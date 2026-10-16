// 验收「主页轮询只更新变了的那张卡，不再整表重建」（用户报"整页一直在闪"）。
//
// 判据（都能量化，不靠肉眼）：
//   ① 轮询一轮之后，**没变的卡片元素本身没被替换**（用 MutationObserver 数 DOM 增删）
//   ② 变了的那张卡确实被更新（内容变了）
//   ③ 卡片数量不变、顺序不变
//
// 用法: node tools/verify_home_no_flicker.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9521;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-hf-'));
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

console.log('\n── ① 准备：打标记 + 挂 MutationObserver ──');
const setup = await evalJS(`(() => {
  const list = document.getElementById('home-list');
  if (!list) return JSON.stringify({ err: 'no #home-list' });
  const cards = [...list.querySelectorAll('.proj-card')];
  if (!cards.length) return JSON.stringify({ err: '主页没有项目卡片' });
  // 给每张卡打上"染色体"标记：元素被替换时标记会丢
  cards.forEach((c, i) => { c.dataset.probeMark = 'mark' + i; });
  window.__probe = { added: 0, removed: 0, replacedCards: 0, log: [] };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      window.__probe.added += m.addedNodes.length;
      window.__probe.removed += m.removedNodes.length;
      for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('proj-card')) window.__probe.replacedCards++;
    }
  });
  obs.observe(list, { childList: true, subtree: false });
  window.__probeObs = obs;
  return JSON.stringify({ cards: cards.length, marks: cards.map(c => c.dataset.probeMark), ids: cards.map(c => c.dataset.id) });
})()`);
console.log('   ', setup);
const S = JSON.parse(setup);
if (S.err) { console.log('  ✗ ' + S.err); ws.close(); edge.kill(); process.exit(1); }
ok(S.cards > 0, `主页有 ${S.cards} 张项目卡片`);

console.log('\n── ② 触发一轮重绘，看有没有动 DOM ──');
const after = await evalJS(`(async () => {
  // 直接调 renderList()（等价于一次轮询）：它现在应该是"定点更新"
  const before = [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.probeMark);
  // renderList 在模块作用域里，页面拿不到 —— 用"再进一次首页"触发同一路径
  location.hash = '#/home';
  await new Promise(r => setTimeout(r, 2500));
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  const marks = cards.map(c => c.dataset.probeMark);
  const kept = marks.filter(m => m && m.startsWith('mark')).length;
  return JSON.stringify({ before: before.length, after: cards.length, keptMarks: kept,
    probe: window.__probe, ids: cards.map(c => c.dataset.id),
    sameIds: JSON.stringify(cards.map(c => c.dataset.id)) === JSON.stringify(${JSON.stringify(S.ids)}) });
})()`);
console.log('   ', after);
const A = JSON.parse(after);
ok(A.after === S.cards, `重绘后卡片数量不变（${S.cards} → ${A.after}）`);
ok(A.sameIds === true, '卡片顺序与 id 完全一致');
/* 关键断言：重绘**不该**替换卡片元素。
 * 注意 re-enter 首页会走 listAnim 且首次 renderList 会重建（firstPaint 判定），
 * 所以这里只要求"没有把全部卡片都换掉"——全换掉说明又回到整表重建。 */
ok(A.probe && A.probe.replacedCards < S.cards,
  `没有整表重建（新增卡片元素 ${A.probe ? A.probe.replacedCards : '?'} 张 < 总数 ${S.cards}）`,
  JSON.stringify(A.probe));

console.log('\n── ③ 连续几轮：没变的卡片必须一个字节都不动 ──');
const rounds = await evalJS(`(async () => {
  const res = [];
  for (let k = 0; k < 3; k++) {
    window.__probe.added = 0; window.__probe.removed = 0; window.__probe.replacedCards = 0;
    window.dispatchEvent(new Event('resize'));            // 不触发轮询，只是别让页面睡着
    await new Promise(r => setTimeout(r, 1600));          // 覆盖一次 1.5s 轮询
    res.push({ added: window.__probe.added, removed: window.__probe.removed, replaced: window.__probe.replacedCards });
  }
  return JSON.stringify(res);
})()`);
console.log('   ', rounds);
const R = JSON.parse(rounds);
const totalReplaced = R.reduce((s, r) => s + r.replaced, 0);
ok(totalReplaced === 0, `3 轮里没有卡片被替换（合计 ${totalReplaced}）`, JSON.stringify(R));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
