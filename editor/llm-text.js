/**
 * LLM 回复的「文本卫生 + 解析」纯工具 —— 不碰 fs / 网络 / 配置, 可单测。
 *
 * 为什么单独成模块（用户报"翻译会失效但从来定位不到"）：
 *  ① **思维链**：推理模型（DeepSeek-R1 / QwQ / GLM-Z1 / Qwen3-thinking…）会在正文前塞
 *     ` thinking…<｜end▁of▁thinking｜>`。不剥掉的话，下面"取第一个 JSON 数组"会被思考过程里的**示例数组**带偏，
 *     而逐行兜底又会把思考行当成译文行 → 行数不符 → 批次失败，报错还只有 120 字，看不出原因。
 *  ② **取 JSON 不能"首个 [ 到末个 ]"**：回复里常出现句尾补充说明（含 `[` 或 `]`）、
 *     数组里嵌字符串等；这里改成**平衡扫描**（带字符串/转义感知），只取第一个**完整闭合**的数组。
 *  ③ **逐行兜底**要顺带吃掉思考行、编号行、代码块围栏、"好的/以下是"之类的寒暄。
 */

'use strict';

/** 剥掉思维链：<think>/<thinking>/<reasoning>/<analysis> 块（含未闭合的截断态）与 ```think 围栏 */
function stripReasoning(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/<(think|thinking|reasoning|analysis|thought)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  s = s.replace(/```(?:think|thinking|reasoning|analysis)\b[\s\S]*?(?:```|$)/gi, '');
  // 去掉零宽/BOM 之类看不见的字符，免得干扰首字符判断
  return s.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

/** 判断回复里是否"看起来有思维链"（给诊断用：没剥到但模型明显在思考） */
function looksLikeReasoning(text) {
  return /<(think|thinking|reasoning|analysis|thought)\b/i.test(String(text || ''))
      || /```(?:think|thinking|reasoning|analysis)\b/i.test(String(text || ''));
}

/**
 * 从任意文本里抠出**第一个完整闭合的 JSON 数组**（字符串/转义感知）。
 * 找不到闭合的（被 max_tokens 截断）→ 返回 null。
 */
function extractJsonArray(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 文本 → 数组。先剥思维链、再剥 ```json 围栏、再平衡扫描；失败返回 null。 */
function parseJsonArray(text) {
  const cleaned = stripReasoning(text);
  if (!cleaned) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  const body = fence ? fence[1].trim() : cleaned;
  const cand = extractJsonArray(body) || extractJsonArray(cleaned);
  if (!cand) return null;
  try {
    const v = JSON.parse(cand);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

const CHATTY_RE = /^\s*(好的|当然|以下是|下面是|翻译如下|这是|注意|说明|所以|首先|Sure|Here|The |Output|Translations|OK\b)/i;

/**
 * 解析模型回复 → 与输入等行数的字符串数组（解析不出来返回 null）。
 * 容忍三种常见形态：① 标准 JSON 数组 ② ```json 围栏 ③ **逐行纯文本**（模型无视 JSON 要求直接吐译文行）。
 */
function parseLineArrayReply(text, n) {
  const arr = parseJsonArray(text);
  if (arr && arr.length === n) return arr.map(v => String(v == null ? '' : v));

  let s = stripReasoning(text);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1];
  const out = [];
  for (let line of s.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line === '[' || line === ']') continue;
    if (/^[\[\]{},]+$/.test(line)) continue;                      // 只有括号/逗号的碎片行
    line = line.replace(/^\s*\d+\s*[.、):：]\s*/, '');             // "1. " / "2)" 编号
    line = line.replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();        // 行首尾引号
    if (!line || chattyLine(line)) continue;
    out.push(line);
  }
  return out.length === n ? out : null;
}

function chattyLine(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (CHATTY_RE.test(t)) return true;
  // 纯英文说明行(如 "Here are the translations:")：整行不含中日韩文字且以冒号结尾
  if (!/[\u3400-\u9fff]/.test(t) && /[:：]$/.test(t)) return true;
  return false;
}

/**
 * 标点对密度合理性（分句用）—— 防小模型"每个词后面都加逗号"这种灾难：
 * 正常英语大约每 8~15 词一个句读；>1/3 词带标点、或出现连续 ≥4 个逗号，判为异常。
 */
function punctPairsSane(pairs, wordCount) {
  const list = Array.isArray(pairs) ? pairs : [];
  if (!list.length || !(wordCount > 0)) return false;
  if (list.length / wordCount > 0.34) return false;
  let run = 0;
  let prevIdx = -2;
  for (const [i, p] of list) {
    if (p === ',' && i === prevIdx + 1) run++;
    else run = p === ',' ? 1 : 0;
    if (run >= 4) return false;
    prevIdx = i;
  }
  return true;
}

/** 错误分类（重试策略按它分流）：网络/限流 → 退避重试；截断 → 直接拆批；内容不合规 → 换策略 */
class LlmError extends Error {
  constructor(message, kind, meta) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind || 'unknown';        // net | rate | timeout | http | truncated | empty | format | unknown
    Object.assign(this, meta || {});
  }
}

module.exports = {
  stripReasoning, looksLikeReasoning, extractJsonArray, parseJsonArray,
  parseLineArrayReply, punctPairsSane, chattyLine, LlmError,
};
