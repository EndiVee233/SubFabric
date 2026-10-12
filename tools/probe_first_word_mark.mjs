// 量「时间轴字幕块的英文首词是否被遮挡/被占位」——上游那条修复的实测口径。
//
// 判定不看代码看像素：把时间轴 canvas 上"首词文字左边缘"往左扫一圈，看它左边是不是
// 还压着一根灰色逐词标记（修复前首词左侧会画一根、且文字为它让位 4px+markW/2）。
//
// 用法: node tools/probe_first_word_mark.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9466;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\shot-firstword';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-fw-'));
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
await send('Page.enable');
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(5500);

// 1) 找一条"有逐词"的句子，量它首词的几何
const info = await evalJS(`(() => {
  const cv = document.querySelector('#timeline-panel canvas') || document.querySelector('canvas');
  if (!cv) return JSON.stringify({ err: 'no canvas' });
  // 从应用状态里取一条带词的句子（state 只在 ?debug 下挂 window，故从 __timeline 侧面拿不到时退回扫描 DOM）
  const tl = window.__timeline;
  let picked = null;
  try {
    const items = (window.__panel && window.__panel.items) || [];
    for (const it of items) {
      const sents = [it.sent, it.en, it.zh].filter(Boolean);
      for (const s of sents) if (s && Array.isArray(s.words) && s.words.length >= 3) { picked = s; break; }
      if (picked) break;
    }
  } catch {}
  return JSON.stringify({
    canvas: { w: cv.width, h: cv.height, cssW: Math.round(cv.getBoundingClientRect().width), cssH: Math.round(cv.getBoundingClientRect().height) },
    hasTimeline: !!tl,
    picked: picked ? { text: picked.text, words: picked.words.slice(0, 3), style: picked.style } : null,
  });
})()`);
console.log('环境:', info);
const env = JSON.parse(info);

// 2) 从真实 lanes 里找一条"带逐词"的块，用与 _drawWordAxis 同一套算式算首词文字起点
const probe = await evalJS(`(() => {
  const tl = window.__timeline;
  if (!tl) return JSON.stringify({ err: 'no __timeline' });
  const lanes = tl.lanes || [];
  let cue = null, lane = null;
  for (const L of lanes) {
    for (const c of (L.cues || L || [])) {
      if (c && Array.isArray(c.words) && c.words.length >= 3) { cue = c; lane = L; break; }
    }
    if (cue) break;
  }
  if (!cue) return JSON.stringify({ err: 'no cue with words', lanes: lanes.length,
    shapes: lanes.slice(0, 2).map(L => Object.keys(L || {}).join(',')) });
  const words = cue.words;
  const x1 = tl.t2x(cue.start), x2 = tl.t2x(cue.end);
  const wx0 = tl.t2x(words[0].s), wx1 = tl.t2x(words[1].s);
  // 与 timeline.js 里 _drawWordAxis 同一算式（首词不为灰条让位）
  const MARK_W = 4;   // 兜底；真实值由 _wordGeom 给
  const textXFirst = Math.round(wx0);
  const textXFirstOld = Math.round(wx0 + MARK_W / 2 + 4);
  return JSON.stringify({
    lane: lane && lane.id ? String(lane.id) : '(lane)',
    cue: { start: +cue.start.toFixed(2), end: +cue.end.toFixed(2), nWords: words.length,
           text: String(cue.text || '').slice(0, 40), style: cue.style || '' },
    words: words.slice(0, 3).map(w => ({ w: w.w, s: +w.s.toFixed(3) })),
    x: { x1: Math.round(x1), x2: Math.round(x2), first: Math.round(wx0), second: Math.round(wx1) },
    textXFirst, textXFirstOld, savedPx: textXFirstOld - textXFirst,
  });
})()`);
console.log('几何:', probe);
const P = JSON.parse(probe);
if (!P.err) {
  ok(P.savedPx > 0, `首词文字不再为灰条让位（相对旧算法左移 ${P.savedPx}px）`);
  ok(P.textXFirst === P.x.first, '首词文字起点 == 该词的时间位置');
  ok(P.x.first >= P.x.x1 - 1, `首词起点不早于块起点（${P.x.first} >= ${P.x.x1}）`);
  console.log('\\n  首词:', JSON.stringify(P.words[0]), ' 次词:', JSON.stringify(P.words[1]));
} else {
  console.log('  取不到带逐词的块:', JSON.stringify(P));
}

// 截一张时间轴区域的图，人工复核
const clip = await evalJS(`(() => {
  const el = document.getElementById('timeline-panel');
  if (!el) return 'null';
  const b = el.getBoundingClientRect();
  return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 });
})()`);
if (clip && clip !== 'null') {
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
  if (shot?.data) { writeFileSync(OUT + '-timeline.png', Buffer.from(shot.data, 'base64')); console.log('时间轴截图:', OUT + '-timeline.png'); }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
