// 验证「完全退出」的前端收尾: 真实 Edge 应用窗口(--app) + CDP 观察
//
// 用法: node tools/tray_quit_probe.mjs [端口]
// 前置: 目标端口上跑着 editor/server.js
//
// 断言:
//   ① 页面确实开了 /api/lifecycle 这条 SSE(托盘退出靠它通知页面)
//   ② POST /api/quit 之后 —— 窗口被 window.close() 关掉(路径 A), 或者出现「已完全退出」提示条(路径 B)
//   ③ 服务端进程/端口随后消失
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8399);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9444;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(1); }
const profile = mkdtempSync(join(tmpdir(), 'subfab-quit-'));
const edge = spawn(EDGE, [
  `--app=${BASE}/editor/index.html`, `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1200,800',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(String(PORT)));
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { edge.kill(); console.error('未找到页面目标'); process.exit(1); }
out('页面目标', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const requests = [];
let socketClosed = false;
let targetGone = false;
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  try { ws.send(JSON.stringify({ id: mid, method, params })); } catch { res({}); }
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  if (m.method === 'Target.targetDestroyed' || m.method === 'Inspector.detached') targetGone = true;
});
ws.addEventListener('close', () => { socketClosed = true; });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await sleep(3000);                                       // 等页面初始化(SSE 建立)

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
};

out('① lifecycle SSE 已连接', requests.some((u) => u.includes('/api/lifecycle')));
out('   页面标题/版本', await evalJs(`document.getElementById('app-version')?.textContent || document.title`));

// 服务端会先广播 shutdown, 再自杀; 这里用托盘同一入口
const t0 = Date.now();
const resp = await fetch(`${BASE}/api/quit`, { method: 'POST', headers: { 'X-SubFabric-Quit': '1' } })
  .then((r) => r.json()).catch((e) => ({ error: String(e && e.message || e) }));
out('② /api/quit 响应', resp);

// 等 5 秒, 看窗口是自己关了(路径 A), 还是留在原地但给出提示条(路径 B)
let closedByScript = false, banner = null;
for (let i = 0; i < 25; i++) {
  await sleep(200);
  if (socketClosed || targetGone) { closedByScript = true; break; }
  const b = await evalJs(`document.getElementById('app-exited')?.textContent || null`).catch(() => null);
  if (b) { banner = b; }
  if (banner) break;
}
out('   窗口被脚本关掉(window.close 生效)', closedByScript);
out('   退而求其次的提示条', banner || '(无)');
out('   观察到关闭时的耗时(ms)', Date.now() - t0);

await sleep(1200);
let listening = 0;
try { listening = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`],
  { encoding: 'utf8' }).trim(); } catch {}
out('③ 退出后端口监听数', listening);

try { ws.close(); } catch {}
try { edge.kill(); } catch {}
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
