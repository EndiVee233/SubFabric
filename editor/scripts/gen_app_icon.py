#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一张 PNG 转成 Windows 多尺寸 .ico（安装包图标 + 程序图标）。

用法:
    python editor/scripts/gen_app_icon.py [源PNG] [输出ICO]

默认: 源 build/installer/logo.png → 输出 build/installer/logo.ico
尺寸: 16 / 24 / 32 / 48 / 64 / 128 / 256（Windows 资源管理器、任务栏、
      开始菜单快捷方式、Inno 安装向导各自会挑合适的一档）。

要点:
  · 源图比目标尺寸小的时候用 LANCZOS 放大，边缘比 NEAREST 干净；
    源图更大时同样 LANCZOS 缩小，避免锯齿。
  · 统一保留 alpha 通道（原图是什么就带什么），不做背景填充 ——
    否则浅色任务栏上会出现一圈黑边。
  · 依赖 Pillow（托管 venv 里装：pip install Pillow）。
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
DEFAULT_OUT = os.path.join(ROOT, 'build', 'installer', 'logo.ico')
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main():
    src = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    out = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    if not os.path.exists(src):
        sys.exit('找不到源图: ' + src)

    img = Image.open(src).convert('RGBA')
    print('源图: %s  %dx%d' % (src, img.width, img.height))

    # 逐尺寸重采样再交给 Pillow 打包（直接 save(sizes=...) 用的是 NEAREST，边缘会崩）
    frames = []
    for s in SIZES:
        frames.append(img.resize((s, s), Image.LANCZOS))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    frames[-1].save(out, format='ICO', sizes=[(s, s) for s in SIZES],
                    append_images=frames[:-1])
    print('已生成: %s  (%s, %d 字节)'
          % (out, ' / '.join('%dpx' % s for s in SIZES), os.path.getsize(out)))


if __name__ == '__main__':
    main()
