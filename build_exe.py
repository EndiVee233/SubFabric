#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建 SubFabric.exe: Node 22 SEA(Single Executable Application)。

产出: build/SubFabric.exe  —— 用户放进发行包根目录双击即用(内嵌 sea-launcher.cjs)。
用法: python build_exe.py
前置: 本机有 Node >= 22(用托管版 22.22.2), 需联网下载 node.exe 二进制(仅首次, 有缓存)。
"""
import json, os, subprocess, sys, hashlib, urllib.request, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(ROOT, 'build')


def find_node_exe():
    """定位 Node 可执行文件(>=22)。
    顺序: 环境变量 SUBFABRIC_NODE → PATH 上的 node → WorkBuddy 托管 Node(取最高版本)
          → 常见安装路径。避免把某台机器的绝对路径写死在仓库里。"""
    env = os.environ.get('SUBFABRIC_NODE')
    if env and os.path.exists(env):
        return env
    which = shutil.which('node')
    if which:
        return which
    base = os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node', 'versions')
    try:
        for v in sorted(os.listdir(base), reverse=True):
            p = os.path.join(base, v, 'node.exe')
            if os.path.exists(p):
                return p
    except Exception:
        pass
    for p in (r'C:\Program Files\nodejs\node.exe', r'C:\Program Files (x86)\nodejs\node.exe'):
        if os.path.exists(p):
            return p
    sys.exit('未找到 node.exe: 请安装 Node >= 22, 或用 SUBFABRIC_NODE 环境变量指定路径')


NODE_EXE = find_node_exe()
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


def patch_gui_subsystem(exe_path):
    """把 PE 子系统从控制台(3)改成 GUI(2): 双击 exe 不再弹出 cmd 窗口。
    Node 官方 SEA 不支持 GUI 子系统, 但只改 PE 头字段即可生效
    (Node 运行时不依赖控制台; sea-launcher.cjs 已把 console 全部静默化)。"""
    import struct
    with open(exe_path, 'rb') as f:
        data = bytearray(f.read())
    e_lfanew = struct.unpack_from('<I', data, 0x3C)[0]
    if bytes(data[e_lfanew:e_lfanew + 4]) != b'PE\x00\x00':
        print('警告: PE 签名异常, 跳过 GUI 子系统修改')
        return
    opt = e_lfanew + 24
    magic = struct.unpack_from('<H', data, opt)[0]
    if magic not in (0x10B, 0x20B):
        print('警告: 未知 Optional Header magic, 跳过 GUI 子系统修改')
        return
    sub_off = opt + 68          # PE32/PE32+ 的 Subsystem 字段都在 OptionalHeader+68
    if struct.unpack_from('<H', data, sub_off)[0] == 2:
        print('已是 GUI 子系统, 无需修改')
        return
    struct.pack_into('<H', data, sub_off, 2)   # IMAGE_SUBSYSTEM_WINDOWS_GUI
    with open(exe_path, 'wb') as f:
        f.write(data)
    print('已切换为 GUI 子系统(双击不再弹出 cmd 窗口):', exe_path)


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
    patch_gui_subsystem(OUT)
    print('完成:', OUT)


if __name__ == '__main__':
    main()
