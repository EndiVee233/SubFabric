#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Multitalker Parakeet Streaming 0.6B v1 推理（NeMo + PyTorch, 仅 CUDA/N 卡）。

定位: **只用于「选区重新识别」** —— 不能参与创建初稿(产品规则由 server.js 强制, 这里再兜一层)。
模型目录需含:
    multitalker-parakeet-streaming-0.6b-v1.nemo        (NVIDIA NeMo 权重, 约 2.3GB)
    multitalker_transcript_config.py                   (官方配置类, 含 single_speaker_mode)
    diar_streaming_sortformer_4spk-v2.1.nemo           (官方流式分离权重, 约 450MB)
说明: NeMo 的 SpeakerTaggedASR **即使单说话人模式也要求传 diar_model 对象**
      (构造函数里读 diar_model._cfg.max_num_of_spks), 所以分离权重是必需项。
输出: 与 asr.py **完全相同**的 JSON —— {duration, language, segments:[{id,start,end,text,words}]},
      这样选区重识别那套下游(偏移回填/翻译/写回字幕)完全不用改。

单说话人模式: 选区重识别按"一个人一直在说话"处理 —— cfg.single_speaker_mode = True,
不接 Sortformer 分离模型(真正多人重叠场景留给后续版本)。

用法: python multitalker.py --model <模型目录> --audio <16k单声道wav> --out <结果json>
                           [--threads 4] [--provider cuda]
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import asr as asrlib          # 复用: 音频读取 / 断句 / 日志协议 —— 两个引擎输出保持一致

emit, log, progress = asrlib.emit, asrlib.log, asrlib.progress


def find_nemo(model_dir):
    """挑**主权重**。注意模型目录里还有官方流式分离权重(diar_*.nemo) ——
    按字母序取第一个会先拿到 diar_(d < m), 把分离模型当成 ASR 加载(实测踩过:
    "权重加载完成: SortformerEncLabelModel" 然后再加载一次分离权重 → CUDA OOM)。"""
    try:
        names = [n for n in sorted(os.listdir(model_dir)) if n.lower().endswith(".nemo")]
    except OSError as e:
        raise RuntimeError("模型目录不可读: %s (%s)" % (model_dir, e))
    if not names:
        raise RuntimeError("模型目录里没有 .nemo 权重（先去设置里下载该模型）: " + model_dir)
    for n in names:                                   # 主权重优先按名字匹配
        if "multitalker" in n.lower():
            return os.path.join(model_dir, n)
    names.sort(key=lambda n: os.path.getsize(os.path.join(model_dir, n)), reverse=True)   # 否则取最大的
    return os.path.join(model_dir, names[0])


def free_ram_gb():
    """可用物理内存(GB)。ctypes 调系统 API, 不引第三方依赖 —— 只为下面那条预检。"""
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return st.ullAvailPhys / 1073741824.0
    except Exception:
        pass
    return None


# fp32 权重 2.3GB + 模型实例化约 2.4GB(编码器 24 层) + 峰值开销 —— 低于这个值会
# 在 torch 分配权重时**直接崩掉进程**(原生段错误, 没有 Python 堆栈, 用户只看到"进程崩溃"),
# 所以宁可在加载前拦下来给一句人话。
MIN_RAM_GB = 6.0


def load_model(model_dir, provider):
    """加载 NeMo 权重。**拒绝 CPU 推理** —— multitalker 只认 N 卡(CUDA)。"""
    import torch
    from nemo.collections.asr.models import ASRModel

    if provider != "cuda":
        raise RuntimeError("该模型只支持 CUDA GPU 推理（不支持 CPU）: 收到 provider=%r" % provider)
    if not torch.cuda.is_available():
        raise RuntimeError("未检测到可用的 CUDA GPU（torch.cuda.is_available()=False）——"
                           "该模型不支持 CPU 推理，请使用 NVIDIA 显卡并安装 CUDA 版 PyTorch")

    avail = free_ram_gb()
    if avail is not None and avail < MIN_RAM_GB:
        raise RuntimeError("可用内存不足：约需 %.1fGB，当前只有 %.1fGB ——"
                           "该模型(fp32)在 CPU 侧实例化+载入权重时峰值约 6GB，不足会让进程直接崩溃。"
                           "请关掉占内存的程序后重试，或换用 Parakeet TDT / Whisper 模型" % (MIN_RAM_GB, avail))
    if avail is not None:
        log("可用内存 %.1fGB" % avail)

    nemo_path = find_nemo(model_dir)
    log("加载权重 %s （%.0f MB）…" % (os.path.basename(nemo_path), os.path.getsize(nemo_path) / 1048576.0))
    try:
        model = ASRModel.restore_from(nemo_path, map_location="cuda")
    except Exception:
        model = ASRModel.from_pretrained(nemo_path)
    model.eval()
    try:
        model = model.to("cuda")
    except Exception:
        pass
    log("权重加载完成: %s" % type(model).__name__)
    return model


def load_diar_model(model_dir):
    """加载官方流式分离模型(必需: SpeakerTaggedASR 即使单说话人模式也要 diar_model 对象)。
    多说话人重叠场景的完整能力留给后续版本; 这里它只为满足官方接口 + 提供说话人槽位。"""
    import torch
    from nemo.collections.asr.models import SortformerEncLabelModel

    name = "diar_streaming_sortformer_4spk-v2.1.nemo"
    path_ = os.path.join(model_dir, name)
    if not os.path.isfile(path_):
        raise RuntimeError("缺少流式分离权重 %s（应在模型目录里，重新下载该模型即可）" % name)
    log("加载流式分离权重 %s …" % name)
    diar = SortformerEncLabelModel.restore_from(path_, map_location="cuda")
    diar.eval()
    return diar


def cfg_from_official(model_dir):
    """官方配置类(随模型一起下载) —— 单说话人模式 + 流式参数都在里面。"""
    if model_dir not in sys.path:
        sys.path.insert(0, model_dir)
    try:
        from multitalker_transcript_config import MultitalkerTranscriptionConfig
    except Exception as e:
        raise RuntimeError("缺少 multitalker_transcript_config.py（应在模型目录里）: %s" % e)
    return MultitalkerTranscriptionConfig


def streaming_transcribe(model, model_dir, wav, sample_rate):
    """NVIDIA 官方流式多说话人流程 + 单说话人模式。

    返回: [{"start": s, "end": e, "text": t, "words": [{"word","start","end"}...]}]
    """
    import torch
    from omegaconf import OmegaConf
    MultitalkerTranscriptionConfig = cfg_from_official(model_dir)
    from nemo.collections.asr.parts.utils.streaming_utils import CacheAwareStreamingAudioBuffer
    from nemo.collections.asr.parts.utils.multispk_transcribe_utils import SpeakerTaggedASR

    cfg = OmegaConf.structured(MultitalkerTranscriptionConfig())
    cfg.audio_file = wav
    cfg.device = "cuda"
    cfg.cuda = 0
    cfg.use_amp = True
    cfg.batch_size = 1
    cfg.print_time = False
    cfg.colored_text = False
    cfg.verbose = False
    cfg.log = False
    # 选区重识别 = 一个人一直在说话: 官方 single_speaker_mode 会把 spk_targets 强制成全 1;
    # 配合 max_num_of_spks=1 → NeMo 内部直接判定"单说话人"(不再依赖分离结果), 只跑一个 ASR 实例
    cfg.single_speaker_mode = True
    cfg.max_num_of_spks = 1

    samples = [{"audio_filepath": wav}]
    buf = CacheAwareStreamingAudioBuffer(
        model=model,
        online_normalization=cfg.online_normalization,
        pad_and_drop_preencoded=cfg.pad_and_drop_preencoded,
    )
    buf.append_audio_file(audio_filepath=wav, stream_id=-1)

    diar = load_diar_model(model_dir)
    streamer = SpeakerTaggedASR(cfg, model, diar)
    for step, (chunk_audio, chunk_lengths) in enumerate(iter(buf)):
        drop_extra_pre_encoded = 0 if step == 0 and not cfg.pad_and_drop_preencoded else getattr(
            getattr(model.encoder, "streaming_cfg", None), "drop_extra_pre_encoded", 0)
        with torch.inference_mode(), torch.autocast("cuda", enabled=cfg.use_amp):
            streamer.perform_parallel_streaming_stt_spk(
                step_num=step, chunk_audio=chunk_audio, chunk_lengths=chunk_lengths,
                is_buffer_empty=buf.is_buffer_empty(), drop_extra_pre_encoded=drop_extra_pre_encoded,
            )
        progress(30 + min(50, int(step * 1.5)), "asr", "流式识别第 %d 块…" % (step + 1))
    streamer.generate_seglst_dicts_from_parallel_streaming(samples=samples)
    seglst = getattr(getattr(streamer, "instance_manager", None), "seglst_dict_list", None) or []
    log("流式识别完成: %d 个片段" % len(seglst))
    return seglst


def segments_from_seglst(seglst):
    """官方 seglst(按说话人切好的片段, 含词) → 本项目的 segments 结构。"""
    words = []
    for item in seglst:
        for w in (item.get("words") or []):
            txt = (w.get("word") or w.get("text") or "").strip()
            if not txt:
                continue
            try:
                st = float(w.get("start", w.get("start_time")))
                en = float(w.get("end", w.get("end_time")))
            except (TypeError, ValueError):
                continue
            words.append({"word": txt, "start": st, "end": en})
    if not words:
        # 没拿到词级时间: 退化成一个整段(下游仍可按行处理)
        spans = []
        for item in seglst:
            txt = (item.get("text") or item.get("transcript") or "").strip()
            if not txt:
                continue
            try:
                spans.append({"start": float(item.get("start", 0.0)), "end": float(item.get("end", 0.0)), "text": txt})
            except (TypeError, ValueError):
                continue
        spans.sort(key=lambda x: x["start"])
        return [{"id": i, "start": s["start"], "end": s["end"], "text": s["text"], "words": []}
                for i, s in enumerate(spans)]
    words.sort(key=lambda w: w["start"])
    return asrlib.words_to_segments(words)


def offline_transcribe(model, wav):
    """兜底: NeMo 标准 transcribe（部分版本不支持该模型的非流式路径, 失败就抛给上层）。"""
    log("尝试 NeMo 标准 transcribe（兜底路径）…")
    hyps = model.transcribe([wav], batch_size=1, verbose=False)
    out = []
    for i, h in enumerate(hyps):
        text = getattr(h, "text", None) or str(h)
        out.append({"start": 0.0, "end": 0.0, "text": text.strip()})
    return out


def main():
    ap = argparse.ArgumentParser(description="Multitalker Parakeet Streaming 推理（NeMo, 仅重新识别）")
    ap.add_argument("--model", required=True, help="模型目录(含 .nemo + multitalker_transcript_config.py)")
    ap.add_argument("--audio", required=True, help="16kHz 单声道 PCM wav")
    ap.add_argument("--out", required=True, help="结果 JSON 输出路径")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--provider", default="cuda", choices=["cuda"],
                    help="只允许 cuda —— 该模型不支持 CPU 推理")
    args = ap.parse_args()

    try:
        log("读取音频 …")
        samples, sr = asrlib.read_wav_mono16k(args.audio)
        dur = len(samples) / float(sr)
        log("音频 %.1fs @ %dHz" % (dur, sr))
        if dur < 0.2:
            raise RuntimeError("音频过短或无有效采样")

        progress(10, "asr", "加载多说话人模型（NeMo）…")
        model = load_model(args.model, args.provider)

        progress(28, "asr", "开始流式识别（单说话人模式）…")
        t0 = time.time()
        try:
            raw = streaming_transcribe(model, args.model, args.audio, sr)
            segments = segments_from_seglst(raw)
        except Exception as e:
            log("流式路径不可用(%s)，改用标准 transcribe 兜底" % str(e)[:200])
            spans = offline_transcribe(model, args.audio)
            segments = [{"id": i, "start": s["start"], "end": s["end"], "text": s["text"], "words": []}
                        for i, s in enumerate(spans)]
        if not segments:
            raise RuntimeError("未识别到语音内容(模型输出为空)")
        log("识别完成 %d 行, 耗时 %.1fs" % (len(segments), time.time() - t0))

        progress(92, "asr", "写入结果 …")
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
