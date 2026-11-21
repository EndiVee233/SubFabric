/*
 * 轻量日志。带标签、带级别过滤，并保留最近若干条供「诊断」页面展示。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x5B1F;   // SubFabric
const PREFIX: string = 'SubFabric';

/** 日志级别。 */
export class LogLevel {
  static readonly DEBUG: number = 0;
  static readonly INFO: number = 1;
  static readonly WARN: number = 2;
  static readonly ERROR: number = 3;
}

/** 一条日志。 */
export class LogEntry {
  readonly time: number;
  readonly level: number;
  readonly tag: string;
  readonly message: string;

  constructor(level: number, tag: string, message: string) {
    this.time = Date.now();
    this.level = level;
    this.tag = tag;
    this.message = message;
  }

  get levelName(): string {
    if (this.level === LogLevel.DEBUG) {
      return 'D';
    }
    if (this.level === LogLevel.INFO) {
      return 'I';
    }
    if (this.level === LogLevel.WARN) {
      return 'W';
    }
    return 'E';
  }

  format(): string {
    return `[${this.levelName}][${this.tag}] ${this.message}`;
  }
}

/** 环形缓冲，最多保留 500 条。 */
const HISTORY: LogEntry[] = [];
const MAX_HISTORY: number = 500;

/** 控制台输出的最低级别，默认 INFO。 */
let minLevel: number = LogLevel.INFO;

export class Logger {
  /** 设置控制台最低输出级别（DEBUG 会打印推理细节，较吵）。 */
  static setMinLevel(level: number): void {
    minLevel = level;
  }

  static getMinLevel(): number {
    return minLevel;
  }

  static debug(tag: string, message: string): void {
    Logger.write(LogLevel.DEBUG, tag, message);
  }

  static info(tag: string, message: string): void {
    Logger.write(LogLevel.INFO, tag, message);
  }

  static warn(tag: string, message: string): void {
    Logger.write(LogLevel.WARN, tag, message);
  }

  static error(tag: string, message: string): void {
    Logger.write(LogLevel.ERROR, tag, message);
  }

  /**
   * 记录错误并带上**堆栈**。
   *
   * 为什么需要：ArkTS 里 `catch (err)` 到的对象只保证有 message，
   * 而像 `Cannot read property 'length' of undefined` 这类 TypeError
   * 光看 message 完全不知道是哪一行抛的——线上排查时这是最缺的信息。
   * 这里把 stack（若存在）一起写日志，并按行输出便于阅读。
   *
   * @param where 出错位置的人类可读描述（如 'transcribeSamples'）
   */
  static errorWithCause(tag: string, where: string, err: Object): void {
    const e = err as Error;
    const msg = e.message !== undefined ? e.message : String(err);
    const name = e.name !== undefined ? e.name : 'Error';
    Logger.write(LogLevel.ERROR, tag, `${where} 失败：${name}: ${msg}`);

    const stack = e.stack;
    if (stack !== undefined && stack.length > 0) {
      // 堆栈可能很长，逐行写入 HISTORY 便于「诊断」页逐条查看
      const lines = stack.split('\n');
      const limit = Math.min(lines.length, 25);
      for (let i = 0; i < limit; i++) {
        const line = lines[i].trim();
        if (line.length > 0) {
          Logger.write(LogLevel.ERROR, `${tag}/stack`, line);
        }
      }
    } else {
      Logger.write(LogLevel.ERROR, `${tag}/stack`, '（该错误对象没有 stack 信息）');
    }
  }

  private static write(level: number, tag: string, message: string): void {
    const entry = new LogEntry(level, tag, message);
    HISTORY.push(entry);
    if (HISTORY.length > MAX_HISTORY) {
      HISTORY.shift();
    }
    if (level < minLevel) {
      return;
    }
    const full = `${PREFIX}/${tag}`;
    try {
      if (level >= LogLevel.ERROR) {
        hilog.error(DOMAIN, full, '%{public}s', message);
      } else if (level === LogLevel.WARN) {
        hilog.warn(DOMAIN, full, '%{public}s', message);
      } else if (level === LogLevel.INFO) {
        hilog.info(DOMAIN, full, '%{public}s', message);
      } else {
        hilog.debug(DOMAIN, full, '%{public}s', message);
      }
    } catch (err) {
      // hilog 在某些环境（如预览器）不可用，忽略即可。
      console.log(`${full}: ${message}`);
    }
  }

  /** 最近的日志（新的在后）。 */
  static history(): LogEntry[] {
    return HISTORY.slice();
  }

  /** 用于「复制诊断信息」。 */
  static dump(): string {
    const lines: string[] = [];
    for (let i = 0; i < HISTORY.length; i++) {
      lines.push(HISTORY[i].format());
    }
    return lines.join('\n');
  }

  static clear(): void {
    HISTORY.length = 0;
  }
}
