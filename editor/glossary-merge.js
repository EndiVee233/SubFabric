'use strict';
/* 术语表合并（纯逻辑，无 IO）：把 [{src,dst}] 合进现有的 glossary 文本。
 *
 * 为什么要单独一个模块：术语表是用户在「翻译方案」里手写的多行文本，带注释（#）与
 * 分组（##简体 / ##繁體 …）。自动写入**不能**整份重排 —— 那会冲掉用户的注释、分组和
 * 手工顺序。规则：
 *   · 有分组时只写 `lang` 那一组；组不存在就在末尾新建 `##<lang>`；
 *   · 原文已存在（忽略大小写、去首尾空白）时只替换译法，保留那一行原来的位置与写法；
 *   · 新词追加到组末尾；组尾的空行保留，新词插在第一个尾随空行之前；
 *   · 注释、空行、其它分组一律原样保留；不合法/空词条直接跳过。
 *
 * 入口：mergeGlossary(text, lang, terms) → string
 */

/** 解析一行术语（与 server.js 的 parseGlossary 同口径）：
 *  '原文=译法' 优先，退回最后一个空白切分的 '原文 译法'；注释/分组/空行返回 null。 */
function parseEntry(line) {
  const l = String(line == null ? '' : line).trim();
  if (!l || l.startsWith('#')) return null;
  const m = /^(.+?)\s*=\s*(.+)$/.exec(l) || /^(.+)\s+(\S+)$/.exec(l);
  if (!m) return null;
  return {
    src: m[1].trim(),
    dst: m[2].trim(),
    sep: /^(.+?)\s*=/.test(l) ? '=' : ' ',
  };
}

function mergeGlossary(text, lang, terms) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = src ? src.split('\n') : [];
  const target = String(lang || '简体').trim() || '简体';
  const entries = (Array.isArray(terms) ? terms : [])
    .map(t => ({ src: String((t && t.src) || '').trim(), dst: String((t && t.dst) || '').trim() }))
    .filter(t => t.src && t.dst && t.src.length <= 300 && t.dst.length <= 300 && !/[\r\n]/.test(t.src + t.dst));
  if (!entries.length) return src;

  const hasSections = lines.some(l => /^##\s*/.test(String(l).trim()));
  let start = 0, end = lines.length, inGroup = false;
  if (hasSections) {
    const bounds = [];
    let cur = '', head = -1;
    lines.forEach((l, i) => {
      const m = /^##\s*(.+)$/.exec(String(l).trim());
      if (m) {
        if (head >= 0) bounds.push({ name: cur, start: head + 1, end: i });
        cur = m[1].trim(); head = i;
      }
    });
    if (head >= 0) bounds.push({ name: cur, start: head + 1, end: lines.length });
    const hit = bounds.find(b => b.name === target);
    if (hit) { start = hit.start; end = hit.end; inGroup = true; }
    else {
      if (lines.length && String(lines[lines.length - 1] || '').trim()) lines.push('');
      lines.push('##' + target);
      start = lines.length; end = lines.length; inGroup = true;
    }
  }

  /* 目标范围内的已有条目：lower(src) → 行号 */
  const at = new Map();
  for (let i = start; i < end; i++) {
    const e = parseEntry(lines[i]);
    if (e && !at.has(e.src.toLowerCase())) at.set(e.src.toLowerCase(), i);
  }

  const appended = [];
  const seen = new Set();
  for (const t of entries) {
    const key = t.src.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = at.get(key);
    if (idx != null) {
      const e = parseEntry(lines[idx]);
      lines[idx] = e.sep === '=' ? `${e.src}=${t.dst}` : `${e.src} ${t.dst}`;
    } else {
      appended.push(`${t.src}=${t.dst}`);
    }
  }

  if (appended.length) {
    if (inGroup) {
      /* 插到组末尾，但跳过尾随空行（保留分组之间的空行） */
      let insertAt = Math.min(end, lines.length);
      while (insertAt > start && !String(lines[insertAt - 1] || '').trim()) insertAt--;
      lines.splice(insertAt, 0, ...appended);
    } else {
      if (lines.length && String(lines[lines.length - 1] || '').trim()) lines.push('');
      lines.push(...appended);
    }
  }
  return lines.join('\n');
}

module.exports = { mergeGlossary, parseEntry };
