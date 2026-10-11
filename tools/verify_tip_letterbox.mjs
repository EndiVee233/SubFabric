// 几何台架验证：**非 16:9**（4:3）素材下，进度条悬浮时间的横向换算是否用对了"去黑边"矩形。
// 这条逻辑只有在长宽比不匹配时才看得出错，所以必须用一个真 4:3 视频跑。
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
  '--window-size=1280,900', url,
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

const meta = await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (v.readyState < 1) await new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
  return JSON.stringify({ vw: v.videoWidth, vh: v.videoHeight, dur: v.duration, rs: v.readyState });
})()`);
console.log('视频:', meta);
const m = JSON.parse(meta);
if (!m.vw) { console.log('视频没加载（file:// 被拒？）'); edge.kill(); process.exit(1); }

const geo = await evalJS(`(() => {
  const v = document.getElementById('video'); const r = v.getBoundingClientRect();
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
})()`);
const g = JSON.parse(geo);
console.log('元素几何:', geo);

// 期望的"去黑边"矩形（与 pictureRect 同一算法，这里独立算一遍做对照）
const vr = m.vw / m.vh, er = g.w / g.h;
let rw = g.w, rh = g.h;
if (er > vr) rw = Math.floor(g.h * vr); else rh = Math.floor(g.w / vr);
const picLeft = g.x + (g.w - rw) / 2, picTop = g.y + (g.h - rh) / 2;
console.log(`素材 ${m.vw}x${m.vh}（${vr.toFixed(3)}）  元素 ${Math.round(g.w)}x${Math.round(g.h)}（${er.toFixed(3)}）`);
console.log(`→ 去黑边后画面：${rw}x${rh}  左偏移 ${Math.round(picLeft - g.x)}  上偏移 ${Math.round(picTop - g.y)}`);
ok(rw < g.w, '这条素材在元素里确实有左右黑边（否则本条测试没意义）', `画面宽 ${rw} vs 元素宽 ${Math.round(g.w)}`);

const barY = Math.round(picTop + rh - 22);
const readTip = async () => JSON.parse(await evalJS(`(() => {
  const t = document.getElementById('video-hover-tip'); const r = t.getBoundingClientRect();
  return JSON.stringify({ hidden: t.hidden, text: t.textContent, cx: r.left + r.width / 2 });
})()`));
const hover = async (px, py) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py), button: 'none', clickCount: 0 });
  await sleep(110);
  return readTip();
};

console.log('\n── 画面内的相对位置 → 时间，必须按**画面**宽度算（不是元素宽度）──');
for (const frac of [0, 0.25, 0.5, 1]) {
  const px = picLeft + rw * frac;
  const tip = await hover(px, barY);
  const expSec = frac * m.dur;
  const exp = `${Math.floor(expSec / 60)}:${String(Math.floor(expSec % 60)).padStart(2, '0')}`;
  ok(!tip.hidden && tip.text === exp, `画面 ${(frac * 100).toFixed(0)}% 处显示 ${tip.text}（期望 ${exp}）`, `hidden=${tip.hidden}`);
  if (tip.hidden) {
    // 失败的边界要靠数值定位，别靠猜：把"我们算的"和"模块内部算的"并排打出来
    const dbg = await evalJS(`(() => {
      const v = document.getElementById('video'); const s = document.getElementById('video-stage');
      const vw = v.videoWidth, vh = v.videoHeight, w = v.clientWidth, h = v.clientHeight;
      const vr = vw / vh, er = w / h;
      let rwid = w, rhei = h;
      if (er > vr) rwid = Math.floor(h * vr); else rhei = Math.floor(w / vr);
      const st = s.getBoundingClientRect(), vb = v.getBoundingClientRect();
      const pic = { left: (vb.left - st.left) + (w - rwid) / 2, top: (vb.top - st.top) + (h - rhei) / 2, width: rwid, height: rhei };
      const py = ${Math.round(barY)} - vb.top;
      const fromBottom = vb.height - py;
      const px = ${Math.round(px)} - vb.left;
      return JSON.stringify({ pic, vb: { l: vb.left, t: vb.top, w: vb.width, h: vb.height },
        px, fromBottom, inX: (px >= pic.left - 1 && px <= pic.left + pic.width + 1),
        inY: (fromBottom >= 1 && fromBottom <= Math.min(34, 72)), fromBottomRaw: fromBottom });
    })()`);
    console.log('     调试:', dbg);
  }
}

console.log('\n── 黑边里（元素内、画面外）不该显示时间 ──');
const inBarLeft = await hover(g.x + 3, barY);
ok(inBarLeft.hidden, '左侧黑边里悬停不显示提示', `hidden=${inBarLeft.hidden} text=${inBarLeft.text}`);
const aboveLeft = await hover(g.x + 3, picTop + 10);
ok(aboveLeft.hidden, '左侧黑边上方不显示提示');

console.log('\n── 提示块要横向对齐它所指的画面位置 ──');
const mid = await hover(picLeft + rw * 0.5, barY);
ok(Math.abs(mid.cx - (picLeft + rw * 0.5)) < 3, '提示块中心与所指位置对齐',
   `tip中心 ${Math.round(mid.cx)} vs 位置 ${Math.round(picLeft + rw * 0.5)}`);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
