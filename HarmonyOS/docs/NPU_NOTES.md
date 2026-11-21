# 鸿蒙端侧 AI 推理：可用路径、算子约束与风险

本文是适配工作的调研沉淀，目的是让接手的人不必重走一遍。
**每条结论都标了可信度**：✅ 有多源/权威依据 · ⚠️ 单源或二手 · ❌ 未能验证。

---

## 1. 第三方应用访问 NPU：只有一条官方路径

### ✅ MindSpore Lite + NNRt 后端

```ts
import { mindSporeLite } from '@kit.MindSporeLiteKit';

const ctx: mindSporeLite.Context = {};
ctx.target = ['nnrt'];                       // ← 注意：是 'nnrt'，不是 'npu'
const devices = mindSporeLite.getAllNNRTDeviceDescriptions();   // API 12+
if (devices.length > 0) {
  const nnrt: mindSporeLite.NNRTDevice = {};
  nnrt.deviceID = devices[0].deviceID();     // 返回 bigint
  ctx.nnrt = nnrt;
} else {
  // 必须优雅降级，而不是抛错
  ctx.target = ['cpu'];
  const cpu: mindSporeLite.CPUDevice = {};
  cpu.threadNum = 4;
  cpu.precisionMode = mindSporeLite.PrecisionMode.PREFER_FP32;
  ctx.cpu = cpu;
}
```

要点：
- **不需要任何权限声明**（声明文件里没有 `@permission`）；
- 需要在 `module.json5` 声明 `SystemCapability.AI.MindSporeLite`；
- **NNRt 不支持模拟器**，只能真机；
- 不是所有模型都能走 NNRt —— 官方示例自己也会标注某些模型不支持；
- ⚠️ `'nnrt'` 这个字符串与 `getAllNNRTDeviceDescriptions()` 的精确签名
  来自单一来源（SDK 声明文件的转述）。**请以本地
  `@ohos.ai.mindSporeLite.d.ts` 为准。** 本项目的封装把整段包在 try/catch 里，
  签名不符只会退回 CPU，不会崩。

### ✅ NNRt 是 C API，没有 ArkTS 版本

`OH_NN_DeviceType { OH_NN_OTHERS=0, OH_NN_CPU=1, OH_NN_GPU=2, OH_NN_ACCELERATOR=3 }`
—— 枚举里**没有 `NPU`**，NPU 是 `OH_NN_ACCELERATOR`，具体设备由**设备名**选定
（HiAI 的是 `"HIAI_F"`）。

所以网上流传的 `import ... from '@ohos.ai.nnruntime'`、`context.target = ['npu']`
都是**错的**。

### ⚠️ HiAI Foundation Kit：真正的 NPU 路径，但门槛未知

- ✅ 面向麒麟平台、跑在达芬奇架构 NPU 上，与云端 Ascend 共用 Ascend C 工具链；
- ✅ 官方示例是 **C++/NAPI**（`hiaifoundationkit-samplecode-clientdemo-cpp`）；
- ✅ 工具链：`tools_omg` 把 Caffe/TF/ONNX/MindSpore 转成 **`.om`**，`tools_dopt` 做量化；
- ❌ **是否需要白名单 / 企业认证 / 开发者联盟申请，未能验证** —— 这是整个调研里
  最大的未知项。存在华为托管的 DDK 与 Gitee 上的 DDK demo，暗示有合作方通道，
  但这是推断不是事实。

**取舍**：MindSpore Lite 路线开箱可用、不需要资质，因此本项目选它。
若后续要做极限性能，再评估 HiAI Foundation。

### ❌ 不能到 NPU 的路径

| 路径 | 结论 |
| --- | --- |
| ONNX Runtime（自编译 `.so` + NAPI） | **CPU only**。ORT 的 NPU EP 是 NNAPI/QNN/CoreML/OpenVINO/Vitis-AI，**没有 NNRt**，也没有任何 Kirin EP |
| sherpa-onnx（ohpm `sherpa_onnx`） | **CPU only**。其 NPU 支持列表是 RKNN / QNN / Ascend / Axera / Intel OpenVINO，**不含 Kirin/HiAI/NNRt**；所有日志都是 `provider="cpu"` |
| CANN Kit | 属于**设备开发**文档集（Ascend），应用侧 reference 里没有 `apis-cann-kit`，不适用于手机应用 |
| `@ohos.ai.intelligentVoice` | 华为自己的唤醒词/声纹 API，是 **`-sys` 系统接口**，第三方不可用 |

---

## 2. 算子覆盖：为什么必须切图

### ✅ Kirin NPU 支持的算子（节选，MindSpore Lite 官方算子表）

`Abs` `Activation` `AddFusion` `ArgmaxFusion` `AvgPoolFusion` `BiasAdd` `Cast`
`Concat` `Conv2DFusion` `DivFusion` `Eltwise` `ExpandDims` `FullConnection`
`FusedBatchNorm` `Gather` `InstanceNorm` `LeakyReLU` `Log` `MatMulFusion`
`Maximum` `MaxPoolFusion` `Minimum` `MulFusion` `Neg` `PadFusion` `ReduceFusion`
`Reshape` `Rsqrt` `ScaleFusion` `SliceFusion` `Softmax` `Split` `Sqrt` `Square`
`StridedSlice` `SubFusion` `TileFusion` `Transpose` `Unsqueeze`

### ❌ Kirin NPU **不支持**的算子（节选）

`BatchNorm` `ExpFusion` `Fill` `Flatten` `GatherD` `GatherNd` **`LayerNormFusion`**
**`LogSoftmax`** `NonMaxSuppression` `PReLUFusion` `PowFusion` `Squeeze` `Stack`
**`TopKFusion`** `Where` `Select` `Dropout` `SpaceToBatchND` `SpaceToDepth`
以及全部 `*Grad` 训练算子

### ⇒ 对本项目的直接后果

TDT 解码需要 `GatherNd` / `Squeeze` / `Stack` / `LogSoftmax` / `TopK`
——**五个全不在支持列表里**（`Gather`/`SliceFusion`/`StridedSlice` 支持，
但这不够）。

如果硬把整张 parakeet 图交给 NPU，MindSpore Lite 会做
「自适应的子图拆分和设备协同调度」，也就是**每次推理都在 NPU 和 CPU 之间
来回搬数据**。对一个每 10 ms 就要调一次的小图（joint）来说，
搬运开销会远大于计算本身。

**所以本项目的切分是刻意的：**

```
编码器（24 层 FastConformer，99% 算力）  →  NPU    算子集干净
预测网络 + joint（每步 <1 ms）           →  CPU    避开不支持的算子
TDT 贪心解码                              →  ArkTS  可打断、可跨窗续状态、拿逐词时间戳
```

> ⚠️ 补充约束（来自 HiAI 官方文档）：`LayerNorm` / `InstanceNorm` / `LRN`
> 标注为「NPU 上使用 FP16 计算存在精度风险」；`Convolution` 在
> Cin/Cout 为 16 的倍数时最优。这也是本项目默认 `--fp16=off` 的原因。

---

## 3. 音频与媒体 API（✅ 以官方文档核实）

### 麦克风采集

`@kit.AudioKit` 的 `audio.AudioCapturer`：

- ✅ `AudioSamplingRate.SAMPLE_RATE_16000` 存在；`AudioChannel.CHANNEL_1`；
  `AudioSampleFormat.SAMPLE_FORMAT_S16LE`；`ENCODING_TYPE_RAW`；
- ✅ 权限 `ohos.permission.MICROPHONE`（`SOURCE_TYPE_MIC` /
  `SOURCE_TYPE_VOICE_RECOGNITION` 需要）；
- ⚠️ 读取循环的具体形式（`on('readData')` vs 阻塞 `read(size, isBlocking)`）
  未逐行核实。本项目用 `on('readData')`，这是 API 11+ 的低延迟方式；
- ⚠️ 「具体设备支持的采样率规格会存在差异」—— 所以
  `AudioCapture.ets` 在不支持目标采样率时回落请求 16 kHz，并保留 ArkTS 侧重采样。

### 媒体解码

- ✅ `AVMetadataExtractor`（API 11+）：拿时长/分辨率/封面，**拿不到 PCM**；
  支持格式：视频 MP4 / MPEG-TS / MKV，音频 M4A / AAC / MP3 / OGG / WAV / FLAC / AMR；
  **不支持 HLS/DASH 与直播流**；
- ✅ 要 PCM 需要 `AVCodec`（解复用 + 解码）或 `AVTranscoder`；
- ⚠️ `AVCodec` 的 ArkTS 类名/方法在版本间有调整，**未逐行核实**；
- ❌ **没有发现官方 ArkTS 重采样 API** —— 所以本项目自己在 ArkTS 里做
  声道混合与重采样（整数倍下采样时先做 box 平均抗混叠）。

### 文件选择

- ✅ `picker.DocumentViewPicker` / `AudioViewPicker`，**接口本身无需申请权限**；
- ⚠️ picker 返回的 URI 只有**临时权限**，应用切后台后可能失效。
  所以本项目在导入时**立即把文件复制进应用沙箱**
  （`importToSandbox`），后续只用沙箱路径 —— 这样也顺带避免了
  「原文件被移动/删除导致项目打不开」的问题。

---

## 4. 一多适配（✅ 官方口径）

### ⚠️ 最重要的一条：**不要用折叠状态驱动布局**

官方原文（多设备适配屏幕差异）：

> **不推荐使用折叠状态监听接口实现页面布局的响应式布局和接续，避免在窗口变化但
> 折叠状态未改变的场景下布局未能及时调整，出现页面异常。**

正确做法：

```ts
// 主动校准一次
const bp: WidthBreakpoint = uiContext.getWindowWidthBreakpoint();
// 持续跟随
win.on('windowSizeChange', (size: window.Size) => { /* 重算断点 */ });
```

`foldStatusChange` **只用于功能开关**（悬停态、相机预览等），不参与布局。

### 断点表

| 断点 | 宽度 (vp) | 典型形态 |
| --- | --- | --- |
| XS | (0, 320) | 穿戴 / 折叠态外屏 |
| SM | [320, 600) | 直板手机 |
| MD | [600, 840) | 折叠屏展开 / 手机横屏 |
| LG | [840, 1440) | 平板 |
| XL | [1440, +∞) | PC / 2in1 |

⚠️ 网上流传一个只有 4 段的版本（sm 0–320 / md 320–600 / lg 600–840 / xl >840），
**每一段都错位了一档**。以上 5 段版本有官方页面引用，采信它；
但最终请以 SDK 里的 `WidthBreakpoint` 枚举为准。

### 相关组件

- ✅ `GridRow({ columns: { sm, md, lg, xl }, breakpoints })` + `GridCol({ span })`
  —— 注意**不要嵌套 GridRow**；
- ✅ `Navigation` 的 `NavigationMode.Auto` 断点是 **600 vp**
  （`minNavBarWidth 240` + `minContentWidth 360`）；
- ✅ `SideBarContainer`：`Embed`（宽屏并排）/ `Overlay`（窄屏浮层）/
  `AUTO`（自动）；
- ⚠️ `deviceInfo.deviceType` 返回 `'phone' | 'tablet' | '2in1' | 'default'`，
  但折叠屏折叠与展开都报同一个值，**不能用来判形态**。本项目只用它区分
  「2in1 / 平板」这类稳定属性，形态仍由宽度断点决定。

---

## 5. 风险清单（按优先级）

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | **MindSpore Lite API 签名未核对** | 编译期报错 | 所有调用包 try/catch + CPU 降级；以本地 `.d.ts` 为准修 |
| 2 | **NPU 上能否真的编译成功** | 拿不到 NPU 加速 | 编码器静态化 + 只用支持算子；失败自动退 CPU；兜底换 110M 模型 |
| 3 | **麒麟上无任何公开性能数据** | 无法预估体验 | 真机实测；把「NPU 可用」做成 UI 可见；不要在没测之前承诺实时 |
| 4 | **622 MB 模型的分发** | 不能进 HAP | 首启下载 + `loadModelFromFd`；或换 110M |
| 5 | **AVCodec 签名差异** | mp4 解不了 | 调用集中在一个函数；兜底提示用户转 WAV |
| 6 | HiAI Foundation 是否需要资质 | 若 MindSpore 路线受阻则无备选 | 未验证，需要时直接问华为 |

---

## 6. 明确未能验证的事项

1. HiAI Foundation Kit 对第三方应用的准入条件（白名单 / 企业认证 / 联盟申请）；
2. CANN Kit 支持的设备清单与第三方可达性；
3. NNRt 在各 API 版本（12/13/14/18/20）与各零售 ROM 上的实际可用性；
4. `js-apis-mindSporeLite` 的文档正文（`'nnrt'` 字符串、`getAllNNRTDeviceDescriptions` 签名、
   `PrecisionMode` 枚举成员名、`MSTensor` 属性名均为单源）；
5. `AudioCapturer` 读取循环的精确签名与 `getBufferSize()` 语义；
6. `AVCodec` 解复用 + 解码的 ArkTS 类名/方法；
7. 是否存在官方 ArkTS 重采样 API（未找到，倾向"没有"）；
8. `@ohos.display` 的 `FoldStatus` 成员名与 `foldStatusChange` 的当前拼写；
9. `WidthBreakpoint` 枚举成员名与权威断点值（两个流传版本冲突，已采信 5 段版）；
10. Parakeet 在 **Kirin** 上的任何真实性能数据（公开资料里不存在）。
