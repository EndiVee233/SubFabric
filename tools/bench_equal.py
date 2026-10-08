#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公平基准：NPU 与 GPU(N 卡) 在**相同分片长度**下的持续识别速度。

为什么不能用整段音频各跑一遍来比（上一版就踩了这个坑）：
  sherpa 的 split_chunks 在 ~26 秒处会把音频切成两块，**每块都要重跑一次编码器**，
  于是 40 秒整段跑出 6.2x，而 30 秒是 19.8x —— 看着像"更慢"，其实只是切多了一块。
  要比吞吐必须**同长度**，而且要用实际并行时的分片长度。

测法：把音频按固定长度切片，每个引擎对同一批切片各跑 rounds 轮，取中位数。
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
import wave

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "asr"))
MODELS = os.path.join(REPO, "asr", "models")


def read_wav(path):
    with wave.open(path, "rb") as wf:
        sr, ch, width, n = wf.getframerate(), wf.getnchannels(), wf.getsampwidth(), wf.getnframes()
        raw = wf.readframes(n)
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        raise SystemExit(f"需要 16kHz，实际 {sr}")
    return x


def slices_of(audio, length_sec, count):
    n = int(length_sec * 16000)
    out = []
    for i in range(count):
        seg = audio[i * n:(i + 1) * n]
        if len(seg) < n:
            seg = np.pad(seg, (0, n - len(seg)))
        out.append(seg)
    return out


def run_npu(segs, rounds, joint="GPU.0"):
    import asr_npu as W
    # 把预测/联合显式钉在 iGPU(GPU.0) 上：N 卡要留给 CUDA 引擎，两个引擎并行时不能抢。
    W.PROVIDER_DEVICES["npu"] = ("NPU", joint)
    rec = W.NpuRecognizer(os.path.join(MODELS, "parakeet-tdt-0.6b-v2-npu"), provider="npu")
    print(f"  编码器={rec.enc_device}  预测/联合={rec.joint_device}")
    rec.recognize_words(segs[0], tta_runs=0)          # 热身
    per = []
    for r in range(rounds):
        t0 = time.time()
        for seg in segs:
            rec.recognize_words(seg, tta_runs=0)
        per.append(time.time() - t0)
    return per


def run_sherpa(segs, rounds):
    import asr as A
    rec = A.load_recognizer(os.path.join(MODELS, "parakeet-tdt-0.6b-v2"), 4, [], 3.0, provider="cuda")
    def one(seg):
        plan = A.split_chunks(seg, 16000)
        return A.recognize_words(rec, seg, 16000, plan)
    one(segs[0])
    per = []
    for r in range(rounds):
        t0 = time.time()
        for seg in segs:
            one(seg)
        per.append(time.time() - t0)
    return per


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--len", type=float, default=15.01, help="分片长度（秒）")
    ap.add_argument("--count", type=int, default=4, help="每次测几个分片")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--engine", default="both", choices=["both", "npu", "sherpa"])
    ap.add_argument("--joint", default="GPU.0",
                    help="NPU 引擎里预测/联合网络的设备：GPU.0=Intel核显（默认，不占 N 卡）/ CPU")
    args = ap.parse_args()

    audio = read_wav(args.audio)
    segs = slices_of(audio, args.len, args.count)
    total_sec = args.len * args.count
    print(f"音频 {len(audio)/16000:.1f}s → 切成 {args.count} 片 × {args.len:g}s = {total_sec:.1f}s")
    print(f"每片重复 {args.rounds} 轮，取中位数\n")

    res = {}
    if args.engine in ("both", "npu"):
        print("=== NPU 引擎（OpenVINO）===")
        try:
            per = run_npu(segs, args.rounds, args.joint)
            med = statistics.median(per)
            res["npu"] = med
            print(f"    {args.count} 片共 {med:.2f}s  →  {total_sec/med:.1f}x 实时"
                  f"   （每轮 {[round(p,2) for p in per]}）")
        except Exception as exc:  # noqa: BLE001
            print(f"    失败: {type(exc).__name__}: {exc}")
        print()

    if args.engine in ("both", "sherpa"):
        print("=== GPU 引擎（sherpa-onnx / CUDA，N 卡）===")
        try:
            per = run_sherpa(segs, args.rounds)
            med = statistics.median(per)
            res["sherpa"] = med
            print(f"    {args.count} 片共 {med:.2f}s  →  {total_sec/med:.1f}x 实时"
                  f"   （每轮 {[round(p,2) for p in per]}）")
        except Exception as exc:  # noqa: BLE001
            print(f"    失败: {type(exc).__name__}: {exc}")
        print()

    if len(res) == 2:
        n, g = res["npu"], res["sherpa"]
        ratio = n / g            # GPU 比 NPU 快几倍（耗时比）
        share_g = ratio / (ratio + 1)
        print("=== 结论 ===")
        print(f"  NPU  : {total_sec/n:5.1f}x 实时")
        print(f"  GPU  : {total_sec/g:5.1f}x 实时")
        print(f"  GPU/NPU 耗时比 = {ratio:.2f}  →  GPU 应承担约 {share_g*100:.0f}% 的分片")
        # 给出整数分工（简单、好实现）
        for gp in range(1, 5):
            for np_ in range(1, 5):
                if abs(gp / (gp + np_) - share_g) < 0.12:
                    print(f"  可行分工：GPU {gp} 片 : NPU {np_} 片  →  预期加速 "
                          f"{(gp+np_)/max(gp/max(ratio,1e-9), np_):.2f}x（相对只用 NPU）")
                    break
            else:
                continue
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
