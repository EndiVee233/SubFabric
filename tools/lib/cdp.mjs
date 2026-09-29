// 通用 CDP 驱动: 无头浏览器 + 真实鼠标事件 + 控制台/网络捕获。
// 供 tools/ 下的复现脚本复用(与 cdp_probe.mjs 同一套路, 抽出连接部分)。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个无头浏览器并连上第一个 page 目标 */
export async function launch({ url, port = 9333, width = 1600, height = 1000 }) {
  const exe = BROWSERS.find((p) => existsSync(p));
  const profile = mkdtempSync(join(tmpdir(), 'subfab-probe-'));
  const headed = !!process.env.SUBFAB_HEADED;      // SUBFAB_HEADED=1 → 起真实窗口(焦点行为与无头不同)
  const proc = spawn(exe, [
    ...(headed ? [] : ['--headless=new']), `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!target) { proc.kill(); throw new Error('找不到页面目标'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const net = [];
  const reqUrls = new Map();     // requestId → url（loadingFailed 只给 requestId）
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[console.' + m.params.type + '] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    } else if (m.method === 'Log.entryAdded') {
      logs.push('[log.' + m.params.entry.level + '] ' + m.params.entry.text);
    } else if (m.method === 'Network.requestWillBeSent') {
      net.push({ phase: 'req', method: m.params.request.method, url: m.params.request.url });
      reqUrls.set(m.params.requestId, m.params.request.url);      // 记下 requestId → url，失败时才能报真 URL
    } else if (m.method === 'Network.responseReceived') {
      net.push({ phase: 'res', status: m.params.response.status, url: m.params.response.url });
    } else if (m.method === 'Network.loadingFailed') {
      // 注意：loadingFailed 带的是 requestId 而不是 url（曾经直接把它当 url 打出来，
      // 报告里出现 "FAIL 18448.194" 这种莫名其妙的数字 —— 那是 CDP 的内部 id）
      net.push({
        phase: 'fail',
        err: m.params.errorText,
        url: reqUrls.get(m.params.requestId) || ('requestId:' + m.params.requestId),
      });
    }
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');

  const api = {
    proc, ws, logs, net, send,
    /** 求值(支持 await, 返回 by value) */
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result?.value;
    },
    async goto(u) {
      await send('Page.navigate', { url: u });
      await sleep(300);
    },
    async waitFor(expr, { timeout = 15000, label = expr, interval = 250 } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await api.eval(`!!(${expr})`)) return true;
        await sleep(interval);
      }
      throw new Error('等待超时: ' + label);
    },
    /** 真实鼠标事件。modifiers: 1=Alt 2=Ctrl 4=Meta 8=Shift */
    async mouse(type, x, y, { button = 'left', buttons = 1, modifiers = 0, clickCount = 1 } = {}) {
      await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount });
    },
    async dragWithCtrl(x0, y0, x1, y1, { steps = 8, releaseCtrlFirst = false } = {}) {
      await api.mouse('mousePressed', x0, y0, { modifiers: 2 });
      for (let i = 1; i <= steps; i++) {
        await api.mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { modifiers: 2 });
        await sleep(25);
      }
      await api.mouse('mouseReleased', x1, y1, { modifiers: releaseCtrlFirst ? 0 : 2 });
      await sleep(120);
    },
    async click(x, y, { modifiers = 0 } = {}) {
      await api.mouse('mousePressed', x, y, { modifiers });
      await sleep(40);
      await api.mouse('mouseReleased', x, y, { modifiers });
      await sleep(150);
    },
    async shot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
    },
    close() { try { ws.close(); } catch {} try { proc.kill(); } catch {} },
  };
  return api;
}

export function report(title, obj) {
  console.log('\n=== ' + title + ' ===');
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}
