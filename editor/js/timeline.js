/** Canvas 时间轴: 胶片缩略图 + 分轨字幕块 + 缩放/平移/定位/拖动改时间/空白拖动新建 */
import { fmtTime } from './util.js';

const FILM_H = 46;       // 胶片缩略图条
const RULER_H = 20;      // 刻度
const LANE_H = 34;       // 每轨高度
const LANE_GAP = 6;
const CHIP_W = 78;       // 轨道标签
const TEXT_PAD = 6;
const EDGE_TOL = 5;      // 块边缘命中半径(px): 块重叠时优先选中"边界"
const DRAG_THRESH = 4;   // 区分"单击"与"拖动"的位移阈值(px)
const DEFAULT_SPAN = 30; // 默认视图跨度(秒): 一上来只看 30 秒, 而不是整个视频

/* 参考图配色 */
const C = {
  bg: '#0b0b0e',
  filmBg: '#15151b',
  filmBorder: '#242430',
  laneBg: '#111116',
  laneBorder: '#20202a',
  accent: '#ff7a45',       // 橙色主色
  chipBg: 'rgba(18,18,24,.88)',
  chipText: '#ffb08a',
  ruler: '#6d6d7a',
  rulerTick: '#2c2c38',
  playhead: '#ff7a45'
};

/* 各样式轨道配色(逐词样式 → 紫, 整句样式 → 橙) */
const LANE_COLORS = ['#ff7a45', '#8b7cf6', '#4fd1a5', '#61b8ff', '#ff5c8a', '#d9c14f'];

/* ── 颜色工具: 说话人颜色半透明底 + 依亮度选文字色 ── */
function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const h = m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function withAlpha(hex, a, fallback) {
  const c = parseHex(hex);
  if (!c) return fallback;
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
/**
 * 半透明色叠在深色轨道底(#111116)上的"实际观感底色", 据此选文字颜色:
 * 直接按原色亮度判断会误判(45% 透明后整体已明显变暗)。
 */
function textOnTranslucent(hex, alpha, fallback) {
  const c = parseHex(hex);
  if (!c) return fallback;
  const bg = { r: 0x11, g: 0x11, b: 0x16 };
  const r = c.r * alpha + bg.r * (1 - alpha);
  const g = c.g * alpha + bg.g * (1 - alpha);
  const b = c.b * alpha + bg.b * (1 - alpha);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.45 ? '#141418' : '#ffffff';
}

/**
 * 块在轨道内的纵向分段:
 *  - 中英配对块 → 占满整轨(上半行英文, 下半行中文)
 *  - 只有中文的孤行 → 只占**上半区**
 *  - 只有英文的孤行 → 只占**下半区**
 * 于是孤行不必另开轨道, 同时保留「中文在上、英文在下」的位置感。
 */
function bandOf(cue, laneTop, laneH) {
  if (cue.half === 'top') return { y: laneTop + 4, h: LANE_H - 8 };
  if (cue.half === 'bottom') return { y: laneTop + LANE_H + LANE_GAP + 4, h: LANE_H - 8 };
  return { y: laneTop + 4, h: laneH - 8 };
}

class Filmstrip {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.fv = null;
    this.cache = new Map();
    this.failed = new Set();
    this.pending = null;
    this.mainSrc = '';
  }
  reset(mainVideo) {
    const src = mainVideo && mainVideo.currentSrc;
    if (src === this.mainSrc && this.fv) return;
    this.mainSrc = src || '';
    this.cache.clear();
    this.failed.clear();
    this.pending = null;
    if (this.fv) { this.fv.removeAttribute('src'); this.fv.load(); this.fv = null; }
  }
  _ensure() {
    if (this.fv) return this.fv;
    if (!this.mainSrc) return null;
    const fv = document.createElement('video');
    fv.muted = true;
    fv.preload = 'metadata';
    fv.src = this.mainSrc;
    fv.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(fv);
    this.fv = fv;
    return fv;
  }
  _key(step, idx) { return step + '@' + idx; }
  get(step, idx) { return this.cache.get(this._key(step, idx)) || null; }
  request(step, idx, t) {
    const k = this._key(step, idx);
    if (this.cache.has(k) || this.failed.has(k) || this.pending) return;
    const fv = this._ensure();
    if (!fv) return;
    this.pending = k;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      fv.removeEventListener('seeked', onSeeked);
      if (ok) {
        try {
          const c = document.createElement('canvas');
          c.width = 160; c.height = 90;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#0a0a0d';
          ctx.fillRect(0, 0, 160, 90);
          const vw = fv.videoWidth, vh = fv.videoHeight;
          if (vw && vh) {
            const r = Math.min(160 / vw, 90 / vh);
            const dw = vw * r, dh = vh * r;
            ctx.drawImage(fv, (160 - dw) / 2, (90 - dh) / 2, dw, dh);
          }
          this.cache.set(k, c);
        } catch (e) { this.failed.add(k); }
      } else {
        this.failed.add(k);
      }
      this.pending = null;
      if (this.onUpdate) this.onUpdate();
    };
    const onSeeked = () => finish(true);
    fv.addEventListener('seeked', onSeeked);
    try { fv.currentTime = Math.max(0, t); }
    catch (e) { finish(false); return; }
    setTimeout(() => { if (!settled) finish(false); }, 4000);
  }
}

export class Timeline {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video || null;
    this.film = new Filmstrip(() => { /* 下一帧重绘 */ });
    this.lanes = [];
    this.duration = 0;
    this.viewStart = 0;
    this.pxPerSec = 50;
    this.follow = true;       // 默认开启跟随播放头
    this.selected = null;     // 行对象
    this.panSensitivity = 120;  // 滚轮平移灵敏度(px/格, 设置 Tab 可调)
    this.zoomSensitivity = 1.25; // Ctrl+滚轮缩放灵敏度(每格倍率, 设置 Tab 可调)
    this.waveform = null;     // 波形图 Image(ffmpeg 提取, 画在字幕块内; PNG 兜底)
    this.waveformReady = false;
    this.peaks = null;        // 峰值数据 {data: Uint8Array, rate} —— 优先用它绘制(任意缩放都锐利)
    this.showFilm = false;    // 胶片预览图(视频缩略图条): 设置里可开关, 默认关
    this.subStart = 0;        // 字幕内容范围(第一块开始 ~ 最后一块结束)
    this.subEnd = 0;
    this.onSeek = null;
    this.onRetime = null;
    this.onSelect = null;
    this.onCreate = null;     // 空白处拖动新建: (start, end)
    this.onDelete = null;     // 右键菜单删除: (ref)
    this.isEditable = null;
    this._drag = null;
    this._filmRotate = 0;
    this._viewReady = false;      // 是否已按"默认跨度"摆好视图
    this._viewFromLanes = false;  // 默认视图是否已按真实字幕范围算过
    this._menuCue = null;

    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
  }

  setVideo(video) { this.video = video; this.film.reset(video); }

  /** 波形图(整段视频一张 PNG); 传空清除 */
  setWaveform(url) {
    this.waveform = null;
    this.waveformReady = false;
    if (!url) return;
    const img = new Image();
    img.onload = () => { this.waveform = img; this.waveformReady = true; };
    img.src = url;
  }

  /** 峰值数据(推荐): rate = 每秒包络值个数, data = Uint8Array。
   *  绘制时按屏幕像素列取该列时间范围内的最大峰值 → 矢量绘制, 任意缩放都锐利(不像缩放图片会糊)。 */
  setPeaks(peaks) {
    this.peaks = (peaks && peaks.data && peaks.data.length) ? peaks : null;
  }

  setLanes(lanes) {
    this.lanes = lanes.map((l, i) => {
      const lane = Object.assign({ color: LANE_COLORS[i % LANE_COLORS.length] }, l);
      // 合并轨(中英同起止): 高度盖住原来两条轨 + 中间间隙 → 一个块无空隙
      if (lane.merged && !lane.h) lane.h = LANE_H * 2 + LANE_GAP;
      // 前缀最大结束时间: 块的 end 不随 start 单调, 命中测试靠它精确剪枝
      let m = -Infinity;
      for (const c of lane.cues) { m = Math.max(m, c.end); c._maxEnd = m; }
      return lane;
    });
    // 载入新文件后按"默认跨度"摆一次视图; 之后的增删改重建不动用户视角
    const hasRange = this._refreshRange();
    if (hasRange && !this._viewFromLanes) {
      this._viewFromLanes = true;
      this._applyDefaultView();
    }
  }

  setDuration(d) {
    const prev = this.duration;
    this.duration = d || 0;
    if (!this._viewReady || Math.abs(this.duration - prev) > 0.05) this._applyDefaultView();
  }

  setSelected(ref) { this.selected = ref; }

  /** 载入新字幕/视频时调用: 下一次 setLanes/setDuration 会重新按默认跨度定位 */
  resetView() {
    this._viewReady = false;
    this._viewFromLanes = false;
    this.subStart = 0;
    this.subEnd = 0;
    this._hideMenu();
  }

  /** 字幕内容范围(第一块开始 ~ 最后一块结束): 缩放与平移都不许越出它 */
  _refreshRange() {
    let a = Infinity, b = -Infinity;
    for (const lane of this.lanes) {
      for (const c of lane.cues) { if (c.start < a) a = c.start; if (c.end > b) b = c.end; }
    }
    if (!isFinite(a) || !(b > a)) { this.subStart = 0; this.subEnd = 0; return false; }
    this.subStart = a; this.subEnd = b;
    return true;
  }

  /** 视图可用范围: 有字幕时=字幕范围, 否则退化成整段视频 */
  _contentRange() {
    if (this.subEnd > this.subStart) return { a: this.subStart, b: this.subEnd, span: this.subEnd - this.subStart };
    if (this.duration > 0) return { a: 0, b: this.duration, span: this.duration };
    return null;
  }

  /** 缩放上下限: 拉到最远时视图恰好覆盖全部字幕(不再超出字幕), 推近约到 0.4 秒铺满 */
  _zoomLimits() {
    const w = Math.max(1, this._cssW());
    const r = this._contentRange();
    const maxSpan = r ? Math.max(0.5, r.span) : Math.max(DEFAULT_SPAN, this.duration || DEFAULT_SPAN);
    const min = w / maxSpan;
    return { min, max: Math.max(w / 0.4, min) };
  }

  /** 默认视图: 跨度 = min(30s, 字幕总时长), 起点对齐第一块 */
  _applyDefaultView() {
    const r = this._contentRange();
    const w = this._cssW();
    if (!r || w <= 0) return;
    this.pxPerSec = w / Math.max(0.2, Math.min(DEFAULT_SPAN, r.span));
    this.viewStart = r.a;
    this._clampView();
    this._viewReady = true;
  }

  /** 适配: 视图正好铺满全部字幕(即缩放到最远) */
  fit() {
    const r = this._contentRange();
    const w = this._cssW();
    if (!r || w <= 0) return;
    this.pxPerSec = w / Math.max(0.2, r.span);
    this.viewStart = r.a;
    this._clampView();
    this._viewReady = true;
  }
  zoomIn() { this._zoomAt(this._cssW() / 2, 1.6); }
  zoomOut() { this._zoomAt(this._cssW() / 2, 1 / 1.6); }

  /** 胶片预览图高度: 关闭时为 0(不占位, 字幕块直接顶到刻度线下方) */
  _filmH() { return this.showFilm ? FILM_H : 0; }

  _cssW() { return this.canvas.parentElement.clientWidth; }
  _cssH() { return this.canvas.parentElement.clientHeight; }
  /** 合并轨(唯一主轨)动态填满画布剩余高度 → 字幕块一直顶到面板底端, 不留黑缺 */
  _laneH(i) {
    const lane = this.lanes[i];
    if (lane && lane.merged) {
      const fill = this._cssH() - this._filmH() - RULER_H - 6;
      return Math.max(LANE_H * 2 + LANE_GAP, fill);
    }
    return (lane && lane.h) || LANE_H;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this._cssW(), h = this._cssH();
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 画布变宽/变窄时保持"可见秒数"不变(否则缩放窗口会顺带改变时间跨度)
    if (this._lastW > 0 && w > 0 && w !== this._lastW) this.pxPerSec *= w / this._lastW;
    this._lastW = w;
    if (!this._viewReady) this._applyDefaultView();
    else this._clampView();
  }

  _zoomAt(px, factor) {
    const lim = this._zoomLimits();
    const next = Math.max(lim.min, Math.min(lim.max, this.pxPerSec * factor));
    if (!isFinite(next) || Math.abs(next - this.pxPerSec) < 1e-9) return false;
    const t = this.viewStart + px / this.pxPerSec;
    this.pxPerSec = next;
    this.viewStart = t - px / this.pxPerSec;
    this._clampView();
    this._viewReady = true;
    return true;
  }
  /** 平移: 正数 = 往时间更晚的方向看 */
  _panBy(px) {
    this.viewStart += px / this.pxPerSec;
    this._clampView();
    this._viewReady = true;
  }
  _clampView() {
    const w = this._cssW();
    if (w <= 0) return;
    const r = this._contentRange();
    if (!r) { this.viewStart = 0; return; }
    const span = w / this.pxPerSec;
    if (span >= r.span) this.viewStart = r.a + (r.span - span) / 2;
    else this.viewStart = Math.min(r.b - span, Math.max(r.a, this.viewStart));
  }

  t2x(t) { return (t - this.viewStart) * this.pxPerSec; }
  x2t(x) { return this.viewStart + x / this.pxPerSec; }

  _laneTop(i) {
    let y = this._filmH() + RULER_H + 6;
    for (let k = 0; k < i; k++) y += this._laneH(k) + LANE_GAP;
    return y;
  }
  _lanesBottom() {
    const n = this.lanes.length;
    return n ? this._laneTop(n - 1) + this._laneH(n - 1) : this._filmH() + RULER_H + 6;
  }

  /* ─────────── 事件 ─────────── */
  _bindEvents() {
    const cv = this.canvas;
    this.menuEl = document.getElementById('tl-menu');
    if (this.menuEl) {
      this.menuEl.addEventListener('click', (e) => {
        const item = e.target.closest('[data-act]');
        if (!item) return;
        const act = item.dataset.act;
        const cue = this._menuCue;
        this._hideMenu();
        if (act === 'delete' && cue && this.onDelete) this.onDelete(cue.ref);
      });
    }

    // 右键字幕块 → 二级菜单(目前只有"删除")
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this._laneIndexAtY(e.offsetY) === -1 ? null : this._hitTest(e.offsetX, e.offsetY, true);
      if (!hit) { this._hideMenu(); return; }
      if (this.onSelect) this.onSelect(hit.cue.ref, { seek: false });
      this._showMenu(e.clientX, e.clientY, hit.cue);
    });

    // 滚轮: 平移(下滑=往前看/更早, 上滑=往后看/更晚, 灵敏度=每格像素), Ctrl+滚轮: 缩放(灵敏度=每格倍率)
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._hideMenu();
      const dir = e.deltaY < 0 ? 1 : -1;        // 上滚为正
      if (e.ctrlKey || e.metaKey) this._zoomAt(e.offsetX, dir > 0 ? this.zoomSensitivity : 1 / this.zoomSensitivity);
      else this._panBy(dir * this.panSensitivity);   // 下滚 dir=-1 → 负 → 看更早
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;               // 右键交给 contextmenu
      this._hideMenu();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无捕获 */ }
      const x = e.offsetX, y = e.offsetY;
      const onLane = this._laneIndexAtY(y) !== -1;
      const hit = onLane ? this._hitTest(x, y, true) : null;

      if (hit && (!this.isEditable || this.isEditable(hit.cue.ref))) {
        const c = hit.cue;
        const csx = this.t2x(c.start), cex = this.t2x(c.end);
        let part = 'body';
        if (cex - csx >= 8) {
          if (Math.abs(x - csx) <= EDGE_TOL) part = 'left';
          else if (Math.abs(x - cex) <= EDGE_TOL) part = 'right';
        }
        const n = this._neighbors(c);
        this._drag = {
          type: 'cue', part, cue: c, x0: x, y0: y, moved: false,
          offStart: c.start - this.x2t(x), len0: c.end - c.start, shift: e.shiftKey,
          prevEnd: n.prevEnd, nextStart: n.nextStart
        };
        if (this.onSelect) this.onSelect(c.ref, { seek: false });
        return;
      }
      // 空白处: 拖动 = 按拖动起止时间新建字幕块; 单击 = 跳转
      this._drag = { type: onLane ? 'create' : 'seek', x0: x, y0: y, t0: this.x2t(x), moved: false };
    });

    cv.addEventListener('pointermove', (e) => {
      const x = e.offsetX, y = e.offsetY;
      if (!this._drag) {
        let cursor = 'default';
        if (this._laneIndexAtY(y) !== -1) {
          const hit = this._hitTest(x, y, true);
          if (hit && (!this.isEditable || this.isEditable(hit.cue.ref))) {
            const csx = this.t2x(hit.cue.start), cex = this.t2x(hit.cue.end);
            const onEdge = cex - csx >= 8 && (Math.abs(x - csx) <= EDGE_TOL || Math.abs(x - cex) <= EDGE_TOL);
            cursor = onEdge ? 'ew-resize' : 'move';
          } else cursor = 'crosshair';
        }
        cv.style.cursor = cursor;
        return;
      }
      const d = this._drag;
      if (!d.moved && Math.abs(x - d.x0) < DRAG_THRESH && Math.abs(y - d.y0) < DRAG_THRESH) return;
      d.moved = true;

      if (d.type === 'cue') {
        d.shift = e.shiftKey;
        const c = d.cue;
        const hi = this._tMax();
        if (d.part === 'body') {
          const len = d.len0;
          let ns = this.x2t(x) + d.offStart;
          ns = Math.min(ns, hi - len);
          if (!d.shift) ns = Math.min(ns, d.nextStart - len);   // 不越过后一个块
          if (!d.shift) ns = Math.max(ns, d.prevEnd);           // 不越过前一个块
          ns = Math.max(0, ns);
          c.start = ns; c.end = ns + len;
        } else if (d.part === 'left') {
          let ns = Math.min(this.x2t(x), c.end - 0.05);
          if (!d.shift) ns = Math.max(ns, d.prevEnd);
          c.start = Math.max(0, ns);
        } else {
          let ne = Math.max(this.x2t(x), c.start + 0.05);
          if (!d.shift) ne = Math.min(ne, d.nextStart);
          c.end = Math.min(hi, ne);
        }
        if (this.onRetime) this.onRetime(c.ref, c.start, c.end, false, d.shift);
        return;
      }
      if (d.type === 'create') { d.t1 = this.x2t(x); d.curX = x; }
    });

    const finishDrag = (e) => {
      const d = this._drag;
      this._drag = null;
      if (!d) return;
      const t = this._clampT(this.x2t(e.offsetX));
      if (d.type === 'cue') {
        if (d.moved) {
          if (this.onRetime) this.onRetime(d.cue.ref, d.cue.start, d.cue.end, true, !!d.shift);
        } else {
          if (this.onSelect) this.onSelect(d.cue.ref, { seek: false });
          if (this.onSeek) this.onSeek(t);
        }
        return;
      }
      if (d.type === 'create' && d.moved) {
        const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
        if (b - a >= 0.05 && this.onCreate) { this.onCreate(Math.max(0, a), b); return; }
      }
      if (this.onSeek) this.onSeek(t);
    };
    cv.addEventListener('pointerup', finishDrag);
    cv.addEventListener('pointercancel', () => { this._drag = null; });

    // 点画布/菜单以外的地方 → 收起菜单
    document.addEventListener('pointerdown', (e) => {
      if (!this.menuEl || this.menuEl.hidden) return;
      if (this.menuEl.contains(e.target) || e.target === cv) return;
      this._hideMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._hideMenu(); });
  }

  _showMenu(cx, cy, cue) {
    const el = this.menuEl;
    if (!el) return;
    this._menuCue = cue;
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(cx, window.innerWidth - w - 6)) + 'px';
    el.style.top = Math.max(4, Math.min(cy, window.innerHeight - h - 6)) + 'px';
  }
  _hideMenu() {
    if (!this.menuEl || this.menuEl.hidden) return;
    this.menuEl.hidden = true;
    this._menuCue = null;
  }

  /** 前后邻居块的边界(防重叠夹取用): 同一条字幕块的另一半不算邻居 */
  _neighbors(cue) {
    let prevEnd = 0, nextStart = Infinity;
    for (const lane of this.lanes) {
      for (const c of lane.cues) {
        if (c === cue || (c.ref && c.ref === cue.ref)) continue;
        if (c.end <= cue.start + 1e-6) prevEnd = Math.max(prevEnd, c.end);
        if (c.start >= cue.end - 1e-6) nextStart = Math.min(nextStart, c.start);
      }
    }
    return { prevEnd, nextStart };
  }

  _tMax() { return this.duration > 0 ? this.duration : Math.max(this.subEnd, 1e6); }

  _clampT(t) {
    const hi = this.duration > 0 ? this.duration : (this.subEnd > 0 ? this.subEnd : t);
    return Math.max(0, Math.min(hi, t));
  }

  _laneIndexAtY(y) {
    for (let i = 0; i < this.lanes.length; i++) {
      const top = this._laneTop(i);
      if (y >= top && y <= top + this._laneH(i)) return i;
    }
    return -1;
  }

  /**
   * 命中测试.
   * 1) 同一轨道上可能同时存在"整块"和"只占上半区/下半区"的孤行, 因此除了时间
   *    还要用 y 判断落在哪一段——否则点上半区的中文行可能选中下半区的英文行。
   * 2) 块重叠时, 落在**边界**(起止边缘 EDGE_TOL 像素内)的点击优先判给该块,
   *    而不是一律判给压在上面的那一块, 否则重叠处的起止边界根本拖不动。
   * 3) 剪枝用前缀最大 end(_maxEnd): 块的 end 不随 start 单调, 直接看 cues[i].end
   *    会漏掉"开始更早但结束更晚"的长块。
   */
  _hitTest(x, y, preferEdge = false) {
    const li = this._laneIndexAtY(y);
    if (li === -1) return null;
    const lane = this.lanes[li];
    const yy = this._laneTop(li), lh = this._laneH(li);
    const t = this.x2t(x);
    const cues = lane.cues;
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const edgeDist = (c) => Math.min(Math.abs(x - this.t2x(c.start)), Math.abs(x - this.t2x(c.end)));
    const bestEdge = (list) => {
      let best = null, bestD = Infinity;
      for (const c of list) {
        const d = edgeDist(c);
        if (d <= EDGE_TOL && d < bestD) { bestD = d; best = c; }
      }
      return best;
    };

    const hits = [];
    for (let i = idx; i >= 0; i--) {
      const c = cues[i];
      if ((c._maxEnd != null ? c._maxEnd : c.end) < t) break;
      if (t >= c.start && t < c.end && this._inBand(c, y, yy, lh)) hits.push(c);
    }
    if (hits.length) {
      // hits[0] = start 最大的那个(绘制顺序在后 → 视觉上压在最上面)
      if (preferEdge) {
        const e = bestEdge(hits);
        if (e) return { lane, cue: e };
      }
      return { lane, cue: hits[0] };
    }
    if (preferEdge) {
      // 时间上没命中(点正好落在块的边界线上/块外一点), 但 x 贴着某块边缘
      const near = [];
      for (let i = Math.max(0, idx); i < cues.length; i++) {
        const c = cues[i];
        if (this.t2x(c.start) - x > EDGE_TOL) break;
        if (this._inBand(c, y, yy, lh)) near.push(c);
      }
      const e = bestEdge(near);
      if (e) return { lane, cue: e };
    }
    return null;
  }

  /** 点 (y) 是否落在该块的纵向分段内 */
  _inBand(cue, y, laneTop, laneH) {
    if (!cue.half) return true;                     // 整块: 占满整轨
    const b = bandOf(cue, laneTop, laneH);
    return y >= b.y && y <= b.y + b.h;
  }

  /* ─────────── 绘制 ─────────── */
  draw(t, playing) {
    this._lastT = t;
    const ctx = this.ctx;
    const W = this._cssW(), H = this._cssH();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.duration) {
      ctx.fillStyle = C.ruler;
      ctx.font = '13px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('加载视频后此处显示时间轴', W / 2, H / 2);
      return;
    }

    // 跟随: 只在**播放中**才把播放头拉回视野中央 —— 暂停时允许自由平移,
    // 否则滚轮平移会被下一帧的跟随立刻拽回去, 等于无法平移。
    if (this.follow && playing !== false) {
      const x = this.t2x(t);
      if (x < W * 0.1 || x > W * 0.9) {
        this.viewStart = t - W * 0.5 / this.pxPerSec;
        this._clampView();
      }
    }

    if (this.showFilm) this._drawFilmstrip(ctx, W);
    this._drawRuler(ctx, W);
    this._drawLanes(ctx, W, t);
    if (this._drag && this._drag.type === 'create' && this._drag.moved) this._drawCreatePreview(ctx);
    this._drawPlayhead(ctx, H, t);
  }

  /** 空白处拖动新建时的虚线预览框 */
  _drawCreatePreview(ctx) {
    const d = this._drag;
    const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
    const x1 = this.t2x(a), x2 = this.t2x(b);
    const top = this._filmH() + RULER_H + 6;
    const bottom = Math.max(top + 24, this._lanesBottom());
    ctx.save();
    ctx.fillStyle = 'rgba(255,122,69,.16)';
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    this._roundRect(ctx, x1, top + 2, Math.max(1.5, x2 - x1), bottom - top - 4, 4);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd9c7';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`新建 ${fmtTime(a)} → ${fmtTime(b)}`, Math.min(x1, x2) + 4, top - 4);
    ctx.restore();
  }

  _thumbStep() {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];
    for (const s of steps) if (s * this.pxPerSec >= 120) return s;
    return 3600;
  }

  _drawFilmstrip(ctx, W) {
    const step = this._thumbStep();
    const spanStart = this.viewStart, spanEnd = this.viewStart + W / this.pxPerSec;
    ctx.fillStyle = C.filmBg;
    ctx.fillRect(0, 0, W, FILM_H);

    const i0 = Math.max(0, Math.floor(spanStart / step));
    const i1 = Math.ceil(spanEnd / step);
    const cells = [];
    for (let i = i0; i <= i1 && cells.length < 64; i++) {
      const start = i * step, end = Math.min(start + step, this.duration);
      const x1 = this.t2x(start), x2 = this.t2x(end);
      if (x2 < -20 || x1 > W + 20) continue;
      cells.push({ i, start, x1, x2 });
    }
    // 每帧至多请求一张缺失缩略图(轮转, 避免抖动)
    if (cells.length) {
      for (let k = 0; k < cells.length; k++) {
        const c = cells[(this._filmRotate + k) % cells.length];
        if (!this.film.get(step, c.i) && !this.film.failed.has(step + '@' + c.i)) {
          this.film.request(step, c.i, c.start + Math.min(1, step * 0.25));
          this._filmRotate++;
          break;
        }
      }
    }

    for (const c of cells) {
      const w = Math.max(1, c.x2 - c.x1);
      const thumb = this.film.get(step, c.i);
      if (thumb) {
        ctx.drawImage(thumb, 0, 0, thumb.width, thumb.height, c.x1 + 0.5, 0.5, w - 1, FILM_H - 1);
      } else {
        ctx.fillStyle = '#191922';
        ctx.fillRect(c.x1 + 0.5, 0.5, w - 1, FILM_H - 1);
      }
      ctx.strokeStyle = C.filmBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(c.x1 + 0.5, 0.5, w - 1, FILM_H - 1);
      // 时间标签(橙色小字, 参考图样式)
      if (w >= 34) {
        const label = fmtTime(c.start, 1).replace(/\.0$/, '');
        ctx.font = '9px Consolas, monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,.62)';
        ctx.fillRect(c.x1 + 3, FILM_H - 13, tw + 6, 11);
        ctx.fillStyle = C.accent;
        ctx.textAlign = 'left';
        ctx.fillText(label, c.x1 + 6, FILM_H - 4);
      }
    }
    ctx.strokeStyle = C.filmBorder;
    ctx.beginPath(); ctx.moveTo(0, FILM_H + 0.5); ctx.lineTo(W, FILM_H + 0.5); ctx.stroke();
  }

  _niceStep(minPx) {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const s of steps) if (s * this.pxPerSec >= minPx) return s;
    return 7200;
  }

  _drawRuler(ctx, W) {
    const top = this._filmH();
    ctx.fillStyle = '#101015';
    ctx.fillRect(0, top, W, RULER_H);
    ctx.strokeStyle = C.laneBorder;
    ctx.beginPath(); ctx.moveTo(0, top + RULER_H + 0.5); ctx.lineTo(W, top + RULER_H + 0.5); ctx.stroke();

    const step = this._niceStep(80);
    const t0 = Math.max(0, Math.floor(this.viewStart / step) * step);
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    for (let tt = t0; tt <= this.viewStart + W / this.pxPerSec + step; tt += step) {
      const x = Math.round(this.t2x(tt)) + 0.5;
      if (x < -60 || x > W + 10) continue;
      ctx.strokeStyle = C.rulerTick;
      ctx.beginPath(); ctx.moveTo(x, top + RULER_H - 7); ctx.lineTo(x, top + RULER_H); ctx.stroke();
      ctx.fillStyle = C.ruler;
      ctx.fillText(fmtTime(tt, 1).replace(/\.0$/, ''), x + 4, top + RULER_H - 8);
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, Math.max(0, w / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 波形层: 铺满给定区域(整条轨道), 30% 不透明。
   *  优先用峰值数据逐屏幕像素列绘制(任意缩放都锐利), 否则退回整段 PNG 切片。 */
  _drawWaveLayer(ctx, W, top, h) {
    if (!(this.duration > 0) || h <= 2) return;
    const cy = top + h / 2, maxH = Math.max(2, h);
    ctx.save();
    ctx.globalAlpha = 0.3;
    if (this.peaks && this.peaks.data.length) {
      const { data, rate } = this.peaks;
      ctx.fillStyle = '#ffffff';
      for (let px = 0; px < W; px++) {
        const b0 = Math.floor(this.x2t(px) * rate);
        let b1 = Math.ceil(this.x2t(px + 1) * rate);
        if (b1 <= b0) b1 = b0 + 1;
        const step = (b1 - b0) > 24 ? Math.ceil((b1 - b0) / 24) : 1;   // 缩得很远时隔段采样
        let mx = 0;
        for (let b = b0; b < b1; b += step) {
          const v = data[b] || 0;
          if (v > mx) mx = v;
        }
        const bh = (mx / 255) * maxH;
        if (bh >= 1) ctx.fillRect(px, cy - bh / 2, 1, bh);
      }
    } else if (this.waveformReady && this.waveform) {
      const img = this.waveform;
      const span = W / this.pxPerSec;
      const sx = (this.viewStart / this.duration) * img.width;
      const sw = (span / this.duration) * img.width;
      if (sw > 0) ctx.drawImage(img, sx, 0, sw, img.height, 0, top, W, maxH);
    }
    ctx.restore();
  }

  _drawLanes(ctx, W, t) {
    this.lanes.forEach((lane, li) => {
      const yy = this._laneTop(li);
      const lh = this._laneH(li);
      ctx.fillStyle = C.laneBg;
      ctx.fillRect(0, yy, W, lh);
      ctx.strokeStyle = C.laneBorder;
      ctx.beginPath(); ctx.moveTo(0, yy + lh + 0.5); ctx.lineTo(W, yy + lh + 0.5); ctx.stroke();

      // 波形铺满整条轨道(整个视频都有波形, 而不仅限于有字幕块的地方); 字幕块画在它上面
      this._drawWaveLayer(ctx, W, yy + 4, lh - 8);

      const spanStart = this.viewStart - 1, spanEnd = this.viewStart + W / this.pxPerSec + 1;
      const cues = lane.cues;
      let lo = 0, hi = cues.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].end >= spanStart) hi = mid; else lo = mid + 1; }

      const minPx = 2;
      let runStart = null, runEnd = null, runBand = null;
      const flushRun = () => {
        if (runStart === null) return;
        const b = runBand || { y: yy + 4, h: lh - 8 };
        ctx.fillStyle = withAlpha(lane.color, 0.12, lane.color + '1f');
        this._roundRect(ctx, runStart, b.y, Math.max(1.5, runEnd - runStart), b.h, 3);
        ctx.fill();
        runStart = runEnd = runBand = null;
      };

      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      for (let i = lo; i < cues.length && cues[i].start <= spanEnd; i++) {
        const c = cues[i];
        const x1 = this.t2x(Math.max(c.start, spanStart));
        const x2 = this.t2x(Math.min(c.end, spanEnd));
        const wpx = x2 - x1;
        const band = bandOf(c, yy, lh);
        if (wpx < minPx) {
          if (runStart === null) { runStart = x1; runEnd = x2; runBand = band; }
          else runEnd = Math.max(runEnd, x2);
          continue;
        }
        flushRun();

        // 说话人颜色优先(半透明底), 否则用轨道色
        const base = c.color || lane.color;
        const isSel = this.selected && c.row === this.selected;
        const isPlay = c.start <= t && t < c.end;
        const alpha = 0.12;                       // 填充 12% 不透明(清晰可见的描边 + 极淡底色)
        const textColor = textOnTranslucent(base, alpha, '#ffffff');
        ctx.fillStyle = withAlpha(base, alpha, base);
        this._roundRect(ctx, x1 + 0.5, band.y, Math.max(1.5, wpx - 1), band.h, 3);
        ctx.fill();
        ctx.strokeStyle = withAlpha(base, 1, base); // 边框 100% 不透明
        ctx.lineWidth = 1;
        this._roundRect(ctx, x1 + 0.5, band.y, Math.max(1.5, wpx - 1), band.h, 3);
        ctx.stroke();
        if (isSel) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          this._roundRect(ctx, x1 + 0.5, band.y, Math.max(1.5, wpx - 1), band.h, 3);
          ctx.stroke();
        }
        // 块内文字(宽度足够时); 合并块: 中文整句在上, 英文**逐词按词级时间**平铺在块底
        if (wpx > 46 && (c.text || c.text2)) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + TEXT_PAD, band.y, wpx - TEXT_PAD * 2, band.h);
          ctx.clip();
          ctx.fillStyle = textColor;
          if (c.text2) {
            ctx.font = '10.5px "Microsoft YaHei", sans-serif';
            ctx.fillText(c.text2.slice(0, 60), x1 + TEXT_PAD, band.y + band.h * 0.36);
            const words = c.words;
            const baseY = band.y + band.h - 3;
            if (words && words.length && wpx / words.length > 8) {
              // 逐词平铺: 每个词画在它自己的开始时间处, 词首一根小竖线; 缩太远(词均宽<8px)退化为单行
              ctx.font = '9px "Microsoft YaHei", sans-serif';
              for (const wd of words) {
                const wx = this.t2x(wd.s);
                if (wx < x1 - 20 || wx > x2 + 20) continue;
                if (this.t2x(wd.e) - wx < 2) continue;
                ctx.globalAlpha = 0.6;
                ctx.fillRect(wx + 0.5, baseY - 11, 1, 11);   // 词首竖线
                ctx.globalAlpha = 1;
                ctx.fillText(wd.w, wx + 2.5, baseY - 1);
              }
            } else if (!words || !words.length) {
              ctx.font = '10px "Microsoft YaHei", sans-serif';
              ctx.fillText(c.text.slice(0, 60), x1 + TEXT_PAD, band.y + band.h * 0.78);
            }
          } else {
            // 纯英文孤行: 同样优先逐词平铺
            const words = c.words;
            const baseY = band.y + band.h - 3;
            if (words && words.length && wpx / words.length > 8) {
              ctx.font = '9px "Microsoft YaHei", sans-serif';
              for (const wd of words) {
                const wx = this.t2x(wd.s);
                if (wx < x1 - 20 || wx > x2 + 20) continue;
                if (this.t2x(wd.e) - wx < 2) continue;
                ctx.globalAlpha = 0.6;
                ctx.fillRect(wx + 0.5, baseY - 11, 1, 11);
                ctx.globalAlpha = 1;
                ctx.fillText(wd.w, wx + 2.5, baseY - 1);
              }
            } else {
              ctx.font = '10px "Microsoft YaHei", sans-serif';
              ctx.fillText(c.text.slice(0, 40), x1 + TEXT_PAD, band.y + band.h / 2 + 3.5);
            }
          }
          ctx.restore();
        }
      }
      flushRun();

      // 轨道标签: 无背景无边框、半透明, 固定在轨道左下角(文字下方), 不挡字幕块内容
      const label = lane.label || '';
      if (label) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = C.chipText;
        ctx.fillText(label, 12, yy + lh - 7);
        ctx.restore();
      }
    });
  }

  _drawPlayhead(ctx, H, t) {
    const x = Math.round(this.t2x(t)) + 0.5;
    if (x < -2 || x > this._cssW() + 2) return;
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7);
    ctx.closePath(); ctx.fill();
  }
}
