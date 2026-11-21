/*
 * Parakeet log-mel 前端 —— app/mel.py 的 ArkTS 逐行移植。
 *
 * 复刻 NeMo/parakeet 参考实现（即 nemo128.onnx 预处理图）的特征提取：
 *   16 kHz → 25 ms 窗 / 10 ms 跳 → 512 点 FFT → 128 个 Slaney 归一化 mel 滤波器
 *   → ln(x + 2^-24) → 逐 mel bin 的均值方差归一化 → 截断到 ±4
 *
 * 实现要点：
 *   - 纯 ArkTS + TypedArray，无第三方依赖；
 *   - FFT 为自实现的 radix-2 复数 FFT + 实数打包，等价于 np.fft.rfft；
 *   - 所有中间量用 float64 计算，与 NumPy 默认精度对齐，便于与 Python 参考逐位对拍。
 */

export const SAMPLE_RATE: number = 16000;
export const N_FFT: number = 512;
/** 25 ms @ 16 kHz */
export const WIN_LENGTH: number = 400;
/** 10 ms @ 16 kHz */
export const HOP_LENGTH: number = 160;
/**
 * mel 滤波器数量。
 *
 * ⚠️ 由**所选模型**决定，不是自由参数：
 *   - parakeet-tdt-0.6b-v2  -> 128
 *   - parakeet-tdt_ctc-110m -> 80
 * 搞错会让整个特征维度对不上，编码器直接报形状不符。
 * 当前版本配的是 **110M 模型（80）**。
 */
export const N_MELS: number = 80;
export const F_MIN: number = 0.0;
export const F_MAX: number = 8000.0;
/** NeMo 的对数保护项：log(x + 2^-24) */
export const LOG_GUARD: number = Math.pow(2, -24);
export const NORM_EPS: number = 1e-5;
export const NORM_CONST: number = 1.0;
export const NORM_MAX: number = 4.0;

/** mel 帧率：100 帧/秒。 */
export const MEL_FRAME_RATE: number = SAMPLE_RATE / HOP_LENGTH;

/**
 * FFT 工作区：把 twiddle 因子与位反转表预先算好，避免每帧重复三角函数运算。
 * 长度固定为 N_FFT/2 = 256 的复数 FFT。
 */
export class FftWorkspace {
  readonly n: number;
  readonly levels: number;
  /** cos(2πk/n)，k = 0 .. n/2-1 */
  readonly cosTable: Float64Array;
  /** sin(2πk/n) */
  readonly sinTable: Float64Array;
  /** 位反转置换表 */
  readonly rev: Int32Array;

  constructor(n: number) {
    this.n = n;
    let levels = 0;
    while ((1 << levels) < n) {
      levels++;
    }
    if ((1 << levels) !== n) {
      throw new Error(`FFT 长度必须是 2 的幂，收到 ${n}`);
    }
    this.levels = levels;

    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const ang = (2 * Math.PI * k) / n;
      cos[k] = Math.cos(ang);
      sin[k] = Math.sin(ang);
    }
    this.cosTable = cos;
    this.sinTable = sin;

    const rev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      rev[i] = r;
    }
    this.rev = rev;
  }

  /**
   * 原地复数 FFT（radix-2 DIT，位反转输入 / 蝶形输出）。
   * 查表法避免每级三角函数：第 `size` 点的子变换使用步长 n/size 取样 twiddle。
   */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    const rev = this.rev;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    const cosT = this.cosTable;
    const sinT = this.sinTable;

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const l = j + half;
          const wr = cosT[k];
          const wi = -sinT[k];
          const xr = re[l];
          const xi = im[l];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          k += step;
        }
      }
    }
  }
}

/** 可复用的 FFT 缓冲（按实例持有，避免每帧分配）。 */
export class Rfft512 {
  private readonly ws: FftWorkspace;
  private readonly sub = N_FFT >> 1;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly xr: Float64Array;
  private readonly xi: Float64Array;
  /** 输出功率谱，长度 N_FFT/2 + 1 = 257。 */
  readonly power: Float64Array;

  constructor() {
    this.ws = new FftWorkspace(N_FFT >> 1);
    this.re = new Float64Array(this.sub);
    this.im = new Float64Array(this.sub);
    this.xr = new Float64Array(this.sub + 1);
    this.xi = new Float64Array(this.sub + 1);
    this.power = new Float64Array((N_FFT >> 1) + 1);
  }

  /**
   * 实数 FFT 的功率谱：|rfft(frame)|^2，长度 257。
   * 采用「N/2 点复数 FFT + 偶奇分离」标准打包算法。
   */
  computePower(frame: Float64Array): Float64Array {
    const sub = this.sub;
    const re = this.re;
    const im = this.im;
    const xr = this.xr;
    const xi = this.xi;

    for (let j = 0; j < sub; j++) {
      re[j] = frame[2 * j];
      im[j] = frame[2 * j + 1];
    }
    this.ws.transform(re, im);

    // 还原 N 点实数谱：X[k] = (Z[k] + conj(Z[N/2-k]))/2 + e^{-2πik/N}·(Z[k] - conj(Z[N/2-k]))/(2i)
    for (let k = 0; k <= sub; k++) {
      const kk = (sub - k) % sub;
      const ar = re[k];
      const ai = im[k];
      const br = re[kk];
      const bi = -im[kk];
      // E = (Z[k] + conj(Z[m])) / 2
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      // O = (Z[k] - conj(Z[m])) / (2i) = -i/2 · (Z[k] - conj(Z[m]))
      const dr = 0.5 * (ar - br);
      const di = 0.5 * (ai - bi);
      const orr = di;
      const oi = -dr;
      const ang = (-2 * Math.PI * k) / N_FFT;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      xr[k] = er + (orr * wr - oi * wi);
      xi[k] = ei + (orr * wi + oi * wr);
    }

    // 归一化掉 N/2 点 FFT 引入的 2 倍因子，保证与 np.fft.rfft 一致。
    const power = this.power;
    for (let k = 0; k <= sub; k++) {
      const r = xr[k] * 0.5;
      const i = xi[k] * 0.5;
      power[k] = r * r + i * i;
    }
    return power;
  }
}

/** Slaney 的 hz -> mel 映射（librosa 默认）。 */
export function hzToMel(freq: number): number {
  const fMin = 0.0;
  const fSp = 200.0 / 3.0;
  const minLogHz = 1000.0;
  const minLogMel = (minLogHz - fMin) / fSp;
  const logstep = Math.log(6.4) / 27.0;
  if (freq >= minLogHz) {
    return minLogMel + Math.log(Math.max(freq, 1e-10) / minLogHz) / logstep;
  }
  return (freq - fMin) / fSp;
}

/** Slaney 的 mel -> hz 映射。 */
export function melToHz(mel: number): number {
  const fMin = 0.0;
  const fSp = 200.0 / 3.0;
  const minLogHz = 1000.0;
  const minLogMel = (minLogHz - fMin) / fSp;
  const logstep = Math.log(6.4) / 27.0;
  if (mel >= minLogMel) {
    return minLogHz * Math.exp(logstep * (mel - minLogMel));
  }
  return fMin + fSp * mel;
}

/**
 * 生成 [N_MELS, N_FFT/2+1] 的 mel 滤波器组，与 librosa 的
 * `mel(sr, n_fft, n_mels, fmin, fmax, norm='slaney')` 数值一致。
 */
export function melFilterbank(nMels: number = N_MELS, nFft: number = N_FFT,
                             sampleRate: number = SAMPLE_RATE, fMin: number = F_MIN,
                             fMax: number = F_MAX, slaneyNorm: boolean = true): Float64Array {
  const nFreqs = (nFft >> 1) + 1;
  const fb = new Float64Array(nMels * nFreqs);

  // fft 频率轴：np.fft.rfftfreq(n_fft, 1/sr)
  const fftFreqs = new Float64Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) {
    fftFreqs[i] = (i * sampleRate) / nFft;
  }

  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const hzPts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    const mel = melMin + ((melMax - melMin) * i) / (nMels + 1);
    hzPts[i] = melToHz(mel);
  }

  for (let m = 0; m < nMels; m++) {
    const lower = hzPts[m];
    const center = hzPts[m + 1];
    const upper = hzPts[m + 2];
    const leftWidth = center - lower;
    const rightWidth = upper - center;
    const base = m * nFreqs;
    for (let k = 0; k < nFreqs; k++) {
      const f = fftFreqs[k];
      // 上升沿与下降沿取较小值，负值截为 0。
      const rising = leftWidth > 0 ? (f - lower) / leftWidth : 0;
      const falling = rightWidth > 0 ? (upper - f) / rightWidth : 0;
      let w = Math.min(rising, falling);
      if (w < 0) {
        w = 0;
      }
      if (slaneyNorm) {
        // enorm = 2 / (hz_pts[m+2] - hz_pts[m])
        const denom = upper - lower;
        if (denom > 0) {
          w *= 2.0 / denom;
        }
      }
      fb[base + k] = w;
    }
  }
  return fb;
}

/**
 * 有状态的 mel 前端。滤波器组与窗函数在构造时算一次。
 *
 * 注意：与 Python 版一样，`logMel` 本身无状态（归一化是逐句的），
 * 状态只是缓存好的常量表。
 */
export class MelFrontend {
  private readonly fb: Float64Array;
  private readonly window: Float64Array;
  private readonly fft = new Rfft512();
  private readonly nMels: number;
  private readonly nMelsFreqs: number;

  constructor(nMels: number = N_MELS) {
    this.nMels = nMels;
    this.nMelsFreqs = (N_FFT >> 1) + 1;
    this.fb = melFilterbank(nMels);
    // np.hanning(WIN_LENGTH + 1)[:-1] —— 周期 Hann 窗，长度 400。
    const win = new Float64Array(WIN_LENGTH);
    const denom = WIN_LENGTH + 1;
    for (let i = 0; i < WIN_LENGTH; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
    }
    this.window = win;
  }

  /** 单帧功率谱（测试/调试用）。 */
  framePower(samples: Float64Array, offset: number): Float64Array {
    const frame = new Float64Array(WIN_LENGTH);
    const win = this.window;
    for (let i = 0; i < WIN_LENGTH; i++) {
      const idx = offset + i;
      const v = idx < samples.length ? samples[idx] : 0;
      frame[i] = v * win[i];
    }
    return this.fft.computePower(frame);
  }

  /**
   * 计算 log-mel 特征。
   *
   * @param samples 16 kHz 单声道浮点样本
   * @param normalize 是否做逐 bin 均值方差归一化（编码器需要 true）
   * @returns [nMels, nFrames] 的行主序数组，nFrames = 1 + (len - 400) / 160
   */
  logMel(samples: Float64Array, normalize: boolean = true): MelFrameSet {
    const length = samples.length;
    if (length < WIN_LENGTH) {
      const padded = new Float64Array(WIN_LENGTH);
      padded.set(samples.subarray(0, length));
      return this.computeOn(padded, normalize, 1, 1);
    }
    const nFrames = 1 + Math.floor((length - WIN_LENGTH) / HOP_LENGTH);
    return this.computeOn(samples, normalize, nFrames, nFrames);
  }

  /**
   * 定长窗：把样本补零到 `windowFrames` 个 mel 帧（编码器是定长图，必须用这个）。
   *
   * 归一化只统计真实帧，补零位置输出 0 —— 对应参考图里
   * `Where(mask, (x-mu)/(sqrt(var)+eps), 0)` 的语义。
   * 实测（.tmp/probe_mel2.py 变体 C）与「整窗归一化」相比
   * 编码器输出的相对误差仅 1.75e-4。
   *
   * @param samples 16 kHz 单声道样本（不足会自动补零）
   * @param windowFrames 目标 mel 帧数，例如 1501 = 15.01 s
   */
  logMelWindow(samples: Float64Array, windowFrames: number): MelFrameSet {
    const needSamples = (windowFrames - 1) * HOP_LENGTH + WIN_LENGTH;
    let x = samples;
    if (samples.length < needSamples) {
      x = new Float64Array(needSamples);
      x.set(samples);
    }
    // 真实帧数：最后一帧必须完整落在输入长度内。
    let validFrames = 0;
    if (samples.length >= WIN_LENGTH) {
      validFrames = 1 + Math.floor((samples.length - WIN_LENGTH) / HOP_LENGTH);
    } else if (samples.length > 0) {
      validFrames = 1;
    }
    if (validFrames > windowFrames) {
      validFrames = windowFrames;
    }
    return this.computeOn(x, true, windowFrames, validFrames);
  }

  /**
   * @param x 已按需补零的样本
   * @param nFrames 要算的总帧数
   * @param validFrames 参与归一化统计、且保留数值的真实帧数；其余输出 0
   */
  private computeOn(x: Float64Array, normalize: boolean, nFrames: number,
                    validFrames: number): MelFrameSet {
    const nMels = this.nMels;
    const nFreqs = this.nMelsFreqs;
    const fb = this.fb;
    // 行主序 [nMels, nFrames]
    const out = new Float64Array(nMels * nFrames);
    const frame = new Float64Array(WIN_LENGTH);
    const win = this.window;
    const logGuard = LOG_GUARD;

    for (let t = 0; t < nFrames; t++) {
      const off = t * HOP_LENGTH;
      for (let i = 0; i < WIN_LENGTH; i++) {
        const idx = off + i;
        frame[i] = (idx < x.length ? x[idx] : 0) * win[i];
      }
      const power = this.fft.computePower(frame);
      for (let m = 0; m < nMels; m++) {
        const base = m * nFreqs;
        let acc = 0;
        for (let k = 0; k < nFreqs; k++) {
          const w = fb[base + k];
          if (w !== 0) {
            acc += power[k] * w;
          }
        }
        out[m * nFrames + t] = Math.log(acc + logGuard);
      }
    }

    if (!normalize) {
      return new MelFrameSet(out, nMels, nFrames, validFrames);
    }

    // 逐 mel bin：仅用有效帧求均值/方差，再 (x - mean) / (std + eps) 截断到 ±4。
    const n = validFrames > 0 ? validFrames : nFrames;
    for (let m = 0; m < nMels; m++) {
      const base = m * nFrames;
      let sum = 0;
      for (let t = 0; t < n; t++) {
        sum += out[base + t];
      }
      const mean = sum / n;
      let varSum = 0;
      for (let t = 0; t < n; t++) {
        const d = out[base + t] - mean;
        varSum += d * d;
      }
      const std = Math.sqrt(varSum / n);
      const denom = std + NORM_EPS;
      for (let t = 0; t < n; t++) {
        let v = (out[base + t] - mean) / denom;
        if (v > NORM_MAX) {
          v = NORM_MAX;
        } else if (v < -NORM_MAX) {
          v = -NORM_MAX;
        }
        out[base + t] = v * NORM_CONST;
      }
      // padding 位置保持 0。
      for (let t = n; t < nFrames; t++) {
        out[base + t] = 0;
      }
    }
    return new MelFrameSet(out, nMels, nFrames, validFrames);
  }
}

/** [nMels, nFrames] 的 log-mel 结果。 */
export class MelFrameSet {
  /** 行主序数据，长度 nMels * nFrames。 */
  readonly data: Float64Array;
  readonly nMels: number;
  readonly nFrames: number;
  /** 真实帧数（其余为补零），供编码器 `length` 入参使用。 */
  readonly validFrames: number;

  constructor(data: Float64Array, nMels: number, nFrames: number, validFrames: number = nFrames) {
    this.data = data;
    this.nMels = nMels;
    this.nFrames = nFrames;
    this.validFrames = validFrames;
  }

  at(mel: number, frame: number): number {
    return this.data[mel * this.nFrames + frame];
  }
}

/** 16 位小端 PCM 转 float32/float64 样本。 */
export function pcm16ToFloat(pcm: Int16Array): Float64Array {
  const out = new Float64Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i];
  }
  return out;
}

/**
 * 线性重采样到 16 kHz。用于设备麦克风/解码器给出的非 16 k 采样率。
 * 采用带简单抗混叠的低通 + 线性插值；语音识别对精度要求不高，
 * 但对 48 k → 16 k 这种整数倍下采样，先做滑动平均可以显著减少混叠。
 */
export function resampleTo16k(input: Float64Array, sourceRate: number): Float64Array {
  if (sourceRate === SAMPLE_RATE) {
    return input;
  }
  if (sourceRate <= 0 || input.length === 0) {
    return new Float64Array(0);
  }

  let src = input;
  // 整数倍下采样时先做 box 平均抗混叠。
  if (sourceRate > SAMPLE_RATE && sourceRate % SAMPLE_RATE === 0) {
    const factor = sourceRate / SAMPLE_RATE;
    const outLen = Math.floor(input.length / factor);
    const out = new Float64Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let acc = 0;
      const base = i * factor;
      for (let j = 0; j < factor; j++) {
        acc += input[base + j];
      }
      out[i] = acc / factor;
    }
    return out;
  }

  const ratio = SAMPLE_RATE / sourceRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    const a = i0 < src.length ? src[i0] : 0;
    const b = i1 >= 0 ? src[i1] : 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
