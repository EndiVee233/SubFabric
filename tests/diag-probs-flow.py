#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：token 概率从解码到"归到词上"的整条链路。

背景：四种样本（clean/noisy/clipped）的 token 项**一致**为 0.0，而单窗口下概率明明是
0.90~1.0。一致为 0 是结构性问题的特征。根因是 _tdt_loop 用字典按"窗口内序号"记概率，
跨窗口合并时序号错配；已改成**与 token 平行的概率列表**，随切片一起走。

这个脚本把链路每一段的数值都打出来，用来确认修好了：
  1. _tdt_loop 直接调用（单窗口）      → 概率应在 0.9 以上
  2. _decode_windows（多窗口，本次重点）→ 概率应与 token 一一对应
  3. 归到词上的 _p                     → 每个词都有概率、没有空洞
  4. token_score / 每词分数的中位数
"""

import os
import sys
import wave

import numpy as np

REPO = r"D:\SubFabric-fork"
sys.path.insert(0, os.path.join(REPO, "asr"))

import asr_npu as W  # noqa: E402
import confidence as C  # noqa: E402


def read_wav(path, seconds=40):
    with wave.open(path, "rb") as wf:
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)[: 16000 * seconds] / 32768.0


def stats(name, vals):
    vals = [float(v) for v in vals]
    if not vals:
        print(f"   {name}: (空)")
        return
    s = sorted(vals)
    print(f"   {name}: n={len(s)}  最小 {s[0]:.4f}  中位 {s[len(s) // 2]:.4f}  最大 {s[-1]:.4f}"
          f"  低于0.5 的 {sum(1 for v in s if v < 0.5)} 个")


def main() -> int:
    audio = sys.argv[1] if len(sys.argv) > 1 else \
        r"C:\Users\Terry\Documents\deepseek-harness\default-workspace\.staging\samples\sample-clean.wav"
    model = os.path.join(REPO, "asr", "models", "parakeet-tdt-0.6b-v2-npu")
    x = read_wav(audio)
    print(f"音频 {len(x)/16000:.1f}s")

    rec = W.NpuRecognizer(model, provider="npu")
    mel = rec.mel.log_mel(x, normalize=True)
    frames = mel.shape[1]
    print(f"mel 帧数 {frames}（每窗口 {W.ENCODER_WINDOW_FRAMES}，所以有 "
          f"{1 + max(0, (frames - W.ENCODER_WINDOW_FRAMES + (W.ENCODER_WINDOW_FRAMES - W.OVERLAP_FRAMES) - 1) // (W.ENCODER_WINDOW_FRAMES - W.OVERLAP_FRAMES))} 个窗口）")

    # ── 1) 单窗口 ──
    size = min(W.ENCODER_WINDOW_FRAMES, frames)
    win = np.zeros((W.MEL_BINS, W.ENCODER_WINDOW_FRAMES), dtype=np.float32)
    win[:, :size] = mel[:, :size]
    acts, valid = rec._encode(win, size)
    state = {"hidden": np.zeros((2, 1, rec.dec_hidden), dtype=np.float32),
             "cell": np.zeros((2, 1, rec.dec_hidden), dtype=np.float32),
             "last_token": W.BLANK_TOKEN_ID}
    toks, tgs, pr = rec._tdt_loop(acts, valid, state, True, collect_probs=True)
    print("\n1) _tdt_loop 单窗口")
    print(f"   tokens={len(toks)}  probs={len(pr)}  {'平行 ✓' if len(toks) == len(pr) else '长度不一致 ✗'}")
    stats("概率", pr)

    # ── 2) 多窗口（修复重点）──
    t2, g2, pr2 = rec._decode_windows(mel, collect_probs=True)
    print("\n2) _decode_windows 多窗口")
    print(f"   tokens={len(t2)}  probs={len(pr2)}  {'平行 ✓' if len(t2) == len(pr2) else '长度不一致 ✗'}")
    stats("概率", pr2)

    # ── 3) 归到词 ──
    words = rec._tokens_to_words(t2, g2, pr2)
    missing = [i for i, w in enumerate(words) if not w.get("_p")]
    print("\n3) _tokens_to_words")
    print(f"   词数={len(words)}  没有概率的词={len(missing)} {missing[:8]}")
    for w in words[:5]:
        print("     %-16s p=%s  score=%.3f" % (w["word"], [round(v, 3) for v in (w.get("_p") or [])][:5],
                                               C.token_score(w.get("_p") or [])))

    # ── 4) 汇总 ──
    allp = [v for w in words for v in (w.get("_p") or [])]
    wscores = sorted(C.token_score(w.get("_p") or []) for w in words)
    print("\n4) 汇总")
    stats("全部 token 概率", allp)
    print(f"   token_score(全部) = {C.token_score(allp):.4f}")
    if wscores:
        print(f"   每词分数: 最小 {wscores[0]:.3f}  中位 {wscores[len(wscores)//2]:.3f}  最大 {wscores[-1]:.3f}")
    print()
    if allp and min(allp) < 0.5:
        print("   → 有低概率 token，说明采集正常且数据有区分度")
    elif allp:
        print("   → 概率都偏高（这段音频确实清晰）；换个加噪样本再看区分度")
    else:
        print("   → 概率为空 ✗ 采集仍有问题")
    return 0


if __name__ == "__main__":
    sys.exit(main())
