// 量"flex 列容器里行被压扁"这一类问题：把容器压矮，看行高是否缩小（该滚不该压）。
//
// 背景（用户反馈："预览界面选中字幕时字幕框的 UI 被错误压缩"）：
//   `.reflect-list` 是 `display:flex; flex-direction:column; overflow-y:auto`，而 `.reflect-item`
//   没写 `flex:none` —— flex 子项默认 `flex-shrink:1`，于是纵向空间不够时**压扁行**而不是滚动。
//   实测行高 74px → 54px（三段文字本身没变，所以看着就是"挤在一起"）。
//   同一模式在另外 5 个列表容器里也有，本探针一起量。
//
// 用法: node tools/probe_flex_squash.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9433;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 容器 → 行类名（都从 studio.html / js 里核对过）
const CASES = [
  { list: 'realign-list', row: 'reflect-item', label: '全片逐词重校对预览', synth: 'realign' },
  { list: 'reflect-list', row: 'reflect-item', label: '反思纠错条目', synth: 'reflect' },
  { list: 'role-list', row: 'role-card', label: '角色列表', synth: 'role' },
  { list: 'pick-list', row: 'pick-row', label: '分片/选区列表', synth: 'pick' },
  { list: 'ah-mine-list', row: 'hw-mine-item', label: '热词候选', synth: 'hotword' },
];

const profile = mkdtempSync(join(tmpdir(), 'edge-squash-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1400,1000',
  `${APP}/editor/studio.html#/home`,
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
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(4500);

/** 按**真实结构**复现：`.reflect-box`（max-height + flex 列）里放 `.reflect-list`（flex:1; min-height:0），
 *  再往里塞行。空间不够时列表先被压缩，行没有 flex:none 就跟着被压扁。
 *
 * 为什么不在原来的容器里量：这些容器大多在 `#/home` 下是隐藏的（祖先 hidden → 量出来全是 0px）。
 * 与其把一堆祖先逐层展开（容易把页面搅乱、也不代表真实布局），不如在页面里挂一个固定的
 * 测试宿主，用**同一份样式表**渲染同样的结构 —— flex 压缩是纯 CSS 行为，与宿主位置无关。 */
const CASES_JSON = JSON.stringify(CASES);
const built = await evalJS(`(() => {
  const cases = ${CASES_JSON};
  let host = document.getElementById('__flex_probe_host');
  if (!host) {
    host = document.createElement('div');
    host.id = '__flex_probe_host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:440px;z-index:99999;'
      + 'background:#101015;display:flex;flex-direction:column;gap:12px;padding:8px;';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const out = {};
  for (const c of cases) {
    // 外层：模仿 .reflect-box（固定上限高度 + flex 列）
    const dialog = document.createElement('div');
    dialog.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:16px;'
      + 'background:#17171d;border:1px solid #2a2a34;border-radius:12px;box-sizing:border-box;'
      + 'height:300px;max-height:300px;';
    dialog.innerHTML = '<div style="font-size:14px;font-weight:700;color:#eceef2">标题</div>'
      + '<div style="font-size:13px;color:#a8a8b4">说明一行</div>';
    // 列表：真实的列表类 + 真实的关键属性
    const box = document.createElement('div');
    box.className = c.list;
    box.id = '__probe_' + c.list;
    box.hidden = false;
    box.style.display = 'flex'; box.style.flexDirection = 'column'; box.style.overflowY = 'auto';
    box.style.flex = '1'; box.style.minHeight = '0';
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const el = document.createElement('div');
      el.className = c.row + (c.synth === 'realign' && i < 2 ? ' is-on' : '');
      if (c.synth === 'realign') {
        el.innerHTML = '<input type="checkbox" checked><span class="ri-body">'
          + '<span class="ri-head"><span class="cc-chip chip-conf">置信度中 76%</span>'
          + '<span class="ri-range">第 1 行 · 00:00:00.000 ~ 00:00:08.960</span></span>'
          + '<span class="ri-text">G\\'day ladies and gents, Cubic Meter here, Merging has just announced</span>'
          + '<span class="ri-reason">识别听到：G Day ladies and gents, Cub here</span></span>';
      } else {
        el.textContent = '第 ' + (i + 1) + ' 条：这是一条用来量高度的行，内容大概这么长，够撑出自然高度。';
      }
      box.appendChild(el);
      rows.push(el);
    }
    dialog.appendChild(box);
    host.appendChild(dialog);
    out[c.list] = { rows: rows.length };
  }
  return JSON.stringify(out);
})()`);
console.log('造行:', built);
await sleep(500);

// 参考值：把行放进一个"高度充裕"的容器里，量它的自然高度
const natural = await evalJS(`(() => {
  const out = {};
  const probe = document.getElementById('__flex_probe_host');
  for (const box of [...probe.children].map(d => d.lastElementChild)) {
    // 临时把行的 flex 设成 none 得到"不受压"的基准高度
    const rows = [...box.children];
    const saved = rows.map(r => r.style.flex);
    rows.forEach(r => { r.style.flex = '0 0 auto'; });
    out[box.id.replace('__probe_', '')] = Math.round(Math.max(...rows.map(r => r.getBoundingClientRect().height)));
    rows.forEach((r, i) => { r.style.flex = saved[i]; });
  }
  return JSON.stringify(out);
})()`);
const NAT = JSON.parse(natural);
console.log('基准行高（行设 flex:0 0 auto 时）:', natural);

console.log('\n容器                       基准行高   实际行高   判定');
console.log('─'.repeat(72));
let bad = 0;
for (const c of CASES) {
  const r = await evalJS(`(() => {
    const box = document.getElementById(${JSON.stringify('__probe_' + c.list)});
    if (!box) return JSON.stringify({ err: 'no element' });
    const rows = [...box.children].filter(e => e.classList.contains(${JSON.stringify(c.row)}));
    if (!rows.length) return JSON.stringify({ err: 'no rows' });
    const hs = rows.map(e => Math.round(e.getBoundingClientRect().height));
    return JSON.stringify({ actual: Math.max(...hs), min: Math.min(...hs), scrollable: box.scrollHeight > box.clientHeight + 1,
      rowFlex: getComputedStyle(rows[0]).flex });
  })()`);
  const d = JSON.parse(r);
  if (d.err) { console.log('  ' + c.list.padEnd(16) + ' ' + d.err); continue; }
  const base = NAT[c.list];
  const squashed = d.actual < base - 2;
  if (squashed) bad++;
  console.log('  %s %s   %spx      %spx     %s   flex=%s',
    c.list.padEnd(16), (c.label + '                    ').slice(0, 20),
    String(base).padStart(3), String(d.actual).padStart(3),
    squashed ? '★ 被压扁（应滚动）' : (d.scrollable ? '✓ 滚动，不压扁' : '· 未溢出'),
    d.rowFlex);
}
console.log('─'.repeat(72));
console.log(bad ? ('★ ' + bad + ' 个容器会把行压扁') : '✓ 没有容器压扁行');

ws.close(); edge.kill();
process.exit(bad ? 1 : 0);



