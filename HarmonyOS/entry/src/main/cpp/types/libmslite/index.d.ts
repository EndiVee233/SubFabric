/*
 * NAPI 原生模块 `libmslite.so` 的 ArkTS 类型声明。
 *
 * 对应实现：entry/src/main/cpp/mslite_napi.cpp
 *
 * 为什么需要这层：ArkTS 的 `@ohos.ai.mindSporeLite` 在 NNRt（NPU）后端下
 * `model.getInputs()` 返回 undefined，拿不到输入张量就无法 predict。
 * 官方 C API 没有这个限制。
 *
 * 使用示例：
 *   import mslite from 'libmslite.so';
 *   const ctx = mslite.createContext(4);
 *   const model = mslite.loadModel(ctx, '/data/.../encoder.ms');
 *   mslite.setInputData(model, 'audio_signal', buf);
 *   mslite.setInputData(model, 'length', lenBuf);
 *   mslite.predict(model);
 *   const out = mslite.getOutputData(model, 'outputs');
 *   mslite.destroyModel(model);
 *   mslite.destroyContext(ctx);
 */

/** 张量元信息。 */
export interface TensorInfo {
  /** 张量名。 */
  name: string;
  /**
   * MindSpore Lite 的数据类型码（OH_AI_DataType）：
   *   43 = FLOAT32, 42 = FLOAT16, 34 = INT32, 35 = INT64,
   *   32 = INT8, 37 = UINT8, 33 = INT16, 38 = UINT16,
   *   39 = UINT32, 40 = UINT64
   */
  dtype: number;
  /** 形状（按维）。 */
  shape: number[];
  /** 数据字节数。 */
  dataSize: number;
  /** 元素个数。 */
  elementNum: number;
}

export interface MsLiteNative {
  /**
   * 创建推理上下文，**强制 NNRt（NPU）**。
   *
   * 枚举不到 NPU 设备时直接抛异常，不做 CPU 降级 —— 与本工程
   * 「只用 NPU」的要求一致。
   *
   * @param threads CPU 线程数（NPU 图上不生效，但有算子回落到 CPU 时有用）
   * @returns 上下文句柄（bigint，内部为指针值）
   */
  createContext(threads?: number): bigint;

  /** 销毁上下文。 */
  destroyContext(ctx: bigint): boolean;

  /**
   * 从文件构建模型。
   *
   * @param ctx createContext 的返回值
   * @param path 沙箱内 `.ms` 的绝对路径
   * @returns 模型 id（> 0）
   * @throws 构建失败（算子不支持、模型未按 NPU 转换、文件损坏等）
   */
  loadModel(ctx: bigint, path: string): number;

  /** 销毁模型，释放其内存。 */
  destroyModel(modelId: number): boolean;

  /** 输入张量名列表（按模型定义顺序）。 */
  getInputNames(modelId: number): string[];

  /** 取张量元信息；名字不存在时返回 null。 */
  getTensorInfo(modelId: number, name: string, isInput: boolean): TensorInfo | null;

  /**
   * 按名字写入输入数据。
   *
   * ArrayBuffer 的长度**必须**等于该张量的 dataSize，否则抛异常
   * （长度不符是最常见的错误来源，早失败比让底层行为不可预期好）。
   */
  setInputData(modelId: number, name: string, data: ArrayBuffer): boolean;

  /** 执行一次推理。 */
  predict(modelId: number): boolean;

  /**
   * 取输出张量数据（**返回的是拷贝**）。
   *
   * 拷贝是刻意的：底层 `OH_AI_TensorGetData` 返回模型内部缓冲指针，
   * 下次 predict 会被覆盖，包成 external ArrayBuffer 有生命周期陷阱。
   *
   * @returns 数据副本；名字不存在时返回 null
   */
  getOutputData(modelId: number, name: string): ArrayBuffer | null;
}

declare const mslite: MsLiteNative;
export default mslite;
