"""干净实验：同一段语音，「有前文」vs「无前文」——只变这一个变量。

为什么重做：上一版拿"整段重跑"当基线，但重跑得到 696 段而原稿 870 段，
两套切分边界完全不同，"区间内词数"根本不可比（数出来 92 vs 15 是无意义的）。
必须控制变量：**同一段音频、同一台模型、只改起点前面有没有真实语音**。

做法（对每个样本）：
  1. 从原稿取一个"语法不完整"的句子 S，区间 [a, b]
  2. 切 X = [a, b]              —— 无前文（S 在音频最开头）
  3. 切 Y = [a - lead, b]       —— 有前文（前面接 lead 秒真实语音）
  4. 各自跑 worker，看 S 是否被正确转写、词数是否更接近真实语速

判据：
  · 若 Y 的词数明显多于 X（且更接近 2.5 词/秒）→ **前文确实能救回丢词** → 机制成立
  · 若 X ≈ Y → 前文无用，机制无价值（回到"分段问题"假设）
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
TMP = os.path.join(os.environ.get("TEMP", "."), "ctx_probe")
SR = 16000
LEAD = 3.0          # 前文长度（秒）


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


def run(wav, tag):
    out = os.path.join(TMP, tag + ".json")
    if os.path.exists(out):
        os.remove(out)
    subprocess.run([PY, "-u", WORKER, "--model", MODEL, "--audio", wav,
                    "--out", out, "--provider", "npu", "--tta", "0"],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(out):
        return None
    return json.load(io.open(out, encoding="utf-8"))


def norm(s):
    import re
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).split()


def main() -> int:
    os.makedirs(TMP, exist_ok=True)
    asr = json.load(io.open(os.path.join(PROJ, "asr.json"), encoding="utf-8"))
    segs = asr["segments"]
    src = os.path.join(PROJ, "audio.wav")
    full = load(src)

    END = (".", "?", "!", "。", "？", "！", "…")
    cand = [i for i, s in enumerate(segs)
            if not s["text"].strip().endswith(END)
            and (s["end"] - s["start"]) >= 1.0
            and len(s.get("words") or []) >= 6]
    step = max(1, len(cand) // 5)
    sample = cand[::step][:5]
    print("样本: %s   （前文取 %.1f 秒）" % (sample, LEAD))
    print()

    tot_x = tot_y = 0
    for i in sample:
        s = segs[i]
        a, b = s["start"], s["end"]
        owords = len(s.get("words") or [])
        dur = b - a
        print("#%d  [%.2f-%.2f] %.2fs  原稿 %d 词 (%.2f 词/秒)" % (
            i, a, b, dur, owords, owords / dur if dur else 0))
        print("     原文: %s" % s["text"][:74])

        # X: 无前文
        xa = max(0, int(a * SR)); xb = min(len(full), int(b * SR))
        wx = os.path.join(TMP, "x%d.wav" % i); save(wx, full[xa:xb])
        dx = run(wx, "x%d" % i)
        # Y: 有前文
        ya = max(0, int((a - LEAD) * SR)); yb = xb
        wy = os.path.join(TMP, "y%d.wav" % i); save(wy, full[ya:yb])
        dy = run(wy, "y%d" % i)

        def report(tag, d, lead):
            if d is None:
                print("     %s: 失败" % tag); return 0, ""
            ss = d.get("segments") or []
            txt = " ".join(x["text"] for x in ss)
            return len(norm(txt)), txt

        nx, tx = report("X 无前文", dx, 0)
        ny, ty = report("Y 有前文", dy, LEAD)
        tot_x += nx; tot_y += ny
        print("     X 无前文 %3d 词: %s" % (nx, tx[:74]))
        print("     Y 有前文 %3d 词: %s" % (ny, ty[:74]))
        # Y 的总词含前文那几个词，粗略减去前文占比
        print("     -> Y/X = %.2f" % (ny / nx if nx else 0))
        print()

    print("合计：无前文 %d 词，有前文 %d 词（后者含前文内容）" % (tot_x, tot_y))
    return 0


if __name__ == "__main__":
    sys.exit(main())
