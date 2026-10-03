/* 字幕列表卡顿归因探针(真实应用内, 只读不改产品代码)
 *
 * 背景: 5000 条稿件删一条后, 主线程被占住约 5s。
 *       在真实页面里量到: _render 同步仅 ~65ms, 强制布局 ~300-630ms,
 *       而"等到真正画完"要 ~4300ms —— 开销在渲染管线内部, 不在 JS。
 *       本探针用 CDP Performance 指标把这段时间拆成
 *         RecalcStyle(样式重算) / Layout(布局) / Script(JS) / 其余(绘制·光栅)
 *       并对若干候选 CSS 方案做同条件对照, 为选型提供依据。
 *
 * 用法: node tools/cue_list_jank_probe.mjs [行数=5000]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PROBE_PORT || 8411);
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9411);
const N = Number(process.argv[2] || 5000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 候选方案: 全部只改 CSS, 不动 DOM 结构与索引语义 */
const VARIANTS = [
  { id: '', cls: '', note: '现状基线' },
  { id: 'oc', cls: 'oc', css: '#cue-spacer.oc .cue-card{overflow:clip}', note: 'overflow:clip' },
  { id: 'ov', cls: 'ov', css: '#cue-spacer.ov .cue-card{overflow:visible}', note: 'overflow:visible' },
  { id: 'br0', cls: 'br0', css: '#cue-spacer.br0 .cue-card{border-radius:0}', note: 'border-radius:0(留裁剪)' },
  { id: 'cv2', cls: 'cv2', css: '#cue-spacer.cv2 .cue-card{content-visibility:auto;contain-intrinsic-size:auto 744px auto 86px}', note: 'cv+宽高 intrinsic' },
  { id: 'oc_cv', cls: 'oc_cv', css: '#cue-spacer.oc_cv .cue-card{overflow:clip;content-visibility:auto;contain-intrinsic-size:auto 744px auto 86px}', note: 'clip + cv' },
  { id: 'sp', cls: 'sp', css: '#cue-spacer.sp{contain:layout style}', note: 'spacer contain:layout style' },
];

const SETUP = `(() => {
  const dbg = window.__dbg, panel = dbg.panel;
  const listEl = panel.listEl, spacer = panel.spacerEl;

  for (const v of window.__variants) {
    if (!v.css) continue;
    const st = document.createElement('style');
    st.textContent = v.css; st.dataset.variant = v.id;
    document.head.appendChild(st);
  }

  const ZH = ['这就是我为什么一直在这里等你的原因','别急','我们先把这个东西拆开看看','他说这句话的时候我就在旁边','所以到底发生了什么'];
  const EN = ['This is exactly why I have been waiting here for you','Hold on','Let us take this thing apart first','I was right there when he said it','So what on earth happened'];
  const items = [];
  for (let i = 0; i < window.__n; i++) {
    const s = i * 3.2;
    items.push({ kind:'ass-row', ref:{}, no:i+1, start:s, end:s+2.8,
      l1: ZH[i % ZH.length] + (i % 7 === 0 ? '，结果还是没赶上最后一班车' : ''),
      l2: EN[i % EN.length],
      badge1: i % 3 === 0 ? '中文字幕' : '', badge2: i % 5 === 0 ? '英文字幕' : '',
      color: i % 4 === 0 ? '#ff7a45' : null, speaker: i % 6 === 0 ? '[Spoke]' : '',
      isNew: false, bad: i % 97 === 0, badReason: i % 97 === 0 ? '测试异常' : '' });
  }
  window.__items = items;
  window.__tasks = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__tasks.push(Math.round(e.duration)); });
    po.observe({ entryTypes: ['longtask'] });
    window.__po = po;
  } catch (e) {}

  window.__geom = {
    panelW: Math.round(document.getElementById('editor-panel').getBoundingClientRect().width),
    listW: Math.round(listEl.getBoundingClientRect().width),
    listH: Math.round(listEl.clientHeight),
  };

  /* 一次完整重建: 同步 → 强制布局 → 两帧后(真正画完) */
  window.__once = async function (id, cls) {
    for (const c of ['oc','ov','br0','cv2','oc_cv','sp']) spacer.classList.remove(c);
    if (cls) spacer.classList.add(cls);
    panel.items = items; panel.filtered = items;
    listEl.scrollTop = 0;
    await new Promise(r => requestAnimationFrame(r));
    window.__tasks.length = 0;
    const t0 = performance.now();
    panel._render();
    const tSync = performance.now() - t0;
    const l0 = performance.now();
    void spacer.offsetHeight;
    const tLayout = performance.now() - l0;
    const p0 = performance.now();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tPaint = performance.now() - p0;
    await new Promise(r => setTimeout(r, 200));
    return { sync:+tSync.toFixed(1), layout:+tLayout.toFixed(1), paint:+tPaint.toFixed(1),
      total:+(tSync+tLayout+tPaint).toFixed(1), nodes: spacer.querySelectorAll('*').length,
      spacerH: Math.round(spacer.offsetHeight), longTasks: window.__tasks.slice(0,6) };
  };

  /* 虚拟化对照: 只渲染可视 40 行 + 撑高占位 */
  window.__windowed = async function () {
    for (const c of ['oc','ov','br0','cv2','oc_cv','sp']) spacer.classList.remove(c);
    const t0 = performance.now();
    spacer.style.height = (items.length * 92) + 'px';
    spacer.innerHTML = items.slice(0, 40).map((it, i) =>
      '<div class="cue-card" data-idx="' + i + '"><div class="cc-times"><div class="cc-t"><span>开始</span><b>00:00</b></div></div><div class="cc-body"><div class="cc-l1">' + it.l1 + '</div><div class="cc-l2">' + it.l2 + '</div></div></div>').join('');
    const tSync = performance.now() - t0;
    const l0 = performance.now(); void spacer.offsetHeight; const tLayout = performance.now() - l0;
    const p0 = performance.now(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const tPaint = performance.now() - p0;
    return { sync:+tSync.toFixed(1), layout:+tLayout.toFixed(1), paint:+tPaint.toFixed(1), total:+(tSync+tLayout+tPaint).toFixed(1), nodes: spacer.querySelectorAll('.cue-card').length };
  };

  window.__teardown = function () {
    for (const c of ['oc','ov','br0','cv2','oc_cv','sp']) spacer.classList.remove(c);
    spacer.style.height = ''; spacer.innerHTML = ''; listEl.scrollTop = 0;
    if (window.__po) { try { window.__po.disconnect(); } catch (e) {} }
  };
  return window.__geom;
})()`;

/* ── 启动服务 + 浏览器 ── */
const server = spawn(process.execPath, [join(ROOT, 'editor', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
let serverUp = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) { serverUp = true; break; } } catch {}
}
if (!serverUp) { console.error('服务未起来'); server.kill(); process.exit(1); }

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + join(process.env.TEMP || '.', 'edge-jank-probe-' + Date.now()),
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1600,1000',    // 桌面布局(窄屏 <900px 是纵向堆叠, 列表不受高度约束)
  `http://127.0.0.1:${PORT}/editor/index.html`
], { stdio: 'ignore' });

const cleanup = () => { try { edge.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes(String(PORT))) || list.find(t => t.type === 'page');
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.error('未找到页面目标'); cleanup(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Performance.enable');
await sleep(3000);

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result && r.result.value;
};
const metrics = async () => {
  const r = await send('Performance.getMetrics');
  const o = {}; for (const x of r.metrics) o[x.name] = x.value; return o;
};
const diff = (a, b) => ({
  style: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
  layout: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000),
  script: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
  task: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
  layoutCount: Math.round(b.LayoutCount - a.LayoutCount),
  styleCount: Math.round(b.RecalcStyleCount - a.RecalcStyleCount),
});

await send('Runtime.evaluate', { expression: `window.__variants=${JSON.stringify(VARIANTS)};window.__n=${N};`, returnByValue: true });
const geom = await evalJs(SETUP);

console.log(`=== 字幕列表卡顿归因 (${N} 条, 真实应用内) ===`);
console.log('面板几何:', JSON.stringify(geom));

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 500 });
await send('Profiler.start');

const rows = [];
for (const v of VARIANTS) {
  await evalJs(`window.__once(${JSON.stringify(v.id)},${JSON.stringify(v.cls)})`);   // 预热一遍
  const m0 = await metrics();
  const t = await evalJs(`window.__once(${JSON.stringify(v.id)},${JSON.stringify(v.cls)})`);
  const m1 = await metrics();
  rows.push({ ...v, ...t, metrics: diff(m0, m1) });
}

const win0 = await metrics();
const window40 = await evalJs('window.__windowed()');
const win1 = await metrics();
window40.metrics = diff(win0, win1);

await evalJs('window.__teardown()');
const prof = await send('Profiler.stop');

console.log('\n方案                    同步   强制布局    首帧     合计   节点    撑高   longtask');
for (const r of rows) {
  console.log(
    String(r.note).padEnd(22) +
    String(r.sync).padStart(7) + String(r.layout).padStart(9) + String(r.paint).padStart(9) +
    String(r.total).padStart(9) + String(r.nodes).padStart(8) + String(r.spacerH).padStart(8) +
    '   ' + JSON.stringify(r.longTasks)
  );
}
console.log('\n渲染管线指标(区间差值, ms)  style=样式重算 layout=布局 script=JS task=主线程总占用');
for (const r of rows) console.log('  ' + String(r.note).padEnd(22) + JSON.stringify(r.metrics));
console.log('  ' + String('虚拟化(仅 40 行)').padEnd(22) + JSON.stringify(window40.metrics) + '  ' + JSON.stringify({ sync: window40.sync, layout: window40.layout, paint: window40.paint, total: window40.total }));

if (prof && prof.profile) {
  const { nodes, samples, timeDeltas } = prof.profile;
  const byId = new Map(nodes.map(nd => [nd.id, nd]));
  const self = new Map();
  for (let i = 0; i < samples.length; i++) {
    const nd = byId.get(samples[i]);
    if (!nd) continue;
    const dt = (timeDeltas[i] || 0) / 1000;
    const f = nd.callFrame || {};
    const name = (f.functionName || '(anonymous)') + (f.url ? ' @ ' + String(f.url).split('/').slice(-1)[0] + ':' + (f.lineNumber + 1) : '');
    self.set(name, (self.get(name) || 0) + dt);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\n=== CPU Profile 自身耗时 Top10 ===');
  for (const [k, v] of top) console.log('  ' + String(Math.round(v)).padStart(6) + 'ms  ' + k);
}
cleanup();
