/* 字体选择器（带预览的下拉）的回归测试。
 *   node tests/font-picker-test.mjs
 *
 * 静态部分不需要浏览器；行为部分靠 tests/font-picker-harness.html，
 * 需要本地服务在跑（默认 8321）。
 *
 * 这个组件是"把字体名输入框升级成带预览的下拉"，所以钉住的约定是：
 *   1. **输入框必须留着** —— ASS 的字体名允许本机没装，不能变成纯 select
 *   2. 选中要**派发 change** —— 下游（载入本机字体进 libass、重建预览）全挂在 change 上
 *   3. 每个字体名用它**自己的字形**渲染 —— 否则还不如原生 datalist
 *   4. 面板要**贴合**输入框，下方空间不够就上翻
 *   5. 390 个字体不能一次性插进 DOM（渐进渲染）
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BASE = process.env.SUBFABRIC_BASE || 'http://127.0.0.1:8321';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

/* ── ① 静态：代码里该有的都在 ─────────────────────────────── */
console.log('== ① 静态 ==');
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'js', 'font-picker.js'), 'utf8');
ok(/export function enhanceFontInput/.test(SRC), '导出了 enhanceFontInput');
ok(/input\.removeAttribute\('list'\)/.test(SRC), '★ 会摘掉原生 list（不再用 datalist）');
ok(/input\.dispatchEvent\(new Event\('change'/.test(SRC),
  '★ 选中后派发 change（下游靠它载入字体+重建预览）');
ok(/li\.style\.fontFamily = /.test(SRC) || /\.style\.fontFamily/.test(SRC),
  '★ 每项用它自己的 font-family 渲染');
ok(/safeFamily/.test(SRC), '有 safeFamily（防引号/反斜杠把 CSS 串了）');
ok(/const CHUNK = \d+/.test(SRC), '有渐进渲染的 CHUNK');
ok(/scrollIntoView/.test(SRC), '键盘高亮会滚进视野');
ok(/Escape/.test(SRC) && /ArrowDown/.test(SRC) && /ArrowUp/.test(SRC), '支持 Esc / ↑ / ↓');

const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');
ok(/\.fp-panel\s*\{[^}]*position:\s*fixed/.test(CSS), '★ .fp-panel 是 position:fixed（否则贴在文档流里）');
ok(/\.fp-panel\s*\{[^}]*max-height:\s*320px/.test(CSS), '★ .fp-panel 有 max-height（否则 390 项撑到几千 px）');
ok(/\.fp-list\s*\{[^}]*overflow-y:\s*auto/.test(CSS), '.fp-list 可滚动');
ok(/\.fp-item\s*\{[^}]*font-size:\s*1[5-9]px/.test(CSS), '★ .fp-item 字号够大（要看得出字形差异）');

const MAIN = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
ok(/import \{ enhanceFontInput \} from '\.\/font-picker\.js'/.test(MAIN), 'main.js 引入了组件');
ok(/enhanceFontInput\(el\)/.test(MAIN), 'main.js 在两个字体框上调用它');
// 旧的原生补全逻辑不该再把 datalist 当主路径（留着无妨，但 list 属性已被摘掉）
ok(/loadSystemFontList/.test(MAIN), '/api/fonts 的读取仍保留（组件用的是同一份数据）');

/* ── ② 行为：用验证页在浏览器里跑 ──────────────────────────── */
console.log('\n== ② 浏览器行为 ==');
let svc = null;
try {
  svc = await (await fetch(BASE + '/api/version', { signal: AbortSignal.timeout(4000) })).json();
} catch { /* 没在跑 */ }
if (!svc) {
  console.log('  (跳过：本地服务没在跑，行为测试需要它。先启动服务再跑本测试)');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
{
  const HARNESS = BASE + '/__test/font-picker-harness.html';
  const PORT = 9841;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefpt-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--disable-extensions', '--window-size=1200,760',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, HARNESS,
  ], { stdio: 'ignore', windowsHide: true });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let u = null;
  for (let i = 0; i < 60 && !u; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) u = p.webSocketDebuggerUrl;
    } catch {}
    if (!u) await sleep(500);
  }
  let finished = false;
  try {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map(); const errs = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errs.push(String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 160));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    const js = async (x) => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200) };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    await send('Runtime.enable');
    await sleep(3200);

    ok(await js('!!window.__fpReady'), '验证页加载成功（组件模块可用）');

    if (await js('!!window.__fpReady')) {
      await js("window.__fpTest.open('zh')");
      await sleep(2200);

      const g = JSON.parse(await js("JSON.stringify(window.__fpTest.gap('zh'))"));
      ok(Math.abs(g.gapX) < 6, `面板水平对齐输入框（偏差 ${g.gapX}px）`, g.gapX);
      ok(Math.abs(g.gapY) < 24, `面板垂直贴合（偏差 ${g.gapY}px）`, g.gapY);
      ok(g.panel.h <= 321, `面板高度受限（${g.panel.h}px ≤ 320）`, g.panel.h);
      ok(g.overlap === false, '面板不遮住输入框');

      const cnt = await js('window.__fpTest.count()');
      ok(cnt >= 40, `列表渐进渲染（首批 ${cnt} 项）`, cnt);
      const fams = await js('JSON.stringify(window.__fpTest.itemFontFamilies(6))').then(s => JSON.parse(s));
      ok(new Set(fams.map(f => f.ff)).size >= 4, '★ 每项各自的字形（不是都在用同一个字体）', fams.map(f => f.ff));

      await js("window.__fpTest.type('黑体')");
      await sleep(300);
      const names = JSON.parse(await js('JSON.stringify(window.__fpTest.names())'));
      ok(names.length >= 1 && names.every(n => /黑体/.test(n)), `搜索过滤生效（${names.length} 项）`, names);

      await js('window.__fpTest.close()');
      await sleep(300);
      await js("window.__fpTest.open('second')");
      await sleep(1800);
      const g2 = JSON.parse(await js("JSON.stringify(window.__fpTest.gap('second'))"));
      const flipped = (g2.panel.t + g2.panel.h) <= (g2.wrap.t + 1);
      const gap = flipped ? (g2.wrap.t - (g2.panel.t + g2.panel.h))
        : (g2.panel.t - (g2.wrap.t + g2.wrap.h));
      ok(Math.abs(gap) < 24, `★ 空间不够时上翻，依然贴合（间隙 ${gap}px）`, { flipped, gap });
      ok(g2.panel.t >= 0 && g2.panel.t + g2.panel.h <= 761, '面板完全在视口内', g2.panel);
    }
    ok(errs.length === 0, '浏览器无未捕获异常', errs.slice(0, 3));

    /* 说明：字体三态反馈（present / loaded / missing）的断言不在这里 ——
     * 它们依赖真实应用页的 #ass-style-status 与 #ass-style-*-font-note，
     * 而本验证页只有选择器组件本身，没有那些元素（放这儿测会假失败）。
     * 那部分见 tests/jsmod/main.js 的 onFontNameChange 与
     * .staging/verify_font_status.mjs（12/12，已在真实页面验过）。 */

    try { ws.close(); } catch {}
    finished = true;
  } finally {
    try { child.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  if (!finished) console.log('  (浏览器部分未跑完)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
