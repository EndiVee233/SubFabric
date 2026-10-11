// 几何台架验证（非 16:9 素材）：进度条悬浮提示的横向映射是否还准。
//
// 为什么单独测这条：16:9 素材下元素与画面重合，看不出"按元素还是按画面"；只有两侧有黑边时
// 两种口径才差得出来。js/video-hover-tip.js 里 trackRect() 对"画面明显比元素窄"的情况
// 是按**画面**贴边铺的（依据见该文件头），这里就用真 4:3 视频把这条假设验掉。
//
// 台架 = 安装目录里的 __tipgeom.html（同样的 DOM 结构 + 真 4:3 视频），跑完删。
// 用法: node tools/verify_tip_letterbox.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9366;
const HARNESS = process.env.HARNESS || 'D:\\SubFabric\\SubFabric\\editor\\__tipgeom.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!existsSync(HARNESS)) { console.log('没有台架页:', HARNESS); process.exit(1); }
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const url = pathToFileURL(HARNESS).href;
const profile = mkdtempSync(join(tmpdir(), 'edge-geom-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required',
  `--window-size=${process.env.WIN || '1400,860'}`, url,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes('__tipgeom')) || list.find(t => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到台架页'); edge.kill(); process.exit(1); }

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

const meta = JSON.parse(await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (v.readyState < 1) await new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
  const r = v.getBoundingClientRect();
  return JSON.stringify({ vw: v.videoWidth, vh: v.videoHeight, dur: v.duration,
    x: r.x, y: r.y, w: r.width, h: r.height });
})()`));
if (!meta.vw) { console.log('视频没加载'); edge.kill(); process.exit(1); }

// 期望的"去黑边"画面矩形（与 pictureRect 同一算法，这里独立算一遍做对照）
const vr = meta.vw / meta.vh, er = meta.w / meta.h;
let picW = meta.w, picH = meta.h;
if (er > vr) picW = Math.floor(meta.h * vr); else picH = Math.floor(meta.w / vr);
const picLeft = meta.x + (meta.w - picW) / 2;
const picTop = meta.y + (meta.h - picH) / 2;
const barY = Math.round(picTop + picH - 14);

console.log(`素材 ${meta.vw}x${meta.vh}（${vr.toFixed(3)}）  元素 ${Math.round(meta.w)}x${Math.round(meta.h)}（${er.toFixed(3)}）  时长 ${meta.dur.toFixed(0)}s`);
console.log(`去黑边画面：${picW}x${picH}  左偏移 ${Math.round(picLeft - meta.x)}px  上偏移 ${Math.round(picTop - meta.y)}px`);
ok(picW < meta.w - 10, '这条素材确实有左右黑边（否则本测试没意义）', `画面宽 ${picW} vs 元素宽 ${Math.round(meta.w)}`);

const readTip = () => evalJS(`(() => {
  const t = document.getElementById('video-hover-tip'); const r = t.getBoundingClientRect();
  return JSON.stringify({ hidden: t.hidden, text: t.textContent, cx: r.left + r.width / 2 });
})()`);
const hover = async (px, py) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py), button: 'none', clickCount: 0 });
  await sleep(110);
  return JSON.parse(await readTip());
};
const parseTip = (t) => { const p = String(t).split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };

// 代码里的假设：画面明显比元素窄时，轨道贴画面铺
const trackLeft = picLeft, trackW = picW;
const tolSec = (meta.dur / trackW) * 3 + 0.9;

console.log('\n── 1. 对拍：滑块真实位置处悬停，读数必须等于当前时间 ──');
console.log('   （若代码错误地按"元素整宽"算，这里在靠两端处会差 5% 左右，必然被抓出来）');
for (const f of [0.1, 0.5, 0.85]) {
  const realTime = await evalJS(`(async () => {
    const v = document.getElementById('video');
    v.currentTime = ${f * meta.dur};
    await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 2000); });
    await new Promise(r => setTimeout(r, 250));
    return v.currentTime;
  })()`);
  const thumbX = trackLeft + trackW * (realTime / meta.dur);
  const tip = await hover(thumbX, barY);
  const got = parseTip(tip.text);
  ok(Math.abs(got - realTime) <= tolSec,
     `当前 ${realTime.toFixed(1)}s（滑块 x≈${Math.round(thumbX)}）→ 读数 ${tip.text}，偏差 ${(got - realTime).toFixed(1)}s（容差 ±${tolSec.toFixed(0)}s）`,
     `hidden=${tip.hidden}`);
}

console.log('\n── 2. 轨道位置 → 时间（画面 0/50/100%）──');
for (const f of [0, 0.5, 1]) {
  const tip = await hover(trackLeft + trackW * f, barY);
  const got = parseTip(tip.text);
  ok(!tip.hidden && Math.abs(got - f * meta.dur) <= tolSec,
     `画面 ${(f * 100).toFixed(0)}% 处读数 ${tip.text}（期望 ${(f * meta.dur).toFixed(1)}s）`);
}

console.log('\n── 3. 黑边里（元素内、画面外）不该显示时间 ──');
const inBarLeft = await hover(meta.x + 3, barY);
ok(inBarLeft.hidden, '左侧黑边里悬停不显示提示', `hidden=${inBarLeft.hidden} text=${inBarLeft.text}`);
const aboveLeft = await hover(meta.x + 3, picTop + 10);
ok(aboveLeft.hidden, '左侧黑边上方不显示提示');

console.log('\n── 4. 提示块横向指向正确（对准滑块，不是对准元素中心）──');
const mid = await hover(trackLeft + trackW * 0.5, barY);
ok(Math.abs(mid.cx - (trackLeft + trackW * 0.5)) < 4, '提示块中心与所指位置对齐',
   `tip中心 ${Math.round(mid.cx)} vs 位置 ${Math.round(trackLeft + trackW * 0.5)}`);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
