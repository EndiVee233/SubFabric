/* 布局探针：调"区域高度"与拖分割线时，视频区/时间轴必须**按比例**此消彼长，且不溢出窗口。
 * 同时检查字幕列表能不能滚到最后一条（用户报的"字幕块显示不全"）。 */
import { launch, sleep } from './lib/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8321';
const list = (await (await fetch(BASE + '/api/projects')).json()).projects;
const proj = list.find(p => !p.draft) || list[0];
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const b = await launch({ port: 9412, width: 1440, height: 900 });
const M = async () => JSON.parse(await b.eval(`(() => {
  const app = document.getElementById('app'), cs = getComputedStyle(app);
  const g = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().height) : null; };
  const st = g('video-stage'), v = document.querySelector('video');
  return JSON.stringify({
    rows: cs.gridTemplateRows, tlVar: cs.getPropertyValue('--tl-h').trim(),
    stageWrap: g('stage-wrap'), stage: st, video: v ? Math.round(v.getBoundingClientRect().height) : null,
    tlPanel: g('timeline-panel'), win: window.innerHeight, bodyScroll: document.body.scrollHeight,
  });
})()`));

await b.goto(BASE + '/#/project/' + proj.id);
await sleep(4500);
const m0 = await M();
console.log('初始:', JSON.stringify(m0));
ok(Math.abs(m0.stage - m0.stageWrap) <= 2, '视频舞台填满它的容器（修好前是 150 vs 517）', m0.stage + ' vs ' + m0.stageWrap);
ok(m0.stage > 200, '舞台高度不再是那个 150px 的默认值', m0.stage);
ok(m0.bodyScroll <= m0.win + 1, '页面不溢出窗口', m0.bodyScroll + ' vs ' + m0.win);

// 用真实滑杆改时间轴高度，视频行必须反向变化（和 ≈ 常数）
const setTl = async (px) => {
  await b.eval(`(() => { const s = document.getElementById('set-tlh'); s.value = '${px}'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  return M();
};
const mSmall = await setTl(96);
const mBig = await setTl(600);
console.log('时间轴 96px:', JSON.stringify(mSmall));
console.log('时间轴 600px:', JSON.stringify(mBig));
ok(Math.abs(mSmall.tlPanel - 96) <= 3, '时间轴面板跟着滑杆变（96）', mSmall.tlPanel);
// 拉到 600 时 App 会钳制到"给视频区留出最小高度"的位置（这是有意的），所以断言"明显变大"而不是等于 600
ok(mBig.tlPanel > 400, '时间轴面板跟着滑杆变（拉到 600 被钳制到留出最小视频区）', mBig.tlPanel);
ok(mBig.stage < mSmall.stage - 300, '时间轴变高 → 视频区明显变矮（按比例）', mSmall.stage + ' → ' + mBig.stage);
ok(Math.abs((mSmall.stageWrap + mSmall.tlPanel) - (mBig.stageWrap + mBig.tlPanel)) <= 4,
  '视频行 + 时间轴 ≈ 常数（此消彼长）', (mSmall.stageWrap + mSmall.tlPanel) + ' vs ' + (mBig.stageWrap + mBig.tlPanel));
ok(mBig.stage > 80 && mBig.stage < mBig.stageWrap + 2, '视频区没有被压没', mBig.stage);

// 回到默认，再用分割线拖一把
await setTl(232);
const pos = await b.eval("(() => { const r = document.getElementById('hsplit').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()");
const p = JSON.parse(pos);
await b.mouse('mousePressed', p.x, p.y, { clickCount: 1 });
await b.mouse('mouseMoved', p.x, p.y - 120);
await b.mouse('mouseReleased', p.x, p.y - 120);
await sleep(700);
const mDrag = await M();
console.log('向上拖 120px:', JSON.stringify(mDrag));
ok(mDrag.tlPanel > 300, '拖分割线能加高时间轴', mDrag.tlPanel);
ok(mDrag.stage < m0.stage - 60, '拖分割线时视频区同步变矮', m0.stage + ' → ' + mDrag.stage);

/* ── 时间轴内部：无论多矮都必须"整条轨都在面板内"（用户报的"太矮显示不全"）── */
const geom = async () => JSON.parse(await b.eval("JSON.stringify(window.__timeline && window.__timeline.debugLayout ? window.__timeline.debugLayout() : null)"));
const checkFits = async (label) => {
  const g = await geom();
  const good = g && g.fits === true && g.laneBottom <= g.cssH + 0.5 && (g.laneH === 0 || g.laneH >= 10);
  ok(good, `整条轨都在面板内（${label}）`, JSON.stringify(g));
  return g;
};
for (const [film, filmLabel] of [[false, '胶片关'], [true, '胶片开']]) {
  await b.eval(`(() => { const c = document.getElementById('set-film'); if (c.checked !== ${film}) { c.checked = ${film}; c.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await sleep(500);
  for (const px of [96, 120, 160, 232, 400]) {
    await setTl(px);
    await checkFits(`${filmLabel} / ${px}px`);
  }
}
// 再收一个"矮窗口"测一遍（时间轴 + 视频区都要活）
await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 560, deviceScaleFactor: 1, mobile: false });
await sleep(900);
await setTl(96);
await checkFits('矮窗口 560px 高 / 96px');
const mSmallWin = await M();
ok(mSmallWin.bodyScroll <= mSmallWin.win + 1, '矮窗口下页面也不溢出', mSmallWin.bodyScroll + ' vs ' + mSmallWin.win);
await b.send('Emulation.clearDeviceMetricsOverride', {});
await sleep(600);


// 字幕列表：滚到最后一条
await b.eval("document.querySelector('.ptab[data-tab=\"subs\"]').click()");
await sleep(700);
const li = JSON.parse(await b.eval(`(() => {
  const el = document.getElementById('cue-list');
  if (!el) return 'null';
  const cards = el.querySelectorAll('.cue-card');
  el.scrollTop = el.scrollHeight;
  const last = cards[cards.length - 1];
  const er = el.getBoundingClientRect(), lr = last ? last.getBoundingClientRect() : null;
  return JSON.stringify({
    cards: cards.length, clientH: Math.round(el.clientHeight), scrollH: Math.round(el.scrollHeight),
    maxScroll: Math.round(el.scrollHeight - el.clientHeight), after: Math.round(el.scrollTop),
    lastVisible: lr ? (lr.bottom <= er.bottom + 1 && lr.top >= er.top - 1) : null,
    lastH: lr ? Math.round(lr.height) : null,
  });
})()`));
console.log('字幕列表:', JSON.stringify(li));
ok(li.maxScroll > 0, '列表可滚动（长字幕文件）', li.maxScroll);
ok(li.after > 0, '确实滚动了', li.after);
ok(li.lastVisible === true, '滚到底后最后一条卡片完整可见', JSON.stringify(li));

console.log(`\n${pass} passed, ${fail} failed`);
b.close();
process.exit(fail ? 1 : 0);
