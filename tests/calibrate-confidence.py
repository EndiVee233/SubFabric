#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校准置信度：看真实分布，据此定阈值（而不是拍脑袋）。

读四种样本的识别结果，打印：
  * 词级分数的分布（含最低的那几个词，人眼确认是不是真的可疑）
  * 句级分数分布
  * 在不同 LOW_CONFIDENCE 阈值下会标出多少行
目标：clean 只标出真正可疑的少数行，噪声越大标出的越多。
"""

import json
import os
import sys

import numpy as np

SAMPLES = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\Terry\Documents\deepseek-harness\default-workspace\.staging\samples"
NAMES = ("clean", "noisy", "verynoisy", "clipped")


def load(name):
    p = os.path.join(SAMPLES, f"result-{name}.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    data = {}
    print("=== 词级分数分布 ===")
    for n in NAMES:
        r = load(n)
        if not r:
            print(f"  {n:10s} (缺)")
            continue
        data[n] = r
        scores = [w.get("confidence") for s in r["segments"] for w in (s.get("words") or [])
                  if w.get("confidence") is not None]
        if not scores:
            print(f"  {n:10s} (没有词级分数)")
            continue
        a = np.array(scores)
        print(f"  {n:10s} n={len(a):4d}  均值 {a.mean():.3f}  中位 {np.median(a):.3f}  "
              f"p10 {np.percentile(a,10):.3f}  p25 {np.percentile(a,25):.3f}  "
              f"最低 {a.min():.3f}   <0.5 的 {int((a<0.5).sum())} 个   =0 的 {int((a==0).sum())} 个")

    print("\n=== 每个样本里最差的 5 个词（人眼判断是否真可疑）===")
    for n in NAMES:
        r = data.get(n)
        if not r:
            continue
        pairs = [(w.get("confidence"), w["word"], s.get("text", "")[:40])
                 for s in r["segments"] for w in (s.get("words") or [])
                 if w.get("confidence") is not None]
        pairs.sort(key=lambda t: t[0])
        print(f"  [{n}]")
        for sc, w, ctx in pairs[:5]:
            print(f"     {sc:.3f}  {w:<18} … {ctx}")

    print("\n=== 句子分数分布与阈值敏感性 ===")
    thresholds = [0.75, 0.70, 0.65, 0.62, 0.55, 0.45]
    print("  样本        行数  " + "  ".join(f"<{t:.2f}" for t in thresholds))
    for n in NAMES:
        r = data.get(n)
        if not r:
            continue
        segs = r["segments"]
        scores = [(s.get("confidence") or {}).get("score") for s in segs]
        scores = [s for s in scores if s is not None]
        if not scores:
            continue
        counts = [sum(1 for s in scores if s < t) for t in thresholds]
        print(f"  {n:10s}  {len(scores):3d}   " + "  ".join(f"{c:4d}" for c in counts))

    print("\n=== 结论怎么用 ===")
    print("  · 理想阈值：clean 只标出 0~2 行，verynoisy/noisy 明显更多。")
    print("  · 若 clean 也被标一大半，说明阈值太高或词级分被少数极低值拉垮，")
    print("    该给词级分设下限（而不是继续调低 LOW_CONFIDENCE）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
