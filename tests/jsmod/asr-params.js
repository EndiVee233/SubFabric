'use strict';
/**
 * ASR 模型参数：schema、默认值、校验与保存值的合并。
 *
 * 纯逻辑模块，供服务端路由和测试直接复用；不碰 setting.json、不 spawn 子进程。
 * 每个引擎只暴露运行时真正支持的参数，避免界面出现“看起来能调、实际被忽略”的项：
 *   · faster-whisper：VAD / 阈值 / 方法、人声分离、逐词时间戳、语言、提示词
 *   · whisper.cpp：语言、线程、词置信度阈值、提示词
 *   · crispasr（Parakeet Vulkan）：线程、词置信度阈值
 *   · qwen（Qwen3-ASR；对齐器单独列出）：分块长度、ASR 最大生成 token
 *   · sherpa-onnx（Parakeet CUDA）：CPU 线程数、TDT blank 惩罚
 *   · vibevoice（VibeVoice 4bit CUDA）：音频编码分块、最大生成 token
 * Parakeet 的 NPU / 双引擎变体没有可安全暴露的参数（稳定性重跑遍数由置信度档位统一控制，
 * 双引擎分工在「性能与调度」里设置），NeMo 与云端同样没有 schema，界面不显示“参数”按钮。
 *
 * 保存值放在 asr/settings.json 的 modelParams[modelId] 下；缺失字段回落默认值。
 */

const LANGUAGE_OPTIONS = [
  { value: 'en', label: '英语（en）' },
  { value: 'zh', label: '中文（zh）' },
  { value: 'ja', label: '日语（ja）' },
  { value: 'ko', label: '韩语（ko）' },
  { value: 'fr', label: '法语（fr）' },
  { value: 'de', label: '德语（de）' },
  { value: 'es', label: '西班牙语（es）' },
  { value: 'ru', label: '俄语（ru）' },
];
const LANGUAGE_OPTIONS_AUTO = LANGUAGE_OPTIONS.concat([{ value: 'auto', label: '自动检测' }]);

const VAD_METHOD_OPTIONS = [
  { value: 'pyannote_v3', label: 'pyannote v3' },
  { value: 'silero_v3', label: 'Silero v3' },
  { value: 'silero_v4', label: 'Silero v4' },
  { value: 'silero_v5', label: 'Silero v5' },
  { value: 'webrtc', label: 'WebRTC' },
];

const PROFILES = {
  'faster-whisper': [
    {
      key: 'language', label: '识别语言', type: 'select', default: 'en',
      options: LANGUAGE_OPTIONS,
      help: 'Whisper large-v2 按此语言解码；本项目素材通常是英语。',
    },
    {
      key: 'vad', label: 'VAD 语音活动检测', type: 'bool', default: false,
      help: '开启后会切掉静音/气口，可能漏掉很轻的词；默认关闭以优先保留完整台词。',
    },
    {
      key: 'vadThreshold', label: 'VAD 阈值', type: 'number', default: 0.05,
      min: 0.01, max: 0.99, step: 0.01,
      help: '越低越敏感（更容易判定为人声）；仅 VAD 开启时生效。',
    },
    {
      key: 'vadMethod', label: 'VAD 方法', type: 'select', default: 'pyannote_v3',
      options: VAD_METHOD_OPTIONS,
      help: 'Faster-Whisper-XXL 内置的语音活动检测器；通常保持 pyannote v3。',
    },
    {
      key: 'vocalExtract', label: 'MDX 人声分离', type: 'bool', default: true,
      help: '压制/识别前分离人声；带 BGM 的素材提升明显，但更慢、更吃显存。',
    },
    {
      key: 'wordTimestamps', label: '逐词时间戳', type: 'bool', default: true,
      help: '关闭后只返回句级时间戳，逐词高亮与逐词校对将不可用。',
    },
    {
      key: 'prompt', label: '识别提示词', type: 'text', default: '', maxLength: 300,
      help: '留空时使用自动热词提示；过长的提示词可能诱发复读或提前收尾。',
    },
  ],
  'whisper.cpp': [
    {
      key: 'language', label: '识别语言', type: 'select', default: 'en',
      options: LANGUAGE_OPTIONS_AUTO,
      help: 'whisper.cpp 的解码语言；“自动检测”会增加一次语言判断。',
    },
    {
      key: 'threads', label: 'CPU 线程数', type: 'number', default: 4,
      min: 1, max: 32, step: 1,
      help: '解码使用的线程数；过大不一定更快，建议不超过物理核心数。',
    },
    {
      key: 'wordThreshold', label: '词时间戳阈值', type: 'number', default: 0.01,
      min: 0.01, max: 0.99, step: 0.01,
      help: '词级时间戳的概率阈值；越高越严格，过低可能产生碎词。',
    },
    {
      key: 'prompt', label: '识别提示词', type: 'text', default: '', maxLength: 300,
      help: '留空时使用自动热词提示；可填入人名、术语等上下文。',
    },
  ],
  'crispasr': [
    {
      key: 'threads', label: 'CPU 线程数', type: 'number', default: 6,
      min: 1, max: 32, step: 1,
      help: 'CrispASR 解码线程数；Vulkan GPU 推理时主要影响前后处理。',
    },
    {
      key: 'wordThreshold', label: '词时间戳阈值', type: 'number', default: 0.01,
      min: 0.01, max: 0.99, step: 0.01,
      help: '词级时间戳概率阈值；越高越严格。',
    },
  ],
  'sherpa-onnx': [
    {
      key: 'threads', label: 'CPU 线程数', type: 'number', default: 4,
      min: 1, max: 32, step: 1,
      help: '特征提取与解码前处理的线程数；CUDA 推理本身不随它提速，超过物理核心数通常更慢。',
    },
    {
      key: 'blankPenalty', label: '空白惩罚', type: 'number', default: 0.5,
      min: 0, max: 2, step: 0.01,
      help: 'TDT 解码的 blank 惩罚：0 关闭；实测 0.5 最稳、0.7 略好、超过 1 反而变差。',
    },
  ],
  'qwen': [
    {
      key: 'chunkSec', label: '分块长度（秒）', type: 'number', default: 150,
      min: 30, max: 240, step: 10,
      help: 'ASR 与对齐器共用；对齐器在 300s 单次会尾部塌缩，默认 150s 最稳。',
    },
    {
      key: 'maxNewTokens', label: 'ASR 最大生成 token', type: 'number', default: 4096,
      min: 1024, max: 8192, step: 1,
      help: '单块 Qwen3-ASR 的生成上限；150s 片段 4096 足够，调小可能截断。',
    },
  ],
  'vibevoice': [
    {
      key: 'acousticChunkSize', label: '音频编码分块', type: 'number', default: 32000,
      min: 3200, max: 96000, step: 3200, multipleOf: 3200,
      help: '必须为 3200 的倍数；调大编码更快但更占显存，显存紧张时调小。',
    },
    {
      key: 'maxNewTokens', label: '最大生成 token', type: 'number', default: 8192,
      min: 1024, max: 32768, step: 1,
      help: '解码输出上限；长音频或多说话人需要更大，达到上限会中止并报错，不会保存截断稿件。',
    },
  ],
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

function schemaFor(model) {
  const list = model && PROFILES[model.engine];
  return Array.isArray(list) ? list.map(f => Object.assign({}, f)) : [];
}

function defaultsFor(model) {
  const out = {};
  for (const f of schemaFor(model)) out[f.key] = f.default;
  return out;
}

function coerce(spec, raw) {
  if (spec.type === 'bool') {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return !!raw;
    if (typeof raw === 'string') {
      if (/^(true|1|on|yes)$/i.test(raw)) return true;
      if (/^(false|0|off|no)$/i.test(raw)) return false;
    }
    return undefined;
  }
  if (spec.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const min = spec.min == null ? -Infinity : spec.min;
    const max = spec.max == null ? Infinity : spec.max;
    let v = Math.min(max, Math.max(min, n));
    // multipleOf: 某些运行时只接受固定步长（VibeVoice 分块必须是 3200 的倍数）。
    const q = Number(spec.multipleOf);
    if (q > 0) v = Math.min(max, Math.max(min, Math.round(v / q) * q));
    return v;
  }
  if (spec.type === 'select') {
    const s = String(raw == null ? '' : raw);
    return spec.options.some(o => o.value === s) ? s : undefined;
  }
  const s = String(raw == null ? '' : raw).trim();
  return spec.maxLength ? s.slice(0, spec.maxLength) : s;
}

/** 保存值 → 实际生效值：只接受当前 schema 里认识的键，非法值回落默认。 */
function resolveFor(model, saved) {
  const out = defaultsFor(model);
  if (!saved || typeof saved !== 'object') return out;
  for (const f of schemaFor(model)) {
    if (!hasOwn(saved, f.key)) continue;
    const v = coerce(f, saved[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/** 用户提交值 → 校验结果；非法字段返回 errors，不写入磁盘。 */
function normalizeFor(model, input) {
  const values = defaultsFor(model);
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, values, errors: [{ key: '', message: '参数必须是对象' }] };
  }
  for (const f of schemaFor(model)) {
    if (!hasOwn(input, f.key)) continue;
    const v = coerce(f, input[f.key]);
    if (v === undefined) {
      errors.push({ key: f.key, message: f.label + ' 的值无效' });
      continue;
    }
    values[f.key] = v;
  }
  return { ok: errors.length === 0, values, errors };
}

function summaryFor(model, values) {
  const v = resolveFor(model, values);
  if (model && model.engine === 'faster-whisper') {
    return `VAD ${v.vad ? '开' : '关'} · 阈值 ${v.vadThreshold} · MDX ${v.vocalExtract ? '开' : '关'} · 逐词 ${v.wordTimestamps ? '开' : '关'}`;
  }
  if (model && model.engine === 'whisper.cpp') {
    return `语言 ${v.language} · 线程 ${v.threads} · 词阈值 ${v.wordThreshold}`;
  }
  if (model && model.engine === 'crispasr') {
    return `线程 ${v.threads} · 词阈值 ${v.wordThreshold}`;
  }
  if (model && model.engine === 'sherpa-onnx') {
    return `线程 ${v.threads} · blank 惩罚 ${v.blankPenalty}`;
  }
  if (model && model.engine === 'qwen') {
    return `分块 ${v.chunkSec}s · ASR 上限 ${v.maxNewTokens} token`;
  }
  if (model && model.engine === 'vibevoice') {
    return `分块 ${v.acousticChunkSize} · 上限 ${v.maxNewTokens} token`;
  }
  return '';
}

function isDefaultFor(model, saved) {
  const current = resolveFor(model, saved);
  const defaults = defaultsFor(model);
  return Object.keys(defaults).every(k => current[k] === defaults[k]);
}

module.exports = {
  schemaFor, defaultsFor, resolveFor, normalizeFor, summaryFor, isDefaultFor,
};
