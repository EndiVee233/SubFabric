// 实测「进度条悬浮时间提示」：真页面 + 真视频 + 合成鼠标事件。
// 用法: node tools/verify_video_hover_tip.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT_CDP = 9355;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '   ' + extra : '')); }
};

const detail = await (await fetch(`${APP}/api/projects/${PROJ}`)).json();
if (!detail?.video?.path) { console.log('该项目没有视频'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'edge-ht-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT_CDP}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,900', `${APP}/editor/index.html#/project/${PROJ}`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes('8321')) || list.find(t => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到页面'); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
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

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};

await sleep(4000);
const ready = await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (!v) return 'no video';
  if (v.readyState < 1) await new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
  try { v.currentTime = 60; } catch {}
  await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 2500); });
  const tip = document.getElementById('video-hover-tip');
  return JSON.stringify({ rs: v.readyState, dur: Math.round(v.duration), tipExists: !!tip, tipHidden: tip ? tip.hidden : null });
})()`);
console.log('就绪:', ready);
const st = JSON.parse(ready);
if (!st.tipExists) { console.log('#video-hover-tip 不存在，测试无法继续'); edge.kill(); process.exit(1); }

const geo = await evalJS(`(() => {
  const v = document.getElementById('video');
  const r = v.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, vw: v.videoWidth, vh: v.videoHeight, dur: v.duration, innerW: innerWidth };
})()`);
console.log('几何:', JSON.stringify(geo));

const picW = geo.w;                       // 16:9 素材正好铺满，黑边为 0
const picLeft = geo.x;
const barY = Math.round(geo.y + geo.h - 14);   // 实测进度条在距底约 14px（8~20px 都会跳转）

// 进度条**可拖动轨道**：约占元素宽 96%，左右对称内缩（实测拟合值，见 js/video-hover-tip.js 文件头）。
// 旧版本这里按"铺满整宽"算，于是测试"通过"了一个错的实现（用户发现读数偏大）。
// 测试必须用与被测代码同一口径的几何，否则它只是在验证自己的假设。
const TRACK_FRAC = 0.96;
const trackLeft = geo.x + geo.w * (1 - TRACK_FRAC) / 2;
const trackW = geo.w * TRACK_FRAC;
// 读数在靠两端约 2px 内会被钳住（实测），所以断言允许 2px 量级的偏差
const TOL_PX = 3;

const readTip = () => evalJS(`(() => {
  const t = document.getElementById('video-hover-tip');
  const r = t.getBoundingClientRect();
  return JSON.stringify({ hidden: t.hidden, text: t.textContent, title: t.title,
    left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    cls: t.className });
})()`);

async function hoverAt(px, py) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py), button: 'none', clickCount: 0 });
  await sleep(120);
  return JSON.parse(await readTip());
}

const fmt = (sec) => {
  const t = Math.floor(sec), h = Math.floor(t / 3600);
  return h > 0
    ? `${h}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
    : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
/** 把提示文本解析回秒，便于按"像素容差"比较而不是要求字面相等。 */
const parseTip = (text) => {
  const p = String(text).split(':').map(Number);
  if (p.some(n => !Number.isFinite(n))) return NaN;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};
/** 轨道像素 → 容差换算：允许 TOL_PX 像素的几何不确定度 */
const tolSec = (geo.dur / trackW) * TOL_PX + 0.9;   // +0.9 覆盖提示只显示整秒

console.log('\n── 1. 轨道位置 → 时间读数（按实测轨道几何：约占元素宽 96%）──');
for (const frac of [0, 0.25, 0.5, 1]) {
  const px = trackLeft + trackW * frac;
  const tip = await hoverAt(px, barY);
  const got = parseTip(tip.text), want = frac * geo.dur;
  ok(!tip.hidden && Math.abs(got - want) <= tolSec,
     `轨道 ${(frac * 100).toFixed(0)}% 处显示 ${tip.text}（期望 ${fmt(want)}±${tolSec.toFixed(0)}s）`,
     `hidden=${tip.hidden} text=${tip.text} got=${got} want=${want.toFixed(1)}`);
  if (frac === 0.5) {
    ok(tip.top + tip.h < barY, '提示块在进度条**上方**（不与进度条重叠）',
       `tip底=${tip.top + tip.h} 进度条=${barY}`);
    ok(tip.title.includes(':'), 'title 带精确时间', tip.title);
  }
}

console.log('\n── 2. 对拍：滑块真实位置处悬停，读数必须等于当前时间（最硬的一条）──');
for (const target of [geo.dur * 0.1, geo.dur * 0.5, geo.dur * 0.8]) {
  const realTime = await evalJS(`(async () => {
    const v = document.getElementById('video');
    v.currentTime = ${target};
    await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 2500); });
    await new Promise(r => setTimeout(r, 300));
    return v.currentTime;
  })()`);
  // 滑块应该在"时间占比 × 轨道宽 + 轨道左"处 —— 这个反推用的是被实测标定过的映射
  const thumbX = trackLeft + trackW * (realTime / geo.dur);
  const tip = await hoverAt(thumbX, barY);
  const got = parseTip(tip.text);
  ok(Math.abs(got - realTime) <= tolSec,
     `当前时间 ${fmt(realTime)}（滑块 x≈${Math.round(thumbX)}）处悬停读数 ${tip.text} — 偏差 ${(got - realTime).toFixed(1)}s`,
     `期望 ${fmt(realTime)}，实际 ${tip.text}`);
}

console.log('\n── 2. 不在进度条上时必须隐藏（不能到处乱弹）──');
for (const [label, px, py] of [
  ['画面正中', picLeft + picW * 0.5, geo.y + geo.h * 0.5],
  ['画面顶部', picLeft + picW * 0.5, geo.y + 20],
  ['进度条上方 60px', picLeft + picW * 0.5, geo.y + geo.h - 82],
]) {
  const tip = await hoverAt(px, py);
  ok(tip.hidden, `${label} 不显示提示`, `hidden=${tip.hidden} text=${tip.text}`);
}

console.log('\n── 3. 轨道两端：读数接近 0 / 时长，且提示块不越界 ──');
const nearL = await hoverAt(trackLeft + 1, barY);
const gotL = parseTip(nearL.text);
ok(!nearL.hidden && gotL <= tolSec, `轨道最左端读数 ${nearL.text}（应接近 0:00）`, `got=${gotL}`);
ok(nearL.left >= geo.x - 1, `最左端提示不越界（left=${nearL.left}，画面 x=${Math.round(geo.x)}）`);
const nearR = await hoverAt(trackLeft + trackW - 1, barY);
const gotR = parseTip(nearR.text);
ok(!nearR.hidden && geo.dur - gotR <= tolSec, `轨道最右端读数 ${nearR.text}（应接近 ${fmt(geo.dur)}）`, `差 ${(geo.dur - gotR).toFixed(1)}s`);
ok(nearR.left + nearR.w <= geo.x + geo.w + 1,
   `最右端提示不越界（右缘=${nearR.left + nearR.w}，画面右缘=${Math.round(geo.x + geo.w)}）`);

console.log('\n── 4. 移出视频后收起 ──');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', clickCount: 0 });
await sleep(200);
const afterLeave = JSON.parse(await readTip());
ok(afterLeave.hidden, '指针移出视频后提示已收起', `hidden=${afterLeave.hidden}`);

console.log('\n── 5. 不能影响原生控件（点进度条仍要能跳转）──');
const t0 = await evalJS('document.getElementById("video").currentTime');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(picLeft + picW * 0.5), y: barY, button: 'none', clickCount: 0 });
await sleep(100);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(picLeft + picW * 0.3), y: barY, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(picLeft + picW * 0.3), y: barY, button: 'left', clickCount: 1 });
await sleep(900);
const t1 = await evalJS('document.getElementById("video").currentTime');
ok(Math.abs(t1 - t0) > 30, '点进度条 30% 处仍能跳转（原生控件没被挡住）', `currentTime ${t0} → ${t1}`);

console.log('\n── 6. 播放中移动鼠标不能干扰播放（passive 监听、绝不 preventDefault）──');
await evalJS('document.getElementById("video").play()');
await sleep(1200);
const p0 = await evalJS('JSON.stringify({paused: document.getElementById("video").paused, t: document.getElementById("video").currentTime})');
for (let i = 0; i < 6; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(picLeft + picW * (0.2 + i * 0.1)), y: barY, button: 'none', clickCount: 0 });
  await sleep(90);
}
const tipPlaying = JSON.parse(await readTip());
const p1 = JSON.parse(await evalJS('JSON.stringify({paused: document.getElementById("video").paused, t: document.getElementById("video").currentTime})'));
const s0 = JSON.parse(p0), s1 = p1;
ok(!s1.paused, '在进度条上连续移动鼠标后视频仍在播放', `paused ${s0.paused} → ${s1.paused}`);
ok(s1.t > s0.t + 0.3, '播放时间在推进（鼠标移动没有把播放卡住）', `currentTime ${s0.t.toFixed(2)} → ${s1.t.toFixed(2)}`);
ok(!tipPlaying.hidden, '播放中悬停进度条照样显示时间', `hidden=${tipPlaying.hidden} text=${tipPlaying.text}`);

console.log('\n── 7. 跳转/拖动时收起重算 ──');
await evalJS('document.getElementById("video").pause()');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(picLeft + picW * 0.5), y: barY, button: 'none', clickCount: 0 });
await sleep(120);
const beforeSeek = JSON.parse(await readTip());
ok(!beforeSeek.hidden, '跳转前提示是显示的');
await evalJS('document.getElementById("video").currentTime = 900');
await sleep(500);
const afterSeek = JSON.parse(await readTip());
ok(afterSeek.hidden, '跳转后提示自动收起（避免显示过时的位置）', `hidden=${afterSeek.hidden} text=${afterSeek.text}`);

console.log('\n── 8. 页面无 JS 报错 ──');
ok(pageErrors.length === 0, '控制台没有 error', pageErrors.slice(0, 3).join(' | '));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
