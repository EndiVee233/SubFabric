"""检查**句内**（逐词）时间戳是否被压缩 —— 这是前面一直没查的粒度。

用户描述："每一段的时间戳被压缩，前十秒的字幕都堆在一起"。
前面我只验了句子级 start/end（那些是对的正确），
而 ASS 里每个"句子"其实由**很多个逐词 Dialogue** 组成 —— 如果这堆逐词事件
全挤在句子开头的一两秒内，观感就是"字幕一闪而过、几秒放完"。

判据：
  · 一个句子的逐词事件跨度，应该约等于该句的时长；
  · 如果事件跨度远小于句子时长（比如 10s 的句子只有 0.5s 的事件），就是压缩。
  · 词/秒 > 6 也说明压缩（正常语速 2~3）。
"""

from __future__ import annotations

import io
import json
import os
import sys

PROJ = r"D:\SubFabric-fork\projects"


def sec(t: str):
    try:
        h, m, s = t.strip().split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return None


def check_ass(path: str, label: str) -> None:
    txt = io.open(path, encoding="utf-8", errors="replace").read()
    lines = [l for l in txt.split("\n") if l.startswith("Dialogue:")]
    metas = []
    for l in lines:
        f = l[9:].split(",")
        if len(f) < 10:
            continue
        a, b = sec(f[1]), sec(f[2])
        text = ",".join(f[9:])
        if a is None or b is None:
            continue
        metas.append({"style": f[3].strip(), "start": a, "end": b, "text": text})
    print(f"  === {label}")
    print(f"      Dialogue {len(metas)} 条")

    # 按 style 分组：中文整句 vs 英文逐词
    from collections import defaultdict
    by = defaultdict(list)
    for m in metas:
        by[m["style"]].append(m)
    for st, items in sorted(by.items(), key=lambda kv: -len(kv[1])):
        items.sort(key=lambda x: x["start"])
        lo = items[0]["start"]
        hi = max(x["end"] for x in items)
        # 每条的平均时长
        durs = [x["end"] - x["start"] for x in items if x["end"] > x["start"]]
        avg = sum(durs) / len(durs) if durs else 0
        print(f"      style={st!r}: {len(items)} 条，{lo:.2f}~{hi:.2f}s，平均每条 {avg:.3f}s")

    # 逐词事件：看"每一条"是不是都很短（那就是把整句压进了开头）
    wordy = [m for m in metas if "\\c" in m["text"] or "{\\" in m["text"]]
    if wordy:
        wordy.sort(key=lambda x: x["start"])
        print(f"      带覆盖标签的（逐词）{len(wordy)} 条，前 12 条的 起~止 / 时长：")
        for m in wordy[:12]:
            print(f"         {m['start']:8.2f} ~ {m['end']:8.2f}   {m['end']-m['start']:6.3f}s   {m['text'][:44]}")
        # 关键：把所有逐词事件按"每 10 秒"统计，看是否堆在前面
        from collections import Counter
        c = Counter(int(m["start"] // 10) for m in wordy)
        keys = sorted(c)
        print(f"      按 10 秒分档（共 {len(keys)} 档）: " +
              "  ".join(f"{k*10}s:{c[k]}" for k in keys[:12]) + ("  ..." if len(keys) > 12 else ""))
    print()


def check_asr(path: str, label: str) -> None:
    d = json.load(io.open(path, encoding="utf-8"))
    segs = d.get("segments") or []
    print(f"  === {label}（asr.json，句内词级）")
    print(f"      {len(segs)} 段")
    print("      前 5 段的句内词时间：")
    for s in segs[:5]:
        ws = s.get("words") or []
        if not ws:
            continue
        span = ws[-1]["end"] - ws[0]["start"]
        dur = s["end"] - s["start"]
        rate = len(ws) / span if span > 0 else 0
        print(f"         句 {s['start']:.2f}~{s['end']:.2f}（时长 {dur:.2f}s）"
              f"  {len(ws)} 词  词跨度 {span:.2f}s  词/秒 {rate:.2f}"
              f"  {'← 压缩' if rate > 6 else ''}")
        print(f"            首词 {ws[0]['start']:.3f}~{ws[0]['end']:.3f}"
              f"  末词 {ws[-1]['start']:.3f}~{ws[-1]['end']:.3f}")
    print()


def main() -> int:
    for pid in sorted(os.listdir(PROJ)):
        d = os.path.join(PROJ, pid)
        ass = os.path.join(d, "subtitle.ass")
        asr = os.path.join(d, "asr.json")
        if os.path.exists(ass):
            check_ass(ass, pid + " / subtitle.ass")
        if os.path.exists(asr):
            check_asr(asr, pid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
