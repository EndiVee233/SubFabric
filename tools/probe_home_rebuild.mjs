// 有任务在跑时，量主页卡片元素**是否被重建**（重建 = 进度条从 0 重放填充动画 = "都在动"）。
// 判据：给每张卡打标记，观察 N 秒内标记是否还在；并统计 childList 增删。
// 用法: node tools/probe_home_rebuild.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9528;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'edge-rb-'));

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1400,1000',
  '--force-device-scale-factor=1', `${APP}/editor/index.html#/home`,
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

console.log('\n── 打标记 + 计数 ──');
const hooked = await evalJS(`(() => {
  const list = document.getElementById('home-list');
  const cards = [...list.querySelectorAll('.proj-card')];
  cards.forEach((c, i) => { c.dataset.mark = 'k' + i; c.dataset.markAt = String(Date.now()); });
  window.__r = { addedCards: 0, removedCards: 0, addedNodes: 0, removedNodes: 0, animRestarts: 0 };
  new MutationObserver((muts) => {
    for (const m of muts) {
      window.__r.addedNodes += m.addedNodes.length;
      window.__r.removedNodes += m.removedNodes.length;
      for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('proj-card')) window.__r.addedCards++;
      for (const n of m.removedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('proj-card')) window.__r.removedCards++;
    }
  }).observe(list, { childList: true, subtree: false });
  // 顺带盯 animationstart：卡片被重建时 bar-from 会重新触发
  list.addEventListener('animationstart', (e) => {
    if (e.animationName === 'bar-from') window.__r.animRestarts++;
  }, true);
  return JSON.stringify({ cards: cards.length });
})()`);
console.log('   ', hooked);

console.log('\n  ★ 现在**手动触发一次** renderList（进设置再回首页），看空闲卡片是否被重建 ──');
const manual = await evalJS(`(async () => {
  const before = [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.mark);
  window.__r.addedCards = 0; window.__r.removedCards = 0; window.__r.animRestarts = 0;
  location.hash = '#/settings';
  await new Promise(r => setTimeout(r, 400));
  location.hash = '#/home';
  await new Promise(r => setTimeout(r, 1500));
  const after = [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.mark);
  return JSON.stringify({ before: before.length, after: after.length, keptMarks: after.filter(m => m).length,
    r: window.__r, sameOrder: JSON.stringify(before) === JSON.stringify(after) });
})()`);
console.log('   ', manual);

console.log('\n  观察 8 秒（有任务在跑，轮询 1.5s）…');
const poll = await evalJS(`(async () => {
  window.__r.addedCards = 0; window.__r.removedCards = 0; window.__r.animRestarts = 0;
  const marks0 = [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.mark || '?');
  await new Promise(r => setTimeout(r, 8000));
  const marks1 = [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.mark || '?');
  return JSON.stringify({ r: window.__r, marks0: marks0.length, marks1: marks1.length,
    kept: marks1.filter(m => m !== '?').length, same: JSON.stringify(marks0) === JSON.stringify(marks1) });
})()`);
console.log('   ', poll);
ws.close(); edge.kill();
