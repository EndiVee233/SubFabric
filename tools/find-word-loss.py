"""定位「原稿丢词 42%」的成因：是解码窗口合并丢的，还是别处丢的？

已测事实（25.29 秒区间 [15.08, 40.37]）：
  · 原始 asr.json：36 词 → 1.42 词/秒（远低于正常语速，说明丢了内容）
  · 合并重识别：  62 词 → 2.45 词/秒（正常）
  · 只在合并后出现的词包含 "but before we begin you need to understand that"、
    "the entire series from start to finish"、"even if you've been watching ... for years"
    → 整句整句地漏

关键线索：该区间**跨过了 15.01 秒的编码器窗口边界**。
原始识别是整段 25 分钟音频喂给 worker 的，worker 内部按 15.01s 滑窗 + 重叠区解码，
再在 `_decode_windows` 里做「时间门 + 标点去重 + 最长后缀/前缀重叠」把窗口拼起来。
**嫌疑就是这一步的合并策略**：重叠区判重判过头，把真实内容当重复丢掉了。

本脚本做对照实验：
  A) 跑 25.29 秒的整段音频（与原始识别同样的调用方式）→ 看词数
  B) 跑 15 秒整（不跨界，单窗口）        → 看词数
  C) 跑 13.3 秒（原始那句的时间区间）    → 看词数
若 A ≈ 36 而 B/C ≈ 62，说明**跨界合并**就是丢词的原因。
"""

from __future__ import annotations

import array
import io
import json
import os
import subprocess
import sys
import wave

PY = r"D:\SubFabric\SubFabric\asr\runtime-python\python.exe"
WORKER = r"D:\SubFabric-fork\asr\asr_npu.py"
MODEL = r"D:\SubFabric-fork\asr\models\parakeet-tdt-0.6b-v2-npu"
PROJ = r"D:\SubFabric-fork\projects\p-muz7axuw-f0bdc"
TMP = os.path.join(os.environ.get("TEMP", "."), "merge_probe")
SR = 16000


def load(path):
    with wave.open(path, "rb") as w:
        n, ch = w.getnframes(), w.getnchannels()
        raw = w.readframes(n)
    a = array.array("h")
    a.frombytes(raw)
    if ch > 1:
        a = array.array("h", [a[i] for i in range(0, len(a), ch)])
    return a


def save(path, a):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(a.tobytes())


def cut(src, dst, t0, t1):
    a = load(src)
    i0, i1 = max(0, int(t0 * SR)), min(len(a), int(t1 * SR))
    save(dst, a[i0:i1])
    return (i1 - i0) / SR


def run(wav, tag, tta=0):
    out = os.path.join(TMP, tag + ".json")
    if os.path.exists(out):
        os.remove(out)
    p = subprocess.run([PY, "-u", WORKER, "--model", MODEL, "--audio", wav,
                        "--out", out, "--provider", "npu", "--tta", str(tta)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(out):
        return None, (p.stdout or "")[-200:] + (p.stderr or "")[-300:]
    d = json.load(io.open(out, encoding="utf-8"))
    return d, ""


def main() -> int:
    os.makedirs(TMP, exist_ok=True)
    src = os.path.join(PROJ, "audio.wav")

    cases = [
        ("A_25s", 15.08, 40.37, "整段 25.29s（跨 15.01s 窗口边界）"),
        ("B_15s", 15.08, 30.08, "前 15s（刚好一个窗口内）"),
        ("C_13s", 15.08, 28.38, "原始那句的区间 13.30s（不跨界）"),
        ("D_10s", 27.00, 37.00, "跨边界附近的 10s（28.38 落在中间）"),
    ]
    print("项目音频: %s" % src)
    print()
    for tag, t0, t1, desc in cases:
        w = os.path.join(TMP, tag + ".wav")
        dur = cut(src, w, t0, t1)
        d, err = run(w, tag)
        if d is None:
            print("  %-6s %5.2fs  %-38s 失败: %s" % (tag, dur, desc, err[-120:]))
            continue
        segs = d.get("segments") or []
        words = sum(len(s.get("words") or []) for s in segs)
        rate = words / dur if dur > 0 else 0
        print("  %-6s %5.2fs  %-38s %3d 段 %4d 词  %.2f 词/秒" % (
            tag, dur, desc, len(segs), words, rate))
        for s in segs:
            print("           [%6.2f-%6.2f] %s" % (s["start"], s["end"], s["text"][:70]))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
