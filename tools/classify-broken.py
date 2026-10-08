"""量化"语法不完整句"的真实构成 —— 决定该修哪一环。

已确认的事实：
  · 这个项目（p-muz7axuw-f0bdc，15:14 生成）的逐词时间戳被压缩 8 倍
    （单词中位数 0.040s，正常应 0.2~0.5s）→ 是**旧 bug 的产物**
  · 当前代码在同一音频上产出正常（0.16~0.96s/词，2.2~3.7 词/秒）
    → 那个 bug 已修好，重新识别即可
  · 所以下面统计的"坏"只反映旧产物；但它能告诉我们
    **句子破碎到底来自转写还是来自分段**

分类（只看文本与时间，不猜模型）：
  A. 拼接痕迹   —— 文本里有「......」「..」或词内重复（reseg 把两段接起来的疤）
  B. 尾巴悬空   —— 结尾是 "that/the/and/to/of..." 这类必然要接下去的虚词
  C. 续句开头   —— 以 "first/wasn't/and/but" 等开头、且前一句也没收尾（被硬切）
  D. 超长空段   —— 时长很长却只有 1~2 个词（时间戳被吃掉）
  E. 孤词       —— 只有 1 个词且时长 > 3s
"""

from __future__ import annotations

import io
import json
import re
import sys

PROJ = r"D:\SubFabric-fork\projects\p-muz7axuw-f0bdc"
END = (".", "?", "!", "。", "？", "！", "…")
# 结尾落在这类词上 → 句子必然没说完
DANGLING = {
    "that", "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at",
    "for", "with", "from", "by", "as", "if", "when", "while", "because", "so",
    "his", "her", "their", "its", "my", "your", "our", "which", "who", "whom",
    "was", "were", "is", "are", "be", "been", "had", "has", "have", "would",
    "could", "should", "will", "can", "not", "no", "into", "about", "after",
    "before", "over", "under", "then", "than", "up", "out", "off",
}


def main() -> int:
    d = json.load(io.open(PROJ + r"\asr.json", encoding="utf-8"))
    segs = d["segments"]
    n = len(segs)
    cat = {"A_splice": [], "B_dangling": [], "C_continuation": [], "D_long_empty": [], "E_orphan": []}

    for i, s in enumerate(segs):
        t = s["text"].strip()
        ws = s.get("words") or []
        dur = s["end"] - s["start"]
        nw = len(ws)
        words = re.findall(r"[A-Za-z']+", t.lower())
        last = words[-1] if words else ""

        if re.search(r"\.{3,}|'\w*\.\.|(\w{3,})\1", t):
            cat["A_splice"].append(i)
        if last in DANGLING:
            cat["B_dangling"].append(i)
        if not t.rstrip().endswith(END) and i > 0:
            prev = segs[i - 1]["text"].strip()
            if not prev.endswith(END) and re.match(r"^(and|but|so|then|first|which|that|wasn't|was|is|it|he|she|they|the)\b",
                                                  words[0] if words else ""):
                cat["C_continuation"].append(i)
        if dur > 4.0 and nw <= 2:
            cat["D_long_empty"].append(i)
        if nw == 1 and dur > 3.0:
            cat["E_orphan"].append(i)

    print("总段数 %d" % n)
    print()
    names = {
        "A_splice": "拼接痕迹（......、词内重复）—— reseg 接缝的疤",
        "B_dangling": "尾巴悬空（结尾是 that/the/and… 必然要接下去）",
        "C_continuation": "续句被硬切（前句也没收尾，本句以连接词开头）",
        "D_long_empty": "超长空段（>4s 却只有 1~2 个词）—— 时间戳被吃掉",
        "E_orphan": "孤词（1 个词却 >3s）",
    }
    for k, v in names.items():
        idx = cat[k]
        print("  %-14s %4d 段 (%.1f%%)   %s" % (k, len(idx), len(idx) / n * 100, v))
    print()
    # 至少命中一类的段数（去重）
    allbad = set()
    for v in cat.values():
        allbad |= set(v)
    print("  至少命中一类: %d 段 (%.1f%%)" % (len(allbad), len(allbad) / n * 100))
    print()
    print("=== 各类举例 ===")
    for k in names:
        if not cat[k]:
            continue
        print("  [%s]" % k)
        for i in cat[k][:4]:
            s = segs[i]
            ws = s.get("words") or []
            print("    #%-4d [%7.2f-%7.2f] %5.2fs %2d 词  %s" % (
                i, s["start"], s["end"], s["end"] - s["start"], len(ws), s["text"][:66]))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
