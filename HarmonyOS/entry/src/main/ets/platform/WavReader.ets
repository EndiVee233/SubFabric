/*
 * WAV 读取 + 重采样到 16 kHz 单声道。
 *
 * 覆盖两种真实场景：
 *   1. 用户直接选一个 .wav（无需解码器，纯解析 RIFF 头）；
 *   2. 先把 mp4/mkv 解成 PCM（见 MediaDecoder.ets），再交给这里做声道混合与重采样。
 */

import { fileIo as fs } from '@kit.CoreFileKit';
import { Logger } from '../engine/Logger';
import { SAMPLE_RATE, resampleTo16k, pcm16ToFloat } from 'common';

const TAG = 'WavReader';

/** WAV 解析结果。 */
export class WavData {
  readonly samples: Float64Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly durationSec: number;

  constructor(samples: Float64Array, sampleRate: number, channels: number,
              bitsPerSample: number) {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = bitsPerSample;
    this.durationSec = sampleRate > 0 ? samples.length / sampleRate : 0;
  }
}

/** 判断是否是 RIFF/WAVE 文件头。 */
export function isWav(path: string): boolean {
  let file: fs.File | null = null;
  try {
    file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const head = new ArrayBuffer(12);
    const read = fs.readSync(file.fd, head);
    if (read < 12) {
      return false;
    }
    const v = new DataView(head);
    return tag(v, 0) === 'RIFF' && tag(v, 8) === 'WAVE';
  } catch (err) {
    return false;
  } finally {
    if (file !== null) {
      fs.closeSync(file);
    }
  }
}

/**
 * 解析 WAV 并返回 16 kHz 单声道浮点样本。
 *
 * 支持 PCM 16/24/32-bit 整数与 32-bit float；多声道按均值混合。
 */
export function readWavAs16kMono(path: string): WavData {
  const buf = readAll(path);
  const v = new DataView(buf);
  if (buf.byteLength < 44) {
    throw new Error('文件太小，不是有效的 WAV');
  }
  if (tag(v, 0) !== 'RIFF' || tag(v, 8) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }

  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = tag(v, pos);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmtOffset = body;
    } else if (id === 'data') {
      dataOffset = body;
      // 有些写入器把 data 大小写成 0 或大于实际长度，取实际可用长度更安全。
      dataSize = Math.min(size, buf.byteLength - body);
    }
    // 块按偶数字节对齐。
    pos = body + size + (size % 2);
  }

  if (fmtOffset < 0 || dataOffset < 0) {
    throw new Error('WAV 缺少 fmt 或 data 块');
  }

  const audioFormat = v.getUint16(fmtOffset, true);
  const channels = v.getUint16(fmtOffset + 2, true);
  const sampleRate = v.getUint32(fmtOffset + 4, true);
  const bitsPerSample = v.getUint16(fmtOffset + 14, true);
  const bytesPerSample = bitsPerSample >> 3;
  const frameBytes = bytesPerSample * channels;

  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`不支持的 WAV 编码格式 ${audioFormat}（仅支持 PCM=1 / FLOAT=3）`);
  }
  if (frameBytes <= 0 || channels <= 0) {
    throw new Error('WAV 头部参数非法');
  }

  const frames = Math.floor(dataSize / frameBytes);
  const mono = new Float64Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    const base = dataOffset + i * frameBytes;
    for (let c = 0; c < channels; c++) {
      acc += readSample(v, base + c * bytesPerSample, bitsPerSample, audioFormat);
    }
    mono[i] = acc / channels;
  }

  Logger.info(TAG, `WAV ${sampleRate} Hz / ${channels} ch / ${bitsPerSample} bit，`
    + `${(frames / sampleRate).toFixed(2)} s`);
  const resampled = resampleTo16k(mono, sampleRate);
  return new WavData(resampled, SAMPLE_RATE, 1, 16);
}

function readSample(v: DataView, off: number, bits: number, format: number): number {
  if (format === 3) {
    // IEEE float
    if (bits === 32) {
      return v.getFloat32(off, true);
    }
    if (bits === 64) {
      return v.getFloat64(off, true);
    }
    return 0;
  }
  if (bits === 8) {
    // 8-bit WAV 是无符号的
    return (v.getUint8(off) - 128) * 256;
  }
  if (bits === 16) {
    return v.getInt16(off, true);
  }
  if (bits === 24) {
    const b0 = v.getUint8(off);
    const b1 = v.getUint8(off + 1);
    const b2 = v.getUint8(off + 2);
    let value = b0 | (b1 << 8) | (b2 << 16);
    if ((value & 0x800000) !== 0) {
      value |= ~0xFFFFFF;    // 符号扩展
    }
    return value / 256;      // 归一到 16-bit 量级
  }
  if (bits === 32) {
    return v.getInt32(off, true) / 65536;
  }
  return 0;
}

function tag(v: DataView, off: number): string {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1),
    v.getUint8(off + 2), v.getUint8(off + 3));
}

function readAll(path: string): ArrayBuffer {
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    const size = fs.statSync(path).size;
    const buf = new ArrayBuffer(size);
    const read = fs.readSync(file.fd, buf);
    if (read < size) {
      Logger.warn(TAG, `只读到 ${read}/${size} 字节`);
    }
    return buf;
  } finally {
    fs.closeSync(file);
  }
}

/** 从任意 PCM 缓冲构造 16 kHz 单声道样本（供解码器输出复用）。 */
export function pcmTo16kMono(interleaved: Int16Array, channels: number,
                             sourceRate: number): Float64Array {
  if (channels <= 1 && sourceRate === SAMPLE_RATE) {
    return pcm16ToFloat(interleaved);
  }
  const frames = Math.floor(interleaved.length / Math.max(1, channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += interleaved[i * channels + c];
    }
    mono[i] = acc / channels;
  }
  return resampleTo16k(mono, sourceRate);
}
