/**
 * 逐词高亮对角线校验的纯逻辑单测。
 * 正常形态：每个高亮切片只亮一个词，且依次为第 0、1、2… 个词。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = fs.readFileSync(path.join(HERE, '..', 'editor', 'js', 'main.js'), 'utf8');
const start = SRC.indexOf('function wordHighlightIssue(');
const end = SRC.lastIndexOf('/**', SRC.indexOf('汇总坏行原因', start));
assert.ok(start > 0 && end > start, 'can extract wordHighlightIssue');
const code = `
const assPlainText = text => String(text).replace(/\\{\\\\[^}]*\\}/g, '').replace(/\\\\N/gi, ' ').trim();
const splitEnglishWords = text => String(text).trim() ? String(text).trim().split(/\\s+/).filter(Boolean) : [];
${SRC.slice(start, end)}
export { wordHighlightIssue };
`;
const modPath = path.join(HERE, '_word-highlight.mjs');
fs.writeFileSync(modPath, code);
const { wordHighlightIssue } = await import(pathToFileURL(modPath).href);
fs.unlinkSync(modPath);

const HL = '{\\c&HFFFFFF&}', END = '{\\c}';
const words = ['one', 'two', 'three'];
const sent = (events, extra = {}) => ({
  text: words.join(' '), words: words.map((w, i) => ({ w, s: i, e: i + 1 })),
  events: events.map((text, i) => ({ start: i, end: i + 1, text })),
  highlightTag: HL, ...extra,
});
const eventAt = i => words.map((w, j) => j === i ? `${HL}${w}${END}` : w).join(' ');
const plain = words.join(' ');

assert.equal(wordHighlightIssue(sent([eventAt(0), eventAt(1), eventAt(2)])), '',
  'diagonal 1→0→0 / 0→1→0 / 0→0→1 passes');
assert.equal(wordHighlightIssue(sent([eventAt(0), plain, eventAt(1), eventAt(2)])), '',
  'gap events without a highlight are ignored');
assert.match(wordHighlightIssue(sent([eventAt(0), eventAt(2), eventAt(1)])), /逐词高亮不连续/,
  'out-of-order highlight is reported');
assert.match(wordHighlightIssue(sent([eventAt(0), plain, eventAt(2)])), /逐词高亮数量异常/,
  'missing highlighted slice is reported');
assert.match(wordHighlightIssue(sent([eventAt(0), `${HL}two${END} ${HL}three${END}`, eventAt(2)])), /逐词高亮重复/,
  'multiple highlighted words in one slice are reported');
assert.equal(wordHighlightIssue(sent([eventAt(0), eventAt(1), eventAt(2)], { karStyle: 'k' })), '',
  'karaoke \\k lines are not treated as color slices');

// 真实文件的 spans 常叠 \3c/\3a/\blur，关闭块也带这些标签；最后一个事件重复高亮首词。
const fancyWords = ['I,', 'SpokeIsHere,', 'plan'];
const open = String.raw`{\c&HFFFFFF&\3c&H0C0CF3&\3a&H40&\blur12.0}`;
const close = String.raw`{\c\3c\3a\blur}`;
const fancy = (hl) => fancyWords.map((w, i) => i === hl ? open + w + close : w).join(' ');
const fancySent = {
  text: fancyWords.join(' '),
  words: fancyWords.map((w, i) => ({ w, s: i, e: i + 1 })),
  highlightTag: String.raw`{\c&HFFFFFF&}`,
  events: [fancy(0), fancy(1), fancy(2), fancy(0)].map((text, i) => ({ start: i, end: i + 1, text })),
};
assert.match(wordHighlightIssue(fancySent), /第 1 词被高亮多次/,
  'tagged highlight spans are detected and duplicate first word is abnormal');
console.log('word-highlight: diagonal, gap, out-of-order, missing and duplicate highlight checks passed');
