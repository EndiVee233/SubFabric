/* 字幕列表虚拟滚动 —— 视觉检查(截图)
 * 渲染 5000 条后截三张图: 初始窗口 / 滚到中间 / 行内编辑打开。
 * 用法: node tools/cue_list_visual_probe.mjs [行数=5000]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8441, CDP_PORT = 9441;
const N = Number(process.argv[2] || 5000);
const OUT = process.env.SHOT_DIR || join(ROOT, 'outputs', 'cue-list-virtual');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, 'editor', 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) break; } catch {} }

const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + join(process.env.TEMP || '.', 'edge-vis-' + Date.now()), '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1600,1000', `http://127.0.0.1:${PORT}/editor/index.html`], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); target = list.find(t => t.type === 'page' && t.url.includes(String(PORT))) || list.find(t => t.type === 'page'); if (target && target.webSocketDebuggerUrl) break; } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');
await sleep(3000);

const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  截图 ' + join(OUT, name));
};

await evalJs(`(() => {
  const hv = document.getElementById('home-view');
  if (hv) hv.hidden = true;                       // 首页是全屏浮层, 遮住编辑器 → 收起来才看得见列表
  const dbg = window.__dbg, panel = dbg.panel;
  panel.showTab('subs');
  const ZH = ['这就是我为什么一直在这里等你的原因','别急','我们先把这个东西拆开看看','他说这句话的时候我就在旁边','所以到底发生了什么'];
  const EN = ['This is exactly why I have been waiting here for you','Hold on','Let us take this thing apart first','I was right there when he said it','So what on earth happened'];
  const items = [];
  for (let i = 0; i < ${N}; i++) {
    const s = i * 3.2;
    items.push({ kind:'ass-row', ref:{}, no:i+1, start:s, end:s+2.8,
      l1: ZH[i%5] + (i%7===0 ? '，结果还是没赶上最后一班车' : '') + ' #' + i,
      l2: EN[i%5] + ' #' + i,
      badge1: i%3===0 ? '中文字幕' : '', badge2: i%5===0 ? '英文字幕' : '',
      color: i%4===0 ? '#ff7a45' : null, speaker: i%6===0 ? '[Spoke]' : '',
      isNew: false, bad: i%97===0, badReason: '测试异常' });
  }
  panel.setItems(items);
  panel.select(panel.filtered[3], false);
  return 'ok';
})()`);
await sleep(400);
console.log('初始窗口:');
await shot('01-initial.png');

await evalJs(`(() => { const p = window.__dbg.panel; p.listEl.scrollTop = Math.round(p._totalH * 0.5); return 'ok'; })()`);
await sleep(400);
console.log('滚到中间:');
await shot('02-middle.png');

await evalJs(`(() => { const p = window.__dbg.panel; p.startEdit(p.filtered[Math.floor(${N}/2)], 1); return 'ok'; })()`);
await sleep(500);
console.log('行内编辑打开:');
await shot('03-editing.png');

const info = await evalJs(`(() => {
  const p = window.__dbg.panel, sp = p.spacerEl;
  const cards = [...sp.querySelectorAll('.cue-card')];
  const pad = sp.querySelector('.cue-pad');
  const cs = getComputedStyle(sp);
  return JSON.stringify({
    rendered: cards.length, total: p.filtered.length,
    padH: pad ? pad.style.height : null,
    spacerH: Math.round(sp.offsetHeight), listH: p.listEl.clientHeight,
    listW: p.listEl.clientWidth, spacerW: sp.clientWidth,
    cardW: cards[0] ? cards[0].offsetWidth : null,
    cardH: cards[0] ? cards[0].offsetHeight : null,
    scrollTop: p.listEl.scrollTop, scrollH: p.listEl.scrollHeight,
    firstIdx: cards[0] ? cards[0].dataset.idx : null,
    editorTop: p.editorEl ? p.editorEl.style.top : null,
    spacerOverflow: cs.overflow, spacerPosition: cs.position,
  }, null, 1);
})()`);
console.log('\n几何:', info);
cleanup();
