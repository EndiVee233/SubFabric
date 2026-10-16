#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成托盘图标 editor/scripts/tray.ico(多尺寸) —— 直接取自应用图标, 不再另画一套。

应用图标源: build/installer/logo.png —— 与安装向导、程序本体(SubFabric.exe)、
浏览器页签(/favicon.ico)用的是同一张图。换图标只需替换 logo.png, 再重跑本脚本
与 gen_app_icon.py(或直接跑 build_exe.py, 它会按 mtime 自动刷新 logo.ico)。

用法: python gen_tray_icon.py [源PNG]
      (产物写到同目录 tray.ico, 并留一张 256px 预览 tray-preview.png)

要点:
  · 保留 alpha 通道, 不做背景填充 —— 浅色/深色任务栏都不出现黑边。
  · 逐尺寸 LANCZOS 重采样(直接 save(sizes=...) 用 NEAREST, 边缘会崩)。
  · 依赖 Pillow(托管 venv 里装: pip install Pillow)。
"""
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit('缺少 Pillow：请先 pip install Pillow')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))          # 仓库根
DEFAULT_SRC = os.path.join(ROOT, 'build', 'installer', 'logo.png')
OUT_ICO = os.path.join(HERE, 'tray.ico')
OUT_PNG = os.path.join(HERE, 'tray-preview.png')
# 托盘/任务栏/通知区各自会挑合适的一档; 20px 是 Windows 通知区的常见档位
SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main():
    src = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(src):
        sys.exit('找不到源图: ' + src)

    img = Image.open(src).convert('RGBA')
    print('源图: %s  %dx%d' % (src, img.width, img.height))

    frames = [img.resize(s, Image.LANCZOS) for s in SIZES]
    frames[-1].save(OUT_ICO, format='ICO', sizes=SIZES, append_images=frames[:-1])
    frames[-1].save(OUT_PNG)
    print('已生成:', OUT_ICO, os.path.getsize(OUT_ICO), 'bytes')
    print('预览:', OUT_PNG)


if __name__ == '__main__':
    main()
