// 复现"确认弹窗出现在界面下方"的 bug:
// 加载首页 → 显示 #confirm-overlay → 读取它的实际位置与 containing block
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const URL = process.argv[2] || 'http://127.0.0.1:8321/editor/index.html#home';
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
  else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await sleep(2500);

const expr = `(async () => {
  const out = {};
  const ov = document.getElementById('confirm-overlay');
  if (!ov) return JSON.stringify({ error: 'no #confirm-overlay' });

  // 模拟 project.js 删除项目的 showConfirm 调用
  document.getElementById('confirm-title').textContent = '删除项目';
  document.getElementById('confirm-msg').textContent = '探针测试';
  ov.hidden = false;
  await new Promise(r => setTimeout(r, 300));

  const r = ov.getBoundingClientRect();
  out.rect = { top: r.top, left: r.left, width: r.width, height: r.height };
  out.vw = innerWidth; out.vh = innerHeight;
  out.position = getComputedStyle(ov).position;
  out.insetProps = ['top','right','bottom','left'].map(p => getComputedStyle(ov)[p]).join(',');
  out.zIndex = getComputedStyle(ov).zIndex;
  out.display = getComputedStyle(ov).display;

  const box = ov.querySelector('.rn-box')?.getBoundingClientRect();
  out.boxRect = box ? { top: box.top, left: box.left, w: box.width, h: box.height } : null;

  // 找 containing block: 向上找有 transform/filter/perspective/contain/will-change 的祖先
  let el = ov.parentElement, cbChain = [];
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    const props = [];
    if (cs.transform !== 'none') props.push('transform=' + cs.transform.slice(0, 40));
    if (cs.filter !== 'none') props.push('filter=' + cs.filter);
    if (cs.backdropFilter && cs.backdropFilter !== 'none') props.push('backdrop=' + cs.backdropFilter);
    if (cs.contain && cs.contain !== 'none') props.push('contain=' + cs.contain);
    if (cs.willChange && cs.willChange !== 'auto') props.push('willChange=' + cs.willChange);
    if (cs.containerType && cs.containerType !== 'normal') props.push('containerType=' + cs.containerType);
    if (props.length) cbChain.push(el.id || el.className.toString().slice(0, 30) + ' → ' + props.join(' | '));
    el = el.parentElement;
  }
  out.containingBlockSuspects = cbChain;
  out.parentChain = (() => { let c = [], e = ov; while (e && e !== document.body) { c.push(e.id || e.tagName); e = e.parentElement; } return c.join(' < '); })();

  // 对比: 设置弹窗(body 直属)的位置
  const st = document.getElementById('st-overlay');
  if (st) { st.hidden = false; await new Promise(r => setTimeout(r, 200)); const sr = st.getBoundingClientRect(); out.stRect = { top: sr.top, left: sr.left, w: sr.width, h: sr.height }; st.hidden = true; }
  ov.hidden = true;
  return JSON.stringify(out);
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('=== 结果 ===');
console.log(res?.result?.value || JSON.stringify(res));
console.log('=== 异常 ===');
console.log(logs.length ? logs.join('\n') : '(无)');
ws.close();
edge.kill();
process.exit(0);
