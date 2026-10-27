import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AssDoc, assPlainText, prepareImportedSubtitle } from '../editor/js/ass.js';
import * as karaoke from '../editor/js/karaoke.js';
import { escapeAssUser } from '../editor/js/segment.js';

const head = '[Script Info]\nTitle: metadata\\Nstays\n[Events]\n'
  + 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
const dialogue = (style, text, start = '0:00:01.00', end = '0:00:03.00') =>
  `Dialogue: 0,${start},${end},${style},,0,0,0,,${text}`;
const raw = head + dialogue('中文', '{\\c&HFFFFFF&}上\\N下\\N尾\\n软\\h空');
assert.equal(prepareImportedSubtitle(raw, 'test.ass', false), raw, 'off preserves source exactly');
const cleaned = prepareImportedSubtitle(raw, 'test.ass');
assert.equal(new AssDoc(cleaned).events[0].text, '{\\c&HFFFFFF&}上下尾\\n软\\h空');
assert.ok(cleaned.includes('Title: metadata\\Nstays'), 'metadata remains unchanged');
const srt = '1\n00:00:01,000 --> 00:00:03,000\n上\\N下\n第二条物理行\n';
assert.equal(prepareImportedSubtitle(srt, 'test.srt'), srt.replace('\\N', ''), 'SRT structure survives');
assert.equal(prepareImportedSubtitle(srt, 'test.srt', false), srt);
assert.equal(assPlainText('{\\b1}上\\N下\\n软\\h空', true), '上\\N下\\n软 空');
assert.equal(assPlainText('上\\N下'), '上 下', 'video text mapping keeps its prior behavior');
assert.deepEqual(karaoke.splitEnglishWords('one\\Ntwo\\nthree'), ['one', 'two', 'three']);
assert.deepEqual(karaoke.splitEnglishWordsWithSpans('one\\Ntwo').map(x => [x.start, x.end]), [[0, 3], [5, 8]]);

// Exercise the actual list commit functions against a real ASS document, then reload.
const main = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
const fn = name => {
  const start = main.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  return main.slice(start, main.indexOf('\n}', start) + 2);
};
for (const kind of ['plain', 'color', 'k']) {
  const en = kind === 'plain' ? 'one\\Ntwo' : kind === 'k'
    ? '{\\k100}one\\N{\\k100}two'
    : '{\\c&H00FF00&}one{\\c}\\Ntwo';
  const doc = new AssDoc(head + dialogue('中文', '上\\N下') + '\n'
    + (kind === 'color'
      ? dialogue('Default', en, '0:00:01.00', '0:00:02.00') + '\n'
        + dialogue('Default', 'one\\N{\\c&H00FF00&}two{\\c}', '0:00:02.00', '0:00:03.00')
      : dialogue('Default', en)));
  const model = karaoke.analyzeKaraoke(doc);
  const zh = model.sentences.find(s => s.style === '中文');
  const english = model.sentences.find(s => s.style === 'Default');
  assert.equal(zh.text, '上\\N下', kind + ' Chinese list text');
  assert.equal(english.text, 'one\\Ntwo', kind + ' English list text');
  const before = doc.serialize();
  assert.equal(new AssDoc(before).events[1].text, en, 'opening does not change render source');
  const state = { assDoc: doc, kar: { ...model, wordStyle: kind === 'plain' ? null : 'Default' } };
  const context = vm.createContext({ ...karaoke, state, assPlainText, escapeAssUser,
    logOp() {}, fmtTime: String, previewTrack: null, clearEditPreview() {}, editRowVisible: () => true,
    assPlayer: { updateNow(text) { assert.ok(text.includes('\\N')); } }, pendingPlaybackRows: new Set() });
  vm.runInContext(fn('applyAnchorSentence') + '\n' + fn('applyWordSentence') + '\n' + fn('applyAssRow')
    + '\n' + main.match(/const escAss = .*;/)[0], context);
  context.item = { ref: { zh, en: english, start: 1, end: 3 } };
  const times = english.words.map(w => [w.s, w.e]);
  vm.runInContext("applyAssRow(item, 1, 3, '新上\\\\N新下\\none two');", context);
  assert.equal(english.text, 'one two', 'removing a marker commits');
  vm.runInContext("applyAssRow(item, 1, 3, '新上\\\\N新下\\none\\\\Ntwo');", context);
  assert.equal(zh.text, '新上\\N新下');
  assert.equal(english.text, 'one\\Ntwo');
  assert.equal(vm.runInContext("escAss('one\\\\Ntwo')", context), 'one\\Ntwo', 'preview accepts typed marker');
  assert.deepEqual(english.words.map(w => [w.s, w.e]), times, 'line-break edits preserve word timing');
  const reloaded = karaoke.analyzeKaraoke(new AssDoc(doc.serialize()));
  assert.equal(reloaded.sentences.find(s => s.style === '中文').text, '新上\\N新下');
  assert.equal(reloaded.sentences.find(s => s.style === 'Default').text, 'one\\Ntwo', kind + ' round trip');
  if (kind !== 'plain') assert.deepEqual(english.words.map(w => w.w), ['one', 'two']);
}
const template = fs.readFileSync(new URL('../tools/templates/studio.html', import.meta.url), 'utf8');
assert.equal(template, fs.readFileSync(new URL('../editor/studio.html', import.meta.url), 'utf8'));
const exportGrid = template.match(/<div class="export-grid">([\s\S]*?)<\/div>/)[1];
assert.equal((exportGrid.match(/<button /g) || []).length, 6);
assert.match(exportGrid, /id="btn-export-advanced"[\s\S]*id="btn-export-video"/, 'video occupies bottom-right cell');
assert.match(template, /id="np-remove-linebreaks" checked/);
console.log('subtitle-linebreak: import on/off, list commits, plain/color/k round trips, preview and export layout passed');
