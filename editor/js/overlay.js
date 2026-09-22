/** SRT 双语叠加渲染层 (HTML, 贴视频画面矩形) */
import { bisectStart } from './util.js';
import { splitBilingual, srtLineToHtml } from './srt.js';

export class SrtOverlay {
  /**
   * @param {HTMLElement} overlayEl  #srt-overlay
   * @param {HTMLVideoElement} video
   */
  constructor(overlayEl, video) {
    this.el = overlayEl;
    this.video = video;
    this.cues = [];
    this.order = 'main-first';   // main-first | sub-first
    this.fontScale = 1;
    this._lastKey = '';
    this.visible = false;
  }

  setCues(cues) { this.cues = cues || []; this._lastKey = '__force__'; }
  setOrder(order) { this.order = order; this._lastKey = '__force__'; }
  setFontScale(v) { this.fontScale = v; this._lastKey = '__force__'; }

  show() { this.visible = true; this.el.style.display = 'flex'; this._lastKey = '__force__'; this.fitToVideo(); }
  hide() { this.visible = false; this.el.style.display = 'none'; }

  /** 让 overlay 精确覆盖视频画面(去黑边), 与 libass 对齐口径一致 */
  fitToVideo() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const w = this.video.clientWidth, h = this.video.clientHeight;
    const vr = vw / vh, er = w / h;
    let rw = w, rh = h;
    if (er > vr) rw = Math.floor(h * vr); else rh = Math.floor(w / vr);
    this.el.style.left = (w - rw) / 2 + 'px';
    this.el.style.top = (h - rh) / 2 + 'px';
    this.el.style.width = rw + 'px';
    this.el.style.height = rh + 'px';
    this._rectH = rh;
    this._lastKey = '__force__';
  }

  /** 每帧调用(timeupdate + rAF) */
  update(t) {
    if (!this.visible) return;
    const actives = [];
    if (this.cues.length) {
      let i = bisectStart(this.cues, t);
      for (let k = i; k >= 0 && this.cues[k].end > t; k--) actives.unshift(this.cues[k]);
      for (let k = i + 1; k < this.cues.length && this.cues[k].start <= t; k++) {
        if (this.cues[k].end > t) actives.push(this.cues[k]);
        else break;
      }
    }
    const key = actives.map(c => c.id).join('|') + '#' + this.order + '#' + this.fontScale;
    if (key === this._lastKey) return;
    this._lastKey = key;

    const basePx = Math.max(12, (this._rectH || 600) * 0.045 * this.fontScale);
    let html = '';
    for (const cue of actives) {
      const { main, subs } = splitBilingual(cue.lines);
      const mainHtml = main != null
        ? `<div class="ov-line ov-main" style="font-size:${basePx.toFixed(1)}px">${srtLineToHtml(main)}</div>` : '';
      const subHtml = subs.length
        ? subs.map(l => `<div class="ov-line ov-sub" style="font-size:${(basePx * 0.78).toFixed(1)}px">${srtLineToHtml(l)}</div>`).join('') : '';
      const inner = this.order === 'main-first' ? mainHtml + subHtml : subHtml + mainHtml;
      html += `<div class="ov-cue">${inner}</div>`;
    }
    this.el.innerHTML = html;
  }
}
