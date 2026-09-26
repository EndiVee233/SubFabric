#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""说话人分离 worker —— 供 K-ASS-Editor「创建初稿」调用。

用法:
    python diarize.py --segmentation <pyannote-seg.onnx> --embedding <emb.onnx> \
        --audio <16kHz单声道wav> --out <结果.json> [--speakers N] [--max-len 秒] [--provider auto]

--speakers: 说话人数量(用户在界面上填的)。没填默认 6 —— 分离模型按聚类分组,
            聚类数 = 说话人数, 填多了会拆出空组/把同一人拆开, 所以让用户告知。
--provider: auto(默认, 仅当装的是 CUDA 版 sherpa-onnx 时走 GPU, 否则 CPU) / cpu(强制 CPU)。
            CUDA 需要 CUDA 版 sherpa-onnx + N 卡驱动 + nvidia-* 运行库(与 asr.py 同一套)。

输出(写到 --out):
    {"speakers": 3, "regions": [{"start":1.2,"end":4.5,"speaker":0}, ...]}
    speaker 为 0 起始的组序号(未按出现顺序重排)。

进度/日志与 asr.py 相同: 往 stderr 输出 JSON 行。
依赖: sherpa-onnx(与 asr.py 同一个 venv), 音频须为 16kHz 单声道 PCM wav。
"""

import argparse
import json
import os
import sys
import time
import wave

SR = 16000


def emit(obj):
    try:
        sys.stderr.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def log(msg):
    emit({"type": "log", "msg": str(msg)})


def progress(pct, msg):
    emit({"type": "progress", "pct": max(0, min(100, int(pct))), "msg": str(msg)})


def read_wav_mono16k(path):
    """读 wav -> (float32 numpy 数组[-1,1], 采样率)。立体声降单声道, 非 16k 则线性重采样兜底。"""
    import array
    import numpy as np

    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sr = wf.getframerate()
        width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())

    if width != 2:
        raise RuntimeError("只支持 16-bit PCM wav(当前 %d 字节/样本)" % width)

    a = array.array("h")
    a.frombytes(raw)
    data = np.asarray(a, dtype=np.float32) / 32768.0

    if nch > 1:
        usable = (len(data) // nch) * nch
        data = data[:usable].reshape(-1, nch).mean(axis=1)

    if sr != SR:
        n = len(data)
        if n == 0:
            return data, sr
        new_n = max(1, int(round(n * SR / float(sr))))
        data = np.interp(
            np.linspace(0, n - 1, num=new_n, dtype=np.float32),
            np.arange(n, dtype=np.float32), data).astype(np.float32)
        sr = SR
    return data, sr


def setup_cuda_dll_paths():
    """CUDA 运行库搜索路径: pip 装的 nvidia-cublas-cu12 / nvidia-cudnn-cu12 等把 DLL 放在
    site-packages/nvidia/<pkg>/bin, 默认不在 DLL 搜索路径里 —— 不注册的话 CUDA EP 会因
    缺 cublasLt64_12.dll 之类加载失败。与 asr.py 同一套逻辑; 仅 CUDA 模式需要, 失败静默。"""
    try:
        import sysconfig
        sp = sysconfig.get_paths().get("purelib", "")
        nv = os.path.join(sp, "nvidia") if sp else ""
        if nv and os.path.isdir(nv):
            dirs = []
            for d in sorted(os.listdir(nv)):
                for sub in ("bin", "lib"):
                    p = os.path.join(nv, d, sub)
                    if os.path.isdir(p):
                        dirs.append(p)
                        try:
                            os.add_dll_directory(p)   # 新式搜索(LOAD_LIBRARY_SEARCH_* 模式)
                        except Exception:
                            pass
            if dirs:
                # onnxruntime 加载 providers_cuda.dll 用旧式搜索, 该模式下只有 PATH 管用 —— 两个都设
                os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(description="说话人分离 worker (sherpa-onnx pyannote + eres2net/titanet embedding)")
    ap.add_argument("--segmentation", required=True, help="说话人分段模型 onnx")
    ap.add_argument("--embedding", required=True, help="说话人嵌入模型 onnx")
    ap.add_argument("--audio", required=True, help="16kHz 单声道 PCM wav")
    ap.add_argument("--out", required=True, help="结果 JSON 输出路径")
    ap.add_argument("--speakers", type=int, default=6, help="说话人数量(用户填的)")
    ap.add_argument("--provider", default="auto", choices=["auto", "cpu"],
                    help="推理设备: auto(默认, 先试 CUDA GPU, 失败回退 CPU) / cpu(强制 CPU)")
    args = ap.parse_args()

    try:
        import numpy as np
        import sherpa_onnx

        log("读取音频 …")
        samples, sr = read_wav_mono16k(args.audio)
        dur = len(samples) / float(sr)
        log("音频 %.1fs @ %dHz" % (dur, sr))
        if dur < 0.5:
            raise RuntimeError("音频过短或无有效采样")

        progress(15, "加载分离模型 …")
        t0 = time.time()

        def make_sd(provider):
            cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                        model=args.segmentation),
                    provider=provider),
                embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=args.embedding, provider=provider),
                clustering=sherpa_onnx.FastClusteringConfig(
                    num_clusters=max(1, args.speakers), threshold=0.5),
                min_duration_on=0.3,
                min_duration_off=0.5,
            )
            return sherpa_onnx.OfflineSpeakerDiarization(cfg)

        used = "cpu"
        if args.provider == "auto":
            # 先试 CUDA GPU(与 ASR 共享 CUDA 版 sherpa-onnx / nvidia-* 运行库), 失败回退 CPU ——
            # 说话人分离不强制 GPU, 可用性优先, 但实际用哪个设备必须在日志里写清楚。
            # 注意: CPU 版 sherpa-onnx 遇到 provider='cuda' 不抛异常只打 stderr 警告并静默用 CPU,
            # 所以先用包版本段判断是不是 CUDA 版(1.13.8+cuda12.cudnn9), 不是就不白试。
            cuda_build = False
            ver = ""
            try:
                from importlib.metadata import version as _pkgver
                ver = _pkgver("sherpa-onnx")
                cuda_build = "+cuda" in ver
            except Exception:
                pass
            if cuda_build:
                setup_cuda_dll_paths()
                try:
                    sd = make_sd("cuda")
                    used = "cuda"
                except Exception as e:
                    log("CUDA 初始化失败(%s), 说话人分离回退 CPU 推理"
                        % str(e).strip().split("\n")[0][:120])
                    sd = make_sd("cpu")
            else:
                log("sherpa-onnx %s 为 CPU 版, 说话人分离走 CPU 推理" % (ver or "?"))
                sd = make_sd("cpu")
        else:
            sd = make_sd("cpu")
        log("分离模型加载完成(provider=%s), 耗时 %.1fs" % (used, time.time() - t0))

        progress(30, "区分说话人中 …")
        t1 = time.time()
        last = [0]

        def cb(done, total):
            if total > 0:
                pct = done * 100 // total
                if pct != last[0]:
                    last[0] = pct
                    progress(30 + pct * 55 // 100, "区分说话人中 … %d%%" % pct)
            return 0

        res = sd.process(samples, cb)
        log("分离完成: %d 人 / %d 片段, 耗时 %.1fs"
            % (res.num_speakers, res.num_segments, time.time() - t1))

        regions = [{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": int(s.speaker)}
                   for s in res.sort_by_start_time() if s.end > s.start]

        tmp = args.out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"speakers": res.num_speakers, "regions": regions}, f, ensure_ascii=False)
        os.replace(tmp, args.out)

        progress(100, "分离完成: %d 人" % res.num_speakers)
        log("结果已写入 %s" % args.out)
        return 0

    except Exception as e:
        emit({"type": "error", "msg": str(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
