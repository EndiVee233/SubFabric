// Execute the real region-import mutators against a real ASS document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AssDoc } from '../editor/js/ass.js';
import * as K from '../editor/js/karaoke.js';
import { escapeAssUser } from '../editor/js/segment.js';
import { makeSyntheticAss } from './ass-fixture.mjs';
import { planRegionMerge, resolveFillOnly, resolveReplace, eventsForReplacement } from '../editor/region-merge.js';
import { Timeline } from '../editor/js/timeline.js';

const src = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
function slice(a, b) { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i); return src.slice(i, j); }
const functions = slice('async function rimApply(force)', '\nif (btnRegionImport)')
  + slice('function removeAssItemsData(', '\nfunction removeItemData(')
  + slice('function removeItemData(', '\nfunction deleteItem(')
  + slice('function addRecognizedRow(', '\n/** 把建好的行')
  + slice('function registerRecognizedRow(', '\n/** 删掉')
  + slice('function appendSentence(', '\n/** 在指定区间');

async function run(force, color = '#ab1234', known = []) {
  const seed = new AssDoc(makeSyntheticAss()), initial = K.analyzeKaraoke(seed);
  const first = K.pairRows(initial.sentences, initial.wordStyle)[0];
  const keep = new Set([...(first.zh?.events || []), ...(first.en?.events || [])]);
  seed.deleteEvents(seed.events.filter(e => !keep.has(e)));
  const doc = new AssDoc(seed.serialize()), kar = K.analyzeKaraoke(doc);
  kar.rows = K.pairRows(kar.sentences, kar.wordStyle);
  const zhStyle = kar.rows.find(r => r.zh).zh.style;
  const state = { format: 'ass', assDoc: doc, kar, newRows: new Set(), selected: null };
  state.items = kar.rows.map(ref => ({ kind: 'ass-row', ref, start: ref.start, end: ref.end }));
  const original = state.items.length, oldFirst = state.items[0].ref;
  const updates = [], calls = [], timeline = { touch() { calls.push('touch'); }, drawIfNeeded() {}, setPlayingByTime() {} };
  const ctx = { state, rimBusy: false, rimName: 'fixture.ass',
    rimPlan: planRegionMerge([{ start: force ? 1 : 260, end: force ? 3 : 263, lines: ['[NEW] 导入字幕', 'fresh imported words'], color, words: [] }], state.items, 0, 300),
    resolveFillOnly, resolveReplace, eventsForReplacement, ROLE_PALETTE: K.ROLE_PALETTE, HIGHLIGHT_COLORS: K.HIGHLIGHT_COLORS,
    ...Object.fromEntries(['sentenceFromEvent','speakerColorOf','speakerTagOf','buildWordSpecs','recalcWords'].map(k => [k, K[k]])),
    hexToAss: h => h.slice(5,7) + h.slice(3,5) + h.slice(1,3), escAss: escapeAssUser,
    itemsInRange: (a,b) => state.items.filter(x => x.end > a && x.start < b),
    computeRoles: () => known, healWordRows: () => 0, reconcileKaraoke() {},
    assPlayer: { updateNow: t => updates.push(t) }, overlay: { setCues() {}, update() {} }, timeline,
    panel: { stashInlineEdit() { calls.push('commit'); return null; }, resumeInlineEdit() {} },
    clearEditPreview: () => calls.push('clear-edit'), clearWordPreview: () => calls.push('clear-word'), pendingPlaybackRows: new Set([oldFirst]),
    rimReadRange: () => ({ ok: true, start: 0, end: 300 }), fmtTime: String,
    jobCardShow() {}, jobCardHide() {}, toast() {}, logOp() {}, rimEls: { overlay: { hidden: false } },
    rebuildItemsAndLanes() { state.items = kar.rows.map(ref => ({ ref, start: ref.start, end: ref.end })); calls.push('rebuild'); },
    setTimeout: fn => { fn(); return 1; }, console,
  };
  vm.createContext(ctx); vm.runInContext(functions + '\nthis.apply = rimApply;', ctx);
  await ctx.apply(force);
  assert.equal(state.items.length, force ? 1 : original + 1, 'replacing all old rows must still create imported rows');
  const imported = kar.rows.find(r => r.en && r.en.text === 'fresh imported words');
  assert.ok(imported && imported.zh && imported.en, 'both tracks survive even when their last anchors were removed');
  assert.equal(imported.zh.style, zhStyle, 'destination Chinese style survives full replacement');
  const expected = known.find(r => r.name === 'NEW')?.color || color;
  assert.equal(imported.color.toLowerCase(), expected);
  assert.ok(imported.en.words.length === 3, 'imported word timing is present');
  assert.equal(updates.length, 1, 'one final renderer track update, not one per deleted row');
  assert.match(updates[0], /fresh/);
  const reload = new AssDoc(doc.serialize());
  const parsed = K.analyzeKaraoke(reload);
  const reloadedRow = K.pairRows(parsed.sentences, parsed.wordStyle).find(r => r.speaker === '[NEW]');
  assert.equal(reloadedRow?.color, expected, 'imported role color survives save/reload, including green');
  assert.ok(reload.events.some(e => e.text.includes('导入字幕')), 'Chinese events survive serialization');
  assert.ok(reload.events.some(e => e.text.includes('fresh')), 'English events survive serialization');
  assert.ok(calls.indexOf('clear-edit') < calls.indexOf('rebuild'), 'stale edit preview is canceled before rebuilding');
  assert.equal(ctx.pendingPlaybackRows.size, 0, 'deferred old rows cannot overwrite the final track');
}
await run(true);
await run(false);
await run(true, '#00ff00');
await run(false, '#00ff00');
await run(true, '#00ff00', [{ name: 'NEW', color: '#123abc' }]);
{
  // Empty Events followed by another section: append inside Events and keep style offsets valid.
  const doc = new AssDoc('[Script Info]\nScriptType: v4.00+\n[Events]\n'
    + 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n; keep comment\n'
    + '[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,32\n');
  const ev = doc.appendEvent({ start: 1, end: 2, style: 'Default', text: 'new event' });
  assert.ok(ev);
  doc.setStyleFields('Default', { fontsize: 40 });
  let reloaded = new AssDoc(doc.serialize());
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.events[0].text, 'new event');
  assert.equal(reloaded.getStyle('Default').fontsize, '40', 'later style records keep their line indices');
  assert.ok(doc.serialize().includes('; keep comment'));
  doc.deleteEvents([ev]);
  const next = doc.appendEvent({ start: 3, end: 4, style: 'Default', text: 'replacement' });
  doc.setEventText(next, 'fresh replacement');
  assert.throws(() => doc.setEventText(ev, 'stale'), /失效/, 'deleted references cannot overwrite appended events');
  reloaded = new AssDoc(doc.serialize());
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.events[0].text, 'fresh replacement');
}
{
  const timeline = Object.create(Timeline.prototype);
  Object.assign(timeline, { _enterSprites: {}, _enterRects: [{}], _enterSpriteKey: 'old',
    _lanesRev: 1, _blockEnterArmed: false, _viewFromLanes: true, _refreshRange: () => false });
  timeline.setLanes([{ label: 'fresh', cues: [{ start: 1, end: 3 }] }]);
  assert.equal(timeline._enterSprites, null, 'new lanes discard stale entrance sprites');
  assert.equal(timeline._enterRects, null);
}
console.log('region-import-refresh: full replacement, bilingual/word/color data, final renderer update, stale preview cancellation and timeline cache passed');
