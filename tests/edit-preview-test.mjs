/* 行内编辑实时预览单测: node tests/edit-preview-test.mjs
 *
 * 回归的 bug: 英文字幕在视频区"随改随变", 中文行却要退出编辑框才更新 ——
 * 因为行内编辑器只给英文行(l2)挂了 input 监听, 中文行(l1)没有。
 * 现在中文行也接 input → panel.onChineseInput → 走同一套临时预览(ass.js 的 previewMulti)。
 *
 * 本测试覆盖两块纯逻辑:
 *  ① buildAnchorText —— 整句行落盘文本的构造(角色标签补回/继承行首色标/换行转 \N),
 *     **提交与预览共用**, 保证"预览看到的 == 提交后的"。
 *  ② previewMulti  —— 中英两行草稿一起预览: 只替换该句事件、不动原文档、不动别人。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  let stale = !fs.existsSync(marker);
  if (!stale) {
    for (const f of fs.readdirSync(SRC)) {
      if (!f.endsWith('.js')) continue;
      const a = path.join(JSMOD, f), b = path.join(SRC, f);
      if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
    }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true });
    fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();

const K = await import('./jsmod/karaoke.js');
const { AssDoc } = await import('./jsmod/ass.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + extra : '')); }
};

const SRC_LINES = [
  '[Script Info]', 'ScriptType: v4.00+', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
  'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:02.00,中文字幕,Minute,0,0,0,,{\\c&HFFFFFF&}[Minute] 我来挡',
  'Dialogue: 0,0:00:00.00,0:00:01.00,Default,Minute,0,0,0,,{\\c&HFFFFFF&}Ill{\\c} block',
  'Dialogue: 0,0:00:01.00,0:00:02.00,Default,Minute,0,0,0,,Ill {\\c&HFFFFFF&}block{\\c}',
  'Dialogue: 0,0:00:02.00,0:00:04.00,中文字幕,Baablu,0,0,0,,{\\c&HFF94FD&}[Baablu] 宝库吗',
  'Dialogue: 0,0:00:02.00,0:00:03.00,Default,Baablu,0,0,0,,{\\c&HFFFFFF&}The{\\c} vault',
  'Dialogue: 0,0:00:03.00,0:00:04.00,Default,Baablu,0,0,0,,The {\\c&HFFFFFF&}vault{\\c}',
];
const mkDoc = () => new AssDoc(SRC_LINES.join('\n'));
/** 取某样式在 [lo,hi) 时间范围内的所有事件, 拼成与 analyzeKaraoke 同构的"一句" */
const mkSent = (doc, style, lo, hi) => {
  const evs = doc.sorted.filter(e => e.style === style && e.start >= lo - 1e-6 && e.start < hi - 1e-6);
  return {
    style, start: evs[0].start, end: Math.max(...evs.map(e => e.end)), text: '',
    events: evs, words: [], proto: { layer: '0', name: evs[0].name, effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } },
    highlightTag: '{\\c&H00FF00&}'
  };
};
const textAt = (serialized, style, start) => {
  for (const l of serialized.split('\r\n')) {
    const m = /^Dialogue:\s*([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/.exec(l);
    if (!m) continue;
    if (m[4].trim() === style && m[2].trim() === start) return m[10];
  }
  return null;
};

console.log('== buildAnchorText: 整句行落盘文本构造 ==');
{
  const B = K.buildAnchorText;
  ok(B('{\\c&HFFFFFF&}[Minute] 我来挡', '[Minute] 我来挡 了') === '{\\c&HFFFFFF&}[Minute] 我来挡 了',
    '新文本没带色标 → 继承原行首色标', B('{\\c&HFFFFFF&}[Minute] 我来挡', '[Minute] 我来挡 了'));
  ok(B('{\\c&HFFFFFF&}[Minute] 我来挡', '{\\c&HFF0000&}[Minute] 红的') === '{\\c&HFF0000&}[Minute] 红的',
    '新文本自带色标 → 不继承旧的', B('{\\c&HFFFFFF&}[Minute] 我来挡', '{\\c&HFF0000&}[Minute] 红的'));
  ok(B('', '[Minute]   我来挡') === '[Minute] 我来挡', '角色标签与正文之间收成一个空格', B('', '[Minute]   我来挡'));
  ok(B('', '我来挡') === '我来挡', '没有标签 → 原样', B('', '我来挡'));
  ok(B('', '[Minute] 上\n下') === '[Minute] 上\\N下', '真换行 → \\N', JSON.stringify(B('', '[Minute] 上\n下')));
  ok(B(null, '[Minute] 甲') === '[Minute] 甲', '原文本为 null 也不炸');
}

console.log('\n== previewMulti: 中英两行草稿一起预览 ==');
{
  const doc = mkDoc();
  const before = doc.serialize();
  const zh = mkSent(doc, '中文字幕', 0, 1);
  const en = mkSent(doc, 'Default', 0, 1.5);
  const zhText = K.buildAnchorText(zh.events[0].text, '[Minute] 我改的中文');
  const track = doc.previewMulti([
    { sentence: zh, text: zhText },
    { sentence: en, text: '{\\c&HFFFFFF&}New{\\c} english' },
  ]);
  ok(textAt(track, '中文字幕', '0:00:00.00') === '{\\c&HFFFFFF&}[Minute] 我改的中文',
    '中文行换成草稿文本(色标与标签都在)', textAt(track, '中文字幕', '0:00:00.00'));
  ok(textAt(track, 'Default', '0:00:00.00') === '{\\c&HFFFFFF&}New{\\c} english', '英文行换成草稿文本');
  ok(textAt(track, '中文字幕', '0:00:02.00') === '{\\c&HFF94FD&}[Baablu] 宝库吗', '别人的中文行原样保留');
  ok(textAt(track, 'Default', '0:00:02.00') === '{\\c&HFFFFFF&}The{\\c} vault', '别人的英文行原样保留');
  ok(doc.serialize() === before, '预览**不改动**原文档(serialize 逐字相同)');
  // 中文 1 条事件 → 1 条 spec(不变); 英文 2 片切片 → 1 条整句 spec(少 1 行) —— 都是"替换"不是"新增"
  const nBefore = before.split('\r\n').length, nAfter = track.split('\r\n').length;
  ok(nAfter === nBefore - 1, '行数是替换的结果(2 片英文 → 1 条 spec), 没有多余新增', `${nBefore} → ${nAfter}`);
}

console.log('\n== 只预览一行时, 另一行保持真实事件 ==');
{
  const doc = mkDoc();
  const zh = mkSent(doc, '中文字幕', 0, 1);
  const before = doc.serialize();
  const track = doc.previewMulti([{ sentence: zh, text: '{\\c&HFFFFFF&}[Minute] 只改中文' }]);
  ok(textAt(track, '中文字幕', '0:00:00.00') === '{\\c&HFFFFFF&}[Minute] 只改中文', '中文行是草稿');
  ok(textAt(track, 'Default', '0:00:00.00') === '{\\c&HFFFFFF&}Ill{\\c} block', '英文行仍是真实事件(没被清空)');
  ok(textAt(track, 'Default', '0:00:01.00') === 'Ill {\\c&HFFFFFF&}block{\\c}', '英文行第二片也在');
  ok(doc.serialize() === before, '原文档未被改动');
}

console.log('\n== previewSentence / previewEvents 兼容 ==');
{
  const doc = mkDoc();
  const zh = mkSent(doc, '中文字幕', 0, 1);
  const s1 = doc.previewSentence(zh, '{\\c&HFFFFFF&}[Minute] 甲');
  ok(textAt(s1, '中文字幕', '0:00:00.00') === '{\\c&HFFFFFF&}[Minute] 甲', 'previewSentence 仍可用');
  const en = mkSent(doc, 'Default', 0, 1.5);
  const s2 = doc.previewEvents(en, [
    { layer: '0', style: 'Default', name: 'Minute', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' }, start: 0, end: 2, text: 'one spec only' }
  ]);
  ok(textAt(s2, 'Default', '0:00:00.00') === 'one spec only', 'previewEvents(specs) 仍可用');
  ok(!s2.includes('Ill block'), '原切片被替换掉');
}

console.log('\n== 预览 == 提交: 两条路径共用 buildAnchorText ==');
{
  const doc = mkDoc();
  const zh = mkSent(doc, '中文字幕', 0, 1);
  const typed = '我改过的中文';
  const tag = '[Minute] ';
  // 预览: 编辑框把标签藏起来 → 预览时补回
  const previewText = K.buildAnchorText(zh.events[0].text, tag + typed);
  const track = doc.previewMulti([{ sentence: zh, text: previewText }]);
  // 提交: applyAnchorSentence 的等价动作
  const commitText = K.buildAnchorText(zh.events[0].text, tag + typed);
  doc.setEventText(zh.events[0], commitText);
  ok(textAt(track, '中文字幕', '0:00:00.00') === textAt(doc.serialize(), '中文字幕', '0:00:00.00'),
    '预览行文本 == 提交后落盘文本', `${textAt(track, '中文字幕', '0:00:00.00')} vs ${textAt(doc.serialize(), '中文字幕', '0:00:00.00')}`);
  ok(textAt(doc.serialize(), '中文字幕', '0:00:00.00') === '{\\c&HFFFFFF&}[Minute] 我改过的中文',
    '落盘后色标/标签/正文都对', textAt(doc.serialize(), '中文字幕', '0:00:00.00'));
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
