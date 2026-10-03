/* 专项诊断: 全量渲染 vs 虚拟窗口 下, 同一批卡片的宽度/累计偏移是否一致
 * (虚拟化的位置表是从"实测行高"累加出来的, 只要宽度有一点点差别, 高度就会漂)
 * 用法: node tools/cue_list_offset_diag.mjs [行数=5000]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8451, CDP_PORT = 9451;
const N = Number(process.argv[2] || 5000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pageProbe(n) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const dbg = window.__dbg, panel = dbg.panel;
  const listEl = panel.listEl, spacer = panel.spacerEl;
  const out = { rows: [] };

  const ZH = ['这就是我为什么一直在这里等你的原因', '别急', '我们先把这个东西拆开看看', '他说这句话的时候我就在旁边', '所以到底发生了什么'];
  const EN = ['This is exactly why I have been waiting here for you', 'Hold on', 'Let us take this thing apart first', 'I was right there when he said it', 'So what on earth happened'];
  const items = [];
  for (let i = 0; i < n; i++) {
    const s = i * 3.2;
    items.push({
      kind: 'ass-row', ref: {}, no: i + 1, start: s, end: s + 2.8,
      l1: ZH[i % 5] + (i % 7 === 0 ? '，结果还是没赶上最后一班车' : '') + ' #' + i,
      l2: EN[i % 5] + ' #' + i,
      badge1: i % 3 === 0 ? '中文字幕' : '', badge2: i % 5 === 0 ? '英文字幕' : '',
      color: i % 4 === 0 ? '#ff7a45' : null, speaker: i % 6 === 0 ? '[Spoke]' : '',
      isNew: false, bad: i % 97 === 0, badReason: i % 97 === 0 ? '测试异常' : '',
    });
  }

  const w = () => ({ list: listEl.clientWidth, spacer: spacer.clientWidth, listOffsetW: listEl.offsetWidth });
  out.wBefore = w();

  /* A. 全量渲染(不设高度) */
  spacer.style.height = '';
  spacer.innerHTML = items.map((it, i) => panel._cardHtml(it, i)).join('');
  void spacer.offsetHeight;
  out.wFull = w();
  const full = [];
  const kids = spacer.children;
  const SAMPLE = [0, 1000, 5000, 10000, 15000, 20000, 30000, 40000, n - 1].filter(i => i >= 0 && i < n);
  for (const idx of SAMPLE) {
    full.push({ idx, top: kids[idx].offsetTop, h: kids[idx].offsetHeight, cw: kids[idx].offsetWidth });
  }
  out.full = full;
  out.fullSpacerH = Math.round(spacer.offsetHeight);
  spacer.innerHTML = '';

  /* B. 虚拟窗口 */
  panel._metricsDirty = true;
  panel.setItems(items);
  await raf2();
  await sleep(150);
  out.wVirt = w();
  out.virtTotalH = Math.round(panel._totalH);
  out.offsets = SAMPLE.map(i => ({ idx: i, off: panel._offsets[i], cached: panel._h.get(panel._hKey(items[i])) }));
  out.virtSpacerH = Math.round(spacer.offsetHeight);
  out.cacheW = panel._hW;

  /* C. 滚到几个位置, 读虚拟窗口里卡片的真实 offsetTop/宽度 */
  const virt = [];
  for (const idx of SAMPLE.slice(0, 6)) {
    listEl.scrollTop = Math.max(0, panel._cardTop(idx) - 200);
    await raf2();
    await sleep(60);
    const el = panel._cardElAt(idx);
    virt.push({ idx, top: el ? el.offsetTop : null, h: el ? el.offsetHeight : null, cw: el ? el.offsetWidth : null, tableTop: panel._offsets[idx] });
  }
  out.virt = virt;
  out.padH = spacer.querySelector('.cue-pad') ? spacer.querySelector('.cue-pad').style.height : null;

  /* 对比 */
  for (const f of full) {
    const v = virt.find(x => x.idx === f.idx);
    const o = panel._offsets[f.idx];
    out.rows.push({ idx: f.idx, 全量top: f.top, 表top: Math.round(o), 差: Math.round(f.top - o), 全量宽: f.cw, 全量高: f.h, 虚拟top: v ? v.top : null, 虚拟高: v ? v.h : null, 缓存高: panel._h.get(panel._hKey(items[f.idx])) });
  }
  return out;
}

const server = spawn(process.execPath, [join(ROOT, 'editor', 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) break; } catch {} }
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + join(process.env.TEMP || '.', 'edge-offdiag-' + Date.now()), '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--window-size=${process.env.WIN || '1600,1000'}`, `http://127.0.0.1:${PORT}/editor/index.html`], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i++) { await sleep(300); try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); target = l.find(t => t.type === 'page' && t.url.includes(String(PORT))) || l.find(t => t.type === 'page'); if (target && target.webSocketDebuggerUrl) break; } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await sleep(3000);

const res = await send('Runtime.evaluate', { expression: '(' + pageProbe.toString() + ')(' + N + ')', awaitPromise: true, returnByValue: true });
const out = res && res.result && res.result.value;
if (res && res.exceptionDetails) console.log('异常:', res.exceptionDetails.exception?.description);
if (out) {
  console.log('宽度: 起始', JSON.stringify(out.wBefore));
  console.log('      全量渲染时', JSON.stringify(out.wFull));
  console.log('      虚拟窗口时', JSON.stringify(out.wVirt), ' 缓存宽度 _hW =', out.cacheW);
  console.log('总高: 全量', out.fullSpacerH, ' 虚拟', out.virtTotalH, ' 虚拟 spacer 实际', out.virtSpacerH);
  console.log('padH =', out.padH);
  console.log('\n idx | 全量top | 位置表top |   差 | 全量宽 | 全量高 | 缓存高 | 虚拟top | 虚拟高');
  for (const r of out.rows) {
    console.log(String(r.idx).padStart(5), String(r.全量top).padStart(9), String(r.表top).padStart(10), String(r.差).padStart(6),
      String(r.全量宽).padStart(7), String(r.全量高).padStart(7), String(r.缓存高).padStart(7),
      String(r.虚拟top).padStart(8), String(r.虚拟高).padStart(7));
  }
  console.log('\n位置表原始值:', JSON.stringify(out.offsets));
} else console.log('未取到结果:', JSON.stringify(res).slice(0, 600));
cleanup();
