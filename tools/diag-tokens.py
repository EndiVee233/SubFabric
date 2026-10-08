#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：sherpa-onnx 返回的 token 到底长什么样（词首到底怎么表示）。

背景：GPU(sherpa) 后端把 "needs 26" 粘成 "needs26"。asr.py 判词首用的是
tok.startswith(" ")，但一直没生效。到底是
  (a) token 里没有前导空格，还是
  (b) 有空格但比较逻辑没走到，还是
  (c) 词表 ▁ 前缀集合建错了
—— 直接打原始 token 看，不猜。
"""

from __future__ import annotations

import os
import sys
import wave

import numpy as np

WS = r"C:\Users\Terry\Documents\deepseek-harness\default-workspace"
REPO = r"D:\SubFabric-fork"
sys.path.insert(0, os.path.join(REPO, "asr"))

import asr as A  # noqa: E402

AUDIO = os.path.join(WS, "webapp", "data", "jobs", "f91e282d1ba5", "source16k.wav")
MODEL = os.path.join(REPO, "asr", "models", "parakeet-tdt-0.6b-v2")


def main() -> int:
    samples, sr = A.read_wav_mono16k(AUDIO)
    seg = samples[int(135.1 * sr):int(150.11 * sr)]
    rec = A.load_recognizer(MODEL, 4, [], 3.0, provider="cuda")

    stream = rec.create_stream()
    stream.accept_waveform(sr, seg)
    rec.decode_stream(stream)
    r = stream.result
    toks = list(r.tokens)
    print(f"token 数: {len(toks)}")
    print("\n=== 前 40 个原始 token（repr，看有没有前导空格）===")
    for i, t in enumerate(toks[:40]):
        has_space = t.startswith(" ")
        print(f"  {i:3d}: {t!r:<14} 有前导空格={has_space}  strip 后={t.strip()!r}")

    print("\n=== 统计 ===")
    n_space = sum(1 for t in toks if t.startswith(" "))
    print(f"  有前导空格的: {n_space}/{len(toks)}")

    starts = A.load_word_starts(os.path.join(MODEL, "tokens.txt"))
    print(f"  load_word_starts 得到 {len(starts)} 个词首 token")
    print(f"    样例: {sorted(starts)[:8]}")

    print("\n=== 用词表判定：模拟 recognize_words 的分词结果（前 30 词）===")
    words, cur = [], None
    hits = {"space": 0, "vocab": 0, "none": 0}
    for t in toks:
        piece = t.strip()
        if not piece:
            continue
        by_space = t.startswith(" ")
        by_vocab = ("▁" + piece) in starts
        if by_space:
            hits["space"] += 1
        elif by_vocab:
            hits["vocab"] += 1
        else:
            hits["none"] += 1
        is_start = by_space or by_vocab
        if cur is not None and is_start:
            words.append(cur)
            cur = None
        cur = piece if cur is None else cur + piece
    if cur:
        words.append(cur)
    print(f"  命中统计: 空格={hits['space']}  词表={hits['vocab']}  都不是={hits['none']}")
    print("  分词结果:")
    print("   ", " ".join(words[:30]))
    print(f"\n  共 {len(words)} 词")
    print("\n=== 对照：只用空格启发式（原逻辑）===")
    words2, cur2 = [], None
    for t in toks:
        piece = t.strip()
        if not piece:
            continue
        if cur2 is not None and t.startswith(" "):
            words2.append(cur2)
            cur2 = None
        cur2 = piece if cur2 is None else cur2 + piece
    if cur2:
        words2.append(cur2)
    print("   ", " ".join(words2[:30]))
    print(f"  共 {len(words2)} 词")
    return 0


if __name__ == "__main__":
    sys.exit(main())
