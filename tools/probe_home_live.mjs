// 在"有任务正在识别"的状态下量主页：每张卡的类名/动画/进度值，并观察 8 秒看谁在写。
// 用法: node tools/probe_home_live.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9527;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'edge-live-'));

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

const snap = async (tag) => {
  const s = await evalJS(`(() => {
    const rows = [...document.querySelectorAll('#home-list .proj-card')].map(c => {
      const box = c.querySelector('.pc-draft');
      const bar = c.querySelector('.pc-draft-bar-in');
      const st = c.querySelector('.pc-st');
      const pct = c.querySelector('.pct');
      const cs = bar ? getComputedStyle(bar) : null;
      return {
        id: c.dataset.id,
        name: (c.querySelector('.pc-name') || {}).textContent.replace(/\\s+/g, ' ').trim().slice(0, 20),
        cls: box ? box.className.replace('pc-draft', '').trim() : '',
        barAnim: cs ? cs.animationName + '×' + cs.animationIterationCount : '',
        st: (st || {}).textContent ? st.textContent.trim() : '',
        pct: pct ? pct.textContent : '',
        from: pct ? pct.dataset.from : '', to: pct ? pct.dataset.pct : '',
        styleW: bar ? (bar.style.width || '') : '',
      };
    });
    return JSON.stringify(rows);
  })()`);
  const rows = typeof s === 'string' ? JSON.parse(s) : [];
  console.log('\n  【' + tag + '】');
  for (const r of rows) {
    console.log('   ', String(r.name).padEnd(22), '| cls=' + String(r.cls).padEnd(8),
      '| anim=' + String(r.barAnim).padEnd(22), '| pct=' + String(r.pct).padEnd(6),
      '| from→to=' + r.from + '→' + r.to, '| w=' + r.styleW);
  }
  return rows;
};

const A = await snap('当前状态');
console.log('\n  等 8 秒（约 5 轮轮询），再拍一次…');
await sleep(8000);
const B = await snap('8 秒后');

console.log('\n  ── 对比 ──');
for (let i = 0; i < Math.min(A.length, B.length); i++) {
  const a = A[i], b = B[i];
  const changed = a.pct !== b.pct || a.from !== b.from || a.to !== b.to || a.styleW !== b.styleW || a.cls !== b.cls;
  console.log('   ', (changed ? '★ 变了' : '  没变'), String(a.name).padEnd(22),
    'pct:', a.pct, '→', b.pct, ' from:', a.from, '→', b.from, ' w:', a.styleW, '→', b.styleW, ' cls:', a.cls, '→', b.cls);
}
ws.close(); edge.kill();
