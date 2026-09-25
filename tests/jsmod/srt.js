/** SRT 解析 / 序列化 / 双语处理 / 有限标签转 HTML */
import { parseTime, fmtTimeSrt, escapeHtml } from './util.js';

/**
 * 解析 SRT 文本 → cues: [{id, start, end, lines[]}]
 * 容错: \r\n / \n, 空行分隔, 缺序号
 */
export function parseSRT(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  const reTime = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  for (const raw of blocks) {
    const linesRaw = raw.split('\n');
    while (linesRaw.length && linesRaw[0].trim() === '') linesRaw.shift();
    while (linesRaw.length && linesRaw[linesRaw.length - 1].trim() === '') linesRaw.pop();
    if (!linesRaw.length) continue;

    let timeIdx = linesRaw.findIndex(l => reTime.test(l));
    if (timeIdx === -1) continue;
    const m = reTime.exec(linesRaw[timeIdx]);
    const start = parseTime(m[1]);
    const end = parseTime(m[2]);
    if (isNaN(start) || isNaN(end)) continue;

    const idLine = linesRaw.slice(0, timeIdx).join(' ').trim();
    const id = parseInt(idLine, 10);
    const textLines = linesRaw.slice(timeIdx + 1);
    // 异常标记: 结束早于开始(含零时长以下) → 列表「⚠ 异常行」可过滤查看
    const bad = end < start ? { order: `${m[1]} --> ${m[2]}` } : null;
    cues.push({ id: isNaN(id) ? cues.length + 1 : id, start, end, lines: textLines, bad });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  cues.forEach((c, i) => c.id = i + 1);
  return cues;
}

export function serializeSRT(cues) {
  const out = [];
  cues.forEach((c, i) => {
    out.push(String(i + 1));
    out.push(`${fmtTimeSrt(c.start)} --> ${fmtTimeSrt(c.end)}`);
    out.push(...c.lines);
    out.push('');
  });
  return '﻿' + out.join('\r\n');
}

/**
 * 双语拆分: 约定第 1 行为主语言, 其余行为副语言
 * → { main: line|null, subs: [lines] }
 */
export function splitBilingual(lines) {
  if (!lines.length) return { main: null, subs: [] };
  if (lines.length === 1) return { main: lines[0], subs: [] };
  return { main: lines[0], subs: lines.slice(1) };
}

/** SRT 行内标签 → 安全 HTML (支持 i/b/u/font color, 其余转义) */
export function srtLineToHtml(line) {
  let s = escapeHtml(line);
  const tag = (name) => new RegExp(`&lt;${name}&gt;(.*?)&lt;/${name}&gt;`, 'gis');
  s = s.replace(tag('i'), '<i>$1</i>')
       .replace(tag('b'), '<b>$1</b>')
       .replace(tag('u'), '<u>$1</u>')
       .replace(tag('s'), '<s>$1</s>');
  s = s.replace(/&lt;font\s+color\s*=\s*"?([^"&>]+?)"?\s*&gt;(.*?)&lt;\/font&gt;/gis,
    (_, color, inner) => `<span style="color:${color.replace(/[^#0-9a-zA-Z(),.\s%]/g, '')}">${inner}</span>`);
  // 未闭合的斜体等容错
  s = s.replace(/&lt;\/?(i|b|u|s)&gt;/gi, (_, t) => `<${t.toLowerCase()}>`);
  return s;
}

/** 列表预览纯文本 */
export function srtPlainText(lines) {
  return lines.map(l => l.replace(/<[^>]+>/g, '')).join(' / ');
}
