// 量：主页每张卡的 `.pc-draft` 类名 + 是否有无限动画在跑（用户报"所有进度条都在动"）。
// 用法: node tools/probe_home_running_class.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9524;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'edge-rc-'));

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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(5500);

const out = await evalJS(`(() => {
  const rows = [...document.querySelectorAll('#home-list .proj-card')].map(c => {
    const bar = c.querySelector('.pc-draft-bar-in');
    const box = c.querySelector('.pc-draft');
    const st = c.querySelector('.pc-st');
    const pct = c.querySelector('.pct');
    const cs = bar ? getComputedStyle(bar) : null;
    const stCs = st ? getComputedStyle(st) : null;
    return {
      id: c.dataset.id,
      name: (c.querySelector('.pc-name') || {}).textContent.replace(/\\s+/g, ' ').trim().slice(0, 22),
      draftClass: box ? box.className : null,
      barAnim: cs ? (cs.animationName + ' / ' + cs.animationIterationCount) : null,
      stClass: st ? st.className : null,
      stAnim: stCs ? stCs.animationName : null,
      pct: pct ? pct.textContent : null,
      hasBar: !!bar,
    };
  });
  return JSON.stringify(rows, null, 1);
})()`);
console.log(out);
ws.close(); edge.kill();
