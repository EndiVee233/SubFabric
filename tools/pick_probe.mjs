// 诊断发行版 /api/pick: 用 CDP 实际点击「浏览…」并观察 fetch 结果与服务端行为
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const URL = process.argv[2] || 'http://127.0.0.1:8321/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-probe-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', URL
], { stdio: 'ignore' });

let target = null;
const listUrl = `http://127.0.0.1:${PORT}/json/list`;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(listUrl)).json();
    target = list.find(t => t.type === 'page') || null;
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到页面目标'); edge.kill(); process.exit(1); }

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
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await sleep(2500);

const expr = `(async () => {
  const out = {};
  // 1. 直接调 /api/pick 接口(绕开 UI), 观察多长时间返回什么
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch('/api/pick', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({kind:'video'}), signal: ctl.signal });
    clearTimeout(killer);
    out.status = r.status;
    out.body = await r.text();
    out.elapsedMs = Date.now() - t0;
  } catch (e) { out.err = e.name + ': ' + e.message + ' @' + (Date.now()-t0) + 'ms'; }
  return JSON.stringify(out);
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('=== /api/pick 结果 ===');
console.log(res?.result?.value || JSON.stringify(res));
console.log('=== 页面日志 ===');
console.log(logs.length ? logs.join('\n') : '(无)');
ws.close();
edge.kill();
process.exit(0);
