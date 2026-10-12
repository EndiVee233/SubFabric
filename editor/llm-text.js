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
 * 剥掉**误当正文存下来的 JSON 数组外壳**。只对"整串就是一个 JSON 字符串数组"生效，
 * 普通译文一律原样返回。
 *
 * 为什么需要：用户报「新稿件的角色里出现台词」—— 查出 4 条译文的正文是
 * `["译文1","译文2",…]` 这种**原样的 JSON 数组字符串**，被 walkSubtitle 写进了 ASS，
 * 于是行首那个 `["…` 被 `speakerTextTagOf` 当成 `[角色名]` 读走了，角色栏里就列出台词。
 * 顺带说明：**不要**只看"有没有方括号"就剥——译文本身可能合法地含 `[` `]`，
 * 所以这里要求整串能被 JSON.parse 成"字符串数组"才动手。
 */
function unwrapJsonArrayString(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length < 4 || s[0] !== '[' || s[s.length - 1] !== ']') return String(v == null ? '' : v);
  let parsed;
  try { parsed = JSON.parse(s); } catch { return String(v == null ? '' : v); }
  if (!Array.isArray(parsed)) return String(v == null ? '' : v);
  const parts = parsed.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  // 空数组、或元素不是字符串（数字/对象/嵌套数组）→ 不是我们认识的那种外壳，不动
  if (!parts.length || parsed.some(x => typeof x !== 'string')) return String(v == null ? '' : v);
  return parts.join(' ');
}

/**
 * 解析模型回复 → 与输入等行数的字符串数组（解析不出来返回 null）。
 * 容忍三种常见形态：① 标准 JSON 数组 ② ```json 围栏 ③ **逐行纯文本**（模型无视 JSON 要求直接吐译文行）。
 *
 * ⚠ 两个必须"带上 n"来判断的点（踩过的坑）：
 *  · 引号剥离不能无条件做 —— 模型按 ①②返回普通数组时，`JSON.parse` 已经把引号去掉了；
 *    而 ③ 才是"字符串里带着 `"…"`"，那种情况下面用 `parseJsonArray(line)` 按**数组元素**处理。
 *  · JSON 数组**是结构化回复**，绝不能落进"逐行兜底"按整行取。模型的数组元素数比输入行数多
 *    是完全正常的（一条输入含 2~4 句 → 它给 2~4 条译文），此时应把元素**并入**结果并按 n 校验；
 *    按整行取就会把 `["a","b","c","d"]` 原样当成一句译文存下去（本次的真实 bug）。
 */
function parseLineArrayReply(text, n) {
  const arr = parseJsonArray(text);
  if (arr) {
    // 元素数正好 → 直接用（最常见）
    if (arr.length === n) return arr.map(v => unwrapJsonArrayString(v));
    // 元素比输入行多 → 先把每个元素各自拆一次（元素本身也可能是数组串），再按 n 校验
    if (arr.length > n) {
      const flat = [];
      for (const v of arr) {
        for (const p of String(v == null ? '' : v).split('\n')) {
          const t = p.trim();
          if (t) flat.push(t);
        }
      }
      if (flat.length === n) return flat.map(unwrapJsonArrayString);
    }
    // 元素比输入行少、或拆完仍对不齐 → 交给下面的逐行兜底再试
  }

  let s = stripReasoning(text);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1];
  const out = [];
  for (let line of s.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line === '[' || line === ']') continue;
    if (/^[\[\]{},]+$/.test(line)) continue;                      // 只有括号/逗号的碎片行
    /* ⚠ 顺序很重要：**先**试 JSON 数组，**再**剥引号。
     *  反过来会把 `["译文1","译文2"]` 的外层引号剥掉、露出非法 JSON，
     *  于是数组元素取不出来、这行被当整句译文 —— 就是本次的 bug。 */
    const lineArr = parseJsonArray(line);
    if (lineArr && lineArr.length) {
      for (const v of lineArr) {
        const t = String(v == null ? '' : v).replace(/^\s*\d+\s*[.、):：]\s*/, '').trim();
        if (t && !chattyLine(t)) out.push(unwrapJsonArrayString(t));
      }
      continue;
    }
    line = line.replace(/^\s*\d+\s*[.、):：]\s*/, '');             // "1. " / "2)" 编号
    line = line.replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();        // 行首尾引号
    if (!line || chattyLine(line)) continue;
    out.push(unwrapJsonArrayString(line));
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

/* ── 翻译批量大小（用户可调：「全局设置 → 字幕翻译 → 每批行数」）──────────────
 * 语义 = "一次请求最多带几行给 LLM"。批越大请求越少，但"返回行数必须等于输入行数"
 * 这条对齐要求越容易整批翻车（小模型少给/多给一行），也更容易被 max_tokens 截断后整批拆半重来。
 * 失败时仍有自动拆半兜底，所以这个值只是"期望规模"。 */
const BATCH_MIN = 5;
const BATCH_MAX = 100;
const BATCH_DEFAULT = 25;
function clampBatchSize(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return BATCH_DEFAULT;
  return Math.max(BATCH_MIN, Math.min(BATCH_MAX, n));
}

/** 把一个数组按 size 切成若干块（翻译分批用；纯函数, 便于单测边界） */
function planChunks(items, size) {
  const list = Array.isArray(items) ? items : [];
  const n = clampBatchSize(size);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/* ── 采样温度 / 上下文行数（全局设置 → 模型设置 → LLM 子视图里的两项）──────────
 * 设计稿把这两项摆在"模型"与"调用参数"两栏里。接线口径：
 *   · temperature —— 直接进请求体（原来写死 0.3）。范围 0~2，越界夹回。
 *   · contextRows —— 每批**额外**送前面 N 行"原文 + 已定译文"作参考，让模型接着上文译。
 *     参考行**不参与译文行数校验**（回复仍然只对应待翻的行），所以它只影响提示词长度，
 *     不会让 parseTranslationReply 的等行数校验失配 —— 这是这条功能最容易出错的地方。
 *     0 = 不带上文（= 旧行为）。默认 0，只有用户显式设置才带上文。 */
const TEMP_MIN = 0, TEMP_MAX = 2, TEMP_DEFAULT = 0.3;
const CTX_MIN = 0, CTX_MAX = 200, CTX_DEFAULT = 0;

function clampTemperature(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return TEMP_DEFAULT;
  return Math.max(TEMP_MIN, Math.min(TEMP_MAX, n));
}

function clampContextRows(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return CTX_MIN;
  return Math.max(CTX_MIN, Math.min(CTX_MAX, n));
}

/** 拼给模型的待翻译正文。带上下文时把参考行放在**同一个 user 消息**里、用显式标记隔开。
 *  ⚠ 字符串里"待翻译的行数"必须仍然等于 texts.length —— 调用方按它校验译文行数。 */
function buildTranslateUserMessage(texts, refs) {
  const list = (Array.isArray(texts) ? texts : []).map(t => String(t == null ? '' : t));
  const body = list.join('\n');
  const r = (Array.isArray(refs) ? refs : []).filter(x => x && (x.text || x.zh));
  if (!r.length) return body;
  const ctx = r.map(x => `${String(x.text == null ? '' : x.text)}\t=> ${String(x.zh == null ? '' : x.zh)}`).join('\n');
  return `[[前文参考（已有译文，不要翻译、不要输出）]]\n${ctx}\n[[以下 ${list.length} 行才是本次要翻译的内容]]\n${body}`;
}

/** 带上下文的批次切分：每批 = { idxs, refs }。
 *  refs 是该批**前面**最多 ctx 行里"已有译文"的那些（原文 + 译文），供模型接上文。 */
function planJobs(items, size, ctx) {
  const list = Array.isArray(items) ? items : [];
  const n = clampBatchSize(size);
  const c = clampContextRows(ctx);
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    const idxs = [];
    for (let k = i; k < Math.min(i + n, list.length); k++) idxs.push(k);
    const refs = [];
    if (c > 0 && i > 0) {
      for (let k = Math.max(0, i - c); k < i; k++) {
        const it = list[k];
        const zh = it && (it.zh != null ? it.zh : it.translation);
        if (zh) refs.push({ text: it && it.text, zh });
      }
    }
    out.push({ idxs, refs });
  }
  return out;
}

/* ── 中文译文的标点归一化 ────────────────────────────────────────
 * 项目约定: 中文行用**空格**分词, 不出现 ，、。 (半角 , . 与 ! ? 保留不动)。
 * 这是"外部文本(LLM 译文 / ASR)入库前"的统一口径 —— 用户手动编辑不走这里。
 *
 * 为什么单独抽成一个函数: 这条规则以前散在 server.js 写初稿、main.js 选区重新识别两处,
 * 而**右键「重新翻译」漏了**, 于是那一路径的中文会带回 ，。 (用户报的 bug)。
 * 浏览器侧同款实现在 editor/js/karaoke.js 的 normalizeZhPunctuation ——
 * tests/zh-punct-test.mjs 会断言两者对同一语料输出一致, 防止再次分叉。
 * ──────────────────────────────────────────────────────────── */
function normalizeZhPunctuation(text) {
  return String(text == null ? '' : text)
    .replace(/\r?\n/g, ' ')
    .replace(/[，、。]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\\N[ \t]*/g, '\\N')   // 别在 ASS 换行符旁留下空格
    .trim();
}

module.exports = {
  stripReasoning, looksLikeReasoning, extractJsonArray, parseJsonArray,
  parseLineArrayReply, unwrapJsonArrayString, punctPairsSane, chattyLine, LlmError,
  clampBatchSize, planChunks, normalizeZhPunctuation, BATCH_MIN, BATCH_MAX, BATCH_DEFAULT,
  clampTemperature, clampContextRows, buildTranslateUserMessage, planJobs,
  TEMP_MIN, TEMP_MAX, TEMP_DEFAULT, CTX_MIN, CTX_MAX, CTX_DEFAULT,
};
