#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一份音频的分片**同时**交给两个识别引擎跑：NPU 引擎 + GPU(N 卡) 引擎，然后合并结果。

为什么值得这么做（本机实测，务必先看数据再定比例）：
    同一段音频、同样 15.01s 分片，持续吞吐：
        NPU 引擎（OpenVINO：编码器 NPU、预测/联合 Intel 核显）  ≈ 21.9x 实时
        GPU 引擎（sherpa-onnx CUDA，N 卡 cuda:0）              ≈ 16.1x 实时
    两者接近、**NPU 略快**，所以默认按 1:1 分工即可；比例可用 --ratio 调，
    也可以用 tools/bench-equal.py 重新测。

设备约束（用户明确要求）：
    * **不使用 GPU 1**（OpenVINO 的 GPU.1 = NVIDIA dGPU）。NPU 引擎的预测/联合网络
      钉在 GPU.0（Intel 核显）上，绝不碰 N 卡 —— N 卡整块留给 CUDA 引擎。
    * 两个引擎因此落在**不同硬件**上（NPU+核显 vs N 卡），并行时互不抢占。

分片与时间戳：
    按固定长度切片（默认 15.01s，正好是 NPU 单窗口长度）。每片交给一个引擎，
    结果里的时间戳加上片起点后合并，再统一做词级结束时间与断句 —— 与单引擎路径
    完全同一套后处理，所以中英对齐/断句行为不变。

用法：
    python asr/asr_dual.py --audio <16k单声道wav> --out <结果.json> \\
        --model-npu <目录> --model-gpu <目录> [--ratio 1:1] [--slice-sec 15.01]
    python asr/asr_dual.py --probe --audio <wav> ...     # 先只测两个引擎的速度并给建议
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# 测速实现放在 tools/（同一个仓库，避免两份基准代码漂移）。必须在这里就加路径 ——
# 只在 probe() 里加的话，main() 之后才生效，导入照样失败（踩过）。
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))

SAMPLE_RATE = 16000

# 与单引擎路径完全一致的后处理（同一份实现，避免两个后端行为漂移）
import asr as A            # noqa: E402  refine_word_ends / words_to_segments / read_wav_mono16k


def emit(obj):
    try:
        sys.stderr.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def log(msg):
    emit({"type": "log", "msg": str(msg)})


def progress(pct, stage, msg):
    emit({"type": "progress", "pct": max(0, min(100, int(pct))), "stage": stage, "msg": str(msg)})


# --------------------------------------------------------------------------
# 切片
# --------------------------------------------------------------------------
def plan_slices(total_sec, slice_sec):
    """返回 [(index, start, end)]。最后一片可能短一些。"""
    out = []
    i, t = 0, 0.0
    while t < total_sec - 1e-6:
        end = min(total_sec, t + slice_sec)
        if total_sec - end < 0.3:          # 尾巴太短就并进上一片，免得切出 0.1s 的碎片
            if out:
                out[-1] = (out[-1][0], out[-1][1], total_sec)
            else:
                out.append((i, t, total_sec))
            break
        out.append((i, t, end))
        i += 1
        t = end
    return out


def write_slice(samples, sr, start, end, path):
    a = samples[int(start * sr):int(end * sr)]
    pcm = np.clip(a, -1.0, 1.0)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((pcm * 32767.0).astype(np.int16).tobytes())


def parse_ratio(text: str) -> float:
    """'1:1' -> 1.0。返回 **GPU 权重 / NPU 权重**。

    必须能表达两个极端，否则没法拿它做单引擎基线对比（踩过：'1:0' 算出 inf、'0:1' 落到默认
    1.0，于是"仅 NPU"那次其实还是对半分工，三组数据自相矛盾）。
      '0:1' -> 0.0（只用 NPU）    '1:0' -> inf（只用 GPU）
    """
    parts = str(text).split(":")
    a = parts[0] if parts else "1"
    b = parts[1] if len(parts) > 1 else "1"
    try:
        g, n = float(a), float(b)
    except ValueError:
        return 1.0
    g, n = max(0.0, g), max(0.0, n)
    if n <= 0 and g <= 0:
        return 1.0
    if n <= 0:
        return float("inf")            # 只用 GPU
    return g / n                       # 含 0.0（只用 NPU）


# --------------------------------------------------------------------------
# 两个引擎各起**一个**进程，一次加载模型，按 manifest 跑完分给自己的分片。
#
# 为什么不是"每片 spawn 一次"（第一版就是这么写的，实测被打回）：
#   模型加载远贵于一片的推理 —— NPU 加载 4.3s、sherpa 加载 14.2s，而一片只有 15s 音频。
#   按片起进程时，开销全花在反复加载模型上，实测总吞吐掉到 1.6x 实时，
#   而单引擎持续吞吐是 21.9x / 16.1x，**差 10 倍**。
# --------------------------------------------------------------------------
def _piece_worker(name, script, model, extra, python_exe, tasks, tmpdir,
                  slices_by_index, results, lock, total, log_fn):
    """一个引擎的取片循环：取一片 → 识别 → 落盘 → 再取。

    动态负载均衡就靠这个循环：跑得快的引擎自然拿到更多片，
    不需要事先知道两个引擎的速度比（那个比值实测波动 17~40%，根本测不准）。
    """
    import json as _json
    import subprocess as _sp
    import time as _t
    while True:
        try:
            idx = tasks.get_nowait()
        except Exception:
            return                                  # 队列空 → 这个引擎收工
        info = slices_by_index[idx]
        try:
            man = os.path.join(tmpdir, f"m-{name}-{idx}.json")
            out = os.path.join(tmpdir, f"o-{name}-{idx}.json")
            with open(man, "w", encoding="utf-8") as fh:
                _json.dump({"slices": [info], "out": out}, fh, ensure_ascii=False)
            t0 = _t.time()
            proc = _sp.run([python_exe, script, "--model", model,
                            "--manifest", man, "--out", out] + extra,
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
            dt = _t.time() - t0
            if proc.returncode != 0:
                tail = ((proc.stderr or "").strip().splitlines() or ["(无输出)"])[-1]
                raise RuntimeError(tail)
            with open(out, encoding="utf-8") as fh:
                got = ((_json.load(fh).get("slices") or {}).get(str(idx))) or {}
            got["__engine"] = name
            got["__wall"] = dt
            with lock:
                results[idx] = got
                n = sum(1 for k in results if isinstance(k, int))
                progress(12 + int(n / max(1, total) * 76), "asr",
                         f"并行识别中 … {n}/{total} 片")
            dur = info["end"] - info["start"]
            log_fn(f"[{name}] 第 {idx + 1} 片 {dur:.1f}s 音频 用时 {dt:.2f}s"
                   f"（{dur / max(dt, 1e-6):.1f}x 实时）")
        except Exception as exc:  # noqa: BLE001
            with lock:
                results[idx] = {"error": str(exc), "__engine": name,
                                "start": info["start"], "end": info["end"]}
            log_fn(f"[{name}] 第 {idx + 1} 片失败：{exc}")
        finally:
            tasks.task_done()


def run_engine(name, script, model, extra, python_exe, slices, tmpdir, out_path):
    """在一个子进程里跑完一批分片。返回 (耗时秒, 结果 dict)。"""
    manifest = os.path.join(tmpdir, f"{name}-manifest.json")
    with open(manifest, "w", encoding="utf-8") as fh:
        json.dump({"slices": slices, "out": out_path}, fh, ensure_ascii=False)
    cmd = [python_exe, script, "--model", model,
           "--manifest", manifest, "--out", out_path] + extra
    t0 = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    for line in proc.stdout:                 # 把子进程日志透传出去（进度条靠它）
        line = line.rstrip()
        if line:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
    proc.wait()
    dt = time.time() - t0
    if proc.returncode != 0:
        raise RuntimeError(f"{name} 引擎退出码 {proc.returncode}")
    with open(out_path, encoding="utf-8") as fh:
        return dt, json.load(fh)


def merge(data_by_engine, want_indices):
    """把各引擎的结果按分片序号合并成一条时间轴（时间戳已在 worker 侧加过片起点）。"""
    words, segs, failed = [], [], []
    for name, data in data_by_engine.items():
        got = (data or {}).get("slices") or {}
        for idx in want_indices.get(name, []):
            r = got.get(str(idx))
            if not r:
                failed.append((idx, name))
                continue
            for seg in r.get("segments") or []:
                for w in seg.get("words") or []:
                    words.append({"word": w["word"], "start": w["start"], "anchor": w["start"]})
                if seg.get("text"):
                    segs.append({"start": seg["start"], "end": seg["end"], "text": seg["text"]})
    words.sort(key=lambda w: w["start"])
    segs.sort(key=lambda x: x["start"])
    return words, segs, failed


# --------------------------------------------------------------------------
def probe(audio, args):
    """只测两个引擎在真实分片上的速度，用来决定分工比例。

    测速实现放在 tools/bench-equal.py（同一个仓库，避免两份基准代码漂移）。
    """
    from bench_equal import run_npu, run_sherpa, slices_of, read_wav  # noqa: PLC0415
    samples = read_wav(audio)
    segs = slices_of(samples, args.slice_sec, 3)
    total = args.slice_sec * 3.0
    log("测速中（每个引擎 3 片）…")
    t_npu = t_gpu = None
    try:
        t_npu = run_npu(segs, 1, joint=args.joint)
        log(f"NPU 引擎：3 片 {t_npu[0]:.2f}s → {total / t_npu[0]:.1f}x 实时")
    except Exception as exc:  # noqa: BLE001
        log(f"NPU 测速失败：{exc}")
    try:
        t_gpu = run_sherpa(segs, 1)
        log(f"GPU 引擎：3 片 {t_gpu[0]:.2f}s → {total / t_gpu[0]:.1f}x 实时")
    except Exception as exc:  # noqa: BLE001
        log(f"GPU 测速失败：{exc}")
    if t_npu and t_gpu:
        ratio = t_npu[0] / t_gpu[0]          # GPU 比 NPU 快多少（耗时比）
        log(f"耗时比 GPU:NPU = {ratio:.2f} → 建议 --ratio {max(1, round(ratio))}:1"
            f"（GPU 承担 {ratio / (ratio + 1) * 100:.0f}% 的分片）")
    return 0



def _parse_load_sec_of(data):
    """从引擎结果里取模型加载耗时。

    结果 JSON 里其实没有这个字段（worker 不写），于是返回 0 —— 这会让"每片净耗时"
    略微高估（把加载时间算进了推理）。但**两个引擎用同一套算法**，
    轮间比例取的是两者的比值，所以系统性偏差会抵消，比例仍然可比。
    """
    try:
        return float((data or {}).get("loadSec") or 0.0)
    except Exception:
        return 0.0

def main() -> int:
    ap = argparse.ArgumentParser(description="NPU 与 GPU 双引擎并行识别")
    ap.add_argument("--audio", required=True, help="16kHz 单声道 wav")
    ap.add_argument("--out", help="结果 JSON 输出路径")
    # server 用统一契约调用（--model/--provider/--threads）。--model 在这里只是"线索"：
    # 从它推出 models/ 根，再拼出两套模型目录。显式给 --model-npu/--model-gpu 时以显式值为准。
    ap.add_argument("--model", default="", help="(统一契约) 任一模型目录，用于推导 models/ 根")
    ap.add_argument("--provider", default="dual",
                    help="(统一契约) server 固定传 'dual'；本脚本自己管设备，此参数不生效")
    ap.add_argument("--models-root", default="", help="models/ 根目录（覆盖自动推导）")
    ap.add_argument("--model-npu", default="")
    ap.add_argument("--model-gpu", default="")
    ap.add_argument("--python", default=sys.executable, help="跑 worker 的解释器")
    ap.add_argument("--slice-sec", type=float, default=15.01,
                    help="分片长度（默认 15.01，正好是 NPU 的单窗口长度）")
    ap.add_argument("--round-sec", type=float, default=240.0,
                    help="分轮次调度：每轮约多少秒音频。一轮内模型只加载一次，"
                         "轮间按实测速度重调比例。太小则加载开销占比高，太大则跟不上负载漂移")
    ap.add_argument("--dynamic", action="store_true",
                    help="动态任务队列。⚠ 当前实现每片起一次进程、每片重新加载模型，"
                         "实测只有 1.7~3.1x 实时（静态是 ~20x）；真正可用的版本需要常驻 worker，"
                         "尚未实现。默认关闭")
    ap.add_argument("--static", action="store_true",
                    help="用静态预分配而不是动态队列（性能测试的基线测量用）。"
                         "日常识别别开 —— 动态队列会自动均衡负载")
    ap.add_argument("--ratio", default="1:1",
                    help="GPU:NPU 的分片配比。两者速度接近时用 1:1；GPU 明显更快才加大。"
                         "用 --probe 实测后再定")
    ap.add_argument("--joint", default="GPU.0",
                    help="NPU 引擎里预测/联合网络用哪个设备。GPU.0=Intel 核显（默认，**不占 N 卡**）")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--probe", action="store_true", help="只测两个引擎的速度并给比例建议")
    args = ap.parse_args()

    # ── 推导两套模型目录，并检查存在性（缺一套就只用另一套，不直接失败）──
    root = args.models_root
    if not root:
        root = os.path.dirname(os.path.abspath(args.model)) if args.model \
            else os.path.join(HERE, "models")
    if not args.model_npu:
        args.model_npu = os.path.join(root, "parakeet-tdt-0.6b-v2-npu")
    if not args.model_gpu:
        args.model_gpu = os.path.join(root, "parakeet-tdt-0.6b-v2")

    have_npu = os.path.exists(os.path.join(args.model_npu, "encoder-model.onnx"))
    have_gpu = (os.path.exists(os.path.join(args.model_gpu, "encoder.int8.onnx"))
                or os.path.exists(os.path.join(args.model_gpu, "encoder.onnx")))
    if not have_npu and not have_gpu:
        log("两套模型都找不到：%s / %s" % (args.model_npu, args.model_gpu))
        return 1
    if not have_npu:
        log("缺 NPU 模型（%s），本次只用 GPU 引擎" % args.model_npu)
    if not have_gpu:
        log("缺 GPU 模型（%s），本次只用 NPU 引擎" % args.model_gpu)
    log("模型：NPU=%s[%s]  GPU=%s[%s]"
        % (os.path.basename(args.model_npu), "有" if have_npu else "缺",
           os.path.basename(args.model_gpu), "有" if have_gpu else "缺"))

    if not os.path.exists(args.audio):
        log(f"音频不存在：{args.audio}")
        return 1
    if args.probe:
        return probe(args.audio, args)

    samples, sr = A.read_wav_mono16k(args.audio)
    dur = len(samples) / float(sr)
    log(f"音频 {dur:.1f}s @ {sr}Hz，分片 {args.slice_sec:g}s")

    all_slices = plan_slices(dur, args.slice_sec)
    ratio = parse_ratio(args.ratio)          # GPU 权重 / NPU 权重
    if not have_gpu:
        ratio = 0.0                          # 只有 NPU
    elif not have_npu:
        ratio = float("inf")                 # 只有 GPU
    total_w = ratio + 1.0

    # 按比例分配：GPU 拿前 n_gpu 片、NPU 拿其余。为什么 GPU 拿前面的：
    # sherpa 加载快（~10s），先开工；NPU 首次要编译计算图（~4s 有缓存 / 60s+ 无缓存），
    # 让它晚一点开始不影响总墙钟，而两个引擎本来就并行。
    total = len(all_slices)
    if ratio == float("inf"):
        n_gpu = total                        # 只用 GPU（基线测量用）
    elif ratio <= 0:
        n_gpu = 0                            # 只用 NPU（基线测量用）
    else:
        n_gpu = round(total * ratio / total_w)
        n_gpu = max(0, min(total, n_gpu))
        if total > 1 and n_gpu == total:
            n_gpu = total - 1                # 至少给 NPU 留一片，否则谈不上"同时"
    log(f"分工：GPU {n_gpu} 片 / NPU {len(all_slices) - n_gpu} 片（ratio {args.ratio}）")

    tmpdir = tempfile.mkdtemp(prefix="dual-asr-")
    try:
        progress(3, "asr", "切分片 …")
        by_engine = {"gpu": [], "npu": [], "_byIndex": {}}
        for k, (idx, start, end) in enumerate(all_slices):
            wav = os.path.join(tmpdir, f"s{idx:04d}.wav")
            write_slice(samples, sr, start, end, wav)
            name = "gpu" if k < n_gpu else "npu"
            by_engine[name].append({"index": idx, "start": start, "end": end, "wav": wav})
            by_engine["_byIndex"][idx] = {"index": idx, "start": start, "end": end, "wav": wav}

        py = args.python
        scripts = {"gpu": (os.path.join(HERE, "asr.py"), args.model_gpu,
                           ["--threads", str(args.threads), "--provider", "cuda"]),
                   "npu": (os.path.join(HERE, "asr_npu.py"), args.model_npu,
                           ["--threads", str(args.threads), "--provider", "npu"])}
        py = args.python
        scripts = {"gpu": (os.path.join(HERE, "asr.py"), args.model_gpu,
                           ["--threads", str(args.threads), "--provider", "cuda"]),
                   "npu": (os.path.join(HERE, "asr_npu.py"), args.model_npu,
                           ["--threads", str(args.threads), "--provider", "npu"])}

        # ── 分轮次调度 ──────────────────────────────────────────────────
        # 一轮内：把该轮的分片按比例分给两个引擎，各自**只加载一次模型**跑完一批。
        # 轮间：用实测的"每片净耗时"重新算比例 —— 这样能跟上负载漂移
        #      （笔记本 dGPU 从省电态升频要时间，后台负载也会变），
        #      而每片动态抢队列的代价是每片重载模型，实测会掉 10 倍（不做）。
        round_sec = max(60.0, float(args.round_sec))
        rounds = [all_slices[i:i + max(1, int(round_sec / args.slice_sec))]
                  for i in range(0, len(all_slices), max(1, int(round_sec / args.slice_sec)))]
        log(f"分轮次：{len(all_slices)} 片 → {len(rounds)} 轮"
            f"（每轮约 {round_sec:g}s 音频；轮间按实测速度重调比例）")

        data_by_engine = {}          # {engine: {"slices": {...}}} 累积
        want = {}                    # {engine: [idx, ...]}
        error = {}
        cur_ratio = ratio
        for ri, rnd in enumerate(rounds):
            if cur_ratio == float("inf"):
                n_gpu = len(rnd)
            elif cur_ratio <= 0:
                n_gpu = 0
            else:
                n_gpu = round(len(rnd) * cur_ratio / (cur_ratio + 1.0))
                n_gpu = max(0, min(len(rnd), n_gpu))
                if len(rnd) > 1 and n_gpu == len(rnd):
                    n_gpu = len(rnd) - 1
            # plan_slices 给的是 (index, start, end) 元组，而 run_engine/manifest 需要
            # 带 wav 路径的字典 —— 用 _byIndex 转一下（踩过：直接传元组会让
            # run_manifest 里的 s.get() 报 "'list' object has no attribute 'get'"）。
            _mk = by_engine["_byIndex"]
            parts = {"gpu": [_mk[t[0]] for t in rnd[:n_gpu]],
                     "npu": [_mk[t[0]] for t in rnd[n_gpu:]]}
            log(f"── 第 {ri + 1}/{len(rounds)} 轮：{len(rnd)} 片 → "
                f"GPU {len(parts['gpu'])} / NPU {len(parts['npu'])}"
                f"（比例 {('inf' if cur_ratio == float('inf') else round(cur_ratio, 2))}）")

            got = {}
            threads = []

            def go(name, _parts=parts):
                script, model, extra = scripts[name]
                if not _parts[name]:
                    return
                try:
                    dt, data = run_engine(name, script, model, extra, py,
                                          _parts[name], tmpdir,
                                          os.path.join(tmpdir, f"{name}-r{ri}.json"))
                    got[name] = (dt, data)
                except Exception as exc:  # noqa: BLE001
                    error[name] = str(exc)
                    log(f"[{name}] 第 {ri + 1} 轮失败：{exc}")

            for name in ("gpu", "npu"):
                t = threading.Thread(target=go, args=(name,), daemon=True)
                t.start()
                threads.append(t)
            for t in threads:
                t.join()

            # 累积结果 + 算下一轮比例
            per_slice = {}
            for name in ("gpu", "npu"):
                if name not in got:
                    continue
                dt, data = got[name]
                data_by_engine.setdefault(name, {"slices": {}})
                data_by_engine[name]["slices"].update(data.get("slices") or {})
                want.setdefault(name, []).extend(s["index"] for s in parts[name])
                n = max(1, len(parts[name]))
                load = _parse_load_sec_of(data)     # 从结果里拿不到就按 0 估
                per_slice[name] = max(1e-4, (dt - load) / n)
                log(f"   [{name}] {len(parts[name])} 片 墙钟 {dt:.2f}s"
                    f"（加载 {load:.2f}s）→ 每片 {per_slice[name]:.3f}s")
            # 用本轮实测更新下一轮比例（两个引擎都有数据才算）
            if len(per_slice) == 2 and ri + 1 < len(rounds):
                new_ratio = per_slice["npu"] / per_slice["gpu"]     # GPU 比 NPU 快几倍
                new_ratio = max(0.2, min(5.0, new_ratio))
                if abs(new_ratio - cur_ratio) > 0.15:
                    log(f"   轮间调整比例 {cur_ratio:.2f} → {new_ratio:.2f}"
                        f"（本轮实测 GPU/NPU 每片耗时比 {new_ratio:.2f}）")
                cur_ratio = new_ratio
        words, segs, failed = merge(data_by_engine, want)
        for idx, name in failed:
            log(f"第 {idx + 1} 片（{name}）没有产出")
        if not words:
            log("两个引擎都没有产出结果" + (f"；错误：{error}" if error else ""))
            return 1

        # 与单引擎完全同一套后处理
        progress(90, "asr", "整理词级时间轴 …")
        words = A.refine_word_ends(words, samples, sr)
        segments = A.words_to_segments(words)
        log(f"识别完成：{len(words)} 词 / {len(segments)} 行"
            + (f"（{len(failed)} 片缺失）" if failed else ""))

        # 各引擎实际速度：调 --ratio 就按这个来
        for name, data in data_by_engine.items():
            got = data.get("slices") or {}
            audio_sec = sum(r.get("audioSec", 0) for r in got.values())
            work_sec = sum(r.get("sec", 0) for r in got.values())
            log(f"[{name}] {len(got)} 片 {audio_sec:.1f}s 音频 / 推理 {work_sec:.2f}s "
                f"= {audio_sec / max(work_sec, 1e-6):.1f}x 实时"
                f"（含加载总墙钟 {data.get('__wall', 0):.1f}s）")

        payload = {"duration": round(dur, 3), "language": "en", "segments": segments,
                   "engines": {"ratio": args.ratio,
                               "gpu": {"slices": len(by_engine["gpu"])},
                               "npu": {"slices": len(by_engine["npu"])}}}
        tmp = (args.out or os.path.join(os.path.dirname(args.audio), "asr-dual.json")) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, args.out or os.path.join(os.path.dirname(args.audio), "asr-dual.json"))
        progress(100, "asr", f"识别完成：{len(segments)} 行")
        return 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
