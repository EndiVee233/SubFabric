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
  assert.ok(['initial-editor', 'resources-return', 'upload-lock'].includes(probe), 'known regression probe');
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
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
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
  if (url === '/api/asr/status') return json({ ready: true, selectedModel: 'cloud', models: [{ id: 'cloud', name: 'Fixture cloud', engine: 'bcut', ready: true, cloud: true }], downloads: [] });
  if (url === '/api/translate/config') return json({ ready: true, cfg: { provider: 'fixture', model },
    presets: [{ id: 'fixture', name: 'Fixture', model }], defaultPrompt: 'Fixture prompt' });
  if (url === '/api/cast/config') return json({ enabled: true, prompt: 'Fixture cast' });
  if (url === '/api/asr/confidence') return json({ mode: 'full' });
  if (url === '/api/pick') return json({ fallback: true });
  const settingReads = new Set(['/api/fetch/settings', '/api/asr/correct', '/api/asr/realign-settings', '/api/asr/perf/state', '/api/asr/hint', '/api/analyze/config', '/api/asr/dual']);
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
assert.equal($('ass-style-group').inert, false, 'direct editor style controls remain available');

const state = { project: null, format: null, srtCues: [] };
const { initProjects } = await loadProduction('project.js', probe === 'resources-return'
  ? source => source.replace(/const fromSettings = previousRoute === '#\/settings' \|\| studioUI && previousRoute === '#\/resources';/, "const fromSettings = previousRoute === '#/settings';")
  : probe === 'upload-lock'
    ? source => source.replace(/if \(studioUI && npSubmitting && h !== '#\/new'\) \{[\s\S]*?\n    \}/, '') : null);
const api = initProjects({ state, video: $('video'), timeline: { setPeaks() {} }, panel: { showConfirm() {} },
  toast: text => toasts.push(text), setPlaybackAudioMode() {}, loadVideoUrl() {},
  routeSub(text) { state.format = 'srt'; state.srtCues = parseSRT(text); } });
api.applyHash(); await settle();
assert.equal($('app').inert, false, 'editor routing enables actual editor interactions');
await click('sf-create');
assert.equal(location.hash, '#/new');
fileDialog = new File(['fixture video bytes'], 'original.webm', { type: 'video/webm' });
await click('np-pick-video');
$('np-file-sub').files = [new File([subtitle], 'original.srt', { type: 'text/plain' })];
$('np-file-sub').dispatchEvent(new Event('change')); await settle();
$('np-name').value = 'Original title'; $('np-word').checked = false;
assert.equal($('np-create').disabled, false, 'real selections enable creation');

// Direct sidebar entry must retain the new-project return context and File/subtitle data.
for (const route of ['settings', 'resources']) {
  const link = $('sf-nav').querySelector(`[data-route="${route}"]`);
  assert.ok(link, 'sidebar route exists'); link.click(); await settle();
  assert.equal(location.hash, '#/' + route);
  assert.equal($('st-cancel').textContent, '返回新建项目', route + ': correct return context');
  assert.equal($('ass-style-group').inert, true, route + ': no active ASS project cannot edit stale document');
  model = route + '-model'; await click('st-cancel');
  assert.equal(location.hash, '#/new', route + ': return reopens creation');
  assert.equal($('np-view').hidden, false);
  assertMaterials(route + ' return preserves material');
  assert.equal($('np-set-model').value, model, route + ': global configuration reloads');
}

// Switching between resource/settings pages must retain the initial caller.
await navigate('#/resources'); await navigate('#/settings'); await click('st-close');
assert.equal(location.hash, '#/new', 'resource/settings cross-navigation returns to original caller');
assertMaterials('cross-navigation');
assert.equal(historyBacks, 0, 'Studio return uses its recorded caller rather than stale browser history');

// Save-and-return is the same real save chain in the new resource route.
await navigate('#/resources'); await click('st-save');
assert.ok(requests.some(request => request.url === '/api/translate/config' && request.method === 'POST'), 'resource save calls actual settings API chain');
assert.equal(location.hash, '#/resources', 'save waits for the feedback timer');
await runTimer(600);
assert.equal(location.hash, '#/new', 'resource save-and-return exits after successful save');
assertMaterials('resource save');

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
  await click('sf-create');
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
await navigate('#/home');
assert.equal(location.hash, '#/home', 'navigation unlocks after completion');
assert.deepEqual(unexpected, [], 'all fetches stay in the explicit in-memory API map');
assert.deepEqual(asyncErrors, []);
assert.equal(eventJobs.size, 0, 'no event handler remains pending');
console.log('studio-navigation: direct editor, settings/resources return+reload, resource save, stale ASS guard, deferred upload navigation lock and original submission payload passed');
