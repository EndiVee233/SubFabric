// 直接验证排序规则本身（不靠 mock，用真实 /api/projects 数据）：
//   规则：正在跑初稿 / **还没出稿（format 为空）** → 置顶；其余保持服务端顺序。
// 用法: node tools/verify_home_sort_rule.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9531;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-sr-'));
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

const res = await evalJS(`(async () => {
  const data = await (await fetch('/api/projects')).json();
  const ps = data.projects || [];
  ps.forEach((p, i) => { p._i = i; });
  const rank = (p) => {
    const dr = p.draft || null;
    if (dr && dr.status === 'running') return 0;
    if (!p.format) return 0;                                   // 还没出稿：正在创建
    if (p.prepare && p.prepare.status === 'running') return 1;
    return 2;
  };
  const want = ps.slice().sort((a, b) => (rank(a) - rank(b)) || (a._i - b._i));
  const dom = [...document.querySelectorAll('#home-list .proj-card')].map(c => c.dataset.id);
  return JSON.stringify({
    want: want.map(p => p.id + '(' + rank(p) + ')'),
    dom,
    detail: want.map(p => ({ id: p.id, rank: rank(p), name: (p.name || '').slice(0, 20),
      fmt: p.format || null, draft: p.draft ? p.draft.status : null, prep: p.prepare ? p.prepare.status : null })),
  });
})()`);
if (typeof res !== 'string') { console.log('  取数失败:', JSON.stringify(res)); ws.close(); edge.kill(); process.exit(1); }
const R = JSON.parse(res);
console.log('\n  规则算出的顺序:', JSON.stringify(R.want));
console.log('  页面实际顺序  :', JSON.stringify(R.dom));
console.log('\n  明细:');
for (const d of R.detail) console.log('   ', String(d.name).padEnd(22), 'rank=' + d.rank, 'fmt=' + d.fmt, 'draft=' + d.draft, 'prepare=' + d.prep);

ok(JSON.stringify(R.want.map(s => s.split('(')[0])) === JSON.stringify(R.dom),
  '页面顺序与排序规则一致');
const topRanks = R.detail.filter(d => d.rank === 0).map(d => d.id);
ok(topRanks.every(gid => R.dom.indexOf(gid) < R.dom.findIndex(x => !topRanks.includes(x)) || R.dom.indexOf(gid) === 0),
  `所有"正在创建/正在跑"的项目都在最前面（${topRanks.length} 个）`);
console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
