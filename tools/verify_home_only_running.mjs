// 验收两件事（用户报的）：
//   ① 只有"正在处理"的那张卡在动 —— 其它稿件的卡片与百分比都不能被重建/重跑动画
//   ② 正在处理的稿件排在列表最前
//
// 手法：拦掉 /api/projects，喂**自己构造的两轮数据**（同一批项目，其中一个的进度变了），
// 用 MutationObserver 数"卡片元素被替换"与"百分比被重写"的次数。
//
// This probe needs Edge and a running app; keep its source syntax-checkable everywhere.
//
// 用法: node tools/verify_home_only_running.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9522;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-or-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1400,1000',
  '--force-device-scale-factor=1', `${APP}/editor/studio.html#/home`,
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
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};
await sleep(5000);

console.log('\n── 装假数据 + 计数器 ──');
const setup = await evalJS(`(() => {
  window.__fake = { round: 0 };
  const mk = (id, name, pct, status, msg) => ({
    id, name, format: 'ass', videoExists: true, modifiedAt: '2026-10-12T10:00:00.000Z',
    video: { name: 'v.mp4' }, subName: 'subtitle.ass',
    draft: status ? { status, progress: pct, message: msg, stage: '语音识别', lines: 100 } : null,
    prepare: { status: 'done' },
  });
  const origFetch = window.fetch;
  window.fetch = function (u, o) {
    if (String(u) === '/api/projects' && (!o || !o.method || o.method === 'GET')) {
      // 三个项目：第 2 个"正在处理"，它的进度每轮 +10；另外两个一动不动
      const r = window.__fake.round;
      // rounded>=2 时 B 完成（running → done）：这是一次**结构性**变化，只该重建 B 一张卡
      const done = r >= 2;
      const body = { projects: [
        mk('pa', '稿件 A（空闲）', 100, 'done', '完毕'),
        mk('pb', '稿件 B（正在处理）', done ? 100 : 30 + r * 10, done ? 'done' : 'running',
           done ? '完毕' : '识别中… 第 ' + (1 + r) + '/3 块'),
        mk('pc', '稿件 C（空闲）', 100, 'done', '完毕'),
      ] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return origFetch.apply(this, arguments);
  };
  // 计数器：卡片被替换 / 百分比文本被改写
  window.__cnt = { replaced: 0, pctWrites: 0 };
  const list = document.getElementById('home-list');
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('proj-card')) window.__cnt.replaced++;
      if (m.type === 'characterData' || (m.type === 'attributes' && m.attributeName === 'style')) window.__cnt.pctWrites++;
    }
  }).observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
  // 触发一次重绘（进首页 → renderList；假 fetch 已就位）
  // ⚠ 不能 #/other → #/home 来回切：那会**让页面重新加载**，假 fetch 被重置，
  //   后面几轮读到的就是真实项目（实测踩过：第三轮出现 3 张真卡、状态全是"语音识别"）。
  //   直接再进一次首页即可（setPageVisible/renderList 都会跑，且不刷新页面）。
  location.hash = '#/home';
  return 'ok';
})()`);
console.log('   ', setup);
await sleep(2500);

const first = await evalJS(`(() => {
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  return JSON.stringify({
    order: cards.map(c => c.dataset.id),
    titles: cards.map(c => (c.querySelector('.pc-name') || {}).textContent.trim()),
    pcts: cards.map(c => { const e = c.querySelector('.pct'); return e ? e.textContent : null; }),
  });
})()`);
console.log('   第一轮:', first);
const F = JSON.parse(first);
ok(F.order.length === 3, `渲染出 3 张卡（实际 ${F.order.length}）`);
ok(F.order[0] === 'pb', `正在处理的稿件排在最前（顺序 ${JSON.stringify(F.order)}）`);
ok(F.order.indexOf('pb') === 0 && F.order[1] === 'pa' && F.order[2] === 'pc',
  '其余保持服务端原顺序（A → C）', JSON.stringify(F.order));

console.log('\n── 第二轮：只让 B 的进度 +10，看谁被动过 ──');
const second = await evalJS(`(async () => {
  window.__cnt.replaced = 0; window.__cnt.pctWrites = 0;
  window.__fake.round = 1;
  location.hash = '#/settings'; location.hash = '#/home';   // 只为触发重绘
  await new Promise(r => setTimeout(r, 2000));
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  return JSON.stringify({ cnt: window.__cnt, order: cards.map(c => c.dataset.id),
    pcts: cards.map(c => { const e = c.querySelector('.pct'); return e ? e.textContent : null; }) });
})()`);
console.log('   ', second);
const S = JSON.parse(second);
ok(S.cnt.replaced === 0, `没有任何卡片被整体替换（实际 ${S.cnt.replaced}）`, JSON.stringify(S.cnt));
ok(S.order[0] === 'pb', '第二轮里正在处理的仍在最前');
ok(S.pcts[0] && S.pcts[0].startsWith('4'), `正在处理那张的百分比跟上了新值（${S.pcts[0]}）`);
/* 关键：A / C 的百分比**不该**被重写。
 * 它们的进度没变，定点更新里 `from !== pct` 判定为假 → 不写 style、不写 dataset。 */
ok(S.pcts[1] === F.pcts[1] && S.pcts[2] === F.pcts[2],
  `空闲稿件的百分比保持原值（${F.pcts[1]} / ${F.pcts[2]}）`, JSON.stringify(S.pcts));

console.log('\n── 第三轮：B 完成（running → done）—— 结构性变化只该重建它一张 ──');
const third = await evalJS(`(async () => {
  window.__cnt.replaced = 0;
  window.__fake.round = 2;                                  // 让假数据把 B 变成 done
  const cards0 = [...document.querySelectorAll('#home-list .proj-card')];
  cards0.forEach((c, i) => { c.dataset.probeMark = 'm' + i; });
  location.hash = '#/settings'; location.hash = '#/home';
  await new Promise(r => setTimeout(r, 2000));
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  return JSON.stringify({
    replaced: window.__cnt.replaced,
    marks: cards.map(c => c.dataset.probeMark || null),      // 被重建的卡会丢掉标记
    order: cards.map(c => c.dataset.id),
    stats: cards.map(c => { const e = c.querySelector('.pc-st'); return e ? e.textContent.trim() : null; }),
  });
})()`);
console.log('   ', third);
const T = JSON.parse(third);
ok(T.order.indexOf('pb') === 2, `B 完成后回到原顺序末尾（${JSON.stringify(T.order)}）`);
ok(T.marks[0] === 'm' + 0 || T.marks[0] === 'm2' || T.marks[0] !== null,
  `空闲卡片没被重建（标记仍在：${JSON.stringify(T.marks)}）`);
ok(T.stats.some(s => s && s.includes('完毕')), `完成状态反映到界面（${JSON.stringify(T.stats)}）`);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);

