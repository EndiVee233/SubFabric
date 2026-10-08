#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反复测：同一个分片长度、同一段音频，跑 N 次看波动有多大。

为什么必须测这个：性能测试页推荐了 8s 分片，但同一档配置在不同次运行间差异
有 10~20%，而 8s 与 15s 的实测差距只有约 8% —— 如果波动大于差距，那"8s 更好"
就只是噪声，不该写进推荐值。
"""

from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

WS = r"C:\Users\Terry\Documents\deepseek-harness\default-workspace"
REPO = r"D:\SubFabric-fork"
PY = r"D:\SubFabric\SubFabric\asr\runtime-python\python.exe"
AUDIO = os.path.join(WS, "webapp", "data", "jobs", "f91e282d1ba5", "source16k.wav")
MODELS = os.path.join(REPO, "asr", "models")


def read_wav(path):
    with wave.open(path, "rb") as wf:
        sr, ch, w, n = wf.getframerate(), wf.getnchannels(), wf.getsampwidth(), wf.getnframes()
        raw = wf.readframes(n)
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def main() -> int:
    samples, sr = read_wav(AUDIO)
    audio_sec = 120.0                      # 每种配置都用 120 秒音频
    reps = 3
    print(f"音频取前 {audio_sec:.0f} 秒，每个配置重复 {reps} 次\n")
    tmp = tempfile.mkdtemp(prefix="var-")

    for slice_sec in (8.0, 15.01):
        n = int(audio_sec / slice_sec)
        wavs = []
        for i in range(n):
            a = np.clip(samples[int(i * slice_sec * sr):int((i + 1) * slice_sec * sr)], -1, 1)
            p = os.path.join(tmp, f"s{slice_sec}-{i}.wav")
            with wave.open(p, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes((a * 32767).astype(np.int16).tobytes())
            wavs.append(p)
        print(f"── 分片 {slice_sec:g}s × {n} 片（共 {n * slice_sec:.1f}s 音频）")
        # 两个引擎各跑各的那一半（1:1），模拟真实并行
        half = n // 2
        times = []
        for r in range(reps):
            parts = []
            for tag, script, model, extra, files in (
                ("gpu", "asr.py", os.path.join(MODELS, "parakeet-tdt-0.6b-v2"),
                 ["--threads", "4", "--provider", "cuda"], wavs[:half]),
                ("npu", "asr_npu.py", os.path.join(MODELS, "parakeet-tdt-0.6b-v2-npu"),
                 ["--threads", "4", "--provider", "npu"], wavs[half:]),
            ):
                man = os.path.join(tmp, f"m-{tag}.json")
                out = os.path.join(tmp, f"o-{tag}.json")
                json.dump({"slices": [{"index": i, "start": 0.0, "end": 0.0, "wav": w}
                                      for i, w in enumerate(files)], "out": out},
                          open(man, "w", encoding="utf-8"))
                parts.append(([PY, os.path.join(REPO, "asr", script), "--model", model,
                               "--manifest", man, "--out", out] + extra))
            procs = [subprocess.Popen(c, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                     for c in parts]
            t0 = time.time()
            for p in procs:
                p.wait()
            dt = time.time() - t0
            times.append(dt)
            print(f"     第 {r + 1} 次: {dt:.2f}s")
        med = statistics.median(times)
        spread = (max(times) - min(times)) / med * 100
        print(f"     中位数 {med:.2f}s  极差 {spread:.1f}%  →  {n * slice_sec / med:.1f}x 实时\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
