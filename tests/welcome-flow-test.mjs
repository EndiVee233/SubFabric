import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../editor/js/project.js', import.meta.url), 'utf8');
const start = source.indexOf("  const welcomeView = $('#welcome-view');");
const end = source.indexOf('  /** 设置页的「加速方式」卡', start);
assert.ok(start > 0 && end > start);
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    hidden: false, disabled: false, checked: false, dataset: {}, innerHTML: '', textContent: '',
    scrollTop: 500, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, querySelector() { return null; }, focus() { this.focused = true; },
    parentNode: null, appendChild(child) { child.parentNode = this; },
    listeners: new Map(), addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler); this.listeners.set(type, handlers);
    },
  });
  return elements.get(selector);
}
let requests = [];
let saveFails = false;
let deferredStatus = null;
const timers = new Map();
let timerId = 0;
const storage = new Map();
const openedParams = [];
const catalog = element('#sf-asr-catalog');
element('#sf-asr-home').appendChild(catalog);
const sandbox = {
  $: element, welcomeBlocking: false, welcomeHardware: null, welcomeBusy: false,
  welcomeFirstRun: true, welcomeReturnHash: '', WELCOME_KEY: 'sf-welcome-v1',
  document: { body: element('body'), documentElement: element('html') },
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  AbortSignal, location: { hash: '#/dashboard' },
  localStorage: { setItem(k, v) { storage.set(k, v); } },
  storedWelcome: () => null, visibleModels: () => [], welcomeRecommendations: () => [],
  gpuMemoryText: gpu => gpu.name,
  escapeHtml: value => String(value),
  applyHash() {}, refreshAsrStatus() {}, loadSettings() {}, renderAsrModels() {}, toast() {},
  asrRenderGeneration: 0, selectedAsrFamily: '', pythonPollTimer: 0, _modelPolling: false,
  showAsrFamily(family) { sandbox.selectedAsrFamily = family; }, bindModelDirSettings() {},
  openAsrParamsDialog(model) { openedParams.push(model); },
  genAsr: null, latestAsrStatus: null,
  fetch: async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.startsWith('/api/asr/hardware')) return { ok: true, json: async () => ({ ok: true,
      cuda: { available: true, device: 'RTX' }, vulkan: { available: true, devices: ['AMD'] } }) };
    if (url === '/api/asr/backends') return { ok: !saveFails, json: async () => saveFails ? { error: 'save failed' } : { ok: true } };
    if (deferredStatus) return deferredStatus;
    return { ok: true, json: async () => ({ models: [], downloads: [{ key: 'runtime:qwen', running: true }] }) };
  },
};
vm.createContext(sandbox);
const paramsStart = source.indexOf('function initAsrParams()');
const paramsEnd = source.indexOf('\n/* ──', paramsStart);
assert.ok(paramsStart > 0 && paramsEnd > paramsStart);
vm.runInContext(source.slice(paramsStart, paramsEnd), sandbox);
vm.runInContext(source.slice(start, end), sandbox);
const run = expression => vm.runInContext(expression, sandbox);
const settle = () => new Promise(resolve => setImmediate(resolve));

run('welcomeShow({firstRun:true})');
await settle();
assert.equal(run('welcomeStep'), 1);
assert.equal(element('#welcome-prep').hidden, true, 'downloads are not on first page');
assert.equal(element('#welcome-cards').hidden, false);
assert.equal(element('#welcome-go').hidden, true);
assert.equal(element('#welcome-next').hidden, false);
assert.equal(element('#welcome-next').disabled, false);
assert.equal(requests.filter(r => r.url === '/api/asr/status').length, 0, 'preparation is loaded only after Next');
await run('welcomeContinue()');
assert.equal(requests.some(r => r.url === '/api/asr/backends'), false, 'cannot skip the download step');

run('welcomeCuda.checked=false; welcomeVulkan.checked=false; welcomeSyncSelection(); welcomeAdvance()');
assert.equal(run('welcomeStep'), 1, 'no backend blocks Next');
assert.equal(element('#welcome-next').disabled, true);
run('welcomeCuda.checked=true; welcomeSyncSelection(); welcomeAdvance()');
await settle();
assert.equal(run('welcomeStep'), 2);
assert.equal(element('#welcome-cards').hidden, true);
assert.equal(element('#welcome-prep').hidden, false);
assert.equal(element('#welcome-go').hidden, false);
assert.equal(element('#welcome-next').hidden, true);
assert.equal(element('#welcome-back').hidden, false);
assert.equal(catalog.parentNode, element('#welcome-asr-mount'), 'step two moves the original settings catalog');
assert.equal(catalog.listeners.get('click').length, 1, 'parameter actions are delegated on the moving catalog');
catalog.listeners.get('click')[0]({ target: { closest: () => ({ dataset: { id: 'test-model' } }) }, preventDefault() {} });
assert.deepEqual(openedParams, ['test-model']);
assert.match(element('#welcome-step').textContent, /2 \/ 2/);
assert.match(element('#welcome-title').innerHTML, /下载模型/);
assert.equal(requests.some(r => r.body), false, 'Next does not start downloads or persist settings');
assert.ok(timers.size > 0, 'active downloads schedule polling');

run('welcomePrevious()');
assert.equal(run('welcomeStep'), 1);
assert.equal(element('#welcome-cuda').checked, true, 'Back keeps the backend choice');
assert.equal(element('#welcome-prep').hidden, true);
assert.equal(catalog.parentNode, element('#sf-asr-home'), 'Back restores the same catalog, without cloning');
assert.equal(timers.has(run('welcomePrepTimer')), false, 'Back cancels the preparation poll timer');
assert.equal(element('#welcome-view').scrollTop, 0, 'step changes return to top');

let resolveStatus;
deferredStatus = new Promise(resolve => { resolveStatus = resolve; });
run('welcomeAdvance()');
run('welcomePrevious()');
resolveStatus({ ok: true, json: async () => ({ marker: 'late', models: [], downloads: [] }) });
await settle();
assert.notEqual(run('welcomePrepStatus?.marker'), 'late', 'late responses cannot re-open or update the previous step');
deferredStatus = null;

run('welcomeVulkan.checked=true; welcomeAdvance()');
await settle();
saveFails = true;
await run('welcomeContinue()');
assert.equal(run('welcomeStep'), 2);
assert.equal(sandbox.welcomeBlocking, true);
assert.match(element('#welcome-alert').textContent, /save failed/);
assert.equal(element('#welcome-back').disabled, false);
saveFails = false;
await run('welcomeContinue()');
assert.equal(sandbox.welcomeBlocking, false);
assert.equal(element('#welcome-view').hidden, true);
assert.equal(catalog.parentNode, element('#sf-asr-home'), 'completion restores the settings controls');
assert.deepEqual(JSON.parse(storage.get('sf-welcome-v1')).cuda, true);
assert.equal(requests.at(-1).url, '/api/asr/backends');
assert.deepEqual(requests.at(-1).body, { cuda: true, vulkan: true });

requests = [];
run('welcomeShow({firstRun:false})');
await settle();
assert.equal(run('welcomeStep'), 1, 'reopening always starts at the backend step');
assert.equal(catalog.listeners.get('click').length, 1, 'moving the catalog does not duplicate parameter listeners');
assert.equal(element('#welcome-cancel').hidden, false);
assert.equal(requests.some(r => r.url === '/api/asr/status'), false);
run('welcomeHide()');
const html = fs.readFileSync(new URL('../editor/studio.html', import.meta.url), 'utf8');
assert.match(html, /id="welcome-prep"[^>]*hidden/);
assert.match(html, /id="welcome-go"[^>]*hidden/);
assert.match(source, /welcomeNext\?\.addEventListener\('click', welcomeAdvance\)/);
assert.match(source, /welcomeBack\?\.addEventListener\('click', welcomePrevious\)/);
console.log('welcome-flow-test: ok (two steps, gating, Back, deferred status, save failure/success, reopen)');
