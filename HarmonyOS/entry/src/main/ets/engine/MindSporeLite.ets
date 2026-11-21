/*
 * MindSpore Lite 端侧推理后端 —— Parakeet 编码器在麒麟 NPU 上运行。
 *
 * ============================ 重要事实（务必先读） ============================
 *
 * 1. **NPU 的 target 值是 `'nnrt'`，不是 `'npu'`。**
 *    HarmonyOS 上第三方 ArkTS 应用访问 NPU 的唯一官方路径是
 *    MindSpore Lite 的 Neural Network Runtime（NNRt）后端：
 *        context.target = ['nnrt']
 *        context.nnrt.deviceID = <来自 getAllNNRTDeviceDescriptions()>
 *    网上常见的 `context.target = ['npu']` 属于**错误写法**。
 *
 * 2. **NNRt 不支持模拟器，只支持带 NPU 的真机。**
 *    因此本文件在枚举不到 NNRT 设备时**自动降级到 CPU**，而不是抛错。
 *
 * 3. **模型必须是 `.ms` 格式**（由 PC 上的 `converter_lite` 转换）。
 *    ONNX 不能直接加载。转换与量化步骤见 docs/MODEL_CONVERSION.md。
 *
 * 4. **编码器必须是定长图 `[1,128,1501]`** —— 与 PC 上的 OpenVINO 路径一致。
 *    转换时用 `--inputShape="audio_signal:1,128,1501;length:1"` 静态化，
 *    否则 NPU 编译器无法做常量折叠。
 *
 * 5. 预测网络 + joint 网络**刻意放在 CPU 上跑**。
 *    原因：TDT 解码需要 Gather/GatherNd/Squeeze/Stack/LogSoftmax/TopK 等算子，
 *    这些在麒麟 NPU 上不支持（见 docs/NPU_NOTES.md 的算子表）。
 *    所幸这块计算量极小（PC 实测 <1 ms/步），真正的大头是编码器。
 *
 * ==========================================================================
 *
 * 本文件的 API 用法**已逐条对照真实 SDK 声明文件核实**：
 *   <SDK>/default/openharmony/ets/api/@ohos.ai.mindSporeLite.d.ts
 *
 * 核实中修正的三处错误（都是「编译不过」级别，不是风格问题）：
 *   a) 没有 `ModelBuilder` 类 —— 加载是**命名空间函数**
 *      `mindSporeLite.loadModelFromFile / loadModelFromBuffer / loadModelFromFd`；
 *   b) `CpuDevice.precisionMode` 的类型是 **string**，不存在 `PrecisionMode` 枚举；
 *   c) `Model` 接口**没有** `getOutputs()`，也**没有** `release()` ——
 *      输出只能来自 `predict()` 的返回值；模型对象交给 GC 回收。
 */

import { mindSporeLite } from '@kit.MindSporeLiteKit';
import { EncoderOutput, JointStepOutput } from 'common';
import { Logger } from './Logger';
import mslite from 'libmslite.so';

const TAG = 'MsLite';

/** 推理后端种类。 */
export class BackendKind {
  static readonly NNRT: string = 'nnrt';
  static readonly CPU: string = 'cpu';
}

/** NNRt 设备描述（对官方 API 的薄封装）。 */
export class NnrtDevice {
  readonly deviceId: bigint;
  readonly name: string;
  readonly type: mindSporeLite.NNRTDeviceType;

  constructor(deviceId: bigint, name: string, type: mindSporeLite.NNRTDeviceType) {
    this.deviceId = deviceId;
    this.name = name;
    this.type = type;
  }

  /** 是否是「专用硬件加速器」——也就是真正意义上的 NPU。 */
  get isAccelerator(): boolean {
    return this.type === mindSporeLite.NNRTDeviceType.NNRTDEVICE_ACCELERATOR;
  }
}

/**
 * MindSpore Lite 上下文与设备的探测/构建。
 *
 * 探测结果会被缓存，因为枚举 NNRT 设备在部分 ROM 上较慢。
 */
export class MsLiteRuntime {
  private static deviceCache: NnrtDevice[] | null = null;
  private static nnrtError: string = '';

  /** 本机可用的 NNRt（NPU）设备列表；为空表示只能走 CPU。 */
  static nnrtDevices(): NnrtDevice[] {
    const cached = MsLiteRuntime.deviceCache;
    if (cached !== null) {
      return cached;
    }
    const out: NnrtDevice[] = [];
    try {
      // API 12+。返回 NNRTDeviceDescription[]，其 deviceID() 返回 bigint。
      const devices: mindSporeLite.NNRTDeviceDescription[] =
        mindSporeLite.getAllNNRTDeviceDescriptions();
      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        try {
          const id: bigint = d.deviceID();
          const type: mindSporeLite.NNRTDeviceType = d.deviceType();
          let name = '';
          try {
            name = d.deviceName();
          } catch (inner) {
            name = '';
          }
          out.push(new NnrtDevice(id, name, type));
        } catch (inner) {
          Logger.warn(TAG, '读取某个 NNRt 设备描述失败，跳过');
        }
      }
      Logger.info(TAG, `发现 ${out.length} 个 NNRt 设备`);
    } catch (err) {
      const e = err as Error;
      MsLiteRuntime.nnrtError = e.message;
      // 常见原因：模拟器 / 该机型无 NPU / API 版本低于 12 / 系统未提供该能力。
      Logger.warn(TAG, `NNRt 设备枚举失败（将使用 CPU）：${e.message}`);
    }
    MsLiteRuntime.deviceCache = out;
    return out;
  }

  /** 本机是否具备可用的 NPU 推理能力。 */
  static hasNpu(): boolean {
    return MsLiteRuntime.nnrtDevices().length > 0;
  }

  /** 探测失败时的原始错误信息（用于「模型与性能」页面展示）。 */
  static nnrtFailure(): string {
    MsLiteRuntime.nnrtDevices();
    return MsLiteRuntime.nnrtError;
  }

  /**
   * 构建推理上下文。
   * @param preferNpu true 且存在 NPU 时用 NNRt，否则 CPU
   * @param threads CPU 线程数
   */
  static buildContext(preferNpu: boolean, threads: number = 4): MsLiteContext {
    const ctx: mindSporeLite.Context = {};
    const devices = preferNpu ? MsLiteRuntime.nnrtDevices() : [];
    let usedNpu = false;

    if (devices.length > 0) {
      try {
        const nnrt: mindSporeLite.NNRTDevice = {};
        nnrt.deviceID = devices[0].deviceId;
        // 性能模式与优先级都是可选项；识别是前台交互任务，给 HIGH 更合适。
        nnrt.performanceMode = mindSporeLite.PerformanceMode.PERFORMANCE_HIGH;
        nnrt.priority = mindSporeLite.Priority.PRIORITY_HIGH;
        ctx.nnrt = nnrt;
        ctx.target = [BackendKind.NNRT];
        usedNpu = true;
      } catch (err) {
        const e = err as Error;
        Logger.warn(TAG, `设置 NNRt 上下文失败，回退 CPU：${e.message}`);
        usedNpu = false;
      }
    }

    if (!usedNpu) {
      const cpu: mindSporeLite.CpuDevice = {};
      cpu.threadNum = threads > 0 ? threads : 4;
      // 大小核优先绑定：移动端把推理压到大核上能明显降低延迟。
      cpu.threadAffinityMode = mindSporeLite.ThreadAffinityMode.BIG_CORES_FIRST;
      // ⚠️ precisionMode 的类型是 **string**（不是枚举）。
      // NeMo 的 LayerNorm 对 FP16 敏感，所以显式不要 FP16。
      cpu.precisionMode = 'preferred_fp32';
      ctx.cpu = cpu;
      ctx.target = [BackendKind.CPU];
    }

    const label = usedNpu
      ? (devices[0].name.length > 0 ? `NPU (${devices[0].name})` : 'NPU')
      : `CPU (${threads} 线程)`;
    return new MsLiteContext(ctx, usedNpu ? BackendKind.NNRT : BackendKind.CPU,
      devices.length > 0 ? devices[0].name : '');
  }
}

/** 推理上下文 + 可读描述。 */
export class MsLiteContext {
  readonly context: mindSporeLite.Context;
  /** 'nnrt' 或 'cpu' */
  readonly target: string;
  /** 人类可读的后端名，例如 "NPU (…)" / "CPU (4 线程)"。 */
  readonly label: string;
  /**
   * `model.getInputs()` 不可用时，退而使用的输入张量名。
   *
   * 真机上遇到过 `getInputs()` 返回 `undefined` 的情况。喂数据是按名字查的
   * （`predict` 里 `inputs.get(t.name)`），所以只要能拿到名字就能继续跑，
   * 只是失去了「张量尺寸校验」这层保护。
   */
  fallbackInputNames: string[] = [];

  constructor(context: mindSporeLite.Context, target: string, deviceName: string) {
    this.context = context;
    this.target = target;
    this.label = target === BackendKind.NNRT
      ? (deviceName.length > 0 ? `NPU (${deviceName})` : 'NPU')
      : 'CPU';
  }

  get isNpu(): boolean {
    return this.target === BackendKind.NNRT;
  }

  /** 供日志使用的目标描述。 */
  get targetText(): string {
    return this.target;
  }
}

/**
 * 一个已加载的 `.ms` 模型（编码器或 decoder_joint）。
 *
 * 注意两个 API 事实：
 *   - 加载用的是**命名空间函数**，不是某个 builder 类；
 *   - `Model` 没有 `getOutputs()`，也没有 `release()` ——
 *     输出只来自 `predict()` 的返回值，模型对象交给 GC。
 */
export class MsLiteModel {
  private model: mindSporeLite.Model | null = null;
  private nativeContext: bigint = BigInt(0);
  private nativeModelId: number = 0;
  private nativeMode: boolean = false;
  private readonly path: string;
  private readonly ctx: MsLiteContext;
  private inputNames: string[] = [];
  /** 最近一次 predict 的输出张量名，用于报错时指明实际有哪些输出。 */
  lastOutputNames: string[] = [];
  /** 输出名 -> 在 predict 返回数组里的下标。 */
  private outputIndex: Map<string, number> = new Map();
  /** getInputs() 返回的是**有状态输入缓冲**，缓存复用避免每步重分配。 */
  private inputTensors: mindSporeLite.MSTensor[] = [];
  private loaded = false;
  /** 是否拿到了可用的输入张量对象（决定这个模型能否真的推理）。 */
  private inputsReady = false;

  constructor(path: string, ctx: MsLiteContext) {
    this.path = path;
    this.ctx = ctx;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 输入张量是否可用。
   *
   * ⚠️ 真机实测（Kirin 9020 / MindSpore Lite 2.x）：
   * **target=nnrt 时 `model.getInputs()` 返回 undefined**，`model` 上也没有
   * 任何可枚举属性；而同一台机器上 **target=cpu 时正常返回张量数组**。
   * 没有输入张量就无法构造 `predict()` 的入参，模型等于不可用。
   *
   * 所以加载后要检查这个标志，NPU 不可用时**必须换 CPU 重新加载**。
   */
  get canInfer(): boolean {
    return this.loaded && this.inputsReady;
  }

  get backendLabel(): string {
    return this.ctx.label;
  }

  /** 输入张量名（加载后可用）。 */
  get inputs(): string[] {
    return this.inputNames;
  }

  /**
   * 加载模型。
   *
   * @param fd 传入 >= 0 时用 `loadModelFromFd`（大模型推荐，避免二次驻留）；
   *           否则用 `loadModelFromFile`。
   *
   * 622 MB 的编码器在部分 ROM 上用文件路径加载会因峰值内存失败，
   * 因此 ParakeetEngine 在失败时回退到 fd 路径。
   */
  async load(fd: number = -1): Promise<void> {
    if (this.loaded) {
      return;
    }
    const t0 = Date.now();
    if (this.ctx.isNpu) {
      this.nativeMode = true;
      try {
        this.nativeContext = mslite.createContext(4);
        this.nativeModelId = mslite.loadModel(this.nativeContext, this.path);
        this.inputNames = mslite.getInputNames(this.nativeModelId);
        this.inputsReady = this.inputNames.length > 0;
        this.loaded = true;
        this.outputIndex.clear();
        this.lastOutputNames = [];
        Logger.info(TAG, `原生 C API 加载 ${this.path}（${this.ctx.label}），`
          + `输入 [${this.inputNames.join(', ')}]，用时 ${Date.now() - t0} ms`);
        return;
      } catch (err) {
        this.nativeMode = false;
        if (this.nativeModelId > 0) {
          mslite.destroyModel(this.nativeModelId);
          this.nativeModelId = 0;
        }
        if (this.nativeContext !== BigInt(0)) {
          mslite.destroyContext(this.nativeContext);
          this.nativeContext = BigInt(0);
        }
        const e = err as Error;
        throw new Error(e.message);
      }
    }
    const model: mindSporeLite.Model = fd >= 0
      ? await mindSporeLite.loadModelFromFd(fd, this.ctx.context)
      : await mindSporeLite.loadModelFromFile(this.path, this.ctx.context);
    if (model === undefined || model === null) {
      throw new Error(`加载 ${this.path} 返回了 ${model}`);
    }
    this.model = model;

    // ⚠️ 真机实测：`model.getInputs()` 的结果会让
    // `inputTensors.length` 抛 "Cannot read property length of undefined"。
    //
    // 最可能的原因是**绑定层返回的是原生数组对象，没有被自动转成 JS 数组**
    // —— 这种情况下 `typeof` 是 object、但 `.length` 是 undefined。
    // 用 `Array.from()` 归一化：是真数组就等价于浅拷贝，是原生数组则完成转换。
    let tensors: mindSporeLite.MSTensor[] = [];
    let rawDesc = '?';
    try {
      const raw = model.getInputs();
      if (raw === undefined || raw === null) {
        rawDesc = String(raw);
      } else {
        // 先探测原始形态，诊断日志要靠它区分「原生数组」与「真数组」。
        // 不能用 ESObject/any（ArkTS 的 arkts-no-any-unknown 规则禁止），
        // 所以用两个类型安全的判据：Array.isArray 与安全的 .length 读取。
        let lenText = '读取失败';
        try {
          lenText = String(raw.length);
        } catch (inner) {
          lenText = '读 length 抛异常';
        }
        rawDesc = `typeof=${typeof raw}, isArray=${Array.isArray(raw)}, `
          + `length=${lenText}`;
        tensors = Array.from(raw);
      }
    } catch (err) {
      const e = err as BusinessError;
      Logger.error(TAG, `getInputs() 失败：${e.code} ${e.message}`);
      rawDesc = `抛异常 ${e.message}`;
    }

    Logger.info(TAG, `getInputs() 原始形态：${rawDesc}；归一化后 ${tensors.length} 个张量`);

    if (tensors.length === 0) {
      // 打诊断：模型对象上到底有什么
      const keys = Object.keys(model);
      Logger.error(TAG, `拿不到输入张量（getInputs 原始形态 ${rawDesc}）。`
        + `model 上的键=[${keys.join(', ')}]，target=${this.ctx.targetText}`);
      // 退路：按名字约定登记输入名。但 predict 需要张量对象，
      // 所以这里明确标记为不可推理，避免悄悄跑出垃圾结果。
      this.inputTensors = [];
      this.inputNames = this.ctx.fallbackInputNames.slice();
      this.loaded = true;
      this.inputsReady = false;
      this.outputIndex.clear();
      this.lastOutputNames = [];
      Logger.warn(TAG, `已加载 ${this.path}（${this.ctx.label}），`
        + `但输入张量对象不可用；调用方应换后端重试。`);
      return;
    }

    this.inputTensors = tensors;
    this.inputNames = [];
    for (let i = 0; i < tensors.length; i++) {
      const t = tensors[i];
      if (t === undefined || t === null) {
        continue;
      }
      this.inputNames.push(t.name);
    }
    this.loaded = true;
    this.inputsReady = true;
    // 输出名只有在第一次 predict 之后才拿得到（Model 接口没有 getOutputs）。
    this.outputIndex.clear();
    this.lastOutputNames = [];
    Logger.info(TAG, `已加载 ${this.path}（${this.ctx.label}），`
      + `用时 ${Date.now() - t0} ms；输入 [${this.inputNames.join(', ')}]`);
  }

  /**
   * 执行一次推理。
   * @param inputs 名字 -> 数据（`ArrayBuffer`，长度必须与张量 dataSize 一致）
   * @returns 输出张量的 Float32Array，顺序与模型输出一致
   */
  async predict(inputs: Map<string, ArrayBuffer>): Promise<Float32Array[]> {
    if (this.nativeMode) {
      if (this.nativeModelId <= 0 || !this.inputsReady) {
        throw new Error(`原生模型 ${this.path} 尚未准备好输入张量`);
      }
      for (const name of this.inputNames) {
        const data = inputs.get(name);
        if (data === undefined) {
          throw new Error(`缺少输入张量 ${name}（模型需要 [${this.inputNames.join(', ')}]）`);
        }
        mslite.setInputData(this.nativeModelId, name, data);
      }
      mslite.predict(this.nativeModelId);
      const names: string[] = this.inputNames.some((name: string): boolean => name === 'audio_signal')
        ? ['outputs', 'encoded_lengths']
        : ['outputs', 'prednet_lengths', 'output_states_1', 'output_states_2'];
      const result: Float32Array[] = [];
      this.outputIndex.clear();
      this.lastOutputNames = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const data = mslite.getOutputData(this.nativeModelId, name);
        if (data === null) {
          continue;
        }
        const info = mslite.getTensorInfo(this.nativeModelId, name, false);
        const values = nativeOutputToFloat(data, info === null ? 0 : info.dtype);
        this.outputIndex.set(name, result.length);
        this.lastOutputNames.push(name);
        result.push(values);
      }
      return result;
    }
    const model = this.model;
    if (model === null) {
      throw new Error('模型尚未加载');
    }
    const tensors = this.inputTensors;
    if (tensors.length === 0) {
      // 静默传空数组会让底层行为不可预期（可能崩、也可能返回垃圾），
      // 这里显式失败并指明原因，避免"识别结果为空"这种难查的表现。
      throw new Error(`拿不到模型 ${this.path} 的输入张量对象`
        + `（getInputs() 返回空/undefined）。`
        + `已记录诊断日志，请查看 ${TAG} 的 error 行。`);
    }
    for (let i = 0; i < tensors.length; i++) {
      const t = tensors[i];
      const data = inputs.get(t.name);
      if (data === undefined) {
        throw new Error(`缺少输入张量 ${t.name}（模型需要 [${this.inputNames.join(', ')}]）`);
      }
      const expected = t.dataSize;
      if (expected > 0 && data.byteLength !== expected) {
        throw new Error(`输入张量 ${t.name} 大小不符：`
          + `给了 ${data.byteLength} 字节，模型要 ${expected} 字节`);
      }
      t.setData(data);
    }
    // predict() 的返回值就是输出张量列表。
    const outTensors: mindSporeLite.MSTensor[] = await model.predict(tensors);
    if (outTensors === undefined || outTensors === null) {
      throw new Error(`model.predict() 返回了 ${outTensors}（期望张量数组）`);
    }
    const result: Float32Array[] = [];
    this.outputIndex.clear();
    this.lastOutputNames = [];
    for (let i = 0; i < outTensors.length; i++) {
      const t = outTensors[i];
      if (t === undefined || t === null) {
        Logger.warn(TAG, `输出张量 ${i} 为 ${t}，跳过`);
        continue;
      }
      // 记录真实元信息：真机上 getData() 的返回内容/类型可能与声明不符，
      // 出问题时这行日志能直接指出是哪个输出异常。
      const raw = t.getData();
      const shapeText = t.shape !== undefined ? t.shape.join(',') : '?';
      const rawDesc = raw === undefined || raw === null
        ? String(raw) : `${raw.byteLength} B`;
      Logger.info(TAG, `输出[${i}] name="${t.name}" dtype=${t.dtype} `
        + `shape=[${shapeText}] dataSize=${t.dataSize} getData=${rawDesc}`);
      if (raw === undefined || raw === null) {
        throw new Error(`输出张量 "${t.name}" 的 getData() 返回了 ${raw}`
          + `（dtype=${t.dtype}, shape=[${shapeText}], dataSize=${t.dataSize}）。`
          + `若 dtype 不是 float32，说明模型输出类型与预期不符。`);
      }
      if (t.name !== undefined && t.name.length > 0) {
        this.outputIndex.set(t.name, i);
        this.lastOutputNames.push(t.name);
      }
      // ⚠️ 必须按 dtype 转换，不能一律 toFloat32。
      //
      // 真机上踩过：`encoded_lengths` 是 **int64**，把它按 float32 读时，
      // 188 的字节序列（BC 00 00 00 00 00 00 00）被解释成 2.6e-22，
      // 取整后变成 0 —— 于是 validFrames=0，解码器静默返回，识别出 0 条字幕，
      // 而整个过程没有任何报错。这类 bug 极难定位。
      result.push(convertOutput(raw, t));
    }
    return result;
  }

  /**
   * 按**名字**取输出张量。
   *
   * 为什么不按下标：实测 decoder_joint 有 4 个输出
   * （outputs, prednet_lengths, output_states_1, output_states_2），
   * 而转换器/版本对输出顺序不作保证。按下标取会把 prednet_lengths 误当成
   * LSTM 隐状态，导致解码状态错位、识别结果全错。
   *
   * @returns 找到则返回 Float32Array，否则 null
   */
  outputByName(outs: Float32Array[], name: string): Float32Array | null {
    const idx = this.outputIndex.get(name);
    if (idx === undefined || idx < 0 || idx >= outs.length) {
      return null;
    }
    return outs[idx];
  }

  /**
   * 释放。
   *
   * MindSpore Lite 的 ArkTS `Model` 接口没有 `release()`，模型由 GC 回收；
   * 这里只断开引用并把缓存清掉。
   */
  async release(): Promise<void> {
    if (this.nativeMode) {
      if (this.nativeModelId > 0) {
        mslite.destroyModel(this.nativeModelId);
      }
      if (this.nativeContext !== BigInt(0)) {
        mslite.destroyContext(this.nativeContext);
      }
      this.nativeModelId = 0;
      this.nativeContext = BigInt(0);
      this.nativeMode = false;
      this.loaded = false;
      this.inputsReady = false;
      this.inputNames = [];
      this.lastOutputNames = [];
      this.outputIndex.clear();
      return;
    }
    this.loaded = false;
    this.model = null;
    this.inputTensors = [];
  }
}

/** 把原生 C API 返回的字节缓冲按真实 dtype 转成统一的 Float32Array。 */
function nativeOutputToFloat(data: ArrayBuffer, dtype: number): Float32Array {
  if (dtype === 35) {
    const src = new BigInt64Array(data);
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = Number(src[i]);
    }
    return out;
  }
  if (dtype === 34) {
    const src = new Int32Array(data);
    return Float32Array.from(src);
  }
  return new Float32Array(data);
}

/**
 * 按张量 dtype 把原始字节转成 Float32Array。
 *
 * 为什么需要：模型输出里混着 int64/int32（典型如 `encoded_lengths`、
 * `prednet_lengths`），把它们按 float32 读会得到接近 0 的垃圾值。
 * 这里先把整型**按数值**读出来，再存进 Float32Array ——
 * 数值 < 2^24 时 float32 能精确表示，对这些长度/索引类张量完全够用。
 *
 * 保持返回类型仍是 `Float32Array`，避免改动所有调用点。
 */
function convertOutput(raw: ArrayBuffer, meta: mindSporeLite.MSTensor): Float32Array {
  // 用**命名枚举**比较，不能用裸数字：ArkTS 会把 `DataType` 与 number
  // 的比较判为 "no overlap" 编译错误。
  //
  // 实测取值：FLOAT32=43、INT32=34、INT64=35（与真机日志一致）。
  const dt: mindSporeLite.DataType = meta.dtype;
  const bytes = raw.byteLength;
  const view = new DataView(raw);
  let out: Float32Array;

  if (dt === mindSporeLite.DataType.NUMBER_TYPE_INT64
    || dt === mindSporeLite.DataType.NUMBER_TYPE_UINT64) {
    const isSigned = dt === mindSporeLite.DataType.NUMBER_TYPE_INT64;
    const n = Math.floor(bytes / 8);
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // 这些张量存的是长度/索引，取值远小于 2^53，转 Number 安全
      out[i] = isSigned ? Number(view.getBigInt64(i * 8, true))
                        : Number(view.getBigUint64(i * 8, true));
    }
    return out;
  }
  if (dt === mindSporeLite.DataType.NUMBER_TYPE_INT32
    || dt === mindSporeLite.DataType.NUMBER_TYPE_UINT32) {
    const isSigned = dt === mindSporeLite.DataType.NUMBER_TYPE_INT32;
    const n = Math.floor(bytes / 4);
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = isSigned ? view.getInt32(i * 4, true) : view.getUint32(i * 4, true);
    }
    return out;
  }
  if (dt === mindSporeLite.DataType.NUMBER_TYPE_INT16
    || dt === mindSporeLite.DataType.NUMBER_TYPE_UINT16) {
    const isSigned = dt === mindSporeLite.DataType.NUMBER_TYPE_INT16;
    const n = Math.floor(bytes / 2);
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = isSigned ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true);
    }
    return out;
  }
  if (dt === mindSporeLite.DataType.NUMBER_TYPE_INT8
    || dt === mindSporeLite.DataType.NUMBER_TYPE_UINT8) {
    const isSigned = dt === mindSporeLite.DataType.NUMBER_TYPE_INT8;
    out = new Float32Array(bytes);
    for (let i = 0; i < bytes; i++) {
      const b = view.getUint8(i);
      out[i] = isSigned && b > 127 ? b - 256 : b;
    }
    return out;
  }

  // 其余（FLOAT32 / FLOAT16 / 未知）按原路径处理
  return toFloat32(raw, meta);
}

/**
 * ArrayBuffer -> Float32Array。
 *
 * ⚠️ 真机上踩过：`MSTensor.getData()` 在某些情况下会返回 `undefined`
 * （例如 dtype 不是 float32、或张量未分配数据）。此时访问
 * `raw.byteLength` 会抛 `Cannot read property 'length' of undefined`
 * ——完全看不出根因。所以这里显式校验并给出可操作的报错。
 */
function toFloat32(raw: ArrayBuffer, meta?: mindSporeLite.MSTensor): Float32Array {
  if (raw === undefined || raw === null) {
    const name = meta !== undefined ? meta.name : '?';
    const dtype = meta !== undefined ? String(meta.dtype) : '?';
    throw new Error(`张量 "${name}" 没有数据（getData() 返回 ${raw}，dtype=${dtype}）`);
  }
  if (raw.byteLength % 4 === 0) {
    return new Float32Array(raw);
  }
  const n = Math.floor(raw.byteLength / 4);
  const out = new Float32Array(n);
  const view = new DataView(raw);
  for (let i = 0; i < n; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/** Float32/Float64 -> 独立 ArrayBuffer（setData 需要一个不与源共享的缓冲）。 */
export function toTensorBuffer(data: Float64Array | Float32Array): ArrayBuffer {
  if (data instanceof Float32Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i];
  }
  return out.buffer;
}

/** Int32 张量。 */
export function toInt32Buffer(data: number[]): ArrayBuffer {
  return Int32Array.from(data).buffer;
}
