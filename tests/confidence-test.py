#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""置信度算法的单元测试（不需要模型、不需要音频文件）。

跑法：
    python tests/confidence-test.py

用合成信号构造"干净 / 嘈杂 / 削波 / 太小声"四种音频，验证音频质量分能区分它们；
再用构造的 token 概率与多遍 token 序列，验证分数映射与稳定性计算的方向性
（好的必须比差的得分高，且都落在 0~1）。
"""

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "asr"))

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


def synth(speech_db=-20.0, noise_db=-70.0, seconds=3.0, clip=False, silence_ratio=0.15, seed=0):
    """合成一段"语音+本底噪声"：语音段与静音段交替，便于验证分位数估计。"""
    rng = np.random.default_rng(seed)
    sr = 16000
    n = int(sr * seconds)
    sp = 10 ** (speech_db / 20.0)
    nz = 10 ** (noise_db / 20.0)
    # 语音包络：交替的有声/静音
    env = np.zeros(n)
    seg = int(sr * 0.4)
    i = 0
    while i < n:
        if rng.random() > silence_ratio:
            env[i:i + seg] = 1.0
        i += seg
    speech = np.sin(2 * np.pi * 220 * np.arange(n) / sr) * env * sp
    # 加一点共振峰似的谐波，别让信号是纯正弦（更接近真实）
    speech += 0.4 * np.sin(2 * np.pi * 660 * np.arange(n) / sr) * env * sp
    x = speech + rng.normal(0, nz, n)
    if clip:
        x = np.clip(x * 8.0, -1.0, 1.0)
    return x.astype(np.float32)


print("== 音频质量：四种情况必须能区分 ==")
clean = C.audio_quality(synth(speech_db=-20, noise_db=-72))
noisy = C.audio_quality(synth(speech_db=-20, noise_db=-28))
clipped = C.audio_quality(synth(speech_db=-10, noise_db=-60, clip=True))
quiet = C.audio_quality(synth(speech_db=-48, noise_db=-72))

for name, r in (("干净", clean), ("嘈杂", noisy), ("削波", clipped), ("太小声", quiet)):
    print(f"     {name}: score={r['score']}  snr={r['snrDb']}dB  clip={r['clippingPct']}%  "
          f"silence={r['silencePct']}%  speech={r['speechDb']}dB")

ok(clean["score"] > noisy["score"], "干净 > 嘈杂", (clean["score"], noisy["score"]))
ok(clean["score"] > clipped["score"], "干净 > 削波", (clean["score"], clipped["score"]))
ok(clean["score"] > quiet["score"], "干净 > 太小声", (clean["score"], quiet["score"]))
ok(clean["snrDb"] > noisy["snrDb"] + 15, "信噪比估计能分开", (clean["snrDb"], noisy["snrDb"]))
ok(clipped["clippingPct"] > 1.0, "削波比例能检测到", clipped["clippingPct"])
ok(all(0.0 <= r["score"] <= 1.0 for r in (clean, noisy, clipped, quiet)), "分数都在 0~1")

print("\n== token 概率映射 ==")
hi = C.token_score([0.99, 0.98, 0.995])
mid = C.token_score([0.85, 0.80, 0.90])
lo = C.token_score([0.60, 0.55, 0.62])
one_bad = C.token_score([0.99, 0.99, 0.30])
print(f"     高={hi}  中={mid}  低={lo}  一个很差={one_bad}")
ok(hi > mid > lo, "概率越高分越高", (hi, mid, lo))
ok(one_bad < mid, "一个很差的 token 会显著拉低整句（不是被平均掉）", (one_bad, mid))
ok(hi <= 1.0 and lo >= 0.0, "映射后仍在 0~1")

print("\n== 稳定性（按词聚合，正式路径）==")
# 10 个词、每个词 2 个 token（token 索引 i 与词索引 i*2 对齐）
words = [{"start": i * 0.5, "end": i * 0.5 + 0.45} for i in range(10)]
clean = [{"id": 100 + i, "frame": i, "prob": 0.95} for i in range(20)]


def with_errors(word_indices):
    """把指定词的第一个 token 改掉，模拟"重跑后这个词变了"。"""
    out = [dict(t) for t in clean]
    for wi in word_indices:
        out[wi * 2]["id"] = 999
    return out


r_clean = C.stability_from_runs(clean, [clean, clean], words)
r_1word = C.stability_from_runs(clean, [with_errors([3])], words)
r_3word = C.stability_from_runs(clean, [with_errors([1, 4, 7])], words)
r_allbad = C.stability_from_runs(clean, [with_errors(list(range(10)))], words)
for name, r in (("完全一致", r_clean), ("1/10 词变了", r_1word),
                ("3/10 词变了", r_3word), ("10/10 词变了", r_allbad)):
    print(f"     {name}: stability={r['stability']}  受影响词={r['affectedWords']}/{r['wordCount']}"
          f"  不一致 token={r['tokenDisagreements']}")
ok(r_clean["stability"] == 1.0 and r_clean["affectedWords"] == 0, "一致 → 满分、0 个词受影响")
ok(r_1word["affectedWords"] == 1, "1 个词变了 → 只算 1 个词受影响", r_1word["affectedWords"])
# 这条抓出过归词的边界 bug：用"时间区间+容差"归词时，相邻词的窗口重叠，
# 3 个词只报出 2 个。现在按 token 序号区间分配，数量必须是准的。
ok(r_3word["affectedWords"] == 3, "3 个词变了 → 必须算 3 个词（不能因边界重叠漏算）",
   r_3word["affectedWords"])
ok(r_clean["stability"] > r_1word["stability"] > r_3word["stability"] > r_allbad["stability"],
   "受影响词越多分越低", [r["stability"] for r in (r_clean, r_1word, r_3word, r_allbad)])
# 这条是这次真正要解决的：只错一个词必须看得出来（旧实现给 0.97≈满分）
ok(r_1word["stability"] < 0.92,
   "只错 1 个词也要明显低于满分（否则校对时看不出来）", r_1word["stability"])
ok(r_allbad["stability"] == 0.0, "全部词都变 → 0 分", r_allbad["stability"])
ok(0.0 <= r_3word["stability"] <= 1.0, "分数在 0~1")
ok(C.stability_from_runs([], [], words)["stability"] == 0.0, "干净跑为空 → 0")
ok(C.stability_from_runs(clean, [], words)["stability"] == 1.0, "没跑重跑 → 不误判为低")
ok(C.stability_from_runs(clean, [with_errors([0])], [])["stability"] == 1.0,
   "拿不到词边界 → 不误判为低")

print("\n== 稳定性：一致 / 局部错 / 全乱（token 级旧接口）==")
base = list(range(50))
same = C.stability_score([base, list(base), list(base)])
one_wrong = C.stability_score([base, base[:20] + [999] + base[21:], base])
two_wrong = C.stability_score([base, base[:20] + [999] + base[21:30] + [888] + base[31:], base])
scrambled = C.stability_score([base, list(reversed(base))])
shorter = C.stability_score([base, base[:25], base[:25]])
for name, r in (("完全一致", same), ("错一个词", one_wrong), ("错两个词", two_wrong),
                ("完全打乱", scrambled), ("长度差一半", shorter)):
    print(f"     {name}: stability={r['stability']}  agreement={r['tokenAgreement']}")
ok(same["stability"] > 0.85, "完全一致 → 高分", same["stability"])
  # 99% 的 token 一致被判为满分是**对的**（token 级接口本就不该对零星差异过敏；
  # 真正的灵敏度由 stability_from_runs 按词聚合来提供）。所以这里用 >=，只断言全乱明显更差。
ok(same["stability"] >= one_wrong["stability"] > scrambled["stability"],
   "一致 >= 局部错 > 全乱", (same["stability"], one_wrong["stability"], scrambled["stability"]))
# 注意：这个 token 级接口对"50 个里错 1 个"本来就不敏感（0.98 落进映射饱和区）。
# 这正是要引入 stability_from_runs 按词聚合的原因 —— 这里只断言方向性，不苛求灵敏度。
ok(two_wrong["stability"] < one_wrong["stability"], "错得越多分越低",
   (two_wrong["stability"], one_wrong["stability"]))
ok(shorter["stability"] < same["stability"], "长度差异会被惩罚", shorter["stability"])
ok(C.stability_score([base])["stability"] == 1.0, "只跑一遍（没得比）时不误判为低")

print("\n== 融合：任一信号差都要拉低整体 ==")
good = C.fuse(0.95, 0.9, 0.95)
bad_tok = C.fuse(0.2, 0.9, 0.95)
bad_audio = C.fuse(0.95, 0.2, 0.95)
bad_stab = C.fuse(0.95, 0.9, 0.2)
for name, r in (("全好", good), ("概率差", bad_tok), ("音频差", bad_audio), ("不稳", bad_stab)):
    print(f"     {name}: score={r['score']}  low={r['low']}  parts={r['parts']}")
ok(good["score"] > 0.85, "全好 → 高分", good["score"])
ok(not good["low"], "全好不标低置信度")
ok(bad_tok["low"] and bad_audio["low"] and bad_stab["low"], "任一信号很差都会标低置信度")
ok(bad_audio["score"] < good["score"] and bad_stab["score"] < good["score"], "差信号确实拉低整体")
ok(good["score"] > C.fuse(0.7, 0.7, 0.7)["score"], "整体分有区分度")

print("\n== 边界情况不能崩 ==")
ok(C.audio_quality(np.zeros(0))["score"] >= 0.0, "空音频")
ok(C.audio_quality(np.zeros(100))["score"] >= 0.0, "极短音频")
ok(C.token_score([]) is None, "没有概率数据 → None（不是 0 分）")
ok(C.token_score([None, None]) is None, "全是 None → None")
ok(C.token_score([float(chr(110)+chr(97)+chr(110))]) is None, "NaN → None")
ok(C.stability_score([[], []])["stability"] == 0.0, "两遍都是空 → 判 0（没内容可言）")
ok(C.stability_score([])["stability"] == 0.0, "完全没跑过 → 判 0")
ok(isinstance(C.fuse(0, 0, 0)["low"], bool), "全 0 输入不抛异常")

print("\n== 适配层：token 概率 → 词 → 句 ==")
w3 = [{"start": 0.0, "end": 0.5}, {"start": 0.5, "end": 1.0}, {"start": 1.0, "end": 1.5}]
C.probs_to_words(w3, {0: 0.99, 1: 0.98, 2: 0.5, 3: 0.6, 4: 0.99, 5: 0.99})
print("     每词概率:", [w.get("_p") for w in w3])
ok(len([w for w in w3 if w.get("_p")]) == 3, "6 个 token 摊到 3 个词上，每词都有")
ok(all(w.get("_p") for w in w3), "没有词被漏掉")

aud = C.audio_quality(synth(speech_db=-20, noise_db=-72))
stab = C.stability_from_runs([{"id": i, "frame": i} for i in range(6)],
                             [[{"id": i, "frame": i} for i in range(6)]],
                             w3)
conf = C.make_confidence(w3, aud, stab)
print(f"     整段置信度: score={conf['score']} low={conf['low']}")
print(f"     分项: {conf['parts']}  每词: {conf['wordScores']}  最差词: {conf['worstWord']}")
# 段级用稳健统计（均值为主 + 低分位兜底），不能因为一个坏词就把整段判死——
# 这是实测踩出来的：294 个 token 里 1 个 0.41，硬取最小值把 clean 音频打到 0.19。
ok(conf["score"] > 0.5, "一个坏词不该把整段判死（段级用稳健统计）", conf["score"])
ok(conf["worstWord"] == 1, "仍能指出最差的词在哪个位置", conf["worstWord"])
ok(len(conf["wordScores"]) == 3, "每词都给了分数")
ok(conf["parts"]["audio"] > 0.9, "干净音频这一项该高分", conf["parts"]["audio"])
ok(conf["wordScores"][1] < 0.3, "坏词自己的词级分要低（供界面定位）", conf["wordScores"])
ok(isinstance(conf["low"], bool), "low 是布尔值")
summ = C.audio_summary(aud)
ok("score" not in summ and "snrDb" in summ, "audio_summary 只留要写进 JSON 的指标", list(summ))
ok(C.make_confidence([], aud, stab)["score"] >= 0.0, "空词列表不崩")

print("\n== 段级稳健性：单个坏词 vs 成片坏词 ==")
many = [{"start": i * 0.5, "end": i * 0.5 + 0.45} for i in range(20)]
C.probs_to_words(many, {**{i: 0.99 for i in range(20)}, 20: 0.30})      # 只 1 个坏词
c1 = C.make_confidence(many, aud, stab)
C.probs_to_words(many, {**{i: 0.99 for i in range(10)}, **{i: 0.30 for i in range(10, 20)}})
c2 = C.make_confidence(many, aud, stab)
print(f"     1 个坏词: score={c1['score']}   parts.token={c1['parts']['token']}")
print(f"     一半坏词: score={c2['score']}   parts.token={c2['parts']['token']}")
ok(c1["score"] > c2["score"], "成片坏词要比单个坏词明显更低", (c1["score"], c2["score"]))
ok(c1["score"] > 0.55, "单个坏词不该把整段打到低置信度", c1["score"])
ok(c2["score"] < 0.7, "一半词都不可信时整段应当低", c2["score"])

print("\n== 序列对齐：长度变化不能导致全盘错位 ==")
base10 = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
# 重跑时中间多出一个 token（加噪常见）—— 同下标比对会从这里开始全错
inserted = base10[:4] + [99] + base10[4:]
r_ins = C.stability_score([base10, inserted])
# 重跑时中间少掉一个 token
removed = base10[:4] + base10[5:]
r_rem = C.stability_score([base10, removed])
print(f"     多一个 token: stability={r_ins['stability']}  agreement={r_ins['tokenAgreement']}")
print(f"     少一个 token: stability={r_rem['stability']}  agreement={r_rem['tokenAgreement']}")
ok(r_ins["stability"] > 0.8, "中间多一个 token 不该导致全盘错位", r_ins["stability"])
ok(r_rem["stability"] > 0.8, "中间少一个 token 不该导致全盘错位", r_rem["stability"])
ok(r_ins["tokenAgreement"] > 0.85, "对齐后一致率仍应很高", r_ins["tokenAgreement"])
ok(len(C.edit_align(base10, base10)) == 10, "完全相同时对齐结果长度正确")
ok(len(C.edit_align([], base10)) == 0, "空序列对齐不崩")
ok(len(C.edit_align([1, 2, 3], [1, 9, 3])) == 3, "替换也能对齐上")

print("\n== 按可用信号融合（CUDA 引擎拿不到 token 概率）==")
full = C.fuse_available(0.9, 0.9, 0.9)
part = C.fuse_available(None, 0.9, 0.9)
print(f"     三项 {full['parts']} -> {full['score']}  missing={full.get('missing')}")
print(f"     缺 token {part['parts']} -> {part['score']}  missing={part.get('missing')}")
# 这条是关键：把"拿不到"当成 0 分会让所有句子都被判低置信度（踩过同类问题）
ok(part["score"] > 0.8, "缺信号时不能当 0 分", part["score"])
ok(part.get("missing") == ["token"], "缺失项如实标注", part.get("missing"))
ok("token" not in part["parts"], "拿不到的信号不进 parts")
ok(C.fuse_available(None, 0.2, 0.9)["low"] is True, "两项里一项很差仍判低")
ok(C.fuse_available(None, None, None)["score"] == 0.0, "全缺 → 0 不崩")
ok(set(full.get("missing") or []) == set(), "三项齐全时 missing 为空")

print("\n== stability_score_runs（只有 id 序列的引擎用）==")
ids = list(range(60))
ok(C.stability_score_runs(ids, [list(ids)])["stability"] > 0.9, "一致 → 高分")
ok(C.stability_score_runs(ids, [ids[:30] + [999] + ids[31:]])["stability"]
   < C.stability_score_runs(ids, [list(ids)])["stability"], "有差异 → 更低")
ok(C.stability_score_runs(ids, [])["stability"] == 1.0, "没重跑 → 不误判")

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
