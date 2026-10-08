#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用同一段语音的三种"质量"验证置信度是否有区分度。

这是端到端验证置信度是否**真的有用**的地方：三个信号里，
  * 音频质量项 应该随噪声/削波明显下降；
  * 稳定性项   在加噪版上应该更低（模型对扰动更敏感）；
  * 整体分     应该"干净 > 嘈杂 > 削波"。
识别文本本身在加噪版上也可能变差——那正是置信度要提前告诉用户的事。

跑法：
    python tests/make-noisy-samples.py            # 只生成样本
    python tests/make-noisy-samples.py --run      # 生成样本并跑 NPU 识别对比
"""

import argparse
import json
import os
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "asr"))

import confidence as C  # noqa: E402

SR = 16000


def read_wav(path):
    with wave.open(path, "rb") as wf:
        n, sr, ch, width = wf.getnframes(), wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        raw = wf.readframes(n)
    assert width == 2, "只支持 16-bit wav"
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    assert sr == SR, f"需要 16kHz，实际 {sr}"
    return a


def write_wav(path, x):
    x = np.clip(x, -1.0, 1.0)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((x * 32767.0).astype(np.int16).tobytes())


def add_noise(x, snr_db, seed=7):
    """按目标信噪比加白噪声。"""
    rng = np.random.default_rng(seed)
    sp = float(np.mean(x ** 2))
    npow = sp / (10 ** (snr_db / 10.0))
    return (x + rng.normal(0, np.sqrt(npow), x.size)).astype(np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default=r"C:\Users\Terry\Documents\deepseek-harness\default-workspace\.tmp\sample1_16k.wav")
    ap.add_argument("--model", default=os.path.join(REPO, "asr", "models", "parakeet-tdt-0.6b-v2-npu"))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--outdir",
                    default=os.environ.get("SUBFABRIC_SAMPLES")
                    or os.path.join(REPO, ".confidence-samples"),
                    help="样本输出目录（默认写到仓库下；沙箱里可指向别处）")
    ap.add_argument("--run", action="store_true", help="顺便跑 NPU 识别并对比置信度")
    args = ap.parse_args()

    if not os.path.exists(args.audio):
        print(f"找不到测试音频：{args.audio}")
        return 2
    os.makedirs(args.outdir, exist_ok=True)
    x = read_wav(args.audio)

    variants = {
        "clean": x,
        "noisy": add_noise(x, 8.0),          # 8dB 信噪比：明显嘈杂
        "verynoisy": add_noise(x, 2.0),      # 2dB：几乎淹掉
        "clipped": np.clip(x * 6.0, -1.0, 1.0),   # 削波
    }

    print("=== 只看波形算出的音频质量（不需要跑模型）===")
    paths = {}
    for name, sig in variants.items():
        p = os.path.join(args.outdir, f"sample-{name}.wav")
        write_wav(p, sig)
        paths[name] = p
        q = C.audio_quality(sig)
        print(f"  {name:9s} score={q['score']:.3f}  snr={q['snrDb']:5.1f}dB  "
              f"clip={q['clippingPct']:6.2f}%  silence={q['silencePct']:5.1f}%  speech={q['speechDb']:6.1f}dB")

    order = ["clean", "noisy", "verynoisy", "clipped"]
    scores = [C.audio_quality(variants[n])["score"] for n in order]
    print()
    ok = True
    if not (scores[0] > scores[1] > scores[2]):
        print(f"FAIL 音频质量分未随噪声单调下降: {dict(zip(order[:3], scores[:3]))}")
        ok = False
    else:
        print(f"ok   音频质量随噪声下降: clean {scores[0]:.3f} > noisy {scores[1]:.3f} > verynoisy {scores[2]:.3f}")
    if not scores[0] > scores[3]:
        print(f"FAIL 削波版没被扣分: {scores[3]}")
        ok = False
    else:
        print(f"ok   削波被扣分: clean {scores[0]:.3f} > clipped {scores[3]:.3f}")

    if not args.run:
        print("\n（加 --run 可跑 NPU 识别，看整体置信度在三种样本上的差异）")
        return 0 if ok else 1

    print("\n=== 跑 NPU 识别（每种样本识别 + TTA 重跑）===")
    worker = os.path.join(REPO, "asr", "asr_npu.py")
    results = {}
    for name in order:
        out = os.path.join(args.outdir, f"result-{name}.json")
        cmd = [args.python, worker, "--model", args.model, "--audio", paths[name],
               "--out", out, "--provider", "npu", "--tta", "2"]
        print(f"  [{name}] 识别中 …", flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0 or not os.path.exists(out):
            print(f"    FAIL 退出码 {r.returncode}")
            print("    " + (r.stderr or "")[-600:])
            ok = False
            continue
        with open(out, encoding="utf-8") as fh:
            results[name] = json.load(fh)
        conf = results[name].get("confidence", {})
        parts = conf.get("parts", {})
        st = conf.get("stability", {})
        print(f"    整体 {conf.get('score')}   token {parts.get('token')}  "
              f"音频 {parts.get('audio')}  稳定性 {parts.get('stability')}  "
              f"受影响 {st.get('affectedWords')}/{st.get('wordCount')} 词")
        segs = results[name].get("segments", [])
        low = [s for s in segs if (s.get("confidence") or {}).get("low")]
        print(f"    {len(segs)} 行，其中 {len(low)} 行低置信度")
        if segs:
            print(f"    首行 [{segs[0]['start']:.2f}-{segs[0]['end']:.2f}] "
                  f"conf={(segs[0].get('confidence') or {}).get('score')}  {segs[0]['text'][:70]}")

    print("\n=== 结论 ===")
    if "clean" in results:
        cs = results["clean"]["confidence"]["score"]
        for name in order[1:]:
            if name not in results:
                continue
            vs = results[name]["confidence"]["score"]
            mark = "ok  " if vs < cs else "FAIL"
            if vs >= cs:
                ok = False
            print(f"  {mark} {name:9s} {vs:.3f} vs clean {cs:.3f}")
        # 逐句也要有区分度：加噪版应当出现低置信度的句子
        clean_low = sum(1 for s in results["clean"]["segments"]
                        if (s.get("confidence") or {}).get("low"))
        noisy_low = sum(1 for s in results.get("verynoisy", {}).get("segments", [])
                        if (s.get("confidence") or {}).get("low"))
        print(f"  低置信度行数: clean {clean_low} → verynoisy {noisy_low}")
        if noisy_low <= clean_low:
            print("  ⚠ 加噪版没有出现更多低置信度行 —— 逐句区分度不足，需要调阈值")

    print("\n" + ("ALL OK" if ok else "SOME CHECKS FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
