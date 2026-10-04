/* ESLint flat config —— 只抓「真会出错」的问题，不做风格管制。
 *
 * 为什么不配 indent/quotes/semi：
 *   本项目 JS 是浏览器原生 <script type="module"> + Node 混用，没有 package.json，
 *   也没有构建步骤。历史上 2 空格与 4 空格、单双引号混用是有意为之的（同一文件里
 *   嵌套层级不同），强推风格规则只会产出几百条与正确性无关的噪音，反而让人懒得看。
 *   真正值得拦的是下面这些「改了会静默出错」的东西。
 *
 * 用法：
 *   npx eslint editor/ tools/            # 全部检查
 *   npx eslint editor/ tools/ --fix      # 自动修可修的
 *   npx eslint editor/js/editor.js       # 单文件
 * 说明：项目无 package.json，需先 `npm i -D eslint@9`（node_modules/ 已在 .gitignore）。
 */
export default [
  {
    // 浏览器侧：原生 ES module，靠 import/export，不用 node 专属语法
    files: ['editor/**/*.js', 'tools/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', fetch: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly',
        TextEncoder: 'readonly', AbortController: 'readonly', Blob: 'readonly',
        FileReader: 'readonly', FormData: 'readonly', Headers: 'readonly',
        Request: 'readonly', Response: 'readonly', localStorage: 'readonly',
        sessionStorage: 'readonly', indexedDB: 'readonly', crypto: 'readonly',
        performance: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
        Audio: 'readonly', AudioContext: 'readonly', Image: 'readonly',
        XMLHttpRequest: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly', Worker: 'readonly', OffscreenCanvas: 'readonly',
        AbortSignal: 'readonly', EventSource: 'readonly', NodeFilter: 'readonly',
        File: 'readonly', FileList: 'readonly', FileReader: 'readonly', Blob: 'readonly',
        HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLCanvasElement: 'readonly',
        HTMLVideoElement: 'readonly', Element: 'readonly', Node: 'readonly', Event: 'readonly',
        CustomEvent: 'readonly', DOMParser: 'readonly', XMLSerializer: 'readonly',
        history: 'readonly', location: 'readonly', screen: 'readonly', getComputedStyle: 'readonly',
        matchMedia: 'readonly', requestIdleCallback: 'readonly', SpeechSynthesisUtterance: 'readonly',
        globalThis: 'readonly', Intl: 'readonly', WeakMap: 'readonly', WeakSet: 'readonly',
        Map: 'readonly', Set: 'readonly', Proxy: 'readonly', Reflect: 'readonly',
        Symbol: 'readonly', Promise: 'readonly', BigInt: 'readonly',
      },
    },
    rules: {
      /* ── 正确性：这些会静默产生错误结果或直接崩 ── */
      'no-undef': 'error',                    // 用了不存在的变量 —— 最容易出真 bug 的一类
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',                   // x === NaN 永远false，必须 Number.isNaN
      'no-cond-assign': 'error',              // if (x = 1)少写一个 = 号
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],  // 项目大量用空catch 兜底，属既定风格
      'require-atomic-updates': 'off',        // 单线程 Node/浏览器里误报太多
      'no-async-promise-executor': 'error',

      /* ── 疑似错误 ── */
      'no-unused-vars': ['warn', {
        args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        caughtErrors: 'none',                 // catch(e){} 的 e 一律不算未使用
      }],
      'no-fallthrough': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'valid-typeof': 'error',

      /* ── 刻意不启用的规则（试过，噪音大于价值）──
       * no-restricted-properties(Object.prototype): server.js:4118 用的是
       *   Object.prototype.hasOwnProperty.call(p, k) —— 这恰恰是**推荐的安全写法**
       *   （读原型方法而非直接调 p.hasOwnProperty，防止 p 是无原型对象时被覆盖）。
       *   规则无法区分它和"真改原型"，会误报，故不启用。
       * indent / quotes / semi: 见文件头，混用是有意的，强推只产风格噪音。
       */
    },
  },

  /* Node 侧服务端：server.js 用 require/CommonJS + node 内置模块 */
  {
    files: ['editor/server.js', 'editor/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly', process: 'readonly',
        Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        TextDecoder: 'readonly', TextEncoder: 'readonly', AbortController: 'readonly',
        AbortSignal: 'readonly', Timeout: 'readonly', Immediate: 'readonly',
        fetch: 'readonly', Blob: 'readonly', FormData: 'readonly', Headers: 'readonly',
        Response: 'readonly', Request: 'readonly', queueMicrotask: 'readonly',
        structuredClone: 'readonly', performance: 'readonly', crypto: 'readonly',
        globalThis: 'readonly', Promise: 'readonly', Symbol: 'readonly',
        Map: 'readonly', Set: 'readonly', WeakMap: 'readonly', WeakSet: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error' },
  },

  /* tools/ 与 tests/ 是 **Node 脚本**（跑探针、跑测试、跑发布），不是浏览器代码：
   * 会用 process.exit / Buffer / WebSocket 等浏览器没有的全局。 */
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'editor/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly', Buffer: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', queueMicrotask: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly',
        TextEncoder: 'readonly', AbortController: 'readonly', fetch: 'readonly',
        Blob: 'readonly', FormData: 'readonly', Headers: 'readonly', Response: 'readonly',
        structuredClone: 'readonly', performance: 'readonly', crypto: 'readonly',
        globalThis: 'readonly', Promise: 'readonly', Symbol: 'readonly', Proxy: 'readonly',
        Map: 'readonly', Set: 'readonly', WeakMap: 'readonly', WeakSet: 'readonly',
        Intl: 'readonly', WebSocket: 'readonly',
        /* 探针脚本(tools/*_probe.mjs / *_diag.mjs)跑在 headless 浏览器里，
         * 会驱动真实 DOM 事件与文件拖放，故这些浏览器全局也可用。 */
        DataTransfer: 'readonly', File: 'readonly', FileList: 'readonly',
        PerformanceObserver: 'readonly', MouseEvent: 'readonly', KeyboardEvent: 'readonly',
        PointerEvent: 'readonly', WheelEvent: 'readonly', DragEvent: 'readonly',
        InputEvent: 'readonly', EventTarget: 'readonly', ClipboardEvent: 'readonly',
        DataTransferItemList: 'readonly', DOMRect: 'readonly', NodeList: 'readonly',
        HTMLCollection: 'readonly', getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        HTMLElement: 'readonly', HTMLInputElement: 'readonly', HTMLCanvasElement: 'readonly',
        HTMLVideoElement: 'readonly', HTMLSelectElement: 'readonly', Element: 'readonly',
        Node: 'readonly', Event: 'readonly', CustomEvent: 'readonly', navigator: 'readonly',
        window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', alert: 'readonly',
      },
    },
    rules: { 'no-unused-vars': 'off' },
  },

  /* tests/jsmod/package.json 只是给镜像目录打 {"type":"module"} 标记，让 .js 能被
   * 当 ESM import；editor/scripts/fetch-vendor.js 是 CommonJS 打包脚本。 */
  {
    files: ['editor/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        __dirname: 'readonly', __filename: 'readonly', process: 'readonly',
        console: 'readonly', Buffer: 'readonly', fetch: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly',
        AbortController: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        globalThis: 'readonly', Promise: 'readonly',
      },
    },
  },

  /* vendor 第三方库注入的全局（由 editor/scripts/fetch-vendor.js 下载到 editor/vendor/）：
   * SubtitlesOctopus 由 assplayer.js:137 直接 new，运行时由 vendor脚本挂在 window 上。 */
  {
    files: ['editor/js/**/*.js'],
    languageOptions: {
      globals: { SubtitlesOctopus: 'readonly' },
    },
  },

  /* 忽略：vendor 第三方代码、测试镜像副本、生成物 */
  {
    ignores: [
      'editor/vendor/**',   // fetch-vendor.js 下载的第三方库，不受本项目规则约束
      'tests/jsmod/**',     // editor/js 的机械副本，改动应发生在 editor/js
      'build/**',           // 打包产物
      'node_modules/**',
    ],
  },
];
