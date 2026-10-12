// 量「全片逐词重校对」预览条目的尺寸：勾选前后差在哪。
// 用户反馈：选中字幕时那个框的 UI 被错误压缩（两行文字挤到一起）。
//
// 用法: node tools/probe_realign_row.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9422;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-rr-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1400,1000',
  `${APP}/editor/index.html#/project/${PROJ}`,
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 300) };
  return r?.result?.value;
};

await sleep(5000);

// 造一条与真实结构一样的预览条目（不依赖后台作业跑完）
const built = await evalJS(`(() => {
  const list = document.getElementById('realign-list');
  const overlay = document.getElementById('realign-overlay') || (list && list.closest('div[hidden], .overlay, #realign'));
  if (!list) return 'no #realign-list';
  if (overlay) overlay.hidden = false;
  list.hidden = false;
  const chip = (c) => (c >= 0.85 ? 'chip-l1' : (c >= 0.7 ? 'chip-conf' : 'chip-conf-low'));
  list.innerHTML = [0, 1, 2].map(k => {
    const picked = k !== 2, off = k === 2, c = 0.76;
    return '<label class="reflect-item' + (off ? ' is-off' : '') + (picked ? ' is-on' : '') + '" data-k="' + k + '">'
      + '<input type="checkbox" data-k="' + k + '"' + (picked ? ' checked' : '') + (off ? ' disabled' : '') + '>'
      + '<span class="ri-body">'
      + '<span class="ri-head">'
      + '<span class="cc-chip ' + chip(c) + '">置信度中 76%</span>'
      + '<span class="ri-range">第 1 行 · 00:00:00.000 ~ 00:00:08.960</span>'
      + '<span class="ri-range">锚点 19/22 词</span>'
      + '</span>'
      + '<span class="ri-text">G\\'day ladies and gents, Cubic Meter here, Merging has just announced, new 26.4 content, drop…</span>'
      + '<span class="ri-reason">识别听到：G Day ladies and gents, Cub here, Merging has just announced, new Archiluad content, dropu</span>'
      + '</span></label>';
  }).join('');
  return 'ok';
})()`);
console.log('造条目:', built);
await sleep(400);

const measure = async (label) => {
  const out = await evalJS(`(() => {
    const rows = [...document.querySelectorAll('#realign-list .reflect-item')];
    return JSON.stringify(rows.map((el) => {
      const cs = getComputedStyle(el);
      const head = el.querySelector('.ri-head');
      const text = el.querySelector('.ri-text');
      const reason = el.querySelector('.ri-reason');
      const cb = el.querySelector('input[type=checkbox]');
      const r = (n) => { const b = n.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x) }; };
      return {
        cls: el.className,
        row: r(el), head: r(head), text: r(text), reason: r(reason), cb: r(cb),
        display: cs.display, alignItems: cs.alignItems, padding: cs.padding,
        overflow: cs.overflow, position: cs.position,
        gap: cs.gap, width: cs.width,
        listW: Math.round(el.parentElement.getBoundingClientRect().width),
      };
    }), null, 1);
  })()`);
  console.log('\n=== ' + label + ' ===');
  console.log(out);
};
await measure('初始（第 1/2 条勾选、第 3 条 off）');

/* ── 关键一步：把列表高度压小，看行是"滚动"还是"被压扁" ──
 * .reflect-list 是 flex 列容器 + overflow-y:auto，而 .reflect-item 没写 flex:none，
 * 默认 flex-shrink:1 —— 于是纵向不够时它优先压扁行，而不是出现滚动条。
 * 这里把列表高度限制成 200px（真实场景是窗口矮 / 面板被挤），量行高变化。 */
await evalJS(`(() => {
  const list = document.getElementById('realign-list');
  list.style.height = '200px';
  list.style.flex = '0 0 200px';
  return 'ok';
})()`);
await sleep(300);
await measure('把列表高度限制成 200px 后（应当滚动，不该压扁）');

await evalJS(`(() => {
  const list = document.getElementById('realign-list');
  list.style.height = '90px';
  return 'ok';
})()`);
await sleep(300);
const squashed = await evalJS(`(() => {
  const rows = [...document.querySelectorAll('#realign-list .reflect-item')];
  const list = document.getElementById('realign-list');
  return JSON.stringify({
    rowHeights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
    scrollH: list.scrollHeight, clientH: list.clientHeight,
    canScroll: list.scrollHeight > list.clientHeight,
  });
})()`);
console.log('\n=== 把列表压到 90px 后 ===');
console.log(squashed);

// 取消勾选第 1 条 → 看尺寸有没有变
await evalJS(`(() => {
  const cb = document.querySelector('#realign-list .reflect-item input[type=checkbox]');
  cb.checked = false;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await sleep(300);
await measure('把第 1 条取消勾选后');

// 再勾回来
await evalJS(`(() => {
  const cb = document.querySelector('#realign-list .reflect-item input[type=checkbox]');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await sleep(300);
await measure('再勾回来后');

ws.close(); edge.kill();
