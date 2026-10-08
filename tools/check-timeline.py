"""检查各项目 asr.json 的时间戳是否合理（把"挤在前几秒"量化）。

判据：**词数 / 时长 = 词/秒**。正常英语语速约 2~3 词/秒；
如果算出来 10+ 词/秒，说明时间戳被压缩了（秒数偏小）。

同时按"分片方案"分组统计：如果只有长音频（多片）出错、短片正常，
问题就在分片/合并那一环，而不是解码帧率。
"""

from __future__ import annotations

import json
import os
import sys

REPO = r"D:\SubFabric-fork"
PROJ = os.path.join(REPO, "projects")


def analyse(pid: str) -> None:
    d = os.path.join(PROJ, pid)
    asr_path = os.path.join(d, "asr.json")
    if not os.path.exists(asr_path):
        return
    try:
        a = json.load(open(asr_path, encoding="utf-8"))
    except Exception as e:
        print(f"  [{pid}] asr.json 读不了: {e}")
        return
    segs = a.get("segments") or []
    if not segs:
        print(f"  [{pid}] 没有 segments")
        return

    ch_path = os.path.join(d, "asr-chunks.json")
    nchunks = 0
    plan = []
    if os.path.exists(ch_path):
        try:
            ch = json.load(open(ch_path, encoding="utf-8"))
            plan = ch.get("chunks") or []
            nchunks = len(plan)
        except Exception:
            pass

    words = sum(len(s.get("words") or []) for s in segs)
    span = max(s["end"] for s in segs) - min(s["start"] for s in segs)
    dur = a.get("duration")
    rate = words / span if span > 0 else 0
    print(f"  [{pid}]")
    print(f"      duration={dur}  分片数={nchunks}  段数={len(segs)}  词数={words}")
    print(f"      时间跨度={span:.2f}s   词/秒={rate:.2f}   {'← 异常（>6 说明被压缩）' if rate > 6 else ''}")

    # 按分片边界切开看：每一片内部的时间戳跨度应约等于该片时长
    if plan:
        for c in plan:
            lo, hi = c["start"], c["end"]
            inside = [s for s in segs if lo - 0.5 <= s["start"] < hi - 0.5]
            if not inside:
                print(f"      片 {c['index']}（{lo}–{hi}）: 没有任何段落在这个区间 ← 缺失/被挤走")
                continue
            w = sum(len(s.get("words") or []) for s in inside)
            sp = max(s["end"] for s in inside) - min(s["start"] for s in inside)
            print(f"      片 {c['index']}（{lo:.0f}–{hi:.0f}，时长 {hi-lo:.0f}s）: "
                  f"{len(inside)} 段 {w} 词，跨度 {sp:.1f}s"
                  f"  片内词/秒={w/sp if sp else 0:.2f}")
    print()


def main() -> int:
    pids = sorted(p for p in os.listdir(PROJ) if p.startswith("p-"))
    print(f"共 {len(pids)} 个项目\n")
    for pid in pids:
        analyse(pid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
