// 进度条几何的横向标定：轨道左内边距与轨道宽度，随**元素宽度**怎么变？
// 决定修法：按比例缩进（写死两个比例）还是按像素缩进（要乘缩放系数）。
//
// 手法（都不依赖截图，直接读 currentTime）：
//   ① 左内边距：时间置 0，从左往右逐点点击，找"时间开始大于 0"的那个像素；
//   ② 轨道宽度：按住滑块右拖一段像素，Δt/Δpx = 秒每像素；轨道宽 = 时长 / (秒每像素)。
// 用法: node tools/probe_bar_geometry.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9388;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const detail = await (await fetch(`${APP}/api/projects/${PROJ}`)).json();
if (!detail?.video?.path) { console.log('该项目没有视频'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'edge-geo-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  `--window-size=${process.env.WIN || '1400,1000'}`, `${APP}/editor/studio.html#/project/${PROJ}`,
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 200) };
  return r?.result?.value;
};
const curTime = () => evalJS('document.getElementById("video").currentTime');

await sleep(4000);
const prep = JSON.parse(await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (v.readyState < 1) await new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
  const r = v.getBoundingClientRect();
  return JSON.stringify({ dur: v.duration, x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight });
})()`));
const vx = prep.x, vw = prep.w, barY = Math.round(prep.y + prep.h - 14);
const dur = prep.dur;
console.log(`元素 ${Math.round(vw)}x${Math.round(prep.h)}  素材 ${prep.vw}x${prep.vh}  时长 ${dur.toFixed(0)}s  barY=${barY}`);

// ── ① 左内边距：时间 0 起，逐点点击，找第一个让时间 > 0 的像素 ──
async function leftInsetPx() {
  let lo = null;
  for (let d = 0; d <= Math.round(vw); d += 4) {
    await evalJS('document.getElementById("video").currentTime = 0');
    await sleep(220);
    const x = Math.round(vx + d);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: barY, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: barY, button: 'left', clickCount: 1 });
    await sleep(160);
    const t = await curTime();
    if (typeof t === 'number' && t > dur * 0.0005) { lo = d; break; }
  }
  // 在 lo-4 到 lo 之间用 1px 粒度细化（若粗扫找到）
  if (lo !== null && lo >= 4) {
    for (let d = lo - 4; d <= lo; d++) {
      await evalJS('document.getElementById("video").currentTime = 0');
      await sleep(220);
      const x = Math.round(vx + d);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: barY, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: barY, button: 'left', clickCount: 1 });
      await sleep(160);
      const t = await curTime();
      if (typeof t === 'number' && t > dur * 0.0005) return d;
    }
  }
  return lo;
}

// ── ② 轨道宽度：拖一段已知像素，Δt/Δpx = 秒每像素 ──
async function trackWidthPx() {
  const t0 = dur * 0.35;
  await evalJS(`document.getElementById("video").currentTime = ${t0}`);
  await sleep(500);
  const start = await curTime();
  const dx = Math.round(vw * 0.25);
  const x0 = Math.round(vx + vw * 0.4);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: barY, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: barY, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0 + dx * i / 6), y: barY, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(70);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x0 + dx), y: barY, button: 'left', clickCount: 1 });
  await sleep(800);
  const end = await curTime();
  const dt = end - start;
  return { secPerPx: dt / dx, trackPx: dur / (dt / dx) };
}

const inset = await leftInsetPx();
const tw = await trackWidthPx();
console.log(`\n左内边距 ≈ ${inset} px   比例 ${(inset / vw).toFixed(4)}`);
console.log(`轨道宽   ≈ ${tw.trackPx.toFixed(1)} px   比例 ${(tw.trackPx / vw).toFixed(4)}`);
console.log(`右内边距 ≈ ${(vw - inset - tw.trackPx).toFixed(1)} px   比例 ${((vw - inset - tw.trackPx) / vw).toFixed(4)}`);
console.log(`\nJSON: ${JSON.stringify({ vw: Math.round(vw), inset, insetFrac: +(inset / vw).toFixed(4), trackPx: +tw.trackPx.toFixed(1), trackFrac: +(tw.trackPx / vw).toFixed(4) })}`);

ws.close(); edge.kill();
