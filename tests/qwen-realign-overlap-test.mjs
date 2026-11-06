import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AssDoc, assPlainText } from '../editor/js/ass.js';
import { analyzeKaraoke, applyRealignItems, buildWordSpecs, realignTargetKey } from '../editor/js/karaoke.js';

const require = createRequire(import.meta.url);
const { planBatches, assignChunkWords } = require('../editor/realign-batch.js');
const tokens = Array.from({ length: 24 }, (_, i) => 'token' + i);
const task = (id, start, end, words = tokens) => ({ id, start, end, from: start - .2, to: end + .2, text: words.join(' ') });
const head = '[Script Info]\n; SubFabricWordStyle: English\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize\nStyle: English,Arial,40\nStyle: Chinese,Arial,40\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n';
function fixture(kind = 'color', words = tokens) {
  const sent = { style: 'English', start: 10, end: 14, text: words.join(' '), karStyle: kind,
    highlightTag: '{\\c&H00FF00&}', kTag: '\\kf', kBaseHex: '#ffffff',
    proto: { layer: '0', name: 'Alice', effect: 'fx', margins: { marginl: '1', marginr: '2', marginv: '3' } },
    words: words.map((w, i) => ({ w, s: 10 + i * 4 / words.length, e: 10 + (i + 1) * 4 / words.length })) };
  const doc = new AssDoc(head + 'Dialogue: 0,0:00:10.00,0:00:14.00,Chinese,Alice,0,0,0,,测试句\n');
  for (const spec of buildWordSpecs(sent)) doc.appendEvent(spec);
  return doc;
}
function assign(tasks, rec) {
  const batches = planBatches(tasks);
  return assignChunkWords(batches, new Map([[batches[0].id, rec]]));
}
const collapsed = tokens.map(word => ({ word, start: 12, end: 12.003 }));
const bad = assign([task(0, 10, 14)], collapsed).get(0);
assert.equal(bad.ok, false, '24 identical Qwen timestamps must not become a successful 157ms cluster');
assert.deepEqual(bad.words, [], 'unusable timing must not be offered for writeback');

// A bad row must not discard another healthy row in the same model batch.
const goodTokens = ['healthy', 'neighbor'];
const mixed = assign([task(0, 10, 14), task(1, 14, 16, goodTokens)], [
  ...collapsed, { word: 'healthy', start: 14.1, end: 14.7 }, { word: 'neighbor', start: 14.8, end: 15.8 },
]);
assert.equal(mixed.get(0).ok, false);
assert.equal(mixed.get(1).ok, true);
assert.deepEqual(mixed.get(1).words, [{ w: 'healthy', s: 14.1, e: 14.7 }, { w: 'neighbor', s: 14.8, e: 15.8 }]);

// Slightly overlapping model intervals retain all tokens, with final ASS-safe bounds.
const phrase = ['one', 'two', 'three', 'four'];
const measurements = [
  { word: 'one', start: 10.1, end: 10.4 },
  { word: 'two', start: 10.39, end: 10.7 },
  { word: 'three', start: 10.72, end: 10.723 },
  { word: 'four', start: 10.73, end: 11.2 },
];
const healthy = assign([task(0, 10, 14, phrase)], measurements).get(0);
assert.equal(healthy.ok, true);
function checkWords(words) {
  for (let i = 0; i < words.length; i++) {
    const s = Math.round(words[i].s * 100), e = Math.round(words[i].e * 100);
    assert.ok(e > s, 'each word survives ASS centisecond serialization');
    if (i) assert.ok(s >= Math.round(words[i - 1].e * 100), 'word intervals never overlap');
  }
}
checkWords(healthy.words);
assert.deepEqual(healthy.words.map(w => w.w), phrase);
assert.ok(healthy.words[0].s >= 10.1 && healthy.words.at(-1).e <= 11.2, 'repair stays within measured speech span');

for (const kind of ['color', 'k']) {
  const doc = fixture(kind, phrase), kar = analyzeKaraoke(doc), sent = kar.sentences.find(s => s.words.length);
  const proposal = { projectId: 'p', targetKey: realignTargetKey(sent), text: sent.text,
    start: sent.start, end: sent.end, words: healthy.words };
  assert.equal(applyRealignItems(doc, kar, [proposal], { projectId: 'p' }).changed, 1);
  const reloaded = new AssDoc(doc.serialize()), after = analyzeKaraoke(reloaded).sentences.find(s => s.words.length);
  assert.equal(after.text, phrase.join(' '));
  assert.deepEqual(after.words.map(w => w.w), phrase);
  checkWords(after.words);
  assert.deepEqual([after.start, after.end], [10, 14]);
  assert.ok(after.events.every(e => assPlainText(e.text) === phrase.join(' ') && e.name === 'Alice'));
  if (kind === 'color') {
    const events = after.events.slice().sort((a,b) => a.start - b.start);
    assert.ok(events.every((e,i) => e.end > e.start && (!i || e.start >= events[i-1].end)), 'no stacked or zero-length color slices');
  } else assert.equal(after.kTag, '\\kf');

  // Already queued/stale model proposals must also pass the writeback guard.
  for (const invalid of [
    [{ w:'one',s:10,e:11 },{ w:'two',s:10.5,e:12 },{ w:'three',s:12,e:13 },{ w:'four',s:13,e:14 }],
    [{ w:'one',s:10,e:10.003 },{ w:'two',s:10.003,e:10.004 },{ w:'three',s:10.004,e:10.005 },{ w:'four',s:10.005,e:14 }],
  ]) {
    const fresh = fixture(kind,phrase), current = analyzeKaraoke(fresh), target = current.sentences.find(s => s.words.length), before = fresh.serialize();
    const result = applyRealignItems(fresh, current, [{ ...proposal, targetKey: realignTargetKey(target), words: invalid }], { projectId:'p' });
    assert.equal(result.changed,0,'overlapping or collapsed results cannot replace existing timing');
    assert.equal(fresh.serialize(),before,'failed result preserves original subtitle bytes');
  }
}
console.log('qwen-realign-overlap: collapsed timestamps rejected per row, ASS-safe repair and k/color writeback/reload passed');
