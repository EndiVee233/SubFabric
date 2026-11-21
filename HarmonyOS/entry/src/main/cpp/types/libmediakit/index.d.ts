/*
 * libmediakit.so 类型声明：HarmonyOS AudioSuite 人声降噪。
 * 实现见 entry/src/main/cpp/audiosuite_napi.cpp
 */

export interface MediaKitNative {
  /** 当前设备是否支持 AudioSuite 降噪节点。 */
  isNoiseReductionSupported(): boolean;

  /**
   * 对 16 kHz / S16LE / 单声道 PCM 做系统降噪。
   * 输入长度必须是 2 的倍数；返回同格式 PCM。
   * 设备不支持或管线失败时抛异常。
   */
  denoisePcm16k(pcm: ArrayBuffer): ArrayBuffer;
}

declare const mediaKit: MediaKitNative;
export default mediaKit;
