#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ASR 置信度：三个独立信号 + 融合。

为什么要三个信号，而不是只用模型概率：
  * **token 概率**（模型自己给的）—— 直接，但对"自信地听错"不敏感：口音重的音频
    常常是"高概率的错误转写"。
  * **音频质量**（波形算的，跟模型无关）—— 信噪比低、削波、静音过多时，任何模型都
    容易出错，这是先验风险。
  * **识别稳定性**（同一段音频加不同噪声重跑，比对转写）—— 最贴近"这句话到底可不可信"：
    如果加了点噪声结果就变了，说明模型在这段音频上本来就站不稳。

三者都归一到 0~1（越大越可信）再取**最小值为主、平均值为辅**：任何一项很差都该拉低
整体评分（只取平均会让"概率高但重跑结果不稳定"的句子蒙混过去）。

本模块只依赖 numpy，可单独测试（见 tests/confidence-test.py）。
"""

from __future__ import annotations

import numpy as np

# ── 分数映射的锚点（改这些就是在调"多严才算低置信度"）────────────────────
TOK_ZERO = 0.55          # token 概率低于此 → 该项 0 分
TOK_ONE = 0.97           # 高于此 → 满分
# token 级接口的锚点（影响 stability_score）。对齐之后一致率能真正到 1.0，
# 所以满分线必须设到 1.0，否则"完全一致"也拿不到满分（踩过）。
STAB_ZERO = 0.45         # 一致率低于此 → 0 分
STAB_ONE = 1.0           # 完全一致 → 满分
SNR_ZERO_DB = 4.0        # 信噪比低于 4dB → 音频质量 0 分
SNR_ONE_DB = 26.0        # 高于 26dB → 满分
QUAL_MIN = 0.08          # 音频质量分数下限（别让好音频出现 0 分这种吓人的数）
QUAL_MAX = 0.97          # 上限同理（没有"绝对可信"这回事）

# 整体分：最小值与平均值按这个权重混合
W_WORST = 0.65
W_MEAN = 0.35

# 低于这个整体分就在界面上标成"需复核"。
# 0.60 是拿真实样本扫出来的（tests/sweep-thresholds.py）：clean 标 0/10、noisy 与 clipped
# 各 5/10、verynoisy 9/9。定 0.62 时 clean 虽也是 0，但 0.65 起 clean 开始误报 ——
# 那才是真的毁掉筛选价值（clean 一大片被标"需复核"就没人再看了）。
LOW_CONFIDENCE = 0.60


def _lerp(x: float, x0: float, x1: float) -> float:
    """把 [x0, x1] 线性映射到 [0, 1] 并夹紧。"""
    if x1 == x0:
        return 1.0 if x >= x1 else 0.0
    return float(min(1.0, max(0.0, (x - x0) / (x1 - x0))))


# --------------------------------------------------------------------------
# 音频质量（与模型无关，纯粹看波形）
# --------------------------------------------------------------------------
def audio_quality(samples) -> dict:
    """算一段音频的"好不好识别"，返回各指标 + 综合分。

    指标：
      snrDb        语音电平与噪声本底的差（用分位数估计，不假设有静音段）
      clippingPct  贴顶采样占比（削波会把音素糊掉，任何模型都救不回来）
      silencePct   低于噪声门限的时长占比（太多静音说明这段本来就没多少话）
      speechDb     语音段的电平（太小声也难识别）
    """
    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    out = {"snrDb": 0.0, "clippingPct": 0.0, "silencePct": 0.0, "speechDb": -60.0, "score": 0.0}
    if x.size < 160:                       # 不到 10ms，没什么可评的
        out["score"] = 0.2
        return out

    frame = 320                            # 20ms
    hop = 160                              # 10ms
    n = 1 + (x.size - frame) // hop
    if n < 2:
        out["score"] = 0.3
        return out
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(np.square(x[idx]), axis=1))
    rms = np.maximum(rms, 1e-7)
    db = 20.0 * np.log10(rms)

    p10, p95 = float(np.percentile(db, 10.0)), float(np.percentile(db, 95.0))
    # 噪声本底取第 10 百分位、语音电平取第 95 —— 比"拿开头当噪声"那种做法稳，
    # 因为实际素材经常一开头就是人声。
    speech_db = p95
    noise_db = p10
    snr_db = max(0.0, speech_db - noise_db)

    peak = float(np.max(np.abs(x)))
    clipping_pct = float(np.mean(np.abs(x) >= 0.995) * 100.0)
    # 噪声门限：本底之上 6dB 算"有语音"
    gate_db = noise_db + 6.0
    silence_pct = float(np.mean(db < gate_db) * 100.0)

    out.update({
        "snrDb": round(snr_db, 1),
        "clippingPct": round(clipping_pct, 3),
        "silencePct": round(silence_pct, 1),
        "speechDb": round(speech_db, 1),
        "peak": round(peak, 3),
    })

    # ── 综合分 ──
    s_snr = _lerp(snr_db, SNR_ZERO_DB, SNR_ONE_DB)
    # 削波：1% 就该显著扣分，5% 以上基本没救
    s_clip = 1.0 - _lerp(clipping_pct, 0.05, 5.0)
    # 电平太低（语音段都在 -42dB 以下）说明录音太小声
    s_level = _lerp(speech_db, -42.0, -20.0)
    # 静音占比：超过 55% 开始扣，92% 扣光
    s_sil = 1.0 - _lerp(silence_pct, 55.0, 92.0)

    raw = 0.50 * s_snr + 0.22 * s_clip + 0.14 * s_level + 0.14 * s_sil
    out["score"] = round(min(QUAL_MAX, max(QUAL_MIN, raw)), 4)
    return out


# --------------------------------------------------------------------------
# token 概率 → 逐词 / 整句
# --------------------------------------------------------------------------
def token_score(probs):
    """一串 token 概率 → 分数；**没有任何有效数据时返回 None**。

    ⚠ 不要把"没数据"当成 0 分。踩过的坑：clean 音频里 97/152 个词因为拿不到概率而被记成
      0.000，整段分数被拖到 0.19，所有句子都被标成低置信度 —— 而它们的转写其实是对的。
      "没有数据"和"数据说很差"必须区分：前者返回 None，由调用方决定怎么处理（跳过）。

    ⚠ 不要用硬最小值。踩过的坑：294 个 token 里只有 1 个 0.41，硬取最小值就把整段打到
      0.41（再经"每词取最小、整段取最小"层层放大），clean 音频整体分只有 0.19，所有句子
      都被标成低置信度 —— 那就等于没有信号。
      现在用**均值为主 + 低分位数兜底**：单个坏 token 只把分数压一部分，成片的低概率
      才会真正拉低。
    """
    p = sorted(float(v) for v in probs if v is not None and v == v)   # v==v 排除 NaN
    if not p:
        return None
    mean = sum(p) / len(p)
    if len(p) >= 4:
        # 低分位数（约 20% 位置）当兜底，但不取极值
        low = p[max(0, int(len(p) * 0.2) - 1)]
        # 有一点极值敏感度：最差的那个只占很小权重
        worst = p[0]
        blended = 0.55 * mean + 0.33 * low + 0.12 * worst
    else:
        # 词很短（1~3 个 token）时，任何一个低概率都值得重视
        blended = 0.60 * mean + 0.40 * p[0]
    return round(_lerp(blended, TOK_ZERO, TOK_ONE), 4)


# --------------------------------------------------------------------------
# 稳定性（多遍加噪重跑的一致性）
# --------------------------------------------------------------------------
def edit_align(a: list, b: list) -> list:
    """序列对齐：返回 [(i, j), ...] 表示 a[i] 与 b[j] 是对应位置。

    为什么需要它：加噪重跑会让 token 数变化（多一个或少一个），此时按**同一下标**比较
    会导致后面全部错位、一致率直接崩到 0 —— 而转写其实基本正确。必须先对齐。
    代价：相同=0，替换/插入/删除=1（Levenshtein）。序列只有几百个 token，O(n·m) 足够。
    """
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return []
    # 常见情况：长度相同且完全相同 → 直接返回，省掉 DP
    if n == m and a == b:
        return [(i, i) for i in range(n)]
    prev = list(range(m + 1))
    # 回溯表用字节数组存方向，省内存（0=对角 1=上 2=左）
    bt = [bytearray(m + 1) for _ in range(n + 1)]
    for j in range(m + 1):
        bt[0][j] = 2
    for i in range(1, n + 1):
        cur = [prev[0] + 1] + [0] * m
        bt[i][0] = 1
        for j in range(1, m + 1):
            diag = prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)
            up = prev[j] + 1
            left = cur[j - 1] + 1
            best = diag
            d = 0
            if up < best:
                best, d = up, 1
            if left < best:
                best, d = left, 2
            cur[j] = best
            bt[i][j] = d
        prev = cur
    pairs = []
    i, j = n, m
    while i > 0 and j > 0:
        d = bt[i][j]
        if d == 0:
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif d == 1:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def stability_from_runs(clean: list, noisy: list, words: list) -> dict:
    """稳定性：同一段音频重跑（加噪）后，**有多少个词**的转写变了。

    为什么按"词"而不按"token"：
      一段话通常有 20~50 个 token，只错一个 token 时"token 一致率"是 0.98 —— 任何合理
      映射都会把它夹到接近满分，等于没信号（踩过这个坑）。但对校对的人来说，"这句话里
      有 1 个词重跑就变了"是实打实的 1/19 风险，按词聚合才符合直觉。

    args:
      clean  [{id, frame, prob}]      干净跑的 token（第一遍）
      noisy  [[{id, frame}], ...]     加噪重跑的若干遍
      words  [{start, end, ...}]      该段已合并好的词（秒，已含窗口偏移）
    """
    if not clean:
        return {"stability": 0.0, "affectedWords": 0, "wordCount": 0,
                "tokenDisagreements": 0, "runs": 1 + len(noisy)}
    if not noisy or not words:
        return {"stability": 1.0, "affectedWords": 0, "wordCount": len(words),
                "tokenDisagreements": 0, "runs": 1 + len(noisy)}

    # 序列对齐后再比对（**不能**按同下标比，见下面 edit_align 的说明）
    disagreements = set()
    for other in noisy:
        pairs = edit_align([t["id"] for t in clean], [t["id"] for t in other])
        for i, oi in pairs:
            if clean[i]["id"] != other[oi]["id"]:
                disagreements.add(i)
        # 对齐后没能配上的 token（插入/删除）也算不一致
        matched = {i for i, _ in pairs}
        for i in range(len(clean)):
            if i not in matched:
                disagreements.add(i)

    # 位置 → 词：**按序号区间分配**，不用时间区间。
    # 踩过的坑：一开始用"token 时间落在词的 [start-0.02, end+0.25] 内"来归词，结果相邻
    # 词的容差窗互相重叠（词的 end 与下一词的 start 本来就贴着），两个词的 token 被算进
    # 同一个词、另一个词被漏掉 —— 实测"错 3 个词"只报出 2 个。词边界与 token 序列一样是
    # 顺序切分，直接按比例分区间就没有这个问题。
    n = max(1, len(words))
    affected = set()
    for i in disagreements:
        wi = min(n - 1, (i * n) // max(1, len(clean)))
        affected.add(wi)

    frac = len(affected) / n
    return {
        "stability": round(1.0 - _lerp(frac, 1.0 - STAB_ONE, STAB_ZERO), 4),
        "affectedWords": len(affected),
        "wordCount": n,
        "tokenDisagreements": len(disagreements),
        "runs": 1 + len(noisy),
    }


def stability_score(runs: list) -> dict:
    """按 token 位置算一致性（**不**按词聚合；保留给拿不到词边界的场景，也是单测入口）。

    ⚠ 对"整句只错一个 token"不敏感（一致率 0.98 会落进饱和区）。正式路径请用
      stability_from_runs —— 它按受影响的**词**占比打分，才符合校对时的直觉。
    """
    original = list(runs)
    runs = [r for r in runs if r]
    if not runs:
        # 跑了两遍却都是空的：说明这段音频压根没解出内容，不能当"没得比"给满分
        return {"stability": 0.0, "tokenAgreement": 0.0, "runs": len(original)}
    if len(runs) < 2:
        return {"stability": 1.0, "tokenAgreement": 1.0, "runs": len(runs)}
    base = runs[0]

    # 先做序列对齐再比对 —— 与 stability_from_runs 同一套逻辑。
    # ⚠ 不能按同下标比：加噪重跑会改变 token 数，一旦长度不同后面全部错位，一致率会崩到
    #   0.5 以下（实测），于是"完全一致"和"差一点"都拿不到分。
    agree = 0.0
    for other in runs[1:]:
        pairs = edit_align(base, other)
        same = sum(1 for i, j in pairs if base[i] == other[j])
        agree += same / max(1, max(len(base), len(other)))
    agreement = agree / len(runs[1:])

    len_penalty = 1.0
    for other in runs[1:]:
        ratio = min(len(base), len(other)) / max(1, max(len(base), len(other)))
        len_penalty = min(len_penalty, ratio)

    combined = 0.8 * agreement + 0.2 * len_penalty
    return {
        "stability": round(_lerp(combined, STAB_ZERO, STAB_ONE), 4),
        "tokenAgreement": round(agreement, 4),
        "runs": len(runs),
    }


# --------------------------------------------------------------------------
# 融合
# --------------------------------------------------------------------------
def fuse(token: float, audio: float, stability: float) -> dict:
    """三个 0~1 分数 → 整体置信度 + 分项。"""
    parts = {"token": round(float(token), 3),
             "audio": round(float(audio), 3),
             "stability": round(float(stability), 3)}
    worst = min(parts.values())
    mean = sum(parts.values()) / len(parts)
    overall = W_WORST * worst + W_MEAN * mean
    return {
        "score": round(float(overall), 3),
        "low": bool(overall < LOW_CONFIDENCE),
        "parts": parts,
    }


def fuse_available(token, audio, stability) -> dict:
    """按**可用信号**融合（None = 该信号拿不到）。

    为什么要这个：两个 ASR 引擎能给的东西不一样 —— NPU 引擎自己解码，能读到 logits，
    三个信号都有；CUDA 引擎走 sherpa-onnx，result 里只有 text/tokens/timestamps，
    **没有概率**。这时不能把 token 项当 0（那会把所有句子都判成低置信度），
    也不该假装有——按实际可用的信号加权，缺的那项在 parts 里就是不出现。
    """
    vals = {}
    if token is not None:
        vals["token"] = float(token)
    if audio is not None:
        vals["audio"] = float(audio)
    if stability is not None:
        vals["stability"] = float(stability)
    if not vals:
        return {"score": 0.0, "low": True, "parts": {}}
    lo = min(vals.values())
    mean = sum(vals.values()) / len(vals)
    overall = W_WORST * lo + W_MEAN * mean
    return {
        "score": round(float(overall), 3),
        "low": bool(overall < LOW_CONFIDENCE),
        "parts": {k: round(v, 3) for k, v in vals.items()},
        "missing": [k for k in ("token", "audio", "stability") if k not in vals],
    }


def stability_score_runs(clean_ids: list, noisy_runs: list) -> dict:
    """两个纯 token id 序列列表 → 稳定性（供拿不到 frame 的引擎用）。

    CUDA 引擎（sherpa）只能拿到 token 文本/序号，拿不到帧号，所以归词那一步做不了；
    这里只按整段序列算一致性。与 stability_score 用同一套对齐逻辑。
    """
    runs = [clean_ids] + [r for r in noisy_runs if r is not None]
    return stability_score(runs)


# --------------------------------------------------------------------------
# 给 ASR worker 用的适配层：token 概率 → 词 → 句
# --------------------------------------------------------------------------
def probs_to_words(words: list, token_probs: dict) -> None:
    """把 {token 序号: 概率} 摊到每个词上（就地写入 w['_p'] 列表）。

    词的序号区间与 token 序列顺序一致（词就是按 token 合并出来的），所以按比例分区间
    即可 —— 不用时间戳，避免词边界与 token 边界不一致时错配。
    """
    n = len(words)
    if n == 0 or not token_probs:
        return
    for idx in range(n):
        words[idx].setdefault("_p", [])
    total = max(token_probs) + 1
    for ti, p in token_probs.items():
        wi = min(n - 1, (ti * n) // max(1, total))
        words[wi]["_p"].append(p)


def make_confidence(words: list, audio: dict, stability: dict, token_fallback: float = 0.0) -> dict:
    """用已归好概率的词 + 音频质量 + 稳定性，算出**整段**置信度。

    段级的 token 项用「均值为主 + 第 10 百分位兜底」，**不用硬最小值**：
    一段话上百个词，硬取最小值等于让单个坏词代表整段（实测把 clean 音频打到 0.19）。
    句级仍然可以把"最差的词"点出来（那是有用的定位信息），但整段评分要稳健。
    """
    raw = [token_score(w.get("_p") or []) for w in words]
    scored = [v for v in raw if v is not None]
    if scored:
        s = sorted(scored)
        mean = sum(s) / len(s)
        p10 = s[max(0, int(len(s) * 0.10) - 1)]
        worst = s[0]
        token_part = 0.55 * mean + 0.33 * p10 + 0.12 * worst
    else:
        token_part = token_fallback
    conf = fuse(token_part, audio.get("score", 0.0), stability.get("stability", 1.0))
    # 没有数据的词写 None（界面显示"—"），不要写成 0 分
    conf["wordScores"] = [None if v is None else round(v, 3) for v in raw]
    conf["scoredWords"] = len(scored)
    conf["wordCount"] = len(raw)
    if scored:
        conf["worstWord"] = int(next(i for i, v in enumerate(raw) if v == min(scored)))
    else:
        conf["worstWord"] = None
    return conf


def audio_summary(audio: dict) -> dict:
    """只留要写进 JSON 的音频指标（去掉内部字段）。"""
    return {k: audio[k] for k in ("snrDb", "clippingPct", "silencePct", "speechDb")
            if k in audio}
