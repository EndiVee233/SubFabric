/*
 * 媒体解码：把视频/音频文件的音轨取成 16 kHz 单声道 PCM。
 *
 * 实现 `IAudioDecoder`，因此可以直接注入 common 里的 Pipeline。
 *
 * ======================= 为什么是「转码成 WAV」而不是解码 =======================
 *
 * 经对照 SDK 声明文件（API 26 / @ohos.multimedia.media.d.ts）核实：
 * **ArkTS 侧没有「解复用 + 解成 PCM」的公开 API**。该模块只导出
 * AVPlayer / AVRecorder / AVMetadataExtractor / AVImageGenerator /
 * AVTranscoder / SoundPool / AudioPlayer / AudioRecorder，
 * 并**不存在** AVDemuxer、AudioDecoder、createAVDemuxer、createAudioDecoderByMime
 * 或 AVBuffer（网上不少示例里的这些名字都是错的）。
 *
 * 因此本文件采用官方可行路径：
 *   1. 本来就是 WAV  -> 自己解析 RIFF（WavReader，零依赖、最快、不损失质量）；
 *   2. 其它容器      -> 用随包 FFmpeg NAPI 把音轨解成 16 kHz 单声道 WAV，再按 1 解析。
 *
 * ⚠️ 不要改用系统 AVTranscoder：API 12 只支持 MP4/AAC，`fileFormat: CFT_WAV`
 * 会直接报 “The Parameter fileFormat is invalid”。FFmpeg 原生层已经随包链接，
 * 解码/重采样在 async work 线程里完成，不阻塞 UI。
 */

import { media } from '@kit.MediaKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Logger } from '../engine/Logger';
import { MediaInfo, SAMPLE_RATE } from 'common';
import type { IAudioDecoder } from 'common';
import { readWavAs16kMono, isWav } from './WavReader';
import { decodeAudioToWav } from './NativeAudioTranscoder';

const TAG = 'MediaDecoder';

/** 解码配置。 */
export class DecodeOptions {
  /** 期望输出采样率，固定 16 kHz（识别要求）。 */
  targetRate: number = SAMPLE_RATE;
  /** 单声道混合。 */
  mono: boolean = true;
}

/** 基于 HarmonyOS 媒体框架的解码器。 */
export class HarmonyAudioDecoder implements IAudioDecoder {
  private readonly options: DecodeOptions;
  /** 中间 WAV 的落地目录（由调用方注入，通常是应用 cacheDir）。 */
  private workDir: string = '';

  constructor(options: DecodeOptions = new DecodeOptions()) {
    this.options = options;
  }

  /** 设置转码中间产物目录。不设置时转码不可用。 */
  setWorkDir(dir: string): void {
    this.workDir = dir;
  }

  /** 读取媒体元信息（时长/分辨率）。 */
  async probe(uri: string): Promise<MediaInfo> {
    const info = new MediaInfo(shortName(uri), uri, 0);
    let file: fs.File | null = null;
    let extractor: media.AVMetadataExtractor | null = null;
    try {
      file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      extractor = await media.createAVMetadataExtractor();
      extractor.fdSrc = { fd: file.fd };
      const meta = await extractor.fetchMetadata();
      const durationMs = Number.parseInt(meta.duration ?? '0', 10);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        info.durationSec = durationMs / 1000;
      }
      const w = Number.parseInt(meta.videoWidth ?? '0', 10);
      const h = Number.parseInt(meta.videoHeight ?? '0', 10);
      if (w > 0 && h > 0) {
        info.width = w;
        info.height = h;
        info.hasVideo = true;
      }
    } catch (err) {
      const e = err as BusinessError;
      Logger.warn(TAG, `读取元信息失败（不影响识别）：${e.message}`);
    } finally {
      if (extractor !== null) {
        try {
          await extractor.release();
        } catch (inner) {
          Logger.warn(TAG, '释放元信息读取器失败（忽略）');
        }
      }
      if (file !== null) {
        fs.closeSync(file);
      }
    }
    return info;
  }

  /** 取出 16 kHz 单声道浮点样本。 */
  async decodeToPcm16k(uri: string, onProgress?: (ratio: number) => void): Promise<Float64Array> {
    try {
      return await this.decodeInner(uri, onProgress);
    } catch (err) {
      // 带堆栈记录。视频路径涉及 AVTranscoder + 自写 WAV 解析，
      // 任何 `Cannot read property 'x' of undefined` 都需要堆栈才能定位。
      Logger.errorWithCause(TAG, `解码 ${shortName(uri)}`, err as Object);
      throw err as Error;
    }
  }

  private async decodeInner(uri: string,
                            onProgress?: (ratio: number) => void): Promise<Float64Array> {
    const isWaveFile = isWav(uri);
    Logger.info(TAG, `开始解码：${shortName(uri)}，是 WAV=${isWaveFile}`);
    if (isWaveFile) {
      if (onProgress) {
        onProgress(0.5);
      }
      const wav = readWavAs16kMono(uri);
      if (onProgress) {
        onProgress(1);
      }
      Logger.info(TAG, `WAV 解析完成：${wav.samples.length} 个样本`
        + `（${wav.durationSec.toFixed(2)} s）`);
      return wav.samples;
    }
    // 非 WAV：先转码成 WAV，再解析。
    const wavPath = await this.transcodeToWav(uri, onProgress);
    const wav = readWavAs16kMono(wavPath);
    // 转码产物是中间文件，用完即删（失败不影响结果）。
    try {
      fs.unlinkSync(wavPath);
    } catch (err) {
      Logger.warn(TAG, `清理中间 WAV 失败（忽略）：${wavPath}`);
    }
    if (onProgress) {
      onProgress(1);
    }
    Logger.info(TAG, `转码+解析完成：${wav.samples.length} 个样本`
      + `（${wav.durationSec.toFixed(2)} s）`);
    return wav.samples;
  }

  /**
   * 用随包 FFmpeg 把音轨转成 WAV。
   *
   * @returns 生成的 WAV 路径
   */
  private async transcodeToWav(uri: string,
                               onProgress?: (ratio: number) => void): Promise<string> {
    if (this.workDir.length === 0) {
      throw new Error('未设置转码工作目录（调用 setWorkDir）');
    }
    const outPath = `${this.workDir}/transcoded_${Date.now()}.wav`;
    if (onProgress) {
      onProgress(0.15);
    }
    try {
      await decodeAudioToWav(uri, outPath);
      if (onProgress) {
        onProgress(0.95);
      }
      Logger.info(TAG, `已转为 WAV：${outPath}（${fs.statSync(outPath).size} 字节）`);
      return outPath;
    } catch (err) {
      const e = err as Error;
      Logger.error(TAG, `音频转 WAV 失败：${e.message}`);
      // 清掉可能产生的半成品。
      try {
        fs.unlinkSync(outPath);
      } catch (inner) {
        // 忽略
      }
      throw new Error(`无法读取该媒体文件的音频（${e.message}）。`);
    }
  }
}

function shortName(uri: string): string {
  const slash = uri.lastIndexOf('/');
  return slash >= 0 ? uri.substring(slash + 1) : uri;
}
