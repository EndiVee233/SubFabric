// 量「时间轴字幕块里的英文首词是否被块的左边界裁掉」。
//
// 用户第二次报的遮挡（截图里 `home` 显示成 `ome`）：
//   _drawWordAxis 对首词用 `textX = Math.round(t2x(w.s))`（词的真实位置）—— 若首词起点
//   早于块起点、或与块起点几乎重合，文字就从块的左边界左侧起画，被块的裁剪区切掉左半边。
//
// 用法: node tools/probe_first_word_clip.mjs [项目id] [关键词]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9499;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv26t5hg-gw2ff';
const NEEDLE = process.argv[3] || 'Home';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\probe-clip';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-clip-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
  '--force-device-scale-factor=1', `${APP}/editor/index.html?debug#/project/${PROJ}`,
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(6500);

// 先把视图放大到"块够宽、首词能画出来"的比例（用户截图那种），否则首词因为放不下而根本不画
const zoom = process.env.ZOOM ? Number(process.env.ZOOM) : 400;
await evalJS(`(() => {
  const tl = window.__timeline;
  if (!tl) return 'no tl';
  tl.pxPerSec = ${zoom};
  tl.viewStart = Math.max(0, 5.8 - 60 / ${zoom});   // 把那段挪进视野
  if (tl.touch) tl.touch();
  if (tl._dirty !== undefined) tl._dirty = true;
  if (typeof tl.draw === 'function') tl.draw();
  return 'zoomed';
})()`);
await sleep(600);


// 找那条带 needle 的块，量它的块边界与首词位置
const info = await evalJS(`(() => {
  const tl = window.__timeline;
  if (!tl) return JSON.stringify({ err: 'no __timeline' });
  const needle = ${JSON.stringify(NEEDLE)};
  let cue = null, lane = null;
  for (const L of tl.lanes || []) {
    for (const c of (L.cues || [])) {
      if (c && Array.isArray(c.words) && c.words.length >= 3 && String(c.text || '').includes(needle)) { cue = c; lane = L; break; }
    }
    if (cue) break;
  }
  if (!cue) return JSON.stringify({ err: 'no cue containing ' + needle });
  const words = cue.words;
  const x1 = tl.t2x(cue.start), x2 = tl.t2x(cue.end);
  const ctx = tl.canvas.getContext('2d');
  ctx.font = tl.enFont();
  const w0 = words[0];
  const wx0 = tl.t2x(w0.s);
  const textX = Math.round(Math.max(wx0, x1 + 6));   // 与绘制同一口径（wordTextX / TEXT_PAD=6）
  const tw = ctx.measureText(w0.w).width;
  const nextX = words.length > 1 ? tl.t2x(words[1].s) : Math.min(tl.t2x(cue.end), x2);
  const geom = tl._wordGeom(tl._laneTop(tl.lanes.indexOf(lane)), tl._laneH(tl.lanes.indexOf(lane)));
  return JSON.stringify({
    cue: { start: +cue.start.toFixed(3), end: +cue.end.toFixed(3), text: String(cue.text||'').slice(0, 46), nWords: words.length },
    first: { w: w0.w, s: +w0.s.toFixed(3) },
    second: words[1] ? { w: words[1].w, s: +words[1].s.toFixed(3) } : null,
    px: { x1: Math.round(x1), x2: Math.round(x2), firstWordX: Math.round(wx0), textX,
          textW: Math.round(tw), textRight: Math.round(textX + tw), nextX: Math.round(nextX),
          availFromBlock: Math.round(nextX - x1 - 3) },
    clip: { leftOverhangPx: Math.round(x1 - textX),        // >0 = 文字画到块左边外 → 会被裁
            firstWordStartsBeforeBlock: w0.s < cue.start - 1e-6 },
    markW: geom.markW,
  }, null, 1);
})()`);
console.log('几何:', info);
const G = typeof info === 'string' ? JSON.parse(info) : info;
if (G.err) { console.log('  ' + G.err); ws.close(); edge.kill(); process.exit(1); }

console.log('\n── 判定 ──');
ok(G.clip.firstWordStartsBeforeBlock === false || G.clip.leftOverhangPx <= 0,
  `首词文字没有画到块左边界之外（越界 ${G.clip.leftOverhangPx}px）`,
  `textX=${G.px.textX} 块左界=${G.px.x1}`);
ok(G.px.textX >= G.px.x1, `首词文字起点不在块左侧（${G.px.textX} >= ${G.px.x1}）`);

// 截那段块的图，人工复核
const shotInfo = await evalJS(`(() => {
  const tl = window.__timeline;
  const needle = ${JSON.stringify(NEEDLE)};
  let cue = null;
  for (const L of tl.lanes || []) for (const c of (L.cues || [])) {
    if (c && Array.isArray(c.words) && String(c.text||'').includes(needle)) { cue = c; break; }
  }
  if (!cue) return 'null';
  const cv = tl.canvas.getBoundingClientRect();
  const x1 = tl.t2x(cue.start), x2 = tl.t2x(cue.end);
  return JSON.stringify({ x: Math.max(0, cv.x + x1 - 40), y: cv.y, width: Math.min(cv.width, x2 - x1 + 120), height: cv.height, scale: 2 });
})()`);
if (shotInfo && shotInfo !== 'null') {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(shotInfo) });
  if (r?.data) { writeFileSync(OUT + '-cue.png', Buffer.from(r.data, 'base64')); console.log('\n  该块截图（2x）: ' + OUT + '-cue.png'); }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);


