// 量：真实主页在连续几秒里，**每张卡**的进度条/百分比各被改写了多少次。
// 用户报"所有进度条都在动" —— 本探针就是为了看清到底是谁在写。
// 用法: node tools/probe_home_progress_writes.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9523;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-pw-'));
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(5000);

// 先看真实列表长什么样（哪个在跑）
const snap = await evalJS(`(() => {
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  return JSON.stringify(cards.map(c => ({
    id: c.dataset.id,
    name: (c.querySelector('.pc-name') || {}).textContent.trim().slice(0, 18),
    st: (c.querySelector('.pc-st') || {}).textContent.trim(),
    pct: (c.querySelector('.pct') || {}).textContent || null,
    barW: (c.querySelector('.pc-draft-bar-in') || {}).style ? (c.querySelector('.pc-draft-bar-in') || {}).style.width : null,
  })));
})()`);
console.log('  当前列表:', snap);

// 给每张卡的进度条挂 style 写入钩子（用 MutationObserver 记 attribute 变化，按卡片分组）
const hooked = await evalJS(`(() => {
  const list = document.getElementById('home-list');
  window.__w = {};
  const key = (node) => {
    const card = node.nodeType === 1 ? node.closest('.proj-card') : (node.parentElement && node.parentElement.closest('.proj-card'));
    return card ? (card.dataset.id || '?') : '?';
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.attributeName === 'style') {
        const k = key(m.target); window.__w[k] = (window.__w[k] || 0) + 1;
      }
      if (m.type === 'characterData') {
        const k = key(m.target); window.__w['txt:' + k] = (window.__w['txt:' + k] || 0) + 1;
      }
    }
  }).observe(list, { subtree: true, attributes: true, attributeFilter: ['style'], characterData: true });
  return 'hooked';
})()`);
console.log('  hook:', hooked);

console.log('\n  等 6 秒（真实轮询间隔 1.5s，约 4 轮）…');
await sleep(6000);

const res = await evalJS(`JSON.stringify({ writes: window.__w, cards: [...document.querySelectorAll('#home-list .proj-card')].map(c => ({
  id: c.dataset.id, pct: (c.querySelector('.pct') || {}).textContent || null })) })`);
console.log('\n  每张卡的 style 写入次数 / 文本写入次数:', res);

// 第二轮：只盯**文本**（数字）的改写次数 —— 若每轮都在改，说明 countTo 对"没变的进度"也在动
const hooked2 = await evalJS(`(() => {
  const list = document.getElementById('home-list');
  window.__t = {};
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== 'characterData') continue;
      const card = m.target.parentElement && m.target.parentElement.closest('.proj-card');
      const k = card ? (card.dataset.id || '?') : '?';
      window.__t[k] = (window.__t[k] || 0) + 1;
    }
  }).observe(list, { subtree: true, characterData: true });
  return 'ok';
})()`);
console.log('  文本钩子:', hooked2);
await sleep(6000);
const res2 = await evalJS(`JSON.stringify(window.__t)`);
console.log('\n  6 秒内**数字文本**被改写的次数（按卡片）:', res2);
ws.close(); edge.kill();

