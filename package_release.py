#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包发行版 zip: 复刻 K-ASS-Editor-1.2.1 的结构(扁平, 无外层目录)。

包含: .gitignore, main.py, asr/(不含 whisper.cpp 运行时与模型), editor/,
      SubFabric.exe(build/ 里的 SEA 单文件启动器, 双击直接开界面, 免装 Node),
      start-editor.bat(老入口, 保留给装了 Node 的用户), start-editor.command
排除: .git / venv / models / asr/whisper.cpp(首次使用自动下载) / projects / videos /
      _test / tests / __pycache__ / node_modules / .workbuddy / build(除 exe 外)

注意: 打包前先 `python build_exe.py`(确保 build/SubFabric.exe 存在) 和
      `node editor/scripts/fetch-vendor.js`(确保 editor/vendor 完整)。
用法: python package_release.py [版本号]   默认 1.3.2
"""
import os, zipfile, sys

VERSION = sys.argv[1] if len(sys.argv) > 1 else '1.3.2'
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, 'K-ASS-Editor-%s.zip' % VERSION)

EXCLUDE_DIRS = {'.git', 'asr/.venv', 'asr/models', 'asr/whisper.cpp', 'asr/runtime-python', 'asr/__pycache__', 'editor/__pycache__',
                'node_modules', 'projects', 'videos', '_test', 'tests', '__pycache__', '.workbuddy', 'build'}
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
        # SEA 单文件启动器(双击 SubFabric.exe 直接开界面; build_exe.py 的产物)
        exe = os.path.join(ROOT, 'build', 'SubFabric.exe')
        if os.path.isfile(exe):
            z.write(exe, 'SubFabric.exe')
            count += 1
        else:
            print('警告: 未找到 build/SubFabric.exe —— 本包用户需要装 Node 才能启动!')
    size = os.path.getsize(OUT)
    print(f'已生成: {OUT}')
    print(f'条目数: {count}  大小: {size/1048576:.1f} MB')


if __name__ == '__main__':
    main()
