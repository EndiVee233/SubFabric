/** Canvas 时间轴: 胶片缩略图 + 分轨字幕块 + 缩放/平移/定位/拖动改时间/空白拖动新建 */
import { fmtTime } from './util.js';

const FILM_H = 46;       // 胶片缩略图条
const RULER_H = 20;      // 刻度
const WAVE_MIN = 24;     // 波形带低于此值就不画了(太空扁的包络看不出内容, 不如让位给字幕轨)
const WAVE_BOTTOM_PAD = 4; // 波形底缘离面板底的余量(留出底边线, 不贴死)
const WAVE_FILL = 220;     // 胶片条收起判据用的"典型满幅波形高"(保守值, 非硬上限)
const LANE_H = 34;       // 每轨高度
const LANE_GAP = 6;
const TEXT_PAD = 6;
const ZH_FONT = '700 12px "Microsoft YaHei", sans-serif';    // 中文行: 加粗加大
const EN_FONT = '700 11px "Microsoft YaHei", sans-serif';    // 英文逐词: 加粗加大
const AXIS_COLOR = 'rgba(228,228,238,.42)';   // 逐词轴/中英分隔线(中性浅灰)
const WORD_MARK = 'rgba(214,214,228,.85)';    // 逐词标记块
const WORD_MARK_HOT = 'rgba(255,255,255,.95)';// 拖动中的标记
const WORD_TEXT = '#e9e9f0';                  // 英文词文本(浅色, 与参考图一致)
const EDGE_TOL = 5;      // 块边缘命中半径(px): 块重叠时优先选中"边界"
const AXIS_R = 0.52;     // 中英分隔线在块高里的相对位置(夹在中文行与标记行之间, 见 _wordGeom)
const DRAG_THRESH = 4;   // 区分"单击"与"拖动"的位移阈值(px)
const DEFAULT_SPAN = 30; // 默认视图跨度(秒): 一上来只看 30 秒, 而不是整个视频

/* 参考图配色 */
const C = {
  bg: '#0b0b0e',
  filmBg: '#15151b',
  filmBorder: '#242430',
  laneBg: '#111116',
  laneBorder: '#20202a',
  waveBg: '#0e0e14',      // 波形带底色: 比轨道底略亮, 让波形区域一眼可辨
  accent: '#ff7a45',       // 橙色主色
  chipBg: 'rgba(18,18,24,.88)',
  chipText: '#ffb08a',
  ruler: '#6d6d7a',
  rulerTick: '#2c2c38',
  playhead: '#ff7a45'
};

/** 读一个 CSS 变量（时间轴要跟着界面主题色走，但 canvas 里拿不到 var()） */
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}
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
 *  - 中英配对块 → 占满整轨
 *  - 只有中文的孤行 → 只占**上半区**
 *  - 只有英文的孤行 → 只占**下半区**
 * 于是孤行不必另开轨道, 同时保留「中文在上、英文在下」的位置感。
 * 注意: 半区必须按轨道**实际高度**对半分 —— 合并轨会撑满整个面板(实测 177px),
 * 若沿用常量 LANE_H(34) 会把"下半区"画到 y+44(轨道 1/4 处), 看起来仍贴在顶上。
 */
function bandOf(cue, laneTop, laneH) {
  if (cue.half === 'top' || cue.half === 'bottom') {
    const pad = 4, gap = 6;
    const h = Math.max(LANE_H - 8, Math.round((laneH - pad * 2 - gap) / 2));
    if (cue.half === 'top') return { y: laneTop + pad, h };
    return { y: laneTop + pad + h + gap, h };
  }
  return { y: laneTop + 4, h: laneH - 8 };
}

/** 半区块"缺的那一半"的位置(单语行画虚线空槽用) */
function otherBandOf(cue, laneTop, laneH) {
  return bandOf({ half: cue.half === 'top' ? 'bottom' : 'top' }, laneTop, laneH);
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
    /* 主题色：游标 / 选中环 / 波形都跟着界面主题走。
       换色时 accent.js 派发 ss-accent 事件（canvas 里读不到 CSS 变量，只能缓存一份）。 */
    this.accent = cssVar('--accent', C.accent);
    try { window.addEventListener('ss-accent', () => { this.accent = cssVar('--accent', C.accent); this._dirty = true; }); } catch {}
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
    this.peaks = null;        // 峰值包络 {data: Uint8Array, rate, ch} —— 优先用它绘制(任意缩放都锐利)
    this._waveCache = null;   // 逐列 min/max 包络缓存(按 viewStart/pxPerSec/W 失效)
    this.showFilm = false;    // 胶片预览图(视频缩略图条): 设置里可开关, 默认关
    this.onWordRetime = null; // 拖动英文逐词开始标记 → (ref, idx, time, done)
    this.onBeforeWordDrag = null; // 命中拖柄后、建立拖动状态前同步提交文本草稿
    this._wordDrag = null;    // 正在拖的逐词标记 {cue, idx}
    this._selCueRef = null;
    this.subStart = 0;        // 字幕内容范围(第一块开始 ~ 最后一块结束): 仅当视频时长未知/更短时兜底
    this.subEnd = 0;
    this.onSeek = null;
    this.onRetime = null;
    this.onSelect = null;
    this.onCreate = null;     // 空白处拖动新建: (start, end)
    this.onDelete = null;     // 右键菜单删除: (ref)
    this.onToggleKaraokeStyle = null; // 右键菜单 → 整轨切换 颜色高亮 ↔ \k 卡拉OK: (ref)
    this.kStyleLabel = null;  // 菜单文案提供者: () => '切换为 \k 卡拉OK' | '切回颜色高亮'
    this.isEditable = null;
    this._drag = null;
    this._filmRotate = 0;
    this._viewReady = false;      // 是否已按"默认跨度"摆好视图
    this._viewFromLanes = false;  // 默认视图是否已按真实字幕范围算过
    this._menuCue = null;
    this.rangeSel = null;         // 批量选区: null | {a, b}(秒, a<=b) —— Ctrl+左键在轨道上拖动框出
    this._rangeDragging = false;  // 选区是否还在拖(拖动中不弹操作浮条)
    // 重新识别后台任务的**常驻**区域: {a, b, status, progress, message}
    // 与 rangeSel 互相独立 —— 点别处/播放/编辑其它字幕都不会清掉它, 任务结束才由 main.js 摘除
    this.reRecogRegion = null;
    this.onRangeSelect = null;    // 选区变化回调(拖完 / 清除时触发) → 刷新浮条
    this.onLayout = null;         // 平移/缩放/resize 回调 → 浮条跟着选区重新定位
    // 空闲降耗(见 drawIfNeeded): 脏标记 + 上次实际绘制时刻。
    // 交互/数据/布局任何会改变画面的地方都要置脏; 2s 心跳兜底, 防漏标导致画面永久过期。
    this._dirty = true;
    this._lastDrawAt = 0;

    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
  }

  setVideo(video) { this.video = video; this.film.reset(video); this._dirty = true; }

  /** 波形图(整段视频一张 PNG); 传空清除 */
  setWaveform(url) {
    this._dirty = true;
    this.waveform = null;
    this.waveformReady = false;
    if (!url) return;
    const img = new Image();
    img.onload = () => { this.waveform = img; this.waveformReady = true; this._dirty = true; };
    img.src = url;
  }

  /** 峰值包络数据。rate = 每秒包络个数; data = Uint8Array。
   *
   *  两种格式(按顺序自动判定, 调用方不必关心):
   *   · 双通道(新, PEAK_VER=2): 每桶 2 字节 [min, max], 带符号, 128=零位
   *     → 画真正的 min/max 包络, 保留波形上下不对称
   *   · 单通道(旧, PEAK_VER=1): 每桶 1 字节 abs 峰值
   *     → 只能画上下对称的"条形图"。旧数据已被固定增益削顶, 建议重算。
   *
   *  通道数无法只靠长度判定(单通道字节数恰好是双通道桶数的 2 倍),
   *  所以由调用方通过 ch 明确告知; 缺省按 ch=2 之外再按偶数兜底。
   */
  setPeaks(peaks) {
    this._dirty = true;
    if (!peaks || !peaks.data || !peaks.data.length) { this.peaks = null; return; }
    const ch = peaks.ch || 2;
    this.peaks = { data: peaks.data, rate: peaks.rate || 100, ch };
    this._waveCache = null;      // 数据换了 → 之前按列算好的包络作废
  }

  setLanes(lanes) {
    this._dirty = true;
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
    this._dirty = true;
    const prev = this.duration;
    this.duration = d || 0;
    if (!this._viewReady || Math.abs(this.duration - prev) > 0.05) this._applyDefaultView();
  }

  setSelected(ref) { this.selected = ref; this._dirty = true; }

  _notifyRange() { if (this.onRangeSelect) this.onRangeSelect(this.rangeSel); }

  /** 取消批量选区(点别处 / 删除完 / 换文件时调用) */
  clearRangeSel() {
    this._dirty = true;
    this._rangeDragging = false;
    if (!this.rangeSel) return;
    this.rangeSel = null;
    this._notifyRange();
  }

  /** 载入新字幕/视频时调用: 下一次 setLanes/setDuration 会重新按默认跨度定位 */
  resetView() {
    this._dirty = true;
    this._viewReady = false;
    this._viewFromLanes = false;
    this.subStart = 0;
    this.subEnd = 0;
    this._hideMenu();
  }

  /** 字幕内容范围(第一块开始 ~ 最后一块结束): 只在视频时长未知/比字幕短时兜底 */
  _refreshRange() {
    let a = Infinity, b = -Infinity;
    for (const lane of this.lanes) {
      for (const c of lane.cues) { if (c.start < a) a = c.start; if (c.end > b) b = c.end; }
    }
    if (!isFinite(a) || !(b > a)) { this.subStart = 0; this.subEnd = 0; return false; }
    this.subStart = a; this.subEnd = b;
    return true;
  }

  /**
   * 视图可用范围 = **视频的跨度**（0 ~ 视频时长），而不是字幕的首末。
   * 为什么：视频第 0 秒常常没人说话（开场、环境音），若按字幕首末来定跨度，时间轴就会
   * 直接从第一句开始（"4 秒才说话 → 时间轴从 4 秒开始"），用户既看不到前面那段空白、
   * 也没法在那儿新建字幕。用户明确要求：**时间轴跨度是视频开始与结束**。
   * 视频时长未知（或比字幕短）时用字幕结束时间兜底，保证不裁掉任何字幕。
   */
  _contentRange() {
    const end = Math.max(this.duration || 0, this.subEnd || 0);
    if (!(end > 0)) return null;
    return { a: 0, b: end, span: end };
  }

  /** 缩放上下限: 拉到最远时视图恰好覆盖整段视频(不再超出视频), 推近约到 0.4 秒铺满 */
  _zoomLimits() {
    const w = Math.max(1, this._cssW());
    const r = this._contentRange();
    const maxSpan = r ? Math.max(0.5, r.span) : Math.max(DEFAULT_SPAN, this.duration || DEFAULT_SPAN);
    const min = w / maxSpan;
    return { min, max: Math.max(w / 0.4, min) };
  }

  /** 默认视图: 跨度 = min(30s, 视频时长), 起点固定在 0(视频开头) */
  _applyDefaultView() {
    const r = this._contentRange();
    const w = this._cssW();
    if (!r || w <= 0) return;
    this.pxPerSec = w / Math.max(0.2, Math.min(DEFAULT_SPAN, r.span));
    this.viewStart = r.a;
    this._clampView();
    this._viewReady = true;
  }

  /** 适配: 视图正好铺满整段视频(即缩放到最远) */
  fit() {
    const r = this._contentRange();
    const w = this._cssW();
    if (!r || w <= 0) return;
    this.pxPerSec = w / Math.max(0.2, r.span);
    this.viewStart = r.a;
    this._clampView();
    this._viewReady = true;
  }
  zoomIn() { this._zoomAtSmooth(this._cssW() / 2, 1.6); }
  zoomOut() { this._zoomAtSmooth(this._cssW() / 2, 1 / 1.6); }

  /** 胶片预览图高度: 关闭时为 0(不占位, 字幕块直接顶到刻度线下方) */
  /** 字幕轨的**最低**高度: 低于此值字幕块就画不出来了(块内要放中英两行 + 逐词轴)。
   *  波形带再怎么挤也不能侵占它 —— 字幕块消失是比波形难看严重得多的回归。 */
  _laneMinH() { return 24; }

  /** 波形带高度: **拉伸填满**「刻度线以下、面板底部以上」的全部空间。
   *
   *  为什么拉伸而不是固定值: 面板高度可由用户拖动(见 main.js TLH_MIN/TLH_MAX), 若波形用固定高度,
   *  面板一高波形只占中间一条、**下方留出大片空白**(实测封顶 200px 时面板 420px 会空 194px),
   *  视觉上恰恰是"波形没填满"。拉伸后波形与字幕块**共用**同一块纵向空间, 任何面板高度下关系都不变。
   *
   *  不设上限: 面板高度本身已被 TLH_MAX(≤420px) 限制, 波形跟着铺满即可;
   *  真要再高, 胶片条的自动收起会先让出空间。
   *  WAVE_MIN: 低于此值就不画波形 —— 太空扁的包络看不出内容, 不如把空间全给字幕块。 */
  _waveH() {
    if (!this.peaks || !this.peaks.data.length) return 0;
    const avail = this._cssH() - this._lanesTop() - WAVE_BOTTOM_PAD;
    return avail >= WAVE_MIN ? avail : 0;
  }

  /** 胶片条高度: 空间不足时**自动收起**(省 46px 给波形带/字幕轨)—— 浅窗口/矮时间轴也不会挤爆。
   *  收起只是"这一帧不画", 设置里的开关不动, 空间够了自动回来。
   *  判据里用 WAVE_FILL 而非实际波形高: 保守一点, 宁可早收胶片也别让内容挤到面板外。 */
  _filmH() {
    if (!this.showFilm) return 0;
    const need = FILM_H + RULER_H + 6 + WAVE_FILL + LANE_H * 2;
    return this._cssH() >= need ? FILM_H : 0;
  }

  _cssW() { return this.canvas.parentElement.clientWidth; }
  _cssH() { return this.canvas.parentElement.clientHeight; }
  /** 合并轨(主轨)动态填满画布剩余高度 → 字幕块一直顶到面板底端, 不留黑缺。
   *  双行字幕轨模式会有**多条**合并轨(需要几条给几条, 见 main.js packTracks):
   *  剩余高度在它们之间平分 —— 不设大下限, 保证再挤也全部装得下、不会漏到面板外面。
   *  单条时行为与以前完全一致。 */
  _laneH(i) {
    const lanes = this.lanes || [];
    const n = Math.max(1, lanes.length);
    const avail = Math.max(10, this._cssH() - this._lanesTop() - (n - 1) * LANE_GAP);
    const ideal = (l) => (l && l.merged) ? (LANE_H * 2 + LANE_GAP) : ((l && l.h) || LANE_H);
    const sumIdeal = lanes.reduce((sum, l) => sum + ideal(l), 0) || 1;
    const lane = lanes[i];
    const want = ideal(lane);
    // ① 装不下 → 按理想高度**等比压缩**（下限 10px）。这样再矮的时间轴也是"整条轨都在面板里"，
    //    而不是把下面那半截画到面板外面去（用户报的"时间轴太矮直接显示不全"就是这个）。
    if (sumIdeal > avail) return Math.max(10, Math.floor(avail * want / sumIdeal));
    // ② 装得下 → 合并轨继续"吃掉剩余高度"（保持原有观感：块一直顶到面板底端，不留黑缺）
    if (lane && lane.merged) {
      const merged = lanes.filter(l => l && l.merged);
      const others = lanes.reduce((sum, l) => sum + (l && l.merged ? 0 : ideal(l)), 0);
      const rest = Math.max(10, avail - others);
      const minOne = merged.length === 1 ? LANE_H * 2 + LANE_GAP : 10;
      return Math.max(minOne, Math.floor(rest / Math.max(1, merged.length)));
    }
    return want;
  }

  /** 只读诊断(给 tools/layout_probe.mjs 用): 轨的几何, 用来断言"整条轨都在面板内" */
  debugLayout() {
    const n = (this.lanes || []).length;
    return {
      cssH: this._cssH(), filmH: this._filmH(), rulerH: RULER_H,
      waveH: this._waveH(), lanesTop: this._lanesTop(),   // 波形带高度与轨道区起点
      laneTop: n ? this._laneTop(0) : 0, laneH: n ? this._laneH(0) : 0,
      laneBottom: this._lanesBottom(), fits: this._lanesBottom() <= this._cssH() + 0.5,
    };
  }

  _resize() {
    this._dirty = true;      // 画布被重新分配(width/height 赋值即清空) → 必须重绘
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
    if (this.onLayout) this.onLayout();
  }

  _zoomAt(px, factor) {
    const lim = this._zoomLimits();
    const next = Math.max(lim.min, Math.min(lim.max, this.pxPerSec * factor));
    if (!isFinite(next) || Math.abs(next - this.pxPerSec) < 1e-9) return false;
    this._dirty = true;
    const t = this.viewStart + px / this.pxPerSec;
    this.pxPerSec = next;
    this.viewStart = t - px / this.pxPerSec;
    this._clampView();
    this._viewReady = true;
    if (this.onLayout) this.onLayout();
    return true;
  }

  /** 缩放（带缓动）：约 160ms 内把倍率补间到目标值，**光标下的时间保持不动**（跟手）。
   *  连续滚轮会从"当前值"重新起步（不是排队), 所以手感是顺滑而不是卡顿。
   *  Ctrl+滚轮 / 工具栏 ± / 快捷键都走这里；prefers-reduced-motion 时退化为瞬时。 */
  _zoomAtSmooth(px, factor) {
    const lim = this._zoomLimits();
    const target = Math.max(lim.min, Math.min(lim.max, this.pxPerSec * factor));
    if (!isFinite(target) || Math.abs(target - this.pxPerSec) < 1e-9) return false;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this._zoomAnim) { cancelAnimationFrame(this._zoomAnim); this._zoomAnim = 0; }
    if (reduced) return this._zoomAt(px, factor);
    const from = this.pxPerSec;
    const tUnder = this.viewStart + px / this.pxPerSec;      // 光标下的时间
    const t0 = performance.now();
    const DUR = 160;
    const self = this;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / DUR);
      const e = 1 - Math.pow(1 - k, 3);                      // easeOutCubic
      self.pxPerSec = from + (target - from) * e;
      self.viewStart = tUnder - px / self.pxPerSec;
      self._dirty = true;                                    // 动画期间每帧都要重绘
      self._clampView();
      self._viewReady = true;
      if (self.onLayout) self.onLayout();
      self._zoomAnim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    this._zoomAnim = requestAnimationFrame(step);
    return true;
  }
  /** 平移: 正数 = 往时间更晚的方向看 */
  _panBy(px) {
    this._dirty = true;
    this.viewStart += px / this.pxPerSec;
    this._clampView();
    this._viewReady = true;
    if (this.onLayout) this.onLayout();
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

  /** 所有轨道内容的起始 y(胶片 + 刻度之下)。
   *  字幕轨与波形带**故意重叠**: 波形铺满整条带, 字幕块半透明叠在它上面,
   *  块间缝隙露出波形 —— 这样纵向空间共用, 既不会把波形挤扁, 也不会多占一整条轨。
   *  (曾改成"波形独立成带、轨道在下", 结果两者上下分离, 既多占高度又看不到叠加关系。) */
  _lanesTop() { return this._filmH() + RULER_H + 6; }

  _laneTop(i) {
    let y = this._lanesTop();
    for (let k = 0; k < i; k++) y += this._laneH(k) + LANE_GAP;
    return y;
  }
  _lanesBottom() {
    const n = this.lanes.length;
    return n ? this._laneTop(n - 1) + this._laneH(n - 1) : this._lanesTop();
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
      else if (act === 'fix' && cue && this.onFix) this.onFix(cue.ref);
      else if (act === 'retranslate' && cue && this.onRetranslate) this.onRetranslate(cue.ref);
      else if (act === 'karaoke-style' && cue && this.onToggleKaraokeStyle) this.onToggleKaraokeStyle(cue.ref);
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
      if (e.ctrlKey || e.metaKey) this._zoomAtSmooth(e.offsetX, dir > 0 ? this.zoomSensitivity : 1 / this.zoomSensitivity);
      else this._panBy(dir * this.panSensitivity);   // 下滚 dir=-1 → 负 → 看更早
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;               // 右键交给 contextmenu
      this._dirty = true;                       // 按下即重绘: 选中/菜单状态可能变化
      this._hideMenu();
      this._hideEdgeHint();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无捕获 */ }
      const x = e.offsetX, y = e.offsetY;
      const onLane = this._laneIndexAtY(y) !== -1;

      // Ctrl(或 Cmd)+左键在轨道上拖动 = **批量选区**(框出一段时间; 松手后出"批量删除"浮条)
      if ((e.ctrlKey || e.metaKey) && onLane) {
        const t = this._clampT(this.x2t(x));
        this.rangeSel = { a: t, b: t };
        this._rangeDragging = true;
        this._notifyRange();
        this._drag = { type: 'range', x0: x, y0: y, t0: t, moved: false };
        return;
      }
      // 普通点击 = 取消已有选区(用户要求: 选完不操作、点别处就取消)
      this.clearRangeSel();

      const hit = onLane ? this._hitTest(x, y, true) : null;

      // 优先: 拖英文逐词的开始标记(调整该词开始时间; 严格夹取, Shift 也不放宽)
      const wh = onLane ? this._hitWordHandle(x, y) : null;
      if (wh && (!this.isEditable || this.isEditable(wh.cue.ref))) {
        if (this.onBeforeWordDrag) this.onBeforeWordDrag(wh.cue.ref, wh.cue);
        if (!wh.cue.words || !wh.cue.words.length) return;
        const idx = Math.min(wh.idx, wh.cue.words.length - 1);
        this._selCueRef = wh.cue.row || wh.cue.ref;
        this._wordDrag = { cue: wh.cue.row || wh.cue.ref, ref: wh.cue.ref, idx };
        this._drag = { type: 'word', cue: wh.cue, idx, x0: x, y0: y, moved: false };
        if (this.onSelect) this.onSelect(wh.cue.ref, { seek: false });
        return;
      }

      if (hit && (!this.isEditable || this.isEditable(hit.cue.ref))) {
        const c = hit.cue;
        const csx = this.t2x(c.start), cex = this.t2x(c.end);
        let part = 'body';
        if (cex - csx >= 8) {
          if (Math.abs(x - csx) <= EDGE_TOL) part = 'left';
          else if (Math.abs(x - cex) <= EDGE_TOL) part = 'right';
        }
        // 边缘拖动按鼠标在块的上下半区分: 上半=整块边界(onRetime), 下半=首/末词细调(onWordRetime)
        if ((part === 'left' || part === 'right') && this.onWordRetime && c.words && c.words.length) {
          const li2 = this._laneIndexAtY(y);
          const yy2 = this._laneTop(li2), lh2 = this._laneH(li2);
          const band = c.half ? bandOf(c, yy2, lh2) : { y: yy2, h: lh2 };
          if (y >= band.y + band.h / 2) {
            if (this.onBeforeWordDrag) this.onBeforeWordDrag(c.ref, c);
            if (!c.words || !c.words.length) return;
            const idx = part === 'left' ? 0 : c.words.length - 1;
            this._selCueRef = c.row || c.ref;
            this._wordDrag = { cue: c.row || c.ref, ref: c.ref, idx };
            // 左边缘=调首词开始(块起始同步); 右边缘=调末词**结束**(块 end 同步延伸)
            const nb = this._neighbors(c);
            this._drag = { type: 'word', cue: c, idx, x0: x, y0: y, moved: false,
              edge: part === 'left' ? 'start' : 'end',
              loLimit: part === 'left' ? nb.prevEnd : null,
              hiLimit: part === 'left' ? null : nb.nextStart };
            if (this.onSelect) this.onSelect(c.ref, { seek: false });
            return;
          }
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
      if (this._drag) this._dirty = true;       // 拖动中块/选区/预览每帧要跟着走; 普通悬停只改光标, 不必重绘
      if (!this._drag) {
        let cursor = 'default';
        if (this._laneIndexAtY(y) !== -1) {
          const wh0 = this._hitWordHandle(x, y);
          if (wh0 && (!this.isEditable || this.isEditable(wh0.cue.ref))) {
            cv.style.cursor = 'ew-resize'; this._hideEdgeHint(); return;
          }
          const hit = this._hitTest(x, y, true);
          if (hit && (!this.isEditable || this.isEditable(hit.cue.ref))) {
            const c = hit.cue;
            const csx = this.t2x(c.start), cex = this.t2x(c.end);
            const onL = cex - csx >= 8 && Math.abs(x - csx) <= EDGE_TOL;
            const onR = cex - csx >= 8 && Math.abs(x - cex) <= EDGE_TOL;
            if (onL || onR) {
              cv.style.cursor = 'ew-resize';
              // 悬停提示: 上半=整体边界 / 下半=首末词边界
              const li2 = this._laneIndexAtY(y);
              const yy2 = this._laneTop(li2), lh2 = this._laneH(li2);
              const band = c.half ? bandOf(c, yy2, lh2) : { y: yy2, h: lh2 };
              const lower = y >= band.y + band.h / 2;
              const text = onL
                ? (lower ? '拖动：只改第一个词的开头' : '拖动：改整块开始时间')
                : (lower ? '拖动：只改最后一个词的结尾' : '拖动：改整块结束时间');
              this._showEdgeHint(e.clientX, e.clientY, text);
              return;
            }
            this._hideEdgeHint();
            cursor = 'move';
          } else { this._hideEdgeHint(); cursor = 'crosshair'; }
        } else {
          this._hideEdgeHint();
        }
        cv.style.cursor = cursor;
        return;
      }
      const d = this._drag;
      if (!d.moved && Math.abs(x - d.x0) < DRAG_THRESH && Math.abs(y - d.y0) < DRAG_THRESH) return;
      d.moved = true;

      if (d.type === 'word') {
        d.lastT = this.x2t(x);
        if (this.onWordRetime) this.onWordRetime(d.cue.ref, d.idx, d.lastT, false, d.edge, d.hiLimit, d.loLimit);
        if (d.edge === 'end') d.cue.end = this.x2t(x);                     // 拖动中块宽度实时跟随(松手 rebuild 校正)
        else if (d.edge === 'start' && d.idx === 0) d.cue.start = this.x2t(x);
        return;
      }
      if (d.type === 'range') {
        const t = this._clampT(this.x2t(x));
        this.rangeSel = { a: Math.min(d.t0, t), b: Math.max(d.t0, t) };
        return;
      }
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
      this._dirty = true;                       // 松手后重建前先重绘一帧(拖到一半的状态立即收尾)
      if (!d) return;
      const t = this._clampT(this.x2t(e.offsetX));
      if (d.type === 'word') {
        if (this.onWordRetime) this.onWordRetime(d.cue.ref, d.idx, this.x2t(e.offsetX), true, d.edge, d.hiLimit, d.loLimit);
        this._wordDrag = null;
        return;
      }
      if (d.type === 'range') {
        const t = this._clampT(this.x2t(e.offsetX));
        const a = Math.min(d.t0, t), b = Math.max(d.t0, t);
        this._rangeDragging = false;
        // 太窄(基本等于单击) → 不当选区, 也不弹浮条
        this.rangeSel = (this.t2x(b) - this.t2x(a) < 8) ? null : { a, b };
        this._notifyRange();
        return;
      }
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
    cv.addEventListener('pointerleave', () => this._hideEdgeHint());
    cv.addEventListener('pointercancel', () => {
      const d = this._drag;
      this._drag = null;
      if (d && d.type === 'word' && d.moved && this.onWordRetime) {
        this.onWordRetime(d.cue.ref, d.idx, d.lastT, true, d.edge, d.hiLimit, d.loLimit);
      }
      this._wordDrag = null;
    });

    // 点画布/菜单以外的地方 → 收起菜单
    document.addEventListener('pointerdown', (e) => {
      if (!this.menuEl || this.menuEl.hidden) return;
      if (this.menuEl.contains(e.target) || e.target === cv) return;
      this._hideMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._hideMenu(); });
  }

  /** 边缘悬停提示: 跟随鼠标的小浮层(告诉用户当前拖的是整体边界还是首末词边界) */
  _showEdgeHint(cx, cy, text) {
    if (!this._hintEl) {
      this._hintEl = document.createElement('div');
      this._hintEl.className = 'tl-edge-hint';
      document.body.appendChild(this._hintEl);
    }
    this._hintEl.textContent = text;
    this._hintEl.hidden = false;
    this._hintEl.style.left = (cx + 14) + 'px';
    this._hintEl.style.top = (cy + 16) + 'px';
  }
  _hideEdgeHint() {
    if (this._hintEl && !this._hintEl.hidden) this._hintEl.hidden = true;
  }

  _showMenu(cx, cy, cue) {
    const el = this.menuEl;
    if (!el) return;
    this._menuCue = cue;
    // 整轨形态切换的文案随当前形态变（只改内层 span —— 图标是插进来的 SVG, 不能 textContent）
    const span = el.querySelector('[data-kstyle-label]');
    if (span && this.kStyleLabel) span.textContent = this.kStyleLabel();
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
  /** 拖动夹取用的前后邻居。只在**本轨内**找: 双行字幕轨模式下不同轨的块本来就允许
   *  时间重叠(那正是分轨的目的), 拿别的轨去夹会把块卡住。单轨时与以前完全等价。 */
  _neighbors(cue) {
    let prevEnd = 0, nextStart = Infinity;
    for (const lane of this.lanes) {
      if (!lane.cues.includes(cue)) continue;
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
  /** 外部直接改了会被绘制的状态(如 main.js 的 reRecogRegion/showFilm)时调用 —— 手动置脏 */
  touch() { this._dirty = true; }

  /** 空闲降耗版 draw: 播放中 / 有脏标记 / 播放头动过 / 2s 心跳兜底 才真正重绘。
   *  draw() 是全量重绘(清屏 + 标尺/波形/胶片/可见块文字度量), 暂停静止时每帧重绘纯属浪费;
   *  心跳是安全网: 万一有哪处状态变更漏标脏, 画面最多过期 2 秒, 不会永久错。 */
  drawIfNeeded(t, playing) {
    const now = performance.now();
    if (playing || this._dirty || t !== this._lastT || now - this._lastDrawAt > 2000) {
      return this.draw(t, playing);
    }
  }

  draw(t, playing) {
    this._dirty = false;
    this._lastDrawAt = performance.now();
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
      ctx.fillText('打开视频后，这里显示时间轴', W / 2, H / 2);
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

    if (this._filmH() > 0) this._drawFilmstrip(ctx, W);   // 空间不够时 _filmH()=0, 这一帧不画
    this._drawRuler(ctx, W);
    this._drawWaveBand(ctx, W);
    this._drawLanes(ctx, W, t);
    if (this._drag && this._drag.type === 'create' && this._drag.moved) this._drawCreatePreview(ctx);
    if (this.rangeSel && this.rangeSel.b > this.rangeSel.a) this._drawRangeSel(ctx);
    if (this.reRecogRegion) this._drawReRecog(ctx, W);
    this._drawPlayhead(ctx, H, t);
  }

  /** 批量选区(Ctrl+左键拖动): 盖住整条轨道高度的半透明色块 + 虚线边 + 时间范围标签。
   *  色块叠在字幕块之上, 框内的块自然被"洗"上一层暖色, 一眼看出哪些会被批量删除。 */
  _drawRangeSel(ctx) {
    const x1 = this.t2x(this.rangeSel.a), x2 = this.t2x(this.rangeSel.b);
    const W = this._cssW();
    const top = this._laneTop(0) - 3;
    const bottom = Math.min(this._cssH() - 1, this._lanesBottom() + 3);
    const cx1 = Math.max(-1, x1), cx2 = Math.min(W + 1, x2);
    const w = Math.max(0.5, cx2 - cx1);
    ctx.save();
    ctx.fillStyle = 'rgba(255,122,69,.13)';
    ctx.fillRect(cx1, top, w, bottom - top);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(cx1) + 0.5, top);
    ctx.lineTo(Math.round(cx1) + 0.5, bottom);
    ctx.moveTo(Math.round(cx2) + 0.5, top);
    ctx.lineTo(Math.round(cx2) + 0.5, bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx1, Math.round(top) + 0.5); ctx.lineTo(cx2, Math.round(top) + 0.5);
    ctx.moveTo(cx1, Math.round(bottom) - 0.5); ctx.lineTo(cx2, Math.round(bottom) - 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    // 拖动中在选区左上角提示当前范围(此时浮条还没出来, 不会互相遮);
    // 松手后右上角浮条已显示条数, 这里就不画了, 精确时间范围放进浮条的 tooltip
    if (!this._rangeDragging) { ctx.restore(); return; }
    const label = `框选中 ${fmtTime(this.rangeSel.a)} → ${fmtTime(this.rangeSel.b)}`;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    const tw = ctx.measureText(label).width;
    if (w > tw + 16) {
      ctx.fillStyle = 'rgba(255,122,69,.92)';
      const lx = cx1 + 4, ly = top + 4;
      this._roundRect(ctx, lx, ly, tw + 8, 14, 3);
      ctx.fill();
      ctx.fillStyle = '#22150e';
      ctx.fillText(label, lx + 4, ly + 10);
    }
    ctx.restore();
  }

  /** 空白处拖动新建时的虚线预览框 */
  _drawCreatePreview(ctx) {
    const d = this._drag;
    const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
    const x1 = this.t2x(a), x2 = this.t2x(b);
    const top = this._lanesTop();
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

  /** 重新识别后台任务的常驻区域: 紫色带 + 顶部标签(标题/进度 + 当前阶段)。
   *  独立于批量选区 —— 点别处/播放/编辑其它字幕都不影响, 任务结束由 main.js 摘除。 */
  _drawReRecog(ctx, W) {
    const r = this.reRecogRegion;
    if (!r || !(r.b > r.a)) return;
    const col = r.status === 'error' ? '#ff5f6b' : '#a78bfa';          // 紫: 与选区橙区分
    const fill = r.status === 'error' ? 'rgba(255,95,107,.13)' : 'rgba(139,92,246,.15)';
    const top = this._laneTop(0) - 3;
    const bottom = Math.min(this._cssH() - 1, this._lanesBottom() + 3);
    const cx1 = Math.max(-1, this.t2x(r.a)), cx2 = Math.min(W + 1, this.t2x(r.b));
    if (cx2 <= 0 || cx1 >= W) return;                                   // 整段在视野外
    ctx.save();
    ctx.fillStyle = fill;
    ctx.fillRect(cx1, top, cx2 - cx1, bottom - top);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.round(cx1) + 0.5, Math.round(top) + 0.5,
      Math.max(1, Math.round(cx2 - cx1) - 1), Math.max(1, Math.round(bottom - top) - 1));
    // 标签: 顶部两行(标题+当前阶段), 横向夹在视野内(区域可能一半在屏幕外)
    const pct = (r.progress == null ? '' : ' ' + r.progress + '%');
    const title = (r.status === 'error' ? '重新识别失败' : '重新识别处理中') + pct;
    const msg = String(r.message || '').slice(0, 46);
    ctx.font = 'bold 10px Consolas, monospace';
    const tw = Math.max(ctx.measureText(title).width, ctx.measureText(msg).width) + 12;
    const lx = Math.max(2, Math.min(cx1 + 4, W - tw - 2));
    const ly = top + 5;
    ctx.fillStyle = 'rgba(24,17,40,.93)';
    this._roundRect(ctx, lx, ly, tw, 27, 4);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = r.status === 'error' ? '#ffb3b8' : '#ddd6fe';
    ctx.fillText(title, lx + 6, ly + 11);
    if (msg) {
      ctx.fillStyle = 'rgba(196,181,253,.85)';
      ctx.font = '9px Consolas, monospace';
      ctx.fillText(msg, lx + 6, ly + 22);
    }
    ctx.restore();
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
    const g = ctx.createLinearGradient(0, top, 0, top + RULER_H);
    g.addColorStop(0, '#16161c');
    g.addColorStop(1, '#101015');
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, RULER_H);
    ctx.strokeStyle = C.laneBorder;
    ctx.beginPath(); ctx.moveTo(0, top + RULER_H + 0.5); ctx.lineTo(W, top + RULER_H + 0.5); ctx.stroke();

    const step = this._niceStep(80);
    const t0 = Math.max(0, Math.floor(this.viewStart / step) * step);
    const sub = step / 5;                       // 次刻度: 主刻度之间再分 5 格, 读数更好对位
    const end = this.viewStart + W / this.pxPerSec + step;
    ctx.strokeStyle = C.rulerTick;
    ctx.beginPath();
    for (let st = t0; st <= end; st += sub) {
      const x = Math.round(this.t2x(st)) + 0.5;
      if (x < 0 || x > W) continue;
      const major = Math.abs(st / step - Math.round(st / step)) < 1e-6;
      ctx.moveTo(x, top + RULER_H - (major ? 7 : 3));
      ctx.lineTo(x, top + RULER_H);
    }
    ctx.stroke();
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'left';
    for (let tt = t0; tt <= end; tt += step) {
      const x = Math.round(this.t2x(tt)) + 0.5;
      if (x < -60 || x > W + 10) continue;
      ctx.fillStyle = C.ruler;
      ctx.fillText(fmtTime(tt, 1).replace(/\.0\$/, ''), x + 4, top + RULER_H - 8);
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

  /**
   * 块内纵向几何。
   *
   * 逐词标记块**贴块底**（不再骑在中英分隔线上）:
   *   标记底 = 块底 − 2px —— "基本贴底", 但那 2px 缺口是刻意的:
   *   贴到 0 会让标记与块的下边框糊成一条, 看着像"顶到边"。
   * 标记与英文词文本因此落在同一行, 一眼能对上是哪个词的抓手。
   *
   * 分隔线仍是中英分界, 观感上在块高中部(AXIS_R)。但它是**夹**在
   * 中文行与标记行之间的, 不是固定比例 —— 矮轨/单语半区上按需让位,
   * 保证"中文 < 分隔线 < 标记"三者互不压。
   */
  _wordGeom(band) {
    /* 逐词标记块(拖动抓手): 目标 20×8(拖动中宽 10), 底部留 5px 不贴块边框。
     *  比原来(10×4)大一倍 —— 小块在密集词里太难点中。
     *
     *  高度**按可用空间自适应**: 块内要同时容纳「中文行 + 分隔线 + 标记」, 若块太矮
     *  (单语孤行/被压扁的矮轨, 实测 ≤39px), 无条件 20px 会让分隔线被标记压住。
     *  所以先给中文行与分隔线留够, 剩下的才给标记; 实在挤不下就压到最小 6px。
     *  宽度也不超过高度(极矮时不该是横条)。*/
    const MARK_H = 20, MARK_W = 8, MARK_W_HOT = 10, MARK_MIN_H = 6;
    const TOP_PAD = 1, GAP = 3;                                // GAP: 中文/分隔线/标记之间的最小间隙
    // 底部余量: 2.5px(贴底但仍留一线缝隙, 不与块边框粘连), 且**不能吃掉整块**
    // (实测块高 4px 时固定 5px 会让 markBot 跑到块顶之上、标记被画到块外)。
    // 所以按块高缩放, 最少留 1px。
    const BOT_PAD = Math.max(1, Math.min(2.5, band.h / 4));
    const zhBase = band.y + Math.round(band.h * 0.30);          // 与 _drawBlockText 的中文基线一致
    const markBot = band.y + band.h - BOT_PAD;                   // 贴底, 不碰块边框
    /* 优先级: **标记 > 分隔线**。标记是拖动抓手, 大一点才点得中; 分隔线只是装饰,
     * 挤不下就该让位。所以分隔线的上界由"给标记留够 MARK_H"决定, 而不是反过来。 */
    const axisLo = Math.min(zhBase + GAP, markBot - MARK_MIN_H);
    const axisHi = Math.max(axisLo, Math.min(zhBase + Math.round(band.h * 0.5), markBot - MARK_H - GAP));
    const axisY = Math.max(axisLo, Math.min(band.y + Math.round(band.h * AXIS_R), axisHi));
    // 标记顶: 紧跟分隔线(GAP), 并保证至少 MARK_MIN_H; 高度优先取满 MARK_H
    const markTop = Math.max(band.y + TOP_PAD, Math.min(axisY + GAP, markBot - MARK_MIN_H));
    const markH = Math.max(2, Math.min(MARK_H, markBot - markTop));
    const markW = Math.max(2, Math.min(MARK_W, markH));          // 极矮时别比高度还宽
    return {
      axisY, sepY: axisY, markTop, markBot, markH, markW, markWHot: MARK_W_HOT,
      top: markTop, bottom: markBot, baseline: band.y + band.h - 3,
    };
  }

  /** 块内文字: 中文整句在上(角色色/加粗), 中英之间是逐词轴, 轴下是英文逐词
   *  样式对齐参考图: 轴与标记用中性浅灰, 词文本浅色; 词太长/太挤则只留标记不画文字 */
  _drawBlockText(ctx, c, band, x1, x2, wpx, base) {
    const g = this._wordGeom(band);
    const words = (c.words && c.words.length) ? c.words : null;
    const showWords = !!(words && wpx / words.length > 8);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1 + TEXT_PAD, band.y, Math.max(1, wpx - TEXT_PAD * 2), band.h);
    ctx.clip();
    ctx.textAlign = 'left';
    if (c.text2) {
      ctx.fillStyle = base;                       // 中文行: 角色色 100% 不透明
      ctx.font = ZH_FONT;
      ctx.fillText(c.text2.slice(0, 60), x1 + TEXT_PAD, band.y + Math.round(band.h * 0.30));
      if (showWords) {
        this._drawWordAxis(ctx, words, g, x1, x2, c.end);
      } else {
        if (c.text) {
          ctx.strokeStyle = AXIS_COLOR;           // 中英分隔线(中性浅灰)
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1 + 4, g.axisY + 0.5);
          ctx.lineTo(x2 - 4, g.axisY + 0.5);
          ctx.stroke();
          ctx.fillStyle = WORD_TEXT;
          ctx.font = EN_FONT;
          ctx.fillText(c.text.slice(0, 60), x1 + TEXT_PAD, g.baseline);
        }
      }
    } else if (showWords) {
      this._drawWordAxis(ctx, words, g, x1, x2, c.end);   // 纯英文孤行
    } else {
      ctx.fillStyle = base;
      ctx.font = ZH_FONT;
      ctx.fillText((c.text || '').slice(0, 40), x1 + TEXT_PAD, band.y + band.h / 2 + 4);
    }
    ctx.restore();
  }

  /** 英文逐词轴: 一条中性轴的线 + 每个词一个标记块(可拖动, 词太长则只留标记) */
  _drawWordAxis(ctx, words, g, x1, x2, blockEnd) {
    const ax0 = Math.max(x1 + 4, 0), ax1 = Math.min(x2 - 4, this._cssW());
    ctx.strokeStyle = AXIS_COLOR;                   // 轴
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax0, g.axisY + 0.5);
    ctx.lineTo(ax1, g.axisY + 0.5);
    ctx.stroke();

    ctx.font = EN_FONT;
    ctx.textAlign = 'left';
    let lastRight = -Infinity;                      // 已画出去的文字右边界(避免相邻词压字)
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const wx = this.t2x(w.s);
      if (wx < x1 - 30 || wx > x2 + 30) continue;
      const hot = this._wordDrag && this._wordDrag.cue === this._selCueRef && this._wordDrag.idx === i;
      // 标记块(始终画, 拖动时的抓手) —— 贴块底, 与英文词文本同一行。
      // 以词起点 wx 为**中心**画(而不是左边), 变宽后仍与词对齐。
      ctx.fillStyle = hot ? WORD_MARK_HOT : WORD_MARK;
      const mw = hot ? g.markWHot : g.markW;
      ctx.fillRect(Math.round(wx - mw / 2), g.markTop, mw, g.markH);
      // 词文本: 放不下(下一个词太近 / 与上一个词文字相撞)就隐藏, 只留标记。
      // 起点随标记块半宽让位 —— 标记变宽后仍留 4px 间隙, 不压到字。
      const textX = Math.round(wx + g.markW / 2 + 4);
      const nextX = (i + 1 < words.length) ? this.t2x(words[i + 1].s) : Math.min(this.t2x(blockEnd), x2);
      const avail = nextX - textX - 3;
      const tw = ctx.measureText(w.w).width;
      if (textX >= lastRight + 2 && tw <= avail) {
        ctx.fillStyle = WORD_TEXT;
        ctx.fillText(w.w, textX, g.baseline);
        lastRight = textX + tw;
      }
    }
  }

  /** 命中某个英文词的开始标记(用于拖动逐词时间) */
  _hitWordHandle(x, y) {
    for (const lane of this.lanes) {
      const li = this.lanes.indexOf(lane);
      const yy = this._laneTop(li), lh = this._laneH(li);
      const t = this.x2t(x);
      for (const c of lane.cues) {
        if (!c.words || !c.words.length) continue;
        if (t < c.start - 1 || t > c.end + 1) continue;
        const band = bandOf(c, yy, lh);
        const g = this._wordGeom(band);
        // 标记贴块底 → 命中区也随之贴底; 再按 ±4 容差夹回块内,
        // 否则容差会溢出到块外, 抢走**下一条轨**同一时刻的点击。
        if (y < g.top - 4 || y > g.bottom + 4) continue;
        if (y < band.y || y > band.y + band.h) continue;
        const wpx = this.t2x(Math.min(c.end, this.viewStart + this._cssW() / this.pxPerSec)) - this.t2x(Math.max(c.start, this.viewStart));
        if (wpx / c.words.length <= 8) continue;
        for (let i = 0; i < c.words.length; i++) {
          const wx = this.t2x(c.words[i].s);
          // 命中半宽跟标记块一致(再加 2px 余量), 看得见的宽度就能点中
          if (Math.abs(x - wx) <= g.markW / 2 + 2) return { lane, cue: c, idx: i };
        }
      }
    }
    return null;
  }

  /** 波形带: 刻度线下方的一条独立横带, 横贯整个宽度, 下方留出到字幕轨的间距。
   *  与字幕块完全分离 —— 波形不再被字幕块压住, 纵向也有足够分辨率画出音节。 */
  /** 波形带: 铺满「刻度线以下」的区域, **字幕块半透明叠在它上面**(块间缝隙露出波形)。
   *  绘制顺序在 draw() 里: 先本方法(波形在下), 再 _drawLanes(字幕块在上)。 */
  _drawWaveBand(ctx, W) {
    const h = this._waveH();
    if (!h) return;
    const top = this._lanesTop();
    // 带底色(比轨道底略亮, 让波形所在区域一眼可辨)
    ctx.fillStyle = C.waveBg;
    ctx.fillRect(0, top, W, h);
    this._drawWaveLayer(ctx, W, top + 2, h - 4);
  }

  /** 逐像素列的 min/max 包络(双通道)。
   *  一次算完整条可见区, 结果按 (viewStart, pxPerSec, W) 缓存 —— 平移/缩放时才重算,
   *  拖动字幕块时每帧重画但不必重扫包络。 */
  _waveEnvelope(W) {
    const pk = this.peaks;
    if (!pk || !pk.data.length) return null;
    const key = this.viewStart.toFixed(3) + '|' + this.pxPerSec.toFixed(4) + '|' + W;
    if (this._waveCache && this._waveCache.key === key) return this._waveCache;

    const { data, rate, ch } = pk;
    const n = ch === 1 ? data.length : (data.length >> 1);
    const env = new Float32Array(W * 2);          // [min, max] 交错, 值域 −1..1
    for (let px = 0; px < W; px++) {
      let b0 = Math.floor(this.x2t(px) * rate);
      let b1 = Math.ceil(this.x2t(px + 1) * rate);
      if (b1 <= b0) b1 = b0 + 1;
      if (b0 < 0) b0 = 0;
      if (b1 > n) b1 = n;
      let lo = 0, hi = 0, got = false;
      if (b1 > b0) {
        // 一列覆盖的桶数可能上千(缩得很远), 超过 64 就等距抽样 —— 取最值不受抽样影响,
        // 但要覆盖**峰值**而不是平均, 否则缩远后波形会萎缩。
        const span = b1 - b0;
        const step = span > 64 ? Math.ceil(span / 64) : 1;
        for (let b = b0; b < b1; b += step) {
          let l, h;
          if (ch === 1) { const v = (data[b] || 0) / 255; l = -v; h = v; }
          else { l = (data[b * 2] - 128) / 127; h = (data[b * 2 + 1] - 128) / 127; }
          if (l < lo) lo = l;
          if (h > hi) hi = h;
          got = true;
        }
      }
      env[px * 2] = got ? lo : 0;
      env[px * 2 + 1] = got ? hi : 0;
    }
    this._waveCache = { key, env };
    return this._waveCache;
  }

  /** 波形层: 铺满给定区域。
   *  走 min/max 包络 + 一次 path 填充整条带 —— 上下不对称, 保留真实形态。
   *  (旧实现每列画一个上下对称的 fillRect 且 30% 透明, 画出来是"条形图"且几乎看不见) */
  _drawWaveLayer(ctx, W, top, h) {
    if (!(this.duration > 0) || h <= 2) return;
    const cache = this._waveEnvelope(W);
    if (cache) {
      const cy = top + h / 2, half = h / 2;
      const env = cache.env;
      ctx.save();
      // 上下对称各留 1px 内缩, 中轴线才不会被波形糊住
      const s = half - 1;
      ctx.beginPath();
      ctx.moveTo(0, cy);
      let started = false, lastX = 0;
      for (let px = 0; px < W; px++) {
        const y = cy - env[px * 2 + 1] * s;
        if (!started) { ctx.lineTo(px, y); started = true; } else ctx.lineTo(px, y);
        lastX = px;
      }
      ctx.lineTo(lastX, cy);
      for (let px = lastX; px >= 0; px--) ctx.lineTo(px, cy - env[px * 2] * s);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, top + h);
      g.addColorStop(0, 'rgba(190,190,205,.85)');
      g.addColorStop(0.5, 'rgba(228,228,240,.95)');
      g.addColorStop(1, 'rgba(190,190,205,.85)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
    } else if (this.waveformReady && this.waveform) {
      const img = this.waveform;
      const span = W / this.pxPerSec;
      const sx = (this.viewStart / this.duration) * img.width;
      const sw = (span / this.duration) * img.width;
      ctx.save();
      ctx.globalAlpha = 0.55;
      if (sw > 0) ctx.drawImage(img, sx, 0, sw, img.height, 0, top, W, h);
      ctx.restore();
    }
  }

  _drawLanes(ctx, W, t) {
    this.lanes.forEach((lane, li) => {
      const yy = this._laneTop(li);
      const lh = this._laneH(li);
      // 轨道底**只在没有波形时**才铺不透明底色: 波形与轨道重叠, 用不透明底会把波形盖死,
      // 字幕块就"贴"不到波形上了(块间缝隙也看不到波形)。
      if (!this._waveH()) {
        ctx.fillStyle = C.laneBg;
        ctx.fillRect(0, yy, W, lh);
      }
      ctx.strokeStyle = C.laneBorder;
      ctx.beginPath(); ctx.moveTo(0, yy + lh + 0.5); ctx.lineTo(W, yy + lh + 0.5); ctx.stroke();

      // 波形由 _drawWaveBand 统一画在下面(只画一次), 不再每轨重画。

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

        // 单语孤行: **有内容的那半画成实心块**(干净的整块边界), **缺的那半画虚线空槽**。
        //   · 只有该行真的没有另一种语言才画空槽(中英都在、只是起止不同则不画, 免得两半互相叠出噪声);
        //   · 空槽用坏行红(单语行必然记坏行) → "红虚线 = 缺另一半" 一眼可读, 且不再糊住实心块。
        const lacks = c.half ? (c.half === 'top' ? !(c.row && c.row.en) : !(c.row && c.row.zh)) : false;
        if (lacks) this._drawEmptyHalf(ctx, x1, otherBandOf(c, yy, lh), wpx, !!c.bad);

        // 说话人颜色优先(半透明底), 否则用轨道色
        const base = c.color || lane.color;
        const isSel = this.selected && c.row === this.selected;
        // 下面两个是「播放头所在块高亮」功能预留的变量, 目前绘制逻辑还没用上。
        // textColor 由 textOnTranslucent() 算出, 若要接上: 把字幕块文本的 fillStyle
        // 从 C.chipText 换成 textColor, 并在 isPlay 时叠加描边或加深边框。
        // **先别删** —— 删了要连带删 textOnTranslucent()。
        // (下面两行因此触发 no-unused-vars 警告, 属预期, 已在 eslint 里标了说明)
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
          ctx.save();
          ctx.shadowColor = withAlpha(this.accent || C.accent, 0.5, 'rgba(255,122,69,.5)');
          ctx.shadowBlur = 7;
          ctx.strokeStyle = this.accent || C.accent;   // 选中环跟主题色(原为白色)
          ctx.lineWidth = 1.5;
          this._roundRect(ctx, x1 + 0.5, band.y, Math.max(1.5, wpx - 1), band.h, 4);
          ctx.stroke();
          ctx.restore();
        }
        // 块内: 中文行(角色色/加粗/100% 不透明) + 分隔线 + 英文逐词轴(可拖动标记)
        if (wpx > 46 && (c.text || c.text2)) this._drawBlockText(ctx, c, band, x1, x2, wpx, base);
        // 坏行(重叠/缺词/方括号…)警告: 红色虚线描边 + 右上角 ⚠ —— 英文行(下半区)重叠也能看到。
        // 单语行的"坏"已经画在**缺的那半**上了, 这里不再把红虚线糊到实心块上(否则看不出块是实心的)。
        if (c.bad && !lacks) this._drawBadMark(ctx, x1, band, wpx);
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
    const acc = this.accent || C.playhead;
    ctx.save();
    ctx.shadowColor = withAlpha(acc, 0.55, 'rgba(255,122,69,.55)');   // 游标光晕: 一眼找到当前时间
    ctx.shadowBlur = 8;
    ctx.strokeStyle = acc;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = acc;
    this._roundRect(ctx, x - 5, 0, 10, 9, 2.5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 4, 8); ctx.lineTo(x + 4, 8); ctx.lineTo(x, 13);
    ctx.closePath(); ctx.fill();
  }

  /** 单语孤行"缺的另一半": 虚线空槽。bad=true 时用坏行红 + ⚠(缺另一半就是这条行被判坏的原因),
   *  bad=false 时用中性灰(只是示意该半区没内容)。 */
  _drawEmptyHalf(ctx, x1, band, wpx, bad) {
    if (wpx < 12) return;
    const bx = x1 + 0.5, by = band.y, bw = Math.max(1.5, wpx - 1), bh = band.h;
    ctx.save();
    ctx.strokeStyle = bad ? '#ff5c5c' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = bad ? 1.5 : 1;
    ctx.setLineDash(bad ? [4, 3] : [3, 3]);
    this._roundRect(ctx, bx, by, bw, bh, 3);
    ctx.stroke();
    ctx.setLineDash([]);
    if (bad) this._drawWarnChip(ctx, bx, by, bw, wpx);
    ctx.restore();
  }

  /** 坏行右上角的 ⚠ 角标 */
  _drawWarnChip(ctx, bx, by, bw, wpx) {
    if (wpx < 16) return;
    const sx = bx + bw - 13, sy = by + 3;
    ctx.fillStyle = '#ff5c5c';
    ctx.beginPath();
    ctx.moveTo(sx + 6, sy);
    ctx.lineTo(sx + 12, sy + 11);
    ctx.lineTo(sx, sy + 11);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1a1a21';
    ctx.font = '700 9px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', sx + 6, sy + 9);
  }

  /** 坏行(重叠/缺词/方括号…)警告: 红色虚线描边 + 右上角 ⚠ 角标。
   *  叠在深色轨底上足够醒目, 让英文行(下半区)的重叠也能在时间轴下半部分看到。 */
  _drawBadMark(ctx, x1, band, wpx) {
    const bx = x1 + 0.5, by = band.y, bw = Math.max(1.5, wpx - 1), bh = band.h;
    ctx.save();
    ctx.strokeStyle = '#ff5c5c';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    this._roundRect(ctx, bx, by, bw, bh, 3);
    ctx.stroke();
    ctx.setLineDash([]);
    this._drawWarnChip(ctx, bx, by, bw, wpx);
    ctx.restore();
  }
}
