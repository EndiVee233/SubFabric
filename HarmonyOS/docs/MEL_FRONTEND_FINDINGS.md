# Parakeet 特征前端：实测结论（本次工程验证）

这些结论是在本机用真实 `encoder-model.onnx` 跑出来的，**优先级高于任何二手资料**。
复现脚本：`.tmp/onnx_peek.py`（图结构）、`.tmp/probe_mel2.py`（数值对比）。

## 1. `nemo128.onnx` 的实际图结构

用最小 protobuf 解析器读出 34 个节点，算子序列为：

```
Slice -> Slice -> Slice -> Mul -> Sub -> Concat -> Pad -> Cast -> STFT
  -> ReduceSumSquare -> Cast -> MatMul -> Add -> Log -> Div -> Add
  -> Transpose -> Unsqueeze -> Shape -> Range -> Less -> Cast -> Where
  -> ReduceSum -> Div -> Sub -> Where -> ReduceSumSquare -> Sub -> Div
  -> Sqrt -> Add -> Div -> Where
```

图 IO：`waveforms: f32[None, None]`、`waveforms_lens: i64[None]`。

**关键推论：整个图里没有 pre-emphasis。**

> 有一份外部调研报告称 NeMo 预处理器包含 `x[1:] -= 0.97*x[:-1]` 的预加重。
> 该说法与本机实测的图结构不符，**判定为错误**。`Mul -> Sub` 那两步是
> 提取 `np.hanning(400)` 窗（400 点）并**减去均值**（NeMo 的
> `normalize="per_feature"` 之前的 standardize 步骤），而不是预加重。

## 2. 通过编码器做的消融实验

OpenVINO **无法**转换 `nemo128.onnx`（ONNX `STFT` 算子要求 signal 输入静态且 rank==3，
`ReduceSumSquare` 也不支持动态输入类型），因此改用「把不同前端产出的
log-mel 喂给真实编码器，比较声学激活」的方式验证。

输入：`.tmp/test_en_90s.wav` 的前 15.01 s（240160 样本，1499 个 mel 帧）。

| 变体 | 与 A 的 cosine | 相对误差 |
| --- | --- | --- |
| A 无预加重 + 整窗归一化（当前 `app/mel.py`） | 1.000000 (基准) | 0 |
| B 预加重 0.97 + 整窗归一化 | 0.999706 | **0.0244** |
| C 无预加重 + **仅有效帧**归一化并掩码 | 1.000000 | 0.000175 |
| D 预加重 0.97 + 仅有效帧归一化 | 0.999705 | 0.0244 |
| E 无预加重 + `valid_frames` 传真实帧数 | 1.000000 | 0.000000 |

特征空间差异：预加重使 log-mel 的 cosine 掉到 0.98884（maxabs 11.29）；
「整窗归一化 vs 掩码归一化」的 cosine 为 0.99999988。

## 3. 采纳的实现约定

1. **不加预加重** —— 与经过端到端验证的 `app/mel.py` 保持一致。
   预加重会让编码器输出产生 2.4% 的相对偏差，属于「看起来更对、实际更偏」的改动。
2. **按有效帧做逐 bin 归一化，padding 位置置 0** —— 与 ONNX 图的
   `Where(mask, ...)` 语义一致，实测与整窗归一化差异可忽略（1.75e-4）。
3. **`valid_frames` 用真实 mel 帧数**（变体 E），而不是写死 1501。
   实测两者编码器输出完全相同，但传真实帧数语义更正确。
4. **mel 帧数公式**：`1 + (n - 400) / 160`（`app/mel.py` 用的就是这个），
   15.01 s → 1499 帧。ONNX 图走 `n // 160` 会得到 1501 帧，
   两者在 `length` 一致时编码器输出无差异。
5. **定长窗 [1,128,1501]**：把 mel 补零到 1501 帧（对应 15.01 s）。
   编码器是定长图，长度必须写死；这一点决定了鸿蒙侧 `.ms` 转换也要按
   1501 帧静态化。
