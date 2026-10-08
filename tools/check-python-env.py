"""按 SubFabric 的探测逻辑，逐个解释"识别模型环境检测"的结果。

为什么要这个：用户点识别模型 → 环境检测报"Python 环境没装好"，但界面只给一句结论，
不告诉你**是哪个 Python、缺哪个包**。这个脚本把 server.js 的 resolvePython() 与
probePython() 的逻辑原样跑一遍，把每一步的结果摆出来。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

REPO = os.environ.get("SUBFABRIC_REPO") or r"D:\SubFabric-fork"
ASR_DIR = os.path.join(REPO, "asr")


def resolve_python() -> tuple[str, str]:
    """复刻 server.js 的 resolvePython()：环境变量 > settings.json 的 pythonExe > 自带运行时。

    ⚠ settings.json 那一级不能漏：用户是双击 vbs 启动的，环境变量传不进去，
    "运行时装在别处"只能靠 settings.json 记。漏了就会报出一个**没在用的**解释器，
    诊断结论完全相反（踩过：报"内置 runtime-python 两个引擎都就绪"，而实际用的那份
    没有 NeMo、内置那份没有 openvino）。
    """
    env = os.environ.get("ASR_PYTHON")
    if env:
        return env, "环境变量 ASR_PYTHON"
    try:
        with open(os.path.join(ASR_DIR, "settings.json"), encoding="utf-8") as fh:
            custom = str((json.load(fh) or {}).get("pythonExe") or "").strip()
        if custom and os.path.isfile(custom):
            return custom, "settings.json 的 pythonExe（界面里「指定其他 Python…」设的）"
    except Exception:  # noqa: BLE001
        pass
    for cand, why in (
        (os.path.join(ASR_DIR, ".venv", "Scripts", "python.exe"), "asr/.venv (Windows)"),
        (os.path.join(ASR_DIR, ".venv", "bin", "python"), "asr/.venv (POSIX)"),
        (os.path.join(ASR_DIR, "runtime-python", "python.exe"), "自带 runtime-python"),
    ):
        if os.path.exists(cand):
            return cand, why
    return "python", "PATH 里的 python（兜底）"


def probe(py: str, engine: str) -> dict:
    """复刻 server.js 的 probePython()。"""
    if engine == "openvino":
        code = ('import sys; import openvino; import numpy; '
                'print(sys.version.split()[0] + " / openvino " + str(openvino.__version__))')
    else:
        code = ('import sys; import sherpa_onnx; import numpy; '
                'print(sys.version.split()[0] + " / sherpa-onnx " '
                '+ str(getattr(sherpa_onnx, "__version__", "?")))')
    try:
        r = subprocess.run([py, "-c", code], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
    except FileNotFoundError:
        return {"ok": False, "msg": "找不到解释器（Windows 上常见于只有 Microsoft Store 占位程序）"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "msg": "探测超时（10s+）"}
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    if r.returncode == 0 and out:
        return {"ok": True, "msg": out.splitlines()[-1]}
    return {"ok": False, "msg": (err.splitlines()[-1] if err else f"退出码 {r.returncode}")}


def main() -> int:
    py, why = resolve_python()
    print(f"仓库: {REPO}")
    print(f"ASR_PYTHON 环境变量: {os.environ.get('ASR_PYTHON') or '(未设置)'}")
    print(f"→ 解析到的解释器: {py}")
    print(f"  依据: {why}")
    print(f"  存在: {os.path.exists(py) if os.sep in py else '(交给 PATH 解析)'}")

    if os.sep in py and not os.path.exists(py):
        print("  ✗ 解释器不存在 —— 环境检测必然失败")
        return 1

    print("\n=== 按引擎分别探测（与点识别模型时的行为一致）===")
    bad = 0
    for engine, label in (("sherpa", "Parakeet（sherpa-onnx / CUDA）"),
                          ("openvino", "Parakeet（Intel NPU / OpenVINO）")):
        r = probe(py, engine)
        mark = "✓" if r["ok"] else "✗"
        print(f"  {mark} {label}")
        print(f"      {r['msg']}")
        if not r["ok"]:
            bad += 1

    # NeMo 运行时（只有 multitalker 多说话人模型要）—— 单独探，因为它依赖 torch，很容易被忽略
    print("\n=== NeMo 运行时（多说话人模型专用）===")
    try:
        r = subprocess.run(
            [py, "-c", "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); "
                       "import nemo.collections.asr; print('nemo OK')"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        out = (r.stdout or "").strip()
        if r.returncode == 0 and "nemo OK" in out:
            print("  ✓ " + " / ".join(out.splitlines()))
        else:
            bad += 1
            tail = ((r.stderr or "").strip().splitlines() or ["(无输出)"])[-1]
            print(f"  ✗ 缺 NeMo 运行时（多说话人模型用不了）")
            print(f"      {tail}")
            print(f"      装法：{py} -m pip install torch --index-url https://download.pytorch.org/whl/cu126")
            print(f"            {py} -m pip install nemo_toolkit[asr]")
    except Exception as exc:  # noqa: BLE001
        bad += 1
        print(f"  ✗ 探测失败: {exc}")

    print("\n=== 诊断建议 ===")
    if bad == 0:
        print("  Python 环境、两个 ASR 引擎、NeMo 运行时都就绪。")
    else:
        print(f"  有 {bad} 项不满足。缺哪个包装哪个：")
        print(f"    {py} -m pip install openvino        # NPU 引擎需要")
        print(f"    {py} -m pip install sherpa-onnx     # CUDA 引擎需要")
        print(f"    {py} -m pip install torch --index-url https://download.pytorch.org/whl/cu126   # NeMo 需要")
        print(f"    {py} -m pip install nemo_toolkit[asr]")
        print("  或换一个已经装好的解释器：界面「全局设置 → 模型管理 → 指定其他 Python…」")
        print("     （等价于在 asr/settings.json 里写 pythonExe，或设环境变量 ASR_PYTHON）")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
