// 直接量「进度条像素 ↔ 时间」的映射：按住滑块拖动一段已知像素，读 currentTime 的变化。
// 比"点一下看跳到哪"可靠：点击受 Chrome 自身取整影响，拖动则是连续映射，且差值抵消了起点误差。
//
// 用法: node tools/probe_bar_mapping.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9377;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const detail = await (await fetch(`${APP}/api/projects/${PROJ}`)).json();
if (!detail?.video?.path) { console.log('该项目没有视频'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'edge-bar-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1400,1000', `${APP}/editor/index.html#/project/${PROJ}`,
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
const time = () => evalJS('document.getElementById("video").currentTime');

await sleep(4000);
const prep = await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (v.readyState < 1) await new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
  const r = v.getBoundingClientRect();
  return JSON.stringify({ dur: v.duration, x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight });
})()`);
const info = JSON.parse(prep);
console.log('视频/几何:', prep);
const vx = info.x, vw = info.w, vb = info.y + info.h;
const dur = info.dur;

// 进度条纵向位置：先用一次点击扫出"哪条 y 能跳转"，避免把判定带写错
console.log('\n=== 先扫出进度条的纵向位置（哪条 y 点下去会跳转）===');
let barY = null;
for (const d of [8, 14, 20, 26, 32, 40]) {
  const y = Math.round(vb - d);
  await evalJS('document.getElementById("video").currentTime = 600');
  await sleep(400);
  const before = await time();
  const x = Math.round(vx + vw * 0.6);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(700);
  const after = await time();
  const jumped = Math.abs(after - before) > dur * 0.05;
  console.log(`  距底 ${String(d).padStart(2)}px (y=${y}): ${before.toFixed(1)} → ${after.toFixed(1)}  ${jumped ? '★ 会跳转' : ''}`);
  if (jumped && barY === null) barY = y;
}
if (barY === null) { console.log('没扫到可跳转的带子，退出'); ws.close(); edge.kill(); process.exit(1); }
console.log('用于拖动测试的 barY =', barY, '（距底', Math.round(vb - barY), 'px）');

console.log('\n=== 拖动滑块：位移 Δpx → Δt，得到每像素多少秒 ===');
async function dragFromTime(t0, dx) {
  await evalJS(`document.getElementById("video").currentTime = ${t0}`);
  await sleep(500);
  const t0real = await time();
  // 从"当前时间对应的像素位置"起拖：滑块就在那儿
  const x0 = Math.round(vx + vw * (t0real / dur));   // 先按"铺满整宽"假设定位滑块
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: barY, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: barY, button: 'left', clickCount: 1 });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(x0 + dx * i / steps), y: barY, button: 'left', buttons: 1, clickCount: 1,
    });
    await sleep(60);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x0 + dx), y: barY, button: 'left', clickCount: 1 });
  await sleep(800);
  const t1 = await time();
  return { t0: t0real, t1, dt: t1 - t0real };
}

const probes = [
  { t0: dur * 0.20, dx: 200 },
  { t0: dur * 0.20, dx: 400 },
  { t0: dur * 0.50, dx: 300 },
  { t0: dur * 0.50, dx: -300 },
];
const secPerPx = [];
for (const p of probes) {
  const r = await dragFromTime(p.t0, p.dx);
  const spp = r.dt / p.dx;
  secPerPx.push(Math.abs(spp));
  console.log(`  从 ${r.t0.toFixed(0)}s 拖 ${p.dx > 0 ? '+' : ''}${p.dx}px → ${r.t1.toFixed(0)}s  Δt=${r.dt.toFixed(1)}s  ${spp.toFixed(4)} s/px`);
}

const med = secPerPx.slice().sort((a, b) => a - b)[Math.floor(secPerPx.length / 2)];
console.log(`\n=== 结论 ===`);
console.log(`  每像素 ${med.toFixed(4)} s  → 整条轨道宽 ${(dur / med).toFixed(1)} px`);
console.log(`  播放器元素宽 ${vw.toFixed(0)} px`);
console.log(`  轨道宽 / 元素宽 = ${(dur / med / vw).toFixed(4)}`);
console.log(`  → 若接近 1：进度条铺满元素宽（当前实现是对的）；`);
console.log(`    若明显 < 1：左右有内边距，需要按这个比例缩进（例如 0.94 表示两端合计缩进 6%）。`);
console.log(`  另外验证：轨道左端 inset = ? 用"时间为 0 时滑块所在像素"单独测（下一步）。`);

console.log('\n=== 轨道左端：时间 0 时滑块中心在哪 ===');
await evalJS('document.getElementById("video").currentTime = 0');
await sleep(600);
const hits = [];
for (let d = 0; d <= Math.round(vw); d += 8) {
  const x = Math.round(vx + d);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: barY, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: barY, button: 'left', clickCount: 1 });
  await sleep(120);
  const t = await time();
  hits.push([d, t]);
  if (t > dur * 0.002) break;      // 一旦时间开始动，说明已经越过轨道左端
}
const last = hits.slice(-4);
console.log('  从左往右点，时间开始"跳起来"的位置（最后几个采样）:');
for (const [d, t] of last) console.log(`    离元素左缘 ${d}px → ${t.toFixed(2)}s`);
console.log(`  → 时间从 0 开始增长的像素 ≈ ${last.length ? last[last.length - 1][0] : '?'}px（这就是轨道左端内边距的近似）`);

ws.close(); edge.kill();
