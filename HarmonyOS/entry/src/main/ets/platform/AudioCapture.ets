/*
 * 麦克风采集：16 kHz / 单声道 / S16LE 原始 PCM。
 *
 * 关键点：
 *   - 直接请求 SAMPLE_RATE_16000 + CHANNEL_1，避免在应用层重采样；
 *     听写场景下音频设备通常原生支持 16 kHz。
 *   - 采集与识别解耦：`AudioCaptureService` 只负责把 PCM 攒进环形缓冲，
 *     由 `VoiceMemoRecorder` 决定什么时候切片送去识别。
 *   - 需要 `ohos.permission.MICROPHONE`，由调用方在页面里先申请。
 */

import { audio } from '@kit.AudioKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Logger } from '../engine/Logger';
import { pcmTo16kMono } from './WavReader';

const TAG = 'AudioCapture';

/** 采集状态。 */
export class CaptureState {
  static readonly IDLE: string = 'idle';
  static readonly RUNNING: string = 'running';
  static readonly ERROR: string = 'error';
  static readonly STOPPED: string = 'stopped';
}

/** 采集配置。 */
export class CaptureConfig {
  /** 目标采样率；16 kHz 是 parakeet 的要求。 */
  sampleRate: number = 16000;
  channels: number = 1;
  /** 每次 read 的字节数（默认 20 ms @16k/mono/s16 ≈ 640 字节）。 */
  readSize: number = 640 * 2;
}

/**
 * 麦克风采集服务。
 *
 * 使用 `on('readData')` 回调模式（API 11+），这是目前最稳的低延迟读取方式；
 * 部分老版本 ROM 只支持阻塞式 `read()`，此时 `startBlocking()` 提供兜底。
 */
export class AudioCaptureService {
  private capturer: audio.AudioCapturer | null = null;
  private state: string = CaptureState.IDLE;
  private readonly config: CaptureConfig;
  /** 已采集的 16 kHz 单声道样本（滚动累积，由上层定期取走）。 */
  private buffer: Float64Array = new Float64Array(0);
  private onState: ((state: string, message: string) => void) | null = null;

  constructor(config: CaptureConfig = new CaptureConfig()) {
    this.config = config;
  }

  getState(): string {
    return this.state;
  }

  /** 已采集样本总数（16 kHz 下的样本数）。 */
  get sampleCount(): number {
    return this.buffer.length;
  }

  setStateListener(listener: (state: string, message: string) => void): void {
    this.onState = listener;
  }

  private emit(state: string, message: string): void {
    this.state = state;
    if (this.onState !== null) {
      this.onState(state, message);
    }
  }

  /** 开始采集。 */
  async start(): Promise<void> {
    if (this.capturer !== null) {
      Logger.warn(TAG, '采集已在运行');
      return;
    }
    const streamInfo: audio.AudioStreamInfo = {
      samplingRate: toSamplingRate(this.config.sampleRate),
      channels: this.config.channels === 1
        ? audio.AudioChannel.CHANNEL_1 : audio.AudioChannel.CHANNEL_2,
      sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
      encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
    };
    const capturerInfo: audio.AudioCapturerInfo = {
      source: audio.SourceType.SOURCE_TYPE_VOICE_RECOGNITION,
      capturerFlags: 0
    };
    const options: audio.AudioCapturerOptions = {
      streamInfo: streamInfo,
      capturerInfo: capturerInfo
    };

    try {
      this.capturer = await audio.createAudioCapturer(options);
    } catch (err) {
      const e = err as BusinessError;
      this.emit(CaptureState.ERROR, `创建采集器失败：${e.code} ${e.message}`);
      throw new Error(`创建采集器失败：${e.message}`);
    }

    const capturer = this.capturer;
    capturer.on('readData', (data: ArrayBuffer): void => {
      this.handleChunk(data);
    });
    capturer.on('audioInterrupt', (event: audio.InterruptEvent): void => {
      Logger.warn(TAG, `音频中断事件 hintType=${event.hintType}`);
      if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE ||
          event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP) {
        this.emit(CaptureState.STOPPED, '被系统中断（来电等）');
      }
    });

    try {
      await capturer.start();
      this.emit(CaptureState.RUNNING, '正在聆听…');
      Logger.info(TAG, `采集已开始：${this.config.sampleRate} Hz / `
        + `${this.config.channels} ch / S16LE`);
    } catch (err) {
      const e = err as BusinessError;
      this.emit(CaptureState.ERROR, `启动采集失败：${e.code} ${e.message}`);
      throw new Error(`启动采集失败：${e.message}`);
    }
  }

  /** 把一块 PCM 追加进缓冲。 */
  private handleChunk(data: ArrayBuffer): void {
    const pcm = new Int16Array(data);
    const mono = pcmTo16kMono(pcm, this.config.channels, this.config.sampleRate);
    if (mono.length === 0) {
      return;
    }
    const merged = new Float64Array(this.buffer.length + mono.length);
    merged.set(this.buffer, 0);
    merged.set(mono, this.buffer.length);
    this.buffer = merged;
  }

  /**
   * 取走并清空当前缓冲。
   * 上层按固定时长（例如 8 s）调用，把音频切片送去识别。
   */
  takeBuffer(): Float64Array {
    const out = this.buffer;
    this.buffer = new Float64Array(0);
    return out;
  }

  /** 只读快照（不清空）。 */
  peekBuffer(): Float64Array {
    return this.buffer;
  }

  /** 停止并释放。 */
  async stop(): Promise<void> {
    const capturer = this.capturer;
    this.capturer = null;
    if (capturer === null) {
      return;
    }
    try {
      capturer.off('readData');
      capturer.off('audioInterrupt');
      await capturer.stop();
      await capturer.release();
      this.emit(CaptureState.STOPPED, '已停止');
    } catch (err) {
      const e = err as BusinessError;
      Logger.warn(TAG, `停止采集出错：${e.message}`);
      this.emit(CaptureState.ERROR, `停止采集出错：${e.message}`);
    }
  }
}

/** 采样率数值 -> audio.AudioSamplingRate 枚举（不支持时回落到 16000）。 */
function toSamplingRate(rate: number): audio.AudioSamplingRate {
  if (rate === 8000) {
    return audio.AudioSamplingRate.SAMPLE_RATE_8000;
  }
  if (rate === 16000) {
    return audio.AudioSamplingRate.SAMPLE_RATE_16000;
  }
  if (rate === 22050) {
    return audio.AudioSamplingRate.SAMPLE_RATE_22050;
  }
  if (rate === 24000) {
    return audio.AudioSamplingRate.SAMPLE_RATE_24000;
  }
  if (rate === 32000) {
    return audio.AudioSamplingRate.SAMPLE_RATE_32000;
  }
  if (rate === 44100) {
    return audio.AudioSamplingRate.SAMPLE_RATE_44100;
  }
  if (rate === 48000) {
    return audio.AudioSamplingRate.SAMPLE_RATE_48000;
  }
  // 不支持的目标采样率一律请求 16 kHz：识别只认 16 kHz，
  // 让设备侧用硬件重采样比在 ArkTS 里做质量更好。
  Logger.warn(TAG, `设备可能不支持 ${rate} Hz，改用 16000 Hz`);
  return audio.AudioSamplingRate.SAMPLE_RATE_16000;
}
