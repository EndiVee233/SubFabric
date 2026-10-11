"""asr.py ↔ asr_npu.py 的**分句输出对拍**（common.py 提取的前置护栏）。

为什么需要：
  `words_to_segments` 在两个引擎里各有一份**逐字重复**的实现（断句阈值、软标点回退、
  行长兜底全一样）。第二轮审查发现它们已经**行为漂移** —— npu 版长出了 token 分数逻辑。
  在把这份重复实现抽成 `asr/common.py` 之前，必须先有这道护栏：
  钉住"分句本身必须逐字一致"，否则提取时改坏了哪一边根本看不出来。

本测试把两件事分开钉：
  A. **分句结果**（id / start / end / text / 逐词 word+start+end）—— 必须**完全一致**，
     这正是将来要提取成公共实现的部分。
  B. **置信度字段** —— 允许且**应当**不同（asr 走 sherpa，拿不到 token 概率；npu 能拿到）。
     这里只钉住"差异是设计好的那几处"，防止有人把某一侧随手写歪。

运行：python tests/asr-segment-parity-test.py
依赖：numpy（asr/confidence.py 需要）。没装就整体跳过 —— 缺的是环境不是代码。
"""

from __future__ import annotations

import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASR = os.path.join(REPO, "asr")

# ── 依赖检查：缺 numpy 就跳过（asr/confidence.py 顶层 import numpy）──
try:
    import numpy as np  # noqa: F401
except ImportError:
    print("（跳过：未安装 numpy —— 本测试要 import asr/confidence，二者都依赖它）")
    print("0 passed, 0 failed")
    sys.exit(0)

sys.path.insert(0, ASR)
try:
    import asr as A          # sherpa/CUDA 引擎（sherpa_onnx 是函数内延迟导入，不影响本测试）
    import asr_npu as N      # OpenVINO/NPU 引擎
except Exception as exc:  # noqa: BLE001
    print("（跳过：导入 asr / asr_npu 失败 —— %s）" % exc)
    print("0 passed, 0 failed")
    sys.exit(0)

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


def W(word, start, end, **kw):
    d = {"word": word, "start": float(start), "end": float(end)}
    d.update(kw)
    return d


def norm(segs):
    """只保留"分句输出"该一致的那部分：置信度、逐词 confidence 一律剥掉。"""
    return [
        {
            "id": s["id"], "start": s["start"], "end": s["end"], "text": s["text"],
            "words": [(w["word"], w["start"], w["end"]) for w in s["words"]],
        }
        for s in segs
    ]


# 20 秒的确定性噪声：npu 版 words_to_segments 必须拿到 samples（内部会 len(samples)），
# 但本测试只比对分句，音频内容不影响结果。
SR = A.SAMPLE_RATE
SIGNAL = np.random.default_rng(20261011).normal(0.0, 0.02, SR * 20).astype(np.float32)
STAB = {"stability": 0.9}


def seg_a(words):
    return norm(A.words_to_segments(words, samples=None))


def seg_n(words):
    return norm(N.words_to_segments(words, samples=SIGNAL, stability=STAB))


# ══════════════════════════════════════════════════════════════════
CASES = []


def case(name, words):
    CASES.append((name, words))


# 1. 句末标点断句
case("句末标点断句", [
    W("hello", 0.0, 0.5), W("world.", 0.5, 1.0), W("next", 1.2, 1.6), W("one", 1.6, 2.0),
])
# 2. 长停顿断句（> PAUSE_SPLIT）
case("长停顿断句", [W("a", 0.0, 0.5), W("b", 2.0, 2.5)])
# 3. 超长行 + 软标点回退（触发 cut 分支：j+1 >= 6）
_soft = [W("w%d" % i, float(i), i + 0.5) for i in range(12)]
_soft[5] = W("w5,", 5.0, 5.5)          # 软标点落在 j=5 → j+1=6，刚好够
case("超长行在软标点处回退断行", _soft)
# 4. 超长行但没有软标点（走 groups.append(cur) 兜底分支）
case("超长行无软标点 → 硬断", [W("w%d" % i, float(i), i + 0.5) for i in range(12)])
# 5. 行长兜底：MAX_LINE_WORDS
case("超过 MAX_LINE_WORDS 硬断", [W("w%d" % i, i * 0.1, i * 0.1 + 0.08)
                                  for i in range(A.MAX_LINE_WORDS + 3)])
# 6. 单行
case("只有一行", [W("only", 0.0, 0.5), W("line", 0.5, 1.0)])
# 7. 空输入
case("空输入", [])
# 8. 连续句末标点 + 混合（标点粘连在词尾）
case("连续句末标点", [W("Yes!", 0.0, 0.4), W("No?", 0.5, 0.9), W("ok.", 1.0, 1.4)])
# 9. 中文句末标点（全角）
case("中文全角句末标点", [W("你好。", 0.0, 0.6), W("再见", 0.7, 1.2)])
# 10. 恰好等于 PAUSE_SPLIT 边界（不 > 就不该断）
case("停顿恰好等于阈值（不应断）",
     [W("a", 0.0, 1.0), W("b", 1.0 + A.PAUSE_SPLIT, 2.0 + A.PAUSE_SPLIT)])

print("== A. 分句结果对拍（必须逐字一致）==")
for name, words in CASES:
    ra, rn = seg_a(words), seg_n(words)
    ok(ra == rn, "%s（%d 段）" % (name, len(ra)),
       "asr=%s\n         npu=%s" % (ra, rn))

print("\n== B. 断句阈值常量也必须一致（将来提取成公共实现的就是它们）==")
for const in ("SENT_END", "SOFT_END", "PAUSE_SPLIT", "MAX_LINE_SEC", "MAX_LINE_WORDS", "SAMPLE_RATE"):
    ok(getattr(A, const) == getattr(N, const), "%s 两边一致" % const,
       "asr=%r npu=%r" % (getattr(A, const), getattr(N, const)))

print("\n== C. 置信度差异是**设计好的**（不是随手写歪）==")
# 两边都给 samples + stability，这时都会算置信度
cw = [W("hello", 0.0, 0.5, _p=[0.9, 0.8]), W("world.", 0.5, 1.0, _p=[0.7, 0.6])]
sa = A.words_to_segments(list(cw), samples=SIGNAL, stability=STAB)[0]["confidence"]
sn = N.words_to_segments(list(cw), samples=SIGNAL, stability=STAB)[0]["confidence"]
ok("token" not in sa["parts"], "asr 的 parts **没有** token（sherpa 不给 token 概率，不伪造）", sa["parts"])
ok("token" in sn["parts"], "npu 的 parts **有** token（它能拿到 token 概率）", sn["parts"])
ok(sa["worstWord"] is None, "asr 的 worstWord 恒为 None（没有逐词分数可用）", sa["worstWord"])
ok(sn["worstWord"] is not None, "npu 的 worstWord 有下标（逐词分数可用）", sn["worstWord"])
for k in ("audio", "stability"):
    ok(k in sa["parts"] and k in sn["parts"], "两边 parts 都有 %s（口径一致）" % k)
ok(abs(sa["parts"]["stability"] - 0.9) < 1e-6 and abs(sn["parts"]["stability"] - 0.9) < 1e-6,
   "stability 取的是 parts.stability（不是 confidence.stability 那个子字典）")

print("\n== D. 已知的签名差异（记录下来，改的时候别踩）==")
# asr.py 的 samples=None 是**受支持**的默认值（跳过置信度计算）；
# asr_npu.py 无条件 len(samples) → samples=None 会 TypeError。
# 提取 common.py 时要统一成前者（可选）。
try:
    A.words_to_segments([W("x", 0.0, 0.5)], samples=None)
    ok(True, "asr：samples=None 可用（跳过置信度）")
except Exception as exc:  # noqa: BLE001
    ok(False, "asr：samples=None 应当可用", exc)
try:
    N.words_to_segments([W("x", 0.0, 0.5)], samples=None)
    print("  ·  npu：samples=None 现在也能用了 —— 若这是有意修的，请把本段改成断言")
except TypeError as exc:
    print("  ·  npu：samples=None 会 TypeError（已知差异）—— %s" % exc)
except Exception as exc:  # noqa: BLE001
    print("  ·  npu：samples=None 抛了别的错 —— %r" % exc)

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
