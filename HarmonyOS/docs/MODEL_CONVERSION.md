# ONNX → MindSpore Lite (.ms) 模型转换

鸿蒙端侧**只能加载 `.ms`**，ONNX 不能直接用。本文给出从
`istupakov/parakeet-tdt-0.6b-v2-onnx` 到可部署产物的完整流程。

---

## 0. 一键生成转换命令

```bash
python tools/gen_ms_conversion.py --check              # 打印命令 + 校验真实图 IO
python tools/gen_ms_conversion.py --out convert_ms.sh  # 写成 shell 脚本
```

`--check` 会用一个零依赖的 protobuf 解析器（不需要装 onnx）读出真实的
输入输出名与形状。在本机实测结果是：

```
encoder:
   IN  audio_signal       float32  [?, ?, ?]     ← 动态，必须静态化
   IN  length             int64    [?]
decoder_joint:
   IN  encoder_outputs    float32  [?, ?, ?]
   IN  targets            int32    [?, ?]
   IN  target_length      int32    [?]
   IN  input_states_1     float32  [?, ?, ?]
   IN  input_states_2     float32  [?, ?, ?]
```

若这里的名字与你手上的导出不一致（不同导出仓库命名会有差异），
请以 `--check` 的输出为准去改 ArkTS 侧的 `ParakeetEngine.ets`。

---

## 1. 目标张量契约

ArkTS 侧（`entry/src/main/ets/engine/ParakeetEngine.ets`）硬编码了下面的契约，
**转换参数必须与之对齐**。

### encoder.ms（跑在 NPU）

| | 名字 | 类型 | 形状 |
| --- | --- | --- | --- |
| IN | `audio_signal` | float32 | `[1, 128, 1501]` |
| IN | `length` | int32 | `[1]` |
| OUT | `outputs` | float32 | `[1, 1024, 188]` |
| OUT | `encoded_lengths` | int32 | `[1]` |

- `1501` = 15.01 s × 100 mel 帧/秒（**必须静态**，见 §3）；
- `188` = `(1501 - 1) / 8 + 1`，8 倍下采样；
- `length` 传真实 mel 帧数，其余补零。

### decoder_joint.ms（跑在 CPU）

| | 名字 | 类型 | 形状 |
| --- | --- | --- | --- |
| IN | `encoder_outputs` | float32 | `[1, 1024, 1]` ← **单帧** |
| IN | `targets` | int32 | `[1, 1]` |
| IN | `target_length` | int32 | `[1]` |
| IN | `input_states_1` | float32 | `[2, 1, 640]` （LSTM h） |
| IN | `input_states_2` | float32 | `[2, 1, 640]` （LSTM c） |
| OUT | `outputs` | float32 | `[1, 1, 1030]` |
| OUT | `output_states_1` | float32 | `[2, 1, 640]` |
| OUT | `output_states_2` | float32 | `[2, 1, 640]` |

`1030 = 1025 词表（blank = 1024）+ 5 个时长头 [0,1,2,3,4]`。

> **为什么 `encoder_outputs` 是单帧而不是整窗？**
> 因为 TDT 解码循环留在 ArkTS 侧（NPU 缺 `GatherNd`/`Squeeze`/`Stack`/
> `LogSoftmax`/`TopK`，整图丢给 NPU 会被切碎成混合图）。
> joint 每步只用到当前帧，所以导出成单帧输入既省内存又更容易被
> MindSpore Lite 接受。

---

## 2. 转换命令

```bash
CONVERTER=converter_lite
SRC=models/istupakov__parakeet-tdt-0.6b-v2-onnx
OUT=ms_models
mkdir -p "$OUT"

# ---- 编码器（目标 NPU）
"$CONVERTER" \
  --modelFile="$SRC/encoder-model.onnx" \
  --outputFile="$OUT/encoder" \
  --inputShape="audio_signal:1,128,1501;length:1" \
  --inputDataFormat=NCHW \
  --optimize=ascend_oriented \
  --saveType=MINDIR \
  --fp16=off

# ---- 预测网络 + joint（目标 CPU）
"$CONVERTER" \
  --modelFile="$SRC/decoder_joint-model.onnx" \
  --outputFile="$OUT/decoder_joint" \
  --inputShape="encoder_outputs:1,1024,1;targets:1,1;target_length:1;input_states_1:2,1,640;input_states_2:2,1,640" \
  --optimize=general \
  --saveType=MINDIR \
  --fp16=off

cp "$SRC/vocab.txt" "$OUT/vocab.txt"
```

`converter_lite` 随 **MindSpore Lite 官方 Linux x86_64 发布包**提供，
部分 DevEco 版本也自带。

### 参数取舍说明

| 参数 | 取值 | 原因 |
| --- | --- | --- |
| `--optimize` | 编码器用 `ascend_oriented`，joint 用 `general` | 编码器目标是 NPU（达芬奇架构，与 Ascend 同源）；joint 跑 CPU，激进优化无收益还有风险 |
| `--fp16` | `off` | NeMo 的 LayerNorm 对精度敏感。官方文档也提示 `LayerNorm`/`InstanceNorm` 在 NPU/FP16 下有精度风险。先用 FP32 跑通，再单独实验 FP16 |
| `--saveType` | `MINDIR` | 便于二次检查；要直接出 `.ms` 可改 `MINDIR_LITE`（不同版本参数名可能是 `--saveType=MINDIR_LITE`） |
| `--inputShape` | 见上 | **必须**，见 §3 |

---

## 3. 为什么编码器必须静态化

原始 ONNX 的 `audio_signal` 是 `[?, 128, ?]`。这个图的长度相关子图是
`Shape → Gather → Range → Expand → Where`（用来构造 attention mask），
**AOT 编译器无法处理动态的 expand 形状**，NNRt 会直接编译失败。

本机在 OpenVINO 路径上实测到一个强相关现象：
`asr.py` 在编译前把图 `reshape` 成静态形状；不做静态化时，
即使是同一个输入，joint 的 argmax 都会变（实测退化成全 blank）。
**静态化不是优化，是正确性前提。**

---

## 4. int8 量化（可选，但建议）

622 MB 的 fp32 编码器对移动端太重。量化到 int8 后约 622 MB → 明显更小、
且 NPU 上 int8 算力更强。

```bash
# 1) 先用 32 条真实语音做校准集（wav，16 kHz 单声道）
ls calib/*.wav | head -32 > calib.txt

# 2) 量化感知转换
"$CONVERTER" \
  --modelFile="$SRC/encoder-model.onnx" \
  --outputFile="$OUT/encoder_int8" \
  --inputShape="audio_signal:1,128,1501;length:1" \
  --quantType=WeightQuant \
  --bitNum=8 \
  --quantWeightSize=1024 \
  --configFile=quant.cfg
```

> ⚠️ **量化后必须做精度回归**：拿 3~5 段各 30 s 的音频，用
> `app/` 下的 Python 版本（或本项目的 ArkTS 解码器）跑同一段音频，
> 对比转写文本。TDT 的 CTC-blank 特性使得量化误差可能表现为
> **整段变空白**而不是「错几个字」，很容易被误判成「模型坏了」。
> 判据用「能否复现已知转写」，不要用「有没有报错」。

---

## 5. 部署

```bash
# 目标目录（应用沙箱）
DIR=/data/app/el2/100/base/com.subfabric.harmony/haps/entry/files/subfabric/models/parakeet
hdc shell mkdir -p $DIR
hdc file send ms_models/encoder.ms        $DIR
hdc file send ms_models/decoder_joint.ms  $DIR
hdc file send ms_models/vocab.txt         $DIR
```

应用内「模型」页面会显示 `模型已就绪`。顶部指示器出现 `NPU (...)` 表示
编码器成功落在 NPU 上；若显示 `CPU` 说明 NNRt 不可用（模拟器、机型无 NPU、
或模型未按 NPU 静态化转换）。

### 关于 `converter_lite` 的输出文件名

部分版本会输出 `encoder.ms` 与 `encoder_graph.ms` 两个文件。
ArkTS 侧读的是 **`encoder.ms`**（见 `ParakeetModelFiles`），请确认。

### 大模型加载

622 MB 的模型用 `loadModelFromFile` 在某些 ROM 上会因峰值内存失败。
`MindSporeLite.ets` 的 `MsLiteModel.load(fd)` 已预留 `loadModelFromFd` 路径
（用 fd 加载可以避免文件内容二次驻留）。若遇到加载失败，在
`ParakeetEngine.load()` 里改成先 `fileIo.openSync` 拿 fd 再传入即可。

---

## 6. 排错清单

| 现象 | 最可能的原因 |
| --- | --- |
| 转换报「不支持算子 STFT / ReduceSumSquare」 | 你在转 **`nemo128.onnx`**（预处理图），它含 ONNX `STFT` 算子，OpenVINO/MindSpore Lite 都转不了。**不需要转它** —— mel 前端在 ArkTS 里自己算 |
| 转换成功但 NNRt 编译失败 | 编码器没静态化；或 NPU 不支持图中某个算子（看 converter 的算子支持报告） |
| 应用显示 `CPU` 而不是 `NPU` | 模拟器 / 机型无 NPU / `getAllNNRTDeviceDescriptions()` 返回空。看「设置 → 诊断」里的日志 |
| 识别结果全空 | 词表不匹配（应 1025 项、`<blk>` 在第 1025 行）；或模型与词表版本不一致（v2 用 v2 词表） |
| 识别结果像乱码 | mel 前端参数不对（见 `docs/MEL_FRONTEND_FINDINGS.md`） |
| 加载模型时 OOM | 见上一节「大模型加载」 |

---

## 7. 可选：换更小的模型

如果目标机型 NPU 上跑不动 0.6B，或想要更小的包体，建议换
**`parakeet-tdt_ctc-110m`**：

- int8 仅约 **126 MB**（单文件）；
- 仍然是官方 NVIDIA 模型，带标点与大小写；
- **原生输出 token 级时间戳**（逐词卡拉OK 仍然可用）；
- 结构是 CTC 而不是 TDT，算子更少，对 NPU 更友好。

代价是识别质量低于 0.6B，且需要改 `TdtDecoder.ets` 里 CTC 的贪心解码
（blank 合并 + 去重），mel 前端与字幕链路可以完全复用。

---

## 8. 实测到的真实张量契约（**以本节为准**）

下面这份是**用 `python tools/gen_ms_conversion.py --check` 在本机 ONNX 上实测出来的**，
不是照文档抄的。转换时请按这份对齐。

### 8.1 真实的图 IO

```
encoder:  2 个输入, 2 个输出
   IN  audio_signal       float32  [?, ?, ?]
   IN  length             int64    [?]
   OUT outputs            float32  [?, ?, ?]
   OUT encoded_lengths    int64    [?]

decoder_joint:  5 个输入, 4 个输出
   IN  encoder_outputs    float32  [?, ?, ?]
   IN  targets            int32    [?, ?]
   IN  target_length      int32    [?]
   IN  input_states_1     float32  [?, ?, ?]
   IN  input_states_2     float32  [?, ?, ?]
   OUT outputs            float32  [?, ?, ?, ?]
   OUT prednet_lengths    int32    [?, ?]
   OUT output_states_1    float32  [?, ?, ?]
   OUT output_states_2    float32  [?, ?, ?]
```

### 8.2 ⚠️ `decoder_joint` 有 **4 个输出**，不是 3 个

这是最容易踩的坑。输出顺序是：

| 下标 | 名字 | 是什么 |
| --- | --- | --- |
| 0 | `outputs` | joint logits，`[1,1,1,1030]` |
| 1 | `prednet_lengths` | 预测网络长度，**不是 LSTM 状态** |
| 2 | `output_states_1` | LSTM 隐状态 h |
| 3 | `output_states_2` | LSTM 细胞状态 c |

**按下标取值会把 `prednet_lengths` 当成 h、把 `output_states_1` 当成 c**，
LSTM 状态完全错位，识别结果必然是垃圾（而且不会报错，只是输出乱码或全空）。

本项目的做法是**按名字取**（`MsLiteModel.outputByName()`），
这样不论转换器怎么排列输出顺序都正确。如果你改了 `ParakeetEngine.ets`，
请保持按名字取值。

### 8.3 转换脚本里曾经有过的一个解析 bug（已修）

`tools/gen_ms_conversion.py` 早期版本把 GraphProto 的字段号记错了：

| 字段号 | 真实含义 | 早期代码误认为 |
| --- | --- | --- |
| 1 | node | — |
| 5 | **initializer**（权重） | input ❌ |
| 11 | **input** | output ❌ |
| 12 | **output** | — |

后果是 `ins` 恒为空、所有输入被当成输出，`--check` 打印的 IO 完全不可信。
如果你手上的副本还是旧版，用 `--check` 输出会看到「全是 OUT」——那就是这个 bug。

### 8.4 静态化参数（务必照抄）

```
encoder:
  --inputShape="audio_signal:1,128,1501;length:1"

decoder_joint:
  --inputShape="encoder_outputs:1,1024,1;targets:1,1;target_length:1;input_states_1:2,1,640;input_states_2:2,1,640"
```

注意 `encoder_outputs` 是**单帧** `[1,1024,1]`，不是整窗：
TDT 解码循环在 ArkTS 侧，模型只保留最小的联合图（原因见 `docs/NPU_NOTES.md` 的算子表）。
