/*
 * 识别硬件接口。
 *
 * CPU 已按当前要求从可选识别硬件中注释掉：引擎内部仍会用到 MindSpore Lite
 * 的线程参数，但设置页不再暴露 CPU 后端，也不再提示「CPU 模式」。
 *
 * GPU（Vulkan）与 NPU 先只做接口：
 *   · NPU：复用现有 MindSpore Lite NNRt 能力，只读探测可用性；
 *   · Vulkan：预留 prepare/release，返回未接入，等原生层接入后再实现。
 */

import { MsLiteRuntime } from './MindSporeLite';
import vulkanprobe from 'libvulkanprobe.so';
import type { VulkanProbeResult } from 'libvulkanprobe.so';

/** 识别硬件类型。CPU 已注释，不再作为可选后端。 */
export class RecognitionHardwareKind {
  static readonly VULKAN: string = 'vulkan';
  static readonly NPU: string = 'npu';
  // static readonly CPU: string = 'cpu';
}

/** 识别硬件接口；真正的推理接入时在这里扩展上下文。 */
export interface RecognitionHardware {
  readonly id: string;
  readonly label: string;
  isAvailable(): boolean;
  prepare(): Promise<boolean>;
  release(): Promise<void>;
  interfaceNote(): string;
}

/** GPU（Vulkan）后端：当前只有接口。 */
export class VulkanHardware implements RecognitionHardware {
  readonly id: string = RecognitionHardwareKind.VULKAN;
  readonly label: string = 'GPU（Vulkan）';

  isAvailable(): boolean {
    try {
      return vulkanprobe.probe().available;
    } catch (err) {
      return false;
    }
  }

  async prepare(): Promise<boolean> {
    return this.isAvailable();
  }

  async release(): Promise<void> {
    // 预留
  }

  interfaceNote(): string {
    try {
      const result: VulkanProbeResult = vulkanprobe.probe();
      return result.available
        ? `Vulkan available · ${result.deviceName}`
        : 'Vulkan device unavailable';
    } catch (err) {
      const e = err as Error;
      return e.message.length > 0 ? `Vulkan native module error: ${e.message}`
        : 'Vulkan native module unavailable';
    }
  }
}

/**
 * 其他 Vulkan 模型（Qwen ASR、对齐模型等）的接口桩。
 *
 * 它们与 Parakeet Vulkan 共用同一套原生 Vulkan 运行时；当前只暴露
 * 可用性、prepare/release 和说明文本，权重与推理都还没接入。
 */
export class VulkanModelInterface implements RecognitionHardware {
  readonly id: string;
  readonly label: string;
  private readonly note: string;

  constructor(id: string, label: string, note: string) {
    this.id = id;
    this.label = label;
    this.note = note;
  }

  isAvailable(): boolean {
    return false;
  }

  async prepare(): Promise<boolean> {
    return false;
  }

  async release(): Promise<void> {
    // 预留
  }

  interfaceNote(): string {
    return this.note;
  }
}

/** NPU 后端：复用现有 NNRt 探测，只暴露可用性接口。 */
export class NpuHardware implements RecognitionHardware {
  readonly id: string = RecognitionHardwareKind.NPU;
  readonly label: string = 'NPU';

  isAvailable(): boolean {
    return MsLiteRuntime.hasNpu();
  }

  async prepare(): Promise<boolean> {
    // 实际上下文仍由 ParakeetEngine 按 NPU-only 策略创建。
    return this.isAvailable();
  }

  async release(): Promise<void> {
    // 由引擎统一释放
  }

  interfaceNote(): string {
    return this.isAvailable() ? '可用（引擎强制 NPU）' : '当前设备不可用';
  }
}

// CPU 后端按需求注释：
// export class CpuHardware implements RecognitionHardware { ... }
