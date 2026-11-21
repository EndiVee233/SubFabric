/*
 * libffmpeg.so 类型声明：随包 FFmpeg 的媒体探测 / AV1 软件解码代理。
 * 实现见 entry/src/main/cpp/ffmpeg_napi.cpp。
 */

export interface MediaProbeResult {
  ok: boolean;
  error?: string;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  hasAudio?: boolean;
}

export interface TranscodeResult {
  ok: boolean;
  output?: string;
}

export interface FfmpegNative {
  /** 读取容器/编码信息；失败时返回 ok=false 的 JSON。 */
  probeMedia(path: string): string;

  /** 系统是否有 AV1 硬件解码器（HARDWARE 类别）。 */
  hasAv1Hardware(): boolean;

  /**
   * 用 FFmpeg 解码任意视频（重点是 AV1）并编码为 H.264 MP4 代理。
   * 返回 JSON 字符串：{"ok":true,"output":"..."}；进度用 getTranscodeProgress() 轮询。
   */
  transcodeToH264(input: string, output: string, maxHeight: number,
                  bitrateKbps: number): Promise<string>;

  /**
   * 用 FFmpeg 把任意容器的音轨解码并重采样成 16 kHz / 单声道 / 16-bit WAV。
   * 返回 JSON 字符串：{"ok":true,"output":"..."} 或 {"ok":false,"error":"..."}。
   */
  decodeAudioToWav(input: string, output: string): Promise<string>;

  getTranscodeProgress(): number;

  cancelTranscode(): void;
}

declare const ffmpegNative: FfmpegNative;
export default ffmpegNative;
