#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：joint 网络输出的 token 概率到底是多少。

背景：置信度里 token 那一项在 clean 音频上得到了 0.0，但转写是对的。
怀疑 joint 输出的是**大数值 logits**，softmax 之后 top-1 概率天然只有 1/1025 量级
（1025 = 词表 + blank），那样任何阈值都没意义。

这个脚本直接打印若干 token 的 top-1/top-2 概率与 logits 分布，用来判断该怎么归一化。
"""

import os
import sys
import wave

import numpy as np

REPO = r"D:\SubFabric-fork"
sys.path.insert(0, os.path.join(REPO, "asr"))

import asr_npu as W  # noqa: E402


def read_wav(path):
    with wave.open(path, "rb") as wf:
        raw = wf.readframes(wf.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> int:
    audio = sys.argv[1] if len(sys.argv) > 1 else \
        r"C:\Users\Terry\Documents\deepseek-harness\default-workspace\.staging\samples\sample-clean.wav"
    model = os.path.join(REPO, "asr", "models", "parakeet-tdt-0.6b-v2-npu")
    x = read_wav(audio)[: 16000 * 6]          # 只取 6 秒，快一点

    rec = W.NpuRecognizer(model, provider="npu")
    mel = rec.mel.log_mel(x, normalize=True)

    # 手动跑一个窗口，把每次 joint 的 logits 统计下来
    stride = W.ENCODER_WINDOW_FRAMES - W.OVERLAP_FRAMES
    frames = mel.shape[1]
    window = np.zeros((W.MEL_BINS, W.ENCODER_WINDOW_FRAMES), dtype=np.float32)
    size = min(W.ENCODER_WINDOW_FRAMES, frames)
    window[:, :size] = mel[:, :size]
    acts, valid = rec._encode(window, size)

    state = {"hidden": np.zeros((2, 1, rec.dec_hidden), dtype=np.float32),
             "cell": np.zeros((2, 1, rec.dec_hidden), dtype=np.float32),
             "last_token": W.BLANK_TOKEN_ID}

    vocab = W.BLANK_TOKEN_ID + 1
    print("=== 逐帧 joint 输出统计 ===")
    print("  帧   top1logit  top2logit  差值   原始softmax_top1   头部均值 头部标准差")
    shown = 0
    f = 0
    while f < min(valid, 40) and shown < 12:
        logits, h, c = rec._joint_step(state["last_token"], state["hidden"], state["cell"])
        flat = np.asarray(logits, dtype=np.float32).reshape(-1, 1030)
        row = flat[f]
        head = row[:vocab]
        order = np.argsort(head)[::-1]
        t1, t2 = float(head[order[0]]), float(head[order[1]])
        # 三种归一化方式对比
        raw_soft = np.exp(head - head.max())
        raw_soft = raw_soft / raw_soft.sum()
        p_raw = float(raw_soft[order[0]])
        # 只用非 blank 的头部重归一化（blank 通常独大）
        nb = head.copy()
        nb[W.BLANK_TOKEN_ID] = -1e9
        s2 = np.exp(nb - nb.max())
        s2 = s2 / s2.sum()
        p_nb = float(s2[int(np.argmax(nb))])
        print("  %3d  %9.3f  %9.3f  %6.3f   %.6f          %.3f     %.3f" % (
            f, t1, t2, t1 - t2, p_raw, float(head.mean()), float(head.std())))
        if int(order[0]) != W.BLANK_TOKEN_ID:
            shown += 1
            state["hidden"], state["cell"] = np.asarray(h, dtype=np.float32), np.asarray(c, dtype=np.float32)
            state["last_token"] = int(order[0])
        f += 1

    # 整体分布
    logits, _, _ = rec._joint_step(W.BLANK_TOKEN_ID, state["hidden"], state["cell"])
    flat = np.asarray(logits, dtype=np.float32).reshape(-1, 1030)
    head_all = flat[:, :vocab]
    print("\n=== 整窗 head 数值分布 ===")
    print("  全部 logits: 均值 %.4f  标准差 %.4f  最小 %.3f  最大 %.3f" % (
        head_all.mean(), head_all.std(), head_all.min(), head_all.max()))
    per_frame_max = head_all.max(axis=1)
    per_frame_min = head_all.min(axis=1)
    print("  每帧 top1 logit 范围: %.3f ~ %.3f  中位 %.3f" % (
        per_frame_max.min(), per_frame_max.max(), np.median(per_frame_max)))
    print("  每帧 min logit 范围: %.3f ~ %.3f" % (per_frame_min.min(), per_frame_min.max()))
    soft = np.exp(head_all - head_all.max(axis=1, keepdims=True))
    soft = soft / soft.sum(axis=1, keepdims=True)
    print("  每帧 top1 softmax: 中位 %.6f  最大 %.6f" % (
        np.median(soft.max(axis=1)), soft.max(axis=1).max()))
    print("\n=== 结论 ===")
    print("  若 top1 softmax 只有 1/1025 量级 → joint 输出的是大 logits，")
    print("  置信度不能用裸 softmax，应按'与次优的差值'或温度缩放来算。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
