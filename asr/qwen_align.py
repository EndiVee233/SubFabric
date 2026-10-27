#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Qwen3-ForcedAligner batch worker for Python 3.10+ / CUDA.

The caller supplies a manifest:
  {
    "audio": "D:/path/audio.wav",
    "language": "English",
    "items": [{"id": 0, "start": 12.3, "end": 15.8, "text": "known transcript"}]
  }

Output:
  {"items": [{"id": 0, "words": [{"word": "...", "start": 12.4, "end": 12.8}]}]}

The audio is loaded once and the aligner is loaded once, so a full-project
realign does not pay the model-load cost for every subtitle block.
"""
import argparse
import json
import sys
import time
from pathlib import Path

from common import watch_parent

def progress(pct, msg):
    try:
        sys.stderr.write(json.dumps(
            {"type": "progress", "pct": max(0, min(100, int(pct))), "msg": str(msg)},
            ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="Qwen3-ForcedAligner model directory")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    watch_parent()

    # 重导入（torch/transformers 约 5s）放到 watch_parent 之后：父进程在加载模型期间
    # 退出时，看护线程也能尽早发现，不留下长时间孤儿。
    import numpy as np
    import soundfile as sf
    import torch
    from transformers import AutoModelForTokenClassification, AutoProcessor

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is not available; Qwen aligner is CUDA-only here")

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    audio_path = manifest["audio"]
    language = manifest.get("language") or "English"
    items = manifest.get("items") or []
    progress(1, "读取音频…")
    data, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)

    t0 = time.time()
    processor = AutoProcessor.from_pretrained(args.model, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(
        args.model, dtype=torch.bfloat16, device_map="cuda", local_files_only=True,
    )
    model.eval()
    load_sec = round(time.time() - t0, 3)
    print(f"loaded in {load_sec}s", file=sys.stderr, flush=True)
    progress(3, f"模型已加载，开始对齐 {len(items)} 段…")

    out = {"loadSec": load_sec, "items": []}
    total = max(1, len(items))
    for idx, item in enumerate(items):
        ident = item.get("id")
        try:
            start = max(0.0, float(item.get("start") or 0.0))
            end = min(len(data) / max(1, sr), float(item.get("end") or 0.0))
            if not (end > start):
                raise ValueError("invalid audio range")
            text = str(item.get("text") or "").strip()
            if not text:
                raise ValueError("empty transcript")
            a = int(round(start * sr))
            b = int(round(end * sr))
            chunk = np.ascontiguousarray(data[a:b])
            if chunk.size < int(sr * 0.05):
                raise ValueError("audio slice too short")
            inputs, word_lists = processor.prepare_forced_aligner_inputs(
                audio=chunk, transcript=text, language=language,
            )
            inputs = inputs.to("cuda", torch.bfloat16)
            with torch.inference_mode():
                logits = model(**inputs).logits
            stamps = processor.decode_forced_alignment(
                logits=logits, input_ids=inputs["input_ids"], word_lists=word_lists,
                timestamp_token_id=model.config.timestamp_token_id,
            )[0]
            words = []
            for w in stamps:
                word = str(w.get("text") or w.get("word") or "").strip()
                if not word:
                    continue
                words.append({
                    "word": word,
                    "start": round(start + float(w.get("start_time") or 0.0), 3),
                    "end": round(start + float(w.get("end_time") or 0.0), 3),
                })
            out["items"].append({"id": ident, "words": words})
        except Exception as exc:  # one bad block must not kill the batch
            out["items"].append({"id": ident, "words": [], "error": str(exc)[:300]})
        progress(3 + int((idx + 1) / total * 96), f"对齐 {idx + 1}/{len(items)} 段…")

    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    progress(100, "对齐完成")


if __name__ == "__main__":
    main()
