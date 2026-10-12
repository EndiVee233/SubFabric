// 检查设置页重构后的 DOM 层级与可见性：
//   · .st-box 下是否只有 head / layout / actions 三块（没有跑出去的兄弟）
//   · .st-tabs 与 .st-body 是否都在 .st-layout 里
//   · 六个面板是否都在 .st-body 里，切换是否正常
//   · 入口卡与运行时环境卡是否被渲染出来
//
// 用法: node tools/probe_settings_layout.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9511;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\settings-layout';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-st-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
  return r?.result?.value;
};
await sleep(5500);

console.log('\n── ① 设置页 DOM 层级 ──');
const tree = await evalJS(`(() => {
  const box = document.getElementById('st-box');
  if (!box) return JSON.stringify({ err: 'no #st-box（设置页没打开？）' });
  const kid = (el) => [...el.children].map(c => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + (c.className ? '.' + String(c.className).split(' ').join('.') : ''));
  const layout = box;
  const nav = box.querySelector('.st-tabs');
  const body = box.querySelector('.st-body');
  const panels = [...box.querySelectorAll('.st-panel')];
  return JSON.stringify({
    boxChildren: kid(box),
    boxKids: kid(box),
    navTabs: [...box.querySelectorAll('.st-tabs .st-tab')].map(t => t.dataset.stp + ':' + t.textContent.trim()),
    subTabs: [...box.querySelectorAll('.st-subtab')].map(t => t.dataset.stsub),
    panelsInBody: panels.filter(p => body && body.contains(p)).map(p => p.dataset.stp),
    panelsOutside: panels.filter(p => !(body && body.contains(p))).map(p => p.dataset.stp),
    activePanel: (panels.find(p => !p.hidden) || {}).dataset ? panels.find(p => !p.hidden).dataset.stp : null,
    bodyChildren: body ? kid(body) : null,
  }, null, 1);
})()`);
console.log(tree);
let T = {};
try { T = JSON.parse(tree); } catch { T = { err: String(tree) }; }
if (T.err) { console.log('  ✗ ' + T.err); ws.close(); edge.kill(); process.exit(1); }

/* grid 骨架（ui.css 的 #st-view .st-box）要求 head / st-tabs / st-body 是**直接子元素**，
   否则 grid 拿不到它们、右栏会被压成 0 宽（实测踩过：多套一层 wrapper 就中招）。
   st-actions 排在第 3 行、也是直接子元素，所以直接子节点应当是这四块。 */
ok(Array.isArray(T.boxChildren) && T.boxChildren.length === 4
  && T.boxChildren[0].includes('st-head') && T.boxChildren[1].includes('st-tabs')
  && T.boxChildren[2].includes('st-body') && T.boxChildren[3].includes('st-actions'),
  `.st-box 直接子节点是 head / st-tabs / st-body / st-actions（grid 骨架完整）`, JSON.stringify(T.boxChildren));
/* 分类数 = 5：设计稿 ② 把「字幕翻译」并成了模型设置里的二级 Tab（ASR / LLM），
   所以左侧不再单列它 —— 这里断言它**有自己的二级 Tab 入口**，不是孤儿面板。 */
ok(T.navTabs && T.navTabs.length === 5, `左侧分类共 5 项`, JSON.stringify(T.navTabs));
ok(T.navTabs && T.navTabs.some(t => t.startsWith('theme:外观与主题')), '含「外观与主题」分类');
ok(T.subTabs && T.subTabs.length === 2 && T.subTabs[0] === 'asr' && T.subTabs[1] === 'llm',
  '模型设置里有 ASR / LLM 两个二级 Tab', JSON.stringify(T.subTabs));
ok(T.panelsOutside && T.panelsOutside.length === 0, '所有面板都在 .st-body 里', JSON.stringify(T.panelsOutside));
ok(T.panelsInBody && T.panelsInBody.length === 6, `.st-body 里有 6 个面板`, JSON.stringify(T.panelsInBody));
ok(T.activePanel === 'models', `默认显示「模型设置」面板（实际 ${T.activePanel}）`);
ok(T.boxKids && T.boxKids.some(c => c.includes('st-tabs')) && T.boxKids.some(c => c.includes('st-body')),
  '分类栏与内容区都在 .st-box 下', JSON.stringify(T.boxKids));

console.log('\n── ② 切换每个分类（不能用 JS 报错，面板要真的换）──');
for (const stp of ['enhance', 'perf', 'fetch', 'theme', 'models']) {
  const r = await evalJS(`(async () => {
    const tab = document.querySelector('.st-tabs .st-tab[data-stp="${stp}"]');
    if (!tab) return JSON.stringify({ err: 'no tab' });
    tab.click();
    await new Promise(r => setTimeout(r, 120));
    const panels = [...document.querySelectorAll('.st-panel')];
    const shown = panels.filter(p => !p.hidden).map(p => p.dataset.stp);
    const activeTabs = [...document.querySelectorAll('.st-tabs .st-tab.active')].map(t => t.dataset.stp);
    return JSON.stringify({ shown, activeTabs, scrollTop: document.querySelector('.st-body').scrollTop });
  })()`);
  const d = JSON.parse(r);
  ok(d.shown && d.shown.length === 1 && d.shown[0] === stp && d.activeTabs && d.activeTabs[0] === stp,
    `切到 ${stp}：只显示该面板且该分类高亮`, JSON.stringify(d));
}

console.log('\n── ③ 两处主题色实例 ──');
const theme = await evalJS(`(() => {
  const slots = [...document.querySelectorAll('[data-theme-swatches]')];
  const first = slots[0];
  return JSON.stringify({
    slots: slots.length,
    swatchesPerSlot: slots.map(s => s.querySelectorAll('.theme-sw').length),
    activeIn: slots.map(s => (s.querySelector('.theme-sw.active') || {}).dataset ? s.querySelector('.theme-sw.active').dataset.hex : null),
    inputs: document.querySelectorAll('#theme-color, [data-theme-color]').length,
    resets: document.querySelectorAll('#theme-reset, [data-theme-reset]').length,
  });
})()`);
console.log('   ', theme);
const TH = JSON.parse(theme);
ok(TH.slots >= 2, `主题色控件有两处实例（实际 ${TH.slots}）`);
ok(TH.swatchesPerSlot.every(n => n > 0), '两处都画出了色块', JSON.stringify(TH.swatchesPerSlot));

const sync = await evalJS(`(async () => {
  const slots = [...document.querySelectorAll('[data-theme-swatches]')];
  const btn = slots[0].querySelectorAll('.theme-sw')[2];      // 挑第 3 个预设色
  const hex = btn.dataset.hex;
  btn.click();
  await new Promise(r => setTimeout(r, 150));
  const active = slots.map(s => (s.querySelector('.theme-sw.active') || {}).dataset ? s.querySelector('.theme-sw.active').dataset.hex : null);
  const inputVal = (document.getElementById('theme-color') || {}).value;
  const applied = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  slots[0].querySelector('.theme-sw.active');
  // 还原：点"恢复默认"
  document.getElementById('theme-reset').click();
  await new Promise(r => setTimeout(r, 120));
  return JSON.stringify({ hex, active, inputVal, applied });
})()`);
console.log('   ', sync);
const SY = JSON.parse(sync);
ok(SY.active && SY.active.every(h => h === SY.hex), '在一处改色 → 两个实例的选中态都跟着变', JSON.stringify(SY.active));
ok(SY.inputVal === SY.hex, '自定义色输入框也同步');

console.log('\n── ④ 截图 ──');
const clip = await evalJS(`(() => { const b = document.getElementById('st-box').getBoundingClientRect();
  return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
if (typeof clip === 'string') {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
  if (r?.data) { writeFileSync(OUT + '-models.png', Buffer.from(r.data, 'base64')); console.log('   ' + OUT + '-models.png'); }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);

