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
    this._workerReadyHandler = null;
    this._memoryFonts = new Map();
    this._fontObjectUrls = new Map();
  }

  get loaded() { return !!this.instance; }

  /** 记住一个字体文件。
   *  persist=true 落 IndexedDB(用户自己挑的文件, 下次还得用);
   *  persist=false 只留内存(本机字体库来的 —— 服务端随时能再给一份,
   *  没必要把几十 MB 的中文字体长期堆进浏览器存储)。 */
  async cacheFont(fontName, file, persist = true) {
    const key = fontKey(fontName);
    if (!key || !file) throw new Error('请先填写字体名称并选择字体文件');
    this._memoryFonts.set(key, file);
    if (!persist) return false;
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

  /** 该字体名在预览(libass)里是否真的有字形可用。
   *  内置 Noto CJK 恒可用; 其余看用户是否用「载入字体」导入过(内存或 IndexedDB 缓存)。
   *  用来在设置面板上如实提示"改了字体名但画面不会变"的原因。 */
  async isFontAvailable(name) {
    const key = fontKey(name);
    if (!key) return false;
    if (key === 'noto sans cjk sc') return true;
    return !!(await this._fontBlob(key));
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
    // 记住本次要渲染的轨道: 就绪后 _doUpdate() 会 setTrack + setCurrentTime。
    // 这一步不能省 —— worker 建轨是异步的, 而 libass 只在收到"时间"消息时才重绘;
    // 视频暂停时根本没有 timeupdate, 于是整轨重建(改字体名走的就是这条路)之后
    // 画面会一直空着, 直到用户碰一下进度条。
    this._pendingText = assText;
    this.ready = false;
    this.error = null;
    this.onStatus('libass 初始化中（WASM 和中文字体）…');
    let createStarted = false;
    const create = async () => {
      if (generation !== this._generation || createStarted) return;
      createStarted = true;
      try {
        // availableFonts 的值必须是**URL 字符串**: worker 的 loadFontFile 会直接对它
        // 调 path.split('/')。传数组会抛 "path.split is not a function" → 字体加载中断、
        // 字幕轨半途而废(画面直接空白)。
        const availableFonts = { 'noto sans cjk sc': FONT_URL };
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
          availableFonts[key] = url;
        }
        if (generation !== this._generation) return;
        const markReady = () => {
          if (generation !== this._generation || this.ready) return;
          this.ready = true;
          clearTimeout(this._initTimer);
          this.passThroughClicks();
          this._doUpdate();          // 推送轨道并立刻渲染当前帧(暂停时也能看到)
          this.onStatus('ASS 渲染就绪');
        };
        this.instance = new SubtitlesOctopus({
          video: this.video,
          subContent: assText,
          workerUrl: WORKER_URL,
          // fonts 一律留空, 只靠 availableFonts 触发加载。
          // 原因: worker 给 fonts 里的文件起名 'font<i>-<basename>', 给 availableFonts 的
          // 却用另一套独立计数器 'font<fontId>-<basename>' —— 同一个 URL 在两个计数器下
          // 撞上同一个下标时就是同一个 /fonts 路径, createPreloadedFile 撞名即抛
          // "FS error", 整个 worker 当场挂掉(实测: 中文轨用系统字体、英文轨也用系统字体时必现)。
          // availableFonts 已足够: worker 的 writeFontToFS 会按 Style 的 Fontname 主动加载。
          fonts: [],
          fallbackFont: FONT_URL,
          availableFonts,
          onReady: () => {
            // subtitles-octopus 4.x 会在收到 worker 的任意首条消息时调用 onReady；
            // wasm 尚未 ready 时可能只是 stdout/stderr，因此下面优先监听精确的 target=ready。
            if (generation !== this._generation) return;
            const worker = this.instance && this.instance.worker;
            if (!worker || typeof worker.addEventListener !== 'function') markReady();
          },
          onError: (e) => {
            if (generation !== this._generation) return;
            this.error = String(e && e.message || e);
            clearTimeout(this._initTimer);
            this.onStatus('ASS 渲染错误: ' + (e && e.message || e));
          }
        });
        const worker = this.instance && this.instance.worker;
        if (worker && typeof worker.addEventListener === 'function') {
          const onWorkerMessage = (event) => {
            if (!event || !event.data || event.data.target !== 'ready') return;
            worker.removeEventListener('message', onWorkerMessage);
            if (this._workerReadyHandler === onWorkerMessage) this._workerReadyHandler = null;
            markReady();
          };
          this._workerReadyHandler = onWorkerMessage;
          worker.addEventListener('message', onWorkerMessage);
        }
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
    // worker-init 是异步的；尚未 onReady 时发 setTrack 会与 libass 初始化竞争。
    // 保留最新文本，由 onReady 再发，避免“稿件已改、视频仍停留在旧轨”。
    if (!this.instance || !this.ready || this._pendingText == null) return;
    try {
      this.instance.setTrack(this._pendingText);
      // setTrack 会重建 libass track。显式同步当前播放时刻，确保暂停画面也立即重绘。
      if (typeof this.instance.setCurrentTime === 'function') {
        this.instance.setCurrentTime(Number(this.video.currentTime) || 0);
      }
    } catch (e) { console.warn('setTrack failed', e); }
  }

  dispose() {
    this._generation++;
    if (this.instance) {
      const worker = this.instance.worker;
      if (worker && this._workerReadyHandler) {
        try { worker.removeEventListener('message', this._workerReadyHandler); } catch (e) { /* noop */ }
      }
      this._workerReadyHandler = null;
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
