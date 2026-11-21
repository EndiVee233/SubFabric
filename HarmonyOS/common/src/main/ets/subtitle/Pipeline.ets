/*
 * 处理流水线：媒体 → 语音检测 → NPU 识别 → 翻译。
 *
 * 这是 app/pipeline.py 的 ArkTS 对应实现，但做了两处面向移动端的重要调整：
 *
 *   1. **平台能力全部通过接口注入**：音频解码（AudioDecoder）、翻译
 *      （ITranslator）、模型后端（IParakeetModel）都由调用方提供实现。
 *      这样本文件保持纯 ArkTS，可以在 PC 上完整跑单元测试。
 *   2. **可取消 + 可挂起**：移动端任务会被系统中断，每一步之间都检查取消标志。
 *
 * 逐行「重新识别」「重新翻译」也在这里，对应 GUI 上的两个按钮。
 */

import { Cue, DecodeStats, MediaInfo, Progress, Stage, WordTiming } from '../model/Cue';
import { ParakeetTdtDecoder, IParakeetModel, detectSpeech, SpeechSegment,
         segmentsFromWords, SegmentOptions } from '../asr/TdtDecoder';
import { SAMPLE_RATE } from '../asr/MelFrontend';

/** 任务被取消。 */
export class CancelledError extends Error {
  constructor(message: string = '已取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** 音频解码能力（鸿蒙侧由 AVCodec/AVDemuxer 或 WAV 解析实现）。 */
export interface IAudioDecoder {
  /**
   * 从媒体文件中解出 16 kHz 单声道 PCM。
   * @param uri 应用沙箱内路径或 fd 对应的路径
   * @param onProgress 0..1
   */
  decodeToPcm16k(uri: string, onProgress?: (ratio: number) => void): Promise<Float64Array>;

  /** 只读取时长等元信息。 */
  probe(uri: string): Promise<MediaInfo>;
}

/** 翻译能力（在线 LLM / 本地模型 / PC 端服务均可实现）。 */
export interface ITranslator {
  /** 后端可读名，用于设置页展示。 */
  backendName(): string;

  /** 是否已配置可用。 */
  isReady(): Promise<boolean>;

  /**
   * 批量翻译。
   * @param texts 待翻译文本
   * @param sourceLang BCP-47 或模型方言，例如 "en"
   * @param targetLang 例如 "zh"
   * @param context 上一句上下文（提升术语一致性），可为空
   */
  translate(texts: string[], sourceLang: string, targetLang: string,
            context?: string): Promise<string[]>;
}

/** 流水线配置。 */
export class PipelineConfig {
  asrDevice: string = 'nnrt';
  sourceLang: string = 'en';
  targetLang: string = 'zh';
  useVad: boolean = true;
  minSilenceSec: number = 0.45;
  maxSegmentSec: number = 14.0;
  /** 翻译时携带的上一句数量。 */
  contextCues: number = 1;
  /** 是否自动翻译。 */
  autoTranslate: boolean = true;
  segmentOptions: SegmentOptions = new SegmentOptions();
}

/** 进度回调。 */
export type ProgressListener = (p: Progress) => void;

/** 新字幕行回调（用于流式上屏）。 */
export type CueListener = (cue: Cue) => void;

/**
 * 流水线。持有模型/解码器/翻译器，任务是异步串行的。
 */
export class Pipeline {
  private readonly decoder: ParakeetTdtDecoder;
  private readonly audioDecoder: IAudioDecoder;
  private readonly translator: ITranslator | null;
  readonly config: PipelineConfig;
  private readonly log: (msg: string) => void;

  private cancelled: boolean = false;
  private audio: Float64Array | null = null;
  /** 最近一次识别的完整统计。 */
  lastStats: DecodeStats = new DecodeStats();

  constructor(model: IParakeetModel, vocab: string[], audioDecoder: IAudioDecoder,
              translator: ITranslator | null, config: PipelineConfig = new PipelineConfig(),
              log?: (msg: string) => void) {
    this.decoder = new ParakeetTdtDecoder(model, vocab, undefined, log);
    this.audioDecoder = audioDecoder;
    this.translator = translator;
    this.config = config;
    this.log = log ?? ((m: string): void => {});
  }

  cancel(): void {
    this.cancelled = true;
  }

  resetCancel(): void {
    this.cancelled = false;
  }

  private checkCancel(): void {
    if (this.cancelled) {
      throw new CancelledError();
    }
  }

  /** 已解码的音频（重新识别时复用，避免重复解码）。 */
  get decodedAudio(): Float64Array | null {
    return this.audio;
  }

  /**
   * 直接识别一段已在内存中的样本（麦克风听写 / 单段测试用）。
   * 不经过解码与 VAD，整段一次识别。
   */
  async transcribeSamples(samples: Float64Array): Promise<string> {
    this.checkCancel();
    const result = await this.decoder.transcribe(samples);
    this.lastStats = result.stats;
    return result.text;
  }

  // ------------------------------------------------------------------ 全量

  /**
   * 完整流程：解码 → VAD → 逐段识别 → 逐段翻译，流式产出字幕行。
   */
  async run(uri: string, onProgress?: ProgressListener,
            onCue?: CueListener): Promise<Cue[]> {
    this.resetCancel();
    const report = (stage: string, message: string, current: number = 0,
                    total: number = 0): void => {
      if (onProgress) {
        const p = new Progress(stage, message, current, total);
        p.elapsedMs = Date.now() - t0;
        onProgress(p);
      }
    };
    const t0 = Date.now();

    report(Stage.DECODE, '正在提取音频…');
    const samples = await this.audioDecoder.decodeToPcm16k(uri,
      (r: number): void => report(Stage.DECODE, '正在提取音频…', Math.round(r * 100), 100));
    this.audio = samples;
    this.checkCancel();
    const duration = samples.length / SAMPLE_RATE;
    this.log(`[音频] 时长 ${duration.toFixed(2)}s`);

    let regions: SpeechSegment[];
    if (this.config.useVad) {
      report(Stage.VAD, '正在检测语音区间…');
      regions = detectSpeech(samples, SAMPLE_RATE, this.config.minSilenceSec,
        this.config.maxSegmentSec);
    } else {
      regions = [];
      const step = this.config.maxSegmentSec;
      let t = 0;
      while (t < duration) {
        regions.push(new SpeechSegment(t, Math.min(duration, t + step)));
        t += step;
      }
    }
    this.log(`[VAD] 检测到 ${regions.length} 个语音区间`);
    this.checkCancel();

    const cues: Cue[] = [];
    const statsTotal = new DecodeStats();
    let idx = 1;

    for (let n = 0; n < regions.length; n++) {
      this.checkCancel();
      const region = regions[n];
      report(Stage.ASR,
        `识别第 ${n + 1}/${regions.length} 段  [${region.start.toFixed(1)}s - ${region.end.toFixed(1)}s]`,
        n, regions.length);

      const newCues = await this.cuesForRegion(region.start, region.end, true);
      if (newCues.length === 0) {
        continue;
      }
      statsTotal.encoderMs += this.lastStats.encoderMs;
      statsTotal.decoderMs += this.lastStats.decoderMs;

      if (this.config.autoTranslate && this.translator !== null) {
        report(Stage.TRANSLATE, `正在翻译第 ${n + 1} 段…`, n, regions.length);
        await this.translateCues(newCues, cues);
      }
      for (let k = 0; k < newCues.length; k++) {
        newCues[k].index = idx;
        idx++;
        cues.push(newCues[k]);
        if (onCue) {
          onCue(newCues[k]);
        }
      }
    }

    statsTotal.audioSeconds = duration;
    statsTotal.tokens = cues.reduce((acc: number, c: Cue): number => acc + c.words.length, 0);
    statsTotal.backend = this.lastStats.backend;
    this.lastStats = statsTotal;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    this.log(`[完成] ${cues.length} 条字幕，用时 ${elapsed}s`);
    report(Stage.DONE, `完成：${cues.length} 条字幕，用时 ${elapsed}s`, cues.length, cues.length);
    return cues;
  }

  // -------------------------------------------------------------- 区域识别

  /** 识别一个时间区间，返回字幕行。 */
  private async cuesForRegion(start: number, end: number, single: boolean): Promise<Cue[]> {
    const audio = this.audio;
    if (audio === null) {
      return [];
    }
    const a = Math.max(0, Math.floor(start * SAMPLE_RATE));
    const b = Math.min(audio.length, Math.ceil(end * SAMPLE_RATE));
    if (b - a < Math.floor(0.05 * SAMPLE_RATE)) {
      return [];
    }
    const chunk = audio.subarray(a, b);
    const result = await this.decoder.transcribe(chunk);
    this.lastStats = result.stats;
    const text = result.text.trim();
    if (text.length === 0) {
      return [];
    }

    const words: WordTiming[] = result.words.map((w: WordTiming): WordTiming =>
      new WordTiming(w.text, w.start + start, w.end + start, w.confidence));

    if (single || text.length <= 90) {
      const cue = new Cue(0, start, end, text, '');
      cue.words = words;
      cue.confidence = meanConfidence(words);
      return [cue];
    }

    // 长段再按标点/停顿切成多条。
    const parts = segmentsFromWords(words, this.config.segmentOptions);
    return parts;
  }

  // ------------------------------------------------------------------ 翻译

  /** 就地把译文写入 cues。context 为已完成的字幕（提供上下文）。 */
  private async translateCues(cues: Cue[], done: Cue[]): Promise<void> {
    const translator = this.translator;
    if (translator === null || cues.length === 0) {
      return;
    }
    const texts = cues.map((c: Cue): string => c.sourceText);
    let context: string | undefined = undefined;
    if (this.config.contextCues > 0 && done.length > 0) {
      const from = Math.max(0, done.length - this.config.contextCues);
      const parts: string[] = [];
      for (let i = from; i < done.length; i++) {
        parts.push(done[i].sourceText);
      }
      context = parts.join('\n');
    }
    try {
      const out = await translator.translate(texts, this.config.sourceLang,
        this.config.targetLang, context);
      for (let i = 0; i < cues.length && i < out.length; i++) {
        cues[i].targetText = out[i];
      }
    } catch (err) {
      const e = err as Error;
      this.log(`[MT] 翻译失败：${e.message}`);
    }
  }

  // ------------------------------------------------------------- 单条重做

  /**
   * 重新识别一条字幕（GUI 上的「重识别」）。
   * 会把行的边界吸附到识别出的词上。
   */
  async retranscribeCue(cue: Cue, pad: number = 0.25): Promise<Cue> {
    this.checkCancel();
    const audio = this.audio;
    const start = Math.max(0, cue.start - pad);
    let end = cue.end + pad;
    if (audio !== null) {
      end = Math.min(audio.length / SAMPLE_RATE, end);
    }
    const results = await this.cuesForRegion(start, end, true);
    if (results.length === 0) {
      return cue;
    }
    const fresh = results[0];
    if (fresh.sourceText.trim().length === 0) {
      return cue;
    }
    cue.sourceText = fresh.sourceText;
    cue.words = fresh.words;
    cue.confidence = fresh.confidence;
    cue.edited = false;
    cue.snapToWords();
    return cue;
  }

  /** 重新翻译一条字幕（GUI 上的「重翻译」）。 */
  async retranslateCue(cue: Cue, context?: string): Promise<Cue> {
    this.checkCancel();
    const translator = this.translator;
    if (translator === null) {
      return cue;
    }
    try {
      const out = await translator.translate([cue.sourceText], this.config.sourceLang,
        this.config.targetLang, context);
      cue.targetText = out.length > 0 ? out[0] : '';
    } catch (err) {
      const e = err as Error;
      this.log(`[MT] 重翻译失败：${e.message}`);
    }
    return cue;
  }

  /**
   * 批量重做：跳过用户手工编辑过的行（与 SubFabric 的行为一致）。
   * @param which 'asr' | 'mt' | 'both'
   */
  async redoCues(cues: Cue[], which: string = 'both',
                 onProgress?: ProgressListener): Promise<void> {
    this.resetCancel();
    for (let i = 0; i < cues.length; i++) {
      this.checkCancel();
      const cue = cues[i];
      if (cue.edited) {
        continue;
      }
      if (onProgress) {
        onProgress(new Progress(which === 'mt' ? Stage.TRANSLATE : Stage.ASR,
          `重做第 ${i + 1}/${cues.length} 条`, i, cues.length));
      }
      if (which === 'asr' || which === 'both') {
        await this.retranscribeCue(cue);
      }
      if (which === 'mt' || which === 'both') {
        await this.retranslateCue(cue);
      }
    }
  }

  /** 把一条字幕的边界吸附到附近真实语音能量上。 */
  findSpeechBounds(start: number, end: number, pad: number = 0.35): number[] {
    const audio = this.audio;
    if (audio === null) {
      return [start, end];
    }
    const sr = SAMPLE_RATE;
    const lo = Math.max(0, Math.floor((start - 1.5) * sr));
    const hi = Math.min(audio.length, Math.ceil((end + 1.5) * sr));
    if (hi - lo < Math.floor(sr / 10)) {
      return [start, end];
    }
    const frame = Math.floor(0.02 * sr);
    const hop = Math.floor(0.01 * sr);
    const n = Math.max(1, 1 + Math.floor((hi - lo - frame) / hop));
    const rms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const base = lo + i * hop;
      let acc = 0;
      for (let j = 0; j < frame; j++) {
        const v = audio[base + j];
        acc += v * v;
      }
      rms[i] = Math.sqrt(acc / frame);
    }
    const sorted = Float64Array.from(rms);
    sorted.sort();
    const p20 = sorted[Math.floor(0.2 * (n - 1))];
    const thr = Math.max(p20 * 3.0, 1e-4);
    const mid = Math.min(Math.max(Math.floor(((start + end) / 2 - lo / sr) / (hop / sr)), 0), n - 1);
    let i = mid;
    while (i > 0 && rms[i - 1] > thr) {
      i--;
    }
    let j = mid;
    while (j < n - 1 && rms[j + 1] > thr) {
      j++;
    }
    return [
      Math.max(0, (lo + i * hop) / sr - pad),
      Math.min(audio.length / sr, (lo + j * hop + frame) / sr + pad)
    ];
  }
}

function meanConfidence(words: WordTiming[]): number {
  if (words.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < words.length; i++) {
    sum += words[i].confidence;
  }
  return sum / words.length;
}
