// 查入口卡的图标是否注入、进度条填充是否被画出来（设计稿 ① 的两处细节）。
// 用法: node tools/probe_entry_card.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9513;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-ec-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
  '--force-device-scale-factor=1', `${APP}/editor/studio.html#/settings`,
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

const out = await evalJS(`(() => {
  const info = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return { sel, tag: el.tagName, cls: el.className, ico: el.dataset ? el.dataset.ico : null,
      childTags: [...el.children].map(c => c.tagName + (c.className ? '.' + String(c.className).split(' ')[0] : '')),
      hasSvg: !!el.querySelector('svg'),
      w: Math.round(b.width), h: Math.round(b.height),
      display: cs.display, inlineWidth: el.style.width || '(none)',
      bg: cs.backgroundColor, color: cs.color };
  };
  return JSON.stringify({
    asrIcon: info('#st-entry-asr .st-entry-ico'),
    llmIcon: info('#st-entry-llm .st-entry-ico'),
    asrBarFill: info('#st-entry-asr-bar'),
    llmBarFill: info('#st-entry-llm-bar'),
    navIcons: [...document.querySelectorAll('.st-tabs .st-tab')].map(t => ({
      stp: t.dataset.stp, ico: t.dataset.ico, hasSvg: !!t.querySelector('svg'),
      kids: [...t.childNodes].map(n => n.nodeType === 3 ? 'text:' + n.textContent.trim().slice(0, 12) : n.nodeName).slice(0, 4),
    })),
    navIconSvgSize: (() => { const s = document.querySelector('.st-tabs .st-tab svg');
      if (!s) return null; const b = s.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
  }, null, 1);
})()`);
console.log(out);
ws.close(); edge.kill();
