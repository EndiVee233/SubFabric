// 复现「选区重新识别按钮点不动」: 真实鼠标事件做 Ctrl+拖动框选, 再真实点击按钮,
// 全程记录 fetch 调用、控制台错误、按钮/浮条的几何与命中测试结果。
//
// 用法: node tools/probe_rerecog.mjs <projectId>
import { launch, sleep, report } from './lib/cdp.mjs';

const PID = process.argv[2] || 'p-mujcirdz-m8wrx';
const BASE = 'http://127.0.0.1:8321';
const br = await launch({ url: `${BASE}/#/project/${PID}` });

// 捕获所有 fetch(含 rerecognize), 在每个新文档里注入, 避免被导航清掉
const HOOK = `(() => {
  window.__calls = [];
  const of = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0] && args[0].url ? args[0].url : args[0]);
    const method = (args[1] && args[1].method) || 'GET';
    const entry = { url, method, status: 'pending' };
    window.__calls.push(entry);
    try {
      const r = await of.apply(window, args);
      entry.status = r.status;
      if (/rerecognize/.test(url)) { try { entry.body = (await r.clone().text()).slice(0, 300); } catch {} }
      return r;
    } catch (e) { entry.status = 'ERR ' + e.message; throw e; }
  };
  return true;
})()`;
await br.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
await br.goto(`${BASE}/#/project/${PID}`);
await br.waitFor(`typeof window.__calls !== 'undefined'`, { timeout: 8000, label: '注入 hook' });
try {
  await br.waitFor(`document.querySelectorAll('.cue-card').length > 0`, { timeout: 20000, label: '字幕列表加载' });
} catch (e) {
  report('字幕列表未加载', { url: await br.eval('location.href'), err: e.message });
}
await sleep(1200);

const geom = await br.eval(`(() => {
  const cv = document.getElementById('timeline');
  const rb = document.getElementById('range-bar');
  const btn = document.getElementById('rb-rerecog');
  const wrap = document.getElementById('tl-canvas-wrap');
  const r = cv.getBoundingClientRect();
  const btnR = btn.getBoundingClientRect();
  const cs = getComputedStyle(rb);
  return {
    cards: document.querySelectorAll('.cue-card').length,
    canvas: { x: r.x, y: r.y, w: r.width, h: r.height },
    wrap: wrap ? { x: wrap.getBoundingClientRect().x, y: wrap.getBoundingClientRect().y, w: wrap.getBoundingClientRect().width, h: wrap.getBoundingClientRect().height } : null,
    rbHidden: rb.hidden, rbDisplay: cs.display, rbZ: cs.zIndex, rbPos: cs.position,
    rbRect: { x: rb.getBoundingClientRect().x, y: rb.getBoundingClientRect().y, w: rb.getBoundingClientRect().width, h: rb.getBoundingClientRect().height },
    btnRect: { x: btnR.x, y: btnR.y, w: btnR.width, h: btnR.height },
    btnPointerEvents: getComputedStyle(btn).pointerEvents,
  };
})()`);
report('几何/初始状态', geom);

/* ── 1) Ctrl+左键在轨道上拖动 → 批量选区 ── */
const cv = geom.canvas;
// 轨道区: 画布底部那一条(与 main.js _laneTop 对应); 取靠下 1/3 处比较稳
const y = Math.round(cv.y + cv.h * 0.8);
const x0 = Math.round(cv.x + 40);
const x1 = Math.round(cv.x + 260);
await br.dragWithCtrl(x0, y, x1, y);
await sleep(300);

report('框选后', await br.eval(`(() => {
  const rb = document.getElementById('range-bar');
  const c = document.getElementById('rb-count');
  return { rbHidden: rb.hidden, count: c && c.textContent, calls: window.__calls.filter(x=>/rerecog/.test(x.url)) };
})()`));

const afterSel = await br.eval(`(() => {
  const btn = document.getElementById('rb-rerecog');
  const r = btn.getBoundingClientRect();
  const cx = r.x + r.width/2, cy = r.y + r.height/2;
  const el = document.elementFromPoint(cx, cy);
  return { btnRect: {x:r.x,y:r.y,w:r.width,h:r.height}, center:{cx,cy},
    elementAtCenter: el ? (el.tagName + '#' + el.id + '.' + el.className) : null,
    btnContains: el ? btn.contains(el) || el === btn : false,
    rbHidden: document.getElementById('range-bar').hidden };
})()`);
report('按钮中心命中测试', afterSel);

/* ── 2) 真实点击「重新识别」按钮 ── */
if (!afterSel.rbHidden && afterSel.btnRect.w > 0) {
  const { cx, cy } = afterSel.center;
  await br.click(Math.round(cx), Math.round(cy));
  await sleep(2500);
  report('点击后', await br.eval(`(() => ({
    calls: window.__calls.filter(x => /rerecog|translate\\/config/.test(x.url)),
    rbHidden: document.getElementById('range-bar').hidden,
    toast: (document.getElementById('toast') || {}).textContent || null,
    toasts: [...document.querySelectorAll('#toast, .toast')].map(e => e.textContent).slice(0,5),
  }))()`));
} else {
  report('按钮不可点', afterSel);
}

report('控制台/日志', br.logs.length ? br.logs.join('\n') : '(无)');
report('网络(非 2xx 或 rerecog)', br.net.filter((n) => n.phase !== 'req' && (n.status >= 400 || /rerecog/.test(n.url))).slice(0, 20));

await br.shot('tmp-test/shot-rerecog.png');
br.close();
process.exit(0);
