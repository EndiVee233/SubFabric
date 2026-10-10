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

# 置信度算法与 NPU 引擎共用同一个模块（asr/confidence.py，有单元测试）。
# 注意：本引擎拿不到 token 概率（sherpa 的 result 只有 text/tokens/timestamps），
# 所以只有「音频质量」与「稳定性」两个信号 —— 融合时按可用信号加权。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import confidence as C  # noqa: E402

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


def _manifest_load(path):
    """读 manifest。返回 (切片列表, manifest 里带的输出路径)。"""
    import json as _json
    with open(path, encoding="utf-8") as fh:
        m = _json.load(fh)
    return (m.get("slices") or []), (m.get("out") or "")


def _manifest_save(out_path, done):
    """增量落盘：每跑完一片写一次，调度器不必等全部结束。"""
    import json as _json
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        _json.dump({"slices": done}, fh, ensure_ascii=False)
    os.replace(tmp, out_path)




def serve_loop(args, build_recognizer, recognize, log_fn):
    """常驻服务循环：模型加载一次，之后反复从 stdin 读任务。

    `recognize(rec, args, job)` 由各脚本提供，返回
    (duration, segments, confidence)；confidence 为 None 表示该引擎没有这个信号。
    """
    import json as _json
    import sys as _sys

    log_fn("常驻模式：加载模型一次 …")
    rec = build_recognizer()
    _sys.stdout.write(_json.dumps({"type": "ready", "device": getattr(rec, "enc_device", "")},
                                  ensure_ascii=False) + "\n")
    _sys.stdout.flush()
    for line in _sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = _json.loads(line)
        except Exception as exc:  # noqa: BLE001
            _sys.stdout.write(_json.dumps({"type": "error", "id": None,
                                           "msg": "请求不是合法 JSON: %s" % exc}) + "\n")
            _sys.stdout.flush()
            continue
        if job.get("cmd") == "quit":
            log_fn("常驻模式：收到 quit，退出")
            return 0
        jid = job.get("id")
        try:
            duration, segments, conf = recognize(rec, args, job)
            out = {"type": "ok", "id": jid, "duration": duration,
                   "language": job.get("language", "en"), "segments": segments}
            if conf is not None:
                out["confidence"] = conf
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc(file=_sys.stderr)
            out = {"type": "error", "id": jid, "msg": str(exc)}
        _sys.stdout.write(_json.dumps(out, ensure_ascii=False) + "\n")
        _sys.stdout.flush()
    return 0


def _serve_recognize(rec, args, job):
    """常驻模式跑一次识别（sherpa）。整段音频，时间戳为绝对时间。"""
    import time as _t
    samples, sr = read_wav_mono16k(job["audio"])
    dur = len(samples) / float(sr)
    if dur < 0.2:
        raise RuntimeError("音频过短或无有效采样")
    t0 = _t.time()
    words = recognize_words(rec, samples, sr, split_chunks(samples, sr))
    if not words:
        raise RuntimeError("未识别到语音内容(模型输出为空)")
    log("识别完成 %d 词, 耗时 %.1fs（模型未重载）" % (len(words), _t.time() - t0))
    words = refine_word_ends(words, samples, sr)
    segments = words_to_segments(words)
    log("断句完成 %d 行" % len(segments))
    return round(dur, 3), segments, None      # sherpa 拿不到 token 概率，故无 confidence


def run_manifest(args, build_recognizer):
    """按 manifest 批量识别：模型只加载一次。

    每片结果的时间戳**统一加片起点**，所以调度器合并后与单引擎路径的时间轴一致。
    """
    slices, mout = _manifest_load(args.manifest)
    out_path = args.out or mout
    if not out_path:
        raise RuntimeError("manifest 模式需要 --out 或 manifest 里的 out 字段")
    if not slices:
        log("manifest 里没有分片")
        return 0
    log("manifest：%d 个分片，模型只加载一次 …" % len(slices))
    rec = build_recognizer()
    done = {}
    total = len(slices)
    for k, s in enumerate(slices):
        idx = s.get("index", k)
        start = float(s.get("start", 0.0))
        end = float(s.get("end", 0.0))
        samples, sr = read_wav_mono16k(s["wav"])
        t0 = time.time()
        segs = _recognize_one(rec, samples, sr, args)
        dt = time.time() - t0
        dur = len(samples) / float(sr)
        for sg in segs:
            sg["start"] = round(sg["start"] + start, 3)
            sg["end"] = round(sg["end"] + start, 3)
            for w in sg.get("words") or []:
                w["start"] = round(w["start"] + start, 3)
                w["end"] = round(w["end"] + start, 3)
        done[str(idx)] = {"start": start, "end": end, "segments": segs,
                          "sec": round(dt, 3), "audioSec": round(dur, 3)}
        log("[片 %s] %.1fs 音频 用时 %.2fs (%.1fx 实时) %d 行"
            % (idx, dur, dt, dur / max(dt, 1e-6), len(segs)))
        _manifest_save(out_path, done)
        progress(10 + int((k + 1) / total * 85), "asr",
                 "并行识别中 … %d/%d 片" % (k + 1, total))
    log("manifest 跑完：%d 片" % len(done))
    return 0



def _recognize_one(rec, samples, sr, args):
    """sherpa 引擎跑一片：分块 → 识别 → 词尾精修 → 断句。"""
    words = recognize_words(rec, samples, sr, split_chunks(samples, sr),
                            )
    if not words:
        return []
    return words_to_segments(refine_word_ends(words, samples, sr))

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


def load_recognizer(model_dir, threads, hotwords=None, hotwords_score=3.0, provider="cuda"):
    import glob
    import tempfile
    # CUDA 运行库搜索: pip 装的 nvidia-cublas-cu12 / nvidia-cudnn-cu12 / nvidia-cuda-runtime-cu12
    # 把 DLL 放在 site-packages/nvidia/<pkg>/bin, 默认不在 DLL 搜索路径里 —— 不显式注册的话
    # onnxruntime_providers_cuda.dll 会因缺 cublasLt64_12.dll 之类加载失败, CUDA 版白装
    try:
        import sysconfig
        _sp = sysconfig.get_paths().get("purelib", "")
        _nv = os.path.join(_sp, "nvidia") if _sp else ""
        if _nv and os.path.isdir(_nv):
            _dirs = []
            for _d in sorted(os.listdir(_nv)):
                for _sub in ("bin", "lib"):
                    _p = os.path.join(_nv, _d, _sub)
                    if os.path.isdir(_p):
                        _dirs.append(_p)
                        try:
                            os.add_dll_directory(_p)   # 新式搜索(LOAD_LIBRARY_SEARCH_* 模式)
                        except Exception:
                            pass
            if _dirs:
                # onnxruntime 加载 providers_cuda.dll 用的是旧式搜索(LOAD_WITH_ALTERED_SEARCH_PATH),
                # 该模式下 add_dll_directory 不生效, 只有 PATH 管用 —— 两个都要设
                os.environ["PATH"] = os.pathsep.join(_dirs) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass
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
    if provider and provider != "cpu":
        kw["provider"] = provider
    try:
        rec = sherpa_onnx.OfflineRecognizer.from_transducer(**kw)
    except Exception as e:
        # 不做 CPU 兜底: ASR 必须跑在 GPU 上(CUDA 初始化失败=DLL 缺失/驱动过旧/非 CUDA 构建)
        hint = str(e).strip().split("\n")[0][:200]
        raise RuntimeError(
            "CUDA 初始化失败, 拒绝回退 CPU 推理 —— 本工具要求 ASR 跑在 GPU 上。"
            "请到「设置 → 识别模型 → Python 环境」重新一键安装(自动换装 CUDA 版 sherpa-onnx"
            " 与 cuBLAS/cuDNN 运行库); 或确认显卡驱动为最新。原始错误: " + hint) from e
    log("模型加载完成(provider=%s), 耗时 %.1fs" % (kw.get("provider", "cpu"), time.time() - t0))
    return rec


def _decode_chunks(rec, samples, sr, chunks, noise=0.0, seed=12345, quiet=False):
    """逐块推理 -> [(token 列表, 该块完整文本), ...]（每块一项）。

    为什么单独抽出来：稳定性那一项要给音频加噪声**重跑**，两次必须走**完全相同**的
    分块与解码路径，才能逐位置比对 token。所以这里只做"块 → token + 文本"，
    词的重建留给 recognize_words —— 免得两份逻辑漂移。

    frame 用真实秒数（与 chunk 起点对齐后）—— 上游 confidence.py 按序号区间归词，
    不依赖时间，这里留真实时间只是为了排查方便。

    ⚠ **纯空白 token 必须留着**（别在这里 `if not tok.strip(): continue`）：
    sherpa 把词边界符 `▁` 单独吐成**一个只有空格的 token**，它正是"这里该断词"的信号。
    早先这里把它过滤掉了，害得 recognize_words 无从判断词边界，
    "we escape" 被拼成 "weescape"、"to escape" 被拼成 "toescape"
    （2026-10-10 用户实测，两个真实项目里都有）。

    同时把 `r.text` 带出来：它是 sherpa 自己拼的完整文本，词间空格**可信**
    （实测：token 直接拼接 == r.text 去掉空格，逐字相同），是词边界的最终依据。
    """
    out = []
    for ci, (cs, ce) in enumerate(chunks):
        seg = samples[int(cs * sr):int(ce * sr)]
        if len(seg) == 0:
            out.append(([], ""))
            continue
        if noise > 0:
            import numpy as np
            rng = np.random.default_rng(seed + ci)
            seg = seg + rng.normal(0.0, noise, len(seg)).astype(seg.dtype)
        stream = rec.create_stream()
        stream.accept_waveform(sr, seg)
        rec.decode_stream(stream)
        r = stream.result
        toks = []
        for tid, (tok, ts) in enumerate(zip(r.tokens, getattr(r, "timestamps", []))):
            toks.append({"id": tid, "frame": float(ts) + cs, "text": tok})
        out.append((toks, getattr(r, "text", "") or ""))
        if not quiet:
            progress(30 + int((ci + 1) / max(1, len(chunks)) * 55), "asr",
                     "识别中 … 第 %d/%d 块" % (ci + 1, len(chunks)))
    return out


def align_word_starts(tokens, text):
    """用**完整文本**标出 token 流里哪些位置是"真正的词首"。

    解决什么问题：sherpa 的 token 流里，词首靠边界符 `▁`（转成前导空格）标识，
    但模型在退化处会**丢掉那个边界标记** ——
        ' we' + 'es' + 'ca' + 'pe'   →   "weescape"（本该是 "we escape"）
    而这个丢失**只发生在 token 流里**：sherpa 自己拼的 `r.text` 仍然是对的
    （实测该处 text = "How do we escape?"）。所以拿文本当**真值**回头修。

    做法：把 token 逐个在文本里"对表"（跳过空格）；只有**同时**满足下面两条才打
    `wordStart`：
      · 文本游标**跳过了空格** —— 说明这里按文本看确实是个词界
      · 该 token **自己不带前导空格** —— 带的话 `recognize_words` 本来就认得出，
        这里再打一次只会把同一个词切碎

    ⚠ 两条"不能算词首"的例外（都是实测踩出来的）：
      · **标点**：文本里 `"point. How"`，`.` 前面没空格、它自己前面也没空格，
        但它是**独立 token** 且不带前导空格 —— 用上面两条判据会把它标成词首，
        于是 "point" 和 "." 被拆成两个词（观感："point . How"）。标点必须挂在前一个词尾。
      · **词中间的片段**：`' H'` + `'ow'` → 文本 "How"。`H` 带前导空格（对表得到词界标记，
        但被上面第二条挡掉），`ow` 前面没空格（不构成边界）→ 拼回 "How"。
    """
    out = []
    pos = 0
    n = len(text or "")
    for tk in tokens or []:
        t = str(tk.get("text") or "")
        if not t.strip():
            out.append(dict(tk))              # 纯空白 token：原样保留
            continue
        skipped = 0
        while pos < n and text[pos].isspace():
            pos += 1
            skipped += 1
        nt = dict(tk)
        is_punct = not any(ch.isalnum() for ch in t)
        # 只给"真正的词首"打标记：
        #   · 文本游标跳过了空格（文本说这里有词界）
        #   · 该 token 自己**不带**前导空格（带的话 recognize_words 本来就认得出）
        #   · 不是标点（标点要挂在前一个词尾，不能独立成词）
        if skipped and not t.startswith(" ") and not is_punct and out:
            nt["wordStart"] = True
        out.append(nt)
        # ⚠ 游标只前进**内容长度**，不能算 token 自带的前导空格 ——
        #   那个空格对应的正是上面已经跳过的那一格，算进去就重复计数，
        #   游标会不断超前、越对越偏（实测：token ' point'(6 字符) 对上文本 "point."(5 字符)，
        #   每遇一个带前导空格的 token 就多走 1 格，于是真正需要修的位置全被错过）。
        pos += len(t.strip())
    return out


def recognize_words(rec, samples, sr, chunks):
    """逐块推理 -> 词列表 [{word, start, anchor}]。

    token 聚成词靠**两种**词边界信号 —— 模型两种都会用，漏认任何一种都会把两个词粘起来：
      ① 边界符挂在词首：' escape'（前导空格）
      ② 边界符**单独成一个 token**：' '（只有空格）
    另外用 align_word_starts 拿完整文本兜底，把模型在 token 流里**整个丢掉**的边界补回来。

    token 聚成词靠 BPE 词边界：sherpa 把**词首**的边界符转成前导空格（实测
    ' F' / ' pr' / ' need'），另外还可能吐一个**孤立的边界 token**（单独成 token，
    转成 ' '）—— 见下面 `boundary` 那段，那是本函数最容易出错的地方。
    模型给的是 token 起始时间；标点 token 的时间戳常落在停顿里，所以额外记录最后一个
    「含字母数字的 token」的时间作为 anchor，后续用它推算真实结束时间。
    """
    per_chunk = _decode_chunks(rec, samples, sr, chunks)

    words = []
    for toks, text in per_chunk:
        # 用完整文本把模型**在 token 流里丢掉的**词边界补回来（文本是可信真值）
        toks = align_word_starts(toks, text)
        cur = None
        for tk in toks:
            tok = tk["text"]
            piece = tok.strip()
            # 纯空白 token = 孤立的边界符：结掉当前词
            if not piece:
                if cur is not None:
                    words.append(cur)
                    cur = None
                continue
            t_abs = tk["frame"]
            # 词首判定：token 自带前导空格（模型自己标了边界），
            # 或文本对齐补出来的 wordStart（模型把边界整个丢了时靠它兜底）。
            #
            # ⚠ 这里**不要**再加"前一个 token 没带边界符"之类的附加条件。
            #   align_word_starts 只给"文本说该断、且 token 自己没标边界"的位置打标记，
            #   已经把误断挡在源头了；在消费端再挡一次会把真正该断的位置也挡掉
            #   （实测：' we'(带空格) 后面的 'es' 被打上 wordStart，却因为
            #     "前一个带空格"被跳过 → 又拼回 "weescape"）。
            if cur is not None and (tok.startswith(" ") or tk.get("wordStart")):
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

    words.sort(key=lambda w: w["start"])
    for i in range(1, len(words)):            # 时间戳偶发抖动, 不允许倒退
        if words[i]["start"] < words[i - 1]["start"]:
            words[i]["start"] = words[i - 1]["start"]
    # 切开"粘连词"：边界符**完全缺失**时（模型退化处连孤立的边界 token 都没有），
    # 片段仍会被 `cur["word"] += piece` 拼成一个词（观感："一个词占 11 秒、文本由两半粘成"）。
    # 上面处理的是"有边界却认不出"，这里是"压根没有边界"，两者互补、都要留着。
    # 放在排序/防倒退之后、refine_word_ends 之前 —— 切开时要依赖已修正的 start。
    C.split_words_inplace(words)
    return words


def stability_of(rec, samples, sr, chunks, clean_per_chunk, tta_runs, log_fn=None):
    """加噪重跑 -> 稳定性。逐块比对 token（块相同，位置可比）。

    与 NPU 引擎同一套思路：如果加一点噪声转写就变了，说明模型在这段音频上本来就不稳。
    比对按块进行 —— 不同块的 token 没有对应关系。
    """
    if tta_runs <= 0:
        return {"stability": 1.0, "runs": 1, "affectedWords": 0, "wordCount": 0}
    runs = []
    for k in range(tta_runs):
        if log_fn:
            log_fn("稳定性重跑 %d/%d …" % (k + 1, tta_runs))
        runs.append(_decode_chunks(rec, samples, sr, chunks,
                                   noise=0.02 + 0.01 * k, seed=1000 + 977 * k, quiet=True))
    # 把所有块的 token 首尾相接，变成整段序列 —— 上游 stability_from_runs 只吃一维序列，
    # 而块之间本来就连续（split_chunks 切的是同一段音频），接起来不影响"位置可比"。
    # ⚠ _decode_chunks 现在返回 (tokens, text) 元组，这里只取 tokens。
    clean_ids = [tk["id"] for toks, _t in clean_per_chunk for tk in toks]
    noisy_ids = [[tk["id"] for toks, _t in one for tk in toks] for one in runs]
    return C.stability_score_runs(clean_ids, noisy_ids)


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


def words_to_segments(words, samples=None, sr=SAMPLE_RATE, stability=None):
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
        seg = {
            "id": i,
            "start": ws[0]["start"],
            "end": ws[-1]["end"],
            "text": " ".join(w["word"] for w in ws).strip(),
            "words": [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in ws],
        }
        if samples is not None:
            # 句级置信度：本句音频质量打底，整体稳定性往下压。
            # 本引擎**没有** token 概率项（sherpa 不给），所以 parts 里不放 token，
            # 界面显示"—"而不是伪造一个分数。
            a = max(0, int(seg["start"] * sr))
            b = min(len(samples), int(seg["end"] * sr))
            q = C.audio_quality(samples[a:b]) if b > a else {"score": 0.2}
            score = q["score"] * (0.7 + 0.3 * float(stability.get("stability", 1.0)))
            seg["confidence"] = {
                "score": round(float(score), 3),
                "low": bool(score < C.LOW_CONFIDENCE),
                "worstWord": None,
                "parts": {"audio": round(float(q["score"]), 3),
                          "stability": round(float(stability.get("stability", 1.0)), 3)},
            }
        out.append(seg)
    for i in range(1, len(out)):              # 相邻行不交叠
        if out[i]["start"] < out[i - 1]["end"]:
            out[i]["start"] = out[i - 1]["end"]
    return out


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Parakeet TDT 0.6B v2 ASR worker")
    ap.add_argument("--model", required=True, help="模型目录(含 encoder/decoder/joiner .onnx + tokens.txt)")
    ap.add_argument("--audio", default="", help="16kHz 单声道 PCM wav（manifest 模式下可省）")
    ap.add_argument("--out", default="", help="结果 JSON 输出路径")
    ap.add_argument("--serve", action="store_true",
                    help="常驻服务模式：模型只加载一次，之后从 stdin 反复收任务"
                         "（给 SubFabric 复用，避免每次识别都付进程启动+运行时导入的开销）")
    ap.add_argument("--manifest", default="",
                    help="批量模式: 读这个 JSON（含多个分片），**模型只加载一次**。"
                         "供双引擎并行调度使用（asr/asr_dual.py）")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--provider", default="cuda", choices=["cuda"],
                    help="推理设备: 仅支持 cuda(N 卡 GPU; 需装 CUDA 版 sherpa-onnx, 不做 CPU 兜底)")
    ap.add_argument("--hotwords-file", default="",
                    help="热词文件: 每行一个词/短语(原始文本, 本脚本负责转 BPE 片段)")
    ap.add_argument("--hotwords-score", type=float, default=3.0,
                    help="热词强度(实测: 1.5 无效 / 3.0 生效且正确 / >=6 开始复读崩坏)")
    ap.add_argument("--tta", type=int, default=2,
                    help="稳定性重跑的遍数(默认 2): 给音频加微小噪声重跑, 看有多少 token 变了 "
                         "—— 置信度的一个信号。设 0 关掉(更快, 但没有稳定性项)")
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
        if args.serve:
            return serve_loop(args,
                              lambda: load_recognizer(
                                  args.model, args.threads, hotwords, args.hotwords_score,
                                  provider=getattr(args, "provider", "cuda")),
                              _serve_recognize, log)
        if args.manifest:
            return run_manifest(args, lambda: load_recognizer(
                args.model, args.threads, hotwords, args.hotwords_score,
                provider=getattr(args, "provider", "cuda")))
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

        rec = load_recognizer(args.model, args.threads, hotwords, args.hotwords_score,
                              provider=getattr(args, "provider", "cuda"))
        t0 = time.time()
        words = recognize_words(rec, samples, sr, chunks,
                                )
        if not words:
            raise RuntimeError("未识别到语音内容(模型输出为空)")
        log("识别完成 %d 词, 耗时 %.1fs" % (len(words), time.time() - t0))

        # 置信度的稳定性项：加噪重跑。为省一次完整解码，这里重跑时只取 token 序列
        # （_decode_chunks），词的重建只做一次。
        stability = {"stability": 1.0, "runs": 1}
        if args.tta > 0:
            clean_per_chunk = _decode_chunks(rec, samples, sr, chunks, quiet=True)
            stability = stability_of(rec, samples, sr, chunks, clean_per_chunk,
                                     args.tta, log_fn=log)
            log("稳定性 %.2f" % stability.get("stability", 1.0))

        progress(88, "asr", "整理词级时间轴 …")
        words = refine_word_ends(words, samples, sr)
        segments = words_to_segments(words, samples, sr, stability)
        low = sum(1 for s in segments if (s.get("confidence") or {}).get("low"))
        log("断句完成 %d 行（其中 %d 行置信度偏低，建议复核）" % (len(segments), low))

        # 整段汇总：只有音频质量与稳定性两个信号（本引擎没有 token 概率）
        audio_all = C.audio_quality(samples)
        overall = C.fuse_available(None, audio_all["score"], stability.get("stability", 1.0))
        overall["audio"] = C.audio_summary(audio_all)
        overall["note"] = "本引擎(sherpa-onnx)拿不到 token 概率，置信度由音频质量与稳定性合成"

        tmp = args.out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"duration": round(dur, 3), "language": "en", "segments": segments,
                       "confidence": overall},
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
