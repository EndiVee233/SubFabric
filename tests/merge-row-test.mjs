/* 「与上一条合并」纯逻辑单测: node tests/merge-row-test.mjs
 * 用户报的 bug: 合句把颜色标签一起合上去。规则:
 *   · 中文: 后段以**纯文本**并入, 中文行**不造逐词切片**(否则每词被包一层绿高亮)
 *   · 英文: **不重排**词级时间, 只把上句末词的结束接到本句开始(补掉中间停顿) */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const K = require_('../editor/js/karaoke.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };
const j = (x) => JSON.stringify(x);

/* 工具: 造一条"句子" */
const row = (o) => Object.assign({ zh: null, en: null, start: 0, end: 0 }, o);
const zh = (text) => ({ text, style: '中文字幕', words: [] });
const en = (text, words, style = 'Default') => ({ text, words: words || [], style, highlightTag: '{\\c&H00FF00&}' });
const W = (w, s, e) => ({ w, s, e });

/* ── 中文: 后段纯文本并入, 不保留其颜色/角色标签 ── */
{
  const prev = row({ start: 0, end: 2, zh: zh('{\\c&Hd000ff&}[Spk] 上一句') });
  const cur = row({ start: 3, end: 5, zh: zh('{\\c&Hff0000&}[Bob] 这一句') });
  const p = K.mergeRowParts(prev, cur);
  ok(p.zhText === '{\\c&Hd000ff&}[Spk] 上一句 这一句', '中文: 保留上一句的行首角色色标, 后段以纯文本并入', p.zhText);
  ok(!/ff0000/.test(p.zhText), '中文: 后段的颜色标签没有跟过来');
  ok(!/00FF00|00ff00/.test(p.zhText), '中文: 没有混进逐词绿高亮标签');
  ok((p.zhText.match(/\{\\c&H/g) || []).length === 1, '中文: 只剩一个颜色标签（上一句自己的）', p.zhText);
  ok(p.start === 0 && p.end === 5, '时间: 取并集', p.start + '~' + p.end);
}

/* ── 中文: 逐词高亮标签、换行、行首角色名都要剥掉 ── */
{
  const prev = row({ start: 0, end: 1, zh: zh('{\\c&Hffffff&}[A] 甲') });
  const cur = row({ start: 2, end: 3, zh: zh('乙{\\c&H00FF00&}丙{\\c}\\N丁') });
  const p = K.mergeRowParts(prev, cur);
  ok(p.zhText === '{\\c&Hffffff&}[A] 甲 乙丙 丁', '中文: 高亮标签/换行按纯文本处理', p.zhText);
  ok(K.stripInlineTags('{\\c&H00FF00&}词{\\c}') === '词', 'stripInlineTags: 去高亮');
  ok(K.stripInlineTags('[Spk] 你好') === '你好', 'stripInlineTags: 去行首角色名');
  ok(K.stripInlineTags('a\\Nb') === 'a b', 'stripInlineTags: \\N → 空格');
  ok(K.stripInlineTags('{\\1c&Hff0000&}红') === '红', 'stripInlineTags: 去 \\1c 主色标签');
}

/* ── 英文: 两侧都有词级时间 → 全部保留, 只把上句末词接到本句开始 ── */
{
  const prev = row({ start: 0, end: 1.8, en: en('hello world', [W('hello', 0.1, 0.6), W('world', 0.7, 1.2)]) });
  const cur = row({ start: 3.0, end: 4.0, en: en('again friend', [W('again', 3.1, 3.5), W('friend', 3.6, 3.9)]) });
  const p = K.mergeRowParts(prev, cur);
  ok(p.enText === 'hello world again friend', '英文: 文本按纯文本拼接', p.enText);
  ok(p.enWords.length === 4, '英文: 词数 = 两边之和', p.enWords.length);
  ok(j(p.enWords.map(w => [w.s, w.e])) === j([[0.1, 0.6], [0.7, 3.0], [3.1, 3.5], [3.6, 3.9]]),
    '英文: 词级时间原样保留, 只有上句末词的结束接到本句开始', j(p.enWords));
  ok(p.enWords[1].e === cur.start, '英文: 上句末词结束 == 本句开始（用户要求）');
  let mono = true;
  for (let i = 1; i < p.enWords.length; i++) if (p.enWords[i].s < p.enWords[i - 1].e - 1e-9) mono = false;
  ok(mono, '英文: 合并后不重叠（单调）');
  ok(p.enWords.every(w => w.s >= 0 && w.e <= 4.0 + 1e-9), '英文: 全部夹在整块时间内');
}

/* ── 英文: 本句没有词级时间 → 上句末词延伸到整块结束 ── */
{
  const prev = row({ start: 0, end: 2, en: en('one two', [W('one', 0.1, 0.5), W('two', 0.6, 1.0)]) });
  const cur = row({ start: 3, end: 5, en: en('three four', []) });
  const p = K.mergeRowParts(prev, cur);
  ok(p.enWords.length === 2, '英文: 只有上句有词级时间', p.enWords.length);
  ok(p.enWords[1].e === 5, '英文: 末词延伸到整块结束（5s）', p.enWords[1].e);
  ok(p.enText === 'one two three four', '英文: 无词级时间的那句照样并进文本', p.enText);
}

/* ── 英文: 上句没有词级时间 → 本句首词起点拉回整块开始 ── */
{
  const prev = row({ start: 0, end: 2, en: en('one two', []) });
  const cur = row({ start: 3, end: 5, en: en('three four', [W('three', 3.4, 4.0), W('four', 4.1, 4.6)]) });
  const p = K.mergeRowParts(prev, cur);
  ok(p.enWords.length === 2 && p.enWords[0].s === 0, '英文: 上句无词级时间时首词起点拉回整块开始', j(p.enWords));
}

/* ── 两侧都没有词级时间 → 保持干净整句, 不假装有逐词 ── */
{
  const prev = row({ start: 0, end: 1, zh: zh('甲'), en: en('aaa', []) });
  const cur = row({ start: 2, end: 3, zh: zh('乙'), en: en('bbb', []) });
  const p = K.mergeRowParts(prev, cur);
  ok(p.enWords.length === 0, '英文: 两侧都没有词级时间 → 不造词级时间（保持整句）', j(p.enWords));
  ok(p.zhText === '甲 乙' && p.enText === 'aaa bbb', '文本: 中英都按纯文本拼接', j([p.zhText, p.enText]));
}

/* ── 标点与空格收拾 ── */
{
  const prev = row({ start: 0, end: 1, en: en('hello', []) });
  const cur = row({ start: 2, end: 3, en: en(', world', []) });
  const p = K.mergeRowParts(prev, cur);
  ok(p.enText === 'hello, world', '英文: 标点前的多余空格被收拾', p.enText);
}

/* ── 缺一半（只有中文 / 只有英文）也要能合 ── */
{
  const a = K.mergeRowParts(row({ start: 0, end: 1, zh: zh('甲') }), row({ start: 2, end: 3, zh: zh('乙') }));
  ok(a.zhText === '甲 乙' && a.enText === '', '只有中文的两条: 中文合、英文为空', j([a.zhText, a.enText]));
  const b = K.mergeRowParts(row({ start: 0, end: 1, en: en('a', []) }), row({ start: 2, end: 3, en: en('b', []) }));
  ok(b.enText === 'a b' && b.zhText === '', '只有英文的两条: 英文合、中文为空', j([b.zhText, b.enText]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
