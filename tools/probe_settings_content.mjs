// 量设置页右栏（.st-body）里各元素的可见性与尺寸，定位"内容空白"。
// 用法: node tools/probe_settings_content.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9512;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-stc-'));
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
await send('Runtime.enable'); await send('Page.enable');
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
  return r?.result?.value;
};
await sleep(6000);

const out = await evalJS(`(() => {
  const box = document.getElementById('st-box');
  const body = document.querySelector('.st-body');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) }; };
  const info = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { rect: r(el), display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
             overflow: cs.overflow, hidden: !!el.hidden, txt: (el.textContent || '').trim().slice(0, 40) };
  };
  const views = ['st-box', 'st-view', 'st-panel-models', 'st-models', 'st-runtime-env', 'st-entry-asr', 'st-entry-llm', 'st-layout', 'st-body'];
  const res = {};
  for (const id of views) res[id] = info(document.getElementById(id));
  res['.st-nav'] = info(document.querySelector('.st-nav'));
  res['.st-body'] = info(body);
  res['.st-actions'] = info(document.querySelector('.st-actions'));
  res['#app'] = info(document.getElementById('app'));
  res['body.scrollHeight'] = body ? body.scrollHeight : null;
  res['body.clientHeight'] = body ? body.clientHeight : null;
  res['viewport'] = { w: innerWidth, h: innerHeight };
  // 右栏里最上面的元素（看有没有东西占了位置）
  const kids = body ? [...body.children].map(c => {
    const b = c.getBoundingClientRect();
    return { cls: c.id || c.className, h: Math.round(b.height), w: Math.round(b.width), hidden: !!c.hidden,
             disp: getComputedStyle(c).display };
  }) : null;
  res.bodyKids = kids;
  return JSON.stringify(res, null, 1);
})()`);
console.log(out);
ws.close(); edge.kill();
