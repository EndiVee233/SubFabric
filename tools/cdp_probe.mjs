// 用无头 Edge + CDP 实际加载页面, 点开设置, 读取模型区渲染结果与控制台错误
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const URL = process.argv[2] || 'http://127.0.0.1:8321/editor/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-probe-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', URL
], { stdio: 'ignore' });

let listUrl = `http://127.0.0.1:${PORT}/json/list`;
let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(listUrl)).json();
    target = list.find(t => t.type === 'page' && t.url.includes('8321'))
          || list.find(t => t.type === 'page');
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到页面目标'); edge.kill(); process.exit(1); }
console.log('target:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('[console.' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  } else if (m.method === 'Log.entryAdded') {
    logs.push('[log.' + m.params.entry.level + '] ' + m.params.entry.text);
  } else if (m.method === 'Network.responseReceived') {
    const st = m.params.response.status;
    if (st >= 400) logs.push('[HTTP ' + st + '] ' + m.params.response.url);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await sleep(2500); // 等页面初始加载

const expr = `(async () => {
  const out = {};
  out.location = location.href;
  out.buildStamp = window.__BUILD_STAMP || null;
  out.versionLabel = document.querySelector('.home-title-en')?.textContent || null;
  const btn = document.getElementById('btn-settings');
  out.hasSettingsBtn = !!btn;
  if (btn) { btn.click(); await new Promise(r=>setTimeout(r,4000)); }
  const box = document.getElementById('st-models');
  out.modelsText = box ? box.textContent.trim().replace(/\\s+/g,' ').slice(0,400) : null;
  out.hasRetryBtn = !!document.getElementById('st-models-retry');
  out.modelRows = box ? box.querySelectorAll('.sm-model').length : 0;
  out.noteText = document.getElementById('st-model-note')?.textContent || '';
  try {
    const r = await fetch('/api/asr/status', { signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    out.apiStatus = r.status;
    out.apiBody = t.slice(0, 160);
  } catch (e) { out.apiStatus = 'ERR ' + e.message; }
  try {
    const r2 = await fetch('/api/version');
    out.versionApi = await r2.text();
  } catch (e) { out.versionApi = 'ERR ' + e.message; }
  return JSON.stringify(out);
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('=== 页面运行时结果 ===');
console.log(res?.result?.value || JSON.stringify(res));
console.log('=== 控制台/日志 ===');
console.log(logs.length ? logs.join('\n') : '(无错误)');

ws.close();
edge.kill();
process.exit(0);
