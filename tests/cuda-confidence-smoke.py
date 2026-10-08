#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""asr.py（CUDA 引擎）的置信度冒烟测试 —— **不需要 GPU 与 sherpa-onnx**。

能测什么：模块可导入、分句带置信度、融合按可用信号走、缺项如实标注。
不能测什么：真实的 sherpa 解码（本机没有 N 卡、也没装 sherpa-onnx）——
            那部分只能靠代码审查 + 与 NPU 引擎共用同一套 confidence 模块来保证。

跑法：
    python tests/cuda-confidence-smoke.py [<16k wav>]
"""

import os
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "asr"))

import asr  # noqa: E402  （导入即验证语法与依赖）
import confidence as C  # noqa: E402

passed = 0
failed = 0


def ok(cond, name, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print("  ok  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ("" if extra is None else " :: " + repr(extra)))


WS = r"C:\Users\Terry\Documents\deepseek-harness\default-workspace"
wav = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WS, ".staging", "samples", "sample-clean.wav")
if not os.path.exists(wav):
    wav = os.path.join(WS, "webapp", "data", "jobs", "16e3e10bab39", "source16k.wav")

print("== 模块可导入、辅助函数在位 ==")
ok(hasattr(asr, "_decode_chunks"), "asr.py 有 _decode_chunks")
ok(hasattr(asr, "stability_of"), "asr.py 有 stability_of")
ok("confidence as C" in open(os.path.join(REPO, "asr", "asr.py"), encoding="utf-8").read(),
   "asr.py 引入了 confidence 模块")

print("\n== fuse_available：按可用信号加权 ==")
three = C.fuse_available(0.9, 0.9, 0.9)
two = C.fuse_available(None, 0.9, 0.9)
print(f"     三项: {three['parts']} -> {three['score']}  missing={three.get('missing')}")
print(f"     两项: {two['parts']} -> {two['score']}  missing={two.get('missing')}")
ok(two["score"] > 0.8, "缺 token 项时不该被当成 0 分（否则全句误判）", two["score"])
ok(two.get("missing") == ["token"], "缺失项如实标注", two.get("missing"))
ok("token" not in two["parts"], "拿不到的信号不出现在 parts 里")
ok(C.fuse_available(None, 0.2, 0.9)["low"] is True, "两项里有一项很差 → 仍判低")
ok(C.fuse_available(None, None, None)["score"] == 0.0, "全缺 → 0 分不崩")
ok(C.fuse_available(0.95, None, 0.95)["score"] > 0.9, "只有 token+稳定性时也能算")

print("\n== stability_score_runs：两个纯 id 序列列表 ==")
a = list(range(60))
same = C.stability_score_runs(a, [list(a), list(a)])
diff = C.stability_score_runs(a, [a[:30] + [999] + a[31:]])
print(f"     一致: {same['stability']}   一处不同: {diff['stability']}")
ok(same["stability"] > 0.9, "完全一致 → 高分", same["stability"])
ok(diff["stability"] < same["stability"], "有差异 → 更低", diff["stability"])
ok(C.stability_score_runs(a, [])["stability"] == 1.0, "没跑重跑 → 不误判为低")
ok(C.stability_score_runs([], [[]])["stability"] == 0.0, "空序列 → 0")

print("\n== words_to_segments：置信度接得上、缺项如实 ==")
samples, sr = asr.read_wav_mono16k(wav)
# 造几个词，起始时间铺在前 8 秒内（用真实音频算音频质量）
words = [
    {"word": "hello", "start": 0.2, "end": 0.6},
    {"word": "world.", "start": 0.6, "end": 1.0},
    {"word": "second", "start": 3.0, "end": 3.4},
    {"word": "line.", "start": 3.4, "end": 3.9},
]
stab = C.stability_score_runs([1, 2, 3, 4], [[1, 2, 3, 4], [1, 2, 3, 4]])
segs = asr.words_to_segments(words, samples, sr, stab)
print(f"     产出 {len(segs)} 行")
for s in segs:
    print(f"       conf={s.get('confidence', {}).get('score')}  parts={s['confidence'].get('parts')}  {s['text'][:40]}")
ok(len(segs) == 2, "按句末标点断开", len(segs))
ok(all("confidence" in s for s in segs), "每行都带 confidence")
ok(all("token" not in (s["confidence"].get("parts") or {}) for s in segs),
   "本引擎的 parts 里**没有** token 项（拿不到就是拿不到，不伪造）")
ok(all("audio" in s["confidence"]["parts"] for s in segs), "有 audio 项")
ok(all("stability" in s["confidence"]["parts"] for s in segs), "有 stability 项")
ok(all(s["confidence"]["worstWord"] is None for s in segs), "worstWord 为 None（没有词级概率）")
ok(all(0.0 <= s["confidence"]["score"] <= 1.0 for s in segs), "分数在 0~1")

print("\n== 不传 samples 时不加置信度（向后兼容）==")
segs2 = asr.words_to_segments([dict(w) for w in words])
ok(all("confidence" not in s for s in segs2), "旧调用方式不受影响")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
