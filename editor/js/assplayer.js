/** ASS 渲染器: 封装 SubtitlesOctopus (libass-wasm, 完整特效支持) */
const WORKER_URL = '/editor/vendor/subtitles-octopus-worker.js';
// 绝对路径: worker 内部 fetch 字体/wasm 时以 worker 脚本为基准, 相对路径会 404
const FONT_URL = '/editor/vendor/fonts/NotoSansCJKsc-Regular.otf';

export class AssPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {(msg:string)=>void} onStatus
   */
  constructor(video, onStatus) {
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.instance = null;
    this.ready = false;
    this.error = null;
    this._pendingText = null;
    this._debounceTimer = null;
  }

  get loaded() { return !!this.instance; }

  load(assText) {
    this.dispose();
    this.ready = false;
    this.error = null;
    this.onStatus('libass 初始化中(载入 WASM 与中文字体)…');
    // 等 video 有尺寸后再建, 否则 canvas 可能为 0
    const create = () => {
      this.instance = new SubtitlesOctopus({
        video: this.video,
        subContent: assText,
        workerUrl: WORKER_URL,
        fonts: [FONT_URL],
        fallbackFont: FONT_URL,
        availableFonts: {
          'noto sans cjk sc': [FONT_URL]
        },
        onReady: () => { this.ready = true; this.passThroughClicks(); this.onStatus('ASS 渲染就绪'); },
        onError: (e) => { this.error = String(e && e.message || e); this.onStatus('ASS 渲染错误: ' + (e && e.message || e)); }
      });
      this.passThroughClicks();
    };
    if (this.video.videoWidth > 0) create();
    else {
      const v = this.video;
      const once = () => { v.removeEventListener('loadedmetadata', once); create(); };
      v.addEventListener('loadedmetadata', once);
      // 兜底: 1.5s 后强建
      setTimeout(() => { if (!this.instance) { v.removeEventListener('loadedmetadata', once); create(); } }, 1500);
    }
  }

  /**
   * 保证字幕渲染层不拦截指针事件(点击/拖动必须穿透到 video)。
   * octopus 只给 canvas 自身设了 pointer-events, 而其容器 .libassjs-canvas-parent
   * 覆盖整个视频区, 若不穿透会导致播放/暂停/进度条全部失效。
   */
  passThroughClicks() {
    try {
      const p = this.instance && this.instance.canvasParent;
      const c = this.instance && this.instance.canvas;
      if (p) p.style.pointerEvents = 'none';
      if (c) c.style.pointerEvents = 'none';
    } catch (e) { /* noop */ }
  }

  /** 编辑后增量刷新(防抖, 适用于拖动等连续操作) */
  update(assText) {
    this._pendingText = assText;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._doUpdate(), 450);
  }

  /** 立即刷新(适用于表单应用, 保证编辑→重算→重渲染时序一致) */
  updateNow(assText) {
    this._pendingText = assText;
    clearTimeout(this._debounceTimer);
    this._doUpdate();
  }

  _doUpdate() {
    if (this.instance && this._pendingText != null) {
      try { this.instance.setTrack(this._pendingText); }
      catch (e) { console.warn('setTrack failed', e); }
    }
  }

  dispose() {
    if (this.instance) {
      try { this.instance.dispose(); } catch (e) { /* noop */ }
      this.instance = null;
    }
    this._pendingText = null;
    clearTimeout(this._debounceTimer);
  }
}
