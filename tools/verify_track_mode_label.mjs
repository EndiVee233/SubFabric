// 验收：设置里那个开关的标签已改成「多行字幕轨」，且开关本身照旧能用。
// 为什么要跑真页面：文案要过 i18n 词典（键=原文），只改 HTML 不改词典时界面会**回退成原文**；
// 反过来词典改了 HTML 没改也一样。两处都改对了才在页面上看到新词。
//
// 用法: node tools/verify_track_mode_label.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9411;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-label-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1400,1000', `${APP}/editor/index.html#/home`,
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

// 等 i18n 词典加载完（它会把中文文案过一遍）
await sleep(4500);

console.log('\n── 1. 页面上的标签文案 ──');
const label = await evalJS(`(() => {
  const el = document.querySelector('.setting-name[title*="重叠的块自动分到"]');
  if (!el) return JSON.stringify({ found: false });
  const row = el.closest('.setting-row');
  const val = row && row.querySelector('.setting-val');
  return JSON.stringify({
    found: true, text: el.textContent.trim(), title: el.getAttribute('title'),
    val: val ? val.textContent.trim() : null,
    switchId: (row && row.querySelector('input[type=checkbox]') || {}).id || null,
  });
})()`);
const L = JSON.parse(label);
console.log('   ', label);
ok(L.found === true, '找得到那个设置项');
ok(L.text === '多行字幕轨', `标签文本是「多行字幕轨」（实际「${L.text}」）`);
ok(!L.title.includes('双行：'), '提示里也改成「多行：」了');
ok(/目前最多两条/.test(L.title), '提示补了"目前最多两条"的说明');
ok(L.switchId === 'set-tracks', `还是原来那个开关（id=${L.switchId}）`);

console.log('\n── 2. 词典没有把新文案改回旧词（i18n 键=原文，改错就会回退）──');
const dictHit = await evalJS(`(async () => {
  const d = await (await fetch('lang/zh-CN.json', { cache: 'no-store' })).json();
  return JSON.stringify({
    hasNew: Object.prototype.hasOwnProperty.call(d, '多行字幕轨'),
    hasOld: Object.prototype.hasOwnProperty.call(d, '双行字幕轨'),
    newVal: d['多行字幕轨'] || null,
    titleHasNew: Object.keys(d).some(k => k.includes('多行：重叠的块')),
    titleHasOld: Object.keys(d).some(k => k.includes('双行：重叠的块')),
  });
})()`);
console.log('   ', dictHit);
const D = JSON.parse(dictHit);
ok(D.hasNew && !D.hasOld, '词典有「多行字幕轨」、没有旧键');
ok(D.titleHasNew && !D.titleHasOld, '词典里那条提示也已换成「多行：」的版本');

console.log('\n── 3. 开关本身照旧能用（切到开 → 回显「双行」，再切回来 →「单行」）──');
const toggle = await evalJS(`(async () => {
  const cb = document.getElementById('set-tracks');
  const val = document.getElementById('set-tracks-val');
  const read = () => { try { return localStorage.getItem('ss-track-mode'); } catch { return 'ERR'; } };
  const before = { checked: cb.checked, val: val.textContent.trim(), ls: read() };
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const after = { checked: cb.checked, val: val.textContent.trim(), ls: read() };
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const back = { checked: cb.checked, val: val.textContent.trim(), ls: read() };
  return JSON.stringify({ before, after, back });
})()`);
console.log('   ', toggle);
const T = JSON.parse(toggle);
ok(T.after.checked !== T.before.checked && T.after.val !== T.before.val, '切换后开关状态与回显都变了');
// ⚠ 别去读 window.state.trackMode —— state 是 main.js 的模块级变量、不挂 window（踩过：
//    这一条最初就是这么写的，永远拿 null）。改成读它真正落盘的地方：localStorage。
ok(T.after.ls === 'double', `打开时落到 localStorage 的是 double（实际 ${JSON.stringify(T.after.ls)}）`);
ok(T.back.checked === T.before.checked, '再切一次回到原状（没有残留副作用）');
ok(T.back.ls === 'single', `关回去落到 localStorage 的是 single（实际 ${JSON.stringify(T.back.ls)}）`);

console.log('\n── 4. 无 JS 报错 ──');
ok(pageErrors.length === 0, '控制台没有 error', pageErrors.slice(0, 3).join(' | '));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
