import assert from 'node:assert/strict';
import { initProjects } from '../editor/js/project.js';

// 运行真实 initProjects / 路由 / 轮询；DOM 与时钟在内存中，不启动服务或读写用户项目。
const mutations = [];
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g,
  (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.parentNode = null;
    this.hidden = true; this.value = ''; this.listeners = new Map();
    this._class = ''; this._text = ''; this._html = ''; this.connected = false;
    const tracked = kind => new Proxy({}, { set: (obj, key, value) => {
      obj[key] = value; this.record(kind + ':' + String(key)); return true;
    } });
    this.dataset = tracked('data');
    this.style = tracked('style');
    this.style.setProperty = (key, value) => { this.style[key] = value; };
    this.classList = {
      contains: name => this._class.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = (this._class + ' ' + name).trim(); },
      remove: name => { if (this.classList.contains(name)) this.className = this._class.split(/\s+/).filter(n => n !== name).join(' '); },
      toggle: (name, enabled) => { const on = enabled ?? !this.classList.contains(name); this.classList[on ? 'add' : 'remove'](name); },
    };
  }
  get isConnected() { return this.connected || !!this.parentNode?.isConnected; }
  record(kind) { if (this.isConnected) mutations.push({ node: this, kind }); }
  get className() { return this._class; }
  set className(value) { this._class = value; this.record('class'); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); this.record('text'); }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this.replaceChildren(); this._html = value; this.record('html');
    const stack = [this];
    for (const token of value.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const child = new Element(/^<([^\s>]+)/.exec(token)[1]);
        for (const match of token.matchAll(/([\w-]+)="([^"]*)"/g)) {
          const [, key, raw] = match; const val = decode(raw);
          if (key === 'class') child.className = val;
          else if (key.startsWith('data-')) child.dataset[key.slice(5)] = val;
          else if (key === 'style') for (const part of val.split(';')) {
            const colon = part.indexOf(':'); if (colon >= 0) child.style[part.slice(0, colon)] = part.slice(colon + 1);
          }
        }
        stack.at(-1).appendChild(child);
        if (!token.endsWith('/>') && !['input', 'br'].includes(child.tagName)) stack.push(child);
      } else stack.at(-1)._text += decode(token);
    }
  }
  replaceChildren() { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.record('children'); }
  insertBefore(child, next) {
    if (child === next) return child;
    if (child.parentNode) child.remove();
    const i = next ? this.children.indexOf(next) : this.children.length;
    assert.ok(i >= 0, 'insertBefore reference belongs to parent');
    this.children.splice(i, 0, child); child.parentNode = this; this.record('insert'); return child;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  remove() {
    if (this.parentNode) { const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; parent.record('remove'); }
  }
  matches(selector) {
    const attr = /\[data-([\w-]+)\]/.exec(selector);
    const cls = /\.([\w-]+)/.exec(selector);
    return (!cls || this.classList.contains(cls[1])) && (!attr || this.dataset[attr[1]] !== undefined);
  }
  querySelectorAll(selector) {
    const parts = selector.split(' '), found = [];
    const walk = node => { for (const child of node.children) {
      if (child.matches(parts.at(-1))) {
        let ancestor = child.parentNode, i = parts.length - 2;
        while (ancestor && i >= 0) { if (ancestor.matches(parts[i])) i--; ancestor = ancestor.parentNode; }
        if (i < 0) found.push(child);
      }
      walk(child);
    } };
    walk(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  setAttribute() {} removeAttribute() {} focus() {}
}

let projects = [], now = 0, sequence = 0, reducedMotion = false;
const timers = new Map(), frames = new Map(), elements = new Map();
const getElement = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
globalThis.document = { querySelector: getElement, getElementById: id => getElement('#' + id),
  querySelectorAll: () => [], createElement: tag => new Element(tag), body: new Element(), addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: reducedMotion }) };
globalThis.location = { hash: '#/home' };
// 返回用户：首次启动欢迎页已完成，避免它拦截 applyHash（首次逻辑由 welcome-model-test 覆盖）
globalThis.localStorage = {
  getItem(key) {
    if (key === 'sf-welcome-v1') return JSON.stringify({ done: true, cuda: true, vulkan: true });
    if (key === 'sf-welcome-synced') return '1';
    return null;
  },
  setItem() {},
};
globalThis.history = { replaceState() {}, back() {} };
globalThis.performance = { now: () => now };
globalThis.setTimeout = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.requestAnimationFrame = fn => { const id = ++sequence; frames.set(id, fn); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.fetch = async url => { assert.equal(url, '/api/projects'); return { json: async () => ({ projects: structuredClone(projects) }) }; };
const home = getElement('#home-view'), list = getElement('#home-list'); list.connected = true;
const settle = () => new Promise(resolve => setImmediate(resolve));
const step = ms => { now += ms; const ready = [...frames.values()]; frames.clear(); for (const fn of ready) fn(now); };
const finish = () => { for (let i = 0; i < 10 && frames.size; i++) step(100); assert.equal(frames.size, 0, 'animation finishes'); };
const poll = async () => {
  const entry = [...timers].find(([, timer]) => timer.ms === 1500);
  assert.ok(entry, 'active tasks keep home polling'); timers.delete(entry[0]); entry[1].fn(); await settle();
};
const card = id => list.children.find(el => el.dataset.id === id);
const ids = () => list.children.map(el => el.dataset.id);
const inside = (node, ancestor) => { while (node) { if (node === ancestor) return true; node = node.parentNode; } return false; };
const touched = node => mutations.filter(m => inside(m.node, node));
const pct = id => card(id).querySelector('.pct');
const project = (id, status = 'done', progress = 100, format = 'ass') => ({
  id, name: id, format, videoExists: true, video: { name: id + '.webm' }, subName: 'subtitle.ass',
  modifiedAt: '2026-10-12T11:00:00Z', prepare: { status: 'done' },
  draft: { status, progress, stage: status === 'done' ? '完毕' : 'ASR识别中', message: id + ' progress' },
});
projects = [project('done'), project('paused', 'paused', 86), project('failed', 'error', 30, null), project('work', 'running', 63, null)];
const api = initProjects({ state: { project: null }, video: { pause() {} }, timeline: {}, panel: {}, toast() {}, setPlaybackAudioMode() {} });
api.applyHash(); await settle();
assert.deepEqual(ids(), ['work', 'done', 'paused', 'failed'], 'only active projects are pinned');
for (const id of ['done', 'paused', 'failed']) assert.equal(pct(id).textContent, projects.find(p => p.id === id).draft.progress + '%', 'inactive percentage is final on first paint');
finish();
const stable = ['done', 'paused', 'failed'].map(id => ({ id, card: card(id), pct: pct(id), bar: card(id).querySelector('.pc-draft-bar-in') }));
mutations.length = 0; await poll(); finish();
assert.equal(mutations.filter(m => m.node === list && ['insert', 'remove', 'children', 'html'].includes(m.kind)).length, 0, 'identical polls do not move cards');
for (const item of stable) assert.equal(touched(item.card).length, 0, 'inactive cards remain untouched');
assert.equal(touched(pct('work')).length, 0, 'unchanged active percentage does not animate again');

projects.at(-1).draft.progress = 70; projects.at(-1).draft.message = 'next chunk'; projects.at(-1).modifiedAt = '2026-10-13T00:00:01Z';
const workPct = pct('work'); mutations.length = 0; await poll();
assert.equal(pct('work'), workPct, 'progress/timestamp updates reuse the percentage node');
step(210); assert.ok(Number.parseFloat(pct('work').textContent) > 63 && Number.parseFloat(pct('work').textContent) < 70, 'active progress interpolates');
projects.at(-1).draft.progress = 75; await poll(); finish();
assert.equal(pct('work').textContent, '75%', 'new progress supersedes an unfinished tween');
for (const item of stable) { assert.equal(card(item.id), item.card); assert.equal(pct(item.id), item.pct); assert.equal(touched(item.card).length, 0); }
mutations.length = 0; await poll(); finish();
assert.equal(touched(pct('work')).length, 0, 'finished tween never replays on later polls');

// 多活动任务按服务端组内顺序；排序变化必须移动已有卡片，而不是只移动重建卡片。
projects = [project('second', 'running', 4, null), ...projects];
await poll(); finish(); assert.deepEqual(ids(), ['second', 'work', 'done', 'paused', 'failed']);
const doneCard = card('done'), secondCard = card('second'), existingWork = card('work');
projects = [projects[3], projects[1], projects[2], projects[4], projects[0]];
await poll(); finish(); assert.deepEqual(ids(), ['work', 'second', 'failed', 'done', 'paused']);
assert.equal(card('work'), existingWork); assert.equal(card('second'), secondCard); assert.equal(card('done'), doneCard);

const work = projects.find(p => p.id === 'work'); work.draft.progress = 80; await poll(); step(100);
const detachedPct = pct('work'), beforeDetach = detachedPct.textContent;
work.format = 'ass'; work.draft = { status: 'done', progress: 100, stage: '完毕', message: 'ready' };
mutations.length = 0; await poll();
assert.deepEqual(ids(), ['second', 'failed', 'done', 'paused', 'work'], 'completed work returns to ordinary server order');
assert.equal(pct('work').textContent, '100%', 'completion is static immediately'); finish();
assert.equal(detachedPct.textContent, beforeDetach, 'detached percentage receives no stale animation writes');
mutations.length = 0; await poll(); finish(); assert.equal(touched(card('work')).length, 0, 'completed work stays static');

// prepare 空窗期置顶；失败、暂停和无格式旧稿不冒充活动任务；删除、改名不影响其他卡片。
projects = [project('failed', 'error', 30, null), { ...project('extract'), format: null, draft: null, prepare: { status: 'running' } }, ...projects.filter(p => p.id !== 'failed')];
await poll(); finish(); assert.deepEqual(ids().slice(0, 2), ['extract', 'second']);
projects.find(p => p.id === 'done').name = 'renamed'; await poll(); finish(); assert.ok(card('done').querySelector('.pc-name').textContent.startsWith('renamed'));
projects = projects.filter(p => p.id !== 'paused'); await poll(); finish(); assert.equal(card('paused'), undefined);
reducedMotion = true; projects.find(p => p.id === 'second').draft.progress = 10; await poll(); assert.equal(pct('second').textContent, '10%'); assert.equal(frames.size, 0);
projects = [{ ...project('new'), format: null, draft: null, prepare: { status: 'none' } }, { ...project('download'), format: null, draft: null, fetching: true }, ...projects];
await poll(); assert.deepEqual(ids().slice(0, 4), ['new', 'download', 'extract', 'second'], 'new/prepare gap and download are active');
home.hidden = true; await poll(); assert.equal([...timers.values()].filter(t => t.ms === 1500).length, 0, 'hidden home stops polling');
projects = [project('done'), project('paused', 'paused', 86, null), project('failed', 'error', 30, null), { ...project('extract-failed'), format: null, draft: null, prepare: { status: 'error' } }];
location.hash = '#/editor'; api.applyHash(); location.hash = '#/home'; api.applyHash(); await settle(); finish();
assert.equal([...timers.values()].filter(t => t.ms === 1500).length, 0, 'inactive/failed projects do not keep polling');
assert.deepEqual(ids(), ['done', 'paused', 'failed', 'extract-failed']);
console.log('home-project-list: active-first ordering, stable inactive DOM, changed-only/superseded tweens, completion, prepare, rename/delete, reduced motion and hidden home passed');
