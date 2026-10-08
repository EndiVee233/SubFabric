#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对比两个引擎对**同一片音频**的转写是否一致 —— 决定双引擎混用是否安全。

为什么必须查：同一段 236 秒音频，仅 NPU 得 614 词/44 行，仅 GPU 得 601 词/52 行。
如果两个引擎对同一片音频给出不同转写，那"按片分工"就会让成品质量参差 ——
最终字幕里一部分来自 NPU、一部分来自 GPU，风格与错误分布都不一样。

做法：切同一片 15.01s 音频，分别喂给两个 worker（各自 manifest 模式），
逐词比对，并做归一化后的一致性统计。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
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


def write_slice(samples, sr, start, end, path):
    a = np.clip(samples[int(start * sr):int(end * sr)], -1, 1)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((a * 32767).astype(np.int16).tobytes())


def run(script, model, extra, wav, out, tmp):
    man = os.path.join(tmp, "m.json")
    with open(man, "w", encoding="utf-8") as fh:
        json.dump({"slices": [{"index": 0, "start": 0.0, "end": 0.0, "wav": wav}], "out": out}, fh)
    r = subprocess.run([PY, script, "--model", model, "--manifest", man, "--out", out] + extra,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit(f"{script} 失败：\n{(r.stderr or '')[-800:]}")
    with open(out, encoding="utf-8") as fh:
        return json.load(fh)["slices"]["0"]["segments"]


def norm(s):
    return re.sub(r"[^a-z0-9 ]", "", str(s).lower())


def main() -> int:
    samples, sr = read_wav(AUDIO)
    spans = [(0.0, 15.01), (60.06, 75.07), (135.1, 150.11)]
    tmp = tempfile.mkdtemp(prefix="cmp-")
    print(f"对比 {len(spans)} 片\n")
    tot_words = tot_lines = 0
    for k, (a, b) in enumerate(spans):
        wav = os.path.join(tmp, f"s{k}.wav")
        write_slice(samples, sr, a, b, wav)
        npu = run(os.path.join(REPO, "asr", "asr_npu.py"),
                  os.path.join(MODELS, "parakeet-tdt-0.6b-v2-npu"),
                  ["--provider", "npu", "--tta", "0"], wav,
                  os.path.join(tmp, f"npu{k}.json"), tmp)
        gpu = run(os.path.join(REPO, "asr", "asr.py"),
                  os.path.join(MODELS, "parakeet-tdt-0.6b-v2"),
                  ["--provider", "cuda"], wav, os.path.join(tmp, f"gpu{k}.json"), tmp)
        tn = " ".join(s["text"] for s in npu)
        tg = " ".join(s["text"] for s in gpu)
        same = norm(tn) == norm(tg)
        # 逐词集合差异
        wn = norm(tn).split()
        wg = norm(tg).split()
        only_n = [w for w in wn if w not in wg]
        only_g = [w for w in wg if w not in wn]
        print(f"片 {k}  [{a:.1f}-{b:.1f}]  NPU {len(wn)} 词/{len(npu)} 行   GPU {len(wg)} 词/{len(gpu)} 行   "
              f"完全一致: {'是' if same else '否'}")
        if not same:
            print(f"    NPU: {tn[:110]}")
            print(f"    GPU: {tg[:110]}")
            if only_n:
                print(f"    只在 NPU: {only_n[:8]}")
            if only_g:
                print(f"    只在 GPU: {only_g[:8]}")
        tot_words += 1 if same else 0
        tot_lines += 1
        print()
    print(f"=== 结论：{tot_words}/{tot_lines} 片两引擎转写完全一致 ===")
    if tot_words < tot_lines:
        print("  → 两个引擎**不保证**输出相同。按片分工意味着成品字幕里一部分来自 NPU、")
        print("    一部分来自 GPU，风格与错误分布会不一致。这是混用的固有代价，需自行权衡。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
