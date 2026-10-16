// 验收：新建项目（还没有 draft / 没有 format 的空窗期）必须钉在列表最上面，
//       且轮询时**不动任何卡片 DOM**（否则 bar-from 动画重放 = 进度条乱跳）。
// 用法: node tools/verify_home_new_project_top.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9529;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-np-'));
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
await sleep(5500);

console.log('\n── 装假数据：一个新项目（没 draft、没 format，正在提取）+ 两个老项目 ──');
const setup = await evalJS(`(() => {
  const orig = window.fetch;
  const mk = (o) => Object.assign({ videoExists: true, prepare: { status: 'done' },
    video: { name: 'v.mp4' }, modifiedAt: '2026-10-12T10:00:00.000Z' }, o);
  window.__fakeNew = true;
  window.fetch = function (u) {
    if (String(u) === '/api/projects') {
      const body = { projects: [
        // 服务端按 modifiedAt 倒序：老项目排在前面（模拟"新项目被挤到下面"的原始处境）
        mk({ id: 'old1', name: '老稿件 1', format: 'ass', subName: 's.ass', modifiedAt: '2026-10-12T12:00:00.000Z',
             draft: { status: 'done', stage: '完毕', progress: 100, message: '完毕' } }),
        mk({ id: 'old2', name: '老稿件 2', format: 'ass', subName: 's.ass', modifiedAt: '2026-10-12T11:00:00.000Z',
             draft: { status: 'done', stage: '完毕', progress: 100, message: '完毕' } }),
        // 新项目：还没 format、还没有 draft —— 空窗期，正是"跑到下面"的那一段
        mk({ id: 'new1', name: '新稿件（正在创建）', format: null, subName: null,
             modifiedAt: '2026-10-12T09:00:00.000Z', prepare: { status: 'running' } }),
      ] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return orig.apply(this, arguments);
  };
  window.__cnt = { addedCards: 0, removedCards: 0, anim: 0, writes: 0 };
  const list = document.getElementById('home-list');
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('proj-card')) window.__cnt.addedCards++;
      for (const n of m.removedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('proj-card')) window.__cnt.removedCards++;
      if (m.type === 'attributes' || m.type === 'characterData') window.__cnt.writes++;
    }
  }).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-pct', 'data-from'], characterData: true });
  list.addEventListener('animationstart', (e) => { if (e.animationName === 'bar-from') window.__cnt.anim++; }, true);
  // ⚠ 必须用**不含路由**的 hash 来触发 hashchange（applyHash → renderList）：
  //   写 '#/home' 或不存在的 '#/noop' 都可能让页面重新加载，假 fetch 随之失效
  //   （实测踩过两次：第一轮读到的是真实项目，断言全部对不上）。
  location.hash = '#zz';
  return 'ok';
})()`);
console.log('   ', setup);
await sleep(2500);

const first = await evalJS(`JSON.stringify({ order: [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.id),
  anims: [...document.querySelectorAll('#home-list .pc-draft-bar-in')].map(b => getComputedStyle(b).animationName + '×' + getComputedStyle(b).animationIterationCount) })`);
console.log('   第一轮:', first);
const F = JSON.parse(first);
ok(F.order[0] === 'new1', `正在创建的新项目在最上面（顺序 ${JSON.stringify(F.order)}）`);
ok(F.order.indexOf('old1') === 1 && F.order.indexOf('old2') === 2, '老项目保持服务端原顺序');

console.log('\n── 观察 8 秒（轮询 1.5s）：新项目在跑，老项目一个字节都不该动 ──');
const poll = await evalJS(`(async () => {
  window.__cnt.addedCards = 0; window.__cnt.removedCards = 0; window.__cnt.anim = 0; window.__cnt.writes = 0;
  const marks = [...document.querySelectorAll('#home-list .proj-card')];
  marks.forEach((c, i) => { c.dataset.mk = 'x' + i; });
  await new Promise(r => setTimeout(r, 8000));
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  return JSON.stringify({ cnt: window.__cnt, order: cards.map(c => c.dataset.id),
    kept: cards.filter(c => c.dataset.mk).length,
    orderSame: JSON.stringify(cards.map(c => c.dataset.id)) === JSON.stringify(${JSON.stringify(F.order)}) });
})()`);
console.log('   ', poll);
const P = JSON.parse(poll);
ok(P.cnt.addedCards === 0 && P.cnt.removedCards === 0,
  `轮询期间没有任何卡片被增删（added ${P.cnt.addedCards} / removed ${P.cnt.removedCards}）`);
ok(P.cnt.anim === 0, `没有任何进度条动画被重放（${P.cnt.anim} 次）`);
ok(P.cnt.writes === 0, `没有任何进度条/数字被改写（${P.cnt.writes} 次）`);
ok(P.orderSame === true && P.kept === 3, '顺序与卡片元素全程不变');
console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
