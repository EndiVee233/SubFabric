/*
 * 随包 FFmpeg 的 ArkTS 包装。
 *
 * 只在需要时使用：
 *   - 打开工程时探一次编码；
 *   - 视频是 AV1 且系统没有 AV1 硬件解码时，生成 H.264 代理。
 *
 * 代理文件放在项目目录，后续打开可直接复用。
 */

import ffmpegNative from 'libffmpeg.so';
import { fileExists, fileSize } from '../platform/FileUtil';

interface FfmpegProbeJson {
  ok?: boolean;
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

interface TranscodeJson {
  ok: boolean;
  output?: string;
}

export class FfmpegProbe {
  ok: boolean = false;
  error: string = '';
  container: string = '';
  videoCodec: string = '';
  audioCodec: string = '';
  width: number = 0;
  height: number = 0;
  duration: number = 0;
  fps: number = 0;
  hasAudio: boolean = false;
}

/** 解析原生 probeMedia 返回的 JSON。失败时返回 ok=false。 */
export function probeMedia(path: string): FfmpegProbe {
  const info = new FfmpegProbe();
  try {
    const raw: string = ffmpegNative.probeMedia(path);
    const obj = JSON.parse(raw) as FfmpegProbeJson;
    info.ok = obj.ok === true;
    info.error = obj.error === undefined ? '' : obj.error;
    info.container = obj.container === undefined ? '' : obj.container;
    info.videoCodec = obj.videoCodec === undefined ? '' : obj.videoCodec;
    info.audioCodec = obj.audioCodec === undefined ? '' : obj.audioCodec;
    info.width = obj.width === undefined ? 0 : obj.width;
    info.height = obj.height === undefined ? 0 : obj.height;
    info.duration = obj.duration === undefined ? 0 : obj.duration;
    info.fps = obj.fps === undefined ? 0 : obj.fps;
    info.hasAudio = obj.hasAudio === true;
  } catch (err) {
    info.ok = false;
    info.error = (err as Error).message;
  }
  return info;
}

export function hasAv1Hardware(): boolean {
  return ffmpegNative.hasAv1Hardware();
}

export function isAv1(probe: FfmpegProbe): boolean {
  return probe.ok && probe.videoCodec.toLowerCase().indexOf('av1') >= 0;
}

/** 代理是否存在且不是上次失败留下的空文件。 */
export function proxyExists(path: string): boolean {
  return fileExists(path) && fileSize(path) > 1024;
}

/**
 * 生成 H.264 代理。onProgress 回调按 ~300ms 轮询原生进度。
 * 返回代理路径；失败时抛出异常。
 */
export async function transcodeToH264(input: string, output: string, maxHeight: number,
                                      bitrateKbps: number,
                                      onProgress: (percent: number) => void): Promise<string> {
  const timer: number = setInterval((): void => {
    try {
      onProgress(ffmpegNative.getTranscodeProgress());
    } catch (err) {
      // 轮询失败不打断转码
    }
  }, 300);
  try {
    const raw: string =
      await ffmpegNative.transcodeToH264(input, output, maxHeight, bitrateKbps);
    const result = JSON.parse(raw) as TranscodeJson;
    if (!result.ok || result.output === undefined || result.output.length === 0) {
      throw new Error('FFmpeg 没有返回代理路径');
    }
    onProgress(100);
    return result.output;
  } finally {
    clearInterval(timer);
  }
}

export function cancelTranscode(): void {
  try {
    ffmpegNative.cancelTranscode();
  } catch (err) {
    // 没有进行中的任务时忽略
  }
}
