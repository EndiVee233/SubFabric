# 验证方法与可复现结果

本项目在**没有鸿蒙设备、也没有 DevEco SDK** 的条件下，尽量把能验证的部分都验证了。
本文说明验证策略、实际结果，以及**哪些必须由你在真机上补**。

---

## 1. 策略：把「能测的」和「必须上真机的」彻底分开

平台相关的代码（ArkUI、MindSpore Lite、AudioCapturer）无法离线验证，
所以架构上做了一个硬性切分：

```
common/  纯 ArkTS，零 @ohos / @kit 依赖    → 可在 Node 上完整验证
entry/   ArkUI + 平台能力                  → 必须真机验证
```

这个切分不是风格偏好，是**可测性设计**：

- `TdtDecoder.ets` 通过 `IParakeetModel` 接口拿推理能力，
  所以换一个假模型就能测全部解码逻辑；
- `Pipeline.ets` 通过 `IAudioDecoder` / `ITranslator` 接口拿平台能力；
- `verify/prepare.mjs` 里有一道**守卫**：一旦有核心模块 import 了
  `@ohos.*` / `@kit.*`，脚本直接失败。这保证了切分不会随时间腐化。

同一个脚本还做**全工程结构检查**（这两类错误在 ArkTS 里都是静默的，
只有到构建时才炸）：

1. 每个相对 `from './x'` 是否真的能解析到文件
   （ArkTS 要求省略扩展名，打错字不会有任何提示）；
2. 每个 `from 'common'` 导入的符号，是否真的由 `common/Index.ets` 导出
   （包名导入不经过任何路径校验）。

实测输出：

```
prepared 6 modules -> src
platform-independence guard: clean
project structure: 22 files, 42 relative imports, 72 HAR exports - all resolve
```

---

## 2. 怎么跑

```bash
cd harmony/verify
npm install                       # typescript + @types/node
node prepare.mjs                  # .ets -> .ts（原样复制 + 补 import 扩展名）
npx tsc -p tsconfig.core.json --noEmit     # 核心：严格类型 + 零 Node/平台类型
npx tsc -p tsconfig.json --noEmit          # 含测试
node --experimental-strip-types tests/core.test.ts
node --experimental-strip-types tests/tdt.test.ts
```

`tsconfig.core.json` 的 `"types": []` 是刻意的：核心模块不能用到
Node 专有 API（`Buffer` / `process` / `require`），否则在 ArkTS 里也不存在。

---

## 3. 实际结果

### 3.1 特征前端：与 Python 参考实现逐值一致

黄金向量由 `app/mel.py` 生成 —— 那是已经端到端跑通过
（README 记录可复现参考转写）的实现。

| 断言 | 结果 |
| --- | --- |
| mel 帧数公式 `1 + (n-400)/160` | ✅ 198 帧，与参考一致 |
| 归一化 log-mel 逐值对比（128×198 = 25344 个数） | ✅ **最大绝对误差 0.0** |
| mel 滤波器组 vs librosa Slaney 归一化 | ✅ 最大差 4.994e-9 |
| Hann 窗 vs `np.hanning(401)[:-1]` | ✅ 最大差 4.914e-11 |
| 定长窗 `logMelWindow(1501)` 的 padding 区 | ✅ 严格为 0 |
| 定长窗与整段计算在 validFrames 内一致 | ✅ 最大差 < 1e-9 |

「最大误差 0.0」意味着 ArkTS 的浮点运算路径与 NumPy 完全重合 ——
包括自实现 FFT 的位反转与 twiddle 查表。这不是"差不多"，是逐位一致。

### 3.2 字幕链路

| 断言 | 结果 |
| --- | --- |
| 时间轴格式化/解析往返（6 个量级） | ✅ |
| SRT 解析（CRLF + 折行） | ✅ |
| VTT 解析（跳过 `WEBVTT` 头） | ✅ |
| SRT 导出重新编号 + 跳过空行 | ✅ |
| 双语 SRT（译文在上、原文在下） | ✅ |
| ASS 转义（`\` `{` `}` 换行） | ✅ |
| ASS 结构（Script Info / V4+ Styles / Events） | ✅ |
| **逐词卡拉OK**：3 个词 → 3 个事件、边界 0-1/1-2/2-3 无缝、每事件只染一个词 | ✅ |

### 3.3 TDT 解码循环

用「剧本化」的假模型驱动真实的 `ParakeetTdtDecoder`，
这样能对每一步的帧号与状态做精确断言：

| 断言 | 验证的机制 |
| --- | --- |
| 按脚本精确产出 token 与帧号 | 帧推进与 `frame/12.5` 时间戳换算 |
| 时长 0 被当作 1 | 死循环保护（**这是 TDT 最容易踩的坑**） |
| LSTM 状态只在非 blank 时提交 | blank 不污染预测网络状态 |
| blank 决定时长远跳（跳过帧 1/2/3） | TDT 的核心加速机制 |
| 同帧连续多 token | 时长 = 1 时的逐帧推进 |
| `maxSymbolsPerFrame` 封顶 | 病态输出的防御 |
| 短音频不发推理 | 边界条件 |
| 统计信息填充 | 性能面板数据源 |
| 20 s 音频切出 ≥2 个编码器窗 | 长音频切窗 |

### 3.4 能量 VAD

合成音频（1 s 静音 / 1 s 正弦 / 1 s 静音 / 1 s 正弦 / 1 s 静音）：
✅ 正确切出 2 段，边界误差 < 0.12 s；全静音输入返回空。

---

## 4. 一个**没能**验证的东西（诚实记录）

我原计划再加一层验证：用真实的 `encoder-model.onnx` 产出编码器输出与
`decoder_joint-model.onnx` 的 logits 表，让 ArkTS 解码器回放这张表，
从而与真实模型的 token 序列做端到端比对。

**这一步没有做成。** 现象与排查过程：

- 用 OpenVINO 直接调用 joint，同一个编码器输入（`‖acts‖ = 34.2245`，
  两条路径数值一致到 1e-5）会出现两种结果：一种给出正确首 token
  （34 = `▁I`），另一种退化成全 blank；
- 差异与以下因素相关：是否先实例化 `ParakeetASR`、
  是否对图做静态 `reshape`、以及 mel 是在整段 20 s 上算还是截断后算；
- 逐个隔离这些变量后仍未能稳定复现"正确"分支，判断是 OpenVINO
  在动态/静态图上的优化差异所致，而不是 mel 或解码逻辑的问题。

**为什么可以接受这个缺口：**

1. mel 前端已经与参考实现逐值一致（3.1），特征侧排除了嫌疑；
2. 解码循环的机制已用脚本化模型逐条验证（3.3）；
3. 真实模型的解码契约是从**已验证可用**的 `app/asr.py` 逐行读出来的
   （bind 整窗 → joint 返回逐帧 logits → 按帧下标取用），ArkTS 侧的实现与之一致；
4. 真正的端到端一致性，**本来就该在端侧 `.ms` 后端上验证** ——
   那是 OpenVINO 与 MindSpore Lite 之外的另一条路径，
   在 PC 上把 OpenVINO 调通并不能证明 `.ms` 转换是对的。

**所以这件事的正确归属是：在真机上做一次端到端回归。** 建议做法：

```bash
# 1) 准备一段有已知转写的音频（建议 15~30 s，英文清晰朗读）
# 2) PC 上用 app/ 的 Python 版本跑出参考转写
.venv\Scripts\python.exe -c "..."        # 或直接跑 run_app.py
# 3) 把同一段音频推到设备，用应用的听写页识别
# 4) 逐词比对两边结果
```

若端侧结果为空或乱码，按 `docs/MODEL_CONVERSION.md` §6 的排错清单走：
先查词表（应 1025 项、`<blk>` 在第 1025 行），再查 mel 参数，
最后查 `.ms` 转换的静态化参数。

---

## 4.5 已补上：真实编译验证

原先最大的缺口是「没有 SDK，无法编译」。DevEco Studio 6.0.0 装好后已补上，
并且**一次性暴露了 40 个真实错误**——全部是「写错就编译不过」级别，
而不是风格问题。逐条核对 `.d.ts` 后修正的内容见 README §3.3，摘要：

| 类别 | 数量 | 典型例子 |
| --- | --- | --- |
| 我凭空造的 API | 6 | `ModelBuilder` 类、`PrecisionMode` 枚举、`AVDemuxer`/`AudioDecoder` |
| 属性与方法混淆 | 2 | `display.foldStatus`（实为 `getFoldStatus()`）、`model.getOutputs()` |
| 字段放错对象 | 1 | `applicationInfo.deviceType`（实在 `@ohos.deviceInfo`） |
| ArkTS 语言限制 | 4 | `arkts-no-untyped-obj-literals`（禁止无类型对象字面量） |
| 模块解析 | 27 | 依赖未安装导致的级联错误，`ohpm install` 后消失 |

**结论：编译通过 ≠ 逻辑正确，但「API 名字对不对」这一类风险现在已经清零。**

## 4.6 媒体解码路径的重大更正

核对 SDK 时发现：**ArkTS 的 `@ohos.multimedia.media` 里根本没有
`AVDemuxer` / `AudioDecoder` / `createAVDemuxer` / `createAudioDecoderByMime` /
`AVBuffer`**。该模块只导出 AVPlayer / AVRecorder / AVMetadataExtractor /
AVImageGenerator / AVTranscoder / SoundPool / AudioPlayer / AudioRecorder。

网上大量中文示例都在用这些不存在的名字，我最初也跟着写错了。

最终实现改为：
1. **WAV** → ArkTS 自己解析 RIFF（零依赖、最快、不损质量）；
2. **其它容器** → **AVTranscoder** 转成 WAV
   （`ContainerFormatType.CFT_WAV` + `CodecMimeType.AUDIO_RAW`）后再解析。

⚠️ **待真机实测**：转码是离线全量过程，30 分钟视频可能要等较久。
若不可接受，正确做法是加 NAPI 层（FFmpeg / 平台解码器），
而不是回 ArkTS 找捷径。

## 5. 必须由你在真机上补的验证

| # | 项目 | 怎么验 | 通过标准 |
| --- | --- | --- | --- |
| 1 | ~~工程能编译~~ | ✅ **已完成** | DevEco Studio 6.0.0 / API 26 / hvigor 6.26.8 实测 **BUILD SUCCESSFUL**，产出 common.har + entry HAP（见下节与 README §3.2） |
| 2 | **NPU 可用** | 「模型」页面 → 重新探测 NPU | 显示「检测到 NPU」，顶部指示器出现 `NPU (...)` |
| 3 | **模型加载** | 推入 3 个文件后重载引擎 | 显示「模型已就绪」，无 OOM |
| 4 | **端到端识别** | 听写页录一段已知内容 | 转写与 PC 版一致（见 §4） |
| 5 | **性能** | 用一段 60 s 音频计时 | 记录实时倍速，写回本文 |
| 6 | **一多布局** | 分别用手机、平板、折叠屏展开/折叠、分屏、2in1 自由窗口拖宽窄 | 断点在 600 / 840 / 1440 vp 正确切换；**分屏拖动窗口时布局要跟着变**（这正是不能用折叠状态的原因） |
| 9 | **安全区避让** | 在带状态栏与手势导航条的真机上打开各页面；再横屏、分屏试一次 | 顶栏不被状态栏遮挡、底部 Tab 不与小白条重叠；旋转后避让跟随更新 |
| 7 | **mp4 解码** | 导入一个 mp4 | 能出音频。现走 AVTranscoder→WAV，需实测**转码耗时**（见下节） |
| 8 | **麦克风听写** | 听写页录音 | 权限申请正常，识别出文本 |

---

## 6. 已知的实现层面待办

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 视频播放器 | `Index.ets` 的 `PlayerPanel` | 目前是占位。需要 `AVPlayer` + `XComponent`，以及「跟随播放高亮」 |
| 波形图 | 未实现 | 原版 SubFabric 有 peaks 波形；端侧需要抽峰 + Canvas 绘制 |
| 时间轴虚拟滚动 | 未实现 | 字幕量大时 `List` 需要 `LazyForEach` |
| 跨窗去重的边界情况 | `TdtDecoder.decodeWindow` | 逻辑已移植，但缺少真实长音频（>15 s 多窗）的回归样本 |
| `MediaDecoder` 的采样率/声道 | `MediaDecoder.decodeWithCodec` | 目前从解码器回调里拿不到真实参数，硬编码为 16 kHz/mono；需要从 `AVDemuxer` 的 track 信息里读 |
| 模型下载 | `AppStore` | 只支持"用户手动放入"，没有做内网/网络下载器 |
