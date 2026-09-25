#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包发行版 zip: 复刻 K-ASS-Editor-1.2.1 的结构(扁平, 无外层目录)。

包含: .gitignore, main.py, asr/, editor/, start-editor.bat, start-editor.command
排除: .git / venv / models / projects / _test / tests / __pycache__ / *.pyc / node_modules / .workbuddy

注意: 打包前先跑 `node editor/scripts/fetch-vendor.js`, 确保 editor/vendor 完整(否则对方渲染不了字幕)。
用法: python package_release.py [版本号]   默认 1.2.4
"""
import os, zipfile, sys

VERSION = sys.argv[1] if len(sys.argv) > 1 else '1.2.4'
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'K-ASS-Editor-%s.zip' % VERSION)

EXCLUDE_DIRS = {'.git', 'asr/.venv', 'asr/models', 'asr/__pycache__', 'editor/__pycache__',
                'node_modules', 'projects', '_test', 'tests', '__pycache__', '.workbuddy'}
EXCLUDE_FILES = {'asr/settings.json', '.DS_Store', 'Thumbs.db', 'desktop.ini'}
EXCLUDE_EXT = {'.pyc'}

INCLUDE_TOP = ['.gitignore', 'main.py', 'asr', 'editor']

BAT = ('@echo off\r\n'
       'cd /d "%~dp0editor"\r\n'
       'rem 先清掉可能还占着 8321 的旧实例, 免得浏览器连到旧服务看到旧界面/卡在"读取中"\r\n'
       'for /f "tokens=5" %%p in (\'netstat -ano ^| findstr ":8321" ^| findstr LISTENING\') do taskkill /F /PID %%p >nul 2>&1\r\n'
       'start "" http://127.0.0.1:8321/\r\n'
       'node server.js\r\n'
       'pause\r\n')
CMD = ('#!/bin/bash\n'
       'cd "$(dirname "$0")/editor"\n'
       '# 先清掉可能还占着 8321 的旧实例\n'
       'lsof -ti tcp:8321 2>/dev/null | xargs -r kill 2>/dev/null\n'
       '(open http://127.0.0.1:8321/ 2>/dev/null || xdg-open http://127.0.0.1:8321/ 2>/dev/null) &\n'
       'node server.js\n')


def keep(p):
    p = p.replace('\\', '/')
    if p in EXCLUDE_FILES:
        return False
    parts = p.split('/')
    for i in range(len(parts)):
        prefix = '/'.join(parts[:i + 1])
        if prefix in EXCLUDE_DIRS:
            return False
    if os.path.splitext(p)[1].lower() in EXCLUDE_EXT:
        return False
    return True


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    count = 0
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for top in INCLUDE_TOP:
            full = os.path.join(ROOT, top)
            if os.path.isdir(full):
                for dirpath, dirs, files in os.walk(full):
                    rel = os.path.relpath(dirpath, ROOT).replace('\\', '/')
                    if rel in EXCLUDE_DIRS or any(
                            ('/'.join(rel.split('/')[:i + 1])) in EXCLUDE_DIRS
                            for i in range(len(rel.split('/')))):
                        dirs[:] = []
                        continue
                    for f in files:
                        fp = os.path.join(dirpath, f)
                        relf = os.path.relpath(fp, ROOT).replace('\\', '/')
                        if keep(relf):
                            z.write(fp, relf)
                            count += 1
            elif os.path.isfile(full) and keep(top):
                z.write(full, top)
                count += 1
        # 启动脚本(打包产物, 不在仓库)
        z.writestr('start-editor.bat', BAT)
        z.writestr('start-editor.command', CMD)
        count += 2
    size = os.path.getsize(OUT)
    print(f'已生成: {OUT}')
    print(f'条目数: {count}  大小: {size/1048576:.1f} MB')


if __name__ == '__main__':
    main()
