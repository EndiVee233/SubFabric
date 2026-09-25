#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Parakeet TDT 0.6B v2 语音识别 worker —— 供 K-ASS-Editor「创建初稿」调用。

用法:
    python asr.py --model <模型目录> --audio <16kHz单声道wav> --out <结果.json> [--threads 4]

模型目录需含: encoder*.onnx / decoder*.onnx / joiner*.onnx / tokens.txt

运行期往 stderr 输出 JSON 行(每行一个 JSON 对象), 供 Node 端增量解析:
    {"type":"log",     "msg":"..."}
    {"type":"progress","pct":42,"stage":"asr","msg":"识别中 3/10 块"}
    {"type":"error",   "msg":"..."}

成功时把结果写到 --out:
    {"duration":123.4, "language":"en", "segments":[{"start":..,"end":..,"text":..,
     "words":[{"word":..,"start":..,"end":..}]}]}

退出码 != 0 表示失败(错误信息在 stderr 的 error 行里)。

注意: parakeet-tdt-0.6b-v2 **仅支持英语**。
"""

import argparse
import array
import json
import os
import sys
import time
import wave

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

SAMPLE_RATE = 16000
FEATURE_DIM = 80

# 基础断句阈值(纯本地规则, 不涉及 LLM)
SENT_END = (".", "?", "!", "。", "？", "！", "…")
SOFT_END = (",", ";", ":")      # 强制断行时优先回退到这里, 避免把句尾词甩成孤行
PAUSE_SPLIT = 0.8     # 停顿超过这个秒数就断行
MAX_LINE_SEC = 10.0   # 行长兜底: 说话不带标点时也不至于糊成一坨
MAX_LINE_WORDS = 30


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------
def emit(obj):
    try:
        sys.stderr.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def log(msg):
    emit({"type": "log", "msg": str(msg)})


def progress(pct, stage, msg):
    emit({"type": "progress", "pct": max(0, min(100, int(pct))), "stage": stage, "msg": str(msg)})


# --------------------------------------------------------------------------
# 音频
# --------------------------------------------------------------------------
def read_wav_mono16k(path):
    """读 wav -> (float32 numpy 数组[-1,1], 采样率)。立体声降单声道, 非 16k 则线性重采样兜底。"""
    import numpy as np

    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sr = wf.getframerate()
        width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())

    if width != 2:
        raise RuntimeError("只支持 16-bit PCM wav(当前 %d 字节/样本)" % width)

    a = array.array("h")
    a.frombytes(raw)
    data = np.asarray(a, dtype=np.float32) / 32768.0

    if nch > 1:
        usable = (len(data) // nch) * nch
        data = data[:usable].reshape(-1, nch).mean(axis=1)

    if sr != SAMPLE_RATE:
        n = len(data)
        if n == 0:
            return data, sr
        new_n = max(1, int(round(n * SAMPLE_RATE / float(sr))))
        data = np.interp(
            np.linspace(0, n - 1, num=new_n, dtype=np.float32),
            np.arange(n, dtype=np.float32), data).astype(np.float32)
        sr = SAMPLE_RATE
    return data, sr


def frame_energies(samples, sr, frame_ms=20.0, hop_ms=10.0):
    """返回 (每帧 RMS, 每帧起始秒, hop秒)。"""
    import numpy as np

    frame = max(1, int(sr * frame_ms / 1000.0))
    hop = max(1, int(sr * hop_ms / 1000.0))
    if len(samples) < frame:
        e = float(np.sqrt(np.mean(np.square(samples)))) if len(samples) else 0.0
        return np.array([e], dtype=np.float32), 0.0, float(hop) / sr

    n_frames = 1 + (len(samples) - frame) // hop
    idx = np.arange(frame, dtype=np.int64)[None, :] + hop * np.arange(n_frames, dtype=np.int64)[:, None]
    energies = np.sqrt(np.mean(np.square(samples[idx]), axis=1)).astype(np.float32)
    return energies, 0.0, float(hop) / sr


def split_chunks(samples, sr, target_sec=26.0, search_sec=5.0, min_tail=3.0):
    """切成约 target_sec 的块, 切点落在附近能量最低处。

    NeMo encoder 不能一次吃下超长音频(中间张量随长度膨胀会 OOM), 必须分块推理;
    切点选在局部能量最低处是为了尽量落在静音里, 避免把词切断。
    """
    import numpy as np

    total_sec = len(samples) / float(sr)
    if total_sec <= target_sec:
        return [(0.0, total_sec)]

    energies, _, hop_sec = frame_energies(samples, sr)
    search_frames = max(1, int(search_sec / hop_sec))
    min_tail_frames = max(1, int(min_tail / hop_sec))
    tail_limit = max(0, int((total_sec - min_tail) / hop_sec))

    chunks = []
    start = 0.0
    while True:
        remain = total_sec - start
        if remain <= target_sec * 1.3:
            chunks.append((start, total_sec))
            break
        f_ideal = int((start + target_sec) / hop_sec)
        f_lo = int(start / hop_sec) + min_tail_frames
        f_hi = min(len(energies) - 1, tail_limit, f_ideal + search_frames)
        if f_hi <= f_lo:
            chunks.append((start, total_sec))
            break
        cut = f_lo + int(np.argmin(energies[f_lo:f_hi + 1]))
        t_cut = max(start + min_tail, min(cut * hop_sec, total_sec))
        if t_cut >= total_sec - 0.05:
            chunks.append((start, total_sec))
            break
        chunks.append((start, t_cut))
        start = t_cut
    return chunks


# --------------------------------------------------------------------------
# 模型与推理
# --------------------------------------------------------------------------
def load_vocab(tokens_path):
    """tokens.txt → {片段: id}; 每行形如 '▁the 5'(空格分隔, id 在最后)"""
    vocab = {}
    try:
        with open(tokens_path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                i = line.rfind(" ")
                if i <= 0:
                    continue
                vocab[line[:i]] = line[i + 1:]
    except Exception:
        return {}
    return vocab


def bpe_encode(word, vocab):
    """把一个词拆成词表里存在的 BPE 片段(首片段带 ▁); 拆不出来返回 None。
    贪心最长前缀 —— 不是严格 BPE, 但只要能命中词表就足以让热词生效。"""
    if not vocab:
        return None
    rest = "\u2581" + str(word).strip()
    out = []
    while rest:
        hit = None
        for n in range(len(rest), 0, -1):
            if rest[:n] in vocab:
                hit = rest[:n]
                break
        if not hit:
            return None
        out.append(hit)
        rest = rest[len(hit):]
    return out


def load_recognizer(model_dir, threads, hotwords=None, hotwords_score=3.0):
    import glob
    import tempfile
    import sherpa_onnx

    def pick(pattern):
        hits = sorted(glob.glob(os.path.join(model_dir, pattern)))
        return hits[0] if hits else None

    encoder = pick("encoder*.onnx")
    decoder = pick("decoder*.onnx")
    joiner = pick("joiner*.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")
    missing = [n for n, v in (("encoder*.onnx", encoder), ("decoder*.onnx", decoder),
                              ("joiner*.onnx", joiner), ("tokens.txt", tokens))
               if not v or not os.path.exists(v)]
    if missing:
        raise RuntimeError("模型文件不完整(%s): 缺少 %s" % (model_dir, " / ".join(missing)))

    # ── 热词(上下文偏置) ──
    # 实测(sherpa-onnx 1.13.8 + parakeet-tdt-0.6b-v2):
    #   ① 热词**必须**用词汇表里的 BPE 片段表示 —— 直接写 "Bdubs" 会被静默跳过(日志里
    #      Cannot find ID for token), 看起来就像"热词没生效";
    #   ② 必须配 decoding_method="modified_beam_search"(greedy_search 直接报错);
    #   ③ hotwords_score 默认 1.5 实测**无效**; 3.0 生效且正确; ≥6 开始复读热词、12 彻底崩坏。
    #      → 因此默认给 3.0, 并在文档里写清安全区间。
    hw_path = None
    if hotwords:
        pieces_all = []
        skipped = []
        vocab = load_vocab(tokens)
        for w in hotwords:
            enc_pieces = bpe_encode(w, vocab)
            if enc_pieces:
                pieces_all.append(" ".join(enc_pieces))
            else:
                skipped.append(w)
        if skipped:
            log("热词无法编码(词表缺片段), 已跳过: %s" % ", ".join(skipped))
        if pieces_all:
            hw_path = os.path.join(tempfile.gettempdir(),
                                   "kass-hotwords-%d.txt" % os.getpid())
            with open(hw_path, "w", encoding="utf-8") as f:
                f.write("\n".join(pieces_all) + "\n")
            log("启用热词 %d 条(score=%s): %s" % (len(pieces_all), hotwords_score,
                                                 ", ".join(hotwords[:8]) + ("…" if len(hotwords) > 8 else "")))
        else:
            log("没有可用的热词(全部无法编码), 按无热词识别")

    log("加载 Parakeet 模型 …")
    t0 = time.time()
    kw = dict(
        encoder=encoder, decoder=decoder, joiner=joiner, tokens=tokens,
        num_threads=threads, sample_rate=SAMPLE_RATE, feature_dim=FEATURE_DIM,
        decoding_method=("modified_beam_search" if hw_path else "greedy_search"),
        model_type="nemo_transducer",
    )
    if hw_path:
        kw["hotwords_file"] = hw_path
        kw["hotwords_score"] = float(hotwords_score)
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(**kw)
    log("模型加载完成, 耗时 %.1fs" % (time.time() - t0))
    return rec


def recognize_words(rec, samples, sr, chunks):
    """逐块推理 -> 词列表 [{word, start, anchor}]。

    token 聚成词靠 BPE 约定「以空格开头的 token 是词首」。模型给的是 token 起始时间;
    标点 token 的时间戳常落在停顿里, 所以额外记录最后一个「含字母数字的 token」的
    时间作为 anchor, 后续用它推算真实结束时间。
    """
    words = []
    for ci, (cs, ce) in enumerate(chunks):
        seg = samples[int(cs * sr):int(ce * sr)]
        if len(seg) == 0:
            continue
        stream = rec.create_stream()
        stream.accept_waveform(sr, seg)
        rec.decode_stream(stream)
        r = stream.result

        cur = None
        for tok, ts in zip(r.tokens, getattr(r, "timestamps", [])):
            piece = tok.strip()
            if not piece:
                continue
            t_abs = float(ts) + cs
            if cur is not None and tok.startswith(" "):
                words.append(cur)
                cur = None
            if cur is None:
                cur = {"word": piece, "start": t_abs, "anchor": t_abs}
            else:
                cur["word"] += piece
            if any(ch.isalnum() for ch in piece):
                cur["anchor"] = t_abs
        if cur:
            words.append(cur)

        progress(30 + int((ci + 1) / max(1, len(chunks)) * 55), "asr",
                 "识别中 … 第 %d/%d 块" % (ci + 1, len(chunks)))

    words.sort(key=lambda w: w["start"])
    for i in range(1, len(words)):            # 时间戳偶发抖动, 不允许倒退
        if words[i]["start"] < words[i - 1]["start"]:
            words[i]["start"] = words[i - 1]["start"]
    return words


def refine_word_ends(words, samples, sr):
    """确定词结束时间。

    连续语音 -> 下一词起点就是本词真实结束; 遇到停顿 -> 用音频能量找语音真正停下的
    位置(直接沿用下一词起点会让句末词一直亮到下一句开头)。
    """
    import numpy as np

    MAX_PAUSE = 0.5
    total_sec = len(samples) / float(sr)
    energies, _, hop_sec = frame_energies(samples, sr)
    thr = max(float(np.percentile(energies, 30)) * 2.0, float(energies.max()) * 0.10, 1e-4) \
        if len(energies) else 1e-4

    def voice_end(t_from, t_to):
        lo = max(0, int(t_from / hop_sec))
        hi = min(len(energies) - 1, int(t_to / hop_sec))
        if hi < lo:
            return t_from
        above = np.nonzero(energies[lo:hi + 1] > thr)[0]
        if len(above) == 0:
            return t_from
        return (lo + int(above[-1]) + 1) * hop_sec

    for i, w in enumerate(words):
        nxt = words[i + 1]["start"] if i + 1 < len(words) else total_sec
        anchor = w.get("anchor", w["start"])
        if nxt - anchor <= MAX_PAUSE:
            end = nxt
        else:
            chars = sum(1 for ch in w["word"] if ch.isalnum())
            est = min(0.6, max(0.15, 0.055 * max(1, chars)))
            end = voice_end(anchor, min(nxt, anchor + est + 0.35))
            if end <= w["start"] + 0.02:
                end = min(nxt, anchor + est)
        w["end"] = max(min(end, total_sec), w["start"] + 0.02)
        w.pop("anchor", None)
    return words


def words_to_segments(words):
    """基础断句: 句末标点 / 长停顿 / 行长兜底。纯本地规则, 不调用 LLM。"""
    groups, cur = [], []
    for w in words:
        if cur:
            prev = cur[-1]
            too_long = (w["start"] - cur[0]["start"]) > MAX_LINE_SEC or len(cur) >= MAX_LINE_WORDS
            if prev["word"].rstrip().endswith(SENT_END) or (w["start"] - prev["end"]) > PAUSE_SPLIT:
                groups.append(cur)
                cur = []
            elif too_long:
                # 被长度逼着断行时, 尽量在最近的软标点(逗号/分号/冒号)处断开 ——
                # 否则会出现「with.」这种只剩一个句尾词的孤行。
                cut = None
                for j in range(len(cur) - 1, -1, -1):
                    if cur[j]["word"].rstrip().endswith(SOFT_END) and (j + 1) >= 6:
                        cut = j + 1
                        break
                if cut:
                    groups.append(cur[:cut])
                    cur = cur[cut:]
                else:
                    groups.append(cur)
                    cur = []
        cur.append(w)
    if cur:
        groups.append(cur)

    out = []
    for i, ws in enumerate(groups):
        out.append({
            "id": i,
            "start": ws[0]["start"],
            "end": ws[-1]["end"],
            "text": " ".join(w["word"] for w in ws).strip(),
            "words": [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in ws],
        })
    for i in range(1, len(out)):              # 相邻行不交叠
        if out[i]["start"] < out[i - 1]["end"]:
            out[i]["start"] = out[i - 1]["end"]
    return out


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Parakeet TDT 0.6B v2 ASR worker")
    ap.add_argument("--model", required=True, help="模型目录(含 encoder/decoder/joiner .onnx + tokens.txt)")
    ap.add_argument("--audio", required=True, help="16kHz 单声道 PCM wav")
    ap.add_argument("--out", required=True, help="结果 JSON 输出路径")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--hotwords-file", default="",
                    help="热词文件: 每行一个词/短语(原始文本, 本脚本负责转 BPE 片段)")
    ap.add_argument("--hotwords-score", type=float, default=3.0,
                    help="热词强度(实测: 1.5 无效 / 3.0 生效且正确 / >=6 开始复读崩坏)")
    args = ap.parse_args()

    hotwords = []
    if args.hotwords_file:
        try:
            with open(args.hotwords_file, encoding="utf-8") as f:
                hotwords = [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]
        except Exception as e:
            log("读取热词文件失败(%s), 按无热词识别" % e)
            hotwords = []

    try:
        log("读取音频 …")
        samples, sr = read_wav_mono16k(args.audio)
        dur = len(samples) / float(sr)
        log("音频 %.1fs @ %dHz" % (dur, sr))
        if dur < 0.2:
            raise RuntimeError("音频过短或无有效采样")

        progress(10, "asr", "准备识别 %d 秒音频" % int(dur))
        chunks = split_chunks(samples, sr)
        log("分块 %d 段" % len(chunks))
        progress(22, "asr", "开始识别(%d 段)" % len(chunks))

        rec = load_recognizer(args.model, args.threads, hotwords, args.hotwords_score)
        t0 = time.time()
        words = recognize_words(rec, samples, sr, chunks)
        if not words:
            raise RuntimeError("未识别到语音内容(模型输出为空)")
        log("识别完成 %d 词, 耗时 %.1fs" % (len(words), time.time() - t0))

        progress(88, "asr", "整理词级时间轴 …")
        words = refine_word_ends(words, samples, sr)
        segments = words_to_segments(words)
        log("断句完成 %d 行" % len(segments))

        tmp = args.out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"duration": round(dur, 3), "language": "en", "segments": segments},
                      f, ensure_ascii=False)
        os.replace(tmp, args.out)

        progress(100, "asr", "识别完成: %d 行" % len(segments))
        log("结果已写入 %s" % args.out)
        return 0

    except Exception as e:
        emit({"type": "error", "msg": str(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
