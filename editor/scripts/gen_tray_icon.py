#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成托盘图标 editor/scripts/tray.ico(多尺寸)。

设计: 品牌紫圆角方块 + 两条白色字幕条(上长下短) + 橙色逐词高亮块 ——
不依赖任何字体, 16x16 缩到最小也是"两行字幕"的形状, 不会糊成一团。
用法: python gen_tray_icon.py        (产物写到同目录 tray.ico, 并留一张 256px 预览 png)
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_ICO = os.path.join(HERE, 'tray.ico')
OUT_PNG = os.path.join(HERE, 'tray-preview.png')

BRAND = (109, 94, 252, 255)      # #6d5efc, 与站点 favicon 同色
WHITE = (255, 255, 255, 255)
HL = (255, 176, 46, 255)         # 逐词高亮橙 #ffb02e

S = 512                          # 先画大图再缩, 边缘更干净
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BRAND)

# 两条字幕条: 上长下短, 像双语字幕
bar_h = int(S * 0.145)
top_y = int(S * 0.30)
bot_y = int(S * 0.55)
d.rounded_rectangle([int(S * 0.16), top_y, int(S * 0.84), top_y + bar_h],
                    radius=bar_h // 2, fill=WHITE)
d.rounded_rectangle([int(S * 0.16), bot_y, int(S * 0.66), bot_y + bar_h],
                    radius=bar_h // 2, fill=WHITE)
# 下条右侧一小段"逐词高亮"(与白条留一道缝, 缩到 16px 也是清楚的一段橙)
hl_x0 = int(S * 0.72)
hl_x1 = int(S * 0.88)
d.rounded_rectangle([hl_x0, bot_y, hl_x1, bot_y + bar_h], radius=bar_h // 2, fill=HL)

img.resize((256, 256), Image.LANCZOS).save(OUT_PNG)
img.save(OUT_ICO, sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('已生成:', OUT_ICO, os.path.getsize(OUT_ICO), 'bytes')
print('预览:', OUT_PNG)
