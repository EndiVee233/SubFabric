'use strict';
/**
 * 术语表拼写修复（纯逻辑，所有 ASR 引擎共用）。
 *
 * 为什么需要：ASR 的错误里有一大类不是"听错整句"，而是**专名拼错**：
 *   Wembu / Wembo → Wemmbu，Sapparata → Saparata，Flotives / Floatives → Flowtives，
 *   Minitech → Minutetech。
 * 这些词在用户提供的术语表里有标准写法，逐词做**受限编辑距离**匹配比重新识别便宜得多，
 * 也不会像"把术语表当热词喂给解码器"那样把整句带崩（实测 Whisper 的 initial_prompt
 * 会把 10 分钟转写从 1740 词压到 1528 词、WER 17%）。
 *
 * 安全边界（每条都来自实测的误伤）：
 *   - 只修**长度 ≥ 6** 的术语；短词（Spoke / Wait / with）与普通词太近，容易把
 *     "with" 修成 "Wraith"、"Wait" 修成 "Wraith"。
 *   - 距离 1 要求前 2 字符相同；距离 2 要求前 3 字符相同且长度差 ≤ 1。
 *   - 完全相等时，只有原词首字母大写 / 术语全大写 / 术语 ≥ 6 字符才改大小写，
 *     避免把句中的动词 "spoke" 改成角色名 "Spoke"。
 *   - 保留原词的标点与首字母大小写习惯。
 */

const PUNCT = /^[^\w'’]+|[^\w'’]+$/;

function coreOf(word) {
  return String(word == null ? '' : word).replace(PUNCT, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function buildGlossary(terms) {
  const out = [];
  const seen = new Set();
  for (const t of terms || []) {
    const core = coreOf(t);
    if (!core || seen.has(core.toLowerCase())) continue;
    seen.add(core.toLowerCase());
    out.push({ lower: core.toLowerCase(), canon: core });
  }
  return out;
}

/** 修一个词；返回新词（没有命中就原样返回）。 */
function repairWord(word, glossary) {
  const raw = String(word == null ? '' : word);
  const core = coreOf(raw);
  if (!core) return raw;
  const low = core.toLowerCase();
  let best = null;
  for (const g of glossary) {
    if (low === g.lower) {
      if (core[0] === core[0].toUpperCase() || g.canon === g.canon.toUpperCase() || g.lower.length >= 6) {
        best = { score: 0, canon: g.canon };
      }
      break;
    }
    if (Math.abs(low.length - g.lower.length) > 2 || g.lower.length < 6) continue;
    const d = levenshtein(low, g.lower);
    const prefix2 = low.slice(0, 2) === g.lower.slice(0, 2);
    const prefix3 = low.slice(0, 3) === g.lower.slice(0, 3);
    const suffix3 = low.slice(-3) === g.lower.slice(-3);
    const ok = (d === 1 && prefix2)
      || (d === 2 && g.lower.length >= 8 && prefix3)
      || (d === 2 && g.lower.length >= 6 && prefix3 && Math.abs(low.length - g.lower.length) <= 1)
      // 缩写/漏音节的长专名：Minitech → Minutetech（d=3，但首 2 尾 3 都吻合）
      || (d === 3 && g.lower.length >= 9 && prefix2 && suffix3);
    if (!ok) continue;
    const score = d / Math.max(1, g.lower.length);
    if (!best || score < best.score) best = { score, canon: g.canon };
  }
  if (!best) return raw;
  let canonical = best.canon;
  // 原词小写、术语不是全大写 → 保持小写（spoke 的动词义）
  if (core[0] === core[0].toLowerCase() && raw[0] === raw[0].toLowerCase() && canonical !== canonical.toUpperCase()) {
    canonical = canonical[0].toLowerCase() + canonical.slice(1);
  }
  return raw.replace(core, canonical);
}

/** 修一份 words（`{word,start,end}`）；原地改，返回改动条数。 */
function repairWords(words, terms) {
  const glossary = buildGlossary(terms);
  if (!glossary.length) return 0;
  let n = 0;
  for (const w of words || []) {
    if (!w || typeof w.word !== 'string') continue;
    const next = repairWord(w.word, glossary);
    if (next !== w.word) { w.word = next; n++; }
  }
  return n;
}

/** 修一份 `{segments:[{text,words}]}`；同时把 text 按 words 重拼。 */
function repairSegments(segments, terms) {
  const glossary = buildGlossary(terms);
  if (!glossary.length) return 0;
  let n = 0;
  for (const seg of segments || []) {
    const words = Array.isArray(seg && seg.words) ? seg.words : [];
    let changed = 0;
    for (const w of words) {
      if (!w || typeof w.word !== 'string') continue;
      const next = repairWord(w.word, glossary);
      if (next !== w.word) { w.word = next; changed++; n++; }
    }
    // 只有真的改过词才重拼 text —— 否则会给外来字幕的空白布局做无意义重排
    if (changed && words.length) seg.text = words.map(w => String(w.word || '').trim()).filter(Boolean).join(' ');
  }
  return n;
}

module.exports = { repairWord, repairWords, repairSegments, buildGlossary, levenshtein };
