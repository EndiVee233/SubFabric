"""下载本地翻译模型（NLLB-200 distilled 600M，CTranslate2 int8 版，约 617MB）。

给「本地模型 NLLB-200」翻译引擎用。为什么要单独下：
  文件不小（617MB），而且**不是** npm 包或 pip 包，放在仓库里会让 clone 变得很重。
  所以按需下载到 models/ 下（与 ASR 模型同样的思路）。

用法：
    python tools/download-mt-nllb.py                 # 下到 <仓库>/models/
    python tools/download-mt-nllb.py --dest D:\\x     # 指定目录
    python tools/download-mt-nllb.py --check          # 只检查是否已就位

下完把路径告诉 SubFabric（二选一）：
    * 放在 <仓库>/models/nllb-200-distilled-600M-ct2-int8  —— 自动识别；
    * 或设环境变量 SUBFABRIC_MT_MODEL=<模型目录>
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.request
import ssl

REPO_ID = "JustFrederik/nllb-200-distilled-600M-ct2-int8"
DIR_NAME = "nllb-200-distilled-600M-ct2-int8"
FILES = [
    "config.json",
    "model.bin",
    "shared_vocabulary.txt",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
]
MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"]
CTX = ssl.create_default_context()


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def is_ready(dest: str) -> bool:
    return (os.path.exists(os.path.join(dest, "model.bin"))
            and os.path.exists(os.path.join(dest, "tokenizer.json")))


def fetch(url: str, path: str, label: str) -> bool:
    have = os.path.getsize(path) if os.path.exists(path) else 0
    headers = {"User-Agent": "SubFabric-downloader"}
    if have:
        headers["Range"] = f"bytes={have}-"
    resp = urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                 timeout=120, context=CTX)
    total = have + int(resp.headers.get("Content-Length") or 0)
    got, t0, last = have, time.time(), 0.0
    with open(path, "ab" if have else "wb") as fh:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            fh.write(chunk)
            got += len(chunk)
            now = time.time()
            if now - last > 2.0:
                last = now
                pct = (got / total * 100) if total else 0
                mbps = (got - have) / max(0.1, now - t0) / 1048576
                print(f"    {label}: {pct:5.1f}%  {got/1048576:6.1f}/{total/1048576:.1f} MB  "
                      f"{mbps:.1f} MB/s", flush=True)
    return got >= total * 0.999 if total else True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=os.path.join(repo_root(), "models", DIR_NAME))
    ap.add_argument("--check", action="store_true", help="只检查，不下载")
    args = ap.parse_args()

    if args.check:
        ok = is_ready(args.dest)
        print(f"{'已就位' if ok else '未就位'}: {args.dest}")
        return 0 if ok else 1

    os.makedirs(args.dest, exist_ok=True)
    print(f"目标: {args.dest}")
    print(f"来源: {REPO_ID}（约 617MB，int8 量化）\n")
    for name in FILES:
        path = os.path.join(args.dest, name)
        ok = False
        for base in MIRRORS:
            try:
                print(f"  {name}  <- {base}")
                if fetch(f"{base}/{REPO_ID}/resolve/main/{name}", path, name):
                    ok = True
                    break
                print("    （未下完，换镜像重试）")
            except Exception as exc:  # noqa: BLE001
                print(f"    失败: {exc}")
        if not ok:
            print(f"  ✗ {name} 下载失败")
            return 1
        print(f"  ✓ {name}  {os.path.getsize(path)/1048576:.1f} MB")

    print("\n完成。检查所需文件:")
    print(f"  model.bin / tokenizer.json / shared_vocabulary.txt 都在 {args.dest}")
    print("\n使用方式：在「设置 → 字幕翻译」里把引擎选成「本地模型 NLLB-200（不联网·用 GPU）」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
