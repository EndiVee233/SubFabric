"""稳定复现「11.7 秒空段 + 拼接文本」这个确定性 bug。

已定位的机制（读源码）：
  asr_npu.py 的 refine_word_ends() 里：
      nxt = words[i+1]["start"] if i+1 < len(words) else total_sec
      if nxt - anchor <= MAX_PAUSE:  end = nxt
  句内**最后一个词**没有下一个词可参照，end 直接取 total_sec（整段音频末尾）。
  若该词后面是一大段静音/音乐，它就被拉伸成"超长词"。

文本侧的「first......'arc.」形态来自 _tokens_to_words() 把两个 token 拼成一个词
（没有 ▁ 边界）。两者叠加就得到"11.7 秒 + 拼接文本 + 1 个词"的观感。

本脚本用真实音频复现，并把每一环的证据打印出来，供修复后对照。
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
TMP = os.path.join(os.environ.get("TEMP", "."), "splice_probe")
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


def run(wav, tag, tta=0):
    out = os.path.join(TMP, tag + ".json")
    if os.path.exists(out):
        os.remove(out)
    subprocess.run([PY, "-u", WORKER, "--model", MODEL, "--audio", wav, "--out", out,
                    "--provider", "npu", "--tta", str(tta)],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(out):
        return None
    return json.load(io.open(out, encoding="utf-8"))


def energy_profile(a, t0, t1):
    """打印 [t0,t1] 区间的能量概况，看末尾是否有长静音（超长词的成因）"""
    import numpy as np
    arr = np.asarray(a, dtype=np.float32) / 32768.0
    seg = arr[int(t0 * SR):int(t1 * SR)]
    if len(seg) < SR // 10:
        return
    hop = SR // 100
    n = len(seg) // hop
    e = np.sqrt(np.mean(seg[:n * hop].reshape(n, hop) ** 2, axis=1))
    thr = max(float(np.percentile(e, 30)) * 2.0, float(e.max()) * 0.10, 1e-4)
    # 从末尾往前找最后的"有声"位置
    above = np.nonzero(e > thr)[0]
    if len(above):
        last = above[-1] / 100.0
        print("      [能量] 区间 %.2f~%.2f，最后有声位置 %.2f（末尾静音 %.2f 秒）"
              % (t0, t1, t0 + last, (t1 - t0) - last))


def main() -> int:
    os.makedirs(TMP, exist_ok=True)
    src = os.path.join(PROJ, "audio.wav")
    full = load(src)

    # 原始 asr.json 里 #5/#6 那对：28.38-28.52（5 词）+ 28.52-40.37（1 词, 11.85s）
    cases = [
        ("s1", 15.08, 40.37, "含 #5/#6 的区间（原 25.29s）"),
        ("s2", 27.00, 40.37, "#5 起点到音频尾（13.37s）"),
    ]
    for tag, t0, t1, desc in cases:
        print("=== %s  [%.2f-%.2f] %.2fs  %s" % (tag, t0, t1, t1 - t0, desc))
        ia, ib = int(t0 * SR), min(len(full), int(t1 * SR))
        w = os.path.join(TMP, tag + ".wav")
        save(w, full[ia:ib])
        energy_profile(full, t0, t1)
        d = run(w, tag)
        if d is None:
            print("     失败")
            continue
        dur = d.get("duration")
        print("     worker duration=%.2f" % (dur or -1))
        for s in (d.get("segments") or []):
            ws = s.get("words") or []
            sd = s["end"] - s["start"]
            print("       [%6.2f-%6.2f] %5.2fs %2d 词  %s" % (
                s["start"], s["end"], sd, len(ws), s["text"][:60]))
            for wd in ws:
                d2 = wd["end"] - wd["start"]
                flag = "  <== 超长词" if d2 > 1.5 else ""
                print("            %-16s %.3f-%.3f (%.3fs)%s" % (
                    wd["word"][:16], wd["start"], wd["end"], d2, flag))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
