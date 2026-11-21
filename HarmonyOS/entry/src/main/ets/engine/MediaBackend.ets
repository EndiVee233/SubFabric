/*
 * 媒体编解码后端偏好。
 *
 * HarmonyOS 的播放/音频解码/硬件编码都走 AVCodec Kit；FFmpeg 目前用于
 * AV1 软件解码与 H.264 软件编码（代理/兜底）。这里不承诺“全流程 FFmpeg”
 * 能替换系统 Video 播放器，只控制处理链路的选择：
 *
 *   · avcodec（默认）：优先系统 AVCodec 硬解/硬编，FFmpeg 只做无硬解时的兜底；
 *   · ffmpeg：AV1 等处理强制走 FFmpeg 软件链路，便于复现兼容性/画质问题。
 *
 * 设置页只显示能力矩阵；真正的出口（视频压制/导出）尚未接入。
 */

export class MediaCodecMode {
  /** AVCodec 优先 + FFmpeg 兜底。 */
  static readonly AVCODEC: string = 'avcodec';
  /** 处理链路强制 FFmpeg 软件实现。 */
  static readonly FFMPEG: string = 'ffmpeg';
}

export class MediaCodecPrefs {
  static readonly MODE: string = 'media.codecMode';
}

export function ensureMediaCodecDefaults(): void {
  PersistentStorage.persistProp<string>(MediaCodecPrefs.MODE, MediaCodecMode.AVCODEC);
}

export function currentMediaCodecMode(): string {
  const value = AppStorage.get<string>(MediaCodecPrefs.MODE);
  return value === MediaCodecMode.FFMPEG ? MediaCodecMode.FFMPEG : MediaCodecMode.AVCODEC;
}

export function isFfmpegForced(): boolean {
  return currentMediaCodecMode() === MediaCodecMode.FFMPEG;
}

export function setMediaCodecMode(mode: string): void {
  AppStorage.setOrCreate<string>(MediaCodecPrefs.MODE,
    mode === MediaCodecMode.FFMPEG ? MediaCodecMode.FFMPEG : MediaCodecMode.AVCODEC);
}
