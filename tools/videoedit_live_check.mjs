/* 就地编辑的"真机验收"：连**已经在跑的那个服务**（不是探针自己起的），
 * 用**真实窗口**（不是无头）从首页点进工程，再用真实鼠标单击/双击字幕（单击=就地编辑，双击=整行弹窗）。
 * 跑法（服务已在 8321 上跑着的话直接用）：
 *   SUBFAB_HEADED=1 node tools/videoedit_live_check.mjs
 *   SUBFAB_HEADED=1 SIZE=1366x768 node tools/videoedit_live_check.mjs
 * 与 videoedit_probe.mjs 的区别：那边是"无头 + 全新临时 profile + 直接用 URL 深链"，
 * 这边是"有头 + 首页点卡片进工程 + 可指定窗口尺寸"，尽量贴近用户实际。
 */
import { launch, sleep } from './lib/cdp.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'outputs');
const BASE = process.env.BASE || 'http://127.0.0.1:8321';
const SIZE = (process.env.SIZE || '1600x1000').split('x').map(Number);
const HEADED = !!process.env.SUBFAB_HEADED;

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};

/** 挑一个"真的有字幕 + 有视频"的本地工程。
 *  **真实工程优先**：名字里带"探针"、或视频指向 tmp-test 的是我自己造的夹具，排后面。 */
function pickProject() {
  const dir = resolve(ROOT, 'projects');
  if (!existsSync(dir)) return null;
  const ids = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  const real = [], fixture = [];
  for (const id of ids) {
    const meta = resolve(dir, id, 'project.json');
    if (!existsSync(meta)) continue;
    try {
      const j = JSON.parse(readFileSync(meta, 'utf8'));
      const sub = j.subtitle && j.subtitle.file;
      const subPath = resolve(dir, id, sub || '');
      const vid = j.video && (j.video.path || j.video.file);
      if (!sub || !existsSync(subPath)) continue;
      if (!vid || !existsSync(String(vid).replace(/\\/g, '/'))) continue;
      const rec = { id, name: j.name, sub: sub || '', video: vid };
      const isFixture = /探针/.test(String(j.name || '')) || /tmp-test/i.test(String(vid));
      (isFixture ? fixture : real).push(rec);
    } catch {}
  }
  // 真实工程里挑视频最大的（越像真片越好）；没有真实工程才退回夹具
  const pool = real.length ? real : fixture;
  if (real.length) {
    const sizeOf = (p) => { try { return statSync(String(p).replace(/\\/g, '/')).size; } catch { return 0; } };
    pool.sort((a, b) => sizeOf(b.video) - sizeOf(a.video));
  }
  console.log(`  工程池: 真实 ${real.length} 个 / 夹具 ${fixture.length} 个 → 用${real.length ? '真实' : '夹具'}的`);
  return pool[0] || null;
}

/** PROJ=<id> 可强制指定工程（用来单独验 SRT 工程 / 某个特定片子） */
function forcedProject() {
  const id = process.env.PROJ;
  if (!id) return null;
  const meta = resolve(ROOT, 'projects', id, 'project.json');
  if (!existsSync(meta)) { console.error('PROJ 指定的工程不存在: ' + id); process.exit(1); }
  const j = JSON.parse(readFileSync(meta, 'utf8'));
  return { id, name: j.name, sub: (j.subtitle && j.subtitle.file) || '', video: (j.video && (j.video.path || j.video.file)) || '' };
}

const proj = forcedProject() || pickProject();
if (!proj) { console.error('没有可用的本地工程（需要 project.json + 字幕文件 + 视频文件都在）'); process.exit(1); }
console.log(`模式: ${HEADED ? '真实窗口(有头)' : '无头'}  窗口 ${SIZE[0]}x${SIZE[1]}  服务 ${BASE}`);
console.log(`工程: ${proj.id}  ${proj.name}  字幕 ${proj.sub}  视频 ${proj.video}`);

const b = await launch({ url: `${BASE}/editor/index.html#/home`, port: 9341, width: SIZE[0], height: SIZE[1] });
try {
  await b.waitFor('!!window.__videoEditor', { timeout: 20000, label: '编辑器就绪' });
  const ver = await b.eval(`(() => ({ stamp: String(window.__BUILD_STAMP || ''), ver: '' }))()`);
  const srvVer = await (await fetch(BASE + '/api/version')).json();
  console.log('  页面版本戳:', ver.stamp, ' 服务端版本戳:', String(srvVer && srvVer.stamp), ' 版本:', srvVer && srvVer.version);
  ok(ver.stamp === String(srvVer && srvVer.stamp), '页面代码与服务端一致（不是旧页面）', [ver.stamp, srvVer && srvVer.stamp]);

  /* 从首页点进工程（真实入口，不是 URL 深链） */
  await sleep(1200);
  const card = await b.eval(`(() => {
    const cards = [...document.querySelectorAll('#home-list .proj-card')];
    const hit = cards.find(e => (e.textContent || '').includes(${JSON.stringify(proj.id)}))
             || cards.find(e => (e.textContent || '').includes(${JSON.stringify(proj.name || '')}));
    if (!hit) return { found: false, n: cards.length };
    hit.scrollIntoView({ block: 'center' });
    const r = hit.getBoundingClientRect();
    return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (card && card.found) {
    console.log(`  首页找到工程卡片(${card.w}x${card.h})，点击:`, Math.round(card.x), Math.round(card.y));
    await b.mouse('mousePressed', card.x, card.y); await b.mouse('mouseReleased', card.x, card.y);
  } else {
    console.log('  首页没定位到卡片（卡片数 ' + (card && card.n) + '）→ 直接跳项目页');
    await b.goto(`${BASE}/editor/index.html#/project/${proj.id}`);
  }
  await sleep(1500);
  await b.waitFor('document.querySelectorAll("#cue-list .cue-card").length > 0', { timeout: 25000, label: '字幕列表' });
  /* 4K 片源的首帧 + libass 首次渲染可能要十几秒 —— 必须等"元数据到位"再动手。
   * 用固定 sleep 会偶发拿到 vw=0 / 全程"可见行 []"，把后面所有断言连坐成假失败。
   * 另有一个实测到的偶发：**经"首页 → 点工程卡片"这条路由进工程时，
   * <video> 的媒体请求偶尔会一直挂在 networkState=2 拿不到元数据**（直接深链进工程页则秒好）。
   * 这里等不到就 reload 一次 —— 刷新后 hash 仍是 #/project/<id>，等价于深链重进。 */
  let meta = null;
  for (let attempt = 0; attempt < 3 && !(meta && meta.vw > 0); attempt++) {
    const limit = attempt === 0 ? 20000 : 45000;
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
      meta = await b.eval(`(() => { const v = document.getElementById('video');
        return { ready: v.readyState, vw: v.videoWidth, vh: v.videoHeight, ns: v.networkState,
          err: v.error ? (v.error.code + ':' + v.error.message) : null }; })()`);
      if (meta.vw > 0) break;
      await sleep(700);
    }
    if (meta && meta.vw > 0) break;
    console.log(`  视频元数据未到位（${JSON.stringify(meta)}）→ 第 ${attempt + 1} 次 reload 重试`);
    await b.eval('location.reload()');
    await b.waitFor('!!window.__videoEditor', { timeout: 30000, label: '重载就绪' });
    await b.waitFor('document.querySelectorAll("#cue-list .cue-card").length > 0', { timeout: 25000, label: '重载字幕列表' });
    await sleep(1500);
  }
  if (meta && meta.vw > 0) console.log(`  视频就绪: readyState=${meta.ready} ${meta.vw}x${meta.vh}`);
  else console.error('  视频元数据始终没到位（环境问题，非功能问题）:', JSON.stringify(meta));
  await sleep(1200);

  const env = await b.eval(`(() => {
    const v = document.getElementById('video');
    return { url: location.hash, fmt: (window.__videoEditor && window.__videoEditor.api) ? 1 : 0,
      vw: v.videoWidth, vh: v.videoHeight, cw: v.clientWidth, ch: v.clientHeight,
      paused: v.paused, t: v.currentTime, ready: v.readyState,
      cards: document.querySelectorAll('#cue-list .cue-card').length,
      dpr: window.devicePixelRatio, innerW: window.innerWidth, innerH: window.innerHeight };
  })()`);
  console.log('  环境:', JSON.stringify(env));

  /* 把播放头放到"确实有字幕"的时刻。
   * 注意：卡片只有 data-idx，没有 data-start → 开始时间要从卡面"开始"那个 <b> 里读（hh:mm:ss.mmm）。 */
  const seekT = await b.eval(`(() => {
    const card = document.querySelector('#cue-list .cue-card');
    if (!card) return null;
    const b0 = card.querySelector('.cc-t b');
    const m = b0 && /(\\d+):(\\d+):(\\d+)(?:[.,](\\d+))?/.exec(b0.textContent || '');
    const start = m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0) : null;
    return { start, seekTo: start == null ? 2 : Math.max(0.05, start + 0.3) };
  })()`) || { start: null, seekTo: 2 };
  console.log('  定位:', JSON.stringify(seekT));

  const layoutDump = async () => b.eval(`(() => {
    const v = document.getElementById('video');
    return { t: v.currentTime, paused: v.paused, rows: window.__videoEditor._layoutItems().map(it => ({
      kind: it.kind, side: it.side, plain: it.plain.slice(0, 24),
      segs: it.segs.map(s => s.text), top: Math.round(it.top), bottom: Math.round(it.bottom),
      x0: Math.round(it.x0), x1: Math.round(it.x0 + it.adv[it.plain.length]),
      segPx: it.segs.map(s => [Math.round(it.x0 + it.adv[s.start]), Math.round(it.x0 + it.adv[s.end])]),
      cxs: it.segs.length ? it.x0 + (it.adv[it.segs[0].start] + it.adv[it.segs[0].end]) / 2 : null })) };
  })()`);

  /* 所有几何断言都必须基于"播放头确实停在 T0"这一刻 ——
   * 一旦播放头漂了（比如某次点击意外切了播放），拿旧 dump 去点就会全错，
   * 那是**脚本自己的状态漂移**，不是功能问题。所以每次测量前统一 park 一次。 */
  const T0 = seekT.seekTo;
  const park = async (t = T0) => {
    for (let k = 0; k < 14; k++) {
      const s = await b.eval(`(() => { const v = document.getElementById('video');
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - ${t}) > 0.06) { try { v.currentTime = ${t}; } catch {} }
        const rows = window.__videoEditor._layoutItems();
        return { t: +v.currentTime.toFixed(3), paused: v.paused, n: rows.length }; })()`);
      if (s.paused && s.n > 0 && Math.abs(s.t - t) < 0.15) return s;
      await sleep(400);
    }
    return null;
  };

  let cur = await layoutDump();
  for (let k = 0; k < 30 && !cur.rows.length; k++) { await sleep(500); cur = await layoutDump(); }
  console.log(`  t=${cur.t.toFixed(2)} 可见行:`, JSON.stringify(cur.rows));
  /* 这一刻没字幕就往后扫（真实片子开头常常有空档） */
  let T0_actual = T0;
  for (const cand of [0.33, 1.2, 2.5, 5, 10, 20, 45, 90]) {
    if (cur.rows.length) break;
    T0_actual = cand;
    await b.eval(`(() => { const v = document.getElementById('video');
      try { v.currentTime = ${cand}; } catch {} v.pause(); return 1; })()`);
    await sleep(1500);
    cur = await layoutDump();
    console.log(`  t=${cur.t.toFixed(2)} 可见行:`, JSON.stringify(cur.rows));
  }
  const items = cur.rows;
  ok(items.length > 0, '当前时刻能估到可见字幕行', items.length);

  await b.shot(resolve(OUT, 'live-1-before.png'));
  let opened = null;
  if (items.length) {
    const it = items[0];
    const st = await b.eval(`document.getElementById('video-stage').getBoundingClientRect().toJSON()`);
    const cx = st.left + (it.cxs != null ? it.cxs : (it.x0 + it.x1) / 2);
    const cy = st.top + (it.top + it.bottom) / 2;
    console.log('  单击位置(视口):', Math.round(cx), Math.round(cy));
    /* 先看看这一点上到底是哪个元素在接事件 —— 有透明层挡住的话这里就能看出来 */
    const at = await b.eval(`(() => {
      const cx = ${JSON.stringify(cx)}, cy = ${JSON.stringify(cy)};
      const el = document.elementFromPoint(cx, cy);
      const stack = document.elementsFromPoint(cx, cy).slice(0, 5).map(e =>
        e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
      const v = document.getElementById('video');
      const vr = v.getBoundingClientRect();
      return { stack, isVideo: el === v, vr: { l: Math.round(vr.left), t: Math.round(vr.top), w: Math.round(vr.width), h: Math.round(vr.height) } };
    })()`);
    console.log('  该点元素栈:', JSON.stringify(at.stack));
    console.log('  点击落在 <video> 上:', at.isVideo, ' video 矩形:', JSON.stringify(at.vr));
    ok(at.isVideo, '字幕位置上方没有遮挡，事件能落到 <video>', at.stack);

    await b.mouse('mouseMoved', cx, cy);        // 真人是先滑过去再点的（接管层要靠悬停武装）
    await sleep(80);
    for (const type of ['mousePressed', 'mouseReleased']) await b.mouse(type, cx, cy, { clickCount: 1 });
    {
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline) { await sleep(80); if (await b.eval('window.__videoEditor.isOpen')) break; }
    }
    opened = await b.eval(`(() => { const ed = window.__videoEditor;
      const box = document.getElementById('cue-inline-editor');
      return { open: ed.isOpen, value: document.getElementById('cie-input').value,
        boxHidden: box.hidden, boxRect: box.getBoundingClientRect().toJSON(),
        segRect: document.getElementById('cue-seg-box').getBoundingClientRect().toJSON(),
        paused: document.getElementById('video').paused }; })()`);
    console.log('  结果:', JSON.stringify({ open: opened.open, value: opened.value, boxHidden: opened.boxHidden,
      box: [Math.round(opened.boxRect.x), Math.round(opened.boxRect.y), Math.round(opened.boxRect.width), Math.round(opened.boxRect.height)] }));
    await b.shot(resolve(OUT, 'live-2-click.png'));
  }
  ok(!!(opened && opened.open === true), '单击字幕 → 就地编辑框打开', opened && { open: opened.open, value: opened.value });
  ok(!!(opened && opened.boxHidden === false), '输入框真的显示在画面上', opened && opened.boxHidden);

  /* 关键回归：画面上同时有中/英两行时，**每一行都必须点得动**，
   * 且点到的必须是那一行的那一段（当初"点不动"就是估位偏 15~20px / 上下行互换导致的）。
   * 每行点两处：首段中心 + 行宽 75% 处（那里的期望段由几何算出来）。 */
  const rowHits = [];
  const moveTo = async (x, y) => {
    /* 关键：接管层是"指针悬到字幕上才武装"的，所以必须先真的移动鼠标过去 ——
     * 真人当然是这么操作的（鼠标一路滑过来，pointermove 早就把层武装好了）。 */
    await b.mouse('mouseMoved', x, y);
    await sleep(60);
  };
  const dbl = async (cx, cy) => {
    await moveTo(cx, cy);
    for (const t of ['mousePressed', 'mouseReleased']) await b.mouse(t, cx, cy, { clickCount: 1 });
    await sleep(40);
    for (const t of ['mousePressed', 'mouseReleased']) await b.mouse(t, cx, cy, { clickCount: 2 });
    await sleep(500);
  };
  /* 手势：**单击**字幕 = 就地编辑（要等过 240ms 双击窗口，框才出来）；双击 = 整行弹窗。
   * 注意：被遮挡/非前台的窗口里 Chrome 会节流 setTimeout（实测 240ms → 630ms），
   * 所以这里**轮询等**而不是睡固定时长，否则会误判成"没开"。 */
  const tap = async (cx, cy) => {
    await moveTo(cx, cy);
    for (const t of ['mousePressed', 'mouseReleased']) await b.mouse(t, cx, cy, { clickCount: 1 });
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      await sleep(80);
      if (await b.eval('window.__videoEditor.isOpen')) return true;
    }
    return false;
  };
  for (let i = 0; i < items.length; i++) {
    const side = items[i].side;
    /* 每行点两处：首段中心 + 行宽 75% 处。
     * **每次点击前都重新 park + 重新取几何，并且 x 和 y 必须来自同一次 dump** ——
     * 拿上一次的坐标去点、或者 x 用旧 dump、y 用新 dump，播放头/墨迹一有变化就会错配。 */
    for (let pass = 0; pass < 2; pass++) {
      const parked2 = await park(T0_actual);
      const it = (await layoutDump()).rows.find(r => r.side === side);
      if (!it) { console.log(`  第${i + 1}行(${side}) 此刻不在画面上，跳过（park=${JSON.stringify(parked2)}）`); break; }
      const x = pass === 0 ? (it.cxs != null ? it.cxs : (it.x0 + it.x1) / 2)
        : it.x0 + (it.x1 - it.x0) * 0.75;
      await b.eval(`window.__videoEditor.isOpen && window.__videoEditor.close()`);
      await sleep(180);
      const st = await b.eval(`document.getElementById('video-stage').getBoundingClientRect().toJSON()`);
      const cx = st.left + x, cy = st.top + (it.top + it.bottom) / 2;
      // 期望段：几何上包住这个 x 的那一段
      const k = it.segPx.findIndex(([a, bnd]) => x >= a && x <= bnd);
      const want = k >= 0 ? it.segs[k] : null;
      /* 点之前先静默调一次命中判定 —— 分清"几何没算对"和"事件没送到" */
      const pre = await b.eval(`(() => {
        const v = document.getElementById('video');
        const st = document.getElementById('video-stage').getBoundingClientRect();
        const hit = window.__videoEditor.hitTestAt(${x}, ${(it.top + it.bottom) / 2});
        const sh = document.getElementById('cue-hit-shield');
        const barTop = st.height - 72;
        return { paused: v.paused, t: +v.currentTime.toFixed(3),
          hit: hit ? { side: hit.item.side, seg: hit.seg.text } : null,
          inBar: ${(it.top + it.bottom) / 2} > barTop,       // 这行是不是压在控制条上
          shieldHidden: sh.hidden, shieldArmed: sh.classList.contains('armed'),
          shieldRect: sh.hidden ? null : { l: Math.round(parseFloat(sh.style.left)), t: Math.round(parseFloat(sh.style.top)),
            w: Math.round(parseFloat(sh.style.width)), h: Math.round(parseFloat(sh.style.height)) } };
      })()`);
      pre.park = parked2;
      await tap(cx, cy);
      const r = await b.eval(`(() => { const ed = window.__videoEditor; const o = ed.open;
        return { open: ed.isOpen, value: document.getElementById('cie-input').value,
          side: o ? o.item.side : null, seg: o ? o.seg.text : null,
          paused: document.getElementById('video').paused, t: +document.getElementById('video').currentTime.toFixed(3) }; })()`);
      rowHits.push({ i, side: it.side, x: Math.round(cx), y: Math.round(cy), want, open: r.open,
        value: r.value, hitSide: r.side, hitSeg: r.seg, pre, pausedAfter: r.paused });
      console.log(`  第${i + 1}行(${it.side}) x=${Math.round(x)} y=${Math.round(cy)} ` +
        `${pre.inBar ? '[压在控制条上]' : ''} → ` +
        (r.open ? `打开：命中行=${r.side} 段="${r.seg}" 框内="${r.value}"｜期望段${want == null ? '(缝隙)' : '"' + want + '"'}`
                : `没反应｜静默命中=${JSON.stringify(pre.hit)} 接管层=${JSON.stringify(pre.shieldRect)} armed=${pre.shieldArmed}`));
    }
  }
  ok(rowHits.every(r => r.open === true), `画面上 ${items.length} 行共 ${rowHits.length} 次单击全部打开就地编辑框`, rowHits.filter(r => !r.open));
  ok(rowHits.every(r => r.open && r.hitSide === r.side), '单击哪行就命中哪行（行↔框配对正确）',
    rowHits.map(r => ({ side: r.side, hitSide: r.hitSide })));
  ok(rowHits.every(r => r.open && (r.want == null || r.value === r.want)), '单击哪个片段就编辑哪个片段（点什么改什么）',
    rowHits.map(r => ({ want: r.want, got: r.value })));
  ok(rowHits.every(r => r.pausedAfter === true), '单击字幕不会顺手切播放/暂停（编辑时定住画面）',
    rowHits.filter(r => r.pausedAfter !== true).map(r => ({ side: r.side, y: r.y })));
  await b.eval(`window.__videoEditor.isOpen && window.__videoEditor.close()`);
  await sleep(200);

  /* ── 新手势：双击字幕 = 整行文本弹窗 ── */
  if (items.length) {
    await park(T0_actual);
    const it0 = (await layoutDump()).rows[0] || items[0];
    const st0 = await b.eval(`document.getElementById('video-stage').getBoundingClientRect().toJSON()`);
    await dbl(st0.left + (it0.cxs != null ? it0.cxs : (it0.x0 + it0.x1) / 2), st0.top + (it0.top + it0.bottom) / 2);
    const dlg = await b.eval(`(() => ({
      shown: !document.getElementById('cue-text-overlay').hidden,
      title: (document.querySelector('#cue-text-overlay .rn-title') || {}).textContent || '',
      input: document.getElementById('ctd-input').value,
      preview: document.getElementById('ctd-preview').textContent,
      inlineOpen: window.__videoEditor.isOpen }))()`);
    console.log(`  双击字幕 → 整行弹窗=${dlg.shown ? '开' : '没开'}「${dlg.title}」预填="${dlg.input.slice(0, 20)}"`);
    ok(dlg.shown === true, '双击字幕 → 弹出整行文本弹窗（不再进就地编辑）', dlg);
    ok(dlg.inlineOpen === false, '双击字幕时不再同时开出就地编辑框', dlg);
    ok(/仅修改 Text 字段/.test(dlg.title), '弹窗标题与参考图一致', dlg.title);
    await b.shot(resolve(OUT, 'live-3-modal.png'));
    await b.eval(`document.getElementById('ctd-cancel').click()`);
    await sleep(300);
  }

  /* ── 新手势：编辑框开着时，单击**另一条字幕**应直接切过去（一次点击，不用先点空白） ── */
  if (items.length > 1) {
    await park(T0_actual);
    const fresh = (await layoutDump()).rows;
    const st1 = await b.eval(`document.getElementById('video-stage').getBoundingClientRect().toJSON()`);
    const a = fresh[0] || items[0], bp = fresh[1] || items[1];
    await tap(st1.left + (a.cxs != null ? a.cxs : (a.x0 + a.x1) / 2), st1.top + (a.top + a.bottom) / 2);
    const first = await b.eval(`(() => { const o = window.__videoEditor.open; return o ? o.item.side + '/' + o.seg.text : null; })()`);
    // 不先关闭，直接点另一条
    await tap(st1.left + (bp.cxs != null ? bp.cxs : (bp.x0 + bp.x1) / 2), st1.top + (bp.top + bp.bottom) / 2);
    const second = await b.eval(`(() => { const o = window.__videoEditor.open; return o ? o.item.side + '/' + o.seg.text : null; })()`);
    console.log(`  框开着(${first}) → 单击另一条 → ${second}`);
    ok(second && second.startsWith(bp.side + '/') && second !== first,
      '编辑框开着时单击另一条字幕 → 直接切过去（一次点击）', { first, second, want: bp.side + '/' + bp.segs[0] });
    await b.eval(`window.__videoEditor.isOpen && window.__videoEditor.close()`);
    await sleep(200);
  }

  /* ── 只读的角色/颜色前缀：单击它**既不编辑、也不切播放** ──
   * （曾经这里会被当成"点空白"，等 240ms 双击窗口过去就把视频播起来了 —— 实测踩过） */
  {
    await park(T0_actual);
    const rowsN = (await layoutDump()).rows;
    const tag = rowsN.find(it => it.side === 'zh') || rowsN.find(it => it.x0 < it.segPx[0][0] - 6);
    if (tag && tag.segPx[0][0] - tag.x0 > 12) {
      const stT = await b.eval(`document.getElementById('video-stage').getBoundingClientRect().toJSON()`);
      const x = stT.left + (tag.x0 + tag.segPx[0][0]) / 2;
      const y = stT.top + (tag.top + tag.bottom) / 2;
      await b.eval(`window.__videoEditor.isOpen && window.__videoEditor.close()`);
      await b.eval(`(() => { document.getElementById('video').pause(); return 1; })()`);
      await sleep(200);
      await tap(x, y);
      const r = await b.eval(`(() => ({ open: window.__videoEditor.isOpen,
        paused: document.getElementById('video').paused, t: +document.getElementById('video').currentTime.toFixed(3) }))()`);
      console.log(`  单击只读前缀 (${Math.round(x)},${Math.round(y)}) → 编辑框=${r.open ? '开' : '没开'} 播放中=${!r.paused} t=${r.t}`);
      ok(r.open === false, '单击只读的 [角色] 前缀不进入编辑', r);
      ok(r.paused === true, '单击只读前缀也不会顺手切播放/暂停', r);
      await b.eval(`window.__videoEditor.isOpen && window.__videoEditor.close()`);
      await sleep(200);
    }
  }

  /* 接管层不能"顺手把整条控制条霸占"：它只该盖住字幕文字那一段，别处进度条/音量必须照常可点。
   * 这里直接量接管层**自己的矩形**（别用几百毫秒前记下的坐标 —— 字幕一换行就对不上了）。 */
  const inBar = rowHits.find(r => r.pre.inBar);
  if (inBar) {
    const scope = await b.eval(`(() => {
      const sh = document.getElementById('cue-hit-shield');
      const v = document.getElementById('video');
      const vr = v.getBoundingClientRect();
      if (sh.hidden) return { hidden: true };
      const r = sh.getBoundingClientRect();
      const y = r.top + r.height / 2, xm = r.left + r.width / 2;
      const has = (x, yy) => document.elementsFromPoint(x, yy).some(e => e.id === 'cue-hit-shield');
      return { hidden: false, rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        y: Math.round(y), overText: has(xm, y),
        farLeft: has(Math.max(2, vr.left + 3), y),
        coversWholeBar: r.width >= vr.width - 4,
        barTop: Math.round(vr.bottom - 72), bottom: Math.round(vr.bottom) };
    })()`);
    if (scope.hidden) {
      console.log('  接管层此刻未挂载（这一刻那行没压到控制条上）→ 跳过范围断言');
    } else {
      console.log(`  接管层矩形: ${JSON.stringify(scope.rect)}｜带内 y=${scope.y}｜字幕处=${scope.overText ? '盖住' : '没盖'} ` +
        `远离字幕处=${scope.farLeft ? '盖住' : '没盖'}（控制条带 ${scope.barTop}~${scope.bottom}，整条宽判定=${scope.coversWholeBar}）`);
      ok(scope.overText, '压到控制条的字幕文字上有接管层（所以单击才有事件）', scope);
      ok(!scope.farLeft && !scope.coversWholeBar, '接管层没有霸占整条控制条，别处的进度条/音量照常可点', scope);
    }
  }

  /* 打字 → 画面跟着变 */
  if (items.length) {
    // 上面那轮把框关掉了，这里重新打开一行来测输入（单击）
    await park(T0_actual);
    const it0 = (await layoutDump()).rows[0] || items[0];
    const st0 = await b.eval(`document.getElementById('video-stage').getBoundingClientRect().toJSON()`);
    await tap(st0.left + (it0.cxs != null ? it0.cxs : (it0.x0 + it0.x1) / 2), st0.top + (it0.top + it0.bottom) / 2);
    opened = { open: await b.eval('window.__videoEditor.isOpen') };
  }
  if (opened && opened.open) {
    await b.eval(`(() => { const i = document.getElementById('cie-input');
      i.value = i.value + '啦'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await sleep(400);
    const v2 = await b.eval(`document.getElementById('cie-input').value`);
    ok(v2.endsWith('啦'), '输入框可编辑', v2);
    await b.eval(`(() => { const i = document.getElementById('cie-input'); i.value = i.value.slice(0, -1); return 1; })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(300);
    ok(!(await b.eval('window.__videoEditor.isOpen')), 'Esc 关闭', null);
  }

  /* ── 新手势：单击**空白视频区** = 播放/暂停（逻辑不变）。
   *  放在最后：它会把播放头带走，前面那些依赖"某一帧几何"的断言必须先跑完。
   *  跑完再把播放头拨回原处，免得影响别的东西。 */
  {
    const t0 = await b.eval(`document.getElementById('video').currentTime`);
    const vp = await b.eval(`(() => { const s = document.getElementById('video-stage').getBoundingClientRect();
      return { x: Math.round(s.left + s.width * 0.5), y: Math.round(s.top + s.height * 0.3) }; })()`);
    await b.eval(`(() => { const v = document.getElementById('video'); v.pause(); return 1; })()`);
    await sleep(150);
    await b.mouse('mouseMoved', vp.x, vp.y); await sleep(60);
    for (const t of ['mousePressed', 'mouseReleased']) await b.mouse(t, vp.x, vp.y, { clickCount: 1 });
    await sleep(1800);                       // 同样要盖过被节流后的 240ms 定时器
    const playing = await b.eval(`!document.getElementById('video').paused`);
    const noEditor = await b.eval(`!window.__videoEditor.isOpen`);
    console.log(`  单击空白视频区 (${vp.x},${vp.y}) → 开始播放=${playing}  也没开出编辑框=${noEditor}`);
    ok(playing === true, '单击空白视频区 = 播放（逻辑不变）', { playing });
    ok(noEditor === true, '单击空白视频区不会误开就地编辑框', null);
    // 再点一下应当暂停（同一个逻辑的另一半）
    for (const t of ['mousePressed', 'mouseReleased']) await b.mouse(t, vp.x, vp.y, { clickCount: 1 });
    await sleep(1800);
    ok((await b.eval(`document.getElementById('video').paused`)) === true, '再单击空白视频区 = 暂停（逻辑不变）', null);
    await b.eval(`(() => { const v = document.getElementById('video'); v.pause(); v.currentTime = ${t0}; return 1; })()`);
    await sleep(1200);
  }

  const errs = (b.logs || []).filter(l => /\[exception\]/.test(l));
  ok(errs.length === 0, '页面无 JS 异常', errs.slice(0, 3));
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('截图 → outputs/live-1-before.png / live-2-click.png');
} catch (e) {
  console.error('异常:', e && e.message);
  console.error((b.logs || []).slice(-8).join('\n'));
} finally {
  b.close();
}
process.exit(fail ? 1 : 0);
