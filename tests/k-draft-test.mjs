// Draft creation options -> real writer -> editor parse/serialize, without ASR/models/network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { serverFunctions } from './helpers/server-functions.mjs';
import { AssDoc } from '../editor/js/ass.js';
import { analyzeKaraoke, buildWordSpecs, hasDraftColorSlices, pairRows, parseKLine, restartsColorCue, splitEnglishWords } from '../editor/js/karaoke.js';
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
  const { startDraftForExisting } = serverFunctions(['startDraftForExisting','assertProjectWritable'], {
    collabOwns: () => false,
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
function write(segments, sweep = false, style = 'k', opts, translated = true) {
  const files = new Map(), logs = [];
  let meta = { id: 'p-write', draft: { modelId: 'fixture', karaokeStyle: style, karaokeSweep: sweep, karaokeBase: '#FFFFFF' } };
  const { writeSubtitle } = serverFunctions(['writeSubtitle','assertProjectWritable','assHeader','wordKLine','wordSliceLine','confidenceMeta',
    'withConfidence','fmtAssTime','fmtSrtTime','hexToAssBgr','assColorFromRgb'], {
    collabOwns: () => false,
    path, fs: { writeFileSync: (p,t) => files.set(p,t), renameSync: (a,b) => { files.set(b,files.get(a)); files.delete(a); } },
    readMeta: () => meta, writeMeta: x => { meta = x; }, readSavedWordColor: () => null,
    modelById: () => ({ name: 'Fixture', engine: 'test' }), projDir: () => '/isolated',
    llmText: { normalizeZhPunctuation: x => x }, cast: { roleNameFor: (_map,n) => 'SPK' + n },
    ROLE_PALETTE: ['#ff0000'], kLine, escAss: kLine.escAss, realignWordsMod,
    pushDraftLog: (_id, line) => logs.push(line),
  });
  const segs = structuredClone(segments);
  const info = writeSubtitle('p-write', true, segs, translated ? segs.map(() => '中文字幕') : null, opts);
  return { text: files.get(path.join('/isolated', info.file)), logs };
}
const seg = (words, start=0) => ({ start, end: start + words.length, text: words.join(' '),
  words: words.map((word,i) => ({ word, start: start+i, end: start+i+1 })) });
{
  const left = seg(['almost', 'ready', 'to', 'post', 'it.'], 1);
  left.end = 2;
  [1, 1.4, 1.97, 1.97, 1.98].forEach((start, i) => { left.words[i].start = start; });
  left.words.at(-1).end = 2;
  const right = seg(['next', 'sentence.'], 2);
  right.words[0].start = 1.97;
  for (const style of ['k', 'color']) {
    const { text } = write([left, right], false, style, { tail: 0.15 });
    const kar = analyzeKaraoke(new AssDoc(text));
    const rows = pairRows(kar.sentences, kar.wordStyle);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.en.words.map(w => w.w)), [left, right].map(s => s.words.map(w => w.word)));
    assert.deepEqual(rows[0].en.words.map(w => [w.s, w.e]), [
      [1, 1.4], [1.4, 1.97], [1.97, 1.98], [1.98, 1.99], [1.99, 2],
    ]);
    assert.equal(rows[1].en.words[0].s, 2, 'the next cue keeps the segmented boundary');
    assert.equal(rows[0].zh.end, rows[1].zh.start, 'translation cues have the same boundaries as the English');
    assert.equal(rows[0].en.events.at(-1).end, rows[0].zh.end);
  }
}
{
  const short = { ...seg(['two', 'words']), end: 0.01,
    words: [{ word: 'two', start: 0, end: 0.005 }, { word: 'words', start: 0.005, end: 0.01 }] };
  const regular = seg(['there', 'are', 'more', 'words', 'here.'], 2);
  const { text } = write([short, regular], false, 'color');
  const doc = new AssDoc(text);
  assert.equal(doc.events.find(e => e.style === 'Default').text, 'two words');
  assert.ok(doc.events.every(e => e.end > e.start));
}
assert.deepEqual(splitEnglishWords('At 26,000 views and 3.75 percent, views.24'),
  ['At', '26,000', 'views', 'and', '3.75', 'percent,', 'views.', '24']);
{
  const source = [seg(['this', 'one', 'ends.']), seg(['it', 'repeats.'], 3), seg(['it', 'repeats.'], 5)];
  const { text } = write(source, false, 'color', { tail: 0.15 }, false);
  assert.deepEqual(analyzeKaraoke(new AssDoc(text)).sentences.map(s => s.text), source.map(s => s.text),
    'an English-only draft keeps adjacent cues separate, including repeated text');
  const { subtitleSource } = serverFunctions(['subtitleSource'], {
    fs: { existsSync: () => true, readFileSync: () => text }, AssDoc,
    readMeta: () => ({ subtitle: { file: 'subtitle.ass' } }), safeProjectFile: () => '/isolated/subtitle.ass',
    subtitleRevision: () => 'revision', karaokeMod: { hasDraftColorSlices, restartsColorCue },
    assSentencesMod: require('../editor/ass-sentences.js'),
  });
  assert.equal(subtitleSource('p-write').rows.length, source.length, 'translation also receives each repeated cue separately');
}
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
  const html = fs.readFileSync(new URL('../tools/templates/studio.html',import.meta.url),'utf8');
  const colorDrafts = ui.match(/\b(payload0?)\.karaokeStyle = 'color'/g) || [];
  assert.equal(colorDrafts.length, 3, 'local, link and batch drafts explicitly use color word highlighting');
  assert.doesNotMatch(ui, /sf-k-style|\bautoPost\s*[:=]/, 'draft creation cannot use the previous karaoke style or enable automatic realignment');
  assert.doesNotMatch(html, /id="(?:np-kstyle|np-autopost|batch-autopost)"/);
}
const swept=kLine.wordKText([{word:'hello',start:0,end:1}],0,1,'00FF00','FFFFFF','\\kf');
assert.equal(parseKLine(swept,0,1).kTag,'\\kf');
console.log('k-draft: link/batch settings, short/long draft generation, sweep, untimed text and editor reload passed');
