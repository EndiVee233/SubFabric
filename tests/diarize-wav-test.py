#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""说话人分离的音频读取：正确性 + 长音频峰值内存（回归测试）

为什么单独给读音频写一个测试：
  说话人分离**不做分片**（与识别的 25 分钟分片不同），整段音频一次性读进内存再喂给模型。
  所以"长视频概率失败"里，内存是最容易被怀疑的一环 —— 读音频这一步的峰值必须可测、可回归。

  · 正确性：单声道 / 立体声取平均 / 非 16k 线性重采样，三种输入都要读对；
  · 内存：同一段长音频分别用**旧实现**和**新实现**读，比对峰值 RSS（字节/采样）。
    旧实现 = array('h') 副本 + float32 临时数组（峰值约 8 字节/采样）；
    新实现 = np.frombuffer 零拷贝 + 原地归一化（峰值约 6 字节/采样）。

用法:
    python tests/diarize-wav-test.py                 # 跑全部断言
    python tests/diarize-wav-test.py --probe <wav> --impl new   # 单独量一次(子进程用)
依赖: numpy（与 asr/.venv 同一套依赖；本测试只用到 numpy）
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'asr'))


def write_wav(path, samples_per_channel, sr=16000, channels=1, amp=10000):
    """写一段 16bit PCM wav：斜升锯齿(左声道) / 常数(右声道, 仅立体声), 便于校验取值。"""
    import array
    a = array.array('h')
    for i in range(samples_per_channel):
        v = int((i % 1000) * amp / 1000)
        a.append(max(-32768, min(32767, v)))
        if channels > 1:
            a.append(amp)          # 右声道恒定 → 取平均后可直接验算
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(a.tobytes())
    return path


# ── 两种实现：新的在 asr/diarize.py 里，旧的原样抄在这里做对照 ──────────────
def read_new(path):
    import diarize
    return diarize.read_wav_mono16k(path)


def read_old(path):
    """v2.0.9 之前的实现（逐字保留，仅用于内存对照，不要改）。"""
    import array
    import numpy as np
    SR = 16000
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sr = wf.getframerate()
        width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise RuntimeError("只支持 16-bit PCM wav")
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


def probe_mode(wav, impl):
    """子进程模式: 读一次音频, 用 tracemalloc 量出这次读取的**峰值**分配字节数。

    tracemalloc 能统计到 numpy 的分配(numpy 自带 tracemalloc_domain), 比读进程 RSS 更准,
    也不受平台限制 —— 我们要比的就是"这一次读取额外占了多少", RSS 会把解释器/numpy 自身的
    几十 MB 一起算进来, 反而看不出 6 与 8 字节/采样的差别。
    """
    import tracemalloc
    read = read_new if impl == 'new' else read_old
    tracemalloc.start()
    data, sr = read(wav)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(json.dumps({
        "impl": impl, "samples": int(data.size), "sr": int(sr),
        "nbytes": int(data.nbytes), "peak_bytes": int(peak),
    }))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', help='只量一次该 wav 的读取峰值(供子进程调用)')
    ap.add_argument('--impl', choices=['old', 'new'], default='new')
    args = ap.parse_args()
    if args.probe:
        return probe_mode(args.probe, args.impl)

    import numpy as np

    fails = []
    tmp = tempfile.mkdtemp(prefix='diarize-wav-')

    def check(name, cond, detail=''):
        print(('  ok  ' if cond else '  FAIL') + ' ' + name + (' — ' + detail if detail else ''))
        if not cond:
            fails.append(name)

    # ── ① 单声道 16k: 取值应与 int16/32768 一致 ──
    w = write_wav(os.path.join(tmp, 'mono16k.wav'), 5000)
    d, sr = read_new(w)
    check('单声道 16k: 采样率/长度', sr == 16000 and d.size == 5000, 'sr=%d n=%d' % (sr, d.size))
    expected = np.array([int((i % 1000) * 10000 / 1000) for i in range(5000)], dtype=np.float32) / 32768.0
    check('单声道 16k: 数值一致', bool(np.allclose(d, expected, atol=1e-6)))

    # ── ② 立体声: 左右取平均(右声道恒定 10000 → 平均值可手算) ──
    w = write_wav(os.path.join(tmp, 'stereo16k.wav'), 4000, channels=2)
    d, sr = read_new(w)
    left = np.array([int((i % 1000) * 10000 / 1000) for i in range(4000)], dtype=np.float32) / 32768.0
    right = np.full(4000, 10000 / 32768.0, dtype=np.float32)
    check('立体声: 降为单声道且等于左右平均',
          d.size == 4000 and bool(np.allclose(d, (left + right) / 2.0, atol=1e-6)))

    # ── ③ 8k 输入: 线性重采样到 16k(长度翻倍) ──
    w = write_wav(os.path.join(tmp, 'mono8k.wav'), 2000, sr=8000)
    d, sr = read_new(w)
    check('非 16k: 重采样到 16k', sr == 16000 and abs(d.size - 4000) <= 2, 'sr=%d n=%d' % (sr, d.size))

    # ── ④ 长音频峰值内存: 新实现应明显低于旧实现(约 6 vs 8 字节/采样) ──
    minutes = 30
    n = 16000 * 60 * minutes                 # 30 分钟 @16k 单声道
    w = write_wav(os.path.join(tmp, 'long.wav'), n)
    res = {}
    for impl in ('old', 'new'):
        out = subprocess.run([sys.executable, os.path.abspath(__file__),
                              '--probe', w, '--impl', impl],
                             capture_output=True, text=True)
        if out.returncode != 0:
            print(out.stderr[-800:])
            check('%s 实现可读' % impl, False, '退出码 %d' % out.returncode)
            continue
        r = json.loads(out.stdout.strip().split('\n')[-1])
        r['bytes_per_sample'] = r['peak_bytes'] / float(r['samples']) if r['samples'] else 0
        res[impl] = r
    if 'old' in res and 'new' in res:
        print('  ·  旧实现 %.2f 字节/采样，新实现 %.2f 字节/采样（30 分钟音频）'
              % (res['old']['bytes_per_sample'], res['new']['bytes_per_sample']))
        check('新实现峰值内存不高于旧实现',
              res['new']['bytes_per_sample'] <= res['old']['bytes_per_sample'] + 0.5)
        # 6 字节/采样是理论值(raw 2 + float32 4)，留 1.5 的余量给解释器与碎片
        check('新实现峰值不超过 7.5 字节/采样',
              res['new']['bytes_per_sample'] <= 7.5,
              '实测 %.2f' % res['new']['bytes_per_sample'])
        check('两种实现读数一致(长度/采样率)',
              res['old']['samples'] == res['new']['samples'] and res['old']['sr'] == res['new']['sr'])

    for f in os.listdir(tmp):
        try:
            os.unlink(os.path.join(tmp, f))
        except Exception:
            pass
    try:
        os.rmdir(tmp)
    except Exception:
        pass

    print('\n失败 %d 项' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
