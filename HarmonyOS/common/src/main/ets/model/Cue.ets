/*
 * SubFabric HarmonyOS — 字幕数据模型
 *
 * 对应 SubFabric 的 Cue 模型（editor/js/project.js）与
 * Parakeet Studio 的 app/subtitles.py::Cue。
 *
 * 设计约束（ArkTS）：
 *   - 不使用索引签名 / 结构化 typing，跨模块数据一律用具名类承载；
 *   - 数值类型统一 number（ArkTS 的 number 为 double）。
 */

/** 逐词时间戳：卡拉OK 逐词染色的最小单位。 */
export class WordTiming {
  /** 词面文本（不含空格）。 */
  text: string = '';
  /** 起始时间（秒，整片绝对时间轴）。 */
  start: number = 0;
  /** 结束时间（秒）。 */
  end: number = 0;
  /** 置信度 0..1；未知时为 0。 */
  confidence: number = 0;

  constructor(text: string, start: number, end: number, confidence: number = 0) {
    this.text = text;
    this.start = start;
    this.end = end;
    this.confidence = confidence;
  }

  clone(): WordTiming {
    return new WordTiming(this.text, this.start, this.end, this.confidence);
  }
}

/** 一条字幕。sourceText 为原文（识别结果），targetText 为译文。 */
export class Cue {
  /** 序号，从 1 开始；导出时重排。 */
  index: number = 0;
  /** 起始时间（秒）。 */
  start: number = 0;
  /** 结束时间（秒）。 */
  end: number = 0;
  /** 原文（识别文本）。 */
  sourceText: string = '';
  /** 译文。 */
  targetText: string = '';
  /** 是否被用户手工编辑过（编辑过的行不会被批量重做覆盖）。 */
  edited: boolean = false;
  /** 是否已完成逐词校对。旧项目有逐词时间时默认视为已校对。 */
  wordChecked: boolean = true;
  /** 识别置信度 0..1。 */
  confidence: number = 0;
  /** 逐词时间戳，空数组表示该行没有逐词数据（此时不能做逐词卡拉OK）。 */
  words: WordTiming[] = [];
  /** 当前行说话人（可覆盖文本开头的 [Name] 标签）。 */
  speaker: string = '';
  /** 说话人颜色（#RRGGBB），用于人物圆点和字幕说话人标签。 */
  speakerColor: string = '';
  /** 当前 ASS 行解析出的中文字幕颜色（#RRGGBB）。 */
  targetColor: string = '';
  /** 当前 ASS 行解析出的英文字幕未高亮颜色（#RRGGBB）。 */
  sourceColor: string = '';
  /** 当前 ASS 行解析出的英文逐词高亮颜色（#RRGGBB）。 */
  wordColor: string = '';

  constructor(index: number = 0, start: number = 0, end: number = 0,
              sourceText: string = '', targetText: string = '') {
    this.index = index;
    this.start = start;
    this.end = end;
    this.sourceText = sourceText;
    this.targetText = targetText;
  }

  get duration(): number {
    return this.end - this.start;
  }

  /** 是否有可用的逐词时间戳。 */
  get hasWords(): boolean {
    return this.words.length > 0;
  }

  /**
   * 与 Python 版一致的回退语义：优先取译文，没有译文时退回原文。
   * 导出 SRT/VTT 时使用。
   */
  bestText(): string {
    const t = this.targetText.trim();
    if (t.length > 0) {
      return t;
    }
    return this.sourceText.trim();
  }

  clone(): Cue {
    const c = new Cue(this.index, this.start, this.end, this.sourceText, this.targetText);
    c.edited = this.edited;
    c.wordChecked = this.wordChecked;
    c.confidence = this.confidence;
    c.words = this.words.map((w: WordTiming): WordTiming => w.clone());
    c.speaker = this.speaker;
    c.speakerColor = this.speakerColor;
    c.targetColor = this.targetColor;
    c.sourceColor = this.sourceColor;
    c.wordColor = this.wordColor;
    return c;
  }

  /** 把行的边界吸附到逐词时间戳上（识别后修正边界用）。 */
  snapToWords(minDuration: number = 0.2, lead: number = 0.05, tail: number = 0.15): Cue {
    if (this.words.length === 0) {
      return this;
    }
    const first = this.words[0];
    const last = this.words[this.words.length - 1];
    this.start = Math.max(0, first.start - lead);
    this.end = Math.max(this.start + minDuration, last.end + tail);
    return this;
  }
}

/** 视频 / 音频源信息。 */
export class MediaInfo {
  /** 用户可见的显示名。 */
  displayName: string = '';
  /** 应用沙箱内的绝对路径。 */
  uri: string = '';
  /** 时长（秒）。 */
  durationSec: number = 0;
  /** 视频宽（音频源为 0）。 */
  width: number = 0;
  /** 视频高。 */
  height: number = 0;
  /** 是否含视频轨。 */
  hasVideo: boolean = false;

  constructor(displayName: string = '', uri: string = '', durationSec: number = 0) {
    this.displayName = displayName;
    this.uri = uri;
    this.durationSec = durationSec;
  }
}

/**
 * 处理阶段，用于进度上报。
 *
 * 用「类 + static readonly 字符串」而不是 `enum`：字符串枚举在 ArkTS 里
 * 支持但容易踩跨模块取值的问题，而纯 TypeScript 的类型擦除运行时不支持
 * enum（本项目要在 Node 上跑核心模块的单元测试）。字符串常量两边都稳。
 */
export class Stage {
  static readonly IDLE: string = 'idle';
  static readonly DECODE: string = 'decode';
  static readonly VAD: string = 'vad';
  static readonly ASR: string = 'asr';
  static readonly TRANSLATE: string = 'translate';
  static readonly DONE: string = 'done';
  static readonly CANCELLED: string = 'cancelled';
  static readonly ERROR: string = 'error';
}

/** 一次任务的可观察进度。 */
export class Progress {
  stage: string = Stage.IDLE;
  current: number = 0;
  total: number = 0;
  message: string = '';
  /** 已完成用时（毫秒）。 */
  elapsedMs: number = 0;

  constructor(stage: string = Stage.IDLE, message: string = '',
              current: number = 0, total: number = 0) {
    this.stage = stage;
    this.message = message;
    this.current = current;
    this.total = total;
  }

  get ratio(): number {
    if (this.total <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, this.current / this.total));
  }
}

/** 识别统计，用于「模型与性能」面板。 */
export class DecodeStats {
  preprocessMs: number = 0;
  encoderMs: number = 0;
  decoderMs: number = 0;
  chunks: number = 0;
  tokens: number = 0;
  audioSeconds: number = 0;
  /** 实际生效的推理后端，例如 "NPU" / "CPU" / "CPU(int8)"。 */
  backend: string = '';

  get totalMs(): number {
    return this.preprocessMs + this.encoderMs + this.decoderMs;
  }

  /** 实时倍速：>1 表示比实时快。 */
  get rtfx(): number {
    if (this.totalMs <= 0 || this.audioSeconds <= 0) {
      return 0;
    }
    return this.audioSeconds / (this.totalMs / 1000);
  }
}

/** 识别结果。 */
export class Transcription {
  text: string = '';
  words: WordTiming[] = [];
  stats: DecodeStats = new DecodeStats();

  constructor(text: string = '') {
    this.text = text;
  }
}
