import assert from 'node:assert/strict';
import { initProjects } from '../editor/js/project.js';

const elements = new Map();
function element() {
  return { hidden: true, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    setAttribute() {}, removeAttribute() {}, focus() {}, appendChild() {}, replaceChildren() {} };
}
globalThis.document = { querySelector: selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
  querySelectorAll: () => [], getElementById: id => document.querySelector('#' + id), body: element(), createElement: element, addEventListener() {} };
globalThis.window = { addEventListener() {} };
globalThis.location = { hash: '#/project/A' };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.history = { replaceState() {}, back() {} };
globalThis.requestAnimationFrame = () => {};
const state = { project: null, format: 'srt', srtCues: [] };
let text = '', putCalls = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pending = new Map();
const subtitle = id => `1\n00:00:00,000 --> 00:00:02,000\n${id}\n`;
const rev = 'a'.repeat(64);
globalThis.fetch = async (url, opts = {}) => {
  if (opts.method === 'PUT') { putCalls.push({ url, body: opts.body }); const wait = pending.get('save'); if (wait) await wait.promise;
    return Response.json({ savedAt: 'now', revision: rev }); }
  const id = /\/api\/projects\/([^/]+)/.exec(url)?.[1];
  if (url.endsWith('/subtitle')) {
    const wait = pending.get(id); if (wait) return wait.promise;
    return new Response(subtitle(id), { headers: { ETag: '"' + rev + '"' } });
  }
  if (url.endsWith('/peaks')) { const wait = pending.get('peaks'); if (wait) return wait.promise; return new Response('', { status: 404 }); }
  return Response.json({ id, name: id, subtitle: { file: 'subtitle.srt' }, prepare: { status: 'none' }, videoExists: false });
};
let peakCalls = 0;
const api = initProjects({ state, video: { pause() {} }, timeline: { setPeaks() { peakCalls++; } }, panel: { showConfirm() {} }, toast() {},
  routeSub(value) { text = value; state.srtCues = [{ start: 0, end: 2, lines: [value.split('\n')[2]] }]; },
  loadVideoUrl() {}, setPlaybackAudioMode() {} });
await api.openProject('A'); assert.equal(state.project.id, 'A');
const old = state.project;
pending.set('B', deferred()); const b = api.openProject('B');
await new Promise(r => setTimeout(r, 5));
pending.get('B').resolve(new Response('error', { status: 500 })); await b;
assert.equal(state.project, old); assert.equal(text, subtitle('A'));
pending.set('B', deferred()); const late = api.openProject('B');
await new Promise(r => setTimeout(r, 5)); await api.openProject('C');
pending.get('B').resolve(new Response(subtitle('B'))); await late;
assert.equal(state.project.id, 'C'); assert.equal(text, subtitle('C'));
pending.set('D', deferred()); const d = api.openProject('D');
await new Promise(r => setTimeout(r, 5)); api.detachProject();
pending.get('D').resolve(new Response(subtitle('D'))); await d; assert.equal(state.project, null);
await api.openProject('A'); pending.set('save', deferred());
state.srtCues[0].lines = ['human edit']; api.scheduleSave(); const saving = api.saveNow();
const switching = api.openProject('C'); await new Promise(r => setTimeout(r, 5));
assert.equal(state.project.id, 'A');
pending.get('save').resolve(); await saving; await switching;
assert.equal(state.project.id, 'C'); assert.ok(putCalls.at(-1).url.includes('/A/subtitle')); assert.ok(putCalls.at(-1).body.includes('human edit'));
pending.set('peaks', deferred()); const peaks = state.project.loadPeaks(); api.detachProject();
pending.get('peaks').resolve(new Response(new Uint8Array([1, 2]))); await peaks; assert.equal(peakCalls, 0);
console.log('repair05: A/B failure, rapid A/B/C, detach during load, save flush and stale peaks passed');
