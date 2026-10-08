#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""性能测试：为**本机**测出 NPU / GPU 两个识别引擎的最佳分工，并给出一键可用的配置。

为什么要"分阶段"而不是把矩阵全跑一遍：
    用户要的是 3 种分片长度 × 5 种配比 = 15 种组合。每种都要重新加载模型
    （NPU 4~5s、sherpa 8~14s），全跑一遍既慢又容易受降频影响，测出来的还是噪声。
    改成：
      测量阶段 —— 每个分片长度只真跑 1:0 与 0:1（单引擎基线各一次），
                  得到"每片净耗时"与"加载耗时"；
      预测阶段 —— 用这两个数**算出**其余配比的预期墙钟（纯算术）；
      验证阶段 —— 只把预测最优的配比**真跑一次**，与预测值对照。
    于是 9 次真跑覆盖 15 个组合，且推荐值有实测背书。

时间模型（已用实测校准，见 tools/bench_equal.py 的历史数据）：
    墙钟 ≈ 加载 + 分片数 × 每片净耗时
    混合配比时两个引擎**并行**，所以
    墙钟 ≈ max(加载 + n_gpu×t_gpu, 加载 + n_npu×t_npu)
    两个引擎落在不同硬件上（NPU+Intel 核显 vs N 卡），互不抢占，所以取 max 是合理的。

输出 JSON：
    {"audio": {...}, "sliceLengths": [ {...每个长度的测量与预测...} ],
     "recommend": {"sliceSec":…, "ratio":"…", "predictedSec":…, "measuredSec":…,
                   "speedupVsNpu":…, "speedupVsGpu":…, "command":"…"}}
"""

from __future__ import annotations

import argparse
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import asr as A                      # noqa: E402  read_wav_mono16k

# 要评估的配比（GPU:NPU 的分片数之比）
RATIOS = ["1:0", "0:1", "1:1", "2:1", "1:2"]


def emit(obj):
    sys.stderr.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def log(msg):
    emit({"type": "log", "msg": str(msg)})


def progress(pct, msg):
    emit({"type": "progress", "pct": int(pct), "msg": str(msg)})


def plan_slices(total_sec, slice_sec):
    """与 asr_dual.py 同一套切法（末片太短就并进上一片）。"""
    out, t, i = [], 0.0, 0
    while t < total_sec - 1e-6:
        end = min(total_sec, t + slice_sec)
        if total_sec - end < 0.3:
            if out:
                out[-1] = (out[-1][0], out[-1][1], total_sec)
            else:
                out.append((i, t, total_sec))
            break
        out.append((i, t, end))
        i += 1
        t = end
    return out


def write_slice(samples, sr, start, end, path):
    a = np.clip(samples[int(start * sr):int(end * sr)], -1.0, 1.0)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((a * 32767.0).astype(np.int16).tobytes())


def _parse_load_sec(stderr: str):
    """从 worker 的 stderr 里抓"模型加载完成…耗时 Ns"。

    日志是**嵌套 JSON**：{"type": "log", "msg": "模型加载完成(provider=cuda), 耗时 3.2s"}
    直接按裸文本切会永远匹配不上 —— 那会把加载时间当成推理时间，预测值严重偏小
    （实测：预测 2.18s vs 真跑 6.36s）。所以先尝试 json.loads 取出 msg，再正则抓数字。
    """
    for line in (stderr or "").splitlines():
        if "模型加载完成" not in line or "耗时" not in line:
            continue
        msg = line
        try:
            obj = json.loads(line)
            if isinstance(obj, dict) and obj.get("msg"):
                msg = str(obj["msg"])
        except Exception:
            pass
        m = re.search(r"耗时\s*([0-9.]+)\s*s", msg)
        if m:
            return float(m.group(1))
    return None


def run_one_engine(name, script, model, extra, python_exe, slices, tmpdir):
    """跑一个引擎的全部分片（manifest 模式：模型只加载一次）。返回耗时与结果。"""
    man = os.path.join(tmpdir, f"m-{name}.json")
    out = os.path.join(tmpdir, f"r-{name}.json")
    with open(man, "w", encoding="utf-8") as fh:
        json.dump({"slices": slices, "out": out}, fh, ensure_ascii=False)
    cmd = [python_exe, script, "--model", model, "--manifest", man, "--out", out] + extra
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    dt = time.time() - t0
    if r.returncode != 0:
        tail = ((r.stderr or "").strip().splitlines() or ["(无输出)"])[-1]
        raise RuntimeError(f"{name} 失败（退出码 {r.returncode}）：{tail}")
    with open(out, encoding="utf-8") as fh:
        data = json.load(fh)
    return {"wall": dt, "slices": data.get("slices") or {},
            "loadSec": _parse_load_sec(r.stderr)}


def plan_budget(lengths, audio_sec, total_avail, min_slices=15):
    """每个分片长度要用多少音频：至少 min_slices 片，且不超过素材总长与上限。

    为什么需要：60 秒音频在 28s 分片下只有 2 片，加载时间（~3s）完全主导，
    测出来的"每片净耗时"是噪声。片数不够的测量没有意义。
    """
    out = {}
    for sec in lengths:
        need = max(audio_sec, sec * min_slices)
        out[sec] = min(need, total_avail)
    return out


def per_slice(engine_run, n):
    """每片净耗时 = (墙钟 - 加载) / 片数。加载取不到就按实测墙钟估。"""
    load = engine_run.get("loadSec")
    if load is None:
        # 从结果里的 sec 字段反推：它只含推理时间，不含加载
        secs = [v.get("sec") for v in (engine_run.get("slices") or {}).values() if v.get("sec")]
        if secs:
            return sum(secs) / len(secs), 0.0
        load = 0.0
    n = max(1, n)
    return max(1e-4, (engine_run["wall"] - load) / n), load


def predict(load_g, t_g, load_n, t_n, n_g, n_n):
    """两个引擎并行 → 墙钟约为两者的 max。"""
    return max((load_g or 0) + n_g * t_g, (load_n or 0) + n_n * t_n)


def allocate(ratio, total):
    """按配比把 total 片分给 GPU / NPU（与 asr_dual.py 的规则一致）。"""
    a, b = ratio.split(":")
    g, n = float(a), float(b)
    if n <= 0:
        return total, 0
    if g <= 0:
        return 0, total
    n_gpu = round(total * (g / (g + n)))
    n_gpu = max(0, min(total, n_gpu))
    if total > 1 and n_gpu == total:
        n_gpu = total - 1
    return n_gpu, total - n_gpu


def format_cmd(slice_sec, ratio, model_npu, model_gpu, python_exe):
    return (f'"{python_exe}" asr/asr_dual.py --audio <音频> --out <输出.json> '
            f'--slice-sec {slice_sec:g} --ratio {ratio}')


def main() -> int:
    ap = argparse.ArgumentParser(description="双引擎分工性能测试")
    ap.add_argument("--audio", required=True, help="16kHz 单声道 wav（测试素材）")
    ap.add_argument("--model-npu", default=os.path.join(HERE, "models", "parakeet-tdt-0.6b-v2-npu"))
    ap.add_argument("--model-gpu", default=os.path.join(HERE, "models", "parakeet-tdt-0.6b-v2"))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--slices", default="8,15.01,28", help="要测的分片长度（秒）")
    ap.add_argument("--audio-sec", type=float, default=90.0,
                    help="每个长度用多少秒音频来测（越大越准越慢）")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", default="", help="结果 JSON 路径")
    args = ap.parse_args()

    t_start = time.time()
    samples, sr = A.read_wav_mono16k(args.audio)
    total_avail = len(samples) / float(sr)
    use_sec = min(args.audio_sec, total_avail)
    if use_sec < 20:
        log(f"音频太短（{total_avail:.1f}s），至少需要 20 秒")
        return 1
    log(f"测试素材 {args.audio}（取前 {use_sec:.0f} 秒）")

    lengths = [float(s) for s in args.slices.split(",") if s.strip()]
    tmpdir = tempfile.mkdtemp(prefix="perf-")
    results = []
    try:
        n_steps = len(lengths) * 3          # 每个长度：GPU 基线 + NPU 基线 + 1 次验证
        step = 0
        budget = plan_budget(lengths, args.audio_sec, total_avail)
        for sec in lengths:
            need = budget[sec]
            plan = plan_slices(need, sec)
            n = len(plan)
            log(f"── 分片 {sec:g}s：共 {n} 片（{use_sec:.0f}s 音频）")
            sd = os.path.join(tmpdir, f"s{str(sec).replace('.', '_')}")
            os.makedirs(sd, exist_ok=True)
            slices = []
            for idx, a, b in plan:
                wav = os.path.join(sd, f"{idx:04d}.wav")
                write_slice(samples, sr, a, b, wav)
                slices.append({"index": idx, "start": a, "end": b, "wav": wav})

            def step_done(label):
                nonlocal step
                step += 1
                progress(5 + step / max(1, n_steps) * 88, label)

            entry = {"sliceSec": sec, "slices": n, "audioSec": round(use_sec, 1)}
            # ── 基线 1：只用 GPU ──
            step_done(f"{sec:g}s：测 GPU 单引擎…")
            g = run_one_engine("gpu", os.path.join(HERE, "asr.py"), args.model_gpu,
                               ["--threads", str(args.threads), "--provider", "cuda"],
                               args.python, slices, tmpdir)
            t_g, load_g = per_slice(g, n)
            log(f"   GPU 单引擎 {g['wall']:.2f}s（加载 {load_g or 0:.2f}s）→ 每片 {t_g:.3f}s")
            # ── 基线 2：只用 NPU ──
            step_done(f"{sec:g}s：测 NPU 单引擎…")
            nn = run_one_engine("npu", os.path.join(HERE, "asr_npu.py"), args.model_npu,
                                ["--threads", str(args.threads), "--provider", "npu"],
                                args.python, slices, tmpdir)
            t_n, load_n = per_slice(nn, n)
            log(f"   NPU 单引擎 {nn['wall']:.2f}s（加载 {load_n or 0:.2f}s）→ 每片 {t_n:.3f}s")

            # ── 预测所有配比 ──
            preds = {}
            for ratio in RATIOS:
                n_g, n_n = allocate(ratio, n)
                preds[ratio] = {"gpuSlices": n_g, "npuSlices": n_n,
                                "predictedSec": round(predict(load_g, t_g, load_n, t_n, n_g, n_n), 2)}
            best = min((r for r in RATIOS if r not in ("1:0", "0:1")),
                       key=lambda r: preds[r]["predictedSec"])
            for ratio in RATIOS:
                p = preds[ratio]
                # 两个纯单引擎配比的耗时是实测值，不是预测值
                if ratio == "1:0":
                    p["measuredSec"] = round(g["wall"], 2)
                elif ratio == "0:1":
                    p["measuredSec"] = round(nn["wall"], 2)
            log(f"   预测最优配比 {best}（{preds[best]['predictedSec']:.2f}s）")

            # ── 验证：只真跑预测最优的那一个 ──
            step_done(f"{sec:g}s：验证最优配比 {best}…")
            n_g, n_n = allocate(best, n)
            gs = slices[:n_g]
            ns = slices[n_g:n_g + n_n]
            t0 = time.time()
            import threading
            errs = {}

            def go(tag, script, model, extra, part):
                try:
                    run_one_engine(tag, script, model, extra, args.python, part, tmpdir)
                except Exception as exc:  # noqa: BLE001
                    errs[tag] = str(exc)

            ths = []
            if gs:
                t = threading.Thread(target=go, args=(
                    "gpu-v", os.path.join(HERE, "asr.py"), args.model_gpu,
                    ["--threads", str(args.threads), "--provider", "cuda"], gs))
                t.start()
                ths.append(t)
            if ns:
                t = threading.Thread(target=go, args=(
                    "npu-v", os.path.join(HERE, "asr_npu.py"), args.model_npu,
                    ["--threads", str(args.threads), "--provider", "npu"], ns))
                t.start()
                ths.append(t)
            for t in ths:
                t.join()
            measured = time.time() - t0
            if errs:
                log(f"   验证失败：{errs}")
                preds[best]["measuredSec"] = None
            else:
                preds[best]["measuredSec"] = round(measured, 2)
                log(f"   验证实测 {measured:.2f}s（预测 {preds[best]['predictedSec']:.2f}s）")

            entry.update({"gpuPerSlice": round(t_g, 4), "npuPerSlice": round(t_n, 4),
                          "gpuLoadSec": round(load_g or 0, 2), "npuLoadSec": round(load_n or 0, 2),
                          "ratios": preds, "bestRatio": best})
            results.append(entry)

        # ── 总推荐：在**验证过的**配比里挑实测最快的 ──
        def score(e):
            r = e["ratios"][e["bestRatio"]]
            return r.get("measuredSec") or r["predictedSec"]
        win = min(results, key=score)
        wr = win["ratios"][win["bestRatio"]]
        best_measured = wr.get("measuredSec") or wr["predictedSec"]
        npu_only = win["ratios"]["0:1"].get("measuredSec") or win["ratios"]["0:1"]["predictedSec"]
        gpu_only = win["ratios"]["1:0"].get("measuredSec") or win["ratios"]["1:0"]["predictedSec"]
        rec = {
            "sliceSec": win["sliceSec"],
            "ratio": win["bestRatio"],
            "predictedSec": wr["predictedSec"],
            "measuredSec": wr.get("measuredSec"),
            "speedupVsNpu": round(npu_only / best_measured, 2) if best_measured else None,
            "speedupVsGpu": round(gpu_only / best_measured, 2) if best_measured else None,
            "command": format_cmd(win["sliceSec"], win["bestRatio"],
                                  args.model_npu, args.model_gpu, args.python),
            "elapsedSec": round(time.time() - t_start, 1),
        }
        payload = {"audio": {"path": args.audio, "usedSec": round(use_sec, 1)},
                   "sliceLengths": results, "recommend": rec}
        out_path = args.out or os.path.join(tmpdir, "perf.json")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        log(f"推荐：分片 {rec['sliceSec']:g}s、配比 {rec['ratio']}，"
            f"实测 {rec['measuredSec']}s（比只用 NPU 快 {rec['speedupVsNpu']}×）")
        emit({"type": "result", "path": out_path, "data": payload})
        progress(100, "测试完成")
        if not args.out:
            shutil.copy(out_path, os.path.join(REPO, "asr", "perf-result.json"))
        return 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
