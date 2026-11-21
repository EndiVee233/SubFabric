/*
 * NAPI 验证入口：在 **NPU（NNRt）** 上加载模型并读取输入张量。
 *
 * 目的：确认官方 C API 能绕开 ArkTS 绑定在 NNRt 后端下的限制
 * （`model.getInputs()` 返回 undefined）。这是整个 NPU 路线的
 * 前提假设，必须先单独验证，再投入去改造推理引擎。
 *
 * 用法：模型页点「NPU 原生自检」，结果打到日志。
 *   ✅ 成功 → 输入张量名能列出来（audio_signal / length）
 *   ❌ 失败 → 抛错并在日志里说明原因
 */

import mslite from 'libmslite.so';
import { Logger } from './Logger';
import { MsLiteRuntime } from './MindSporeLite';

const TAG = 'NpuSelfTest';

/** 自检结果。 */
export class SelfTestResult {
  ok: boolean = false;
  /** 人类可读的详细说明（成功与失败都填）。 */
  detail: string = '';
}

/**
 * 在 NPU 上加载指定的 `.ms`，读出输入张量名。
 *
 * @param modelPath 沙箱内 `.ms` 的绝对路径
 * @param label     日志里用来区分是哪个模型（对照实验用）
 */
export function npuSelfTest(modelPath: string, label: string = 'encoder'): SelfTestResult {
  const res = new SelfTestResult();
  const lines: string[] = [];
  Logger.info(TAG, `===== 开始自检：${label} -> ${modelPath} =====`);

  // ---- 0) 先看 ArkTS 侧怎么报告 NPU 可用性（对照组）
  const arkTsNpu = MsLiteRuntime.hasNpu();
  const devices = MsLiteRuntime.nnrtDevices();
  lines.push(`ArkTS 侧：hasNpu=${arkTsNpu}，枚举到 ${devices.length} 个 NNRt 设备`);
  for (let i = 0; i < devices.length; i++) {
    lines.push(`  [${i}] id=${devices[i].deviceId} type=${devices[i].type} name=${devices[i].name}`);
  }
  Logger.info(TAG, lines[lines.length - 1]);

  let ctx: bigint = BigInt(0);
  let modelId = 0;
  try {
    // ---- 1) 建 NNRt 上下文（原生侧，无 NPU 直接抛错）
    ctx = mslite.createContext(4);
    lines.push(`✅ 原生 createContext 成功（未降级 CPU）`);
    Logger.info(TAG, lines[lines.length - 1]);

    // ---- 2) 在 NPU 上构建模型
    modelId = mslite.loadModel(ctx, modelPath);
    lines.push(`✅ 原生 loadModel 成功，modelId=${modelId}`);
    Logger.info(TAG, lines[lines.length - 1]);

    // ---- 3) ★ 关键：读取输入张量名
    //        ArkTS 在 NNRt 下这一步返回 undefined；C API 应当正常
    const names = mslite.getInputNames(modelId);
    lines.push(`✅ 读到 ${names.length} 个输入张量：[${names.join(', ')}]`);
    Logger.info(TAG, lines[lines.length - 1]);

    // ---- 4) 逐个打印张量元信息，确认形状/类型
    for (let i = 0; i < names.length; i++) {
      const info = mslite.getTensorInfo(modelId, names[i], true);
      if (info !== null) {
        lines.push(`  IN ${info.name}: dtype=${info.dtype} `
          + `shape=[${info.shape.join(',')}] dataSize=${info.dataSize}`);
        Logger.info(TAG, lines[lines.length - 1]);
      }
    }

    // ---- 5) 顺手看一眼输出张量，确认契约
    const outCandidates: string[] = ['outputs', 'encoded_lengths'];
    for (let i = 0; i < outCandidates.length; i++) {
      const info = mslite.getTensorInfo(modelId, outCandidates[i], false);
      if (info !== null) {
        lines.push(`  OUT ${info.name}: dtype=${info.dtype} `
          + `shape=[${info.shape.join(',')}] dataSize=${info.dataSize}`);
        Logger.info(TAG, lines[lines.length - 1]);
      }
    }

    res.ok = names.length > 0;
    res.detail = res.ok
      ? `NPU 原生通路可用（${names.length} 个输入）`
      : '模型加载成功但输入张量为空——需要进一步排查';
  } catch (err) {
    const e = err as Error;
    res.ok = false;
    res.detail = `NPU 原生通路失败：${e.message}`;
    Logger.errorWithCause(TAG, 'npuSelfTest', err as Object);
  } finally {
    // 清理，避免 410 MB 的模型留在内存里
    try {
      if (modelId > 0) {
        mslite.destroyModel(modelId);
      }
      if (ctx !== BigInt(0)) {
        mslite.destroyContext(ctx);
      }
    } catch (inner) {
      Logger.warn(TAG, '清理原生资源失败（忽略）');
    }
  }

  Logger.info(TAG, `自检结束：${res.detail}`);
  return res;
}
