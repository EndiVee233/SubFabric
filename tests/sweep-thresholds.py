#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用真实数据扫描参数：句级聚合方式 + 低置信度阈值。

问题：默认阈值 0.62 下 clean 也标了 7/10 行低置信度 —— 筛选就失去意义了。
句级分现在是 `音频 * (0.7 + 0.3 * 最差词分)`，单个坏词影响太大。

这个脚本拿四种样本的**词级分数**重算句级分（不需要再跑模型），对比几种聚合方式，
找出"clean 只标 0~2 行、噪声越大标得越多"的组合。
"""

import json
import os
import sys

SAMPLES = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\Terry\Documents\deepseek-harness\default-workspace\.staging\samples"
NAMES = ("clean", "noisy", "verynoisy", "clipped")


def load(name):
    p = os.path.join(SAMPLES, f"result-{name}.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def word_scores(seg):
    """该句的词级分（跳过 None）。"""
    return [w.get("confidence") for w in (seg.get("words") or [])
            if w.get("confidence") is not None]


def pct(vals, q):
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, int(len(s) * q)))] if s else None


def seg_score(seg, audio, mode):
    ws = word_scores(seg)
    if not ws:
        return audio * 0.85
    if mode == "worst":
        w = min(ws)
    elif mode == "p20":
        w = pct(ws, 0.20)
    elif mode == "p35":
        w = pct(ws, 0.35)
    elif mode == "mean":
        w = sum(ws) / len(ws)
    else:
        raise ValueError(mode)
    return audio * (0.7 + 0.3 * w)


def main() -> int:
    data = {}
    for n in NAMES:
        r = load(n)
        if r:
            data[n] = r
    if not data:
        print("没有样本结果，先跑 tests/make-noisy-samples.py --run")
        return 1

    modes = ["worst", "p20", "p35", "mean"]
    thresholds = [0.60, 0.62, 0.65, 0.68, 0.70, 0.72, 0.75, 0.78]

    for mode in modes:
        print(f"\n=== 句级聚合 = {mode} ===")
        print("  样本        行数   " + "  ".join(f"<{t:.2f}" for t in thresholds))
        table = {}
        for n, r in data.items():
            audio = (r.get("confidence") or {}).get("parts", {}).get("audio", 0.5)
            segs = r["segments"]
            scores = [seg_score(s, audio, mode) for s in segs]
            table[n] = scores
            counts = [sum(1 for s in scores if s < t) for t in thresholds]
            print(f"  {n:10s} {len(scores):4d}   " + "  ".join(f"{c:4d}" for c in counts))

    print("\n=== 挑最合适的组合 ===")
    print("  目标: clean 标出 <= 2 行; verynoisy 明显多于 clean (最好 >= 6)")

    best = []
    for mode in modes:
        for t in thresholds:
            res = {}
            for n, r in data.items():
                audio = (r.get("confidence") or {}).get("parts", {}).get("audio", 0.5)
                scores = [seg_score(s, audio, mode) for s in r["segments"]]
                res[n] = sum(1 for s in scores if s < t)
            clean_n = res.get("clean", 99)
            very_n = res.get("verynoisy", 0)
            # 打分：clean 少标 + verynoisy 多标
            score = (0 if clean_n <= 2 else -10) + (very_n - clean_n)
            best.append((score, mode, t, res))
    best.sort(key=lambda x: -x[0])
    for score, mode, t, res in best[:6]:
        flag = "✓" if score >= 4 else " "
        print(f"  {flag} {mode:5s} 阈值 {t:.2f} → " +
              "  ".join(f"{k}:{v}" for k, v in res.items()))

    print("\n=== 建议 ===")
    top = best[0]
    if top[0] >= 4:
        print(f"  用聚合方式 '{top[1]}' + 阈值 {top[2]:.2f}")
        print(f"  预期标记行数: " + "  ".join(f"{k}:{v}" for k, v in top[3].items()))
    else:
        print("  没有找到理想组合 —— 说明句级分本身区分度不够，")
        print("  应当回头看句级聚合公式（而不是继续调阈值）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
