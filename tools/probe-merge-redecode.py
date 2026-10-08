"""决定性实验：合并相邻句重新识别，到底能不能改善？

背景（本项目的具体事实）：
  · asr_npu.py 按 ENCODER_WINDOW_FRAMES（15.01s）滑窗解码，**带重叠区**
  · 实测平均句长只有 1.5 秒 → 模型原始解码时本来就有 ~10 倍句长的声学上下文
  · 所以"合并相邻句再识别"喂进去的声学上下文可能几乎没变 → 输出一样 → 白花时间

本实验直接对比：
  A) 单独识别目标句的音频区间（模拟"只喂这一句"）
  B) 识别"前一句 + 目标句 + 后一句"的合并区间（模拟本机制）
  C) 原始 asr.json 里那一句的文本（作为基线）

如果 B 的文本与目标句在 A/C 里的部分**完全一致**，说明该机制对 NPU 引擎无效
（因为原解码窗口早就把上下文含进去了）。
如果 B 更好，则机制有价值。

用法: python probe_merge_redecode.py <project_dir> <seg_index> [模型目录]
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import wave

PY = r"D:\SubFabric\SubFabric\asr\runtime-python\python.exe"
WORKER = r"D:\SubFabric-fork\asr\asr_npu.py"
MODEL = r"D:\SubFabric-fork\asr\models\parakeet-tdt-0.6b-v2-npu"


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        data = w.readframes(n)
    assert sw == 2, "expect 16-bit"
    import array
    a = array.array("h")
    a.frombytes(data)
    if ch > 1:
        a = array.array("h", [a[i] for i in range(0, len(a), ch)])
    return a, sr


def write_wav(path, samples, sr):
    import array
    a = samples if isinstance(samples, array.array) else array.array("h", samples)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(a.tobytes())


def slice_wav(src, dst, t0, t1, sr):
    a, _ = read_wav(src)
    i0 = max(0, int(t0 * sr))
    i1 = min(len(a), int(t1 * sr))
    write_wav(dst, a[i0:i1], sr)
    return (i1 - i0) / sr


def run_worker(wav, out, tta=0):
    """tta=0：本实验只关心文本，不需要稳定性重跑（更快）。"""
    args = [PY, "-u", WORKER, "--model", MODEL, "--audio", wav, "--out", out,
            "--provider", "npu", "--tta", str(tta)]
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not os.path.exists(out):
        return None, (p.stderr or "")[-400:]
    d = json.load(io.open(out, encoding="utf-8"))
    return d.get("segments") or [], ""


def norm(s: str) -> str:
    """比文本时忽略大小写与标点，只看词"""
    import re
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).split()


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    proj = sys.argv[1]
    idx = int(sys.argv[2])
    asr = json.load(io.open(os.path.join(proj, "asr.json"), encoding="utf-8"))
    segs = asr["segments"]
    if not (0 <= idx < len(segs)):
        print("seg index out of range")
        return 2

    tgt = segs[idx]
    prev = segs[idx - 1] if idx > 0 else None
    nxt = segs[idx + 1] if idx + 1 < len(segs) else None
    wav = os.path.join(proj, "audio.wav")
    tmp = os.path.join(os.environ.get("TEMP", "."), "merge_probe")
    os.makedirs(tmp, exist_ok=True)

    print("目标句 #%d  %.2f-%.2f (%.2fs, %d 词)" % (
        idx, tgt["start"], tgt["end"], tgt["end"] - tgt["start"], len(tgt.get("words") or [])))
    print("  原文: %s" % tgt["text"])
    if prev:
        print("  前句: [%.2f-%.2f] %s" % (prev["start"], prev["end"], prev["text"][:70]))
    if nxt:
        print("  后句: [%.2f-%.2f] %s" % (nxt["start"], nxt["end"], nxt["text"][:70]))
    print()

    # A) 只喂目标句
    wa = os.path.join(tmp, "a.wav")
    da = slice_wav(wav, wa, tgt["start"], tgt["end"], 16000)
    segsA, errA = run_worker(wa, os.path.join(tmp, "a.json"))
    print("A) 单独识别目标句（%.2fs 音频）" % da)
    if segsA is None:
        print("   失败: %s" % errA)
    else:
        for s in segsA:
            print("   -> %s" % s["text"])

    # B) 前 + 目标 + 后 合并
    lo = prev["start"] if prev else tgt["start"]
    hi = nxt["end"] if nxt else tgt["end"]
    wb = os.path.join(tmp, "b.wav")
    db = slice_wav(wav, wb, lo, hi, 16000)
    segsB, errB = run_worker(wb, os.path.join(tmp, "b.json"))
    print()
    print("B) 合并识别（前+目标+后 = %.2f-%.2f，%.2fs 音频，是目标句的 %.1f 倍）" % (
        lo, hi, db, db / max(0.01, tgt["end"] - tgt["start"])))
    if segsB is None:
        print("   失败: %s" % errB)
    else:
        for s in segsB:
            mark = ""
            # 找出与目标句时间重叠的那条（B 的时间轴相对合并区间起点）
            s_abs_a, s_abs_b = s["start"] + lo, s["end"] + lo
            if not (s_abs_b <= tgt["start"] or s_abs_a >= tgt["end"]):
                mark = "   <== 与目标句重叠"
            print("   -> [%.2f-%.2f]%s %s" % (s_abs_a, s_abs_b, mark, s["text"]))

    # 结论：把 A 的词与 B 中重叠段的词比
    if segsA and segsB:
        wa_ = norm(" ".join(s["text"] for s in segsA))
        # B 里与目标区间重叠的段
        ov = [s for s in segsB
              if not (s["end"] + lo <= tgt["start"] or s["start"] + lo >= tgt["end"])]
        wb_ = norm(" ".join(s["text"] for s in ov))
        print()
        print("对比（只看词，忽略大小写与标点）")
        print("  A 词数 %d  B(重叠段) 词数 %d" % (len(wa_), len(wb_)))
        print("  完全相同: %s" % (wa_ == wb_))
        if wa_ != wb_:
            onlyA = [w for w in wa_ if w not in wb_]
            onlyB = [w for w in wb_ if w not in wa_]
            print("  只在 A: %s" % " ".join(onlyA[:30]))
            print("  只在 B: %s" % " ".join(onlyB[:30]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
