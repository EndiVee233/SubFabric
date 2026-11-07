"""WhisperX 3.8.6 CUDA adapter. Heavy imports stay inside the worker entry point."""
import argparse
import contextlib
import gc
import importlib.metadata
import json
import math
import os
from pathlib import Path
import socket
import sys
import threading


VERSION = "3.8.6"
_DLL_HANDLES = []


def emit(kind, msg, **extra):
    print(json.dumps({"type": kind, "msg": msg, **extra}, ensure_ascii=False), file=sys.stderr, flush=True)


def configure_cache(directory):
    root = Path(directory).resolve()
    paths = {"HF_HOME": root / "huggingface", "HF_HUB_CACHE": root / "huggingface" / "hub",
             "TORCH_HOME": root / "torch", "NLTK_DATA": root / "nltk",
             "XDG_CACHE_HOME": root, "HF_DATASETS_CACHE": root / "datasets",
             "HF_MODULES_CACHE": root / "modules", "MPLCONFIGDIR": root / "matplotlib",
             "NUMBA_CACHE_DIR": root / "numba", "CUDA_CACHE_PATH": root / "cuda"}
    for key, value in paths.items():
        value.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(value)
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    return root


def load_runtime():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("WhisperX 需要可用的 NVIDIA CUDA GPU；请检查驱动和独立运行时")
    # CTranslate2 on Windows also needs the CUDA/cuDNN DLLs shipped with this torch wheel.
    if os.name == "nt":
        lib = Path(torch.__file__).parent / "lib"
        os.environ["PATH"] = str(lib) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            _DLL_HANDLES.append(os.add_dll_directory(str(lib)))
    import whisperx
    from whisperx.asr import load_model
    from whisperx.alignment import load_align_model, align
    from whisperx.vads.pyannote import Pyannote
    import ctranslate2
    import soundfile
    import numpy
    if importlib.metadata.version("whisperx") != VERSION:
        raise RuntimeError("WhisperX 版本不匹配，请重新安装独立运行时")
    if not ctranslate2.get_supported_compute_types("cuda"):
        raise RuntimeError("CTranslate2 未检测到可用 CUDA 设备")
    asset = Path(whisperx.__file__).parent / "assets" / "pytorch_model.bin"
    if not asset.is_file():
        raise RuntimeError("WhisperX 缺少随包 VAD 权重，请重新安装运行时")
    # Keep references alive and prove the real inference imports work during installation.
    return torch, whisperx, load_model, load_align_model, align, Pyannote, soundfile, numpy


def finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def validate_nltk():
    import nltk
    try:
        nltk.sent_tokenize("WhisperX runtime validation.", language="english")
    except LookupError as error:
        raise RuntimeError("WhisperX 缺少本地 punkt_tab 断句资源，请重新安装独立运行时") from error


def normalized_segments(result, duration):
    """Never discard transcript tokens or invent measured timing for unaligned words."""
    output = []
    for raw in result.get("segments", []):
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        start, end = finite(raw.get("start")), finite(raw.get("end"))
        if start is None or end is None:
            raise ValueError("WhisperX 返回了缺少句时间的字幕段")
        start, end = max(0.0, start), min(duration, end)
        if end <= start:
            raise ValueError("WhisperX 返回了无效的句时间范围")
        words, complete, previous = [], True, start
        for word in raw.get("words", []):
            token = str(word.get("word") or "").strip()
            if not token:
                continue
            ws, we = finite(word.get("start")), finite(word.get("end"))
            if ws is None or we is None or ws < start - 0.02 or we > end + 0.02 or we <= ws or ws < previous - 0.001:
                complete = False
                continue
            ws, we = max(start, ws), min(end, we)
            if we <= ws:
                complete = False
                continue
            item = {"word": token, "start": ws, "end": we}
            score = finite(word.get("score"))
            if score is not None:
                item["score"] = max(0, min(1, score))
            words.append(item)
            previous = we
        compact_text = "".join(text.split())
        compact_words = "".join("".join(w["word"].split()) for w in words)
        complete = complete and bool(words) and compact_text == compact_words
        # Downstream reseg may rebuild text from words. A partial word array would lose the remaining text.
        if not complete:
            words = []
        segment = {"id": len(output), "start": start, "end": end, "text": text,
                   "words": words, "alignmentIncomplete": not complete}
        # WhisperX carries the ASR decoder's average log probability through align().
        # Word `score` comes from wav2vec2 alignment, so it must not stand in for ASR confidence.
        logprob = finite(raw.get("avg_logprob"))
        if logprob is not None and logprob <= 0:
            probability = math.exp(logprob)
            score = round(probability, 3)
            segment["avg_logprob"] = logprob
            segment["confidence"] = {
                "score": score, "low": probability < 0.60, "worstWord": None,
                "parts": {"token": score}, "missing": ["audio", "stability"],
                "source": "whisperx.avg_logprob",
            }
        output.append(segment)
    return output


def transcribe(args, runtime):
    torch, _, load_model, load_align_model, align, _, sf, np = runtime
    torch.set_num_threads(4)
    data, rate = sf.read(args.audio, dtype="float32", always_2d=True)
    if rate != 16000:
        raise ValueError("WhisperX 输入必须是项目准备阶段生成的 16kHz WAV")
    audio = np.ascontiguousarray(data.mean(axis=1))
    duration = len(audio) / rate
    if not len(audio):
        return {"segments": [], "language": args.language, "engine": "whisperx"}
    emit("progress", "加载 WhisperX large-v2 与 VAD…", pct=5)
    language = None if args.language == "auto" else args.language
    model = load_model(args.model, "cuda", compute_type=args.compute_type, language=language,
                       local_files_only=True, vad_method="pyannote",
                       asr_options={"beam_size": args.beam_size, "initial_prompt": None},
                       vad_options={"vad_onset": args.vad_onset, "vad_offset": args.vad_offset,
                                    "chunk_size": args.chunk_size})
    emit("progress", "WhisperX 批量识别中…", pct=20)
    result = model.transcribe(audio, batch_size=args.batch_size, chunk_size=args.chunk_size,
                              progress_callback=lambda p: emit("progress", "WhisperX 批量识别中…", pct=20 + min(100, max(0, p)) * 0.4))
    language = result.get("language") or language
    del model
    gc.collect()
    torch.cuda.empty_cache()
    if not result.get("segments"):
        return {"segments": [], "language": language, "engine": "whisperx"}
    if not language:
        raise ValueError("WhisperX 未返回识别语言，无法选择对齐模型")
    local_align = Path(args.model) / "align" / "en"
    kwargs = {"model_dir": str(Path(args.cache_dir) / "align")}
    if language == "en":
        if not (local_align / "model.safetensors").is_file():
            raise FileNotFoundError("缺少 WhisperX 英语对齐权重，请重新下载 WhisperX 模型")
        kwargs.update(model_name=str(local_align), model_cache_only=True)
    emit("progress", "WhisperX 正在加载对应语言的逐词对齐模型…", pct=60)
    align_model, metadata = load_align_model(language_code=language, device="cuda", **kwargs)
    emit("progress", "WhisperX wav2vec2 逐词对齐中…", pct=72)
    result = align(result["segments"], align_model, metadata, audio, "cuda", return_char_alignments=False,
                   progress_callback=lambda p: emit("progress", "WhisperX wav2vec2 逐词对齐中…", pct=72 + min(100, max(0, p)) * 0.25))
    segments = normalized_segments(result, duration)
    incomplete = sum(1 for segment in segments if segment["alignmentIncomplete"])
    if incomplete:
        emit("log", f"WhisperX 有 {incomplete} 句未能完整对齐，保留整句文本与句时间，不伪造逐词时间")
    emit("progress", "WhisperX 识别与逐词对齐完成", pct=100)
    return {"segments": segments, "language": language, "engine": "whisperx"}


def parser():
    cli = argparse.ArgumentParser()
    cli.add_argument("--model")
    cli.add_argument("--audio")
    cli.add_argument("--out")
    cli.add_argument("--provider", choices=["cuda"], default="cuda")
    cli.add_argument("--language", default="en")
    cli.add_argument("--batch-size", type=int, default=4)
    cli.add_argument("--compute-type", choices=["float16", "int8_float16"], default="float16")
    cli.add_argument("--beam-size", type=int, default=5)
    cli.add_argument("--chunk-size", type=int, default=30)
    cli.add_argument("--vad-onset", type=float, default=0.5)
    cli.add_argument("--vad-offset", type=float, default=0.36)
    cli.add_argument("--cache-dir", default=str(Path(__file__).parent / "runtime-whisperx" / "cache"))
    cli.add_argument("--probe", action="store_true")
    cli.add_argument("--prepare-runtime", action="store_true")
    return cli


def main():
    args = parser().parse_args()
    # Embedded Python's _pth omits the script folder.
    sys.path.insert(0, str(Path(__file__).parent))
    from common import watch_parent
    os.environ["SUBFABRIC_PARENT_WATCH"] = "1"
    watch_parent()
    def abort_timeout():
        emit("error", "WhisperX 运行超过两小时，已停止")
        os._exit(1)
    deadline = threading.Timer(7200, abort_timeout)
    deadline.daemon = True
    deadline.start()
    configure_cache(args.cache_dir)
    socket.setdefaulttimeout(60)
    with contextlib.redirect_stdout(sys.stderr):
        try:
            runtime = load_runtime()
        except Exception:
            # Installation markers are a cache, not evidence that broken dependencies still work.
            mark_path = Path(args.cache_dir).parent / "ready.json"
            try:
                mark = json.loads(mark_path.read_text(encoding="utf-8"))
                if isinstance(mark, dict) and mark.get("version") == VERSION and Path(mark.get("python", "")).resolve() == Path(sys.executable).resolve():
                    mark_path.unlink()
            except (OSError, ValueError, TypeError):
                pass
            raise
        if args.prepare_runtime:
            validate_nltk()
        if args.probe or args.prepare_runtime:
            result = {"version": VERSION, "cuda": True}
        else:
            if not all((args.model, args.audio, args.out)):
                raise ValueError("缺少 --model / --audio / --out")
            if not 1 <= args.batch_size <= 32 or not 1 <= args.beam_size <= 10 or not 5 <= args.chunk_size <= 30:
                raise ValueError("WhisperX 参数超出有效范围")
            result = transcribe(args, runtime)
            destination = Path(args.out)
            temp = destination.with_name(destination.name + ".tmp")
            temp.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            os.replace(temp, destination)
    if args.probe or args.prepare_runtime:
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as error:
        hint = "；显存不足时请减小批量大小或使用 int8_float16" if "out of memory" in str(error).lower() else ""
        emit("error", f"WhisperX 失败：{error}{hint}")
        sys.exit(1)
