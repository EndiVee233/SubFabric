// 实测：鼠标落在原生 <video controls> 的进度条上时，事件被谁接走？
// 这决定"悬浮进度条显示时间"是能靠一个监听实现，还是必须自建控制条。
//
// 用法: node tools/probe_video_controls.mjs [项目id]
// 前置: 服务在 127.0.0.1:8321 上跑着（PORT 可覆盖）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT_CDP = 9344;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 先问服务要这个项目的视频路径，拼出 /api/media URL
const detail = await (await fetch(`${APP}/api/projects/${PROJ}`)).json();
const vpath = detail?.video?.path || '';
if (!vpath) { console.log('该项目没有视频路径，退出'); process.exit(1); }
const mediaUrl = `${APP}/api/media?path=${encodeURIComponent(vpath)}`;
console.log('视频:', vpath.split('\\').pop());
console.log('mediaUrl:', mediaUrl.slice(0, 110) + '…');

const profile = mkdtempSync(join(tmpdir(), 'edge-vc-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT_CDP}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,900', `${APP}/editor/studio.html`,
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
if (!target) { console.log('未找到页面目标'); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');

const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200) };
  return r?.result?.value;
};

// 先把项目页真正打开（首页也有一个 #video，会被项目列表盖住，测不到控制条）
await evalJS(`location.hash = '#/project/${PROJ}'`);
await sleep(3500);
const routed = await evalJS(`(() => {
  const app = document.getElementById('app');
  const stage = document.getElementById('video-stage');
  return {
    hash: location.hash,
    appVisible: !!(app && app.offsetParent !== null),
    stageRect: stage ? JSON.stringify(stage.getBoundingClientRect().toJSON ? stage.getBoundingClientRect().toJSON() : {}) : 'no stage',
    hasProjView: !!document.querySelector('#stage-wrap'),
  };
})()`);
console.log('路由后状态:', JSON.stringify(routed));

// 项目页打开后，视频由 main.js 自己挂 src（走 /api/media）；这里只等它就绪，不覆盖它
const injected = await evalJS(`(async () => {
  const v = document.getElementById('video');
  if (!v) return 'no #video';
  if (!v.currentSrc) { v.src = ${JSON.stringify(mediaUrl)}; }
  if (v.readyState < 1) {
    await new Promise((res) => { v.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 8000); });
  }
  try { v.currentTime = 30; } catch {}
  await new Promise((res) => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 2500); });
  return 'ok readyState=' + v.readyState + ' duration=' + Math.round(v.duration) + ' src=' + (v.currentSrc||'').slice(0,60);
})()`);
console.log('视频就绪:', injected);

await evalJS(`
window.__vc = { moves: [], downs: [] };
(function(){
  const rec = (arr) => (e) => arr.push({
    tgt: (e.target && (e.target.id || e.target.className || e.target.tagName)) + '',
    x: Math.round(e.clientX), y: Math.round(e.clientY), trusted: e.isTrusted,
  });
  document.addEventListener('mousemove', rec(window.__vc.moves), true);
  document.addEventListener('mousedown', rec(window.__vc.downs), true);
})();
`);

const geo = await evalJS(`(() => {
  const v = document.getElementById('video');
  const s = document.getElementById('video-stage');
  const vr = v.getBoundingClientRect(), sr = s.getBoundingClientRect();
  return {
    video: { x: Math.round(vr.x), y: Math.round(vr.y), w: Math.round(vr.width), h: Math.round(vr.height) },
    stage: { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) },
    readyState: v.readyState, duration: Math.round(v.duration), controls: v.controls,
    innerW: innerWidth, innerH: innerHeight,
  };
})()`);
console.log('几何:', JSON.stringify(geo));
const vb = geo.video;
const x = Math.round(vb.x + vb.w * 0.42);

console.log(`\n在 x=${x} 处自底向上逐条派发 mouseMoved（合成输入事件，走浏览器命中测试）:`);
for (let d = 2; d <= 90; d += 6) {
  const y = vb.y + vb.h - d;
  await evalJS('window.__vc.moves.length = 0');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await sleep(90);
  const got = await evalJS('JSON.stringify(window.__vc.moves)');
  const efp = await evalJS(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.id || e.className || e.tagName) : 'null'; })()`);
  console.log(`  距底 ${String(d).padStart(2)}px  事件: ${got}   elementFromPoint: ${efp}`);
}

// 原生控件是否真的接管点击（点进度条 70% 处看 currentTime 变不变）
const before = await evalJS('document.getElementById("video").currentTime');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(vb.x + vb.w * 0.7), y: vb.y + vb.h - 8, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(vb.x + vb.w * 0.7), y: vb.y + vb.h - 8, button: 'left', clickCount: 1 });
await sleep(800);
const after = await evalJS('document.getElementById("video").currentTime');
console.log(`\n点进度条 70% 处: currentTime ${before} → ${after}`);
console.log('  （变了 = 原生控件接管了点击；同时说明命中测试把控制条算作 video 的一部分）');
console.log('down 事件命中:', await evalJS('JSON.stringify(window.__vc.downs)'));

ws.close();
edge.kill();
