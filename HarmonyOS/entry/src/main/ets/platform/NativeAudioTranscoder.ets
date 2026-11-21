/*
 * 原生音频转 WAV。
 *
 * 系统 AVTranscoder 在 API 12 只支持 MP4/AAC，传 CFT_WAV 会报
 * “fileFormat is invalid”；因此这里直接调用随包的 FFmpeg NAPI，
 * 把任意容器的音轨解成 16 kHz / 单声道 / 16-bit WAV。
 */

import ffmpegNative from 'libffmpeg.so';

interface AudioDecodeJson {
  ok?: boolean;
  output?: string;
  error?: string;
}

/**
 * 把媒体文件的音轨转成 WAV。
 * 成功返回 WAV 路径；失败抛出带原生错误信息的异常。
 */
export async function decodeAudioToWav(input: string, output: string): Promise<string> {
  const raw: string = await ffmpegNative.decodeAudioToWav(input, output);
  const result = JSON.parse(raw) as AudioDecodeJson;
  if (result.ok !== true) {
    throw new Error(result.error === undefined || result.error.length === 0
      ? 'FFmpeg 音频转换失败' : result.error);
  }
  return result.output === undefined || result.output.length === 0 ? output : result.output;
}
