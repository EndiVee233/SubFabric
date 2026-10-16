// 验收：连续触发多次列表重绘后，**空闲卡片**的进度条属性/数字文本一个字节都不该被改写。
// 用法: node tools/verify_home_idle_static.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9525;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-is-'));
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

console.log('\n── 给每张卡挂"属性/文本写入"计数器 ──');
const hooked = await evalJS(`(() => {
  const list = document.getElementById('home-list');
  window.__w = {};
  const keyOf = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const card = el && el.closest ? el.closest('.proj-card') : null;
    return card ? (card.dataset.id || '?') : '?';
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      const k = keyOf(m.target);
      if (m.type === 'attributes') window.__w[k + ':attr'] = (window.__w[k + ':attr'] || 0) + 1;
      if (m.type === 'characterData') window.__w[k + ':txt'] = (window.__w[k + ':txt'] || 0) + 1;
    }
  }).observe(list, { subtree: true, attributes: true, attributeFilter: ['style', 'data-pct', 'data-from'], characterData: true });
  return 'ok';
})()`);
console.log('   ', hooked);

console.log('\n── 连触发 4 次重绘（模拟轮询），看谁被写 ──');
const res = await evalJS(`(async () => {
  const before = [...document.querySelectorAll('#home-list .proj-card')].map(c => ({
    id: c.dataset.id, pct: (c.querySelector('.pct') || {}).textContent || null,
    cls: (c.querySelector('.pc-draft') || {}).className || null,
  }));
  window.__w = {};
  for (let k = 0; k < 4; k++) {
    location.hash = '#/settings'; await new Promise(r => setTimeout(r, 120));
    location.hash = '#/home';     await new Promise(r => setTimeout(r, 1200));
  }
  const after = [...document.querySelectorAll('#home-list .proj-card')].map(c => ({
    id: c.dataset.id, pct: (c.querySelector('.pct') || {}).textContent || null,
    cls: (c.querySelector('.pc-draft') || {}).className || null,
  }));
  return JSON.stringify({ writes: window.__w, before, after });
})()`);
const R = JSON.parse(res);
console.log('  写入统计:', JSON.stringify(R.writes));
console.log('  重绘前后:', JSON.stringify(R.before.map(b => b.id + '=' + b.pct)));

const running = R.before.filter(b => b.cls && b.cls.includes('running')).map(b => b.id);
const idle = R.before.filter(b => b.cls && !b.cls.includes('running')).map(b => b.id);
console.log('  正在处理:', running, ' 空闲:', idle.length, '张');
ok(idle.length > 0, `列表里有 ${idle.length} 张空闲卡片（用于对照）`);
const idleWrites = idle.reduce((s, gid) => s + (R.writes[gid + ':attr'] || 0) + (R.writes[gid + ':txt'] || 0), 0);
ok(idleWrites === 0, `4 次重绘里空闲卡片零写入（实际 ${idleWrites}）`, JSON.stringify(R.writes));
ok(JSON.stringify(R.before.map(b => b.id + b.pct)) === JSON.stringify(R.after.map(b => b.id + b.pct)),
  '重绘前后所有卡片的百分比与顺序完全一致');
console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
