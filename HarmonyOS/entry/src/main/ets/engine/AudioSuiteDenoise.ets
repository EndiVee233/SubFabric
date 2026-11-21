/*
 * HarmonyOS AudioSuite 人声降噪。
 *
 * 原生实现：entry/src/main/cpp/audiosuite_napi.cpp
 * 输入/输出固定 16 kHz / S16LE / 单声道 PCM。
 *
 * 这是华为 Audio Kit 的现成降噪节点（EFFECT_NODE_TYPE_NOISE_REDUCTION），
 * 不是自写 RNNoise/afftdn；设备是否支持由系统能力决定。
 */

import mediaKit from 'libmediakit.so';
import { Logger } from './Logger';

const TAG = 'AudioSuite';

export class AudioSuiteDenoise {
  /** 当前设备是否支持系统降噪节点。 */
  static supported(): boolean {
    try {
      return mediaKit.isNoiseReductionSupported();
    } catch (err) {
      Logger.warn(TAG, 'AudioSuite 降噪能力查询失败');
      return false;
    }
  }

  /**
   * 对 16 kHz / S16LE / 单声道 PCM 做降噪。
   * 调用方负责把媒体解码到此格式；长度必须是 2 的倍数。
   */
  static denoise(pcm: ArrayBuffer): ArrayBuffer {
    return mediaKit.denoisePcm16k(pcm);
  }
}
