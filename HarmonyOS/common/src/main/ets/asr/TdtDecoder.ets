/*
 * Parakeet TDT (Token-and-Duration Transducer) 贪心解码器。
 *
 * 移植自 app/asr.py（已在 Intel NPU 上验证可用）。此处刻意**不依赖任何
 * 平台 API**：模型推理通过 IParakeetModel 接口注入，因此
 *   1) 可以在 PC 上用 mock/ONNX 后端对拍 Python 参考实现；
 *   2) 鸿蒙上换成 MindSpore Lite NPU 后端即可，解码逻辑零改动。
 *
 * 算法要点（与 NeMo / sherpa-onnx 一致）：
 *   - 编码器输出帧率 = 100 Hz mel ÷ 8 倍下采样 = 12.5 帧/秒；
 *   - joint 输出 1030 维 = 1025 词表（含 blank=1024）+ 5 个时长头 [0,1,2,3,4]；
 *   - 命中 blank → 按预测时长跳帧；命中非 blank → 提交 LSTM 状态并输出该 token；
 *   - 时长预测为 0 时按 1 处理，否则会死循环；
 *   - 编码器是定长图 [1,128,1501]（= 15.01 s），长音频按重叠窗切分，
 *     LSTM 状态与已解码 token 前缀跨窗延续，窗间再做重叠去重。
 */

import {
  MelFrontend,
  MelFrameSet,
  MEL_FRAME_RATE,
  SAMPLE_RATE,
  HOP_LENGTH,
  WIN_LENGTH
} from './MelFrontend';
import { Cue, DecodeStats, Transcription, WordTiming } from '../model/Cue';

// ------------------------------------------------------------------ 常量

/**
 * mel 滤波器数量 —— 必须与 `MelFrontend.N_MELS` 和模型输入一致。
 *   0.6b-v2 -> 128 ； 110m -> 80
 * 当前配的是 **110M（80）**。改这里时务必同时改 MelFrontend 的同名常量。
 */
export const MEL_BINS: number = 80;
export const BLANK_TOKEN_ID: number = 1024;
/** joint 输出中时长头的偏移（紧跟 1025 维词表之后）。 */
export const DURATION_BINS: number[] = [0, 1, 2, 3, 4];
export const NUM_DURATION_BINS: number = 5;
/** joint 输出总维度 = 1025 + 5。 */
export const JOINT_OUT_DIM: number = BLANK_TOKEN_ID + 1 + NUM_DURATION_BINS;
/** 编码器输入宽度：1501 帧 mel = 15.01 s。 */
export const ENCODER_WINDOW_FRAMES: number = 1501;
export const ENCODER_DOWNSAMPLE: number = 8;
/** 12.5 编码器帧/秒。 */
export const ENCODER_FRAME_RATE: number = MEL_FRAME_RATE / ENCODER_DOWNSAMPLE;
/** SentencePiece 词边界标记。 */
export const WORD_BOUNDARY: string = '\u2581';
/** 输出层大小（词表 + 时长头）。 */
const DEFAULT_JOINT_OUT_DIM: number = JOINT_OUT_DIM;

// ------------------------------------------------------------------ 接口

/**
 * 编码器输出：定长窗的声学表征。
 * activations 为行主序 [nFrames, hidden]，nFrames 对应 validFrames / 8。
 */
export class EncoderOutput {
  /** 行主序 [nFrames, hidden]。 */
  readonly activations: Float32Array;
  readonly nFrames: number;
  readonly hidden: number;
  /** 有效帧数（padding 之外的编码器帧数）。 */
  readonly validFrames: number;

  constructor(activations: Float32Array, nFrames: number, hidden: number, validFrames: number) {
    this.activations = activations;
    this.nFrames = nFrames;
    this.hidden = hidden;
    this.validFrames = validFrames;
  }

  /** 取第 t 帧的 hidden 维向量并按需转成 float32 连续块。 */
  frame(t: number): Float32Array {
    const out = new Float32Array(this.hidden);
    const base = t * this.hidden;
    for (let i = 0; i < this.hidden; i++) {
      out[i] = this.activations[base + i];
    }
    return out;
  }
}

/** joint 网络单步输出。 */
export class JointStepOutput {
  /** 当前帧的 logits，长度 jointOutDim（1030）。 */
  readonly logits: Float32Array;
  /** 更新后的 LSTM 隐状态 [2,1,decHidden]。 */
  readonly hidden: Float32Array;
  /** 更新后的 LSTM 细胞状态 [2,1,decHidden]。 */
  readonly cell: Float32Array;

  constructor(logits: Float32Array, hidden: Float32Array, cell: Float32Array) {
    this.logits = logits;
    this.hidden = hidden;
    this.cell = cell;
  }
}

/**
 * 声学模型后端。鸿蒙上由 MindSpore Lite(NPU) 实现；PC 上由 ONNX Runtime 实现；
 * 单元测试里由假实现驱动。
 */
export interface IParakeetModel {
  /** 编码器 hidden 维（parakeet-tdt-0.6b 为 1024）。 */
  encoderHidden(): number;

  /** 预测网络/LSTM hidden 维（640）。 */
  decoderHidden(): number;

  /** joint 输出维度（1030）。 */
  jointOutDim(): number;

  /** 载入模型（幂等）。 */
  load(): Promise<void>;

  /** 是否已载入。 */
  isLoaded(): boolean;

  /** 后端可读名称，例如 "MindSpore Lite / NPU"。 */
  backendName(): string;

  /** 释放资源。 */
  release(): Promise<void>;

  /**
   * 运行编码器。
   * @param mel 行主序 [128, 1501] 的归一化 log-mel
   * @param validFrames 有效 mel 帧数（其余为补零）
   */
  runEncoder(mel: Float32Array, validFrames: number): Promise<EncoderOutput>;

  /**
   * 运行预测网络 + joint 网络单步。
   * @param token 上一个非 blank token（初始为 blank）
   * @param hidden LSTM 隐状态 [2,1,decHidden]
   * @param cell LSTM 细胞状态 [2,1,decHidden]
   * @param frameIndex 当前编码器帧下标（joint 只需该帧）
   */
  runJoint(token: number, hidden: Float32Array, cell: Float32Array,
           frameIndex: number): Promise<JointStepOutput>;
}

/** LSTM 预测网络状态（跨编码器窗口延续）。 */
export class TdtState {
  hidden: Float32Array;
  cell: Float32Array;
  /** 上一个提交的 token；窗口开始时继承上一窗的最后一个 token。 */
  lastToken: number;

  constructor(hidden: Float32Array, cell: Float32Array, lastToken: number = BLANK_TOKEN_ID) {
    this.hidden = hidden;
    this.cell = cell;
    this.lastToken = lastToken;
  }

  static zeros(decoderHidden: number): TdtState {
    return new TdtState(
      new Float32Array(2 * decoderHidden),
      new Float32Array(2 * decoderHidden),
      BLANK_TOKEN_ID);
  }

  clone(): TdtState {
    return new TdtState(this.hidden.slice(), this.cell.slice(), this.lastToken);
  }
}

/** 逐 token 时间戳。 */
export class TokenTiming {
  readonly tokenId: number;
  frameIndex: number;
  readonly confidence: number;

  constructor(tokenId: number, frameIndex: number, confidence: number) {
    this.tokenId = tokenId;
    this.frameIndex = frameIndex;
    this.confidence = confidence;
  }
}

// ------------------------------------------------------------------ 静音检测

/** 语音区间。 */
export class SpeechSegment {
  readonly start: number;
  readonly end: number;

  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }

  get duration(): number {
    return this.end - this.start;
  }
}

/**
 * 能量 VAD（app/audio.py::detect_speech 的对应实现）。
 *
 * 思路：20 ms 窗 / 10 ms 跳求 RMS，用噪声底（低分位）乘系数得阈值，
 * 再按最短静音切分、按最长片段裁剪、丢弃过短区间。
 */
export function detectSpeech(samples: Float64Array, sampleRate: number = SAMPLE_RATE,
                             minSilenceSec: number = 0.45,
                             maxSegmentSec: number = 14.0,
                             minSpeechSec: number = 0.25): SpeechSegment[] {
  const frame = Math.max(1, Math.round(0.02 * sampleRate));
  const hop = Math.max(1, Math.round(0.01 * sampleRate));
  const n = samples.length;
  if (n < frame) {
    return [];
  }
  const nFrames = 1 + Math.floor((n - frame) / hop);

  const rms = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const base = i * hop;
    let acc = 0;
    for (let j = 0; j < frame; j++) {
      const v = samples[base + j];
      acc += v * v;
    }
    rms[i] = Math.sqrt(acc / frame);
  }

  // 噪声底：取 20% 分位，阈值 = max(3×噪声底, 绝对下限)。
  const sorted = Float64Array.from(rms);
  sorted.sort();
  const p20 = sorted[Math.floor(0.2 * (nFrames - 1))];
  const peak = sorted[nFrames - 1];
  let thr = Math.max(p20 * 3.0, peak * 0.02);
  if (thr < 1e-6) {
    // 近乎全静音。
    return [];
  }

  const voiced = new Uint8Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    voiced[i] = rms[i] > thr ? 1 : 0;
  }

  // 填充短于 minSilence 的静音洞（避免把词内停顿切开）。
  const maxSilFrames = Math.max(1, Math.round(minSilenceSec / (hop / sampleRate)));
  let i = 0;
  while (i < nFrames) {
    if (voiced[i] === 0) {
      let j = i;
      while (j < nFrames && voiced[j] === 0) {
        j++;
      }
      // 只有内部静音洞才填。
      if (i > 0 && j < nFrames && (j - i) <= maxSilFrames) {
        for (let k = i; k < j; k++) {
          voiced[k] = 1;
        }
      }
      i = j;
    } else {
      i++;
    }
  }

  // 提取连续有声段。
  const raw: SpeechSegment[] = [];
  i = 0;
  while (i < nFrames) {
    if (voiced[i] === 1) {
      let j = i;
      while (j < nFrames && voiced[j] === 1) {
        j++;
      }
      const startSec = (i * hop) / sampleRate;
      const endSec = Math.min(n / sampleRate, (j * hop + frame) / sampleRate);
      if (endSec - startSec >= minSpeechSec) {
        raw.push(new SpeechSegment(startSec, endSec));
      }
      i = j;
    } else {
      i++;
    }
  }

  // 按最大时长切分过长的段。
  const out: SpeechSegment[] = [];
  for (let s = 0; s < raw.length; s++) {
    const seg = raw[s];
    if (seg.duration <= maxSegmentSec) {
      out.push(seg);
      continue;
    }
    let t = seg.start;
    while (t < seg.end) {
      const e = Math.min(seg.end, t + maxSegmentSec);
      if (e - t >= minSpeechSec) {
        out.push(new SpeechSegment(t, e));
      }
      t = e;
    }
  }
  return out;
}

// ------------------------------------------------------------------ 解码器

/** 解码配置。 */
export class DecoderConfig {
  /** 每个编码器帧最多允许连续输出多少个 token（防御性上限）。 */
  maxSymbolsPerFrame: number = 10;
  /** 末尾冲刷时最多补多少个 token。 */
  flushSymbols: number = 8;
  /** 跨窗去重时向前回溯比对的最大 token 数。 */
  dedupeWindow: number = 15;
}

/** 词级时间戳重建结果。 */
export class WordResult {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;

  constructor(text: string, start: number, end: number, confidence: number) {
    this.text = text;
    this.start = start;
    this.end = end;
    this.confidence = confidence;
  }
}

/**
 * Parakeet TDT 识别器：mel 前端 + 编码器 + 贪心 TDT 解码。
 */
export class ParakeetTdtDecoder {
  private readonly model: IParakeetModel;
  private readonly mel: MelFrontend;
  private readonly config: DecoderConfig;
  private vocab: string[] = [];
  private log: (msg: string) => void;

  constructor(model: IParakeetModel, vocab: string[],
              config: DecoderConfig = new DecoderConfig(), log?: (msg: string) => void) {
    this.model = model;
    this.vocab = vocab;
    this.mel = new MelFrontend(MEL_BINS);
    this.config = config;
    this.log = log ?? ((msg: string): void => {});
  }

  // ---------------------------------------------------------- 词表 / 反分词

  /** 取 token 对应的 SentencePiece 片段。 */
  piece(tokenId: number): string {
    if (tokenId >= 0 && tokenId < this.vocab.length) {
      return this.vocab[tokenId];
    }
    return '';
  }

  /** 判断 token 是否为句末标点（跨窗去重时用）。 */
  isPunctuation(tokenId: number): boolean {
    let p = this.piece(tokenId);
    if (p.startsWith(WORD_BOUNDARY)) {
      p = p.substring(WORD_BOUNDARY.length);
    }
    return p === '.' || p === '?' || p === '!';
  }

  /**
   * SentencePiece 反分词。
   *
   * 词边界来自片段上的 `▁` 前缀；一个**裸 `▁` 片段**本身也是显式边界
   * （模型会用 `▁many ▁ es ca pe` 这种切法表示 "many escape"）；
   * 不带标记的片段是续接，直接追加。
   */
  decodeTokens(tokenIds: number[]): string {
    let out = '';
    let pendingSpace = false;
    for (let i = 0; i < tokenIds.length; i++) {
      const tid = tokenIds[i];
      if (tid === BLANK_TOKEN_ID || tid < 0) {
        continue;
      }
      let piece = this.piece(tid);
      if (piece.length === 0) {
        continue;
      }
      if (piece === WORD_BOUNDARY) {
        pendingSpace = true;
        continue;
      }
      const leading = piece.startsWith(WORD_BOUNDARY);
      if (leading) {
        piece = piece.substring(WORD_BOUNDARY.length);
      }
      if (piece.length === 0) {
        continue;
      }
      if (out.length > 0 && (leading || pendingSpace)) {
        out += ' ';
      }
      pendingSpace = false;
      out += piece;
    }
    return out.trim();
  }

  /**
   * 由 token 流重建词级时间戳（卡拉OK 逐词染色的基础）。
   * 与 Python 版 _words_from_tokens 行为一致：`▁` 前缀开启新词，
   * 末尾用 +2 帧的余量收口。
   */
  wordsFromTokens(tokens: number[], timings: TokenTiming[]): WordResult[] {
    if (tokens.length === 0 || timings.length === 0) {
      return [];
    }
    const frameToS = 1.0 / ENCODER_FRAME_RATE;
    const words: WordResult[] = [];
    let cur = '';
    let curStart = 0;
    let curConfSum = 0;
    let curConfN = 0;
    let pendingSpace = false;

    const flush = (endTime: number): void => {
      if (cur.length === 0) {
        return;
      }
      const text = cur.trim();
      if (text.length > 0) {
        const start = timings[curStart].frameIndex * frameToS;
        const end = Math.max(endTime, start + 0.08);
        const conf = curConfN > 0 ? curConfSum / curConfN : 0;
        words.push(new WordResult(text, start, end, conf));
      }
      cur = '';
      curConfSum = 0;
      curConfN = 0;
    };

    for (let i = 0; i < tokens.length && i < timings.length; i++) {
      const piece = this.piece(tokens[i]);
      if (piece === WORD_BOUNDARY) {
        pendingSpace = true;
        continue;
      }
      const leading = piece.startsWith(WORD_BOUNDARY);
      const clean = leading ? piece.substring(WORD_BOUNDARY.length) : piece;
      if (clean.length === 0) {
        continue;
      }
      if ((leading || pendingSpace) && cur.length > 0) {
        flush(timings[i].frameIndex * frameToS);
        curStart = i;
      } else if (cur.length === 0) {
        curStart = i;
      }
      pendingSpace = false;
      cur += clean;
      curConfSum += timings[i].confidence;
      curConfN++;
    }
    const tail = (timings[timings.length - 1].frameIndex + 2) * frameToS;
    flush(tail);
    return words;
  }

  // ---------------------------------------------------------------- 主流程

  /** 识别一段 16 kHz 单声道音频。 */
  async transcribe(samplesIn: Float64Array): Promise<Transcription> {
    if (!this.model.isLoaded()) {
      await this.model.load();
    }

    // ================== 强制 NPU 闸门 ==================
    //
    // 每次识别开始前校验后端。只要不是 NPU 就**立刻失败**，
    // 绝不进入 CPU 推理分支。这样能保证：
    //   1. 性能与行为可预期，不会悄悄退化成 CPU 跑几十秒；
    //   2. 日志里明确看到「被拦下」，而不是「跑完了但结果不对」。
    //
    // 放在这里而不是只在 load() 里做：模型可能被复用，
    // 每次 transcribe 都应独立确认后端。
    const backendName = this.model.backendName();
    const lower = backendName.toLowerCase();
    const isNpu = lower.indexOf('npu') >= 0 || lower.indexOf('nnrt') >= 0;
    if (!isNpu) {
      const msg = `已禁用 CPU 推理，但当前后端是「${backendName}」。识别终止。`;
      this.log(`[中止] ${msg}`);
      throw new Error(msg);
    }
    this.log(`[后端] ${backendName}（已确认走 NPU）`);

    const samples = samplesIn;
    const stats = new DecodeStats();
    stats.audioSeconds = samples.length / SAMPLE_RATE;
    stats.backend = this.model.backendName();

    if (samples.length < 400) {
      return new Transcription('');
    }

    // 全局帧数：决定需要跑几个编码器窗。逐窗前端会各自重算归一化，
    // 这里只用等价的帧数公式确定循环边界。
    const frames = 1 + Math.floor((samples.length - WIN_LENGTH) / HOP_LENGTH);
    if (frames <= 0) {
      return new Transcription('');
    }

    const maxFrames = ENCODER_WINDOW_FRAMES;
    const overlap = Math.max(4, Math.floor(maxFrames / 9));
    const encHidden = this.model.encoderHidden();
    const decHidden = this.model.decoderHidden();

    const tokens: number[] = [];
    const timings: TokenTiming[] = [];
    let lastGlobalFrame = 0;
    let haveLast = false;
    let chunkIdx = 0;
    let offset = 0;

    const state = TdtState.zeros(decHidden);
    const samplePerFrame = HOP_LENGTH;
    const windowSamples = (maxFrames - 1) * samplePerFrame + WIN_LENGTH;

    while (offset < frames) {
      const size = Math.floor(Math.min(maxFrames, frames - offset));
      const isLast = (offset + size) >= frames;

      // 逐窗重新做前端：归一化是**按窗**统计的，与参考实现一致。
      // 传入的样本比本窗实际需要略多，logMelWindow 只取需要的前缀。
      const sampleStart = offset * samplePerFrame;
      const sampleEnd = Math.min(samples.length, sampleStart + windowSamples);
      const chunk = samples.subarray(sampleStart, sampleEnd);
      const melWin = this.mel.logMelWindow(chunk, maxFrames);

      // [nMels, maxFrames] 行主序 float64 -> 编码器需要的 float32 布局。
      const windowBuf = new Float32Array(MEL_BINS * maxFrames);
      for (let i = 0; i < windowBuf.length; i++) {
        windowBuf[i] = melWin.data[i];
      }

      const tEnc = Date.now();
      const enc: EncoderOutput = await this.model.runEncoder(windowBuf, melWin.validFrames);
      stats.encoderMs += Date.now() - tEnc;

      const tDec = Date.now();
      const res = await this.decodeWindow(enc, state, isLast);
      stats.decoderMs += Date.now() - tDec;
      for (let k = 0; k < res.timings.length; k++) {
        res.timings[k].frameIndex += offset;
      }

      if (chunkIdx === 0) {
        for (let k = 0; k < res.tokens.length; k++) {
          tokens.push(res.tokens[k]);
          timings.push(res.timings[k]);
        }
      } else {
        let skip = 0;
        // 丢掉落在上一窗已覆盖帧范围内的 token。
        if (haveLast) {
          while (skip < res.timings.length && res.timings[skip].frameIndex <= lastGlobalFrame) {
            skip++;
          }
        }
        // 边界处重复的句末标点。
        if (skip < res.tokens.length && tokens.length > 0 &&
            res.tokens[skip] === tokens[tokens.length - 1] &&
            this.isPunctuation(res.tokens[skip])) {
          skip++;
        }
        // 最长后缀/前缀重叠比对。
        const window = Math.min(this.config.dedupeWindow, tokens.length, res.tokens.length - skip);
        for (let length = window; length > 1; length--) {
          let match = true;
          for (let k = 0; k < length; k++) {
            if (tokens[tokens.length - length + k] !== res.tokens[skip + k]) {
              match = false;
              break;
            }
          }
          if (match) {
            skip += length;
            break;
          }
        }
        // 非末窗时，本窗重叠区内的 token 留给下一窗处理。
        let emitEnd = res.tokens.length;
        if (!isLast && res.timings.length > 0) {
          const boundary = size > overlap ? size - overlap : 0;
          for (let idx = 0; idx < res.timings.length; idx++) {
            const local = res.timings[idx].frameIndex - offset;
            if (local >= boundary) {
              emitEnd = Math.min(emitEnd, idx);
              break;
            }
          }
        }
        for (let k = skip; k < emitEnd; k++) {
          tokens.push(res.tokens[k]);
          timings.push(res.timings[k]);
        }
      }

      if (timings.length > 0) {
        lastGlobalFrame = timings[timings.length - 1].frameIndex;
        haveLast = true;
      }
      chunkIdx++;
      if (isLast) {
        break;
      }
      offset += (maxFrames - overlap);
    }

    stats.chunks = chunkIdx;
    stats.tokens = tokens.length;
    const text = this.decodeTokens(tokens);
    const wordResults = this.wordsFromTokens(tokens, timings);
    const duration = samples.length / SAMPLE_RATE;

    const out = new Transcription(text);
    out.stats = stats;
    out.words = wordResults.map((w: WordResult): WordTiming => {
      const end = w.end > duration ? duration : w.end;
      return new WordTiming(w.text, w.start, end, w.confidence);
    });
    // 隐藏维用于外部校验。
    if (encHidden <= 0) {
      this.log('encoder hidden 维度异常');
    }
    return out;
  }

  /** 单个编码器窗的贪心 TDT 解码；会就地更新 state。 */
  private async decodeWindow(enc: EncoderOutput, state: TdtState,
                             isLast: boolean): Promise<WindowDecodeResult> {
    const res = new WindowDecodeResult();
    const validFrames = Math.min(enc.validFrames, enc.nFrames);
    if (validFrames <= 0) {
      return res;
    }

    let lastToken = state.lastToken;
    let frame = 0;

    while (frame < validFrames) {
      let emittedThisFrame = 0;
      // 同一个编码器帧内可能连续输出多个 token（时长预测为 0 时）。
      while (frame < validFrames) {
        const step = await this.model.runJoint(lastToken, state.hidden, state.cell, frame);
        const stepRes = this.pick(step, frame);
        let dur = stepRes.duration;
        if (dur <= 0) {
          dur = 1;
        }

        if (stepRes.token === BLANK_TOKEN_ID) {
          frame = Math.min(frame + dur, validFrames);
          emittedThisFrame = 0;
          break;
        }

        res.tokens.push(stepRes.token);
        res.timings.push(new TokenTiming(stepRes.token, frame, stepRes.confidence));
        lastToken = stepRes.token;
        state.hidden = step.hidden;
        state.cell = step.cell;
        state.lastToken = stepRes.token;
        frame = Math.min(frame + dur, validFrames);
        emittedThisFrame++;
        if (emittedThisFrame >= this.config.maxSymbolsPerFrame) {
          break;
        }
      }
    }

    // 末窗冲刷：预测网络往往还有几个想吐的 token。
    if (isLast && res.tokens.length > 0) {
      const lastFrame = Math.max(0, validFrames - 1);
      for (let n = 0; n < this.config.flushSymbols; n++) {
        const step = await this.model.runJoint(lastToken, state.hidden, state.cell, lastFrame);
        const stepRes = this.pick(step, lastFrame);
        if (stepRes.token === BLANK_TOKEN_ID) {
          break;
        }
        res.tokens.push(stepRes.token);
        res.timings.push(new TokenTiming(stepRes.token, lastFrame, stepRes.confidence));
        lastToken = stepRes.token;
        state.hidden = step.hidden;
        state.cell = step.cell;
        state.lastToken = stepRes.token;
      }
    }
    return res;
  }

  /** 从 joint 输出里取当前帧的 argmax(token) / argmax(duration)。 */
  private pick(step: JointStepOutput, frame: number): PickResult {
    const outDim = this.model.jointOutDim();
    const vocabSize = BLANK_TOKEN_ID + 1;
    // 某些导出把 logits 铺成 [1, T, 1030]；此处同时兼容「单帧」与「整窗」两种排布。
    let base = 0;
    const perFrame = outDim > 0 ? outDim : DEFAULT_JOINT_OUT_DIM;
    if (step.logits.length >= perFrame * (frame + 1)) {
      base = frame * perFrame;
    }

    let bestToken = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < vocabSize; i++) {
      const v = step.logits[base + i];
      if (v > bestScore) {
        bestScore = v;
        bestToken = i;
      }
    }

    let bestDurIdx = 0;
    let bestDurScore = -Infinity;
    for (let d = 0; d < NUM_DURATION_BINS; d++) {
      const v = step.logits[base + vocabSize + d];
      if (v > bestDurScore) {
        bestDurScore = v;
        bestDurIdx = d;
      }
    }
    return new PickResult(bestToken, DURATION_BINS[bestDurIdx], bestScore);
  }
}

class PickResult {
  readonly token: number;
  readonly duration: number;
  readonly confidence: number;

  constructor(token: number, duration: number, confidence: number) {
    this.token = token;
    this.duration = duration;
    this.confidence = confidence;
  }
}

class WindowDecodeResult {
  tokens: number[] = [];
  timings: TokenTiming[] = [];
}

// ------------------------------------------------------------------ 分句

/** 分句参数。 */
export class SegmentOptions {
  maxChars: number = 84;
  maxDuration: number = 7.0;
  minDuration: number = 0.8;
  gapSplit: number = 0.7;
}

/**
 * 把词级结果聚合成字幕行（app/asr.py::segments_from_words 的对应实现）。
 * 优先在句末标点、长停顿、超长时断开。
 */
export function segmentsFromWords(words: WordTiming[],
                                  opts: SegmentOptions = new SegmentOptions()): Cue[] {
  const cues: Cue[] = [];
  let cur: WordTiming[] = [];

  const flush = (): void => {
    if (cur.length === 0) {
      return;
    }
    let text = '';
    for (let i = 0; i < cur.length; i++) {
      text += (i > 0 ? ' ' : '') + cur[i].text;
    }
    text = text.trim();
    if (text.length === 0) {
      cur = [];
      return;
    }
    let confSum = 0;
    let confN = 0;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].confidence > 0) {
        confSum += cur[i].confidence;
        confN++;
      }
    }
    const start = cur[0].start;
    const end = Math.max(cur[cur.length - 1].end, start + 0.3);
    const cue = new Cue(cues.length + 1, start, end, text, '');
    cue.confidence = confN > 0 ? confSum / confN : 0;
    cue.words = cur.map((w: WordTiming): WordTiming => w.clone());
    cues.push(cue);
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (cur.length > 0) {
      const gap = word.start - cur[cur.length - 1].end;
      let projected = 0;
      for (let k = 0; k < cur.length; k++) {
        projected += cur[k].text.length + 1;
      }
      projected += word.text.length;
      const duration = word.end - cur[0].start;
      if (gap > opts.gapSplit || projected > opts.maxChars || duration > opts.maxDuration) {
        flush();
      }
    }
    cur.push(word);
    const last = word.text;
    const endsSentence = last.endsWith('.') || last.endsWith('?') || last.endsWith('!') ||
      last.endsWith('\u3002') || last.endsWith('\uFF1F') || last.endsWith('\uFF01');
    if (endsSentence && cur.length > 0 && (word.end - cur[0].start) >= opts.minDuration) {
      flush();
    }
  }
  flush();
  return cues;
}
