#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建 SubFabric.exe: Node 22 SEA(Single Executable Application)。

产出: build/SubFabric.exe  —— 用户放进发行包根目录双击即用(内嵌 sea-launcher.cjs)。
用法: python build_exe.py
前置: 本机有 Node >= 22(用托管版 22.22.2), 需联网下载 node.exe 二进制(仅首次, 有缓存)。
"""
import json, os, subprocess, sys, hashlib, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(ROOT, 'build')
NODE_EXE = r'C:\Users\SpokeIsThere\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
LAUNCHER = os.path.join(ROOT, 'editor', 'scripts', 'sea-launcher.cjs')
OUT = os.path.join(BUILD, 'SubFabric.exe')
CACHE = os.path.join(BUILD, 'node-binary.exe')
NODE_VERSION = 'v22.22.2'
NODE_URL = f'https://nodejs.org/dist/{NODE_VERSION}/win-x64/node.exe'


def run(cmd, **kw):
    print('>', ' '.join(cmd))
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        sys.exit(f'命令失败: {cmd}')


def main():
    os.makedirs(BUILD, exist_ok=True)

    # 1. 生成 SEA 配置(节点 22 要求 assets 键值; 入口必须是 cjs)
    cfg = {'main': LAUNCHER, 'output': os.path.join(BUILD, 'sea-prep.blob'),
           'disableExperimentalSEAWarning': True, 'useSnapshot': False, 'useCodeCache': True}
    cfg_path = os.path.join(BUILD, 'sea-config.json')
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)

    # 2. 生成 blob
    run([NODE_EXE, '--experimental-sea-config', cfg_path], cwd=ROOT)

    # 3. 取一份干净的 node.exe 二进制(缓存复用)
    if not os.path.exists(CACHE):
        src = NODE_EXE
        if os.path.exists(src):
            print('复制本机 node.exe 作为底版:', src)
            with open(src, 'rb') as a, open(CACHE, 'wb') as b:
                b.write(a.read())
        else:
            print('下载 node.exe:', NODE_URL)
            urllib.request.urlretrieve(NODE_URL, CACHE)

    # 4. 复制底版 → 输出名, 注入 blob
    with open(CACHE, 'rb') as a, open(OUT, 'wb') as b:
        b.write(a.read())
    run([NODE_EXE, '-e',
         "require('node:fs').copyFileSync(process.argv[1], process.argv[1]);"
         "const {inject} = require('node:module').flags ? {} : {};"], cwd=ROOT) if False else None
    postject = None
    # postject 是官方 SEA 注入工具; node 自带 npx 可能没有, 直接用 node_modules 里缓存的
    # 简化: 用 npx postject(首次联网装)
    run([NODE_EXE, os.path.join(ROOT, 'editor', 'scripts', 'inject_postject.mjs'), OUT,
         os.path.join(BUILD, 'sea-prep.blob')], cwd=ROOT)
    print('完成:', OUT)


if __name__ == '__main__':
    main()
