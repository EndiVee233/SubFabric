// 复现用户报的 bug：导入字幕 → 导入样式预设 → 改「中文在上」→ 改逐词高亮色
// → 画面上出现**两行重叠**（一行中文+白色高亮、一行中文+绿色高亮）。
//
// 手法：每一步之后 dump ASS 文档的事件统计（总数 / 同时刻重复 / 逐词 span 色标分布），
// 找出"从哪一步开始多出事件"。同时截视频区图做视觉对照。
//
// 用法: node tools/repro_highlight_dup.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9477;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-repro-real1';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\repro-dup';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-dup-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
  `--force-device-scale-factor=1`, `${APP}/editor/studio.html#/project/${PROJ}`,
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
await send('Log.enable');
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
});
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(5500);

/** 统计 ASS 文档：事件数 / 同时刻重复 / 逐词 span 色标 */
const STAT = `(() => {
  const doc = (window.__state && window.__state.assDoc) || null;
  if (!doc) return JSON.stringify({ err: 'no assDoc (state 未挂 window，试 ?debug)' });
  const evs = doc.events || [];
  const key = (e) => e.start + '|' + (e.style || '');
  const byKey = new Map();
  for (const e of evs) byKey.set(key(e), (byKey.get(key(e)) || 0) + 1);
  const dupGroups = [...byKey.entries()].filter(([, n]) => n > 1);
  const colors = {};
  let withSpan = 0;
  for (const e of evs) {
    const t = String(e.text || '');
    const m = t.match(/\\\\c&H([0-9A-Fa-f]{6})&/g);
    if (m) { withSpan++; for (const x of m) colors[x] = (colors[x] || 0) + 1; }
  }
  const zhN = evs.filter(e => (e.style || '').includes('中文')).length;
  const enN = evs.filter(e => (e.style || '').toLowerCase() === 'default').length;
  return JSON.stringify({
    total: evs.length, zhStyle: zhN, enStyle: enN,
    dupStartStyleGroups: dupGroups.length,
    dupSamples: dupGroups.slice(0, 3).map(([k, n]) => k + ' ×' + n),
    eventsWithColorSpan: withSpan,
    colors,
    wordColorMeta: (() => { try { return doc.getScriptInfoComment('SubFabricWordHighlightColor'); } catch { return null; } })(),
    wordColorInput: (document.getElementById('ass-style-word-color') || {}).value || null,
    orderVal: (document.getElementById('ass-style-order') || {}).value || null,
    orderShown: (document.getElementById('ass-style-order-val') || {}).textContent || null,
  });
})()`;

const stat = async (label) => {
  const raw = await evalJS(STAT);
  console.log('\\n【' + label + '】');
  if (typeof raw === 'object' && raw.__err) { console.log('  ' + raw.__err); return null; }
  let d;
  try { d = JSON.parse(raw); } catch { console.log('  ' + raw); return null; }
  console.log('  事件 ' + d.total + '（中文样式 ' + d.zhStyle + ' / 英文样式 ' + d.enStyle + '）'
    + '  含色标事件 ' + d.eventsWithColorSpan);
  console.log('  同时刻+同样式重复组: ' + d.dupStartStyleGroups + (d.dupSamples.length ? '  ' + JSON.stringify(d.dupSamples) : ''));
  console.log('  色标分布: ' + JSON.stringify(d.colors));
  console.log('  元数据逐词色: ' + d.wordColorMeta + '   输入框: ' + d.wordColorInput + '   顺序: ' + d.orderVal + '/' + d.orderShown);
  return d;
};

const shot = async (label) => {
  const clip = await evalJS(`(() => { const el = document.getElementById('video-stage'); const b = el.getBoundingClientRect();
    return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
  if (typeof clip === 'string') {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
    if (r?.data) { writeFileSync(OUT + '-' + label + '.png', Buffer.from(r.data, 'base64')); console.log('  截图: ' + OUT + '-' + label + '.png'); }
  }
};

// 先把 debug 打开，state 才会挂到 window（main.js 只在 URL 带 debug 时挂）
const hasState = await evalJS('!!(window.__state && window.__state.assDoc)');
if (!hasState) {
  console.log('state 未挂 window → 带 ?debug 重新加载');
  await evalJS(`location.href = location.href.split('?')[0].split('#')[0] + '?debug#/project/${PROJ}'`);
  await sleep(6000);
}

await stat('① 打开稿件（导入字幕创建初稿后的状态）');
await shot('1-open');

// ── ② 构造一份"白色逐词高亮"的样式预设并导入 ──
const mk = await evalJS(`(() => {
  const doc = window.__state.assDoc;
  const preset = {
    kind: 'subfabric.ass-style-preset', version: 1, createdBy: 'SubFabric',
    createdAt: new Date().toISOString(),
    tracks: {
      zh: (() => { const r = doc.styles.get('中文字幕'.toLowerCase()); return { track: 'zh', styleName: r.name, format: r.format.slice(), values: r.values.slice() }; })(),
      en: (() => { const r = doc.styles.get('default'); return { track: 'en', styleName: r.name, format: r.format.slice(), values: r.values.slice() }; })(),
    },
    wordColor: '#ffffff',
    kBase: '#ffffff',
    kSweep: false,
  };
  window.__testPreset = JSON.stringify(preset);
  return 'preset ready, zh=' + preset.tracks.zh.styleName + ' en=' + preset.tracks.en.styleName;
})()`);
console.log('\\n构造预设:', mk);

const imported = await evalJS(`(async () => {
  const dt = new DataTransfer();
  dt.items.add(new File([window.__testPreset], 'test.style-preset.json', { type: 'application/json' }));
  const inp = document.getElementById('ass-style-preset-file');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  return 'imported';
})()`);
console.log('导入预设:', imported);
await stat('② 导入样式预设（逐词色 = 白）之后');
await shot('2-preset');

// ── ③ 切换「中文在上」 ──
const ordered = await evalJS(`(async () => {
  const sel = document.getElementById('ass-style-order');
  const before = sel.value;
  sel.value = 'zh-top';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  return JSON.stringify({ before, after: sel.value });
})()`);
console.log('\\n切换顺序:', ordered);
await stat('③ 改为「中文在上」之后');
await shot('3-order');

// ── ④ 改逐词高亮色（走取色器入口：data-color-input）──
const recolored = await evalJS(`(async () => {
  const inp = document.getElementById('ass-style-word-color');
  const before = inp.value;
  inp.value = '#00ff00';
  // 上游自绘取色器接管了 data-color-input；两种事件都发一遍，确保触发应用
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  return JSON.stringify({ before, after: inp.value });
})()`);
console.log('\\n改逐词高亮色:', recolored);
const final = await stat('④ 把逐词高亮色改成绿色之后');
await shot('4-recolor');

console.log('\\n页面 error:', errors.length ? JSON.stringify(errors.slice(0, 3)) : '无');
ws.close(); edge.kill();
