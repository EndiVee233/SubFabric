#!/usr/bin/env python3
"""把 Parakeet 模型内置进 HAP（或移除）。

原理：hvigor 会把 `entry/src/main/resources/rawfile/` 下的所有文件原样打包进 HAP。
所以「内置模型」= 把这几个文件放进那个目录，并生成一份带 SHA-256 的清单。

用法
----
    # 查看当前状态（默认动作）
    python tools/embed_model.py

    # 内置模型：生成 manifest.json + 复制进 rawfile
    python tools/embed_model.py add --model-dir D:\\path\\to\\ms_models

    # 移除内置模型（rawfile 清空，HAP 回到几百 KB）
    python tools/embed_model.py remove

    # 自定义文件名（默认 encoder.ms / decoder_joint.ms / vocab.txt）
    python tools/embed_model.py add --model-dir ... --files encoder.ms,decoder_joint.ms,vocab.txt

为什么用脚本而不是手工拷贝
--------------------------
1. 656 MB 的手工拷贝容易半途失败留下坏文件，而 MindSpore Lite 对坏模型的
   报错毫无指向性 —— 所以这里**强制**生成 SHA-256，App 侧解包后会校验。
2. 需要顺手给出包体积预估和磁盘占用提示，避免「装完发现占 1.3 GB」。
3. 模型不该进版本库：本脚本可随时 remove，工程回到轻量状态。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAWFILE_DIR = os.path.join(PROJECT, "entry", "src", "main", "resources",
                           "rawfile", "parakeet")
MANIFEST = os.path.join(RAWFILE_DIR, "manifest.json")

DEFAULT_FILES = ["encoder.ms", "decoder_joint.ms", "vocab.txt"]

# 与 entry/src/main/ets/engine/ParakeetEngine.ets 保持一致的契约
ENGINE = "tdt"
MEL_BINS = 128


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0
    return "%.1f GB" % n


def sha256_file(path: str, chunk: int = 4 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def status() -> int:
    print("=" * 72)
    print("内置模型状态")
    print("=" * 72)
    print("rawfile 目录: %s" % RAWFILE_DIR)
    if not os.path.isdir(RAWFILE_DIR):
        print("  （不存在 —— 当前 HAP 不内置模型）")
        return 0

    entries = sorted(os.listdir(RAWFILE_DIR))
    if not entries:
        print("  （空 —— 当前 HAP 不内置模型）")
        return 0

    total = 0
    for name in entries:
        p = os.path.join(RAWFILE_DIR, name)
        if os.path.isfile(p):
            total += os.path.getsize(p)
            print("  %-28s %12s" % (name, human(os.path.getsize(p))))

    print("-" * 72)
    print("  %-28s %12s" % ("合计（HAP 增量）", human(total)))
    print()
    print("  安装后占用提示：HAP 内 %s + 解包后 %s ≈ %s"
          % (human(total), human(total), human(total * 2)))
    print("  （首启会把模型从 rawfile 解包到 files 目录，两份会同时存在）")
    return 0


def remove() -> int:
    if os.path.isdir(RAWFILE_DIR):
        shutil.rmtree(RAWFILE_DIR)
        print("已移除内置模型目录: %s" % RAWFILE_DIR)
    else:
        print("内置模型目录本来就不存在，无需移除")
    print("提示：重新构建后 HAP 会回到几百 KB 量级。")
    return 0


def add(model_dir: str, files: list[str]) -> int:
    if not os.path.isdir(model_dir):
        print("模型目录不存在: %s" % model_dir, file=sys.stderr)
        return 1

    missing = [f for f in files if not os.path.isfile(os.path.join(model_dir, f))]
    if missing:
        print("模型目录缺少以下文件：", file=sys.stderr)
        for m in missing:
            print("  %s" % m, file=sys.stderr)
        print("\n目录里现有：%s" % ", ".join(sorted(os.listdir(model_dir))),
              file=sys.stderr)
        return 1

    os.makedirs(RAWFILE_DIR, exist_ok=True)

    manifest_files = []
    total = 0
    print("=" * 72)
    print("内置模型：复制 + 计算 SHA-256")
    print("=" * 72)

    for name in files:
        src = os.path.join(model_dir, name)
        dst = os.path.join(RAWFILE_DIR, name)
        size = os.path.getsize(src)
        print("  %-24s %10s  计算校验和…" % (name, human(size)), end="", flush=True)
        digest = sha256_file(src)
        shutil.copyfile(src, dst)
        manifest_files.append({"name": name, "size": size, "sha256": digest})
        total += size
        print("\r  %-24s %10s  %s" % (name, human(size), digest[:16] + "…"))

    manifest = {
        "model": "parakeet-tdt-0.6b-v2",
        "engine": ENGINE,
        "melBins": MEL_BINS,
        "files": manifest_files,
    }
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print("-" * 72)
    print("  合计 %s" % human(total))
    print("  清单已写入 %s" % MANIFEST)
    print()
    print("下一步：直接构建，hvigor 会把 rawfile 打进 HAP：")
    print("  hvigorw --mode module -p product=default -p module=entry@default "
          "assembleHap --no-daemon")
    print()
    print("⚠️ 提醒")
    print("  1. HAP 会增大到约 %s，安装与更新都会明显变慢。" % human(total + 700 * 1024))
    print("  2. 首次启动会解包一份到 files 目录，**设备上会同时占两份**。")
    print("  3. 模型文件不要提交到版本库；用 `remove` 可随时还原。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="把 Parakeet 模型内置进 HAP")
    sub = ap.add_subparsers(dest="cmd")

    p_add = sub.add_parser("add", help="内置模型")
    p_add.add_argument("--model-dir", required=True,
                       help="含 .ms 与 vocab.txt 的目录")
    p_add.add_argument("--files", default=",".join(DEFAULT_FILES),
                       help="要内置的文件名，逗号分隔（默认 %s）"
                            % ",".join(DEFAULT_FILES))

    sub.add_parser("remove", help="移除内置模型")
    sub.add_parser("status", help="查看当前状态（默认）")

    args = ap.parse_args()
    if args.cmd == "add":
        return add(args.model_dir, [s.strip() for s in args.files.split(",") if s.strip()])
    if args.cmd == "remove":
        return remove()
    return status()


if __name__ == "__main__":
    sys.exit(main())
