# WhisperX 补充评测（2026-10-23）

对《SubFabric ASR 三长度横评（2026-10-21）》的同一素材、同一 30s / 5min / 10min
切片补测 WhisperX 3.4.2。**不接入生产、不改变现有模型列表。**

## 最终结果：MDX + pyannote VAD + 说话人分离

| 方案 | 30s WER | 5min WER | 10min WER | 总耗时 30s / 5 / 10min | 说话人准确率 5 / 10min |
| --- | --- | --- | --- | --- | --- |
| WhisperX + MDX + pyannote | 1.19% | 8.59% | 9.23% | 47.4 / 497 / 997s | 64.5% / 62.9% |
| SubFabric XXL + MDX + sherpa | 1.19% | 9.44% | 11.31% | 16.1 / 141 / 299s | 73.2% / 65.1% |
| 2026-10-21 报告（XXL + MDX，无说话人分离） | 1.22% | 8.73% | 8.92% | 36.6 / 198 / 393s | — |

结论：MDX 后 WhisperX 的 ASR 与 SubFabric 打平甚至略好（30s 相同，5/10min 分别低
0.85 / 2.08pp）；但总耗时约为 SubFabric 的 3.3×，主要慢在 pyannote 说话人分离。
说话人分离 SubFabric 更准（5min 73.2% vs 64.5%，10min 65.1% vs 62.9%；句级最优标签
映射，不是帧级 DER）。SubFabric 复跑的 9.44% / 11.31% 与报告值 8.73% / 8.92% 有
0.7 / 2.4pp 差异，原因尚未完全定位，相对比较统一用本轮同参考、同 MDX 人声。

### pyannote VAD 修复

`pyannote_fix.py`：先设 `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`，在 import
`whisperx` / `whisperx.diarize` 前把 SpeechBrain `LazyModule` 的 dunder 属性直接
抛 `AttributeError`，避免 Lightning `inspect.stack()` 触发递归。30/300s 通过；
600s 单次 VAD >40min 未返回，改为 2×300s 后通过（WER 9.23%）。

## 旧口径：无 MDX（保留对照）

| 片段 | 识别耗时 | 对齐耗时 | 总耗时 | 总× | 词时间中位 | ≤200ms | WER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 30s | 17.26s | 4.52s | 21.78s | 1.38× | 45ms | 100% | 1.19% |
| 300s | 31.84s | 7.73s | 39.57s | 7.58× | 41ms | 95.3% | 19.51% |
| 600s | 55.56s | 7.24s | 62.80s | 9.55× | 40ms | 93.8% | 14.03% |

此表是 WhisperX + Silero VAD、**没有人声分离**的结果，只用于说明 MDX 的影响。

## 环境

- WhisperX 3.4.2，faster-whisper 1.2.0，CTranslate2 4.4.0，PyTorch 2.7.1+cu126，
  torchaudio 2.7.1，Transformers 4.56.1
- ASR：Whisper large-v2（CTranslate2 float16，batch_size=8，language=en）
- 对齐：wav2vec2 base 960h（torchaudio pipeline）
- VAD：pyannote segmentation-3.0（onset 0.5 / offset 0.363 / chunk 30s）
- 分离：pyannote/speaker-diarization-3.1，6 speakers
- 人声分离：Faster-Whisper-XXL `--ff_vocal_extract mdx_kim2 --ff_dump`
- GPU：RTX 4060 Laptop 8GB

## 口径

- 音频从原视频抽 16k 单声道 WAV，30s / 300s / 600s 均从 0 秒开始。
- 参考文本：参考 ASS 的 Default 英文事件，去覆盖标签，按整句文本去重逐词高亮事件；
  三个片段归一化后 84 / 943 / 1875 词。
- WER：小写、去标点、去所有格撇号、展开常见缩写、数字归一到 `<num>`，标准
  Levenshtein 计算 S/D/I。
- 说话人准确率：参考说话人取中文字幕 `[name]`；按句级最大重叠取系统说话人，再用
  最优标签映射统计；覆盖 100%；不是帧级 DER。30s 参考只有 1 人，6 簇分离准确率无意义。
- 词时间（旧表）：参考词取逐词高亮事件；WhisperX 取 `word_segments`；`difflib` 匹配后
  计算 `|Δt_start|` 中位数与 ≤200ms 占比。

## 复现

将以下占位符替换为本机路径；cuDNN DLL 目录需要加入 `PATH`：

```bash
WHISPERX_PY=/path/to/python-with-whisperx
WHISPERX_MODEL=/path/to/faster-whisper-large-v2
AUDIO=/path/to/minecraft-300s.wav

PATH="/path/to/cudnn/bin:$PATH" "$WHISPERX_PY" -m whisperx "$AUDIO" \
  --model "$WHISPERX_MODEL" --device cuda --compute_type float16 \
  --batch_size 8 --language en --output_format json --output_dir out \
  --vad_method pyannote --print_progress False
```

pyannote VAD 需要先应用 `mdx-diar/pyannote_fix.py`；600s 建议切成 2×300s。
说话人分离/评分脚本本轮未放进仓库；`mdx-diar/` 保留了原始 JSON、分离结果与评分。

## 文件

- `mdx-diar/results.json`：MDX + diarization 的时间、WER、说话人准确率
- `mdx-diar/hyp-*.json`：WhisperX 对齐后的完整 JSON
- `mdx-diar/whisperx-diar-*.json` / `subfabric-diar-*.json`：两套分离结果
- `mdx-diar/speaker-eval-*.json`：逐句说话人评分
- `mdx-diar/pyannote_fix.py`：pyannote VAD 兼容补丁
- 报告：`../SubFabric-WhisperX-补充评测-2026-10-23.pdf`（4 页）
