// 复现（修正版）：**只**改「中英上下顺序」→ 改逐词高亮色 → 画面出现两行重叠。
// 再改一次顺序即恢复正常，且逐词高亮色仍是字幕自带的绿色。
//
// 判据（不靠肉眼）：
//   ① 文档里有没有"同一时刻、同样式"的多条事件（= 叠加渲染）
//   ② 每条英文行的文本里，被高亮的词是否**同时存在两种色标**（白+绿）
//   ③ assPlayer 是否被喂了"重排前/后的两份文本"（updatingNow vs load 的调用序列）
//
// 用法: node tools/repro_order_color.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9488;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-repro-real1';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\repro2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'edge-oc-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
  '--force-device-scale-factor=1',
  `${APP}/editor/index.html?debug#/project/${PROJ}`,
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(6000);

// 记录"每次被序列化出去喂给预览的文本"。
// 为什么不 hook assPlayer：它没挂 window（main.js 只挂 __timeline/__panel/__state）。
// 而调用方一律用 `state.assDoc.serialize()` 取文本 —— 在文档实例上挂一层即可，
// 这样能直接看到"喂进去的文本里有没有两种色标/多了 Dialogue 行"。
const hooked = await evalJS(`(() => {
  const doc = (window.__state || {}).assDoc;
  if (!doc) return 'no assDoc（URL 里要带 debug）';
  if (!window.__feed) {
    window.__feed = [];
    const orig = doc.serialize.bind(doc);
    doc.serialize = function () {
      const text = orig();
      const cs = [...new Set(String(text).match(/\\\\c&H[0-9A-Fa-f]{6}&/g) || [])];
      const dlgs = (String(text).match(/^Dialogue:/gm) || []).length;
      window.__feed.push({ colors: cs, dlgs, len: String(text).length, stack: (new Error().stack || '').split('\\n').slice(1, 4).map(s => s.trim().replace(/^at /, '').slice(0, 60)) });
      return text;
    };
  }
  return 'hooked';
})()`);
console.log('hook:', hooked);

const STAT = `(() => {
  const st = window.__state || {};
  const doc = st.assDoc;
  if (!doc) return JSON.stringify({ err: 'no assDoc' });
  const evs = doc.events || [];
  // 同一(开始,样式)多条 = 叠加渲染
  const m = new Map();
  for (const e of evs) { const k = e.start.toFixed(2) + '|' + (e.style || ''); m.set(k, (m.get(k) || 0) + 1); }
  const overlap = [...m.entries()].filter(([, n]) => n > 1);
  // 逐词行里"一个词被画两次不同色"的痕迹
  let twoColor = 0;
  for (const e of evs) {
    const t = String(e.text || '');
    const cs = [...new Set(t.match(/\\\\c&H[0-9A-Fa-f]{6}&/g) || [])];
    if (cs.length > 1) twoColor++;
  }
  const text = doc.serialize();
  return JSON.stringify({
    events: evs.length,
    overlapGroups: overlap.length, overlapSamples: overlap.slice(0, 3).map(([k, n]) => k + ' ×' + n),
    twoColorLines: twoColor,
    colorsInDoc: [...new Set(text.match(/\\\\c&H[0-9A-Fa-f]{6}&/g) || [])],
    metaColor: (() => { try { return doc.getScriptInfoComment('SubFabricWordHighlightColor'); } catch { return null; } })(),
    inputColor: (document.getElementById('ass-style-word-color') || {}).value,
    orderSel: (document.getElementById('ass-style-order') || {}).value,
    feedTail: (window.__feed || []).slice(-4),
  });
})()`;

const step = async (label) => {
  const raw = await evalJS(STAT);
  console.log('\\n【' + label + '】');
  let d; try { d = JSON.parse(raw); } catch { console.log('  ' + raw); return null; }
  if (d.err) { console.log('  ' + d.err); return null; }
  console.log('  事件 ' + d.events + '   同刻同样式重复组 ' + d.overlapGroups + (d.overlapSamples.length ? ' ' + JSON.stringify(d.overlapSamples) : ''));
  console.log('  含两种色标的行 ' + d.twoColorLines + '   文档里的色标 ' + JSON.stringify(d.colorsInDoc));
  console.log('  元数据色 ' + d.metaColor + '   输入框 ' + d.inputColor + '   顺序下拉 ' + d.orderSel);
  console.log('  喂给 libass 的最近 4 次: ' + JSON.stringify(d.feedTail));
  return d;
};
const shot = async (tag) => {
  const clip = await evalJS(`(() => { const b = document.getElementById('video-stage').getBoundingClientRect();
    return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
  if (typeof clip === 'string') {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
    if (r?.data) { writeFileSync(`${OUT}-${tag}.png`, Buffer.from(r.data, 'base64')); console.log('  截图 ' + `${OUT}-${tag}.png`); }
  }
};

await step('① 打开稿件');
await shot('1-open');

// 把播放头移到第 1 句，画面上要能看到字幕
await evalJS(`(() => { const v = document.getElementById('video');
  return 'no video'; })()`);

await evalJS(`(async () => {
  const sel = document.getElementById('ass-style-order');
  sel.value = 'zh-top';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1000));
})()`);
await step('② 改成「中文在上」之后');
await shot('2-order-zh-top');

await evalJS(`(async () => {
  const inp = document.getElementById('ass-style-word-color');
  inp.value = '#ffffff';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
})()`);
await step('③ 把逐词高亮色改成白色之后（bug 出现的位置）');
await shot('3-color-white');

await evalJS(`(async () => {
  const sel = document.getElementById('ass-style-order');
  sel.value = 'en-top';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1000));
})()`);
await step('④ 再改一次顺序（据用户说会恢复正常）');
await shot('4-order-en-top');

ws.close(); edge.kill();
