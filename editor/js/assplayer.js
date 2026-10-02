/** ASS 渲染器: 封装 SubtitlesOctopus (libass-wasm, 完整特效支持) */
// 基于模块自身位置推导绝对 URL: 无论站点根是项目根(server.js)还是 editor/(python -m http.server),
// 都能正确命中 worker/wasm/字体。写死 '/editor/vendor/...' 在后者下会 404 → ASS 完全不渲染。
const VENDOR_DIR = new URL('../vendor/', import.meta.url);
const WORKER_URL = new URL('subtitles-octopus-worker.js', VENDOR_DIR).href;
// 绝对路径: worker 内部 fetch 字体/wasm 时以 worker 脚本为基准, 相对路径会 404
const FONT_URL = new URL('fonts/NotoSansCJKsc-Regular.otf', VENDOR_DIR).href;
const FONT_DB_NAME = 'subfabric-ass-fonts';
const FONT_STORE = 'fonts';

function openFontDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(FONT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FONT_STORE)) db.createObjectStore(FONT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function fontKey(name) { return String(name || '').trim().toLowerCase(); }

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
    this._generation = 0;
    this._memoryFonts = new Map();
    this._fontObjectUrls = new Map();
  }

  get loaded() { return !!this.instance; }

  async cacheFont(fontName, file) {
    const key = fontKey(fontName);
    if (!key || !file) throw new Error('请先填写字体名称并选择字体文件');
    this._memoryFonts.set(key, file);
    const db = await openFontDb();
    if (!db) return false;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FONT_STORE, 'readwrite');
        tx.objectStore(FONT_STORE).put(file, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('字体缓存失败'));
      });
      return true;
    } finally { db.close(); }
  }

  async _fontBlob(name) {
    const key = fontKey(name);
    if (!key) return null;
    if (this._memoryFonts.has(key)) return this._memoryFonts.get(key);
    const db = await openFontDb();
    if (!db) return null;
    try {
      return await new Promise((resolve) => {
        const req = db.transaction(FONT_STORE, 'readonly').objectStore(FONT_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } finally { db.close(); }
  }

  load(assText, fontNames = []) {
    this.dispose();
    const generation = this._generation;
    this.ready = false;
    this.error = null;
    this.onStatus('libass 初始化中（WASM 和中文字体）…');
    let createStarted = false;
    const create = async () => {
      if (generation !== this._generation || createStarted) return;
      createStarted = true;
      try {
        const extraFonts = [];
        const availableFonts = { 'noto sans cjk sc': [FONT_URL] };
        for (const name of [...new Set((fontNames || []).map(n => String(n || '').trim()).filter(Boolean))]) {
          const blob = await this._fontBlob(name);
          if (generation !== this._generation) return;
          if (!blob) continue;
          const key = fontKey(name);
          let url = this._fontObjectUrls.get(key);
          if (!url) {
            url = URL.createObjectURL(blob);
            this._fontObjectUrls.set(key, url);
          }
          extraFonts.push(url);
          availableFonts[key] = [url];
        }
        if (generation !== this._generation) return;
        this.instance = new SubtitlesOctopus({
          video: this.video,
          subContent: assText,
          workerUrl: WORKER_URL,
          fonts: [FONT_URL, ...extraFonts],
          fallbackFont: FONT_URL,
          availableFonts,
          onReady: () => {
            if (generation !== this._generation) return;
            this.ready = true;
            clearTimeout(this._initTimer);
            this.passThroughClicks();
            this.onStatus('ASS 渲染就绪');
            if (this._pendingText != null) this._doUpdate();
          },
          onError: (e) => {
            if (generation !== this._generation) return;
            this.error = String(e && e.message || e);
            clearTimeout(this._initTimer);
            this.onStatus('ASS 渲染错误: ' + (e && e.message || e));
          }
        });
        this.passThroughClicks();
      } catch (e) {
        if (generation !== this._generation) return;
        // worker/wasm/字体 404 等启动失败: 给出可执行的修复指引
        this.error = String(e && e.message || e);
        this.onStatus('ASS 渲染器启动失败: ' + this.error
          + '。运行 node editor/scripts/fetch-vendor.js 下载渲染依赖后刷新页面');
      }
    };
    clearTimeout(this._initTimer);
    this._initTimer = setTimeout(() => {
      if (generation === this._generation && !this.ready && !this.error) {
        this.onStatus('libass 初始化超时。确认 editor/vendor 已就绪：node editor/scripts/fetch-vendor.js');
      }
    }, 8000);
    if (this.video.videoWidth > 0) create();
    else {
      const v = this.video;
      const once = () => {
        v.removeEventListener('loadedmetadata', once);
        if (this._metadataHandler === once) this._metadataHandler = null;
        create();
      };
      this._metadataHandler = once;
      v.addEventListener('loadedmetadata', once);
      // 兜底: 1.5s 后强建
      this._metadataTimer = setTimeout(() => {
        if (generation !== this._generation) return;
        v.removeEventListener('loadedmetadata', once);
        if (this._metadataHandler === once) this._metadataHandler = null;
        create();
      }, 1500);
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
    this._generation++;
    if (this.instance) {
      try { this.instance.dispose(); } catch (e) { /* noop */ }
      this.instance = null;
    }
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      for (const url of this._fontObjectUrls.values()) URL.revokeObjectURL(url);
    }
    this._fontObjectUrls.clear();
    if (this._metadataHandler) {
      this.video.removeEventListener('loadedmetadata', this._metadataHandler);
      this._metadataHandler = null;
    }
    clearTimeout(this._metadataTimer);
    clearTimeout(this._initTimer);
    this._pendingText = null;
    clearTimeout(this._debounceTimer);
  }
}
