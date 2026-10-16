// 验收设计稿 ③「LLM 方案列表 + 卡片内展开设置区」：
//   · 二级 Tab 能切到 LLM 子视图，切回 ASR 也不坏
//   · 方案列表按真实 presets 渲染，标出「当前使用」，未配置的行变暗
//   · 服务选择胶囊两处（列表上方 + 卡片内）都能点，点了会展开设置区
//   · 卡片内设置区：按下「设置」后插入当前卡片下方，连续展开并在关闭动画后 hidden
//   · 面板里的字段与后端**真有的**字段一一对应（province/baseUrl/model/batch/prompt/glossary 都在）
//   · 「新建方案」会清空 Key 并切到另一个服务商
//
// 用法: node tools/verify_scheme_drawer.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9515;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\scheme-drawer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-sd-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
  '--force-device-scale-factor=1', `${APP}/editor/studio.html#/settings`,
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
await send('Log.enable');
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
});
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
  return r?.result?.value;
};
await sleep(7000);

console.log('\n── ① 二级 Tab ──');
const tabs = await evalJS(`(async () => {
  const click = (s) => document.querySelector('.st-subtab[data-stsub="' + s + '"]').click();
  click('llm');
  await new Promise(r => setTimeout(r, 250));
  const llm = { shown: [...document.querySelectorAll('.st-subview')].filter(v => !v.hidden).map(v => v.dataset.stsub),
                active: [...document.querySelectorAll('.st-subtab.active')].map(t => t.dataset.stsub) };
  click('asr');
  await new Promise(r => setTimeout(r, 200));
  const asr = { shown: [...document.querySelectorAll('.st-subview')].filter(v => !v.hidden).map(v => v.dataset.stsub) };
  click('llm');
  await new Promise(r => setTimeout(r, 250));
  const llm2 = { shown: [...document.querySelectorAll('.st-subview')].filter(v => !v.hidden).map(v => v.dataset.stsub) };
  return JSON.stringify({ llm, asr, llm2 });
})()`);
console.log('   ', tabs);
const T = JSON.parse(tabs);
ok(T.llm.shown.length === 1 && T.llm.shown[0] === 'llm' && T.llm.active[0] === 'llm', '切到 LLM 只显示 LLM 子视图');
ok(T.asr.shown.length === 1 && T.asr.shown[0] === 'asr', '切回 ASR 只显示 ASR 子视图');
ok(T.llm2.shown[0] === 'llm', '可以在两个子视图之间反复切换');

console.log('\n── ② 方案列表（真实 presets）──');
const list = await evalJS(`(() => {
  const rows = [...document.querySelectorAll('#st-scheme-list .st-scheme')];
  return JSON.stringify({
    n: rows.length,
    names: rows.map(r => (r.querySelector('.st-scheme-name') || {}).textContent.trim()),
    cur: rows.filter(r => r.classList.contains('cur')).map(r => r.dataset.provider),
    dim: rows.filter(r => r.classList.contains('off')).map(r => r.dataset.provider),
    hasSetBtn: rows.every(r => !!r.querySelector('.st-scheme-set')),
    descs: rows.slice(0, 3).map(r => (r.querySelector('.st-scheme-desc') || {}).textContent.trim()),
    picks: [...document.querySelectorAll('#st-scheme-picks .st-pick')].map(b => b.textContent.trim()),
    pickOn: [...document.querySelectorAll('#st-scheme-picks .st-pick.on')].map(b => b.dataset.provider),
  });
})()`);
console.log('   ', list);
const L = JSON.parse(list);
const START_PROVIDER = L.cur[0];      // 记住用户原本用的是哪套，验收结束要切回去
ok(L.n === 8, `方案数 = 服务商预置数（${L.n}）`, JSON.stringify(L.names.slice(0, 3)));
ok(L.cur.length === 1, `恰好一行标为「当前使用」（${L.cur[0]}）`);
ok(L.cur[0] === L.pickOn[0], `胶囊的选中态与当前服务商一致（${L.pickOn[0]}）`);
ok(L.hasSetBtn, '每行都有「设置」按钮');
ok(L.picks.length === 8, '服务选择胶囊与服务商一一对应');
ok(L.descs.every(d => !/undefined/.test(d)), '描述里没有 undefined', JSON.stringify(L.descs));

console.log('\n── ③ 卡片内展开设置区 ──');
const draw = await evalJS(`(async () => {
  const d = document.getElementById('st-scheme-drawer');
  const before = { hidden: d.hidden, open: d.classList.contains('open'), x: Math.round(d.getBoundingClientRect().x) };
  document.querySelector('#st-scheme-list .st-scheme-set').click();
  await new Promise(r => setTimeout(r, 500));
  const cs = getComputedStyle(d);
  const first = document.querySelector('#st-scheme-list .st-scheme');
  const after = { hidden: d.hidden, open: d.classList.contains('open'), x: Math.round(d.getBoundingClientRect().x),
                  w: Math.round(d.getBoundingClientRect().width), transform: cs.transform,
                  belowCard: d.parentElement === document.getElementById('st-scheme-list') && first.nextElementSibling === d,
                  title: document.getElementById('st-scheme-title').textContent,
                  curShown: !document.getElementById('st-scheme-cur').hidden,
                  picksInside: document.querySelectorAll('#st-drawer-picks .st-pick').length };
  // 面板里必须存在的字段（后端真有的那些）
  const ids = ['st-provider','st-baseurl','st-key','st-model','st-batch','st-prompt','gl-tabs','gl-rows','gl-add'];
  const fields = {};
  for (const i of ids) fields[i] = !!document.getElementById(i);
  // 值是否被填上（接口地址/模型名应当来自当前服务商）
  const vals = { baseurl: document.getElementById('st-baseurl').value,
                 model: document.getElementById('st-model').value,
                 batch: document.getElementById('st-batch').value,
                 promptLen: document.getElementById('st-prompt').value.length };
  return JSON.stringify({ before, after, fields, vals, vw: innerWidth });
})()`);
console.log('   ', draw);
const D = JSON.parse(draw);
ok(D.before.hidden === true || D.before.open === false, '初始时面板是收起/隐藏的');
ok(D.after.open === true && D.after.hidden === false, '点「设置」后面板已打开');
ok(D.after.belowCard, '设置区插入当前方案卡片下方');
ok(D.after.transform === 'none' || D.after.transform === 'matrix(1, 0, 0, 1, 0, 0)', '展开动画结束（位移已归零）');
ok(D.after.w > 400 && D.after.w <= D.vw, `设置区与列表同宽（实际 ${D.after.w}）`);
ok(D.after.curShown === true, '标题旁标出了「当前使用」');
ok(D.after.picksInside === 8, '面板里也有服务选择胶囊');
ok(Object.values(D.fields).every(Boolean), '凭证/模型/调用参数/术语表/提示词 字段齐全',
  JSON.stringify(Object.entries(D.fields).filter(([, v]) => !v)));
ok(!!D.vals.baseurl && !!D.vals.model && Number(D.vals.batch) > 0 && D.vals.promptLen > 10,
  '字段值已填上（接口地址 / 模型名 / 每批行数 / 提示词）', JSON.stringify(D.vals));

console.log('\n── ④ 关闭与新建方案 ──');
const close = await evalJS(`(async () => {
  document.getElementById('st-scheme-close').click();
  await new Promise(r => setTimeout(r, 600));
  const d = document.getElementById('st-scheme-drawer');
  const afterClose = { hidden: d.hidden, open: d.classList.contains('open') };
  // 新建方案：Key 清空、切到另一个服务商、面板再打开
  const beforeProvider = document.getElementById('st-provider').value;
  document.getElementById('st-scheme-new').click();
  await new Promise(r => setTimeout(r, 500));
  const afterNew = { provider: document.getElementById('st-provider').value,
                     keyVal: document.getElementById('st-key').value,
                     open: d.classList.contains('open'),
                     curShown: !document.getElementById('st-scheme-cur').hidden };
  return JSON.stringify({ afterClose, beforeProvider, afterNew });
})()`);
console.log('   ', close);
const C = JSON.parse(close);
ok(C.afterClose.hidden === true && C.afterClose.open === false, '关闭后面板收起并隐藏（等动画结束）');
ok(C.afterNew.provider !== C.beforeProvider, `「新建方案」切到了另一个服务商（${C.beforeProvider} → ${C.afterNew.provider}）`);
ok(C.afterNew.keyVal === '', '新建方案时 Key 输入框已清空');
ok(C.afterNew.open === true, '新建后面板自动打开');
ok(C.afterNew.curShown === false, '新建的方案不标「当前使用」');

// ⚠ 上面「新建方案」那一步把 provider 换掉了（saveTranslateCfg 切换 provider 时会连带改
//    baseUrl/model），而这是**用户的真实配置**。跑完必须切回去，否则验收会改坏用户设置
//    （实测踩过：跑完一轮，provider 从 deepseek 变成 openai）。
const restore = await evalJS(`(async () => {
  const sel = document.getElementById('st-provider');
  sel.value = ${JSON.stringify(START_PROVIDER)};
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  document.getElementById('st-drawer-save').click();
  await new Promise(r => setTimeout(r, 2500));
  const r = await (await fetch('/api/translate/config')).json();
  return JSON.stringify({ provider: r.cfg.provider, model: r.cfg.model });
})()`);
console.log('   恢复初始方案:', restore);
const R0 = JSON.parse(restore);
ok(R0.provider === START_PROVIDER, `验收结束后把 provider 切回初始值（${START_PROVIDER}）`);

console.log('\n── ⑤ API Key 显示/隐藏 与 无 JS 报错 ──');
const eye = await evalJS(`(() => {
  const k = document.getElementById('st-key');
  const b = document.getElementById('st-key-eye');
  const t0 = k.type; b.click(); const t1 = k.type; b.click(); const t2 = k.type;
  return JSON.stringify({ t0, t1, t2 });
})()`);
console.log('   ', eye);
const E = JSON.parse(eye);
ok(E.t0 === 'password' && E.t1 === 'text' && E.t2 === 'password', '「显示/隐藏」能切换 Key 的明文可见性');
ok(errors.length === 0, '控制台没有 error', errors.slice(0, 2).join(' | '));

console.log('\n── ⑥ 采样温度 / 上下文行数（设计稿 ③ 的两项，已接线到后端）──');
const params = await evalJS(`(async () => {
  const t = document.getElementById('st-temp'), c = document.getElementById('st-ctx');
  const present = { temp: !!t, ctx: !!c };
  const initial = { temp: t ? t.value : null, ctx: c ? c.value : null };
  const limits = { tMin: t && t.min, tMax: t && t.max, cMin: c && c.min, cMax: c && c.max };
  // 改值 → 走「保存方案」（复用既有保存链路）
  t.value = '0.8'; c.value = '30';
  document.getElementById('st-drawer-save').click();
  await new Promise(r => setTimeout(r, 2500));
  const r = await (await fetch('/api/translate/config')).json();
  return JSON.stringify({ present, initial, limits, saved: { temp: r.cfg.temperature, ctx: r.cfg.contextRows },
                          uiAfter: { temp: t.value, ctx: c.value } });
})()`);
console.log('   ', params);
const P = JSON.parse(params);
ok(P.present.temp && P.present.ctx, '面板里有「采样温度」与「上下文行数」两个输入框');
ok(Number(P.limits.tMin) === 0 && Number(P.limits.tMax) === 2, `温度输入框标了 0~2 的范围（${P.limits.tMin}~${P.limits.tMax}）`);
ok(Number(P.limits.cMin) === 0 && Number(P.limits.cMax) === 200, `上下文输入框标了 0~200 的范围（${P.limits.cMin}~${P.limits.cMax}）`);
ok(Number(P.saved.temp) === 0.8, `温度已存到服务端（${P.saved.temp}）`);
ok(Number(P.saved.ctx) === 30, `上下文行数已存到服务端（${P.saved.ctx}）`);

// 越界值必须被服务端夹回（不信任前端）
const clamp = await evalJS(`(async () => {
  await fetch('/api/translate/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temperature: 99, contextRows: -5 }) });
  const r = await (await fetch('/api/translate/config')).json();
  return JSON.stringify({ temp: r.cfg.temperature, ctx: r.cfg.contextRows });
})()`);
console.log('   ', clamp);
const CL = JSON.parse(clamp);
ok(Number(CL.temp) === 2, `服务端把越界温度夹到上限（99 → ${CL.temp}）`);
ok(Number(CL.ctx) === 0, `服务端把负数上下文夹到 0（-5 → ${CL.ctx}）`);
// 恢复成默认，别把测试值留在用户机器上
const restored = await evalJS(`(async () => {
  document.getElementById('st-temp').value = '0.3';
  document.getElementById('st-ctx').value = '0';
  document.getElementById('st-drawer-save').click();
  await new Promise(r => setTimeout(r, 2500));
  const r = await (await fetch('/api/translate/config')).json();
  return JSON.stringify({ temp: r.cfg.temperature, ctx: r.cfg.contextRows });
})()`);
console.log('   ', restored);
const RS = JSON.parse(restored);
ok(Number(RS.temp) === 0.3 && Number(RS.ctx) === 0, `已恢复默认（${RS.temp} / ${RS.ctx}）`);

console.log('\n── ⑥ 截图 ──');
const clip = await evalJS(`(() => { const b = document.querySelector('.st-body').getBoundingClientRect();
  return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
if (typeof clip === 'string') {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
  if (r?.data) { writeFileSync(OUT + '.png', Buffer.from(r.data, 'base64')); console.log('   ' + OUT + '.png'); }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);

