export interface VulkanProbeResult {
  available: boolean;
  deviceCount: number;
  deviceName: string;
}

export interface VulkanProbeNative {
  probe(): VulkanProbeResult;
  load(kind: number, path: string): bigint;
  release(handle: bigint): boolean;
  transcribe(handle: bigint, pcm: Float32Array, offsetCs?: number): VulkanTranscriptionResult;
}

export interface VulkanWordResult {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface VulkanTranscriptionResult {
  text: string;
  words: VulkanWordResult[];
}

declare const vulkanprobe: VulkanProbeNative;
export default vulkanprobe;
