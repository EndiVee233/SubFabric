/**
 * 视频区就地编辑（"双击 → 点什么改什么"）。
 *
 * 交互（用户定稿）：
 *   · 在画面里**双击**某条字幕 → 贴着你点中的那个**片段**（空格分隔，与该行可见文本同口径）
 *     弹出小输入框；Enter 保存 / Esc 取消 / 点框外取消。
 *   · 只替换那一个片段，行内其它内联标签、时间、样式一律不动（见 segment.js）。
 *   · 框内多打一个空格 = 把片段**拆成两段**（逐词英文行会按新词数重算词级时间）。
 *   · 需要整行改文本（可用 ASS 内联标签）时，走"整行文本"弹窗。
 *
 * 职责边界：本模块只做**命中判定 + 画面上的 UI**。
 *   几何估算、文本语义（纯文本/原文、转义、重建词切片）都不在这里 ——
 *   前者在 main.js 给的 items 里，后者在 main.js 的 commit 回调里。
 *   main.js 仍是唯一真相源，本模块不改任何文档数据。
 *
 * 命中判定的两个口径：
 *   · SRT：字幕是 HTML 层（#srt-overlay 的 .ov-line），行元素的真实矩形能直接量到 → 精确。
 *   · ASS：由 libass 画在 canvas 上，**没有按行的 DOM**。但画布是 2D 且背景透明，
 *     所以直接读它的 alpha 通道就是**真实墨迹**（见 _inkBands）——字体回退、字号缩放、
 *     libass 自己的防重叠上推全都自动包含在内，比按 Style 反推可靠得多。
 *     画布读不到（上下文丢失/还没画出这一帧）时，退回按 Style 估算：
 *     Fontname/Fontsize/Alignment/MarginL/R/V + PlayRes 定位，measureText 量字宽。
 *     估算出的矩形既用于命中，也用于画高亮框 —— 两者自洽，用户看到框就知道程序认为你点的是哪一段。
 */
import { htmlPlainAndMap } from './segment.js';

/** 量字宽用的字体栈：与 #srt-overlay .ov-line 同族；CJK 字宽≈1em，拉丁字宽误差可接受 */
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';
const SEG_PAD_X = 6;          // 高亮框在片段左右各留一点(视觉)
const SEG_HIT_SLOP = 10;      // 点在片段边界外多少像素内还算命中
const NEAR_MAX = 1.6;         // 离最近片段超过 1.6em 就算"没点字幕"
/* 原生 <video controls> 底部控制条的高度。**必须与 main.js 里那个 72 一致**
 * （main.js 用它把"点视频=播放/暂停"让给原生控件）。实测这条带子里
 * pointerdown/mousedown/click/dblclick 一个都到不了页面 —— 所以它上面的字幕必须另想办法。 */
const CTRL_BAR = 72;
/* 扫不到墨迹时最多重试几次（见 _inkBands）。3 次 × 接管层 250ms 的节奏 → 不到 1 秒内自愈。 */
const INK_MISS_MAX = 3;
/* 单击字幕 = 就地编辑、双击字幕 = 整行弹窗 —— 两者要靠**等一个双击窗口**分开：
 * 单击后先按住 240ms，期间没有第二下才真的把就地框开出来，否则双击会先开出就地框再被弹窗顶掉。
 * 240 与 main.js 里"单击视频 = 播放/暂停"的等待同值（同一个交互语言）。 */
const CUE_CLICK_DELAY = 240;

/** 这条字幕在 ASS 文件里的行号（events 段的下标）。
 *  libass 的摆放规则是**按事件在文件里的先后从底部往上摆、后面的往上顶**（先写的贴着 margin），
 *  所以"行号升序 = 由下到上"。中英两行的估算中心可能只差 2px，靠最近邻/靠"谁叫中文"都会错，
 *  只有这个行号是可靠依据。取不到行号（SRT 等）返回 NaN，由调用方退回估算。 */
function _eventLineIdx(it) {
  const ev = it && it.sent && it.sent.events && it.sent.events[0];
  return ev && Number.isFinite(ev.lineIdx) ? ev.lineIdx : NaN;
}

export class VideoCueEditor {
  /**
   * @param {object} deps
   * @param {HTMLVideoElement} deps.video
   * @param {HTMLElement} deps.stage      #video-stage
   * @param {HTMLElement} deps.layer      #cue-edit-layer
   * @param {HTMLElement} deps.segBox     #cue-seg-box   画面上的片段高亮框
   * @param {HTMLElement} deps.box        #cue-inline-editor
   * @param {HTMLInputElement} deps.input #cie-input
   * @param {HTMLElement} deps.shield     #cue-hit-shield 底部控制条上的字幕接管层
   * @param {object} api                  由 main.js 注入(见 main.js 的绑定处)
   */
  constructor({ video, stage, layer, segBox, box, input, shield }, api) {
    this.video = video;
    this.stage = stage;
    this.layer = layer;
    this.segBox = segBox;
    this.box = box;
    this.input = input;
    this.shield = shield || null;
    this.api = api;
    this.dialog = null;            // 整行文本弹窗(main.js 注入); Ctrl+Enter 从片段框转过去
    this.open = null;              // { item, seg } —— 非空即在编辑中
    this._mctx = null;
    this._ink = null;              // 墨迹带缓存（key = 帧 + 画布尺寸）
    this._pvDirty = false;         // 有过打字预览 → 画布上是草稿，关框时墨迹缓存要作废
    this._pvFrame = 0;             // 预览用的 rAF 句柄（逐帧合并输入）
    this._shieldRect = null;       // 接管层的目标矩形（stage 坐标）；null = 当前不需要
    this._rowRect = null;          // 武装判定区 = 整行矩形（含控制条以上那截）
    this._lastPt = null;           // 指针最后所在的位置（视口坐标），用于静止指针下也能武装
    this._shieldArmed = false;     // 指针是否正悬在接管层上（只有这时才接收事件）
    this._cueClickTimer = 0;       // "单击字幕"等双击窗口的定时器句柄
    this._onDocPointer = this._onDocPointer.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onRelayout = this._onRelayout.bind(this);
    this._onInput = this._onInput.bind(this);
    this._onShieldMove = this._onShieldMove.bind(this);
    this.input.addEventListener('input', this._onInput);
    this._bindShield();
    /* #video-stage 被其它面板挤压（元素级尺寸变化）时 window 的 resize 事件不会派发 ——
     * ResizeObserver 直接盯 stage 本身，就地框开着期间跟着画面重新落位（PLAN md 的遗留项）。
     * 只在 begin/close 里 observe/disconnect，不在编辑外空跑。 */
    this._ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(() => this._onRelayout()) : null;
  }

  get isOpen() { return !!this.open; }

  /* ─────────── 底部控制条上的"字幕接管层" ───────────
   * 背景：原生控件在 video 的 UA shadow 里，会把底部约 CTRL_BAR 内的一切鼠标事件吃掉，
   * 落在这一条里的字幕行"双击点不动"。光靠 <video> 的 dblclick 修不了 —— 那个事件根本不派发。
   * 办法：放一块透明层盖住"字幕行 ∩ 控制条带"，把这一小块从控件手里抢回来。
   * 为了不殃及进度条/音量，它默认 pointer-events:none，只在指针悬到这一条上时才变 auto。 */

  _bindShield() {
    const sh = this.shield;
    if (!sh) return;
    /* 接管层的两个手势必须和"画面上方那半截字幕"完全一致，否则同一条字幕上下半截行为不同：
     *   单击 → 就地编辑；双击 → 整行弹窗。 */
    sh.addEventListener('dblclick', (e) => {
      if (!this.video.currentSrc) return;
      e.preventDefault();
      this.dblClickAt(e.clientX, e.clientY);
    });
    sh.addEventListener('click', (e) => {
      // 先清掉"点框外取消"留下的记号（事件本来到不了 <video>，没人替它清就会吃掉下一次正常单击）
      const swallowed = this.consumeClick();
      if (this.clickAt(e.clientX, e.clientY)) return;    // 点在字幕上 = 编辑手势
      if (swallowed) return;
    });
    sh.addEventListener('contextmenu', (e) => {
      if (this.open || !this.video.currentSrc || !this.api.contextAt) return;
      if (this.api.contextAt(e.clientX, e.clientY)) e.preventDefault();
    });
    document.addEventListener('pointermove', this._onShieldMove, { passive: true });
    // 定时对齐：字幕换行/画面尺寸变化都要跟着走。开销很小（没字幕时直接返回，播放中每帧墨迹只算一次）
    this._shieldTimer = setInterval(() => this._syncShield(), 250);
  }

  /** 按当前画面上可见的字幕行，把接管层摆到"行 ∩ 控制条带"上；不需要就收起来。
   *  注意**不要**拿 `document.hidden` 当闸门 —— 页面被别的窗口压住时它会是 true，
   *  那样接管层会被收掉，压在控制条上的字幕又变成"点不动"（实测踩过）。 */
  _syncShield() {
    const sh = this.shield;
    if (!sh) return;
    if (!this.video.currentSrc) return this._dropShield();
    const pic = this.api.pictureRect();
    if (!pic || !pic.width || !pic.height) return this._dropShield();
    // 先花极小的代价问一句"这一刻有字幕吗"，没有就不必去算几何（也避开墨迹扫描）
    const t = Number(this.video.currentTime) || 0;
    if (!(this.api.itemsAt && (this.api.itemsAt(t) || []).length)) return this._dropShield();

    const barTop = pic.top + pic.height - CTRL_BAR;
    const picBottom = pic.top + pic.height;
    let l = Infinity, tp = Infinity, r = -Infinity, b = -Infinity;   // 接管层 = 行 ∩ 控制条带
    let rl = Infinity, rt = Infinity, rr = -Infinity;                // 判定区 = 整行（含控制条以上那截）
    for (const it of this._layoutItems()) {
      const y0 = Math.max(it.top, barTop);
      const y1 = Math.min(it.bottom + 2, picBottom);
      if (y1 - y0 < 4) continue;                       // 整行都在控制条上方 → 原生双击本来就够用
      l = Math.min(l, it.x0 - 2);
      r = Math.max(r, it.x0 + it.adv[it.plain.length] + 2);
      tp = Math.min(tp, y0);
      b = Math.max(b, y1);
      rl = Math.min(rl, it.x0 - 2);
      rr = Math.max(rr, it.x0 + it.adv[it.plain.length] + 2);
      rt = Math.min(rt, it.top);
    }
    if (!(r > l)) return this._dropShield();
    l = Math.max(l, pic.left); r = Math.min(r, pic.left + pic.width);
    rl = Math.max(rl, pic.left); rr = Math.min(rr, pic.left + pic.width);
    this._shieldRect = { l, t: tp, r, b };
    /* 武装的判定区用**整行**（不只压到控制条的那一截）：指针停在字幕上任意位置都算"准备编辑"，
     * 往下滑进控制条时就已经是武装状态了。控制条里 pointermove 是能到页面的（实测：
     * down/click/dblclick 被控件吃掉，move 照常冒泡），所以任何接近路径都会被看见。 */
    this._rowRect = { l: rl, t: rt, r: rr, b };
    if (sh.hidden) sh.hidden = false;
    sh.style.left = l + 'px';
    sh.style.top = tp + 'px';
    sh.style.width = (r - l) + 'px';
    sh.style.height = (b - tp) + 'px';
    this._armFromLastPoint();                          // 字幕正好出现在静止的指针底下时也能武装
  }

  _dropShield() {
    this._shieldRect = null;
    this._rowRect = null;
    if (!this.shield) return;
    this._setShieldArmed(false);
    if (!this.shield.hidden) this.shield.hidden = true;
  }

  _onShieldMove(e) {
    this._lastPt = { x: e.clientX, y: e.clientY };
    this._armFromLastPoint();
  }

  /** 按"指针最后所在的位置"决定要不要武装。用最后位置而不是"本次移动事件的位置"，
   *  是为了让"字幕正好出现在静止的指针底下"这种情况也能武装（定时对齐时会重算一次）。 */
  _armFromLastPoint() {
    const p = this._lastPt;
    if (!this._rowRect || !p) { if (this._shieldArmed) this._setShieldArmed(false); return; }
    const st = this.stage.getBoundingClientRect();
    const x = p.x - st.left, y = p.y - st.top;
    const r = this._rowRect;
    const pad = this._shieldArmed ? 8 : 0;             // 回滞：离开要比进入多走 8px，贴边不抖
    const inside = x >= r.l - pad && x <= r.r + pad && y >= r.t - pad && y <= r.b + pad;
    if (inside !== this._shieldArmed) this._setShieldArmed(inside);
  }

  _setShieldArmed(on) {
    this._shieldArmed = on;
    if (this.shield) this.shield.classList.toggle('armed', on);
  }


  /* ─────────── 命中判定 ─────────── */

  /** 视口坐标 → 命中结果（单击/双击/右键三条入口共用） */
  _hitAt(clientX, clientY) {
    const st = this.stage.getBoundingClientRect();
    return this._hitTest(clientX - st.left, clientY - st.top);
  }

  /** 入口①：单击字幕 = 进入就地编辑（改被点中的那一段）。
   *  要跟"双击 = 整行弹窗"分家，所以先按住一个双击窗口，期间没等到第二下才真的开框。
   *  返回 true = 这一下算字幕手势，调用方**不要**再拿它去切播放/暂停。 */
  clickAt(clientX, clientY) {
    const st = this.stage.getBoundingClientRect();
    const x = clientX - st.left, y = clientY - st.top;
    const row = this._rowAt(x, y);
    if (this._cueClickTimer) { clearTimeout(this._cueClickTimer); this._cueClickTimer = 0; }
    if (!row) return false;                      // 不在字幕上 → 交回调用方（切播放/暂停）
    const hit = this._hitTest(x, y);
    /* 落在只读的角色/颜色前缀上，或片段之间的缝上：**属于字幕、但不编辑**。
     * 这里必须返回 true 把它按住 —— 否则那一下会被当成"点空白"，
     * 等 240ms 双击窗口过去就把视频切了播放（实测踩过：点 [Wemmbu] 会把视频播起来）。 */
    if (!hit) return true;
    this._cueClickTimer = setTimeout(() => {
      this._cueClickTimer = 0;
      // 边播边点时这 240ms 里播放头会走 → 重新命中一次；拿不到就用当初那一击的结果
      const h = this._hitTest(x, y) || hit;
      this.begin(h.item, h.seg);
    }, CUE_CLICK_DELAY);
    return true;
  }

  /** 入口②：双击字幕 = 整行文本弹窗（"仅修改 Text 字段，不改变时间与样式"）。
   *  返回 true = 这一下算字幕手势。 */
  dblClickAt(clientX, clientY) {
    if (this._cueClickTimer) { clearTimeout(this._cueClickTimer); this._cueClickTimer = 0; }
    const hit = this._hitAt(clientX, clientY);
    if (!hit) return false;
    if (this.open) this.cancel();
    if (this.dialog) this.dialog.show(hit.item);
    return true;
  }

  /** 有一下落在字幕以外 → 撤销那个还没落地的"单击字幕"。
   *  否则"点空白切播放"会在 240ms 后又顺带弹出编辑框。 */
  cancelPendingClick() {
    if (this._cueClickTimer) { clearTimeout(this._cueClickTimer); this._cueClickTimer = 0; }
  }

  /** 程序化入口（探针/脚本用）：直接就地编辑某个点。交互路径见 clickAt / dblClickAt。 */
  tryOpen(clientX, clientY) {
    const hit = this._hitAt(clientX, clientY);
    if (!hit) return false;
    this.begin(hit.item, hit.seg);
    return true;
  }

  /** 命中判定（坐标相对 #video-stage）。给双击与右键菜单共用。 */
  hitTestAt(x, y) { return this._hitTest(x, y); }

  /** 这次 click 是不是"用来关掉编辑框的那一下"？
   *  是 → 调用方（main.js 的播放/暂停）应当忽略它，别让"点框外取消"顺带把视频切了播放。 */
  consumeClick() {
    const v = this._swallowClick === true;
    this._swallowClick = false;
    return v;
  }

  _hitTest(x, y) {
    const it = this._rowAt(x, y);
    if (!it) return null;
    const seg = this._segmentAt(it, x);
    return seg ? { item: it, seg } : null;
  }

  /** 这个点落在哪一条字幕上？（只判"行"，不判"段"）
   *  横向范围用**整条带子**（`plain` 含只读的角色/颜色前缀，所以前缀也在范围内）——
   *  用来把"点字幕"和"点空白"分开：落在带子上的一律算字幕手势，绝不切播放。
   *  竖向优先取离得最近且带内距离为 0 的那条（中英两行只隔几像素，不能取第一条）。 */
  _rowAt(x, y) {
    const items = this._layoutItems();
    if (!items.length) return null;
    const vdist = (it) => (y < it.top ? it.top - y : y > it.bottom ? y - it.bottom : 0);
    const near = items.filter(it => vdist(it) <= SEG_HIT_SLOP);
    let it;
    if (near.length) {
      near.sort((a, b) => vdist(a) - vdist(b)
        || Math.abs(y - (a.top + a.bottom) / 2) - Math.abs(y - (b.top + b.bottom) / 2));
      it = near[0];
    } else {
      const byCenter = items.slice().sort((a, b) =>
        Math.abs(y - (a.top + a.bottom) / 2) - Math.abs(y - (b.top + b.bottom) / 2));
      const lineH = byCenter[0].lineH || 1;
      if (Math.abs(y - (byCenter[0].top + byCenter[0].bottom) / 2) > lineH * 1.2) return null;   // 离字幕太远 → 没点到
      it = byCenter[0];
    }
    /* 横向容差与 _segmentAt 用**同一口径**（不能比它更严）：估算回退时行宽能差几十像素，
     * 这里要是卡得比片段判定还紧，就会出现"片段判定说命中了、却因为行范围不认而整条落空"。 */
    const x1 = it.x0 + it.adv[it.plain.length];
    const pad = SEG_HIT_SLOP + (it.fontPx || 0) * 0.6;
    if (x < it.x0 - pad || x > x1 + pad) return null;
    return it;
  }

  /** 横向：落在哪个片段的 x 区间内；落在缝隙里取最近的（容差 NEAR_MAX em） */
  _segmentAt(it, x) {
    const segs = it.segs;
    if (!segs || !segs.length) return null;
    let best = null, bestD = Infinity;
    for (const s of segs) {
      const x1 = it.x0 + it.adv[s.start];
      const x2 = it.x0 + it.adv[s.end];
      const d = x < x1 ? x1 - x : x > x2 ? x - x2 : 0;
      if (d < bestD) { bestD = d; best = s; }
      if (d === 0) break;
    }
    return bestD <= SEG_HIT_SLOP + (it.fontPx || 0) * 0.6 ? best : null;
  }

  /* ─────────── 画面几何（估算） ─────────── */

  _measure(text, fontCss) {
    if (!this._mctx) this._mctx = document.createElement('canvas').getContext('2d');
    this._mctx.font = fontCss;
    return this._mctx.measureText(String(text == null ? '' : text)).width;
  }

  /** 把 main.js 报上来的候选行算成"画面上的一条带子 + 每个片段的 x 区间" */
  _layoutItems() {
    const api = this.api;
    const pic = api.pictureRect();
    if (!pic || !pic.width || !pic.height) return [];
    const t = Number(this.video.currentTime) || 0;
    const raw = api.itemsAt(t) || [];
    const out = [];
    for (const it of raw) {
      const laid = it.kind === 'srt' ? this._layoutSrt(it, pic) : this._layoutAss(it, pic);
      if (laid) out.push(Object.assign({}, it, laid));
    }
    // 每条行至少要有 top：SRT 由 DOM 直接给，ASS 由 bottom+lineH 反推（后面可能被墨迹/排开改写）
    for (const it of out) if (!Number.isFinite(it.top)) it.top = it.bottom - it.lineH;
    // ASS 行优先用真实墨迹校正几何；全部校正成功就不用再做防重叠排开了
    const allReal = this._applyInk(out, pic);
    if (allReal) return this._sortRows(out);
    // SRT 行的矩形来自真实 DOM，本来就不重叠，不该被这里的排开逻辑挪位置
    const assRows = out.filter(it => it.kind !== 'srt');
    if (!assRows.length) return this._sortRows(out);
    // 同名重叠时按 libass 的真实摆放规则自下而上排开（见 _eventLineIdx 注释）
    // —— 这一支是"拿不到墨迹"时的回退，顺序必须和墨迹那一支**同一口径**，否则两路结果互斥，
    //    表现为"有时点得动有时点不动"。原来这里按"中文在上"猜，正好与真实顺序相反。
    assRows.sort((a, b) => {
      const sa = _eventLineIdx(a), sb = _eventLineIdx(b);
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
      return (b.bottom - a.bottom) || (a.side === 'zh' ? 1 : -1);
    });
    let cursor = pic.top + pic.height;
    for (const it of assRows) {
      const h = it.lineH;
      let bottom = Math.min(it.bottom, cursor);
      bottom = Math.max(bottom, pic.top + h);          // 不许把带子顶出画面
      it.bottom = bottom;
      it.top = bottom - h;
      cursor = it.top - 2;
    }
    return this._sortRows(out);
  }

  /** 上位优先（同一时刻画面上靠上的先返回），高亮框/命中都以这个顺序算 */
  _sortRows(rows) {
    return rows.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
  }

  /* ─────────── 真实墨迹（ASS 走这条） ─────────── */

  /** libass 画布 alpha → 文字带。返回 [{top,bottom,left,right}]，坐标相对 #video-stage。
   *  同一帧只读一次：读 1096×617 约 1~2 次全画布扫描，只在双击/右键时发生（编辑时会暂停）。 */
  _inkBands(pic) {
    const cv = this.api.assCanvas ? this.api.assCanvas() : null;
    if (!cv || !cv.width || !cv.height) return null;
    const t = Number(this.video.currentTime) || 0;
    const key = `${t}|${cv.width}x${cv.height}|${Math.round(pic.width)}x${Math.round(pic.height)}|${pic.left.toFixed(1)},${pic.top.toFixed(1)}`;
    /* 缓存只认**扫成功**的结果。扫不到往往只是撞上了 libass 重绘的那一瞬（画布暂时是空的），
     * 而视频暂停时这个 key 永远不会变 —— 一旦把这次 null 记下来，这一帧就会**永久**退回估算几何：
     * 中英两行上下颠倒、整体偏十几像素，双击自然"点不动"（实测踩过，且因为接管层每 250ms
     * 会来取一次布局，撞上空帧的概率比在双击那一刻扫一次高得多）。
     * 所以：① 成功的结果照常复用；② 失败最多重试 INK_MISS_MAX 次，都失败才认这一帧真的没墨迹。 */
    if (this._ink && this._ink.key === key) {
      if (this._ink.bands) return this._ink.bands;
      if ((this._ink.miss || 0) >= INK_MISS_MAX) return null;
    }
    let bands = null;
    try {
      const ctx = cv.getContext('2d');
      if (ctx) bands = this._scanInk(ctx, cv, pic);
    } catch { bands = null; }                     // 上下文丢失 / 取不到像素 → 退回估算
    const prev = (this._ink && this._ink.key === key) ? this._ink : null;
    this._ink = bands ? { key, bands, miss: 0 }
      : { key, bands: null, miss: (prev ? (prev.miss || 0) : 0) + 1 };
    return bands;
  }

  _scanInk(ctx, cv, pic) {
    const W = cv.width, H = cv.height;
    const d = ctx.getImageData(0, 0, W, H).data;
    // ① 逐行统计：一条字幕行 = 一段连续"有足够墨迹"的行
    const rows = new Uint32Array(H);
    for (let y = 0, i = 3; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++, i += 4) if (d[i] > 24) n++;
      rows[y] = n;
    }
    const minRow = Math.max(3, Math.round(W * 0.004));
    const runs = [];
    let cur = null;
    for (let y = 0; y < H; y++) {
      if (rows[y] >= minRow) {
        if (cur) cur.y1 = y;
        else cur = { y0: y, y1: y };
      } else if (cur && y - cur.y1 > 2) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    // ② 每条带子再扫左右边界（像素坐标）
    const out = [];
    for (const b of runs) {
      if (b.y1 - b.y0 < 4) continue;               // 太薄：噪声，不是字
      let x0 = Infinity, x1 = -Infinity;
      for (let y = b.y0; y <= b.y1; y++) {
        const base = y * W * 4;
        for (let x = 0; x < W; x++) {
          if (d[base + x * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
        }
      }
      if (x0 > x1) continue;
      out.push({ y0: b.y0, y1: b.y1, x0, x1 });
    }
    if (!out.length) return null;
    // ③ 画布内部像素 → CSS。画布通常正好贴在画面上，但按真实矩形换算，不赌偏移：
    //    getBoundingClientRect 一律是视口坐标，两边相减即得"画布相对 stage"的位置。
    const st = this.stage.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const sx = (cr.width || W) / W, sy = (cr.height || H) / H;
    const bx = cr.left - st.left, by = cr.top - st.top;
    return out.map(b => ({
      top: by + b.y0 * sy,
      bottom: by + (b.y1 + 1) * sy,
      left: bx + b.x0 * sx,
      right: bx + (b.x1 + 1) * sx,
    }));
  }

  /** 把真实墨迹覆盖到 ASS 行上：
   *  竖直直接取墨迹带（比 Style + MarginV 准，且已含 libass 的防重叠上推）；
   *  水平保留 measureText 的**相对**字宽，只把总宽整体缩放到真实墨迹宽 ——
   *  这样片段边界等比落位，不需要靠列簇间距去猜词边界（字体一换就不稳）。
   *  返回 true = 所有非 SRT 行都拿到了真实几何。 */
  _applyInk(items, pic) {
    const bands = this._inkBands(pic);
    const ass = items.filter(it => it.kind !== 'srt');
    if (!bands || !bands.length || !ass.length) return false;
    // 估算只给 bottom（+lineH），top 要到排开时才出现 —— 中心按 bottom/lineH 推
    const est = (it) => (Number.isFinite(it.top) ? (it.top + it.bottom) / 2
      : it.bottom - (it.lineH || 0) / 2);
    /* 哪条墨迹带属于哪一行？墨迹本身只说"画面上有几条带子"，认领只能靠"libass 会把谁摆在哪"。
     * libass 的规则是**按事件在文件里的先后从底部往上摆、后面的往上顶**（同一层里先写的贴着 margin）。
     * 所以"事件行号升序 = 由下到上"，正好与墨迹带（y 升序 = 由上到下）**反向**一一对应。
     * 不用估算坐标配对：中英两行的估算中心可能只差 2px，最近邻贪心一次错配就全错（实测踩过）；
     * 也不能按"声明顺序"（= 中文在前），两行重叠时画面上的实际顺序由文件顺序决定，与谁先声明无关。 */
    const lineSeq = _eventLineIdx;
    let pairs;
    if (bands.length === ass.length && ass.every(it => Number.isFinite(lineSeq(it)))) {
      const bottomUp = ass.slice().sort((a, b) => lineSeq(a) - lineSeq(b));
      pairs = bottomUp.map((it, i) => [it, bands[bands.length - 1 - i]]);
    } else {
      // 行数与带数不等（有行此刻没画出来）→ 才退回最近邻
      const used = new Array(bands.length).fill(false);
      pairs = [];
      for (const it of ass) {
        let bi = -1, bd = Infinity;
        for (let i = 0; i < bands.length; i++) {
          if (used[i]) continue;
          const d = Math.abs((bands[i].top + bands[i].bottom) / 2 - est(it));
          if (d < bd) { bd = d; bi = i; }
        }
        if (bi >= 0) { used[bi] = true; pairs.push([it, bands[bi]]); }
      }
    }
    let hit = 0;
    for (const [it, b] of pairs) {
      // 位置对不上 → 这条行此刻可能没画出来（或估算完全跑偏），别硬套。
      // 允许的偏差随行数放宽：n 条叠在一起时，最上面那条离自己的 margin 有 (n-1) 行高。
      const cap = Math.max(it.lineH || 0, b.bottom - b.top) * 1.5 + (ass.length - 1) * (it.lineH || 0);
      if (Math.abs((b.top + b.bottom) / 2 - est(it)) > cap) continue;
      hit++;
      it.top = b.top;
      it.bottom = b.bottom;
      it.lineH = b.bottom - b.top;
      const estW = it.adv[it.plain.length] || 0, realW = b.right - b.left;
      const k = estW > 0 ? realW / estW : 0;
      if (k > 0.35 && k < 2.5) {
        it.adv = it.adv.map(v => v * k);            // 片段区间随之等比换算
        it.fontPx = (it.fontPx || realW / 12) * k;
      }
      it.x0 = b.left;
    }
    return hit === ass.length;
  }

  _layoutSrt(it, pic) {
    const el = this._findSrtLineEl(it.plain);
    if (!el) return null;
    const st = this.stage.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const fontPx = parseFloat(cs.fontSize) || 20;
    const r = el.getBoundingClientRect();
    const lineH = r.height || fontPx * 1.32;
    const top = r.top - st.top, bottom = r.bottom - st.top;
    // 有真实 DOM 就量到字符级：片段边界不是估算出来的
    const adv = this._domAdvances(el, it.plain, st.left);
    if (adv) return { fontPx, lineH, top, bottom, x0: adv.base, adv: adv.rel };
    // 兜底（元素没渲染 / 量不到）：按元素矩形 + 量字宽摆放，与 ASS 的估算同一套口径
    const fontCss = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = htmlPlainAndMap(it.raw);
    const w = this._measure(m.plain, fontCss);
    const left = r.left - st.left, right = r.right - st.left;
    const x0 = (left + right) / 2 - w / 2;
    return { fontPx, lineH, top, bottom, x0, adv: this._advances(m.plain, x0, fontCss) };
  }

  /**
   * SRT 行是真实 DOM → 逐字符用 Range 量左边缘，片段区间因此是**精确**的。
   * 行内标签（<i>/<font>）会把文本拆成多个节点，所以按节点顺序累计下标偏移。
   * 量不到（元素不可见 / 整行换行了 / 与纯文本对不上）返回 null，由调用方退回估算。
   */
  _domAdvances(el, plain, stageLeft) {
    const n = String(plain || '').length;
    if (!n) return null;
    const lefts = new Array(n), widths = new Array(n);
    let off = 0, bad = false;
    const walk = (node) => {
      if (bad) return;
      if (node.nodeType === 3) {
        const s = node.nodeValue || '';
        for (let i = 0; i < s.length; i++) {
          const idx = off + i;
          if (idx >= n) { bad = true; return; }
          const rg = document.createRange();
          rg.setStart(node, i); rg.setEnd(node, i + 1);
          const b = rg.getBoundingClientRect();
          if (!b.width && !b.height) { bad = true; return; }
          if (idx && b.left < lefts[idx - 1] - 1) { bad = true; return; }   // 折行了 → 逐字模型不成立
          lefts[idx] = b.left - stageLeft;
          widths[idx] = b.width;
        }
        off += s.length;
      } else if (node.nodeType === 1) {
        for (const c of node.childNodes) walk(c);
      }
    };
    walk(el);
    if (bad || off !== n) return null;
    const base = lefts[0] || 0;
    const rel = new Array(n + 1);
    for (let i = 0; i < n; i++) rel[i] = lefts[i] - base;
    rel[n] = Math.max(rel[n - 1] + (widths[n - 1] || 0), rel[n - 1] + 1);
    return { base, rel };
  }

  /** ASS 行没有 DOM，按 Style 反推；竖直位置由 Alignment + MarginV 决定 */
  _layoutAss(it, pic) {
    const st = this.api.styleOf(it.styleName) || {};
    const playY = Number(this.api.playResY()) || 1080;
    const scale = pic.height / playY;
    const fontPx = (Number(st.fontsize) || 48) * scale;
    const align = Number(st.alignment) || 2;
    const mv = (Number(st.marginv) || 0) * scale;
    const ml = (Number(st.marginl) || 0) * scale;
    const mr = (Number(st.marginr) || 0) * scale;
    const lineH = fontPx * 1.28;
    const fontCss = `600 ${fontPx.toFixed(1)}px ${FONT_STACK}`;
    const w = this._measure(it.plain, fontCss);
    const left = pic.left + ml, right = pic.left + pic.width - mr;
    const col = align % 3;                              // 1=左 2=中 0=右（小键盘对齐）
    const x0 = col === 1 ? left : col === 0 ? right - w : (left + right) / 2 - w / 2;
    const bottom = align >= 7 ? pic.top + mv + lineH
      : align >= 4 ? pic.top + pic.height / 2 + lineH / 2
        : pic.top + pic.height - mv;
    return { fontPx, lineH, x0, bottom, adv: this._advances(it.plain, x0, fontCss) };
  }

  /** 逐字符累计宽度：adv[i] = 纯文本前 i 个字符的总宽（片段区间直接查表） */
  _advances(plain, x0, fontCss) {
    const s = String(plain || '');
    const adv = new Array(s.length + 1);
    adv[0] = 0;
    for (let i = 0; i < s.length; i++) adv[i + 1] = adv[i] + this._measure(s[i], fontCss);
    return adv;
  }

  _findSrtLineEl(plain) {
    const overlay = document.getElementById('srt-overlay');
    if (!overlay) return null;
    const want = String(plain || '').trim();
    for (const el of overlay.querySelectorAll('.ov-line')) {
      if (el.textContent.trim() === want) return el;
    }
    return null;
  }

  /* ─────────── 打开 / 提交 / 取消 ─────────── */

  begin(item, seg) {
    if (this.open) this.cancel();
    this.cancelPendingClick();
    this.open = { item, seg };
    this._swallowClick = false;
    this._pausedBefore = this.video.paused;
    if (!this.video.paused) this.video.pause();       // 编辑时定住画面（播放头移出该句会看不到效果）
    this.input.value = seg.text;
    this.layer.hidden = false;
    this.box.hidden = false;
    this._place(item, seg);
    this.input.focus();
    this.input.select();
    document.addEventListener('pointerdown', this._onDocPointer, true);
    document.addEventListener('keydown', this._onKey, true);
    window.addEventListener('resize', this._onRelayout);
    window.addEventListener('fullscreenchange', this._onRelayout);   // 全屏切换后画面尺寸变了
    if (this._ro) this._ro.observe(this.stage);                     // 元素级尺寸变化（面板挤压）上面两个事件收不到
    if (this.api.onOpenChange) this.api.onOpenChange(true);
  }

  /** 把高亮框与输入框摆到片段附近：能放下面就放下方，放不下就放上方；横向夹在画面内 */
  _place(item, seg) {
    const r = this._segRect(item, seg);
    this.segBox.style.left = r.left + 'px';
    this.segBox.style.top = r.top + 'px';
    this.segBox.style.width = r.width + 'px';
    this.segBox.style.height = r.height + 'px';

    const stage = this.stage.getBoundingClientRect();
    const pic = this.api.pictureRect();
    const bw = this.box.offsetWidth || 240;
    const bh = this.box.offsetHeight || 62;
    let left = r.left + r.width / 2 - bw / 2;
    const minL = Math.max(4, pic.left + 4), maxL = Math.min(stage.width - bw - 4, pic.left + pic.width - bw - 4);
    left = Math.min(Math.max(left, minL), Math.max(minL, maxL));
    const below = r.top + r.height + 8;
    const above = Math.max(4, r.top - bh - 8);
    // 中英双行时"下方"就是另一条字幕行 —— 压住它等于把要对照的那行挡住，所以让开：
    // 下方会压到别的行就翻到上方；上方也压得到（三行以上）就还是回下方（至少贴着点中的那条）
    const others = this._layoutItems().filter(o => !(o.side === item.side && o.plain === item.plain));
    const coversOther = (t) => others.some(o => t < o.bottom + 4 && t + bh > o.top - 4);
    const fitsBelow = below + bh <= stage.height - 4;
    const top = (fitsBelow && !coversOther(below)) ? below
      : (fitsBelow && coversOther(above)) ? below : above;
    this.box.style.left = left + 'px';
    this.box.style.top = top + 'px';
    /* 入场动画（CSS 的 pop-in）从"点中的那一段"长出来：原点 = 片段中心在框内的百分比。
     * 框在片段下方 → 原点贴顶边；翻到上方 → 贴底边（视觉上永远是"从字幕那侧冒出来"）。 */
    const ox = Math.max(0, Math.min(100, ((r.left + r.width / 2) - left) / (bw || 1) * 100));
    this.box.style.setProperty('--pop-ox', ox.toFixed(1) + '%');
    this.box.style.setProperty('--pop-oy', (top < r.top ? 100 : 0) + '%');
  }

  _segRect(item, seg) {
    const x1 = item.x0 + item.adv[seg.start];
    const x2 = item.x0 + item.adv[seg.end];
    return { left: x1 - SEG_PAD_X, top: item.top + 2, width: (x2 - x1) + SEG_PAD_X * 2, height: Math.max(12, item.lineH - 4) };
  }

  commit() {
    const cur = this.open;
    if (!cur) return;
    // 必须先取文本再 close() —— close() 会清空输入框，顺序反了提交的就永远是空串
    const text = String(this.input.value);
    this.close();
    if (text === cur.seg.text) { this._restorePlay(); return; }    // 没改 → 当取消
    const done = this.api.commit(cur.item, cur.seg, text);
    this._ink = null;      // 文本真的改了 → 这一帧的墨迹几何作废
    if (done === false && this.api.toast) this.api.toast('⚠ 字幕已变化，未保存，请重新双击');
    else if (done !== false && this.api.toast) this.api.toast('✓ 已替换' + (/\s/.test(text) ? '（已拆成多段）' : ''));
    this._restorePlay();
  }

  cancel() {
    if (!this.open) return;
    this.close();
    this._restorePlay();
  }

  /** 只收 UI，不动数据、不动播放状态 */
  close() {
    this.open = null;
    this.layer.hidden = true;
    this.box.hidden = true;
    this.input.value = '';
    if (this._pvFrame) { cancelAnimationFrame(this._pvFrame); this._pvFrame = 0; }
    if (this.api.endPreview) this.api.endPreview();       // 撤掉实时预览，画面回到真实字幕
    /* 墨迹缓存**只在画布内容真的变过**时才作废（打字预览过 → 画布上是草稿）。
     * 不能无条件清：清了以后下一次 _layoutItems 要重扫，而重扫有可能撞上 libass 重绘的
     * 空帧、退回估算几何 —— 同一帧上两次取布局就会给出两套坐标，命中判定随之飘。
     * 保存（commit）走的是另一条路，那里会显式作废。 */
    if (this._pvDirty) { this._ink = null; this._pvDirty = false; }
    document.removeEventListener('pointerdown', this._onDocPointer, true);
    document.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onRelayout);
    window.removeEventListener('fullscreenchange', this._onRelayout);
    if (this._ro) this._ro.disconnect();
    if (this.api.onOpenChange) this.api.onOpenChange(false);
  }

  /* ─────────── 打字即预览 ─────────── */

  /** 逐帧合并：连打十个字只渲染一次，且永远用最新的输入框内容 */
  _onInput() {
    if (!this.open || !this.api.preview) return;
    if (this._pvFrame) return;
    this._pvFrame = requestAnimationFrame(() => {
      this._pvFrame = 0;
      const cur = this.open;
      if (!cur) return;
      this.api.preview(cur.item, cur.seg, String(this.input.value));
      this._ink = null;             // 画布上现在是草稿 → 这一帧的墨迹几何作废
      this._pvDirty = true;
    });
  }

  _restorePlay() {
    if (this._pausedBefore === false) this.video.play().catch(() => {});
    this._pausedBefore = undefined;
  }

  /* ─────────── 事件 ─────────── */

  _onDocPointer(e) {
    if (!this.open) return;
    if (this.box.contains(e.target)) return;
    // 点框外即取消。点在视频区上时，这一下 pointerdown 之后还会来一个 click ——
    // 记个记号让 main.js 的播放/暂停忽略它（否则"取消编辑"会顺带把视频切一下）。
    if (this.stage.contains(e.target)) this._swallowClick = true;
    this.cancel();
  }

  _onKey(e) {
    if (!this.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Enter = 从"改这一段"升级成"改整行"（与列表行内编辑的 Ctrl+Enter 语义一致）
      e.preventDefault(); e.stopPropagation();
      const item = this.open.item;
      if (this.dialog) { this.cancel(); this.dialog.show(item); }
    } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.commit(); }
  }

  /** 重新取"开着的这一行"的最新几何。开框时抓下来的 item 是**那一刻**的坐标，
   *  窗口/容器尺寸一变就过期 —— 拿旧坐标重摆只会把框摆偏（_place 的 adv/top 全来自 item）。
   *  身份按底层对象匹配（ASS 的 sent / SRT 的 cue+lineIdx），不按文本 —— 文本正被编辑。 */
  _refreshOpenItem() {
    const src = this.open && this.open.item;
    if (!src) return null;
    for (const it of this._layoutItems()) {
      if (it.kind !== src.kind || it.side !== src.side) continue;
      if (src.kind === 'srt') { if (it.cue === src.cue && it.lineIdx === src.lineIdx) return it; }
      else if (it.sent === src.sent) return it;
    }
    return null;
  }

  _onRelayout() {
    if (!this.open) return;
    const fresh = this._refreshOpenItem();
    if (fresh) {
      this.open.item = fresh;
      const seg = (fresh.segs || []).find(s => s.start === this.open.seg.start && s.end === this.open.seg.end);
      if (seg) this.open.seg = seg;                 // 文本未提交，区间必然对得上；对不上就保守沿用旧的
    }
    this._place(this.open.item, this.open.seg);
  }
}

/**
 * 整行文本弹窗（"编辑字幕文本（仅修改 Text 字段，不改变时间与样式）"）。
 *
 * 与片段框的分工：片段框只做"快速改一个字/词"（用户输入按纯文本转义）；
 * 这里改**整行正文**，允许直接写 ASS 内联标签（{\c&H..&}、\N 等）——
 * 行首的角色标签与颜色前缀属于只读前缀，保存时自动补回，所以编辑框里不出现、也不用重复输入。
 *
 * 入口：片段框内 Ctrl+Enter（不额外加按钮，保持与参考图一致的紧凑外观），
 *       或在视频画面上右键该条字幕。
 */
export class CueTextDialog {
  constructor({ overlay, title, preview, hint, input, cancelBtn, okBtn }, api) {
    this.el = overlay;
    this.titleEl = title;
    this.previewEl = preview;
    this.hintEl = hint;
    this.inputEl = input;
    this.api = api;
    this.open = null;
    cancelBtn.addEventListener('click', () => this.close());
    okBtn.addEventListener('click', () => this.save());
    // 点遮罩空白处 = 取消（与项目其它弹窗一致）
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) this.close(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.save(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
  }

  get isOpen() { return !this.el.hidden; }

  show(item) {
    this.open = item;
    if (this.previewEl) this.previewEl.textContent = item.plain;
    // 提示按格式说人话：SRT 没有 Text 字段也没有内联标签，照抄 ASS 的文案会误导
    if (this.hintEl) {
      this.hintEl.textContent = item.kind === 'srt'
        ? '提示：仅替换这一行的文本；时间与其它行不动。行首 [角色] 前缀会自动保留，不应在编辑框中重复输入。'
          + '（SRT 行内 <i>/<b> 等标签按纯文本处理，整行改写后不会自动带回来）'
        : '提示：仅替换 ASS 的 Text 字段；行首角色/颜色前缀会自动保留，不应在编辑框中重复输入。可在此输入 ASS 内联标签。';
    }
    this.inputEl.value = item.plain.slice(item.prefix.length);
    this.el.hidden = false;
    this.inputEl.focus();
    const n = this.inputEl.value.length;
    this.inputEl.setSelectionRange(n, n);
  }

  save() {
    const item = this.open;
    if (!item) return;
    const body = this.inputEl.value;
    this.close();
    const done = this.api.commitWhole(item, body);
    if (done === false && this.api.toast) this.api.toast('⚠ 字幕已变化，未保存');
    else if (this.api.toast) this.api.toast('✓ 已更新整行文本');
  }

  close() {
    this.open = null;
    this.el.hidden = true;
  }
}
