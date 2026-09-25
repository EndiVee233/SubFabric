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
def load_recognizer(model_dir, threads):
    import glob
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

    log("加载 Parakeet 模型 …")
    t0 = time.time()
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=encoder, decoder=decoder, joiner=joiner, tokens=tokens,
        num_threads=threads, sample_rate=SAMPLE_RATE, feature_dim=FEATURE_DIM,
        decoding_method="greedy_search", model_type="nemo_transducer",
    )
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
    args = ap.parse_args()

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

        rec = load_recognizer(args.model, args.threads)
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
