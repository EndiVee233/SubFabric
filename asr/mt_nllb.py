#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NLLB-200 本地翻译服务（CTranslate2，优先 GPU）—— 供 SubFabric 的「本地模型」翻译引擎调用。

为什么是"服务"而不是"每次 spawn 一个 worker"：
    NLLB 加载一次要十几秒、占 600MB 内存。而翻译是**逐批往返**的（一批几十行），
    每次起进程等于每批都重新加载模型。所以这里做成常驻小服务，SubFabric 启动它一次、
    之后走 HTTP 请求；翻译结束/退出时随子进程一起收掉。

为什么用 CTranslate2 版模型而不是 webapp 那份 ONNX：
    webapp 那份是给 Transformers.js 用的量化 ONNX，要跑它就得把 onnxruntime-node
    （287MB 原生二进制）带进 SubFabric —— 而 SubFabric 是**零 npm 依赖**的。
    CTranslate2 只要 model.bin + 词表，本机 ctranslate2 还自带 CUDA。

接口（只监听 127.0.0.1）：
    GET  /health
        -> {"ok":true,"device":"cuda","computeType":"int8","model":"…","loaded":true}
    POST /translate  {"texts":[…],"src":"en","tgt":"zh"[,"maxNewTokens":256]}
        -> {"texts":[…],"ms":123,"device":"cuda","nllb":{"src":"eng_Latn","tgt":"zho_Hans"}}
    POST /shutdown   -> {"ok":true}（然后退出）

两种模式：
    （默认）常驻服务；--once 则从 stdin 读一行 JSON、把结果写到 stdout 后退出（给测试用）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# NLLB 的语言标记。子集按需扩充即可（NLLB-200 支持 200 种语言）。
NLLB_LANGS = {
    "en": "eng_Latn", "zh": "zho_Hans", "zh-Hant": "zho_Hant", "ja": "jpn_Jpan",
    "ko": "kor_Hang", "fr": "fra_Latn", "de": "deu_Latn", "es": "spa_Latn",
    "ru": "rus_Cyrl", "pt": "por_Latn", "it": "ita_Latn", "ar": "arb_Arab",
    "th": "tha_Thai", "vi": "vie_Latn", "hi": "hin_Deva", "id": "ind_Latn",
    "nl": "nld_Latn", "pl": "pol_Latn", "tr": "tur_Latn", "uk": "ukr_Cyrl",
}

_CJK = ("\u3000", "\u303f", "\u3040", "\u30ff", "\u3400", "\u4dbf",
        "\u4e00", "\u9fff", "\uf900", "\ufaff", "\uff00", "\uffef")


def tidy_spacing(text: str) -> str:
    """NLLB 输出的是 SentencePiece 风格的空格，中文里会夹多余空格 —— 收拾一下。

    与 webapp/server/mt_engine.js 的 tidySpacing 同一套规则（两处输出要对得上）。
    """
    out = str(text or "").strip()
    if not out:
        return out
    import re
    out = re.sub(r"\s+", " ", out)
    if any("\u3000" <= ch <= "\u9fff" or "\uff00" <= ch <= "\uffef" for ch in out):
        out = re.sub(r"\s+(?=[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef])", "", out)
        out = re.sub(r"(?<=[\u4e00-\u9fff])\s+", "", out)
    out = re.sub(r"\s+([,.!?;:%）】」』])", r"\1", out)
    out = re.sub(r"([（【「『])\s+", r"\1", out)
    return out.strip()


class Translator:
    """CTranslate2 的 NLLB 封装。懒加载：第一次翻译时才载入模型。"""

    def __init__(self, model_dir: str, device: str = "auto", compute_type: str = "",
                 inter_threads: int = 1, intra_threads: int = 0):
        self.model_dir = model_dir
        self.device = device
        self.compute_type = compute_type
        self.inter_threads = inter_threads
        self.intra_threads = intra_threads
        self._ct2 = None
        self._tok = None
        self._lock = threading.Lock()
        self.load_ms = 0

    # ---------------------------------------------------------------- 载入
    def load(self):
        with self._lock:
            if self._ct2 is not None:
                return
            import ctranslate2
            from tokenizers import Tokenizer

            t0 = time.time()
            dev = self.device
            if dev == "auto":
                dev = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            ct = self.compute_type or ("int8" if dev == "cuda" else "int8")
            kwargs = {"device": dev, "compute_type": ct}
            if self.intra_threads:
                kwargs["intra_threads"] = self.intra_threads
            try:
                self._ct2 = ctranslate2.Translator(self.model_dir, **kwargs)
            except Exception as exc:  # noqa: BLE001
                if dev != "cpu":
                    sys.stderr.write(json.dumps({
                        "type": "log",
                        "msg": "在 %s 上加载失败(%s)，回退 CPU" % (dev, str(exc)[:120])}) + "\n")
                    sys.stderr.flush()
                    dev = "cpu"
                    self._ct2 = ctranslate2.Translator(self.model_dir, device="cpu",
                                                      compute_type="int8")
                else:
                    raise
            self.device = dev

            tok_path = os.path.join(self.model_dir, "tokenizer.json")
            if not os.path.exists(tok_path):
                raise RuntimeError("模型目录缺少 tokenizer.json：%s" % self.model_dir)
            self._tok = Tokenizer.from_file(tok_path)
            # tokenizer.json 里没有 src_lang，但 NLLB 需要源语言标记作为输入前缀；
            # 这里显式设置，保证 encode 出来带 eng_Latn 之类的标记。
            self.load_ms = int((time.time() - t0) * 1000)

    # ---------------------------------------------------------------- 翻译
    def lang_id(self, code: str) -> str:
        token = NLLB_LANGS.get(code, code)
        vocab = self._tok.get_vocab()
        if token not in vocab:
            raise RuntimeError("词表里没有语言标记 %s（模型可能不是 NLLB）" % token)
        return token

    def translate(self, texts, src: str = "en", tgt: str = "zh", max_new_tokens: int = 256):
        self.load()
        src_tok, tgt_tok = self.lang_id(src), self.lang_id(tgt)
        self._tok.no_truncation()
        self._tok.encode_special_tokens = True

        def encode_one(text: str):
            # NLLB 的输入格式：<src_lang> 原文
            self._tok.set_language(src_tok) if hasattr(self._tok, "set_language") else None
            enc = self._tok.encode(text, pair=None, is_pretokenized=False)
            ids = enc.ids
            vocab = self._tok.get_vocab()
            inv = {v: k for k, v in vocab.items()}
            toks = [inv[i] for i in ids]
            if toks and toks[0] != src_tok:
                toks = [src_tok] + toks
            return toks

        batch = [encode_one(str(t or "").strip()) for t in texts]
        empty = [i for i, b in enumerate(batch) if not b]
        results = list(texts)

        t0 = time.time()
        if len(batch) > len(empty):
            out = self._ct2.translate_batch(
                batch,
                target_prefix=[[tgt_tok]] * len(batch),
                max_decoding_length=int(max_new_tokens),
                beam_size=1,
                replace_unknowns=True,
            )
            vocab = self._tok.get_vocab()
            for i, res in enumerate(out):
                if i in empty:
                    continue
                toks = list(res.hypotheses[0])
                # 去掉开头的目标语言标记
                if toks and toks[0] == tgt_tok:
                    toks = toks[1:]
                ids = [vocab[t] for t in toks if t in vocab]
                results[i] = tidy_spacing(self._tok.decode(ids, skip_special_tokens=True))
        for i in empty:
            results[i] = ""
        return {"texts": results, "ms": int((time.time() - t0) * 1000),
                "device": self.device, "nllb": {"src": src_tok, "tgt": tgt_tok}}


def make_handler(translator: Translator):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):        # 静音默认的 stderr 访问日志
            pass

        def _send(self, code: int, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return {}
            try:
                return json.loads(self.rfile.read(n).decode("utf-8"))
            except Exception:  # noqa: BLE001
                return {}

        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] == "/health":
                return self._send(200, {
                    "ok": True, "loaded": translator._ct2 is not None,
                    "device": translator.device, "model": translator.model_dir,
                    "loadMs": translator.load_ms,
                })
            return self._send(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            path = self.path.split("?")[0]
            if path == "/shutdown":
                self._send(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if path != "/translate":
                return self._send(404, {"error": "not found"})
            body = self._read_json()
            texts = body.get("texts")
            if not isinstance(texts, list):
                return self._send(400, {"error": "texts 必须是字符串数组"})
            try:
                out = translator.translate(
                    texts,
                    src=str(body.get("src") or "en"),
                    tgt=str(body.get("tgt") or "zh"),
                    max_new_tokens=int(body.get("maxNewTokens") or 256),
                )
            except Exception as exc:  # noqa: BLE001
                return self._send(500, {"error": str(exc)})
            return self._send(200, out)

    return Handler


def run_once(model_dir: str, device: str, compute_type: str, req_file: str = "") -> int:
    """读一个请求（--request-file 指定，或从 stdin 读一行 JSON），结果写 stdout。"""
    if req_file:
        with open(req_file, encoding="utf-8") as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.readline()
    if not raw.strip():
        print(json.dumps({"error": "没有读到请求"}, ensure_ascii=False))
        return 1
    # 容错：整文件读取时可能带换行/缩进，直接按 JSON 解析（不依赖单行）
    req = json.loads(raw)
    tr = Translator(model_dir, device=device, compute_type=compute_type)
    out = tr.translate(req.get("texts") or [], src=req.get("src") or "en",
                       tgt=req.get("tgt") or "zh")
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="NLLB-200 本地翻译服务（CTranslate2）")
    ap.add_argument("--model", default=os.environ.get("SUBFABRIC_MT_MODEL", ""),
                    help="CTranslate2 模型目录（含 model.bin / tokenizer.json）")
    ap.add_argument("--port", type=int, default=0, help="监听端口（0 = 让系统分配）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--compute-type", default="", help="默认 int8")
    ap.add_argument("--threads", type=int, default=0, help="intra_threads（0 = 库自己决定）")
    ap.add_argument("--once", action="store_true", help="读一个请求、写 stdout 后退出")
    ap.add_argument("--request-file", default="", help="配合 --once：从这个 JSON 文件读请求")
    args = ap.parse_args()

    if not args.model:
        sys.stderr.write(json.dumps({"type": "error", "msg": "必须指定 --model 或 SUBFABRIC_MT_MODEL"}) + "\n")
        return 2
    if not os.path.isdir(args.model):
        sys.stderr.write(json.dumps({"type": "error", "msg": "模型目录不存在: %s" % args.model}) + "\n")
        return 2

    if args.once:
        return run_once(args.model, args.device, args.compute_type, args.request_file)

    tr = Translator(args.model, device=args.device, compute_type=args.compute_type,
                    intra_threads=args.threads)
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(tr))
    port = srv.server_address[1]
    # 先把端口告诉调用方（SubFabric 读这行拿到实际端口；用 PORT= 前缀便于解析）
    sys.stdout.write("PORT=%d\n" % port)
    sys.stdout.flush()
    sys.stderr.write(json.dumps({"type": "log",
                                 "msg": "本地翻译服务已就绪 http://%s:%d/ （模型 %s，设备 %s，懒加载）"
                                        % (args.host, port, os.path.basename(args.model), args.device)},
                                ensure_ascii=False) + "\n")
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
