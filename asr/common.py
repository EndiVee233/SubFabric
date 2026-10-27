"""
识别引擎与后台 worker **共用**的部分。

- `asr.py`     —— sherpa-onnx / CUDA（N 卡 GPU）
- `asr_npu.py` —— OpenVINO / NPU

为什么要抽：
  这两个文件原先各自实现了一份**逐字重复**的断句逻辑，第二轮审查发现已经行为漂移
  （npu 版在重复的副本上长出了 token 分数逻辑，历史审查记录见 docs/PROJECT.md §12，
  其中把它列为"收益最大单项"）。
  2026-10-11 先补了 `tests/asr-segment-parity-test.py` 做护栏（钉住两边分句必须逐字一致），
  然后才来做这次提取 —— 顺序不能反，否则改坏了哪一边看不出来。

边界（**刻意**只放这些）：
  · 断句阈值常量
  · `group_words()`   —— 纯分组，不含置信度
  · `seg_base()`      —— 一段的公共字段（id / start / end / text / words）
  · `clamp_overlap()` —— 相邻行不交叠
  · `watch_parent()` —— 对齐/说话人分离 worker 的非阻塞父进程看护

置信度**刻意不在这里**：两个引擎能拿到的信号不同（sherpa 不给 token 概率、NPU 给），
口径本来就该各写各的（对拍测试里也把这项差异钉成"设计如此"）。
"""

import os
import threading
import time


def parent_alive(pid):
    """检查进程是否存活；Windows 用进程句柄，不能依赖退出后仍保留的 PPID。"""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    # ctypes 默认把返回值当 c_int；显式声明 HANDLE，保持 32/64 位调用契约。
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return ctypes.get_last_error() == 5  # ACCESS_DENIED：保守当作存活
    try:
        return kernel.WaitForSingleObject(handle, 0) != 0  # WAIT_OBJECT_0：已退出
    finally:
        kernel.CloseHandle(handle)


def watch_parent():
    """显式启用后每秒检查父进程，退出时回收 worker；不读 stdin，避免模型导入死锁。"""
    if os.environ.get("SUBFABRIC_PARENT_WATCH") != "1":
        return
    ppid = os.getppid()

    def run():
        while True:
            time.sleep(1)
            if not parent_alive(ppid):
                os._exit(0)

    threading.Thread(target=run, daemon=True).start()

SAMPLE_RATE = 16000

# 基础断句阈值(纯本地规则, 不涉及 LLM)
SENT_END = (".", "?", "!", "。", "？", "！", "…")
SOFT_END = (",", ";", ":")      # 强制断行时优先回退到这里, 避免把句尾词甩成孤行
PAUSE_SPLIT = 0.8     # 停顿超过这个秒数就断行
MAX_LINE_SEC = 10.0   # 行长兜底: 说话不带标点时也不至于糊成一坨
MAX_LINE_WORDS = 30


def group_words(words):
    """基础断句: 句末标点 / 长停顿 / 行长兜底。只返回"词分组"，不含置信度。

    两个引擎共用这一份 —— 以前各写一份，改了一处忘另一处就是行为漂移。
    """
    groups, cur = [], []
    for w in words:
        if cur:
            prev = cur[-1]
            too_long = (w["start"] - cur[0]["start"]) > MAX_LINE_SEC or len(cur) >= MAX_LINE_WORDS
            if prev["word"].rstrip().endswith(SENT_END) or (w["start"] - prev["end"]) > PAUSE_SPLIT:
                groups.append(cur)
                cur = []
            elif too_long:
                # 被长度逼着断行时, 尽量在最近的软标点(逗号/分号/冒号)处断开 ——
                # 否则会出现「with.」这种只剩一个句尾词的孤行。
                cut = None
                for j in range(len(cur) - 1, -1, -1):
                    if cur[j]["word"].rstrip().endswith(SOFT_END) and (j + 1) >= 6:
                        cut = j + 1
                        break
                if cut:
                    groups.append(cur[:cut])
                    cur = cur[cut:]
                else:
                    groups.append(cur)
                    cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def seg_base(i, ws):
    """一段的公共字段。两个引擎这部分必须**逐字一致**
    （由 tests/asr-segment-parity-test.py 钉着）。"""
    return {
        "id": i,
        "start": ws[0]["start"],
        "end": ws[-1]["end"],
        "text": " ".join(w["word"] for w in ws).strip(),
        "words": [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
                  for w in ws],
    }


def clamp_overlap(segs):
    """相邻行不交叠：把后一行的 start 抬到前一行的 end。原地改并返回。"""
    for i in range(1, len(segs)):
        if segs[i]["start"] < segs[i - 1]["end"]:
            segs[i]["start"] = segs[i - 1]["end"]
    return segs


def frame_energies(samples, sr, frame_ms=20.0, hop_ms=10.0):
    """返回 (每帧 RMS, 每帧起始秒, hop秒)。两个引擎共用（refine_word_ends 用）。

    按块计算: 老实现一次性广播出 (n_frames, frame) 的 int64 索引矩阵,
    1 小时音频 ≈ 1.15 亿索引(索引 + 浮点切片 + 平方临时量峰值约 1.8GB), 长片有 OOM 风险;
    分块后内存占用只与块大小有关、与音频长度无关, 逐帧数值与老实现完全一致
    (同一行内的 square/mean 归约顺序不变)。

    ⚠ 教训（第二轮审查）：asr_npu.py 曾把这份实现**复制**过去，复制的还是
      asr.py 修复前那份全量广播的老版本 —— 于是 NPU 引擎会在 GPU 引擎不崩的地方
      OOM。跨引擎同算法只留一份实现，就是这个函数的全部意义。
    """
    import numpy as np

    frame = max(1, int(sr * frame_ms / 1000.0))
    hop = max(1, int(sr * hop_ms / 1000.0))
    if len(samples) < frame:
        e = float(np.sqrt(np.mean(np.square(samples)))) if len(samples) else 0.0
        return np.array([e], dtype=np.float32), 0.0, float(hop) / sr

    n_frames = 1 + (len(samples) - frame) // hop
    energies = np.empty(n_frames, dtype=np.float32)
    offs = np.arange(frame, dtype=np.int64)[None, :]              # 帧内偏移, 建一次复用
    block = max(1, 2000000 // frame)                              # 每块索引元素 ≤200万(int64 约16MB)
    for b0 in range(0, n_frames, block):
        b1 = min(n_frames, b0 + block)
        idx = offs + (hop * np.arange(b0, b1, dtype=np.int64))[:, None]
        energies[b0:b1] = np.sqrt(np.mean(np.square(samples[idx]), axis=1)).astype(np.float32)
    return energies, 0.0, float(hop) / sr
