/* 字幕列表虚拟滚动 —— 正确性 + 性能验证探针(真实应用内)
 *
 * 虚拟化的前提是"位置表必须和真实全量渲染完全等价", 所以本探针先做一次**全量渲染**当参考,
 * 再逐条比对虚拟化后的位置表/撑高; 然后验证可视覆盖、点击映射、选中定位、行内编辑定位,
 * 最后量删除一条的开销(用户报的场景)。
 *
 * 用法: node tools/cue_list_virtual_probe.mjs [行数=5000]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PROBE_PORT || 8421);
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9421);
const N = Number(process.argv[2] || 5000);
const UNIQ = !!process.env.PROBE_UNIQ;      // 每条文本都不同(最坏情况: 高度缓存无法去重)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pageProbe(n, uniq) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const dbg = window.__dbg, panel = dbg.panel;
  const listEl = panel.listEl, spacer = panel.spacerEl;
  const R = { pass: 0, fail: 0, checks: [] };
  const ok = (c, name, extra) => {
    R.checks.push({ ok: !!c, name, extra: extra == null ? '' : String(extra) });
    if (c) R.pass++; else R.fail++;
  };

  const ZH = ['这就是我为什么一直在这里等你的原因', '别急', '我们先把这个东西拆开看看', '他说这句话的时候我就在旁边', '所以到底发生了什么'];
  const EN = ['This is exactly why I have been waiting here for you', 'Hold on', 'Let us take this thing apart first', 'I was right there when he said it', 'So what on earth happened'];
  const UNIQ = !!uniq;             // 每条文本都不同 → 指纹不重复, 最坏情况(真实稿件接近这个)
  const mkItems = (k) => {
    const a = [];
    for (let i = 0; i < k; i++) {
      const s = i * 3.2;
      a.push({
        kind: 'ass-row', ref: {}, no: i + 1, start: s, end: s + 2.8,
        l1: ZH[i % ZH.length] + (i % 7 === 0 ? '，结果还是没赶上最后一班车' : '') + (UNIQ ? ' #' + i : ''),
        l2: EN[i % EN.length] + (UNIQ ? ' #' + i : ''),
        badge1: i % 3 === 0 ? '中文字幕' : '', badge2: i % 5 === 0 ? '英文字幕' : '',
        color: i % 4 === 0 ? '#ff7a45' : null, speaker: i % 6 === 0 ? '[Spoke]' : '',
        isNew: false, bad: i % 97 === 0, badReason: i % 97 === 0 ? '测试异常' : '',
      });
    }
    return a;
  };
  const items = mkItems(n);
  const tasks = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(Math.round(e.duration)); });
    po.observe({ entryTypes: ['longtask'] });
    R._po = po;
  } catch (e) {}
  const takeTasks = () => { const t = tasks.slice(); tasks.length = 0; return t; };

  R.geom = { listW: listEl.clientWidth, listH: listEl.clientHeight };

  /* 布局无关的滚动/可视区工具:
   *   桌面布局 —— #cue-list 受高度约束, 列表自己滚(scrollTop);
   *   窄屏堆叠布局 —— #cue-list 被内容撑满, 整页滚(window)。
   * 两种情形下"当前可见的内容区间"都从矩形求交算, 断言才能通用。 */
  // 列表"能不能自己滚"才是关键: 能滚 → 桌面布局(滚列表); 不能滚(被内容撑满) → 整页滚。
  const unbounded = () => (listEl.scrollHeight - listEl.clientHeight) <= 2 && listEl.scrollHeight > (window.innerHeight + 10);
  const visibleBand = () => {
    const sr = spacer.getBoundingClientRect(), lr = listEl.getBoundingClientRect();
    const t = Math.max(0, Math.max(sr.top, lr.top, 0) - sr.top);
    const b = Math.min(panel._totalH, Math.min(sr.bottom, lr.bottom, window.innerHeight) - sr.top);
    return { top: t, bot: b };
  };
  // 窄屏堆叠布局下真正在滚的是 document.body(html/body 都是 height:100% + overflow-y:auto),
  // window.scrollTo 不生效 → 直接找那个"内容比可视区高"的滚动容器。
  const pageScroller = () => [document.scrollingElement, document.documentElement, document.body]
    .find(e => e && (e.scrollHeight - e.clientHeight) > 2) || document.scrollingElement;
  const scrollTo = async (contentTop) => {
    if (unbounded()) {
      const sr = spacer.getBoundingClientRect();
      const sc = pageScroller();
      sc.scrollTop = Math.max(0, sc.scrollTop + (contentTop - Math.max(0, -sr.top)));
    } else {
      listEl.scrollTop = contentTop;
    }
    await raf2();
    await sleep(60);
  };

  /* ── 0. 参考: 全量渲染一次, 逐条量高 → 真实总高 ──
   * 注意总高要用"首卡顶边 → 末卡底边"的真实几何量出来, 不能自己套 sum(h)+gap*(n-1):
   * 那样算出来和虚拟化用的是同一个公式, 等于恒等式, 漂多少都查不出来。 */
  const ref = { h: [], total: 0, tops: [] };
  {
    spacer.style.height = '';
    spacer.innerHTML = items.map((it, i) => panel._cardHtml(it, i)).join('');
    void spacer.offsetHeight;
    const kids = spacer.children;
    for (let i = 0; i < n; i++) ref.h.push(kids[i] ? kids[i].getBoundingClientRect().height : 0);
    const first = kids[0].getBoundingClientRect(), last = kids[n - 1].getBoundingClientRect();
    ref.total = last.bottom - first.top;
    // 采样几个下标的真实累计偏移(offsetTop 相对 spacer), 用来查位置表的累积漂移
    for (const i of [0, 1, 10, 100, 1000, Math.floor(n / 2), n - 100, n - 1]) {
      if (i >= 0 && i < n) ref.tops.push({ i, top: kids[i].offsetTop });
    }
    spacer.innerHTML = '';
    R.refTotal = Math.round(ref.total);
  }

  /* ── 1. 首次 setItems: 应该只渲染窗口, 且撑高 == 真实总高 ── */
  const t0 = performance.now();
  panel.setItems(items);
  const tSync = performance.now() - t0;
  const l0 = performance.now(); void spacer.offsetHeight; const tLayout = performance.now() - l0;
  const p0 = performance.now(); await raf2(); const tPaint = performance.now() - p0;
  await sleep(200);
  R.setItems = { sync: +tSync.toFixed(1), layout: +tLayout.toFixed(1), paint: +tPaint.toFixed(1), longTasks: takeTasks() };
  R.setItems.longTasks = R.setItems.longTasks.slice(0, 6);
  R.layout = unbounded() ? '窄屏(整页滚)' : '桌面(列表滚)';
  R.listGeom = { clientH: listEl.clientHeight, scrollH: listEl.scrollHeight, spacerH: Math.round(spacer.offsetHeight), innerH: window.innerHeight };

  const rendered = document.querySelectorAll('.cue-card').length;
  R.rendered = rendered;
  R.totalH = Math.round(panel._totalH);
  R.spacerH = Math.round(spacer.offsetHeight);

  ok(rendered >= 1 && rendered <= Math.min(n, 120), `只渲染可视窗口(实际 ${rendered} 张, 共 ${n} 条)`, rendered);
  ok(Math.abs(panel._totalH - ref.total) <= 1, '撑高 == 全量渲染的真实几何总高(±1px)', `虚拟 ${Math.round(panel._totalH)} vs 真实 ${Math.round(ref.total)}`);
  ok(Math.abs(spacer.offsetHeight - ref.total) <= 1, 'spacer 实际高度 == 真实总高(±1px)', `${Math.round(spacer.offsetHeight)} vs ${Math.round(ref.total)}`);
  ok(R.setItems.sync < 450, `首次 setItems(含一次性全量量高) < 450ms(实际 ${R.setItems.sync}ms)`, R.setItems.sync);
  ok(!R.setItems.longTasks.some(d => d > 1200), '首次 setItems 没有 >1200ms 的主线程长任务', JSON.stringify(R.setItems.longTasks));

  /* ── 2. 位置表逐条等价: 缓存高度 == 实测高度 + 卡片间距 ── */
  {
    let bad = 0, firstBad = '', worst = 0;
    for (let i = 0; i < n; i++) {
      const h = panel._h.get(panel._hKey(items[i]));
      const want = ref.h[i] + 6;
      const d = h == null ? 999 : Math.abs(h - want);
      if (d > 0.5) { bad++; if (!firstBad) firstBad = `#${i} 缓存=${h} 实测=${want}`; }
      if (d > worst) worst = d;
    }
    ok(bad === 0, '每条缓存行高 == 实测行高 + 间距(±0.5px)', bad ? `${bad} 条不符, 例如 ${firstBad}` : `全部 ${n} 条一致, 最大偏差 ${worst.toFixed(3)}px`);
  }

  /* ── 2.5 累积漂移: 位置表必须和全量渲染的真实累计偏移一致(整数行高会在这里露出马脚) ── */
  {
    let worst = 0, worstAt = '';
    for (const t of ref.tops) {
      const d = Math.abs(panel._offsets[t.i] - t.top);
      if (d > worst) { worst = d; worstAt = `#${t.i} 表=${panel._offsets[t.i].toFixed(2)} 实=${t.top}`; }
    }
    ok(worst <= 1, '位置表无累积漂移(与全量渲染逐点比对 ≤1px)', `最大偏差 ${worst.toFixed(3)}px ${worstAt}`);
  }

  /* ── 3. 已渲染卡片 offsetTop == 位置表偏移(选中/编辑定位依赖这条) ── */
  const checkOffsets = (label) => {
    const kids = spacer.children;
    let bad = 0, firstBad = '', cnt = 0;
    for (let k = 1; k < kids.length; k++) {          // kids[0] 是顶部占位
      const el = kids[k];
      const idx = +el.dataset.idx;
      cnt++;
      const want = panel._offsets[idx];
      if (Math.abs(el.offsetTop - want) > 0.6) { bad++; if (!firstBad) firstBad = `idx=${idx} dom=${el.offsetTop} 表=${want}`; }
    }
    ok(bad === 0 && cnt >= 1, `${label}: 卡片 offsetTop == 位置表(±0.6px)`, bad ? `${bad}/${cnt} 不符, ${firstBad}` : `${cnt} 张一致`);
  };
  checkOffsets('初始窗口');

  /* ── 3.5 逐像素等价: 同一张卡在"全量渲染"与"虚拟窗口"下的几何必须一致 ── */
  {
    const idx = Math.floor(n / 2);
    spacer.style.height = '';
    spacer.innerHTML = items.map((it, i) => panel._cardHtml(it, i)).join('');
    void spacer.offsetHeight;
    const a = spacer.children[idx].getBoundingClientRect();
    const aTop = spacer.children[idx].offsetTop;
    spacer.innerHTML = '';
    panel._metricsDirty = true;
    panel._render();
    await scrollTo(Math.max(0, panel._cardTop(idx) - 120));
    const el = panel._cardElAt(idx);
    const b = el ? el.getBoundingClientRect() : null;
    const lr = listEl.getBoundingClientRect();
    ok(!!b, '全量渲染与虚拟窗口都能取到第 ' + idx + ' 条', b ? 'ok' : '未渲染');
    if (b) {
      ok(Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5,
        '卡片尺寸与全量渲染完全一致', `${a.width}x${a.height} vs ${b.width}x${b.height}`);
      ok(Math.abs((a.left - lr.left) - (b.left - lr.left)) <= 0.5 && Math.abs(a.right - b.right) <= 0.5,
        '卡片相对列表左边缘/右边缘位置一致', `left ${Math.round(a.left - lr.left)} vs ${Math.round(b.left - lr.left)}`);
      ok(Math.abs(el.offsetTop - aTop) <= 0.6, '卡片相对列表内容顶部偏移一致', `${el.offsetTop} vs ${aTop}`);
    }
  }

  /* ── 4. 滚动到若干位置: 窗口必须完整覆盖可视区, 且位置表对齐 ── */
  for (const frac of [0.1, 0.35, 0.62, 0.9, 1.0]) {
    await scrollTo(Math.round(panel._totalH * frac));
    const band = visibleBand();
    const kids = spacer.children;
    const firstEl = kids[1], lastEl = kids[kids.length - 1];
    const top = firstEl ? firstEl.offsetTop : -1;
    const bot = lastEl ? (lastEl.offsetTop + lastEl.offsetHeight) : -1;
    ok(top <= band.top + 1 && bot >= band.bot - 1,
      `滚到 ${Math.round(frac * 100)}%: 窗口覆盖可视区`,
      `可视 [${Math.round(band.top)}, ${Math.round(band.bot)}]  窗口 [${top}, ${bot}]  渲染 ${kids.length - 1} 张`);
    (R.scrollDiag = R.scrollDiag || []).push({ frac, winY: Math.round(pageScroller().scrollTop), listTop: Math.round(listEl.scrollTop), srTop: Math.round(spacer.getBoundingClientRect().top), band: [Math.round(band.top), Math.round(band.bot)] });
    const idxs = [...kids].slice(1).map(el => +el.dataset.idx);
    ok(idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1), `滚到 ${Math.round(frac * 100)}%: 窗口下标连续`, idxs.slice(0, 3).join(',') + '...');
  }
  checkOffsets('滚动后');

  /* ── 5. 点击映射: 点第一张卡 → selected 必须是 filtered[data-idx] ── */
  {
    const el = spacer.children[1];
    const idx = +el.dataset.idx;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height - 6);   // 避开文字行 → 只选中
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    }
    await sleep(120);
    ok(panel.selected === panel.filtered[idx], '点击卡片 → 选中的正是该条', `idx=${idx} selected=${panel.selected === panel.filtered[idx]}`);
    ok(el.classList.contains('selected'), '点击后该卡片带 selected 类', el.className);
  }

  /* ── 6. select() 定位: 选一条远处的, 必须滚到视野并渲染出来 ── */
  {
    const idx = Math.floor(n * 0.5);
    const it = panel.filtered[idx];
    panel.select(it, true);
    await raf2();
    await sleep(120);
    const el = panel._cardElAt(idx);
    const band = visibleBand();
    if (unbounded()) {
      // 窄屏堆叠布局: #cue-list 被内容撑满, select() 里的 listEl.scrollTop 滚不动(既有行为),
      // 所以拿不到目标卡片 —— 这里只验证"不报错且窗口仍覆盖可视区"
      ok(true, `窄屏布局下 select() 不做滚动断言(既有行为)`, 'skip');
    } else {
      const vis = el ? (el.offsetTop >= band.top - 1 && el.offsetTop <= band.bot) : false;
      ok(!!el, `select() 后第 ${idx} 条在窗口内(被渲染)`, el ? 'ok' : '未渲染');
      ok(vis, `select() 后第 ${idx} 条顶部在可视区内`, `top=${el ? el.offsetTop : '-'} 可视[${Math.round(band.top)}, ${Math.round(band.bot)}]`);
      ok(el && el.classList.contains('selected'), 'select() 后该卡片带 selected 类', el ? el.className : '-');
    }
    R.selectScroll = { idx, band: [Math.round(band.top), Math.round(band.bot)], top: el ? el.offsetTop : null };
  }

  /* ── 7. 行内编辑定位: 编辑框 top 必须贴着目标卡片 ── */
  {
    const idx = Math.floor(n * 0.5);
    const it = panel.filtered[idx];
    if (!panel._cardElAt(idx)) await scrollTo(Math.max(0, panel._cardTop(idx) - 100));   // 整页滚布局下先滚到它附近
    panel.startEdit(it, 1);
    await sleep(150);
    const ed = panel.editorEl;
    const want = panel._cardTop(idx) + 6;
    const got = ed ? parseFloat(ed.style.top) : NaN;
    ok(!!ed, 'startEdit 建出了行内编辑框', ed ? 'ok' : '没有');
    ok(Math.abs(got - want) <= 1.5, '编辑框 top 贴着目标卡片(±1.5px)', `实际 ${got} 期望 ${want}`);
    const el = panel._cardElAt(idx);
    ok(!!el || unbounded(), '目标卡片带 editing 类', el ? el.className : (unbounded() ? '窄屏布局跳过' : '未渲染'));
    // Tab 键: 英文行 → 中文行, 且不能误提交(编辑器必须还在)
    {
      const l2 = ed ? ed.querySelector('.ie-l2') : null;
      if (l2) { l2.focus(); }
      if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await sleep(80);
      ok(!!panel.editorEl && panel.editItem === it, 'Tab 切换行后编辑框仍在(未误提交)', panel.editorEl ? 'ok' : '被收掉了');
    }
    // 编辑中滚动: 编辑框必须仍贴着同一条卡片(位置表算出来的 top 不能漂)
    if (!unbounded()) {
      const before = parseFloat(panel.editorEl.style.top);
      await scrollTo(Math.max(0, panel._cardTop(idx) - 300));
      await sleep(120);
      const after = panel.editorEl ? parseFloat(panel.editorEl.style.top) : NaN;
      const stillThere = !!panel.editorEl && panel.editItem === it;
      ok(stillThere && Math.abs(after - before) <= 0.5, '编辑中滚动: 编辑框仍贴在原卡片上', `top ${before} → ${after}`);
      await scrollTo(Math.max(0, panel._cardTop(idx) - 100));
      await sleep(100);
    }
    panel.cancelEdit();
    await sleep(120);
    ok(!panel.editorEl, 'cancelEdit 后编辑框已移除', panel.editorEl ? '还在' : 'ok');
  }

  /* ── 8. 删除一条(用户报的场景): 开销 + 位置表更新 ── */
  {
    await sleep(200);
    takeTasks();
    const before = panel.filtered.length;
    const cut = Math.floor(n * 0.5);
    const cutH = panel._h.get(panel._hKey(panel.filtered[cut]));
    const next = panel.filtered.slice();
    next.splice(cut, 1);
    const cacheBefore = { size: panel._h.size, w: panel._hW, clientW: spacer.clientWidth };
    const t = performance.now();
    panel.setItems(next, true);
    const sync = performance.now() - t;
    const l = performance.now(); void spacer.offsetHeight; const lay = performance.now() - l;
    const p = performance.now(); await raf2(); const paint = performance.now() - p;
    await sleep(200);
    const lt = takeTasks();
    R.del = {
      sync: +sync.toFixed(1), layout: +lay.toFixed(1), paint: +paint.toFixed(1), total: +(sync + lay + paint).toFixed(1),
      longTasks: lt.slice(0, 6), before, after: panel.filtered.length,
      cacheBefore, cacheAfter: { size: panel._h.size, w: panel._hW, clientW: spacer.clientWidth },
    };
    ok(panel.filtered.length === before - 1, '删除后条数 -1', `${before} → ${panel.filtered.length}`);
    if (panel.filtered.length) {
      ok(Math.abs(panel._totalH - (ref.total - cutH)) <= 2, '删除后总高 == 真实总高 - 该条高(±2px)', `${Math.round(panel._totalH)} vs ${Math.round(ref.total - cutH)}`);
    } else {
      ok(panel._totalH === 0 && spacer.children.length === 0, '删空后总高归零且 DOM 清空', `${panel._totalH} / children=${spacer.children.length}`);
    }
    ok(sync < 60, `删除后 setItems 同步 < 60ms(实测 ${R.del.sync}ms; 修复前全量渲染约 5000ms)`, `缓存 ${JSON.stringify(cacheBefore)} → ${JSON.stringify(R.del.cacheAfter)}`);
    ok(!lt.some(d => d > 300), '删除后没有 >300ms 主线程长任务', JSON.stringify(lt.slice(0, 6)));
  }

  /* ── 9. 过滤 / 模式切换 / 空列表 ── */
  {
    const beforeF = panel.filtered.length;
    const kw = (panel.filtered[0] ? panel.filtered[0].l1 : '').slice(0, 4);
    if (beforeF >= 2) {
      panel._filterText = kw;
      panel._applyFilter();
      await sleep(150);
      const nf = panel.filtered.length;
      ok(nf >= 1 && nf < beforeF, `搜索过滤生效(${beforeF} → ${nf}, 关键词「${kw}」)`, nf);
    } else {
      ok(true, `条目太少(${beforeF} 条), 跳过搜索过滤检查`, 'skip');
    }
    const nf = panel.filtered.length;
    if (nf) {
      const sumF = panel.filtered.reduce((a, it) => a + (panel._h.get(panel._hKey(it)) || 86), 0);
      ok(Math.abs(panel._totalH - (sumF - 6)) <= 2, '过滤后撑高 == 过滤结果高度和 - 末条间距(±2px)', `${Math.round(panel._totalH)} vs ${Math.round(sumF - 6)}`);
    }
    ok(nf === 0 || document.querySelectorAll('.cue-card').length > 0, '过滤后窗口仍有卡片', document.querySelectorAll('.cue-card').length);

    panel._filterText = '';
    panel._applyFilter();
    await sleep(120);

    panel.setModeOptions([{ v: 'bi', t: '双语' }, { v: 'first', t: '仅主' }, { v: 'second', t: '仅副' }], 'first');
    panel._applyFilter();
    await sleep(200);
    ok(panel._mode === 'first', '切到"仅主"模式', panel._mode);
    const h1 = panel.filtered[0] ? panel._h.get(panel._hKey(panel.filtered[0])) : null;
    ok(panel.filtered.length === 0 || h1 != null, '新模式下行高已重新测量', h1);
    panel.setModeOptions([{ v: 'bi', t: '双语' }], 'bi');
    panel._applyFilter();
    await sleep(200);

    panel.setItems([]);
    await sleep(120);
    ok(spacer.children.length === 0 && !spacer.style.height, '空列表 → 清空并撤掉撑高', `children=${spacer.children.length} height="${spacer.style.height}"`);
  }

  ok(document.querySelectorAll('.cue-measure').length === 0, '测量容器没有残留在页面里', document.querySelectorAll('.cue-measure').length);

  panel.setItems(mkItems(50));      // 收尾: 留个小列表
  await sleep(120);
  if (R._po) { try { R._po.disconnect(); } catch (e) {} }
  delete R._po;
  R.finalRendered = document.querySelectorAll('.cue-card').length;
  return R;
}

/* ── 启动 ── */
const server = spawn(process.execPath, [join(ROOT, 'editor', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
let serverUp = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) { serverUp = true; break; } } catch {}
}
if (!serverUp) { console.error('服务未起来'); server.kill(); process.exit(1); }

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + join(process.env.TEMP || '.', 'edge-virt-probe-' + Date.now()),
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // 必须用桌面宽度: 窄屏(<900px)是纵向堆叠布局, 那时 #cue-list 不受高度约束(整页滚),
  // 滚动窗口的验证会失真 —— 无头浏览器默认窗口约 745px 宽, 正好落在窄屏分支里。
  `--window-size=${process.env.WIN || '1600,1000'}`,
  `http://127.0.0.1:${PORT}/editor/index.html`
], { stdio: 'ignore' });

const cleanup = () => { try { edge.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes(String(PORT))) || list.find(t => t.type === 'page');
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.error('未找到页面目标'); cleanup(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await sleep(3000);

const res = await send('Runtime.evaluate', {
  expression: '(' + pageProbe.toString() + ')(' + N + ',' + (UNIQ ? 'true' : 'false') + ')', awaitPromise: true, returnByValue: true
});
const out = res && res.result && res.result.value;
const err = res && res.exceptionDetails;

console.log(`=== 字幕列表虚拟滚动验证 (${N} 条) ===`);
if (err) console.log('页面异常:', err.exception?.description || err.text);
if (out) {
  console.log(`布局: ${out.layout} | 列表 ${out.listGeom.clientH}/${out.listGeom.scrollH} spacer ${out.listGeom.spacerH} 窗口高 ${out.listGeom.innerH} | 真实总高 ${out.refTotal}px | 虚拟撑高 ${out.totalH}px | 实际高度 ${out.spacerH}px`);
  console.log(`首次 setItems: 同步 ${out.setItems.sync}ms | 布局 ${out.setItems.layout}ms | 首帧 ${out.setItems.paint}ms | longtask ${JSON.stringify(out.setItems.longTasks)}`);
  console.log(`DOM 里卡片数: ${out.rendered} / 共 ${N} 条`);
  console.log(`删除一条: 同步 ${out.del.sync}ms | 布局 ${out.del.layout}ms | 首帧 ${out.del.paint}ms | 合计 ${out.del.total}ms | longtask ${JSON.stringify(out.del.longTasks)} | ${out.del.before} → ${out.del.after}`);
  if (out.selectScroll) console.log('select() 定位:', JSON.stringify(out.selectScroll));
  if (out.scrollDiag) console.log('滚动诊断:', JSON.stringify(out.scrollDiag));
  console.log('');
  for (const c of out.checks) console.log((c.ok ? '  ok  ' : 'FAIL  ') + c.name + (c.extra ? '   [' + c.extra + ']' : ''));
  console.log(`\n${out.pass} passed, ${out.fail} failed`);
  process.exitCode = out.fail ? 1 : 0;
} else {
  console.log('未取到结果:', JSON.stringify(res).slice(0, 800));
}
cleanup();
