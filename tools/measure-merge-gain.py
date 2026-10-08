"""量化「补上下文重识别」的收益：丢词有多普遍、能救回多少。

已确认的病因（探针实测）：
  同一段语音，喂给 worker 的**起点不同，结果差异很大** ——
    起始位置附近的内容会被整块漏掉；
    前面接上真实语音后，同样的内容就能正确转写出来。
  这正是"语法不完整句"的来源：不是分段切坏了，而是**那段话压根没被转写**。

本脚本在**整段 57 分钟音频**上抽样测量（不是切 25 秒片段，避免引入新变量）：
  · 基线     ：worker 跑整段 → 每个目标句区间的词数
                 （与项目里已有的 asr.json 独立复核一遍，确认可复现）
  · 补上下文 ：对句子做**掩码重识别** —— 只在目标句的音频区间上算词数，
                 但整段音频都喂给模型（上下文完整）。
                 这就要求 worker 支持"部分区间出结果"，见 --help 说明。

若 worker 暂不支持区间掩码，本脚本退化为：
  用 `--out` 拿到整段结果，然后按时间区间**裁出**目标句对应的段，统计词数。
  这样能测出"模型的段边界落在哪里"，但测不出"强制在目标句起止点切分"的效果。
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys

PY = r"D:\SubFabric\SubFabric\asr\runtime-python\python.exe"
WORKER = r"D:\SubFabric-fork\asr\asr_npu.py"
MODEL = r"D:\SubFabric-fork\asr\models\parakeet-tdt-0.6b-v2-npu"
PROJ = r"D:\SubFabric-fork\projects\p-muz7axuw-f0bdc"
OUTDIR = os.path.join(os.environ.get("TEMP", "."), "merge_probe")
END = (".", "?", "!", "。", "？", "！", "…")


def run_worker(wav, out, tta=0, timeout=3600):
    args = [PY, "-u", WORKER, "--model", MODEL, "--audio", wav, "--out", out,
            "--provider", "npu", "--tta", str(tta)]
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout)
    if not os.path.exists(out):
        return None
    return json.load(io.open(out, encoding="utf-8"))


def words_in(segs, lo, hi):
    """落在 [lo, hi) 区间内的词数（按词的时间中点归属）"""
    n = 0
    for s in segs:
        for w in (s.get("words") or []):
            mid = (w["start"] + w["end"]) / 2
            if lo <= mid < hi:
                n += 1
    return n


def main() -> int:
    os.makedirs(OUTDIR, exist_ok=True)
    asr = json.load(io.open(os.path.join(PROJ, "asr.json"), encoding="utf-8"))
    segs = asr["segments"]
    audio = os.path.join(PROJ, "audio.wav")

    print("项目 asr.json: %d 段" % len(segs))
    print("音频: %s" % audio)
    print()

    # 挑"语法不完整 + 有实义内容"的句子做样本（太短的没意义）
    cand = []
    for i, s in enumerate(segs):
        t = s["text"].strip()
        dur = s["end"] - s["start"]
        nw = len(s.get("words") or [])
        if t.rstrip().endswith(END):
            continue
        if dur < 1.0 or nw < 6:          # 太短/太空的片段不适合评估
            continue
        cand.append(i)
    print("候选（不以句末标点结尾、时长≥1s、词数≥6）: %d 个" % len(cand))

    # 均匀取 6 个样本
    step = max(1, len(cand) // 6)
    sample = cand[::step][:6]
    print("抽样: %s" % sample)
    print()

    # 整段跑一次作为基线（只跑一次，之后按区间统计）
    base_out = os.path.join(OUTDIR, "full_base.json")
    if os.path.exists(base_out):
        print("复用已有整段结果: %s" % base_out)
        base = json.load(io.open(base_out, encoding="utf-8"))
    else:
        print("跑整段识别（57 分钟，NPU，不重跑稳定性）… 需要几分钟")
        base = run_worker(audio, base_out)
        if base is None:
            print("整段识别失败")
            return 1
    bsegs = base.get("segments") or []
    print("基线结果: %d 段" % len(bsegs))
    print()

    print("%-6s %-14s %6s %6s %6s %6s  %s" % (
        "idx", "时间区间", "时长", "原词", "基线词", "基线率", "原文"))
    tot_orig = tot_base = 0
    rows = []
    for i in sample:
        s = segs[i]
        lo, hi = s["start"], s["end"]
        dur = hi - lo
        no = len(s.get("words") or [])
        nb = words_in(bsegs, lo, hi)
        rate = nb / dur if dur > 0 else 0
        tot_orig += no
        tot_base += nb
        rows.append((i, lo, hi, dur, no, nb, rate, s["text"]))
        print("%-6d %6.2f-%6.2f %6.2fs %6d %6d %6.2f  %s" % (
            i, lo, hi, dur, no, nb, rate, s["text"][:40]))
    print()
    print("合计: 原始 %d 词，整段重跑基线 %d 词" % (tot_orig, tot_base))
    print("（若两者接近，说明 asr.json 的结果可复现 → 丢词是模型/窗口本身的行为，不是随机噪声）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
