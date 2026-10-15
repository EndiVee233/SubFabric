# -*- coding: utf-8 -*-
"""VibeVoice ASR worker.

This worker deliberately exposes one execution device: CUDA.  The model is a
pre-quantized 4-bit Transformers checkpoint; loading or generation is rejected
when CUDA, bitsandbytes, or a CUDA-only device map is unavailable.  There is no
alternate device path in this module.

The worker follows the Transformers VibeVoice ASR contract: the processor builds
an audio transcription request and the model returns structured ``Start`` /
``End`` / ``Speaker`` / ``Content`` records after decoding.  The Node server
consumes newline JSON progress records from stderr and reads the final
transcription from ``--out``.  The output shape matches the other ASR workers
used by SubFabric.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import re
import sys
import time
from types import MethodType
import wave
from pathlib import Path
from typing import Any


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(payload: dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def log(message: str) -> None:
    emit({"type": "log", "msg": str(message)})


def progress(pct: float, message: str) -> None:
    emit({"type": "progress", "pct": max(0, min(100, int(round(pct)))), "stage": "asr", "msg": str(message)})


def probe_runtime() -> dict[str, Any]:
    """Probe the exact CUDA/NF4 runtime needed by the worker.

    Import checks alone are insufficient: bitsandbytes can be importable while
    its CUDA 4bit kernel is unavailable.  The tiny quantize/dequantize roundtrip
    below exercises the same NF4 CUDA path used by the checkpoint loader.
    """
    info: dict[str, Any] = {
        "ok": False,
        "cuda": False,
        "gpu": "",
        "vramMB": 0,
        "transformers": False,
        "nativeModel": False,
        "nativeProcessor": False,
        "bitsandbytes": False,
        "bnbCudaKernel": False,
    }
    try:
        import torch
        info["cuda"] = bool(torch.cuda.is_available())
        if info["cuda"]:
            info["gpu"] = torch.cuda.get_device_name(0)
            info["vramMB"] = int(torch.cuda.get_device_properties(0).total_memory / 1048576)
    except Exception as exc:
        info["msg"] = "CUDA PyTorch 不可用: %s" % exc
        return info
    try:
        import transformers
        info["transformers"] = True
        info["nativeModel"] = bool(getattr(transformers, "VibeVoiceAsrForConditionalGeneration", None)
                                    or getattr(transformers, "VibeVoiceASRForConditionalGeneration", None))
        info["nativeProcessor"] = bool(getattr(transformers, "VibeVoiceAsrProcessor", None))
    except Exception as exc:
        info["msg"] = "Transformers 原生 VibeVoice 类不可用: %s" % exc
    try:
        import bitsandbytes as bnb
        info["bitsandbytes"] = True
        if not info["cuda"]:
            info["msg"] = "没有可用 CUDA，拒绝 CPU/NPU 4bit"
        else:
            source = torch.linspace(-1, 1, 4096, device="cuda", dtype=torch.float16).reshape(64, 64)
            packed, state = bnb.functional.quantize_4bit(source, quant_type="nf4", compress_statistics=True)
            restored = bnb.functional.dequantize_4bit(packed, state, quant_type="nf4")
            torch.cuda.synchronize()
            info["bnbCudaKernel"] = bool(restored.is_cuda and restored.shape == source.shape
                                         and torch.isfinite(restored).all().item()
                                         and (restored - source).abs().max().item() < 0.2)
    except Exception as exc:
        info["msg"] = "bitsandbytes CUDA NF4 kernel 不可用: %s" % exc
    info["ok"] = bool(info["cuda"] and info["vramMB"] >= 7600 and info["transformers"]
                      and info["nativeModel"] and info["nativeProcessor"]
                      and info["bitsandbytes"] and info["bnbCudaKernel"])
    if not info["ok"] and "msg" not in info:
        info["msg"] = "缺少 CUDA、原生 VibeVoice 类或 bitsandbytes NF4 CUDA kernel"
    return info


def read_duration(audio: str) -> float:
    with wave.open(audio, "rb") as fh:
        return float(fh.getnframes()) / float(fh.getframerate() or 1)


def parse_time(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if not isinstance(value, bool) and math.isfinite(value) else None
    text = str(value).strip()
    if not text:
        return None
    try:
        result = float(text)
        return result if math.isfinite(result) else None
    except ValueError:
        pass
    parts = text.replace(",", ".").split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
    except ValueError:
        return None
    return None


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(clean_text(v) for v in value).strip()
    return re.sub(r"\s+", " ", str(value)).strip()


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def normalize_words(raw: Any, offset: float, limit: float) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in as_list(raw):
        if not isinstance(item, dict):
            continue
        text = clean_text(item.get("word", item.get("text", item.get("token"))))
        start = parse_time(item.get("start", item.get("start_time", item.get("begin"))))
        end = parse_time(item.get("end", item.get("end_time", item.get("finish"))))
        if not text or start is None or end is None:
            continue
        start = max(0.0, min(limit, start + offset))
        end = max(start, min(limit, end + offset))
        result.append({"word": text, "start": round(start, 3), "end": round(end, 3)})
    return result


def normalize_segments(raw: Any, duration: float) -> list[dict[str, Any]]:
    """Convert the structured VibeVoice result to SubFabric segments.

    VibeVoice is trained to return timestamped JSON records.  A raw string is
    deliberately rejected here: inventing a 0..duration segment would make a
    malformed model response look like a valid transcript and would destroy
    the time axis in the editor.
    """
    if isinstance(raw, dict):
        for key in ("segments", "transcription", "results", "items"):
            if key in raw:
                raw = raw[key]
                break
    if isinstance(raw, str):
        return []

    output: list[dict[str, Any]] = []
    speakers: dict[str, int] = {}
    for index, item in enumerate(as_list(raw)):
        if isinstance(item, str):
            continue
        if not isinstance(item, dict):
            continue
        start = parse_time(item.get("start", item.get("Start", item.get("start_time", item.get("begin")))))
        end = parse_time(item.get("end", item.get("End", item.get("end_time", item.get("finish")))))
        text = clean_text(item.get("text", item.get("Content", item.get("transcript", item.get("content")))))
        words = normalize_words(item.get("words", item.get("word_timestamps")), 0.0, duration)
        if start is None and words:
            start = words[0]["start"]
        if end is None and words:
            end = words[-1]["end"]
        # Timestamped records are required.  Do not manufacture timing from
        # neighboring rows; overlapping speakers are valid VibeVoice output.
        if start is None or end is None or not math.isfinite(start) or not math.isfinite(end) or end <= start:
            raise RuntimeError("VibeVoice 返回了无效时间戳，拒绝生成不完整稿件")
        if start < -0.1 or start >= duration or end > duration + 1:
            raise RuntimeError("VibeVoice 时间戳超出音频范围")
        start = max(0.0, min(duration, start))
        end = max(start, min(duration, end))
        if not text and words:
            text = " ".join(word["word"] for word in words).strip()
        if not text:
            continue
        row: dict[str, Any] = {
            "id": index,
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "words": words,
        }
        speaker = item.get("speaker", item.get("Speaker", item.get("speaker_id")))
        if speaker not in (None, ""):
            label = str(speaker)
            row["speaker"] = speakers.setdefault(label, len(speakers))
        output.append(row)

    output.sort(key=lambda row: (row["start"], row["end"]))
    for index, row in enumerate(output):
        row["id"] = index
        row["start"] = round(row["start"], 3)
        row["end"] = round(max(row["start"], row["end"]), 3)
    return output


def load_processor_and_model(model_dir: str):
    """Load the pre-quantized checkpoint with an explicit CUDA-only map.

    The checkpoint is already NF4-quantized.  Passing a generic Seq2Seq class
    here is unsafe because it can silently select a model architecture that
    does not understand VibeVoice's audio inputs, so loading fails explicitly
    when the native class is unavailable.
    """
    try:
        import torch
        import transformers
    except Exception as exc:  # pragma: no cover - exercised by runtime probe
        raise RuntimeError("VibeVoice 运行时缺少 PyTorch/Transformers: %s" % exc) from exc

    if not torch.cuda.is_available():
        raise RuntimeError("VibeVoice 只允许 CUDA 推理，当前没有可用 NVIDIA CUDA 设备")
    device = torch.device("cuda:0")
    props = torch.cuda.get_device_properties(device)
    total_mb = int(props.total_memory / 1048576)
    if total_mb < 7600:
        raise RuntimeError("VibeVoice 4bit 需要至少约 7.6GB 显存，当前仅 %.1fGB" % (total_mb / 1024))
    free_bytes, _ = torch.cuda.mem_get_info(device)
    if free_bytes < 900 * 1048576:
        raise RuntimeError("CUDA 显存不足：加载 VibeVoice 4bit 前至少需要约 900MB 可用显存")

    try:
        import bitsandbytes  # noqa: F401
    except Exception as exc:
        raise RuntimeError("VibeVoice 4bit 需要支持 CUDA 的 bitsandbytes: %s" % exc) from exc

    config_path = Path(model_dir) / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError("无法读取 VibeVoice 模型配置: %s" % exc) from exc
    quant = config.get("quantization_config") or {}
    if not quant:
        raise RuntimeError("模型配置没有 quantization_config，已拒绝非 4bit 加载")
    if quant.get("load_in_4bit") is not True:
        raise RuntimeError("模型配置没有明确启用 4bit 量化，已拒绝加载")
    if str(quant.get("quant_method", "")).lower() != "bitsandbytes":
        raise RuntimeError("模型配置不是 bitsandbytes 量化，已拒绝加载")
    if str(quant.get("bnb_4bit_quant_type", "")).lower() != "nf4":
        raise RuntimeError("模型配置不是 NF4 量化，已拒绝加载")
    metadata_path = Path(model_dir) / "quantization_metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError("缺少 VibeVoice NF4 量化元数据，已拒绝加载: %s" % exc) from exc
    if metadata.get("bits") != 4 or str(metadata.get("quant_type", "")).lower() != "nf4":
        raise RuntimeError("模型不是受支持的 NF4 4bit checkpoint，已拒绝加载")
    if str(metadata.get("quantization_method", metadata.get("quant_method", ""))).lower() not in {"bitsandbytes", "bnb"}:
        raise RuntimeError("VibeVoice 量化方式不是 CUDA bitsandbytes，已拒绝加载")
    if quant.get("load_in_8bit") or quant.get("llm_int8_enable_fp32_cpu_offload"):
        raise RuntimeError("VibeVoice 配置启用了非 4bit 模式或 CPU offload")

    progress(8, "加载 VibeVoice 4bit 处理器…")
    processor = transformers.AutoProcessor.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    progress(18, "加载 VibeVoice 4bit CUDA 模型…")
    model_cls = getattr(transformers, "VibeVoiceAsrForConditionalGeneration", None)
    if model_cls is None:
        model_cls = getattr(transformers, "VibeVoiceASRForConditionalGeneration", None)
    if model_cls is None:
        raise RuntimeError("当前 Transformers 没有 VibeVoice 原生模型类，请在设置中升级 VibeVoice CUDA 运行时")
    kwargs = {
        "device_map": {"": "cuda:0"},
        "low_cpu_mem_usage": True,
        "trust_remote_code": False,
        "local_files_only": True,
        "dtype": torch.bfloat16,
    }
    # Transformers 5.17 将两个音频编码器移到 model.*；checkpoint 的排除
    # 名称来自旧结构。只补齐前缀，不重新量化或改写下载的权重。
    model_config = transformers.AutoConfig.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    runtime_quant = dict(quant)
    skipped = list(runtime_quant.get("llm_int8_skip_modules") or [])
    for name in ("model.acoustic_tokenizer_encoder", "model.semantic_tokenizer_encoder"):
        if name not in skipped:
            skipped.append(name)
    runtime_quant["llm_int8_skip_modules"] = skipped
    model_config.quantization_config = runtime_quant
    kwargs["config"] = model_config
    model = model_cls.from_pretrained(model_dir, **kwargs)

    device_map = getattr(model, "hf_device_map", {}) or {}
    bad_devices = [str(value) for value in device_map.values()
                   if value != 0 and str(value).lower() not in {"cuda", "cuda:0"}]
    if bad_devices:
        raise RuntimeError("VibeVoice 4bit 被映射到非 CUDA 设备，已拒绝 CPU/offload 推理")
    for parameter in model.parameters():
        if parameter.device.type != "cuda":
            raise RuntimeError("VibeVoice 参数未全部位于 CUDA，已拒绝非 CUDA 推理")
    for buffer in model.buffers():
        if buffer.device.type != "cuda":
            raise RuntimeError("VibeVoice 缓冲区未全部位于 CUDA，拒绝 offload")
    if not getattr(model, "is_loaded_in_4bit", False):
        raise RuntimeError("VibeVoice 实际加载结果不是 4bit")
    quantized_layers = 0
    for module in model.modules():
        if getattr(getattr(module, "_hf_hook", None), "offload", False):
            raise RuntimeError("VibeVoice 检测到 offload hook，已拒绝推理")
        if isinstance(module, bitsandbytes.nn.Linear4bit):
            state = getattr(module.weight, "quant_state", None)
            if state is None or state.quant_type != "nf4":
                raise RuntimeError("VibeVoice 量化层缺少 NF4 状态，请修复运行时兼容性")
            quantized_layers += 1
    if not quantized_layers:
        raise RuntimeError("VibeVoice 没有实际 NF4 量化层")
    progress(24, "CUDA NF4 校验通过：%d 个量化层，无 CPU/offload" % quantized_layers)
    model.eval()
    gc.collect()
    torch.cuda.empty_cache()
    emit({"type": "log", "msg": "模型显存：分配 %.0fMiB / 保留 %.0fMiB" % (
        torch.cuda.memory_allocated(device) / 1048576, torch.cuda.memory_reserved(device) / 1048576)})
    return torch, processor, model, device


def make_inputs(processor: Any, audio: str, torch: Any, device: Any):
    # 服务端提供 PCM WAV；直接读入数组，避免路径加载器间接启用 librosa/numba
    # 并向只读依赖目录写 JIT 缓存。这里只做音频解码/重采样，模型仍全部在 CUDA。
    import soundfile as sf
    import soxr
    waveform, sample_rate = sf.read(audio, dtype="float32", always_2d=True)
    waveform = waveform.mean(axis=1)
    target_rate = int(processor.feature_extractor.sampling_rate)
    if sample_rate != target_rate:
        waveform = soxr.resample(waveform, sample_rate, target_rate, quality="HQ")
    inputs = processor.apply_transcription_request(audio=waveform, return_tensors="pt")
    if hasattr(inputs, "to"):
        try:
            return inputs.to(device, torch.bfloat16)
        except TypeError:
            return inputs.to(device)
    if isinstance(inputs, dict):
        moved = {}
        for key, value in inputs.items():
            if hasattr(value, "to"):
                if getattr(value, "is_floating_point", lambda: False)():
                    value = value.to(device=device, dtype=torch.bfloat16)
                else:
                    value = value.to(device=device)
            moved[key] = value
        return moved
    return inputs


def decode_transcription(processor: Any, generated: Any) -> Any:
    if not hasattr(processor, "decode"):
        raise RuntimeError("VibeVoice 处理器不支持结构化 decode")
    try:
        # tokenizer.decode accepts one token sequence, not a 2-D batch.
        if generated.ndim != 2 or generated.shape[0] != 1:
            raise RuntimeError("VibeVoice 只接受单条音频输出")
        parsed = processor.decode(generated[0], return_format="parsed")
    except Exception as exc:
        raise RuntimeError("VibeVoice 输出不是有效的结构化时间轴: %s" % exc) from exc
    # The worker is single-audio today.  Keep the batch contract explicit so a
    # future caller cannot accidentally merge two files into one transcript.
    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], list):
        return parsed[0]
    if isinstance(parsed, list) and all(isinstance(item, dict) for item in parsed):
        return parsed
    raise RuntimeError("VibeVoice 没有返回单条音频的结构化时间轴")


def encode_audio_inputs(model: Any, inputs: Any, torch: Any, chunk_size: int):
    # 每个 worker 只识别一段音频。原生 forward 会在首轮计算音频特征，随后
    # 音频模块不再使用；提前执行同一计算并释放这些 CUDA 权重，给 8GB 显卡
    # 留出解码空间。没有将模块移到 CPU，也没有从磁盘按层换入。
    core = model.model
    with torch.inference_mode():
        features = core.get_audio_features(
            input_values=inputs["input_values"], padding_mask=inputs.get("padding_mask"),
            acoustic_tokenizer_chunk_size=chunk_size,
        ).pooler_output
        embeddings = core.get_input_embeddings()(inputs["input_ids"])
        mask = (inputs["input_ids"] == model.config.audio_token_id).unsqueeze(-1)
        embeddings = embeddings.masked_scatter(mask, features.to(embeddings.dtype))
    inputs.pop("input_values", None)
    inputs.pop("padding_mask", None)
    inputs["inputs_embeds"] = embeddings
    from transformers.generation import GenerationMixin
    def prepare(self, input_ids, inputs_embeds=None, **kwargs):
        # 5.17 的原生适配器未向父方法转交 is_first_iteration，会忽略预计算
        # 嵌入。音频已编码，此处直接用通用文本准备方法，保留首轮标志及缓存。
        return GenerationMixin.prepare_inputs_for_generation(self, input_ids, inputs_embeds=inputs_embeds, **kwargs)
    model.prepare_inputs_for_generation = MethodType(prepare, model)
    del features, mask
    core.acoustic_tokenizer_encoder = None
    core.semantic_tokenizer_encoder = None
    core.multi_modal_projector = None
    gc.collect()
    torch.cuda.empty_cache()
    emit({"type": "log", "msg": "音频编码完成，释放已用 CUDA 音频模块；解码显存 %.0fMiB" % (
        torch.cuda.memory_allocated() / 1048576)})
    return inputs


def run(args: argparse.Namespace) -> int:
    if args.provider != "cuda":
        raise RuntimeError("VibeVoice 只接受 --provider cuda，已禁用其它推理设备")
    duration = read_duration(args.audio)
    if duration < 0.2:
        raise RuntimeError("音频过短或无有效采样")
    torch, processor, model, device = load_processor_and_model(args.model)
    progress(28, "准备 CUDA 音频输入…")
    inputs = make_inputs(processor, args.audio, torch, device)
    generate_kwargs = {
        "max_new_tokens": int(args.max_new_tokens),
        "do_sample": False,
    }
    if args.acoustic_tokenizer_chunk_size <= 0:
        raise RuntimeError("音频编码分块必须大于零")
    inputs = encode_audio_inputs(model, inputs, torch, int(args.acoustic_tokenizer_chunk_size))
    progress(35, "VibeVoice 4bit CUDA 识别中…")
    class TokenProgress:
        def __init__(self):
            self.first = True
            self.count = 0
            self.last = time.monotonic()

        def put(self, value):
            if self.first:
                self.first = False
                return
            self.count += int(value.numel())
            now = time.monotonic()
            if now - self.last >= 5:
                emit({"type": "log", "msg": "CUDA 已生成 %d token" % self.count})
                self.last = now

        def end(self):
            pass

    started = time.monotonic()
    with torch.inference_mode():
        generated = model.generate(**inputs, **generate_kwargs, streamer=TokenProgress())
    emit({"type": "log", "msg": "CUDA 生成耗时 %.1fs，峰值分配显存 %.0fMiB" % (
        time.monotonic() - started, torch.cuda.max_memory_allocated(device) / 1048576)})
    if hasattr(generated, "sequences"):
        generated = generated.sequences
    if hasattr(inputs, "__contains__") and "input_ids" in inputs and hasattr(generated, "shape"):
        prompt_len = int(inputs["input_ids"].shape[1])
        if generated.ndim != 2 or generated.shape[0] != 1 or generated.shape[-1] <= prompt_len:
            raise RuntimeError("VibeVoice 生成结果没有可解码的新增 token")
        generated = generated[:, prompt_len:]
        eos = model.generation_config.eos_token_id
        eos = eos if isinstance(eos, list) else [eos]
        if generated.shape[-1] >= args.max_new_tokens and int(generated[0, -1]) not in eos:
            raise RuntimeError("VibeVoice 达到输出长度上限，请缩短识别音频；未保存截断稿件")
    progress(88, "解析 VibeVoice 时间戳…")
    raw = decode_transcription(processor, generated)
    segments = normalize_segments(raw, duration)
    if not segments:
        raise RuntimeError("VibeVoice 未返回带时间轴的识别结果")
    payload = {"duration": round(duration, 3), "language": "auto", "segments": segments}
    out = Path(args.out)
    tmp = Path(str(out) + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, out)
    progress(100, "VibeVoice 识别完成：%d 行" % len(segments))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="VibeVoice ASR CUDA 4bit worker")
    parser.add_argument("--model")
    parser.add_argument("--audio")
    parser.add_argument("--out")
    parser.add_argument("--provider", choices=["cuda"])
    parser.add_argument("--probe", action="store_true")
    parser.add_argument(
        "--acoustic-tokenizer-chunk-size", "--tokenizer-chunk-size",
        dest="acoustic_tokenizer_chunk_size", type=int, default=32000,
        help="VibeVoice acoustic tokenizer chunk size; use a multiple of 3200",
    )
    parser.add_argument("--max-new-tokens", type=int, default=8192)
    args = parser.parse_args()
    try:
        if args.probe:
            info = probe_runtime()
            print(json.dumps(info, ensure_ascii=False))
            return 0 if info["ok"] else 1
        if not args.model or not args.audio or not args.out or args.provider != "cuda":
            raise RuntimeError("VibeVoice 只接受完整的 CUDA 参数，CPU/NPU 路径已禁用")
        return run(args)
    except Exception as exc:  # pragma: no cover - runtime failures are surfaced to Node
        message = str(exc).strip() or type(exc).__name__
        if "out of memory" in message.lower():
            message = "CUDA 显存不足，请关闭占用显存的程序或缩短音频；不会回退 CPU。" + message[:180]
        emit({"type": "error", "msg": message})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
