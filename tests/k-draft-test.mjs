// Draft creation options -> real writer -> editor parse/serialize, without ASR/models/network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { serverFunctions } from './helpers/server-functions.mjs';
import { AssDoc } from '../editor/js/ass.js';
import { analyzeKaraoke, buildWordSpecs, parseKLine } from '../editor/js/karaoke.js';
import * as realignWordsMod from '../editor/realign-words.js';
const require = createRequire(import.meta.url), kLine = require('../editor/k-line.js');
const source = fs.readFileSync(new URL('../editor/server.js', import.meta.url), 'utf8');
const { draftKaraokeOptions } = serverFunctions(['draftKaraokeOptions']);
const options = { karaokeStyle: 'k', karaokeSweep: true, karaokeBase: '#123abc' };
assert.deepEqual(JSON.parse(JSON.stringify(draftKaraokeOptions(options, true))), {
  karaokeStyle: 'k', karaokeSweep: true, karaokeBase: '#123ABC',
});
assert.equal(draftKaraokeOptions(options, false).karaokeStyle, 'color');
assert.equal(draftKaraokeOptions(options, false).karaokeSweep, false);
assert.equal(draftKaraokeOptions({ karaokeStyle: 'invalid', karaokeBase: 'bad' }, true).karaokeBase, '#FFFFFF');

// Execute the actual link-create branch: no download or model worker is started.
{
  let saved, response;
  const a = source.indexOf('      const fetchUrl = normalizeFetchUrl('), b = source.indexOf('      const vpRaw =', a);
  assert.ok(a > 0 && b > a);
  const ctx = { data: { draft: true, fetch: { url: 'https://www.youtube.com/watch?v=fixture' }, ...options },
    normalizeFetchUrl: x => x, fetchSiteOf: () => 'youtube', fetchReady: () => true,
    modelById: () => ({ id: 'fixture', engine: 'test' }), resolveAsrModel: () => ({ id: 'fixture' }), draftAllowedOf: () => true,
    projDir: id => '/isolated/' + id, fs: { mkdirSync() {} }, draftOutputPlan: async () => ({ wordLevel: true, align: false }),
    draftKaraokeOptions, FETCH_STAGE: 'fetch', writeMeta: m => { saved = m; }, readMeta: () => saved,
    metaView: x => x, pushDraftLog() {}, normalizePart: () => 1, startFetchJob: async () => {}, finishDraft() {},
    res: {}, sendJson: (_res, status, data) => { response = { status, data }; } };
  await vm.runInNewContext('(async()=>{' + source.slice(a,b) + '})()', ctx);
  assert.equal(response.status, 200);
  assert.equal(saved.draft.karaokeStyle, 'k', 'link draft keeps the selected karaoke style');
  assert.equal(saved.draft.karaokeSweep, true, 'link draft keeps sweep');
  assert.equal(saved.draft.karaokeBase, '#123ABC', 'link draft keeps unsung color');
}
// Existing-project batch start uses the same normalization rather than resetting sweep/base.
{
  let meta = { id: 'p-existing', video: { path: '/isolated/video.mp4' }, prepare: { status: 'done' } };
  const { startDraftForExisting } = serverFunctions(['startDraftForExisting'], {
    readMeta: () => meta, writeMeta: x => { meta = x; }, fs: { existsSync: () => true }, path,
    projDir: () => '/isolated', modelById: () => ({ id: 'fixture', name: 'fixture' }), resolveAsrModel: () => ({ id: 'fixture' }),
    draftAllowedOf: () => true, draftOutputPlan: async () => ({ wordLevel: true, align: false }), draftKaraokeOptions,
    STAGE: { extract: 'extract' }, CONFIDENCE_MODES: ['full'], pendingAsr: new Map(), pushDraftLog() {},
    safeDraftStep: (_id, fn) => fn(), startDraftAsr() {}, startPrepare() {},
  });
  await startDraftForExisting('p-existing', options);
  assert.equal(meta.draft.karaokeStyle, 'k'); assert.equal(meta.draft.karaokeSweep, true);
  assert.equal(meta.draft.karaokeBase, '#123ABC');
}
function write(segments, sweep = false, style = 'k') {
  const files = new Map(), logs = [];
  let meta = { id: 'p-write', draft: { modelId: 'fixture', karaokeStyle: style, karaokeSweep: sweep, karaokeBase: '#FFFFFF' } };
  const { writeSubtitle } = serverFunctions(['writeSubtitle','assHeader','wordKLine','wordSliceLine','confidenceMeta',
    'withConfidence','fmtAssTime','fmtSrtTime','hexToAssBgr','assColorFromRgb'], {
    path, fs: { writeFileSync: (p,t) => files.set(p,t), renameSync: (a,b) => { files.set(b,files.get(a)); files.delete(a); } },
    readMeta: () => meta, writeMeta: x => { meta = x; }, readSavedWordColor: () => null,
    modelById: () => ({ name: 'Fixture', engine: 'test' }), projDir: () => '/isolated',
    llmText: { normalizeZhPunctuation: x => x }, cast: { roleNameFor: (_map,n) => 'SPK' + n },
    ROLE_PALETTE: ['#ff0000'], kLine, escAss: kLine.escAss, realignWordsMod,
    pushDraftLog: (_id, line) => logs.push(line),
  });
  const segs = structuredClone(segments);
  const info = writeSubtitle('p-write', true, segs, segs.map(() => '中文字幕'));
  return { text: files.get(path.join('/isolated', info.file)), logs };
}
const seg = (words, start=0) => ({ start, end: start + words.length, text: words.join(' '),
  words: words.map((word,i) => ({ word, start: start+i, end: start+i+1 })) });
for (const sweep of [false,true]) for (const words of [['hello'], ['hello','world'], ['one','two','three','four','five','six','seven']]) {
  const { text, logs } = write([seg(words)], sweep), doc = new AssDoc(text), kar = analyzeKaraoke(doc);
  assert.ok(text.includes(sweep ? '{\\kf' : '{\\k'), 'even a short draft uses the selected karaoke tag');
  assert.equal(doc.getScriptInfoComment('SubFabricKaraokeStyle'), 'k');
  assert.equal(logs.length, 0, 'explicit k does not take the legacy six-slice fallback');
  const sentence = kar.sentences.find(s => s.karStyle === 'k');
  assert.ok(sentence); assert.equal(sentence.kTag, sweep ? '\\kf' : '\\k');
  assert.deepEqual(sentence.words.map(w=>w.w),words);
  assert.equal(doc.events.filter(e=>e.style==='Default').length,1,'one event per k sentence');
  const before = sentence.words.map(w=>[w.w,w.s,w.e]);
  doc.replaceEvents(sentence.events,buildWordSpecs(sentence));
  const reloaded = analyzeKaraoke(new AssDoc(doc.serialize())).sentences.find(s=>s.karStyle==='k');
  assert.deepEqual(reloaded.words.map(w=>[w.w,w.s,w.e]),before,'word timings survive rebuild/reload');
  assert.equal(reloaded.kTag,sweep?'\\kf':'\\k');
}
assert.ok(!write([seg(['hello','world'])],false,'color').text.includes('{\\k'),'legacy short color fallback remains');
{
  const external = new AssDoc(write([seg(['hello','world'])]).text.replace(/^; SubFabricWordStyle:.*\n/gm,''));
  external.deleteEvents(external.events.filter(e=>e.style!=='Default'));
  const short = analyzeKaraoke(new AssDoc(external.serialize())).sentences.find(s=>s.karStyle==='k');
  assert.ok(short,'a short single-language k file needs no SubFabric style metadata');
  assert.deepEqual(short.words.map(w=>w.w),['hello','world']);
}
{
  const noWords = { start: 0, end: 1, text: 'no timings', words: [] };
  assert.ok(write([noWords]).text.includes('no timings'),'no word timing never means lost text');
  const text = write([seg(['hello','world']),{...noWords,start:3,end:4}]).text;
  assert.ok(text.includes('{\\k') && text.includes('no timings'),'mixed timed/untimed rows keep both');
}
{
  const ui = fs.readFileSync(new URL('../editor/js/project.js',import.meta.url),'utf8');
  const fn = /^  function draftKaraokeSettings\([^\n]*\n[\s\S]*?^  }/m.exec(ui)?.[0]; assert.ok(fn);
  const storage = { getItem: key => ({'sf-k-style':'k','sf-k-sweep':'1','sf-k-base':'#abcdef'})[key] };
  const settings = vm.runInNewContext('('+fn+')', { localStorage: storage });
  assert.equal(settings().karaokeStyle,'k','batch follows remembered draft style');
  assert.equal(settings().karaokeSweep,true); assert.equal(settings().karaokeBase,'#abcdef');
  assert.equal(settings('color').karaokeStyle,'color','explicit current choice wins');
  const restricted = vm.runInNewContext('('+fn+')', { localStorage: { getItem() { throw Error('blocked'); } } });
  assert.equal(restricted('k').karaokeStyle,'k','unavailable storage does not discard current choice');
}
const swept=kLine.wordKText([{word:'hello',start:0,end:1}],0,1,'00FF00','FFFFFF','\\kf');
assert.equal(parseKLine(swept,0,1).kTag,'\\kf');
console.log('k-draft: link/batch settings, short/long draft generation, sweep, untimed text and editor reload passed');
