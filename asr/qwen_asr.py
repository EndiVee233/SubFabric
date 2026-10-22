# -*- coding: utf-8 -*-
"""Qwen3-ASR-1.7B worker for SubFabric.

CUDA only. The ASR model produces text. If --aligner is supplied, the separate
Qwen3-ForcedAligner turns that text into word-level timestamps; without it the
output is sentence-level only (the caller then writes SRT).
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def log(msg):
    print(msg, flush=True)


def t2s(text):
    return str(text or "").strip()


def load_audio(path):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    if data.shape[1] > 1:
        data = data.mean(axis=1)
    return data, sr


def write_wav(path, data, sr):
    sf.write(path, data, sr, subtype="PCM_16")


def split_sentences(words):
    """Group aligned words into subtitle-sized segments.

    The aligner strips punctuation from word text, so also break on pauses, a
    maximum duration and a maximum word count. The app's reseg stage can refine
    these groups further.
    """
    groups, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        text = str(w.get("word") or w.get("text") or "")
        gap = (words[i + 1]["start"] - w["end"]) if i + 1 < len(words) else 99
        span = float(cur[-1]["end"]) - float(cur[0]["start"])
        if ((re.search(r"[.!?。！？…]$", text.strip()) and len(cur) >= 2)
                or gap > 0.8 or span >= 8.0 or len(cur) >= 24):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    out = []
    for i, ws in enumerate(groups):
        if not ws:
            continue
        out.append({
            "id": i,
            "start": round(float(ws[0]["start"]), 3),
            "end": round(float(ws[-1]["end"]), 3),
            "text": " ".join(str(w.get("word") or w.get("text") or "").strip() for w in ws).strip(),
            "words": ws,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="Qwen3-ASR model directory")
    ap.add_argument("--aligner", default="", help="optional Qwen3-ForcedAligner directory")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--provider", default="cuda", choices=["cuda"])
    ap.add_argument("--language", default="en")
    ap.add_argument("--chunk-sec", type=float, default=150.0)
    ap.add_argument("--max-new-tokens", type=int, default=4096)
    ap.add_argument("--threads", type=int, default=4)  # accepted for contract parity; unused
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("Qwen3 需要 NVIDIA CUDA，未检测到可用 CUDA")

    from transformers import AutoProcessor, AutoModelForMultimodalLM, AutoModelForTokenClassification

    lang_name = {"en": "English", "zh": "Chinese", "auto": None}.get(str(args.language).lower(), None)
    t0 = time.time()
    log("加载 Qwen3-ASR…")
    asr_proc = AutoProcessor.from_pretrained(args.model, local_files_only=True)
    asr = AutoModelForMultimodalLM.from_pretrained(
        args.model, dtype=torch.bfloat16, device_map="cuda", local_files_only=True,
    )
    asr.eval()
    al_proc = al = None
    if args.aligner:
        log("加载 Qwen3-ForcedAligner…")
        al_proc = AutoProcessor.from_pretrained(args.aligner, local_files_only=True)
        al = AutoModelForTokenClassification.from_pretrained(
            args.aligner, dtype=torch.bfloat16, device_map="cuda", local_files_only=True,
        )
        al.eval()
    log("模型就绪：%.1fs" % (time.time() - t0))

    data, sr = load_audio(args.audio)
    duration = len(data) / float(sr)
    chunk = max(5.0, float(args.chunk_sec))
    tmp = tempfile.mkdtemp(prefix="sf-qwen-")
    words_all = []
    segments_simple = []
    try:
        starts = [i * chunk for i in range(max(1, int(np.ceil(duration / chunk))))]
        for idx, st in enumerate(starts):
            en = min(duration, st + chunk)
            if en - st < 0.2:
                continue
            wav = os.path.join(tmp, f"c{idx}.wav")
            write_wav(wav, data[int(st * sr):int(en * sr)], sr)
            log(f"分块 {idx + 1}/{len(starts)}：{st:.1f}-{en:.1f}s")
            inputs = asr_proc.apply_transcription_request(audio=wav, language=lang_name)
            inputs = inputs.to("cuda", torch.bfloat16)
            with torch.inference_mode():
                out = asr.generate(**inputs, max_new_tokens=int(args.max_new_tokens), do_sample=False)
            gen = out[:, inputs["input_ids"].shape[1]:]
            text = asr_proc.decode(gen, return_format="transcription_only")[0].strip()
            if not text:
                log("本块 ASR 无文本，跳过")
                continue
            if al_proc is None:
                # 没装对齐器：只输出句级文本，调用方会写 SRT。
                segments_simple.append({
                    "id": len(segments_simple), "start": round(st, 3),
                    "end": round(en, 3), "text": text, "words": [],
                })
                log("本块完成：句级（未加载对齐器）")
                continue
            ai, wl = al_proc.prepare_forced_aligner_inputs(
                audio=wav, transcript=text, language=lang_name or "English",
            )
            ai = ai.to("cuda", torch.bfloat16)
            with torch.inference_mode():
                ao = al(**ai)
            stamps = al_proc.decode_forced_alignment(
                logits=ao.logits, input_ids=ai["input_ids"], word_lists=wl,
                timestamp_token_id=al.config.timestamp_token_id,
            )[0]
            for node in stamps:
                w = str(node.get("text") or "").strip()
                if not w:
                    continue
                words_all.append({
                    "word": w,
                    "start": round(float(node["start_time"]) + st, 3),
                    "end": round(float(node["end_time"]) + st, 3),
                })
            log(f"本块完成：{len(stamps)} 词")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if al_proc is None:
        if not segments_simple:
            raise SystemExit("未得到任何字幕段")
        segments = segments_simple
    else:
        if not words_all:
            raise SystemExit("未得到任何对齐词，无法生成逐词字幕")
        segments = split_sentences(words_all)
    result = {"duration": round(duration, 3), "language": args.language or "en",
              "segments": segments}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    log(f"完成：{len(segments)} 段 / {len(words_all)} 词 -> {args.out}")


if __name__ == "__main__":
    main()
