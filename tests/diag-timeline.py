#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""取证：为什么句子时间戳会超出音频长度（40 秒的音频出现 226 秒的句子）。

直接调 worker 的解码链路，把每个窗口的 token 数与最终帧位置打出来。
"""

import os
import sys
import wave

import numpy as np

REPO = r"D:\SubFabric-fork"
sys.path.insert(0, os.path.join(REPO, "asr"))
import asr_npu as W  # noqa: E402

WS = r"C:\Users\Terry\Documents\deepseek-harness\default-workspace"
audio = os.path.join(WS, ".staging", "samples", "sample-clean.wav")
model = os.path.join(REPO, "asr", "models", "parakeet-tdt-0.6b-v2-npu")

with wave.open(audio, "rb") as wf:
    raw = wf.readframes(wf.getnframes())
    sr = wf.getframerate()
x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
print(f"音频 {len(x)/sr:.1f}s = {len(x)} 采样")

rec = W.NpuRecognizer(model, provider="npu")
mel = rec.mel.log_mel(x, normalize=True)
frames = mel.shape[1]
stride = W.ENCODER_WINDOW_FRAMES - W.OVERLAP_FRAMES
print(f"mel 帧数 = {frames}  (窗口 {W.ENCODER_WINDOW_FRAMES}, 重叠 {W.OVERLAP_FRAMES}, 步进 {stride})")
print(f"mel 时长 = {frames/100:.1f}s（应约等于音频时长）")
print()

tokens, timings, probs = rec._decode_windows(mel, collect_probs=True)
print(f"token 总数 = {len(tokens)}")
if timings:
    last = timings[-1]["frame"]
    print(f"末 token 帧 = {last} → {last/W.ENCODER_FRAME_RATE:.1f}s  (应 <= {frames/100:.1f}s)")
    # 检查帧是否单调、有没有重复段
    fr = [t["frame"] for t in timings]
    back = sum(1 for i in range(1, len(fr)) if fr[i] < fr[i-1])
    print(f"帧回退次数 = {back}（回退说明窗口拼接有重复/错位）")
    print(f"前 5 帧 = {fr[:5]}   末 5 帧 = {fr[-5:]}")
print()

words = rec._tokens_to_words(tokens, timings, probs)
if words:
    print(f"词数 = {len(words)}")
    print(f"末词 = {words[-1]['word']!r}  start={words[-1]['start']:.1f}s")
    bad = [w for w in words if w["start"] > len(x)/sr + 1.0]
    print(f"时间超界的词 = {len(bad)} 个" + (f"，前 3 个: {[(w['word'], round(w['start'],1)) for w in bad[:3]]}" if bad else ""))
