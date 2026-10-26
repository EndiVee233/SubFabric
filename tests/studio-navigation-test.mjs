import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseSRT, serializeSRT } from '../editor/js/srt.js';

// Exercise the production Studio module and initProjects together. HTML, events,
// storage, timers and API replies stay in memory; no service or user data is used.
// Optional probes remove one fix in an in-memory source copy to confirm this suite
// detects the prior behavior. Production files and import dependencies are untouched.
const probe = process.argv.find(arg => arg.startsWith('--probe='))?.slice(8) || '';
if (probe) {
  assert.ok(['initial-editor', 'upload-lock'].includes(probe), 'known regression probe');
  process.on('uncaughtException', error => { console.error('studio-navigation probe ' + probe + ': ' + error.message.split('\n')[0]); process.exit(1); });
}
async function loadProduction(name, transform = null) {
  const url = new URL('../editor/js/' + name, import.meta.url);
  if (!transform) return import(url.href);
  const original = fs.readFileSync(url, 'utf8');
  let source = transform(original);
  assert.notEqual(source, original, 'regression probe actually changes its in-memory copy');
  source = source.replace(/\bfrom\s+(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, relative) => 'from ' + quote + new URL(relative, url).href + quote);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g,
  (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const asyncErrors = [], eventJobs = new Set();
let fileDialog = null;
class Surface {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(listener => listener !== fn));
  }
  dispatchEvent(event) {
    if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true });
    for (const fn of this.listeners.get(event.type) || []) {
      try {
        const result = fn(event);
        if (result?.then) {
          eventJobs.add(result);
          result.catch(error => asyncErrors.push(error)).finally(() => eventJobs.delete(result));
        }
      } catch (error) { asyncErrors.push(error); }
    }
    return !event.defaultPrevented;
  }
}
class Element extends Surface {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.dataset = {}; this._class = ''; this._text = ''; this._html = '';
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.files = [];
    this.style = { setProperty(key, value) { this[key] = value; }, getPropertyValue(key) { return this[key] || ''; } };
    this.classList = {
      contains: name => this._class.split(/\s+/).includes(name),
      add: (...names) => { this._class = [...new Set([...this._class.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this._class = this._class.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, enabled) => {
        const on = enabled ?? !this.classList.contains(name); this.classList[on ? 'add' : 'remove'](name); return on;
      }
    };
  }
  get parentElement() { return this.parentNode; }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
  get className() { return this._class; }
  set className(value) { this._class = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this.replaceChildren(); this._html = String(value); parseHtml(this, this._html);
    if (this.tagName === 'SELECT') this.value = this.children.find(child => child.selected)?.value ?? this.children[0]?.value ?? '';
  }
  get options() { return this.querySelectorAll('option'); }
  get selectedIndex() { return this.tagName === 'SELECT' ? this.options.findIndex(option => option.value === this.value) : undefined; }
  set selectedIndex(index) { if (this.tagName === 'SELECT') this.value = this.options[index]?.value ?? ''; }
  setAttribute(key, value = '') {
    const text = decode(value); this.attributes.set(key, text);
    if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = text;
    else if (key === 'class') this.className = text;
    else if (['hidden', 'checked', 'disabled', 'selected'].includes(key)) this[key] = true;
    else if (key === 'style') for (const part of text.split(';')) {
      const colon = part.indexOf(':'); if (colon >= 0) this.style.setProperty(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    else this[key] = text;
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'hidden') this.hidden = false; }
  toggleAttribute(key, force) {
    const on = force ?? !this.attributes.has(key);
    if (on) this.setAttribute(key); else this.removeAttribute(key);
    return on;
  }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; children.forEach(child => this.appendChild(child)); }
  insertBefore(child, next) {
    if (child === next) return child;
    child.remove(); const index = next ? this.children.indexOf(next) : this.children.length;
    assert.ok(index >= 0, 'memory DOM insertion reference belongs to parent');
    this.children.splice(index, 0, child); child.parentNode = this; return child;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  prepend(child) { this.insertBefore(child, this.children[0] || null); }
  before(child) { this.parentNode.insertBefore(child, this); }
  after(child) { this.parentNode.insertBefore(child, this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null); }
  remove() {
    if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const attrs = [...part.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)];
      if (!attrs.every(([, key, a, b, c]) => {
        const actual = key.startsWith('data-') ? this.dataset[camel(key.slice(5))] : this.attributes.get(key) ?? this[key];
        return a === undefined && b === undefined && c === undefined ? actual !== undefined : String(actual) === (a ?? b ?? c);
      })) return false;
      const bare = part.replace(/\[[^\]]*\]/g, '');
      const id = /#([\w-]+)/.exec(bare), tag = /^[\w-]+/.exec(bare), classes = [...bare.matchAll(/\.([\w-]+)/g)];
      return (!id || this.id === id[1]) && (!tag || this.tagName === tag[0].toUpperCase())
        && classes.every(([, name]) => this.classList.contains(name));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const found = [];
    for (const branch of selector.split(',')) {
      const parts = branch.trim().split(/\s+/);
      const walk = node => { for (const child of node.children) {
        if (child.matches(parts.at(-1))) {
          let ancestor = child.parentNode, index = parts.length - 2;
          while (ancestor && index >= 0) { if (ancestor.matches(parts[index])) index--; ancestor = ancestor.parentNode; }
          if (index < 0 && !found.includes(child)) found.push(child);
        }
        walk(child);
      } };
      walk(this);
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { document.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 40 }; }
  scrollIntoView() {}
  click() {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'file' && !this.id && fileDialog) {
      this.files = [fileDialog]; queueMicrotask(() => this.dispatchEvent(new Event('change'))); return;
    }
    const event = new Event('click', { cancelable: true }); this.dispatchEvent(event);
    if (!event.defaultPrevented && this.tagName === 'A' && this.href?.startsWith('#')) location.hash = this.href;
  }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}
function parseHtml(root, source) {
  const stack = [root], voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  source = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const token of source.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) {
      const tag = /^<\/([^\s>]+)/.exec(token)?.[1].toUpperCase();
      const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index;
    } else if (token.startsWith('<') && !token.startsWith('<!')) {
      const tag = /^<([^\s/>]+)/.exec(token)?.[1]; if (!tag) continue;
      const child = new Element(tag);
      for (const [, key, a, b, c] of token.slice(tag.length + 1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(key, a ?? b ?? c ?? '');
      stack.at(-1).appendChild(child);
      if (!voids.has(tag.toLowerCase()) && !token.endsWith('/>')) stack.push(child);
    } else if (!token.startsWith('<')) stack.at(-1)._text += decode(token);
  }
}

const documentSurface = new Surface(), body = new Element('body'); body.className = 'sf-studio';
globalThis.document = Object.assign(documentSurface, { body, documentElement: new Element('html'), hidden: false,
  getElementById: id => body.querySelector('#' + id), querySelector: selector => body.querySelector(selector),
  querySelectorAll: selector => body.querySelectorAll(selector), createElement: tag => new Element(tag),
  createComment: text => { const node = new Element('#comment'); node.textContent = text; return node; } });
const html = fs.readFileSync(new URL('../editor/studio.html', import.meta.url), 'utf8');
parseHtml(body, /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)[1]);
const $ = id => { const node = document.getElementById(id); assert.ok(node, 'production control exists: ' + id); return node; };
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
globalThis.matchMedia = () => media;
globalThis.window = Object.assign(new Surface(), { matchMedia, SSAccent: { apply() {}, current: () => '#5c7560' } });
if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
let hash = '#/editor', historyBacks = 0;
globalThis.location = { get hash() { return hash; }, set hash(next) {
  if (next === hash) return; hash = next; queueMicrotask(() => window.dispatchEvent(new Event('hashchange')));
} };
globalThis.history = { replaceState(_state, _unused, route) { hash = route; }, back() { historyBacks++; } };
const storage = new Map();
// 返回用户：欢迎页已完成，否则 initProjects 会按首次启动拦截 applyHash。
storage.set('sf-welcome-v1', JSON.stringify({ done: true, cuda: true, vulkan: true }));
storage.set('sf-welcome-synced', '1');
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
let timerSequence = 0;
const timers = new Map(), frames = new Map();
globalThis.setTimeout = (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.setInterval = (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms, interval: true }); return id; };
globalThis.clearInterval = id => timers.delete(id);
globalThis.requestAnimationFrame = fn => { const id = ++timerSequence; frames.set(id, fn); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const requests = [], unexpected = [], toasts = [], created = [];
let schemes = [], schemeActive = '', schemeFailure = false, schemeConfirm = true;
let pythonProbeReady = false;
window.confirm = () => schemeConfirm;
const subtitle = serializeSRT([{ start: 0, end: 2, lines: ['Original subtitle'] }]);
const revision = 'a'.repeat(64);
let model = 'old-model', upload = null;
const json = data => Response.json(data);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, method: options.method || 'GET', body: options.body });
  if (url.startsWith('/api/upload-video?')) { assert.ok(upload, 'upload must be deliberately deferred'); return upload.promise; }
  if (url === '/api/projects' && options.method === 'POST') { created.push(JSON.parse(options.body)); return json({ id: 'created' }); }
  if (url === '/api/projects') return json({ projects: [] });
  if (url === '/api/projects/created') return json({ id: 'created', name: 'Original title', videoExists: false,
    subtitle: { file: 'subtitle.srt' }, prepare: { status: 'none' } });
  if (url === '/api/projects/created/subtitle') return new Response(subtitle, { headers: { ETag: '"' + revision + '"' } });
  if (url.startsWith('/api/projects/created/subtitle?') && options.method === 'PUT') {
    assert.equal(options.body, subtitle, 'leaving created project preserves canonical subtitle');
    assert.equal(new URL(url, 'http://memory.test').searchParams.get('revision'), revision, 'save retains loaded revision');
    return json({ revision, savedAt: '2026-10-13T00:00:00Z' });
  }
  if (url === '/api/asr/select-rerecog') return json({ok:true});
  if (url === '/api/asr/status') return json({ pythonProbe: pythonProbeReady ? {ok:false,msg:'Missing fixture Python'} : null, nemo: {ok:false,msg:'Missing fixture NeMo'}, vibevoice: {ok:false,cuda:true,vramMB:8188,msg:'Missing fixture bitsandbytes'}, diarize:{ready:false}, ready: true,
    // 返回用户：加速方式已配置，且硬件探测已在 status 里，避免 renderAsrModels 再打 /api/asr/hardware
    hardware: { cuda: { available: true, device: 'Fixture RTX' }, vulkan: { available: true, devices: ['Fixture RTX'] }, npu: { available: true, devices: ['Fixture NPU'] } },
    backends: { cuda: true, vulkan: true },
    selectedModel: 'cloud', models: [{ id: 'cloud', name: 'Fixture cloud', engine: 'bcut', ready: true, cloud: true }, { id:'vibevoice-asr-4bit', name:'Fixture VibeVoice', engine:'vibevoice', ready:false, usable:false, cloud:false, needRuntime:true, runtimeKey:'vibevoice', runtimeName:'VibeVoice CUDA 4bit', runtimeSizeMB:2200 }], downloads: [],
    aligners: [{ id:'qwen3-forced-aligner-0.6b-cuda', name:'Qwen3-ForcedAligner 0.6B（CUDA）', backend:'cuda', ready:false,
      filesOk:true, runtimeReady:false, needRuntime:true, runtimeKey:'runtime:qwen', runtimeName:'Qwen3 CUDA 运行时',
      missing:[], source:'独立对齐模型', desc:'fixture' },
    { id:'qwen3-forced-aligner-0.6b-vulkan', name:'Qwen3-ForcedAligner 0.6B（Vulkan）', backend:'vulkan', ready:false,
      filesOk:false, partial:true, missing:['qwen3-forced-aligner-0.6b-q8_0.gguf'], runtimeKey:'runtime:crispasr',
      runtimeName:'CrispASR', source:'独立对齐模型', desc:'fixture partial' }] });
  if (url === '/api/translate/config') return json({ ready: true, cfg: { provider: 'fixture', model },
    schemes, activeSchemeId:schemeActive,
    presets: [{ id: 'fixture', name: 'Fixture', model, baseUrl:'http://localhost:1234/v1' }], defaultPrompt: 'Fixture prompt' });
  if (url.startsWith('/api/translate/schemes')) {
    if (schemeFailure) return new Response(JSON.stringify({error:'Fixture save failure'}),{status:500});
    // GET 只读，绝不能走下面的"新建方案"分支；创建页进入时会读一次方案列表。
    if ((options.method || 'GET') === 'GET') return json({ schemes, activeSchemeId: schemeActive });
    if (url.endsWith('/test')) return json({ok:true,reply:'ok'});
    const payload = options.body ? JSON.parse(options.body) : {}, id=url.split('/')[4];
    if (url.endsWith('/activate')) schemeActive=id;
    else if (options.method === 'DELETE') { schemes=schemes.filter(item=>item.id!==id); if(schemeActive===id) schemeActive=''; }
    else {
      const saved={...schemes.find(item=>item.id===id),...payload,id:id||'scheme-'+(schemes.length+1),hasKey:!!payload.apiKey}; delete saved.apiKey;
      if (id) schemes=schemes.map(item=>item.id===id?saved:item); else schemes.push(saved);
      if(payload.activate) schemeActive=saved.id;
    }
    return json({schemes,activeSchemeId:schemeActive});
  }
  if (url === '/api/cast/config') return json({ enabled: true, prompt: 'Fixture cast' });
  if (url === '/api/asr/confidence') return json({ mode: 'full' });
  if (url === '/api/pick') return json({ fallback: true });
  const settingReads = new Set(['/api/fetch/settings', '/api/asr/correct', '/api/asr/perf/state', '/api/asr/hint', '/api/analyze/config', '/api/asr/dual']);
  if (settingReads.has(url)) return json({ cfg: {}, hint: {}, presets: [], ok: true });
  unexpected.push(url); throw Error('Unexpected mock API: ' + url);
};
async function settle() {
  for (let i = 0; i < 6; i++) { await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(asyncErrors, [], 'event handlers do not throw');
  const ready = [...frames.values()]; frames.clear(); ready.forEach(fn => fn(0));
}
async function navigate(route) { location.hash = route; await settle(); }
async function click(id) { $(id).click(); await settle(); }
async function runTimer(ms) {
  const due = [...timers].filter(([, timer]) => timer.ms === ms && !timer.interval);
  assert.ok(due.length, 'expected controlled ' + ms + 'ms timer');
  for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
  await settle();
}
function assertMaterials(message) {
  assert.equal($('np-name').value, 'Original title', message + ': title');
  assert.equal($('np-video-name').textContent, 'original.webm（浏览器选择）', message + ': selected video');
  assert.equal($('np-sub-name').textContent, 'original.srt', message + ': selected subtitle');
  assert.equal($('np-word').checked, false, message + ': project option');
}

// main.js deliberately skips applyHash for the historical direct #/editor boot.
// Import the real Studio adapter first, so a later test applyHash cannot hide that regression.
for (const name of ['studio-themes.js', 'studio-progress.js'])
  vm.runInThisContext(fs.readFileSync(new URL('../editor/js/' + name, import.meta.url), 'utf8'), { filename: name });
await loadProduction('studio.js', probe === 'initial-editor'
  ? source => source.replace(/window\.__sfStudio\.route\(route, null, ''\);/, '') : null);
assert.equal(document.body.dataset.workspace, 'editor', 'direct Studio #/editor initializes workspace without project routing');
assert.equal($('sf-nav').hidden, true, 'direct editor hides primary navigation');
assert.equal($('sf-topbar').hidden, true, 'direct editor hides application topbar');
assert.equal(Boolean($('ass-style-group').inert), false, 'direct editor style controls remain available');
if (probe !== 'initial-editor') {
  assert.equal($('app').classList.contains('is-editor-panels-entering'), true,
    'refreshing directly into the editor still starts the panel entrance');
}

// Media decoding may report an old time while a long-video seek is pending.
// Drive the real adapter events: the visible fill/time must follow input immediately.
const playerVideo = $('video'), playerRange = $('sf-seek-range'), playerBar = $('sf-seek');
const playerFrames = frames.size;
Object.assign(playerVideo, { duration: 240, currentTime: 30, paused: true, ended: false, seeking: false, currentSrc: 'synthetic.mp4' });
playerVideo.dispatchEvent(new Event('loadedmetadata'));
assert.equal($('video-hover-tip').parentNode, playerBar, 'hover time belongs to the custom track');
playerRange.dispatchEvent(new Event('pointerdown'));
playerRange.value = '70'; playerRange.dispatchEvent(new Event('input'));
assert.equal(playerVideo.currentTime, 168, 'input requests actual media seek');
assert.equal(playerBar.style.getPropertyValue('--sf-progress'), '70%', 'fill follows input before any media event');
assert.equal($('sf-play-time').textContent, '00:02:48', 'time label follows the requested position');
playerVideo.currentTime = 30; playerVideo.dispatchEvent(new Event('timeupdate'));
assert.equal(playerRange.value, '70', 'late old media time does not move the thumb during dragging');
assert.equal(playerBar.style.getPropertyValue('--sf-progress'), '70%', 'late old media time does not move the fill');
playerRange.value = '80'; playerRange.dispatchEvent(new Event('input'));
playerRange.dispatchEvent(new Event('pointerup'));
playerVideo.currentTime = 30; playerVideo.dispatchEvent(new Event('timeupdate'));
assert.equal(Number(playerRange.value), 80, 'release preserves target until decoding settles');
playerVideo.currentTime = 192; playerVideo.dispatchEvent(new Event('seeked'));
playerVideo.currentTime = 60; playerVideo.dispatchEvent(new Event('timeupdate'));
assert.equal(Number(playerRange.value), 25, 'settled seek returns to normal playback tracking');
playerRange.value = '50'; playerRange.dispatchEvent(new Event('input')); playerRange.dispatchEvent(new Event('change'));
assert.equal(playerBar.style.getPropertyValue('--sf-progress'), '50%', 'keyboard input updates fill immediately too');
playerVideo.dispatchEvent(new Event('seeked'));
playerRange.getBoundingClientRect = () => ({ left: 100, width: 400 });
playerRange.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 300 }));
assert.equal($('video-hover-tip').hidden, false, 'custom track has a hover time');
assert.equal($('video-hover-tip').textContent, '00:02:00', 'hover uses the actual custom-track geometry');
assert.equal(playerVideo.currentTime, 120, 'hover never seeks media');
playerRange.dispatchEvent(new Event('pointerleave'));
assert.equal($('video-hover-tip').hidden, true, 'leaving custom track hides preview');
playerRange.dispatchEvent(new Event('pointerdown')); playerRange.value = '75'; playerRange.dispatchEvent(new Event('input'));
playerRange.dispatchEvent(new Event('pointercancel')); playerVideo.dispatchEvent(new Event('seeked'));
playerVideo.currentTime = 120;
$('sf-back-ten').click();
assert.equal(playerVideo.currentTime, 110, 'back button seeks exactly ten seconds');
assert.equal($('sf-play-time').textContent, '00:01:50', 'skip immediately updates visible time');
$('sf-forward-ten').click();
assert.equal(playerVideo.currentTime, 120, 'forward button seeks exactly ten seconds');
playerVideo.dispatchEvent(new Event('seeked'));
playerVideo.currentTime = 235; $('sf-forward-ten').click();
assert.equal(playerVideo.currentTime, 240, 'forward clamps at media end');
playerVideo.dispatchEvent(new Event('seeked'));
playerVideo.currentTime = 5; $('sf-back-ten').click();
assert.equal(playerVideo.currentTime, 0, 'back clamps at media beginning');
playerVideo.currentTime = 5; $('sf-forward-ten').click();
assert.equal(playerVideo.currentTime, 10, 'rapid skip starts from pending target rather than a stale decoder position');
playerVideo.dispatchEvent(new Event('seeked'));
Object.assign(playerVideo, { volume: .35, muted: false, playbackRate: 1.5 });
playerVideo.dispatchEvent(new Event('volumechange')); playerVideo.dispatchEvent(new Event('ratechange'));
assert.equal(Number($('sf-volume').value), .35, 'custom volume stays in sync with media');
assert.equal($('sf-volume').style.getPropertyValue('--sf-volume'), '35%', 'volume fill follows media level');
assert.equal($('sf-rate').value, '1.5', 'styled speed select reflects external media rate');
$('sf-volume').value = '0'; $('sf-volume').dispatchEvent(new Event('input'));
assert.equal(playerVideo.muted, true, 'zero volume mutes media');
playerVideo.dispatchEvent(new Event('volumechange'));
assert.equal($('sf-mute').getAttribute('aria-pressed'), 'true', 'mute control reflects zero volume');
$('sf-mute').click();
assert.equal(playerVideo.muted, false, 'mute button restores sound');
assert.equal(playerVideo.volume, 1, 'unmute restores zero volume to audible level');
$('sf-rate').value = '2'; $('sf-rate').dispatchEvent(new Event('change'));
assert.equal(playerVideo.playbackRate, 2, 'speed option changes actual media playback');
const rateToggle = $('sf-rate-toggle'), rateMenu = $('sf-rate-menu'), rateShell = rateToggle.parentNode;
const rateOption = rate => rateMenu.querySelector(`[data-rate="${rate}"]`);
rateToggle.click();
assert.equal(rateToggle.getAttribute('aria-expanded'), 'true', 'custom speed button exposes expanded state');
assert.equal(document.activeElement, rateOption(2), 'opening focuses actual current media rate');
const chooseRate = new Event('click');
Object.defineProperty(chooseRate, 'target', { value: rateOption(.75).children[0] });
rateMenu.dispatchEvent(chooseRate);
assert.equal(playerVideo.playbackRate, .75, 'nested option label changes actual playback rate');
assert.equal($('sf-rate-label').textContent, '0.75×', 'selection updates visible speed immediately');
assert.equal(rateOption(.75).getAttribute('aria-checked'), 'true');
assert.equal(rateOption(2).getAttribute('aria-checked'), 'false');
assert.equal(rateMenu.hidden, true, 'selection closes custom menu');
assert.equal(document.activeElement, rateToggle, 'selection restores trigger focus');
playerVideo.playbackRate = 1.25; playerVideo.dispatchEvent(new Event('ratechange'));
assert.equal($('sf-rate-label').textContent, '1.25×', 'external media rate synchronizes custom trigger');
assert.equal(rateOption(1.25).getAttribute('aria-checked'), 'true');
const rateKey = key => {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
  Object.defineProperty(event, 'target', { value: document.activeElement });
  rateShell.dispatchEvent(event); return event;
};
assert.equal(rateKey('ArrowDown').defaultPrevented, true);
assert.equal(document.activeElement, rateOption(1.25), 'keyboard opening focuses current rate');
rateKey('ArrowDown'); assert.equal(document.activeElement, rateOption(1.5));
rateKey('End'); assert.equal(document.activeElement, rateOption(2));
rateKey('ArrowDown'); assert.equal(document.activeElement, rateOption(.25), 'arrow navigation wraps');
rateKey('Home'); assert.equal(document.activeElement, rateOption(.25));
rateKey('Escape');
assert.equal(rateMenu.hidden, true); assert.equal(document.activeElement, rateToggle);
rateToggle.click();
const insidePointer = new Event('pointerdown'); Object.defineProperty(insidePointer, 'target', { value: rateOption(1) });
document.dispatchEvent(insidePointer); assert.equal(rateMenu.hidden, false, 'inside pointer keeps menu open');
document.dispatchEvent(new Event('pointerdown')); assert.equal(rateMenu.hidden, true, 'outside pointer closes menu');
rateToggle.click(); rateKey('Tab'); assert.equal(rateMenu.hidden, true, 'Tab leaves menu without a focus trap');
rateToggle.focus(); rateKey(' ');
assert.equal(rateMenu.hidden, false, 'Space opens menu despite player capture cancellation');
rateKey('End'); rateKey(' ');
assert.equal(playerVideo.playbackRate, 2, 'Space activates focused speed option');
assert.equal(rateMenu.hidden, true); assert.equal(document.activeElement, rateToggle);
await settle();
Object.assign(playerVideo, { duration: NaN, currentTime: 0, currentSrc: '' });
playerVideo.dispatchEvent(new Event('emptied'));
assert.equal(playerRange.disabled, true, 'empty media disables seeking');
assert.equal($('sf-back-ten').disabled, true, 'empty media disables ten-second navigation');
assert.equal($('sf-forward-ten').disabled, true);
assert.equal(playerBar.style.getPropertyValue('--sf-progress'), '0%', 'project/media reset clears pending progress');
assert.equal($('video-hover-tip').hidden, true);
assert.equal(frames.size, playerFrames, 'scrubbing and hover add no animation-frame loop');

// The Material choices retain the native select and its business change chain.
document.body.dataset.design = 'material'; window.dispatchEvent(new Event('sf-studio-theme'));
const roleSelect = $('sel-role-filter'), choice = $('sel-role-filter-choice'), choiceMenu = $('sf-choice-menu');
roleSelect.innerHTML = '<option value="__all__">全部角色</option><option value="alice">Alice</option><option value="blocked" disabled>Unavailable</option><optgroup label="Team" disabled><option value="grouped">Grouped</option></optgroup><option value="bob">Bob</option>';
roleSelect.value = '__all__'; roleSelect.dispatchEvent(new Event('change'));
const roleChanges = []; roleSelect.addEventListener('change', () => roleChanges.push(roleSelect.value));
const choiceKey = key => { const event = Object.assign(new Event('keydown', { cancelable: true }), { key }); choice.dispatchEvent(event); return event; };
choice.click();
assert.equal(choice.getAttribute('aria-expanded'), 'true');
assert.equal(choiceMenu.getAttribute('role'), 'listbox');
assert.equal(document.activeElement, choice, 'combobox keeps keyboard focus while listbox is open');
assert.equal(choice.getAttribute('aria-activedescendant'), 'sf-choice-option-0');
assert.equal(choiceMenu.querySelector('[data-choice-index="3"]').disabled, true, 'disabled optgroup is respected');
choiceKey('ArrowDown'); assert.equal(choice.getAttribute('aria-activedescendant'), 'sf-choice-option-1');
choiceKey('ArrowDown'); assert.equal(choice.getAttribute('aria-activedescendant'), 'sf-choice-option-4', 'keyboard skips disabled option and group');
choiceKey(' ');
assert.equal(roleSelect.value, 'bob', 'Space writes original select');
assert.deepEqual(roleChanges, ['bob'], 'one business change event per changed choice');
assert.equal(choice.querySelector('.sf-choice-value').textContent, 'Bob');
assert.equal(choiceMenu.hidden, true); assert.equal(document.activeElement, choice);
choiceKey('Home'); choiceKey('Enter');
assert.equal(roleSelect.value, '__all__');
choice.click(); choiceKey('a');
assert.equal(choice.getAttribute('aria-activedescendant'), 'sf-choice-option-1', 'typeahead finds the option');
choiceKey('Escape'); assert.equal(choiceMenu.hidden, true); assert.equal(roleSelect.value, '__all__', 'Escape preserves original selection');
choice.click();
const optionClick = new Event('click'); Object.defineProperty(optionClick, 'target', { value: choiceMenu.querySelector('[data-choice-index="1"]').children[0] });
choiceMenu.dispatchEvent(optionClick); assert.equal(roleSelect.value, 'alice', 'nested option text uses original value');
choice.click();
const sameChoice = new Event('click'); Object.defineProperty(sameChoice, 'target', { value: choiceMenu.querySelector('[data-choice-index="1"]') });
const changesBefore = roleChanges.length; choiceMenu.dispatchEvent(sameChoice);
assert.equal(roleChanges.length, changesBefore, 'choosing current option does not spuriously save');
choice.click(); choiceKey('Tab'); assert.equal(choiceMenu.hidden, true, 'Tab leaves without trapping focus');
choice.click(); document.dispatchEvent(new Event('pointerdown')); assert.equal(choiceMenu.hidden, true, 'outside pointer closes listbox');
choice.click(); window.dispatchEvent(new Event('resize')); assert.equal(choiceMenu.hidden, true, 'resize closes positioned menu');
roleSelect.value = 'bob'; roleSelect.dispatchEvent(new Event('change'));
assert.equal(choice.querySelector('.sf-choice-value').textContent, 'Bob', 'external change synchronizes label');
roleSelect.disabled = true; roleSelect.dispatchEvent(new Event('change'));
assert.equal(choice.disabled, true, 'native disabled state reaches replacement control');
choice.click(); assert.equal(choiceMenu.hidden, true);
roleSelect.disabled = false; roleSelect.dispatchEvent(new Event('change'));
const settingsSelect = $('word-convert-scope'), settingsChoice = $('word-convert-scope-choice');
let settingsChanges = 0; settingsSelect.addEventListener('change', () => settingsChanges++);
settingsChoice.click();
const enabledSettingsOption = choiceMenu.querySelectorAll('[data-choice-index]').find(row => Number(row.dataset.choiceIndex) !== settingsSelect.selectedIndex && !row.disabled);
assert.ok(enabledSettingsOption, 'real editor settings choices are enhanced');
const settingsClick = new Event('click'); Object.defineProperty(settingsClick, 'target', { value: enabledSettingsOption });
choiceMenu.dispatchEvent(settingsClick); assert.equal(settingsChanges, 1, 'settings choice dispatches original handler');
assert.ok($('sf-background-choice'), 'global settings select is enhanced');
assert.ok($('st-provider-choice'), 'drawer select is enhanced');
assert.ok($('np-model-sel-choice'), 'creation model choices share the menu');
assert.ok($('dt-set-provider-choice'), 'resource defaults share the menu');
assert.equal($('sf-rate').parentElement.classList.contains('sf-choice-shell'), false, 'rate keeps its dedicated menu');
const assignmentCard = document.createElement('div'); assignmentCard.className = 'proj-card';
const assignments = [0, 1].map(() => {
  const select = document.createElement('select'); select.className = 'sf-assign';
  select.setAttribute('aria-label', '移动到文件夹');
  select.innerHTML = '<option value="">全部稿件</option><option value="folder">Folder</option>';
  assignmentCard.appendChild(select); return select;
});
document.body.appendChild(assignmentCard); window.dispatchEvent(new Event('sf-studio-theme'));
const assignmentControls = assignmentCard.querySelectorAll('.sf-choice-toggle');
assert.equal(assignmentControls.length, 2, 'dynamically added card choices are enhanced');
assert.notEqual(assignmentControls[0].id, assignmentControls[1].id, 'anonymous card controls have distinct ids');
assert.equal(assignments[0].id, undefined, 'native anonymous control is not renamed');
let folderChanges = 0; assignments[0].addEventListener('change', () => folderChanges++);
const assignmentOpen = new Event('click'); assignmentControls[0].dispatchEvent(assignmentOpen);
assert.equal(assignmentOpen.cancelBubble, true, 'choice click cannot open the containing project card');
const assignmentPick = new Event('click'); Object.defineProperty(assignmentPick, 'target', { value: choiceMenu.querySelector('[data-choice-index="1"]') });
choiceMenu.dispatchEvent(assignmentPick);
assert.equal(assignments[0].value, 'folder'); assert.equal(folderChanges, 1, 'folder choice reaches the existing business event');
assignments[0].innerHTML = '<option value="folder">Renamed folder</option>';
assignments[0].value = 'folder'; window.dispatchEvent(new Event('sf-studio-theme'));
assert.equal(assignmentControls[0].querySelector('.sf-choice-value').textContent, 'Renamed folder', 'dynamic folder changes update visible labels');
assignmentControls[0].click(); assignmentCard.remove(); window.dispatchEvent(new Event('sf-studio-theme'));
assert.equal(choiceMenu.hidden, true, 'removed card closes its menu');
const choiceCount = document.querySelectorAll('.sf-choice-toggle').length;
window.dispatchEvent(new Event('sf-studio-theme')); window.dispatchEvent(new Event('sf-studio-theme'));
assert.equal(document.querySelectorAll('.sf-choice-toggle').length, choiceCount, 'theme changes do not duplicate controls');
choice.click(); document.body.dataset.design = 'studio'; window.dispatchEvent(new Event('sf-studio-theme'));
assert.equal(choiceMenu.hidden, true, 'theme switch closes the previous menu');
assert.equal(roleSelect.value, 'bob', 'theme switch preserves actual selected value');
choice.click(); assert.equal(choiceMenu.hidden, false, 'Studio uses the shared custom selection interaction');
choiceKey('Home'); choiceKey(' ');
assert.equal(roleSelect.value, '__all__', 'Studio keyboard choice changes original value');
assert.equal(choiceMenu.hidden, true); assert.equal(document.activeElement, choice, 'Studio restores focus to custom trigger');
choice.click(); choiceKey('Escape'); assert.equal(choiceMenu.hidden, true, 'Studio Escape closes without changing selection');
roleSelect.disabled = true; roleSelect.dispatchEvent(new Event('change'));
assert.equal(choice.disabled, true, 'Studio preserves disabled semantics');
roleSelect.disabled = false; roleSelect.dispatchEvent(new Event('change'));
assert.equal($('st-fetch-quality-choice').getAttribute('aria-label'), '默认画质', 'grid fields use their visible label');
rateToggle.click(); assert.equal(rateMenu.hidden, false, 'Studio exposes the existing speed menu');
const studioRatePick = new Event('click'); Object.defineProperty(studioRatePick, 'target', { value: rateOption(1.5) });
rateMenu.dispatchEvent(studioRatePick); assert.equal(playerVideo.playbackRate, 1.5, 'Studio speed choice changes real playback rate');
assert.equal(document.activeElement, rateToggle);
window.dispatchEvent(new Event('sf-studio-theme'));
assert.equal(document.querySelectorAll('.sf-choice-toggle').length, choiceCount, 'Studio rescan does not duplicate controls');
assert.equal($('sel-display-mode').id, 'sel-display-mode', 'all original select ids remain available');
assert.equal(frames.size, playerFrames, 'select controls add no animation-frame loop');
await settle();

const state = { project: null, format: null, srtCues: [] };
const { initProjects } = await loadProduction('project.js', probe === 'upload-lock'
    ? source => source.replace(/if \(studioUI && npSubmitting && h !== '#\/new'\) \{[\s\S]*?\n    \}/, '') : null);
const api = initProjects({ state, video: $('video'), timeline: { setPeaks() {} }, panel: { showConfirm(_title, _msg, _yes, _no, onYes) { if (schemeConfirm) return onYes(); } },
  toast: text => toasts.push(text), setPlaybackAudioMode() {}, loadVideoUrl() {},
  routeSub(text) { state.format = 'srt'; state.srtCues = parseSRT(text); } });
api.applyHash(); await settle();
assert.equal($('app').inert, false, 'editor routing enables actual editor interactions');
await click('btn-new-project');
assert.equal(location.hash, '#/new');
fileDialog = new File(['fixture video bytes'], 'original.webm', { type: 'video/webm' });
await click('np-pick-video');
$('np-file-sub').files = [new File([subtitle], 'original.srt', { type: 'text/plain' })];
$('np-file-sub').dispatchEvent(new Event('change')); await settle();
$('np-name').value = 'Original title'; $('np-word').checked = false;
assert.equal($('np-create').disabled, false, 'real selections enable creation');

// ASS controls stay in the editor throughout global navigation, retaining node/value/listener identity.
const assGroups = ['ass-style-group', 'ass-fx-group', 'word-convert-group'];
const assNodes = new Map(assGroups.map(id => [id, $(id)]));
const assInput = $('ass-style-zh-size'); const assValue = assInput.value; let assChanges = 0;
assInput.addEventListener('input', () => assChanges++);
function assertAssInEditor(context) {
  for (const id of assGroups) {
    assert.equal($(id), assNodes.get(id), context + ': resident ASS node ' + id);
    assert.ok($('tab-settings').contains($(id)), context + ': ASS stays in editor ' + id);
    assert.equal($('st-view').contains($(id)), false, context + ': ASS absent from global settings ' + id);
  }
  assert.equal($('ass-style-zh-size'), assInput);
  assert.equal(assInput.value, assValue, context + ': ASS input is preserved');
}
// Classification moves resident controls, preserving their input and listener identity.
const editorPrefs = ['sf-editor-timeline', 'sf-editor-display', 'sf-editor-roles', 'sf-editor-media', 'sf-editor-export'];
const originalParents = new Map(editorPrefs.map(id => [id, $(id).parentNode]));
const stableInput = $('set-pan'); let preferenceChanges = 0;
stableInput.addEventListener('input', () => preferenceChanges++);
stableInput.value = '260';
await navigate('#/settings');
assert.equal($('sf-settings-tab-theme').getAttribute('aria-selected'), 'true', 'settings starts with common appearance preferences');
assert.equal($('st-save').hidden, true, 'instant preference category does not imply a global manual save');
assert.equal(document.querySelector('#st-view .st-actions'), null, 'settings page no longer renders a global action bar');
assert.equal($('st-save').closest('.st-panel')?.id, 'st-panel-enhance', 'manual save belongs to the enhance panel');
assert.ok($('st-msg').closest('.sf-settings-status'), 'settings status has a non-frame home');
const rimToggle = $('sf-rim-enabled').closest('label');
assert.ok(rimToggle.classList.contains('switch'), 'rim curve toggle reuses the shared switch component');
assert.ok(rimToggle.classList.contains('sf-rim-toggle'), 'rim curve toggle keeps its right-aligned header wrapper');
assert.ok(rimToggle.querySelector('.switch-slider'), 'rim curve toggle uses the shared switch slider');
const settingsList = document.querySelector('#tab-settings .settings-list');
assert.equal($('ass-fx-group').contains($('sf-editor-display')), false, 'postprocess group does not swallow later settings');
assert.equal(settingsList.contains($('sf-editor-display')), true, 'later settings stay direct children of the settings list');
assert.equal($('ass-fx-group').contains($('fx-status-note')), true, 'postprocess note stays inside its own group');
assert.equal($('timeline-panel').parentNode.id, 'app', 'timeline panel stays inside the editor grid');
assert.equal($('tab-logs').parentNode.id, 'editor-panel', 'logs tab stays inside the editor panel');
const themeColorPanel = document.querySelector('.sf-theme-color-panel');
assert.ok(themeColorPanel, 'custom theme color and swatches share one panel');
assert.ok(themeColorPanel.querySelector('.sf-settings-color'), 'theme color panel owns the custom color row');
assert.ok(themeColorPanel.querySelector('.sf-settings-swatches'), 'theme color panel owns the reset swatches');
// Theme pack cards are delegated controls: exercise every built-in pack through
// the same click path users take in the released Studio UI, including the
// rerender that happens after applyTheme().
for (const id of ['windows-uwp', 'material-you', 'subfabric-classic']) {
  const packButton = document.querySelector(`[data-pack-select="${id}"]`);
  assert.ok(packButton, 'built-in theme pack is rendered: ' + id);
  // The in-memory DOM does not synthesize event bubbling; dispatch at the
  // delegated container with the same target a browser click would provide.
  const packClick = new Event('click'); Object.defineProperty(packClick, 'target', { value: packButton });
  $('sf-theme-packs').dispatchEvent(packClick); await settle();
  assert.equal(document.body.dataset.themePack, id, 'theme pack click applies ' + id);
  assert.equal(document.body.dataset.design, id === 'material-you' ? 'material' : id === 'subfabric-classic' ? 'classic' : id === 'windows-uwp' ? 'uwp' : 'studio', 'theme design follows ' + id);
  assert.equal(document.querySelector(`[data-pack-select="${id}"]`).getAttribute('aria-pressed'), 'true', 'theme pack selection is retained for ' + id);
}
for (const [name, input] of [['models', 'st-model-dir'], ['translate', 'st-scheme-list'], ['enhance', 'st-conf-mode'], ['fetch', 'st-fetch-quality'], ['perf', 'perf-start'], ['theme', 'sf-color']]) {
  await click('sf-settings-tab-' + name);
  assertAssInEditor(name);
  const panel = $('st-panel-' + name);
  assert.equal(panel.hidden, false, name + ' panel is visible');
  assert.ok(panel.contains($(input)), name + ' owns its real controls');
  assert.equal(document.querySelectorAll('.st-panel').filter(el => !el.hidden).length, 1, name + ' has exactly one visible panel');
  assert.equal($('sf-settings-tab-' + name).getAttribute('tabindex'), '0', name + ' is the keyboard focus stop');
  assert.equal($('st-test').hidden, true, 'connection test belongs inside scheme form');
  assert.equal($('st-save').hidden, name !== 'enhance', name + ' matches actual save behavior');
  assert.equal(document.querySelector('.st-subview[data-stsub="llm"]').closest('.st-panel').hidden, name !== 'translate', 'translation subtree cannot leak into other categories');
}
assert.equal(document.getElementById('st-panel-general'),null,'removed global workbench category');
// 全模型速度：测试条件控件与创建页一致；分角色识别以说话人区分为前提。
assert.ok($('bench-word') && $('bench-confidence') && $('bench-cast') && $('bench-speakers'), 'bench condition controls are present');
$('bench-cast').checked = true; $('bench-cast').dispatchEvent(new Event('change'));
assert.equal($('bench-speakers').checked, true, '分角色识别自动开启说话人区分');
$('bench-speakers').checked = false; $('bench-speakers').dispatchEvent(new Event('change'));
assert.equal($('bench-cast').checked, false, '关闭说话人区分时同时关闭分角色识别');
assert.ok($('tab-settings').contains($('cb-heal-words')), 'load repair stays in editor preferences');
assert.ok($('st-panel-models').contains($('dual-ratio')), 'ratio retains original delegated ancestor');
const keyboardTab = $('sf-settings-tab-theme');
keyboardTab.dispatchEvent(Object.assign(new Event('keydown', {cancelable:true}), {key:'ArrowDown'})); await settle();
assert.equal(document.activeElement, $('sf-settings-tab-models'), 'arrow key changes category and moves focus');
assert.equal($('st-panel-models').hidden, false);
for (const id of editorPrefs) assert.equal($(id).parentNode, originalParents.get(id), 'workbench control always remains in editor ' + id);
assert.equal($('set-pan'), stableInput); assert.equal(stableInput.value, '260', 'tab switching preserves entered preference');
stableInput.dispatchEvent(new Event('input')); assert.equal(preferenceChanges, 1, 'moved preference keeps its original listener');
$('st-prompt').value = 'Unsubmitted translation draft';
await click('sf-settings-tab-translate'); await click('sf-settings-tab-theme'); await click('sf-settings-tab-translate');
assert.equal($('st-prompt').value, 'Unsubmitted translation draft', 'resident drawer draft survives category switches');
await click('st-cancel');
for (const id of editorPrefs) assert.equal($(id).parentNode, originalParents.get(id), 'return restores editor group ' + id);
assert.equal(stableInput.value, '260');
assertAssInEditor('return'); assInput.dispatchEvent(new Event('input')); assert.equal(assChanges, 1, 'ASS listener remains attached');
assertMaterials('settings reclassification');

// Settings is the only global sidebar entry; the old resources alias is no longer rendered.
assert.equal($('sf-nav').querySelector('[data-route="resources"]'), null, 'resource management is removed from the sidebar');
assert.equal(document.getElementById('sf-resource-links'), null, 'resource shortcut strip is removed from settings');

// Direct settings entry retains the new-project return context and File/subtitle data.
for (const route of ['settings']) {
  const link = $('sf-nav').querySelector(`[data-route="${route}"]`);
  assert.ok(link, 'sidebar route exists'); link.click(); await settle();
  assert.equal(location.hash, '#/' + route);
  assert.equal($('st-cancel').textContent, '返回新建项目', route + ': correct return context');
  assert.equal($('app').inert, true, route + ': editor subtree cannot edit a document from global pages');
  assertAssInEditor(route);
  model = route + '-model'; await click('st-cancel');
  assert.equal(location.hash, '#/new', route + ': return reopens creation');
  assert.equal($('np-view').hidden, false);
  assertMaterials(route + ' return preserves material');
  assert.equal($('np-set-model').value, model, route + ': global configuration reloads');
}

// Old resource bookmarks remain safe aliases, but resolve to the single settings page.
await navigate('#/resources');
assert.equal(location.hash, '#/settings', 'legacy resource bookmark redirects to settings');
assert.equal($('st-view').hidden, false, 'legacy resource bookmark shows settings');
assert.equal(document.getElementById('st-close'), null, 'settings header no longer has the top back button');
await click('st-cancel');
assert.equal(location.hash, '#/new', 'legacy resource alias preserves the original caller');
assertMaterials('legacy resource alias');
assert.equal(historyBacks, 0, 'Studio return uses its recorded caller rather than stale browser history');

// Save no longer implies navigation; leaving settings is the sidebar's job.
await navigate('#/settings'); await click('st-save');
assert.ok(requests.some(request => request.url === '/api/asr/hint' && request.method === 'POST'), 'global enhancement save calls its own API');
assert.equal(requests.some(request => request.url === '/api/translate/config' && request.method === 'POST'),false,'global save does not silently overwrite named translation schemes');
await settle();
assert.equal(location.hash, '#/settings', 'save stays in settings; sidebar handles navigation');
assertMaterials('settings save');

// Named schemes start empty, validate names, retain failed drafts and never write keys to storage.
await navigate('#/settings'); await click('sf-settings-tab-translate');
assert.equal($('st-scheme-list').querySelectorAll('.st-scheme').length,0,'no preconfigured provider cards');
await click('st-scheme-new');
assert.equal($('st-scheme-drawer').hidden,false); assert.equal($('st-scheme-drawer').inert,false);
assert.equal($('st-provider').value,'','new scheme requires explicit provider');
await click('st-drawer-save'); assert.equal(schemes.length,0,'missing name cannot save');
assert.equal(document.activeElement,$('st-scheme-name'));
$('st-scheme-name').value='First scheme'; $('st-provider').value='fixture'; $('st-provider').dispatchEvent(new Event('change'));
$('st-key').value='fake-secret'; $('st-model').value='first-model';
await click('gl-add'); $('gl-rows').querySelector('.gl-src').value='hello'; $('gl-rows').querySelector('.gl-src').dispatchEvent(new Event('input'));
$('gl-rows').querySelector('.gl-dst').value='你好'; $('gl-rows').querySelector('.gl-dst').dispatchEvent(new Event('input'));
schemeFailure=true; await click('st-drawer-save');
assert.equal($('st-scheme-drawer').hidden,false,'failed save retains visible form');
assert.equal($('st-key').value,'fake-secret','failed save retains typed key for retry');
assert.equal(schemes.length,0); schemeFailure=false;
await click('st-drawer-save'); await runTimer(320);
assert.equal(schemes.length,1); assert.equal(schemeActive,'scheme-1');
assert.equal($('st-key').value,'','successful save removes plaintext from DOM');
assert.ok(schemes[0].glossary.includes('hello=你好')); assert.equal($('st-scheme-drawer').inert,true);
assert.equal($('st-scheme-list').querySelectorAll('.st-scheme').length,1);
$('st-scheme-list').querySelector('.sf-scheme-open').click(); await settle();
assert.equal($('st-scheme-name').value,'First scheme'); assert.equal($('gl-rows').querySelector('.gl-dst').value,'你好','saved glossary restores');
$('st-model').value='discarded-model'; await click('st-drawer-cancel'); await runTimer(320);
assert.equal(schemes[0].model,'first-model','cancel does not mutate saved scheme');
await click('st-scheme-new'); $('st-scheme-name').value='Second scheme'; $('st-provider').value='fixture'; $('st-provider').dispatchEvent(new Event('change'));
$('st-model').value='second-model'; $('st-scheme-activate').checked=false;
await click('st-scheme-test'); assert.equal(schemes.length,1,'connection test does not persist draft');
await click('st-drawer-save'); await runTimer(320);
assert.equal(schemes.length,2); assert.equal(schemeActive,'scheme-1');
const secondCard=$('st-scheme-list').querySelectorAll('.st-scheme')[1]; secondCard.querySelector('.sf-scheme-use').click(); await settle();
assert.equal(schemeActive,'scheme-2');
schemeConfirm=false; $('st-scheme-list').querySelector('.sf-scheme-delete').click(); await settle(); assert.equal(schemes.length,2);
schemeConfirm=true; $('st-scheme-list').querySelector('.sf-scheme-delete').click(); await settle(); assert.equal(schemes.length,1);
$('st-scheme-list').querySelector('.sf-scheme-open').click(); await settle();
assert.equal($('st-scheme-drawer').hidden,false);
$('st-scheme-list').querySelector('.sf-scheme-delete').click(); await settle(); await runTimer(320);
assert.equal(schemes.length,0);
assert.equal($('st-scheme-drawer').hidden,true,'deleting the edited scheme closes its drawer');
assert.ok(![...storage.values()].some(value=>value.includes('fake-secret')),'keys never enter localStorage');
assert.equal(requests.some(request=>request.url==='/api/translate/config'&&request.method==='POST'),false);

// Aurora preferences use validated colors, survive storage reload and add no clocks.
const auroraTimers=timers.size, auroraFrames=frames.size;
$('sf-background').value='aurora'; $('sf-background').dispatchEvent(new Event('change'));
assert.equal($('sf-aurora-options').hidden,false);
$('sf-aurora-palette').value='ocean'; $('sf-aurora-palette').dispatchEvent(new Event('change'));
assert.equal(document.documentElement.style.getPropertyValue('--sf-aurora-1'),'#74adc8');
$('sf-aurora-motion').value='static'; $('sf-aurora-motion').dispatchEvent(new Event('change'));
assert.equal(document.body.dataset.auroraMotion,'static');
$('sf-aurora-color-2').value='#123456'; $('sf-aurora-color-2').dispatchEvent(new Event('change'));
assert.equal($('sf-aurora-palette').value,'custom');
const savedAurora=storage.get('subfabric-studio-v1');
assert.deepEqual(JSON.parse(savedAurora).auroraColors,['#74adc8','#123456','#95c5be']);
$('sf-aurora-color-1').value='url(invalid)'; $('sf-aurora-color-1').dispatchEvent(new Event('change'));
assert.equal(storage.get('subfabric-studio-v1'),savedAurora,'invalid color never persists');
window.dispatchEvent(Object.assign(new Event('storage'),{key:'subfabric-studio-v1',newValue:savedAurora}));
assert.equal(document.body.dataset.auroraMotion,'static');
assert.equal($('sf-aurora-color-2').value,'#123456');
document.hidden=true; document.dispatchEvent(new Event('visibilitychange')); assert.equal(document.body.dataset.pageVisible,'false');
document.hidden=false; document.dispatchEvent(new Event('visibilitychange')); assert.equal(document.body.dataset.pageVisible,'true');
$('sf-aurora-palette').value='theme'; $('sf-aurora-palette').dispatchEvent(new Event('change'));
assert.deepEqual(JSON.parse(storage.get('subfabric-studio-v1')).auroraColors,[]);
$('sf-background').value='solid'; $('sf-background').dispatchEvent(new Event('change'));
assert.equal($('sf-aurora-options').hidden,true);
assert.equal(frames.size,auroraFrames,'no aurora animation frame loop');
assert.ok(timers.size<=auroraTimers+1,'only invalid-color notice may add a timeout');

// Series navigation keeps prerequisites and model actions behind the selected family.
// Glass controls validate, persist, update output and synchronize across windows.
for (const [id,key,value,expected] of [['sf-glass-dim','glassDim','72',72],['sf-glass-blur','glassBlur','32',32],['sf-glass-opacity','glassOpacity','60',60],['sf-glass-dim','glassDim','2',72],['sf-glass-blur','glassBlur','999',32],['sf-glass-opacity','glassOpacity','5',20]]) {
  $(id).value=value; $(id).dispatchEvent(new Event('input'));
  assert.equal(JSON.parse(storage.get('subfabric-studio-v1'))[key],expected);
}
const savedGlass=storage.get('subfabric-studio-v1');
window.dispatchEvent(Object.assign(new Event('storage'),{key:'subfabric-studio-v1',newValue:savedGlass}));
assert.equal(document.documentElement.style.getPropertyValue('--sf-glass-blur'),'32px');
assert.equal($('sf-glass-dim-value').textContent,'72%');
assert.equal($('sf-glass-blur-value').textContent,'32px');
assert.equal($('sf-glass-opacity-value').textContent,'20%');
assert.equal(frames.size,auroraFrames,'glass controls add no animation loop');
await click('sf-settings-tab-models');
assert.equal($('sf-asr-families').hidden,false);
assert.equal($('st-rerecog-sel').closest('.st-card'),$('sf-asr-rerecog-mount'));
assert.equal($('sf-asr-rerecog-mount').hidden,false);
$('st-rerecog-sel').value='cloud'; $('st-rerecog-sel').dispatchEvent(new Event('change')); await settle();
assert.deepEqual(JSON.parse(requests.find(request=>request.url==='/api/asr/select-rerecog').body),{modelId:'cloud'});
const familyButtons=$('sf-asr-families').querySelectorAll('[data-asr-family]');
assert.equal(familyButtons.length,7);
const otherModels=familyButtons.find(button=>button.dataset.asrFamily==='其它模型');
assert.ok(otherModels && otherModels.hidden, 'no downloaded disabled models → no 其它模型 entry');
assert.ok(familyButtons.find(button=>button.dataset.asrFamily==='Qwen 系列'), 'Qwen 系列入口存在');
assert.ok(familyButtons.find(button=>button.dataset.asrFamily==='对齐模型'), '对齐模型入口存在');
assert.equal(familyButtons.find(button=>button.dataset.asrFamily==='对齐模型').hidden,false,
  '有对齐器时对齐模型入口可见');
// Downloaded aligner without its runtime must offer install/delete, never a dead download button.
familyButtons.find(button=>button.dataset.asrFamily==='对齐模型').click(); await settle();
assert.equal($('sf-asr-detail-title').textContent,'对齐模型');
const alignerRow=$('st-models').querySelector('.sf-aligner');
assert.ok(alignerRow, 'aligner row is rendered');
assert.ok(alignerRow.textContent.includes('模型已下载 · 还差 Qwen3 CUDA 运行时'),
  'downloaded aligner says the runtime is missing instead of 未下载');
assert.equal(alignerRow.querySelectorAll('.sm-dl').length,0, 'complete files do not show a download button');
assert.ok(alignerRow.querySelector('.sf-runtime-download'), 'missing runtime offers 安装运行时');
assert.ok(alignerRow.querySelector('.sm-del'), 'downloaded aligner keeps the delete action');
const partialAligner=[...$('st-models').querySelectorAll('.sf-aligner')].find(row=>row.textContent.includes('模型文件不完整'));
assert.ok(partialAligner, 'incomplete aligner files are reported as 不完整');
assert.ok(partialAligner.querySelector('.sm-del'), 'incomplete aligner keeps the delete action');
assert.ok(partialAligner.querySelector('.sm-dl'), 'incomplete aligner can resume download');
await click('sf-asr-back'); assert.equal($('sf-asr-families').hidden,false);
assert.equal(familyButtons.find(button=>button.dataset.asrFamily==='VibeVoice 系列'),undefined,
  'VibeVoice 系列入口已停用');
const parakeet=familyButtons.find(button=>button.dataset.asrFamily==='Parakeet 系列');
assert.ok(parakeet && !parakeet.disabled); parakeet.click(); await settle();
assert.equal($('sf-asr-detail-title').textContent,'Parakeet 系列');
assert.ok($('st-models').classList.contains('is-model-entering'), 'series switch starts one entrance pass');
await runTimer(260);
assert.ok(!$('st-models').classList.contains('is-model-entering'), 'entrance class is removed after one pass');
await click('sf-asr-back'); assert.equal($('sf-asr-families').hidden,false);
familyButtons.find(button=>button.dataset.asrFamily==='云端识别').click(); await settle();
assert.equal($('sf-asr-families').hidden,true); assert.equal($('sf-asr-detail-title').textContent,'云端识别');
assert.equal($('st-models').querySelector('.sf-asr-model').hidden,false);
assert.ok($('st-models').querySelectorAll('.sf-asr-setup').every(row=>row.hidden));
await click('sf-asr-back'); assert.equal($('sf-asr-families').hidden,false);
familyButtons.find(button=>button.dataset.asrFamily==='前置').click(); await settle();
assert.ok($('st-models').textContent.includes('检测中'), 'Python 预检未返回时先显示检测中');
pythonProbeReady = true;
await runTimer(1500);
assert.ok(!$('st-models').textContent.includes('检测中'),
  'Python 预检完成后卡片自动重画，不会永远卡在检测中');
assert.equal($('st-model-dir').closest('.st-card').hidden,false);
assert.equal($('st-runtime-env').closest('.st-card').hidden,true,'duplicate environment card stays hidden');
assert.equal($('sf-asr-rerecog-mount').hidden,true,'re-recognition belongs to overview');
assert.equal($('st-models').querySelectorAll('.sf-prerequisite').length,2);
assert.equal($('st-models').querySelectorAll('.sm-pyinstall').length,1);
assert.equal($('st-models').querySelectorAll('.sm-nemoinstall').length,0);
assert.equal($('st-models').querySelectorAll('.sf-prerequisite .sm-dl').length,1);
assert.ok(!$('st-models').querySelector('.sf-prerequisite').textContent.includes('不写注册表'));
assert.ok($('st-models').querySelector('.sm-pyset')); assert.ok($('st-models').querySelector('.sm-pyreset'));
assert.ok($('st-models').querySelectorAll('.sf-asr-setup').every(row=>!row.hidden));
await click('sf-asr-back');
assert.ok(editorPrefs.every(id=>$(id).parentNode===originalParents.get(id)));
assertMaterials('scheme and series interactions'); await click('st-cancel');

// Start the actual browser-file upload, then attempt every newly exposed navigation path.
upload = deferred(); await click('np-create');
const uploadRequest = requests.find(request => request.url.startsWith('/api/upload-video?'));
assert.ok(uploadRequest, 'create reaches the real upload request');
assert.equal(uploadRequest.body, fileDialog, 'upload still has the original selected File');
assert.equal($('np-create').disabled, true, 'submission is in progress');
for (const route of ['#/home', '#/resources', '#/settings', '#/tasks', '#/help', '#/editor']) {
  await navigate(route);
  assert.equal(location.hash, '#/new', 'upload blocks hash navigation to ' + route);
  assert.equal($('np-view').hidden, false, 'upload keeps creation page visible');
  assertMaterials('blocked ' + route);
  await click('btn-new-project');
  assertMaterials('create after blocked ' + route + ' does not npReset');
}
await click('np-cancel');
assert.equal(location.hash, '#/new', 'existing cancel action also respects submission lock');
assert.equal(created.length, 0, 'no project is submitted before upload completes');
assert.ok(toasts.some(text => text.includes('正在提交稿件')), 'blocked navigation has visible feedback');
upload.resolve(json({ path: 'videos/original.webm', name: 'original.webm' })); await settle();
assert.equal(created.length, 1, 'upload completion submits exactly one project');
// File.text() removes a leading UTF-8 BOM before the real import handler sees it.
assert.deepEqual(created[0], { name: 'Original title', video: { path: 'videos/original.webm', name: 'original.webm' }, subtitle: { name: 'original.srt', text: subtitle.replace(/^\uFEFF/, '') } }, 'submitted payload preserves all original materials after blocked navigation');
assert.equal(location.hash, '#/project/created', 'completed submission enters its project');
assert.equal(state.project?.id, 'created', 'real project loader opens the synthetic created project');
assert.equal($('app').classList.contains('is-editor-panels-entering'), true,
  'entering the editor starts the three-panel entrance');
await navigate('#/home');
assert.equal($('app').classList.contains('is-editor-panels-entering'), false,
  'leaving the editor clears the three-panel entrance');
assert.equal(location.hash, '#/home', 'navigation unlocks after completion');
assert.deepEqual(unexpected, [], 'all fetches stay in the explicit in-memory API map');
assert.deepEqual(asyncErrors, []);
assert.equal(eventJobs.size, 0, 'no event handler remains pending');

// 主页入场：主题切换先播一次动画；随后晚到的项目快照只能就地更新文字，
// 不能重播入场，也不能替换磁贴节点（用户报的「动画播完过一会又刷新一下」）。
await navigate('#/dashboard');
const dashboard = $('dashboard-view');
assert.equal(dashboard.hidden, false, 'dashboard shows after navigation');
let dashboardEntranceReads = 0;
Object.defineProperty(dashboard, 'offsetWidth', {
  configurable: true,
  get() { dashboardEntranceReads++; return 1200; },
});
window.dispatchEvent(new Event('sf-studio-theme')); await settle();
assert.ok(dashboard.classList.contains('is-entering'), 'theme switch starts the dashboard entrance');
assert.ok(dashboardEntranceReads > 0, 'dashboard entrance forces a layout');
const entranceReadsAfterTheme = dashboardEntranceReads;
const widgetNodes = [...$('sf-widgets').children];
assert.ok(widgetNodes.length >= 7, 'dashboard widgets are built');
window.__sfStudio.projects([{ id: 'late', name: 'Late project', format: 'ass', subName: 'late.ass', videoExists: true, draft: null }]);
await settle();
const widgetNodesAfter = [...$('sf-widgets').children];
assert.equal(widgetNodesAfter.length, widgetNodes.length, 'late snapshot does not rebuild the widget set');
widgetNodes.forEach((node, index) => assert.equal(widgetNodesAfter[index], node, 'late snapshot keeps widget node ' + index));
assert.equal($('sf-widgets').querySelector('[data-widget="resume"] .sf-widget-title').textContent, 'Late project', 'late snapshot updates widget text in place');
assert.equal($('sf-widgets').querySelector('[data-widget-filter="all"] .sf-widget-num').textContent, '1', 'late snapshot updates live counts in place');
assert.equal(dashboardEntranceReads, entranceReadsAfterTheme, 'late project snapshot does not replay the dashboard entrance');

console.log('studio-navigation: immediate scrub/late-media/keyboard/hover/reset, direct editor, settings return, legacy resources alias, settings save, stale ASS guard, deferred upload navigation lock, original submission payload and in-place dashboard refresh passed');

