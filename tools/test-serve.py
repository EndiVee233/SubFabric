#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证常驻服务模式：模型只加载一次，第二次识别显著更快。

这是"消掉进程启动+运行时导入开销"这件事的直接检验：
    冷启动一次识别 = 进程启动 + 运行时导入 + 模型加载 + 推理
    常驻后每次识别 = 推理
两者之差就是这笔固定开销，也就是常驻服务能省下的部分。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

WS = r"C:\Users\Terry\Documents\deepseek-harness\default-workspace"
REPO = r"D:\SubFabric-fork"
PY = r"D:\SubFabric\SubFabric\asr\runtime-python\python.exe"
WAV = os.path.join(WS, ".staging", "samples", "sample-clean.wav")
MODELS = os.path.join(REPO, "asr", "models")


def cold_once(script, model, extra):
    """冷启动一次：走原来的 --audio/--out 路径。"""
    out = os.path.join(WS, ".staging", "_cold.json")
    if os.path.exists(out):
        os.remove(out)
    t0 = time.time()
    r = subprocess.run([PY, script, "--model", model, "--audio", WAV, "--out", out] + extra,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=REPO)
    dt = time.time() - t0
    ok = r.returncode == 0 and os.path.exists(out)
    return dt, ok, (r.stderr or "")


def serve_test(name, script, model, extra):
    """常驻两次，看第二次比冷启动快多少。"""
    print(f"── {name}")
    cold, ok, err = cold_once(script, model, extra)
    print(f"   冷启动一次（含进程+导入+加载）: {cold:.2f}s  {'成功' if ok else '失败'}")
    if not ok:
        print(f"      错误: {err.strip().splitlines()[-1][:150] if err.strip() else '(无)'}")
        return None

    proc = subprocess.Popen([PY, script, "--model", model, "--serve"] + extra,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            errors="replace", bufsize=1, cwd=REPO)
    t0 = time.time()
    ready = None
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") == "ready":
            ready = obj
            break
    startup = time.time() - t0
    if ready is None:
        print("   ✗ 没收到 ready")
        proc.kill()
        return None
    print(f"   常驻启动（进程+导入+加载）: {startup:.2f}s")

    times = []
    for i in range(3):
        t1 = time.time()
        proc.stdin.write(json.dumps({"cmd": "transcribe", "id": i, "audio": WAV,
                                     "tta": 0}) + "\n")
        proc.stdin.flush()
        res = None
        while True:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") in ("ok", "error") and obj.get("id") == i:
                res = obj
                break
        dt = time.time() - t1
        times.append(dt)
        if res and res.get("type") == "ok":
            print(f"   第 {i + 1} 次识别: {dt:.2f}s   {len(res['segments'])} 行  "
                  f"首行: {res['segments'][0]['text'][:50]}")
        else:
            print(f"   第 {i + 1} 次识别: {dt:.2f}s   失败: {(res or {}).get('msg')}")
    proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
    proc.stdin.flush()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()

    if times:
        saved = cold - times[0]
        print(f"   → 冷启动 {cold:.2f}s  vs  常驻后续 {times[0]:.2f}s  "
              f"= 每次省 {saved:.2f}s（{saved / cold * 100:.0f}%）")
    print()
    return {"cold": cold, "first": times[0] if times else None, "startup": startup}


def main() -> int:
    serve_test("NPU（OpenVINO）", os.path.join("asr", "asr_npu.py"),
               os.path.join(MODELS, "parakeet-tdt-0.6b-v2-npu"),
               ["--provider", "npu", "--tta", "0"])
    serve_test("GPU（sherpa-onnx / CUDA）", os.path.join("asr", "asr.py"),
               os.path.join(MODELS, "parakeet-tdt-0.6b-v2"),
               ["--provider", "cuda", "--threads", "4"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
