// 在真实主页上挂钩：记录进度条 style.width / --from 与数字文本的**每一次写入**及其调用栈。
// 用来定位"进度条和数字都在动"到底是哪段代码在写。
// 用法: node tools/probe_home_who_writes.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9526;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\who-writes.json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'edge-ww-'));

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1400,1000',
  '--force-device-scale-factor=1', `${APP}/editor/studio.html#/home`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes('8321')) || list.find(t => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到页面'); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
  return r?.result?.value;
};
await sleep(6000);

console.log('\n── 装写入钩子（记录调用栈）──');
const hooked = await evalJS(`(() => {
  window.__log = [];
  const who = (el) => {
    if (!el || !el.closest) return null;
    const card = el.closest('.proj-card');
    if (!card) return null;
    return (card.dataset.id || '?') + (el.classList.contains('pct') ? ':pct' : (el.classList.contains('pc-draft-bar-in') ? ':bar' : ':' + (el.className || el.tagName)));
  };
  const push = (kind, key, extra) => {
    if (!key) return;
    if (window.__log.length > 400) return;
    const st = (new Error().stack || '').split('\\n').slice(2, 5).map(s => s.trim().replace(/^at /, '').slice(0, 70));
    window.__log.push({ kind, key, extra: extra || '', st });
  };
  // ① style 写入
  const dsp = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'setProperty');
  CSSStyleDeclaration.prototype.setProperty = function (n, v, p) {
    const key = who(this.parentElement || this.owner || null);
    if (key) push('setProperty', key, n + '=' + v);
    return dsp.value.call(this, n, v, p);
  };
  const wsp = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'width');
  Object.defineProperty(CSSStyleDeclaration.prototype, 'width', {
    get: wsp.get, set(v) { const key = who(this.parentElement || this.owner || null); if (key) push('style.width', key, String(v)); return wsp.set.call(this, v); },
    configurable: true, enumerable: true,
  });
  // ② 文本写入
  const tn = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', {
    get: tn.get,
    set(v) { const key = who(this.nodeType === 1 ? this : this.parentElement); if (key) push('textContent', key, String(v).slice(0, 24)); return tn.set.call(this, v); },
    configurable: true, enumerable: true,
  });
  return 'hooked';
})()`);
console.log('   ', hooked);

const before = await evalJS(`JSON.stringify([...document.querySelectorAll('#home-list .proj-card')].map(c => ({
  id: c.dataset.id, cls: (c.querySelector('.pc-draft') || {}).className || null,
  pct: (c.querySelector('.pct') || {}).textContent || null })))`);
console.log('\n  快照(前):', before);

console.log('  观察 8 秒…');
await sleep(8000);

const out = await evalJS(`JSON.stringify({ log: window.__log.slice(0, 60),
  after: [...document.querySelectorAll('#home-list .proj-card')].map(c => ({
    id: c.dataset.id, cls: (c.querySelector('.pc-draft') || {}).className || null,
    pct: (c.querySelector('.pct') || {}).textContent || null })) })`);
const O = JSON.parse(out);
console.log('\n  快照(后):', JSON.stringify(O.after));
console.log('\n  写入明细（最多 60 条）:');
const byKey = {};
for (const e of O.log) {
  byKey[e.key] = byKey[e.key] || {};
  byKey[e.key][e.kind + ' ' + e.extra] = (byKey[e.key][e.kind + ' ' + e.extra] || 0) + 1;
}
console.log(JSON.stringify(byKey, null, 1));
console.log('\n  前 12 条的调用栈:');
for (const e of O.log.slice(0, 12)) console.log('   ', e.key, e.kind, e.extra, '←', (e.st || []).join(' | '));
writeFileSync(OUT, JSON.stringify(O, null, 1), 'utf8');
console.log('\n  明细已写入', OUT);
ws.close(); edge.kill();
