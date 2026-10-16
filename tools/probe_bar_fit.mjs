// 用**线性拟合**标定进度条：拖动滑块到多个像素位置，记下 (像素, currentTime)，拟合斜率。
//   轨道宽 = 时长 / 斜率(秒每像素)
//   左内边距 = 拟合出的"时间=0 时的像素位置"
// 比单次拖动可靠：多点多轮，斜率用最小二乘，还能报拟合优度（残差大说明有非线性/干扰）。
//
// 用法: node tools/probe_bar_fit.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9399;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const detail = await (await fetch(`${APP}/api/projects/${PROJ}`)).json();
if (!detail?.video?.path) { console.log('该项目没有视频'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'edge-fit-'));
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

await sleep(4000);
const prep = JSON.parse(await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (v.readyState < 1) await new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
  const r = v.getBoundingClientRect();
  return JSON.stringify({ dur: v.duration, x: r.x, y: r.y, w: r.width, h: r.height });
})()`));
const vx = prep.x, vw = prep.w, dur = prep.dur;
const barY = Math.round(prep.y + prep.h - 14);
console.log(`元素宽 ${Math.round(vw)}  时长 ${dur.toFixed(0)}s  barY=${barY}`);

/** 点住并拖到元素内某个绝对偏移，松手后读 currentTime。 */
async function seekByDrag(d) {
  const x = Math.round(vx + d);
  // 从别处按下、拖到目标位置再松手 —— 这样"按下点"不影响结果（Chrome 是"跟手"的）
  const xs = Math.round(vx + vw * 0.5);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xs, y: barY, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xs, y: barY, button: 'left', clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(xs + (x - xs) * i / steps), y: barY, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(45);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: barY, button: 'left', clickCount: 1 });
  await sleep(420);
  return await evalJS('document.getElementById("video").currentTime');
}

const pts = [];
// 采样点特意"往两端挤"：边界只能靠贴边的点定准，中间的点对 j0/j1 几乎没约束力。
const fracs = process.env.BOUNDS
  ? [0.004, 0.008, 0.015, 0.03, 0.06, 0.12, 0.5, 0.88, 0.94, 0.97, 0.985, 0.992, 0.996]
  : [0.06, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.88, 0.94];
const offsets = fracs.map(f => Math.round(vw * f));
console.log('\n偏移(px)  currentTime(s)   时间占比');
for (const d of offsets) {
  const t = await seekByDrag(d);
  if (typeof t !== 'number') { console.log(`  ${d}  读不到时间`); continue; }
  pts.push([d, t]);
  console.log(`  ${String(d).padStart(4)}   ${t.toFixed(1).padStart(9)}   ${(t / dur * 100).toFixed(2)}%`);
}

// 最小二乘：t = a*d + b
const n = pts.length;
const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const b = (sy - a * sx) / n;
let ssRes = 0, ssTot = 0;
const ybar = sy / n;
for (const [d, t] of pts) { ssRes += (t - (a * d + b)) ** 2; ssTot += (t - ybar) ** 2; }
const r2 = 1 - ssRes / ssTot;

const trackPx = dur / a;                 // 轨道宽（秒/像素的倒数 × 时长）
const insetPx = -b / a;                  // 时间=0 对应的像素偏移
console.log(`\n拟合: currentTime = ${a.toFixed(4)} × px ${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(1)}   R²=${r2.toFixed(5)}`);
console.log(`  轨道宽   = ${trackPx.toFixed(1)} px   （占元素宽 ${(trackPx / vw * 100).toFixed(2)}%）`);
console.log(`  左内边距 = ${insetPx.toFixed(1)} px   （占元素宽 ${(insetPx / vw * 100).toFixed(2)}%）`);
console.log(`  右内边距 = ${(vw - insetPx - trackPx).toFixed(1)} px   （占元素宽 ${((vw - insetPx - trackPx) / vw * 100).toFixed(2)}%）`);

/* ── 拟合出"插值边界框" j0 / j1 ──────────────────────────────────────────
 * 用 t/dur = (off − j0) / (j1 − j0) 这个两步映射去套实测点：
 * 不再假设 j0 是整数、j1 是 clientWidth−某个数，而是让数据自己把两个边界定出来。
 * 做法：把实测点 (off, frac) 做同样的一次拟合，直接读出 j0 与 j1。 */
const fr = pts.map(([d, t]) => [d, t / dur]);
const m = fr.length;
const fx = fr.reduce((s, p) => s + p[0], 0), fy = fr.reduce((s, p) => s + p[1], 0);
const fxx = fr.reduce((s, p) => s + p[0] * p[0], 0), fxy = fr.reduce((s, p) => s + p[0] * p[1], 0);
const k2 = (m * fxy - fx * fy) / (m * fxx - fx * fx);      // frac per px
const c2 = (fy - k2 * fx) / m;
const j0 = -c2 / k2;
const j1 = (1 - c2) / k2;
let res2 = 0;
for (const [d, f] of fr) res2 += (f - (k2 * d + c2)) ** 2;
console.log(`\n同样的点换成"时间占比"再拟合: frac = ${k2.toExponential(4)} × off + ${c2.toFixed(5)}`);
console.log(`  → 边界框: off=${j0.toFixed(2)} 处 frac=0，off=${j1.toFixed(2)} 处 frac=1`);
console.log(`  → 即 leftInset=${j0.toFixed(2)}px，trackWidth=${(j1 - j0).toFixed(2)}px，innerWidth=${(vw - j1).toFixed(2)}px`);
console.log(`  JSON2: ${JSON.stringify({ vw: Math.round(vw), j0: +j0.toFixed(2), j1: +j1.toFixed(2), trackW: +(j1 - j0).toFixed(2) })}`);
console.log(`\nJSON: ${JSON.stringify({ vw: Math.round(vw), trackPx: +trackPx.toFixed(1), trackFrac: +(trackPx / vw).toFixed(4), insetPx: +insetPx.toFixed(1), insetFrac: +(insetPx / vw).toFixed(4), r2: +r2.toFixed(5) })}`);

ws.close(); edge.kill();
