// 验收「全片逐词重校对 · 预览」的两个 bug：
//   ① 选中行被压扁（.reflect-item.is-on 的 overflow:hidden 让 min-height:auto 失效）
//   ② 切换稿件/重新开始时，右下角按钮还留着上一份稿件的句数
//
// 用法: node tools/verify_realign_preview.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9455;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const N = Number(process.env.N || 45);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-rpv-'));
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
await send('Log.enable');
const pageErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') pageErrors.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.text || 'exception');
});
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(5200);

const fill = await evalJS(`(() => {
  const overlay = document.getElementById('realign-overlay');
  const list = document.getElementById('realign-list');
  if (!overlay || !list) return 'no overlay/list';
  overlay.hidden = false;
  const conf = document.getElementById('realign-conf');
  const sum = document.getElementById('realign-summary');
  const allWrap = document.getElementById('realign-all-wrap');
  const apply = document.getElementById('realign-apply');
  const msg = document.getElementById('realign-msg');
  if (conf) conf.hidden = false;
  if (sum) { sum.hidden = false; sum.textContent = '共 ${N} 句：36 句达标（会重排逐词时间）、9 句未达标（保留原样）'; }
  if (allWrap) allWrap.hidden = false;
  if (msg) msg.textContent = '校对完成，确认后应用（未达标的不可勾选）';
  if (apply) { apply.disabled = false; apply.textContent = '应用选中项（36 句）'; }
  list.hidden = false;
  let html = '';
  for (let k = 0; k < ${N}; k++) {
    const off = k >= ${N} - 9, picked = !off, c = off ? 0.52 : 0.76;
    const chip = c >= 0.85 ? 'chip-l1' : (c >= 0.7 ? 'chip-conf' : 'chip-conf-low');
    const word = c >= 0.85 ? '高' : (c >= 0.7 ? '中' : '低');
    html += '<label class="reflect-item' + (off ? ' is-off' : '') + (picked ? ' is-on' : '') + '" data-k="' + k + '">'
      + '<input type="checkbox" data-k="' + k + '"' + (picked ? ' checked' : '') + (off ? ' disabled' : '') + '>'
      + '<span class="ri-body">'
      + '<span class="ri-head"><span class="cc-chip ' + chip + '">置信度' + word + ' ' + Math.round(c * 100) + '%</span>'
      + '<span class="ri-range">第 ' + (k + 1) + ' 行 · 00:00:0' + (k % 10) + '.000 ~ 00:00:0' + ((k + 9) % 10) + '.960</span>'
      + '<span class="ri-range">锚点 19/22 词</span></span>'
      + '<span class="ri-text">G\\'day ladies and gents, Cubic Meter here, Merging has just announced, new 26.4 content</span>'
      + '<span class="ri-reason">识别听到：G Day ladies and gents, Cub here, Merging has just announced</span>'
      + '</span></label>';
  }
  list.innerHTML = html;
  return 'ok rows=' + list.children.length;
})()`);
console.log('填列表:', fill);
await sleep(600);

console.log('\n── ① 选中行不能被压扁（is-on 的 overflow:hidden 曾让它缩到 16px）──');
const m = JSON.parse(await evalJS(`(() => {
  const list = document.getElementById('realign-list');
  const rows = [...list.children];
  const hs = rows.map(r => Math.round(r.getBoundingClientRect().height));
  const on = rows.filter(r => r.classList.contains('is-on')).map(r => Math.round(r.getBoundingClientRect().height));
  const off = rows.filter(r => r.classList.contains('is-off')).map(r => Math.round(r.getBoundingClientRect().height));
  return JSON.stringify({
    n: rows.length, min: Math.min(...hs), max: Math.max(...hs),
    onMin: Math.min(...on), onMax: Math.max(...on),
    offMin: Math.min(...off), offMax: Math.max(...off),
    scrollable: list.scrollHeight > list.clientHeight + 1,
    rowFlex: getComputedStyle(rows[0]).flex,
  });
})()`));
console.log('   行高统计:', JSON.stringify(m));
ok(m.onMin >= 60, `选中行高度正常（最低 ${m.onMin}px，压扁时是 16px）`);
ok(m.min >= 60, `没有任何行被压扁（全场最低 ${m.min}px）`);
ok(Math.abs(m.onMax - m.offMax) <= 2, `选中与未选中行同高（${m.onMax} vs ${m.offMax}）`);
ok(m.scrollable, '列表改为滚动（scrollHeight > clientHeight）');
ok(/0 0 auto|none/.test(m.rowFlex), `行的 flex 已钉住（${m.rowFlex}）`);

console.log('\n── ② 重新开始时按钮不能留着上一轮的句数 ──');
const started = await evalJS(`(async () => {
  // 拦掉真实请求：只验 UI 复位，不去打扰服务端/稿件
  const origFetch = window.fetch;
  window.fetch = (u, o) => (String(u).includes('/realign-full') ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) : origFetch(u, o));
  const btn = document.getElementById('realign-btn') || document.getElementById('btn-realign-full');
  const apply = document.getElementById('realign-apply');
  const before = { text: apply.textContent, disabled: apply.disabled };
  btn.click();
  await new Promise(r => setTimeout(r, 500));
  const after = { text: apply.textContent, disabled: apply.disabled, listHidden: document.getElementById('realign-list').hidden };
  window.fetch = origFetch;
  return JSON.stringify({ hasBtn: !!btn, before, after });
})()`);
console.log('   ', started);
const S = JSON.parse(started);
ok(S.hasBtn, '找得到「全片逐词重校对」按钮');
ok(/3927|（\d+ 句）/.test(S.before.text), `预先摆出旧句数（${S.before.text}）`);
ok(!/（\d+ 句）/.test(S.after.text), `重新开始后按钮文案已复位（${S.after.text}）`);
ok(S.after.disabled === true, '重新开始后按钮是禁用状态');
ok(S.after.listHidden === true, '列表已收起（不再显示上一轮清单）');

console.log('\n── ③ 切换稿件时浮层整个收掉（按钮也不留旧数据）──');
const switched = await evalJS(`(async () => {
  const apply = document.getElementById('realign-apply');
  const overlay = document.getElementById('realign-overlay');
  // 先把浮层摆成"有旧数据"的样子
  overlay.hidden = false;
  document.getElementById('realign-list').hidden = false;
  document.getElementById('realign-list').innerHTML = '<label class="reflect-item is-on"><input type="checkbox"><span class="ri-body"><span class="ri-head"><span class="ri-range">旧稿件</span></span></span></label>';
  apply.disabled = false;
  apply.textContent = '应用选中项（3927 句）';
  if (typeof window.__realignReset === 'function') window.__realignReset();
  await new Promise(r => setTimeout(r, 200));
  return JSON.stringify({
    hasHook: typeof window.__realignReset === 'function',
    overlayHidden: overlay.hidden,
    listHidden: document.getElementById('realign-list').hidden,
    listEmpty: document.getElementById('realign-list').children.length === 0,
    applyText: apply.textContent,
    applyDisabled: apply.disabled,
  });
})()`);
console.log('   ', switched);
const W = JSON.parse(switched);
ok(W.hasHook, '切稿件钩子 window.__realignReset 已就位');
ok(W.overlayHidden === true, '浮层已收起');
ok(W.listHidden === true && W.listEmpty === true, '清单已清空');
ok(!/（\d+ 句）/.test(W.applyText) && W.applyDisabled === true, `按钮回到初始态（${W.applyText} / disabled=${W.applyDisabled}）`);

console.log('\n── ④ 无 JS 报错 ──');
ok(pageErrors.length === 0, '控制台没有 error', pageErrors.slice(0, 3).join(' | '));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
