// Exercise production async writeback/queue code with controlled network replies, without models or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
const asyncCode = source.slice(source.indexOf('let subtitleWriteGeneration ='), source.indexOf('/* ═══════════ 右下角进度卡'));
const at = source.indexOf('async function runRealign(');
const alignCode = source.slice(at, source.indexOf('\n}', at) + 2);
const fullAt = source.indexOf('async function applyRealignFull(');
const fullCode = source.slice(fullAt, source.indexOf('\n}', fullAt) + 2);
const marksAt = source.indexOf('function syncRealignFailureMarks(');
const marksCode = source.slice(marksAt, source.indexOf('\n}', marksAt) + 2);
const selectAt = source.indexOf('timeline.onSelect =');
const selectCode = source.slice(selectAt, source.indexOf('\n};', selectAt) + 3);
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

function fixture() {
  const posts = [], applied = [], notices = [];
  let interval = null, job = null, replyAlign;
  const rows = [0, 4, 8].map(start => ({ start, end: start + 3, l1: 'text ' + start, l2: '', ref: {} }));
  const ctx = vm.createContext({
    state: { project: { id: 'fixture' }, format: 'ass', assDoc: { replaceEvents() { return []; }, serialize() { return 'ass'; } }, items: rows,
      kar: { sentences: [{ key: 'sentence', text: 'hello', words: [], events: [] }] } },
    panel: { editItem: null }, window: {}, timeline: { reRecogRegion: null, lanes: [], touch() {} }, crypto: webcrypto, TextEncoder,
    realignFailureKeys: new Set(), selectItem() {},
    realignApplying: false, realignData: { items: [{ ok: true, start: 0, words: [] }], usable: 1, total: 1 },
    realignPicked: new Set([0]), realignEls: {}, syncRealignApply() {}, realignShow() {}, Projects: { scheduleSave() {} },
    applyRealignItems() { applied.push('full'); return { changed: 1, skipped: 0 }; },
    reRecogBusy: false, reflectApplying: false, realignBusy: false, realignRunningKey: '', realignQueue: [],
    setInterval(fn) { interval = fn; return 1; }, clearInterval() { interval = null; },
    setTimeout(fn) { return setTimeout(fn, 1); }, queueMicrotask, AbortSignal,
    jobCardShow(...args) { notices.push(args); }, jobCardDone(...args) { notices.push(args); }, toast(...args) { notices.push(args); },
    applyRecognized(a, b, segs) {
      applied.push({ a, b, segs });
      // Production reconciliation replaces row wrappers. Queued requests must still find unchanged rows.
      ctx.state.items = ctx.state.items.map(row => ({ ...row, ref: {} }));
      return segs.length;
    },
    refreshRealignTarget(target) { return target; }, realignTargetKey(sentence) { return sentence.key; },
    buildWordSpecs() { return []; }, reconcileKaraoke() {}, rebuildItemsAndLanes() { applied.push('align'); },
    assPlayer: { updateNow() {} }, logOp() {}, fmtTime: String,
    async fetch(url, options = {}) {
      if (url === '/api/translate/config') return { json: async () => ({ ready: true }) };
      if (url.endsWith('/realign')) return new Promise(resolve => { replyAlign = resolve; });
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        job = { status: 'running', start: posts.at(-1).start, end: posts.at(-1).end };
        return { ok: true, json: async () => ({}) };
      }
      return { json: async () => ({ job }) };
    },
  });
  ctx.state.itemByRef = new Map();
  rows[0].ref.en = ctx.state.kar.sentences[0];
  ctx.timeline.lanes = [{ cues: [{ ref: rows[0].ref }] }];
  vm.runInContext(asyncCode + '\n' + alignCode + '\n' + fullCode + '\n' + marksCode + '\n' + selectCode
    + '\n globalThis.api = { startRerecog, runRealign, applyRealignFull, syncRealignFailureMarks };', ctx);
  return { ctx, posts, applied, notices,
    tick() { assert.ok(interval, 'poll is scheduled'); return interval(); },
    done(status = 'done') { job = { ...job, status, segments: [{ start: job.start, end: job.end, text: 'recognized' }] }; },
    alignDone(ok = true) { replyAlign({ ok: true, json: async () => ({ blocks: [{ ok, words: [{ w: 'hello', s: 0, e: 1 }] }] }) }); },
  };
}

{
  const f = fixture(), { api, state, panel } = f.ctx;
  await api.startRerecog(0, 3, 'first', state.items[0].ref);
  await api.startRerecog(4, 7, 'second', state.items[1].ref);
  assert.equal(await api.startRerecog(4, 7, 'duplicate', state.items[1].ref), false);
  await settle();
  assert.equal(f.posts.length, 1, 'only one POST while first task runs');
  panel.editItem = { draft: 'uncommitted', caret: 3 };
  const editor = panel.editItem;
  f.done(); const completing = f.tick(); await settle();
  assert.equal(panel.editItem, editor, 'preserves active editor identity');
  assert.equal(f.applied.length, 0, 'finished result waits instead of committing a draft');
  assert.equal(f.posts.length, 1, 'queued task waits for previous writeback');
  panel.editItem = null; await completing; await settle();
  assert.equal(f.applied.length, 1);
  assert.equal(f.posts.length, 2, 'next row survives wrapper reconstruction and starts automatically');
  assert.equal(f.posts[1].start, 4);
  f.done(); await f.tick();
  assert.equal(f.applied.length, 2);
}
{
  const f = fixture(); await f.ctx.api.startRerecog(0, 3, 'changed'); await settle();
  f.ctx.panel.editItem = {};
  f.done(); const completing = f.tick(); await settle();
  f.ctx.state.items[0].l1 = 'user saved a new version';
  f.ctx.panel.editItem = null; await completing;
  assert.equal(f.applied.length, 0, 'does not replace a sentence edited during recognition');
  assert.ok(f.notices.some(args => String(args[0]).includes('已保留当前')));
}
{
  const f = fixture(); await f.ctx.api.startRerecog(0, 3, 'fail'); await f.ctx.api.startRerecog(8, 11, 'next'); await settle();
  f.done('error'); await f.tick(); await settle();
  assert.equal(f.posts.length, 2, 'failure releases queue');
  f.done(); await f.tick();
}
{
  const f = fixture(); await f.ctx.api.startRerecog(0, 3, 'switch'); await settle();
  f.ctx.panel.editItem = {}; f.done(); const completing = f.tick(); await settle();
  f.ctx.state.project = { id: 'other' }; f.ctx.panel.editItem = null; await completing;
  assert.equal(f.applied.length, 0, 'late output cannot mutate another project');
}
{
  const f = fixture(), { api, panel, state } = f.ctx;
  const work = api.runRealign({ pid: 'fixture', key: 'sentence', text: 'hello', start: 0, end: 3, no: 1 });
  panel.editItem = { draft: 'typing' }; const editor = panel.editItem;
  f.alignDone(); await settle();
  assert.equal(panel.editItem, editor);
  assert.equal(f.applied.length, 0, 'word realignment also waits for input');
  assert.equal(state.kar.sentences[0].words.length, 0);
  panel.editItem = null; await work;
  assert.equal(state.kar.sentences[0].words.length, 1);
  assert.equal(f.applied.length, 1);
}
{
  const f = fixture();
  f.ctx.panel.editItem = { draft: 'full alignment draft' }; const editor = f.ctx.panel.editItem;
  const work = f.ctx.api.applyRealignFull(); await settle();
  assert.equal(f.ctx.panel.editItem, editor);
  assert.equal(f.applied.length, 0, 'full alignment also defers writes');
  f.ctx.panel.editItem = null; await work;
  assert.ok(f.applied.includes('full'));
}
{
  const f = fixture(); await f.ctx.api.startRerecog(0, 3, 'video editor'); await settle();
  f.ctx.window.__videoEditor = { isOpen: true }; f.done(); const work = f.tick(); await settle();
  assert.equal(f.applied.length, 0, 'video subtitle editor also protects its draft');
  f.ctx.window.__videoEditor.isOpen = false; await work;
  assert.equal(f.applied.length, 1);
}
{
  const f = fixture();
  const work = f.ctx.api.runRealign({ pid: 'fixture', key: 'sentence', text: 'hello', start: 0, end: 3, no: 1 });
  f.ctx.panel.editItem = {}; f.alignDone(); await settle();
  f.ctx.state.kar.sentences[0].key = 'edited sentence'; f.ctx.panel.editItem = null; await work;
  assert.equal(f.applied.length, 0, 'stale word alignment cannot replace a user-edited target');
}
{
  const f = fixture(), target = { pid: 'fixture', key: 'sentence', text: 'hello', start: 0, end: 3, no: 1, markFailure: true };
  const failed = f.ctx.api.runRealign(target); f.alignDone(false); await failed;
  assert.equal(f.ctx.timeline.lanes[0].cues[0].realignFailed, true, 'timeline-origin failure marks the target');
  const rebuilt = { en: { key: 'sentence' } };
  f.ctx.timeline.lanes = [{ cues: [{ ref: rebuilt }, { ref: { en: { key: 'other' } } }] }];
  f.ctx.api.syncRealignFailureMarks();
  assert.equal(f.ctx.timeline.lanes[0].cues[0].realignFailed, true, 'failure survives rebuilt row objects');
  f.ctx.timeline.onSelect(f.ctx.timeline.lanes[0].cues[1].ref);
  assert.equal(f.ctx.timeline.lanes[0].cues[0].realignFailed, true, 'another block does not acknowledge this failure');
  f.ctx.timeline.onSelect(rebuilt);
  assert.equal(f.ctx.timeline.lanes[0].cues[0].realignFailed, false, 'clicking even an already-selected target clears its mark');
  f.ctx.realignFailureKeys.add('sentence');
  const retry = f.ctx.api.runRealign(target); f.alignDone(); await retry;
  assert.equal(f.ctx.realignFailureKeys.has('sentence'), false, 'successful retry clears prior failure');
}
{
  const f = fixture();
  const work = f.ctx.api.runRealign({ pid: 'fixture', key: 'sentence', text: 'hello', start: 0, end: 3, no: 1 });
  f.alignDone(false); await work;
  assert.equal(f.ctx.realignFailureKeys.size, 0, 'list-origin failure does not add timeline-only acknowledgements');
}
console.log('Background subtitle writeback and realignment failure acknowledgement passed');
