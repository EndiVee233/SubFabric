"""粘连词切分的回归测试。

修的 bug（实测）：两个引擎的 token→词 都靠"词边界标记"判定新词
（NPU 看 SentencePiece 的 ▁，sherpa 看 token 的前导空格）。模型在退化处会吐出
**没有边界标记的垃圾片段**，被拼进同一个词：
    series.ies / first......'arc. / headquarters..hunter's. / players.....ed.
后果：一个"词"占 11~12 秒、文本由两半粘成，段落边界随之崩坏 ——
用户看到的是"语法不完整的怪句子"，实测某项目 90% 的段被这类词拖坏。

修法：confidence.split_glommed_word() + split_words_inplace()，
在两个引擎的 words 构建处调用（必须在 refine_word_ends 之前）。

本测试覆盖三类容易写错的点：
  1. 该切的要切开（实测见过的形态）
  2. 不该切的绝不能切（撇号缩写、词尾单标点）
  3. 时间分配 —— 尤其"词上还没有 end"这个真实前置条件
     （早期版本用 w.get("end", start) 兜底 → 零长度区间 → 两段 start 相同，切了等于没切）
"""

from __future__ import annotations

import io
import os
import sys

REPO = r"D:\SubFabric-fork"
sys.path.insert(0, os.path.join(REPO, "asr"))
import confidence as C  # noqa: E402

passed = 0
failed = 0


def ok(cond, name, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ((" :: " + str(extra)) if extra != "" else ""))


def show(words):
    return [(w["word"], round(w["start"], 3), round(w.get("end", -1), 3)) for w in words]


def main() -> int:
    print("== 1. 该切的要切开（实测见过的形态）==")
    for src, want in [
        ("series.ies", ["series", ".ies"]),
        ("storyline...", ["storyline", "..."]),
        ("first......'arc.", ["first", "......'arc."]),
        ("headquarters..hunter's.", ["headquarters", "..hunter's."]),
        ("entirely..ive", ["entirely", "..ive"]),
        ("players.....ed.", ["players", ".....ed."]),
    ]:
        got = C.split_glommed_word(src)
        ok(got == want, "%s -> %s" % (src, got), "期望 %s" % want)

    print("\n== 2. 不该切的绝不能切（撇号缩写 / 词尾单标点 / 短词）==")
    for src in ["series,", "you've", "SMP.", "Mr.", "don't", "U.S.A", "e.g",
                "storyline", "Hello,", "OK.", "a.b", "hunter's.", "it's",
                "Spoke,", "Flamefrags,", "Minecraft", "Minecraft.", "wasn't", "Rembu,"]:
        got = C.split_glommed_word(src)
        ok(got == [src], "%s 保持原样" % src, got)

    print("\n== 3. 时间分配：词上**没有 end**（真实前置条件）==")
    words = [
        {"word": "Minecraft", "start": 14.16, "anchor": 14.16},
        {"word": "series.ies", "start": 14.64, "anchor": 14.64},
        {"word": "with", "start": 15.19, "anchor": 15.19},
    ]
    n = C.split_words_inplace(words)
    ok(n == 1, "切开 1 个", n)
    got = show(words)
    ok([w[0] for w in got] == ["Minecraft", "series", ".ies", "with"], "词序正确", got)
    ok(abs(got[1][1] - 14.64) < 1e-6, "series.start = 14.64", got[1])
    # 关键：第二段的 start 必须**大于**第一段的 start（早期 bug 里两者相同）
    ok(got[2][1] > got[1][1], "第二段 start > 第一段 start（早期 bug：两者相同）", got[2:3])
    ok(abs(got[2][1] - 14.97) < 0.02, "第二段 start ≈ 14.97（按字符比例）", got[2])
    ok(abs(got[2][2] - 15.19) < 1e-6, "末段 end = 原词 end（= 下一个词的 start）", got[2])
    # 区间连续、不重叠
    ok(abs(got[1][2] - got[2][1]) < 1e-6, "两段首尾相接，不重叠不留缝", (got[1], got[2]))

    print("\n== 4. 末词（没有下一个词可参照）也要有非零区间 ==")
    w2 = [{"word": "storyline...", "start": 24.07, "anchor": 24.07}]
    C.split_words_inplace(w2)
    ok(len(w2) == 2, "切成 2 段", len(w2))
    ok(w2[1]["start"] > w2[0]["start"], "两段 start 不同（否则切开无意义）",
       show(w2))
    ok(all(x["end"] > x["start"] for x in w2), "两段都有正的时长", show(w2))

    print("\n== 5. 已有 end 时按比例分摊（end 存在的路径）==")
    w3 = [{"word": "series.ies", "start": 10.0, "end": 11.0, "anchor": 10.0}]
    C.split_words_inplace(w3)
    ok(len(w3) == 2, "切成 2 段")
    ok(abs(w3[0]["end"] - w3[1]["start"]) < 1e-6, "首尾相接")
    ok(abs(w3[0]["end"] - 10.0 - (11.0 - 10.0) * len("series") / len("series.ies")) < 0.01,
       "按字符数比例分摊", show(w3))

    print("\n== 6. 健壮性 ==")
    ok(C.split_words_inplace([]) == 0, "空列表不炸")
    ok(C.split_words_inplace(None) == 0, "None 不炸")
    ok(C.split_glommed_word("") == [""], "空串返回自身")
    w4 = [{"word": "hello", "start": 1.0, "end": 1.5}]
    ok(C.split_words_inplace(w4) == 0, "正常词不算切开")
    ok(w4[0]["word"] == "hello", "正常词不被改动")
    # _p 必须被丢掉（原本是整个粘连词的概率，切开后对不上号）
    w5 = [{"word": "series.ies", "start": 1.0, "end": 2.0, "anchor": 1.0, "_p": [0.9, 0.8]}]
    C.split_words_inplace(w5)
    ok(all("_p" not in x for x in w5), "切开的片段不带 _p（避免错位的词级评分）", show(w5))

    print("\n== 7. 两个引擎都接上了切分（防回退）==")
    for fn in ("asr_npu.py", "asr.py"):
        s = io.open(os.path.join(REPO, "asr", fn), encoding="utf-8").read()
        ok("C.split_words_inplace" in s, "%s 调用了切分" % fn)
    s = io.open(os.path.join(REPO, "asr", "asr_npu.py"), encoding="utf-8").read()
    # 必须在 _tokens_to_words 内（= 在 refine_word_ends 之前）
    i_t = s.find("def _tokens_to_words")
    i_c = s.find("C.split_words_inplace", i_t)
    i_r = s.find("def refine_word_ends", i_t)
    ok(0 < i_t < i_c < i_r, "asr_npu: 切分位于 _tokens_to_words 内、refine_word_ends 之前")

    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
