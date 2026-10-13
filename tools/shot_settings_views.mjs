// 快速目视验收：ASR 子视图（双语标签 + 模型分组 + 硬件条）与 LLM 子视图整体截图。
// 用法: node tools/shot_settings_views.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9516;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'edge-shot2-'));

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1600,1100',
  '--force-device-scale-factor=1', `${APP}/editor/index.html#/settings`,
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 200) };
  return r?.result?.value;
};
await sleep(7000);

const shoot = async (tag) => {
  const clip = await evalJS(`(() => { const b = document.getElementById('st-box').getBoundingClientRect();
    return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
  if (typeof clip === 'string') {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
    if (r?.data) { writeFileSync(`D:\\DSH\\npu-verify\\settings-${tag}.png`, Buffer.from(r.data, 'base64')); console.log('  D:\\DSH\\npu-verify\\settings-' + tag + '.png'); }
  }
};

// ASR 子视图：滚到模型列表顶部
await evalJS(`(async () => {
  const t = document.querySelector('.st-subtab[data-stsub="asr"]'); if (t) t.click();
  await new Promise(r => setTimeout(r, 300));
  const body = document.querySelector('.st-body'); if (body) body.scrollTop = 0;
})()`);
await sleep(500);
await shoot('asr');

// LLM 子视图
await evalJS(`(async () => {
  const t = document.querySelector('.st-subtab[data-stsub="llm"]'); if (t) t.click();
  await new Promise(r => setTimeout(r, 400));
  const body = document.querySelector('.st-body'); if (body) body.scrollTop = 0;
})()`);
await sleep(500);
await shoot('llm');

// 双语布局相关的标签在不在（我的结构改动最可能弄坏的就是它）
const check = await evalJS(`(() => {
  const ids = ['ass-style-zh-font','ass-style-en-font','ass-style-order','set-tracks','st-tabs'];
  const found = {};
  for (const i of ids) found[i] = !!document.getElementById(i);
  const tabs = [...document.querySelectorAll('.st-tabs .st-tab')].map(t => t.textContent.trim());
  const subtabs = [...document.querySelectorAll('.st-subtab')].map(t => t.textContent.trim());
  const sel = document.getElementById('ass-style-order');
  const opts = sel ? [...sel.options].map(o => o.value + '=' + o.textContent.trim()) : null;
  return JSON.stringify({ found, tabs, subtabs, orderOpts: opts });
})()`);
console.log('  结构检查:', check);
ws.close(); edge.kill();
