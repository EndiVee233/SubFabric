#!/usr/bin/env python3
"""为「应用内下载模型」生成 manifest.json。

背景
----
应用要的是 MindSpore Lite 的 `.ms` 文件，而 HuggingFace 上的 parakeet 仓库
只有 ONNX（`istupakov/parakeet-tdt-0.6b-v2-onnx`）或高通 Hexagon 的 QNN 产物
（`runanywhere/*_HNPU`），**都不能直接喂给 MindSpore Lite**。
所以流程必然是：

    你在 Linux 上用 converter_lite 转出 .ms
        → 用本脚本生成 manifest.json
        → 把 .ms 与 manifest.json 一起传到 HuggingFace
        → 把 manifest.json 的地址填进 App 的「设置 → 模型下载」

用法
----
    # 1) 生成清单（同时打印各文件的 SHA-256）
    python tools/gen_download_manifest.py --model-dir ./ms_models \\
        --base-url https://huggingface.co/<你的用户名>/<仓库名>/resolve/main/ \\
        --out manifest.json

    # 2) 打印 HuggingFace 上传命令（需要 huggingface_hub 与登录）
    python tools/gen_download_manifest.py --model-dir ./ms_models \\
        --base-url https://huggingface.co/<你>/<仓库>/resolve/main/ \\
        --out manifest.json --print-upload <你的用户名>/<仓库名>

注意
----
* `--base-url` **必须以 `/` 结尾**。HuggingFace 的文件直链形式是
  `https://huggingface.co/<user>/<repo>/resolve/main/<文件名>`，
  所以 base-url 写到 `resolve/main/` 为止。
* HuggingFace 支持 Range 请求，因此应用的断点续传可用；
  但直链会 302 到 CDN，部分情况下 CDN 端可能忽略 Range ——
  应用里已做兜底（收到 200 就从头重写），不会产生坏文件。
* manifest.json 本身也要放进同一目录，App 才是从它推导各文件地址的。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

# 与 entry/src/main/ets/engine/ParakeetEngine.ets 的契约保持一致
DEFAULT_ENGINE = "tdt"
DEFAULT_MEL_BINS = 128
DEFAULT_FILES = ["encoder.ms", "decoder_joint.ms", "vocab.txt"]


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0
    return "%.1f GB" % n


def sha256_file(path: str, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(
        description="生成应用内下载所需的 manifest.json")
    ap.add_argument("--model-dir", required=True,
                    help="含 .ms 与 vocab.txt 的目录")
    ap.add_argument("--base-url", required=True,
                    help="文件下载基地址，必须以 / 结尾，"
                         "例如 https://huggingface.co/me/parakeet-ms/resolve/main/")
    ap.add_argument("--out", default="manifest.json", help="输出清单路径")
    ap.add_argument("--files", default=",".join(DEFAULT_FILES),
                    help="文件名，逗号分隔（默认 %s）" % ",".join(DEFAULT_FILES))
    ap.add_argument("--model", default="parakeet-tdt-0.6b-v2-int8",
                    help="模型标识，仅用于展示")
    ap.add_argument("--engine", default=DEFAULT_ENGINE,
                    choices=["tdt", "ctc"], help="解码器类型")
    ap.add_argument("--mel-bins", type=int, default=DEFAULT_MEL_BINS,
                    help="mel 特征维度（0.6B v2 是 128，110M 是 80）")
    ap.add_argument("--print-upload", default="",
                    help="传入 <user>/<repo> 时，额外打印 huggingface 上传命令")
    args = ap.parse_args()

    if not os.path.isdir(args.model_dir):
        print("模型目录不存在: %s" % args.model_dir, file=sys.stderr)
        return 1
    if not args.base_url.endswith("/"):
        print("--base-url 必须以 / 结尾，否则文件地址会拼错。\n"
              "  当前: %s\n  应为: %s/" % (args.base_url, args.base_url),
              file=sys.stderr)
        return 1

    names = [s.strip() for s in args.files.split(",") if s.strip()]
    missing = [n for n in names if not os.path.isfile(os.path.join(args.model_dir, n))]
    if missing:
        print("模型目录缺少以下文件：", file=sys.stderr)
        for m in missing:
            print("  %s" % m, file=sys.stderr)
        print("\n目录里现有：%s" % ", ".join(sorted(os.listdir(args.model_dir))),
              file=sys.stderr)
        return 1

    files = []
    total = 0
    print("=" * 74)
    print("计算 SHA-256")
    print("=" * 74)
    for name in names:
        p = os.path.join(args.model_dir, name)
        size = os.path.getsize(p)
        digest = sha256_file(p)
        files.append({"name": name, "size": size, "sha256": digest})
        total += size
        print("  %-24s %12s  %s" % (name, human(size), digest))

    manifest = {
        "version": "1",
        "model": args.model,
        "engine": args.engine,
        "melBins": args.mel_bins,
        "baseUrl": args.base_url,
        "files": files,
    }
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print("-" * 74)
    print("  合计 %s" % human(total))
    print("  清单已写入 %s" % args.out)
    print()
    print("清单地址（填进 App 的「设置 → 模型下载」）：")
    print("  %smanifest.json" % args.base_url)

    if args.print_upload:
        repo = args.print_upload
        print()
        print("=" * 74)
        print("上传到 HuggingFace")
        print("=" * 74)
        print("  pip install -U huggingface_hub")
        print("  huggingface-cli login          # 用你的 HF token")
        print()
        print("  # 创建仓库（若还没有）")
        print("  huggingface-cli repo create %s --repo-type model" % repo.split("/")[-1])
        print()
        print("  # 上传（大文件会自动走 LFS，656 MB 可能需要几十分钟）")
        for name in names:
            print("  huggingface-cli upload %s \"%s\" %s"
                  % (repo, os.path.join(args.model_dir, name), name))
        print("  huggingface-cli upload %s \"%s\" manifest.json" % (repo, args.out))
        print()
        print("  # 上传后可核对 LFS 哈希是否与清单一致：")
        print("  #   https://huggingface.co/api/models/%s?blobs=true" % repo)
        print()
        print("⚠️ 提示：仓库设为 public 才能被 App 直接下载；")
        print("   若为 private，需要在请求里带 token（当前实现未支持，需自行扩展 header）。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
