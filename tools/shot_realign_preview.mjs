// 给「全片逐词重校对 · 预览」浮层拍真图：往里塞真实条数的行，看是否有压缩/裁切。
// 用法: node tools/shot_realign_preview.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9444;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const N = Number(process.env.N || 45);
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\shot-realign';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-shot-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1400,1000',
  `--force-device-scale-factor=1`, `${APP}/editor/index.html#/project/${PROJ}`,
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

// 用真实渲染函数把列表填满（走 main.js 的 renderRealignList 需要 realignData，这里直接造同样的 DOM）
const built = await evalJS(`(() => {
  const overlay = document.getElementById('realign-overlay');
  const list = document.getElementById('realign-list');
  if (!overlay || !list) return 'no overlay/list';
  const msg = document.getElementById('realign-msg');
  const conf = document.getElementById('realign-conf');
  const sum = document.getElementById('realign-summary');
  const allWrap = document.getElementById('realign-all-wrap');
  const apply = document.getElementById('realign-apply');
  overlay.hidden = false;
  if (conf) conf.hidden = false;
  if (sum) { sum.hidden = false; sum.textContent = '共 ${N} 句：36 句达标（会重排逐词时间）、9 句未达标（保留原样）'; }
  if (allWrap) allWrap.hidden = false;
  if (msg) msg.textContent = '校对完成，确认后应用（未达标的不可勾选）';
  if (apply) { apply.disabled = false; apply.textContent = '应用选中项（36 句）'; }
  list.hidden = false;
  const texts = [
    "G'day ladies and gents, Cubic Meter here, Merging has just announced, new 26.4 content, drop…",
    'Then last month I did some research on that claim and it turns out I was wrong about it…',
    'So I believe the time has come to make the actual oldest escape room in Minecraft history…',
  ];
  let html = '';
  for (let k = 0; k < ${N}; k++) {
    const off = k >= ${N} - 9;
    const picked = !off;
    const c = off ? 0.52 : 0.76;
    const chip = c >= 0.85 ? 'chip-l1' : (c >= 0.7 ? 'chip-conf' : 'chip-conf-low');
    const word = c >= 0.85 ? '高' : (c >= 0.7 ? '中' : '低');
    const mm = String(Math.floor(k / 60)).padStart(2, '0');
    const ss = String(k % 60).padStart(2, '0');
    html += '<label class="reflect-item' + (off ? ' is-off' : '') + (picked ? ' is-on' : '') + '" data-k="' + k + '">'
      + '<input type="checkbox" data-k="' + k + '"' + (picked ? ' checked' : '') + (off ? ' disabled' : '') + '>'
      + '<span class="ri-body">'
      + '<span class="ri-head">'
      + '<span class="cc-chip ' + chip + '">置信度' + word + ' ' + Math.round(c * 100) + '%</span>'
      + '<span class="ri-range">第 ' + (k + 1) + ' 行 · 00:' + mm + ':' + ss + '.000 ~ 00:' + mm + ':' + String((k + 9) % 60).padStart(2, '0') + '.960</span>'
      + '<span class="ri-range">锚点 ' + (10 + (k % 13)) + '/' + (12 + (k % 13)) + ' 词</span>'
      + '</span>'
      + '<span class="ri-text">' + texts[k % 3] + '</span>'
      + '<span class="ri-reason">识别听到：G Day ladies and gents, Cub here, Merging has just announced</span>'
      + '</span></label>';
  }
  list.innerHTML = html;
  return 'ok rows=' + list.children.length;
})()`);
console.log('填列表:', built);
await sleep(600);

const geo = await evalJS(`(() => {
  const box = document.querySelector('#realign-overlay .reflect-box');
  const list = document.getElementById('realign-list');
  const rows = [...list.children];
  const hs = rows.map(r => Math.round(r.getBoundingClientRect().height));
  const cs = getComputedStyle(list);
  return JSON.stringify({
    box: (() => { const b = box.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) }; })(),
    list: (() => { const b = list.getBoundingClientRect(); return { h: Math.round(b.height), scrollH: list.scrollHeight, clientH: list.clientHeight, overflowY: cs.overflowY }; })(),
    rowH: { min: Math.min(...hs), max: Math.max(...hs), first5: hs.slice(0, 5), last5: hs.slice(-5) },
    vh: innerHeight,
  });
})()`);
console.log('几何:', geo);

// 诊断：为什么前几行只有 16px？把它们与"正常行"的计算样式并排 dump 出来
const diag = await evalJS(`(() => {
  const list = document.getElementById('realign-list');
  const rows = [...list.children];
  const info = (el, tag) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag, cls: el.className,
      h: Math.round(r.height), scrollH: el.scrollHeight, clientH: el.clientHeight,
      flex: cs.flex, minHeight: cs.minHeight, height: cs.height, maxHeight: cs.maxHeight,
      display: cs.display, overflow: cs.overflow, boxSizing: cs.boxSizing,
      padding: cs.padding, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      children: [...el.children].map(c => {
        const cr = c.getBoundingClientRect(); const ccs = getComputedStyle(c);
        return { cls: c.className || c.tagName, h: Math.round(cr.height), scrollH: c.scrollHeight,
                 flex: ccs.flex, minHeight: ccs.minHeight, display: ccs.display, overflow: ccs.overflow };
      }),
    };
  };
  return JSON.stringify({ squashed: info(rows[0], 'rows[0]'), normal: info(rows[rows.length - 1], 'rows[last]'), listStyle: {
    display: getComputedStyle(list).display, flexDirection: getComputedStyle(list).flexDirection,
    height: getComputedStyle(list).height, minHeight: getComputedStyle(list).minHeight, flex: getComputedStyle(list).flex,
  } }, null, 1);
})()`);
console.log('\\n=== 诊断（被压扁的行 vs 正常的行）===');
console.log(diag);

// 整页截图 + 列表元素截图
const full = await send('Page.captureScreenshot', { format: 'png' });
if (full?.data) { writeFileSync(OUT + '-full.png', Buffer.from(full.data, 'base64')); console.log('整页图:', OUT + '-full.png'); }
const clip = await evalJS(`(() => { const b = document.querySelector('#realign-overlay .reflect-box').getBoundingClientRect();
  return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
const c = JSON.parse(clip);
const shot = await send('Page.captureScreenshot', { format: 'png', clip: c });
if (shot?.data) { writeFileSync(OUT + '-box.png', Buffer.from(shot.data, 'base64')); console.log('浮层图:', OUT + '-box.png'); }

ws.close(); edge.kill();
