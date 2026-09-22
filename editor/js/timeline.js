/** Canvas 时间轴: 胶片缩略图 + 分轨字幕块 + 缩放/平移/定位/拖动改时间 */
import { fmtTime } from './util.js';
import { shortcuts, wheelGesture, gestureFromEvent } from './shortcuts.js';

const FILM_H = 46;      // 胶片缩略图条
const RULER_H = 20;     // 刻度
const LANE_H = 34;      // 每轨高度
const LANE_GAP = 6;
const CHIP_W = 78;      // 轨道标签
const TEXT_PAD = 6;

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
    this.follow = false;
    this.selected = null;     // 行对象
    this.onSeek = null;
    this.onRetime = null;
    this.onSelect = null;
    this.isEditable = null;
    this._drag = null;
    this._filmRotate = 0;

    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
  }

  setVideo(video) { this.video = video; this.film.reset(video); }

  setLanes(lanes) {
    this.lanes = lanes.map((l, i) => Object.assign({ color: LANE_COLORS[i % LANE_COLORS.length] }, l));
  }
  setDuration(d) { this.duration = d || 0; }
  setSelected(ref) { this.selected = ref; }

  fit() {
    const w = this._cssW();
    if (this.duration > 0 && w > 0) {
      this.pxPerSec = w / this.duration;
      this.viewStart = 0;
    }
  }
  zoomIn() { this._zoomAt(this._cssW() / 2, 1.6); }
  zoomOut() { this._zoomAt(this._cssW() / 2, 1 / 1.6); }

  _cssW() { return this.canvas.parentElement.clientWidth; }
  _cssH() { return this.canvas.parentElement.clientHeight; }
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this._cssW(), h = this._cssH();
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _zoomAt(px, factor) {
    const t = this.viewStart + px / this.pxPerSec;
    this.pxPerSec = Math.min(2000, Math.max(this._cssW() / Math.max(this.duration, 1) / 4, this.pxPerSec * factor));
    this.viewStart = t - px / this.pxPerSec;
    this._clampView();
  }
  _panBy(px) { this.viewStart -= px / this.pxPerSec; this._clampView(); }
  _clampView() {
    const span = this._cssW() / this.pxPerSec;
    const max = Math.max(0, this.duration - span);
    if (this.duration <= span) this.viewStart = (this.duration - span) / 2;
    else this.viewStart = Math.min(max, Math.max(0, this.viewStart));
  }

  t2x(t) { return (t - this.viewStart) * this.pxPerSec; }
  x2t(x) { return this.viewStart + x / this.pxPerSec; }

  _laneTop(i) { return FILM_H + RULER_H + 6 + i * (LANE_H + LANE_GAP); }
  _lanesBottom() { return this._laneTop(Math.max(0, this.lanes.length - 1)) + LANE_H; }

  /* ─────────── 事件 ─────────── */
  _bindEvents() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault()); // 允许右键拖动

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const beh = shortcuts.mouseBehavior(wheelGesture(e)) || 'none';
      const dir = e.deltaY < 0 ? 1 : -1;             // 上滚为正
      if (beh === 'zoom') {
        this._zoomAt(e.offsetX, dir > 0 ? 1.25 : 1 / 1.25);
      } else if (beh === 'pan') {
        this._panBy(dir * 120);
      } else if (beh === 'scrub') {
        const t = this._lastT || 0;
        this.onSeek && this.onSeek(this._clampT(t + dir * 0.2));
      }
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无捕获 */ }
      const x = e.offsetX, y = e.offsetY;
      const t = this.x2t(x);
      const laneIdx = this._laneIndexAtY(y);
      const beh = laneIdx === -1 ? 'scrub' : shortcuts.mouseBehavior(gestureFromEvent(e, 'drag'));

      if (beh === 'scrub') {
        this._drag = { type: 'scrub' };
        this.onSeek && this.onSeek(this._clampT(t));
        return;
      }
      if (beh === 'pan') {
        this._drag = { type: 'pan', lastX: x, moved: false };
        return;
      }
      if (beh === 'edit') {
        const h = this._hitTest(x, y);
        if (h) this.onSelect && this.onSelect(h.cue.ref, { seek: true });
        this._drag = null;
        return;
      }
      if (beh === 'none') { this._drag = null; return; }

      // 默认: 命中条目 → 移动/改时长; 空白 → 平移
      const hit = this._hitTest(x, y);
      if (hit && (!this.isEditable || this.isEditable(hit.cue.ref))) {
        const csx = this.t2x(hit.cue.start), cex = this.t2x(hit.cue.end);
        let part = 'body';
        if (cex - csx >= 8) {
          if (Math.abs(x - csx) <= 5) part = 'left';
          else if (Math.abs(x - cex) <= 5) part = 'right';
        }
        this._drag = { type: 'cue', part, cue: hit.cue, offStart: hit.cue.start - t, offEnd: hit.cue.end - t, moved: false };
        this.onSelect && this.onSelect(hit.cue.ref, { seek: false });
      } else {
        this._drag = { type: 'pan', lastX: x, moved: false };
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const x = e.offsetX, y = e.offsetY;
      const t = this.x2t(x);
      if (!this._drag) {
        let cursor = 'crosshair';
        if (this._laneIndexAtY(y) === -1) cursor = 'col-resize';
        else {
          const hit = this._hitTest(x, y);
          if (hit && (!this.isEditable || this.isEditable(hit.cue.ref))) {
            const csx = this.t2x(hit.cue.start), cex = this.t2x(hit.cue.end);
            cursor = (Math.abs(x - csx) <= 5 || Math.abs(x - cex) <= 5) && cex - csx >= 8 ? 'ew-resize' : 'move';
          } else cursor = 'grab';
        }
        cv.style.cursor = cursor;
        return;
      }
      const d = this._drag;
      if (d.type === 'scrub') {
        this.onSeek && this.onSeek(this._clampT(t));
      } else if (d.type === 'pan') {
        this._panBy(x - d.lastX); d.lastX = x; d.moved = true;
      } else if (d.type === 'cue') {
        d.moved = true;
        const c = d.cue;
        if (d.part === 'body') {
          const len = c.end - c.start;
          let ns = this._clampT(t + d.offStart);
          ns = Math.min(ns, this.duration - len);
          c.start = Math.max(0, ns); c.end = c.start + len;
        } else if (d.part === 'left') {
          c.start = Math.min(this._clampT(t + d.offStart), c.end - 0.05);
        } else {
          c.end = Math.max(this._clampT(t + d.offEnd), c.start + 0.05);
        }
        this.onRetime && this.onRetime(c.ref, c.start, c.end, false);
      }
    });

    cv.addEventListener('pointerup', (e) => {
      const d = this._drag;
      this._drag = null;
      if (!d) return;
      if (d.type === 'cue' && d.moved) {
        this.onRetime && this.onRetime(d.cue.ref, d.cue.start, d.cue.end, true);
      } else if (d.type === 'pan' && !d.moved) {
        this.onSeek && this.onSeek(this._clampT(this.x2t(e.offsetX)));
      }
    });

    cv.addEventListener('dblclick', (e) => {
      const beh = shortcuts.mouseBehavior('dblclick') || 'edit';
      if (beh === 'none') return;
      const hit = this._hitTest(e.offsetX, e.offsetY);
      if (hit) this.onSelect && this.onSelect(hit.cue.ref, { seek: true });
    });
  }

  _clampT(t) { return Math.max(0, Math.min(this.duration || t, t)); }

  _laneIndexAtY(y) {
    for (let i = 0; i < this.lanes.length; i++) {
      const top = this._laneTop(i);
      if (y >= top && y <= top + LANE_H) return i;
    }
    return -1;
  }

  _hitTest(x, y) {
    const li = this._laneIndexAtY(y);
    if (li === -1) return null;
    const lane = this.lanes[li];
    const t = this.x2t(x);
    const cues = lane.cues;
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = idx; i >= 0 && cues[i].end >= t; i--) {
      if (t >= cues[i].start && t < cues[i].end) return { lane, cue: cues[i] };
    }
    return null;
  }

  /* ─────────── 绘制 ─────────── */
  draw(t, now) {
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

    if (this.follow) {
      const x = this.t2x(t);
      if (x < W * 0.1 || x > W * 0.9) {
        this.viewStart = t - W * 0.5 / this.pxPerSec;
        this._clampView();
      }
    }

    this._drawFilmstrip(ctx, W);
    this._drawRuler(ctx, W);
    this._drawLanes(ctx, W, t);
    this._drawPlayhead(ctx, H, t);
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
    const top = FILM_H;
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

  _drawLanes(ctx, W, t) {
    this.lanes.forEach((lane, li) => {
      const yy = this._laneTop(li);
      ctx.fillStyle = C.laneBg;
      ctx.fillRect(0, yy, W, LANE_H);
      ctx.strokeStyle = C.laneBorder;
      ctx.beginPath(); ctx.moveTo(0, yy + LANE_H + 0.5); ctx.lineTo(W, yy + LANE_H + 0.5); ctx.stroke();

      const spanStart = this.viewStart - 1, spanEnd = this.viewStart + W / this.pxPerSec + 1;
      const cues = lane.cues;
      let lo = 0, hi = cues.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].end >= spanStart) hi = mid; else lo = mid + 1; }

      const minPx = 2;
      let runStart = null, runEnd = null;
      const flushRun = () => {
        if (runStart === null) return;
        ctx.fillStyle = lane.color + '66';
        this._roundRect(ctx, runStart, yy + 4, Math.max(1.5, runEnd - runStart), LANE_H - 8, 3);
        ctx.fill();
        runStart = runEnd = null;
      };

      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      for (let i = lo; i < cues.length && cues[i].start <= spanEnd; i++) {
        const c = cues[i];
        const x1 = this.t2x(Math.max(c.start, spanStart));
        const x2 = this.t2x(Math.min(c.end, spanEnd));
        const wpx = x2 - x1;
        if (wpx < minPx) {
          if (runStart === null) { runStart = x1; runEnd = x2; }
          else runEnd = Math.max(runEnd, x2);
          continue;
        }
        flushRun();

        const isSel = this.selected && c.row === this.selected;
        const isPlay = c.start <= t && t < c.end;
        ctx.fillStyle = isPlay ? lane.color : lane.color + 'cc';
        this._roundRect(ctx, x1 + 0.5, yy + 4, Math.max(1.5, wpx - 1), LANE_H - 8, 3);
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          this._roundRect(ctx, x1 + 0.5, yy + 4, Math.max(1.5, wpx - 1), LANE_H - 8, 3);
          ctx.stroke();
        }
        // 块内文字(宽度足够时)
        if (wpx > 46 && c.text) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + TEXT_PAD, yy + 4, wpx - TEXT_PAD * 2, LANE_H - 8);
          ctx.clip();
          ctx.fillStyle = isPlay ? '#1a1206' : '#ffffff';
          ctx.fillText(c.text.slice(0, 40), x1 + TEXT_PAD, yy + LANE_H / 2 + 3.5);
          ctx.restore();
        }
      }
      flushRun();

      // 轨道标签(悬浮于最上层)
      const label = lane.label || '';
      if (label) {
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        const tw = Math.min(CHIP_W, ctx.measureText(label).width + 14);
        ctx.fillStyle = C.chipBg;
        this._roundRect(ctx, 5, yy + 6, tw, LANE_H - 12, 8);
        ctx.fill();
        ctx.strokeStyle = lane.color + '99';
        ctx.lineWidth = 1;
        this._roundRect(ctx, 5.5, yy + 6.5, tw - 1, LANE_H - 13, 8);
        ctx.stroke();
        ctx.fillStyle = C.chipText;
        ctx.fillText(label, 12, yy + LANE_H / 2 + 3.5);
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
