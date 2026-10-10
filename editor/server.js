/**
 * 字幕编辑器 - 本地静态服务器
 * 特性:
 *  - 服务 D:\subtitle 整个目录(编辑器页面 / 示例视频 / 示例字幕)
 *  - 支持 HTTP Range 请求(大视频拖动进度必需)
 *  - /api/samples 返回根目录下的示例视频与字幕清单
 * 运行: node server.js  (默认 http://127.0.0.1:8321)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const resegMod = require('./reseg.js');   // 语义分句(LLM 补标点 → 按标点切句), 所有识别引擎共用
const bcutAsr = require('./bcut-asr.js'); // 必剪(bcut)云端识别: 免模型/免显卡, 只把音频传上去
const capcutAsr = require('./capcut-asr.js'); // 剪映(CapCut)云端识别: 同上, 与必剪互为备份
const asrChunks = require('./asr-chunks.js'); // 长音频分片: 静音优先切片 + 时间戳偏移合并 + 片间节流
const audioSlice = require('./audio-slice.js'); // 静音检测与切片(真 ffmpeg; 与离线探针共用同一份实现)
const llmText = require('./llm-text.js');
// 长稿反思纠错：让 LLM 通读全片找"语句不通顺"，产出可预览的建议与去重后的重识别区间
const reflectMod = require('./reflect.js');
const packMod = require('./project-pack.js');      // 项目压缩包: 文件分类与校验(纯逻辑)
const alignMod = require('./align.js');           // 逐词时间重对齐(TTS 合成 → 重识别 → 序列对齐)
const speechGapMod = require('./speech-gap.js');   // 波形漏字幕检测: 有说话、没字幕覆盖的区间
const mtLocal = require('./mt-local.js');
const asrServiceMod = require('./asr-service.js');
const hotwordsMod = require('./hotwords.js');       // 从操作日志挖 ASR 热词候选(纯逻辑, 有单测)
const gluedWordsMod = require('./glued-words.js');  // 扫"单词被粘住"(toescape 这类), 有单测

/* 测试用页面：`/__test/<name>` 直接吐 tests/<name>。
 * 为什么需要：`tests/*.html` 的验证页要用 fetch 调 /api/*，而 file:// 下是跨源、
 * 拿不到数据（实测踩过：验证页里 fetch('/api/fonts') 静默失败 → 组件空转，
 * 于是"定位对不对"这类断言测的其实是个空盒子）。
 * ⚠ 只在测试目录里按文件名取，不做路径拼接 —— 不给任意文件读取留口子。 */
function serveTestPage(req, res, pathname) {
  const m = /^\/__test\/([A-Za-z0-9_.-]{1,64})$/.exec(pathname);
  if (!m) return false;
  const name = m[1];
  const p = path.join(ROOT, 'tests', name);
  if (!p.startsWith(path.join(ROOT, 'tests')) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  const ext = path.extname(name).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' || ext === '.mjs' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(p));
  return true;
}

/* ── 本地翻译引擎（NLLB / CTranslate2）──
 * 惰性单例：第一次真正要翻的时候才起服务（起一次要载入 600MB 模型，十几秒）。
 * ⚠ 必须定义在**模块级**：llmReady 与 /api/mt/local/* 路由都在这个作用域调用它。
 *   之前放在 translateOnce 内部，结果 llmReady 直接 ReferenceError（踩过）。 */
let _localMt = null;
function localMt() {
  if (!_localMt) {
    _localMt = new mtLocal.LocalMt({
      repoRoot: ROOT,
      pythonExe: process.env.SUBFABRIC_MT_PYTHON || ASR_PY,
      onLog: (m) => console.log(m),
    });
  }
  return _localMt;
}
const fonts = require('./fonts.js');          // 本机字体库: 让 ASS 样式面板直接用系统字体
const cast = require('./cast.js');            // LLM 分角色(纯逻辑: 阵容推断 + SPK→角色名)  // LLM 回复卫生+解析(剥思维链/平衡取JSON/密度校验)
const secretStore = require('./secret-store.js'); // 敏感值落盘: bilibili Cookie / LLM API Key 走密文, 不明文进 settings.json

const ROOT = path.resolve(__dirname, '..'); // D:\subtitle

/* ── 控制台输出同时落一份到文件 ────────────────────────────────────────
 * 为什么需要: 无窗口启动器(启动SubFabric(无窗口).vbs)下 node **没有控制台**,
 * 光靠控制台的日志就全丢了 —— 启动失败时用户什么都看不到。
 * 这里有两条路可走: ①让启动器把 stdout 重定向到文件(要求经过 cmd, 实测在
 * wscript 里调用会卡住, 见启动器注释); ②在 node 内部 tee 一份。选了 ② —— 不依赖
 * 任何 shell 引号规则, 直接双击/发行版 exe 起也照样有日志。
 * 写入失败(目录只读等)时静默降级, 绝不能因为日志把服务拖挂。 */
const LOG_DIR = path.join(ROOT, 'logs');
const CONSOLE_LOG = path.join(LOG_DIR, 'launcher-console.log');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stream = fs.createWriteStream(CONSOLE_LOG, { flags: 'a' });
  stream.on('error', () => {});
  const tee = (orig) => (...args) => {
    orig.apply(console, args);
    try {
      const line = args.map(a => (typeof a === 'string' ? a : require('util').inspect(a))).join(' ');
      stream.write('[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + line + '\n');
    } catch {}
  };
  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));
  console.log('[subtitle-editor] 日志同时写入 ' + CONSOLE_LOG);
} catch {}

/** 端口: --port NNNN > 环境变量 PORT > 默认 8321。
 *  为什么要 --port: 8321 上可能停着一个"看不见的旧实例"(它的托盘图标被收进了隐藏区),
 *  这时用户需要一个不改环境变量就能换端口再起的入口 —— 启动器(启动SubFabric(无窗口).vbs)
 *  就是用它传端口的。 */
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  if (i >= 0) {
    const n = Number(process.argv[i + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    console.error('[subtitle-editor] --port 的值无效：' + process.argv[i + 1] + '（忽略，用默认端口）');
  }
  return process.env.PORT ? Number(process.env.PORT) : 8321;
})();
const HOST = '127.0.0.1';
// 版本号 2.2.1-fork.1：本 fork 与上游**同名不同内容**，故加 -fork.N 后缀区分。
//（基线上游 2.2.1；本 fork 自己的功能见 editor/README.md 的更新日志 ——
//  分段导入（多人协作）/ 区域字幕导入 / 项目压缩包导出导入 / 逐词字幕自愈 /
//  全片逐词重校对 / 备注弹幕 / NPU 识别 + 本地 NLLB 翻译 等）。
const APP_VERSION = '2.2.1-fork.1'; // 与打版号一致; 改了就顺手同步这里
// Windows 的文件版本号要求**四段纯数字**，不能带 -fork.1 这种后缀
//（build_exe.py 用它喂 rcedit，安装包 SubFabric.iss 里也有一份同值的 MyAppFileVersion）。
// 改 APP_VERSION 时这个也要跟着改，否则 exe 属性里显示的版本会对不上。
const APP_FILE_VERSION = '2.2.1.0';

/* ── 子进程登记表 ──────────────────────────────────────────────
 * ffmpeg(抽音频/波形)、Python 识别(可能占着几 GB 显存)、PowerShell 选择文件对话框,
 * 全是本服务的子进程。「退不干净」的根子就在这: 服务进程没了, 它们照旧活着, 用户只能
 * 去任务管理器里一个个杀。这里包一层**同名** spawn —— 20 多个调用点一个字都不用改,
 * 但每个子进程都进了 CHILDREN, 「完全退出」时能一并收掉。 */
const CHILDREN = new Set();
function spawn(...args) {
  const p = childProcess.spawn(...args);
  try {
    if (p && typeof p.once === 'function') {
      CHILDREN.add(p);
      const forget = () => CHILDREN.delete(p);
      p.once('close', forget);          // 正常结束/被杀都走这里
      p.once('exit', forget);
    }
  } catch {}
  return p;
}

/* audio-slice 默认用原生 spawn(为的是能被离线探针独立复用), 这里把**登记版**注入进去 ——
 * 静音检测/切片用的 ffmpeg 也要进 CHILDREN, 否则「完全退出」后它还在后台占着。 */
audioSlice.setSpawnImpl(spawn);

/* ── 运行日志: 环形缓冲 + SSE 推送(UI「日志」页实时显示)。
 * GUI 版 exe 无控制台, console 输出本来无处可去 —— 统一收进缓冲,
 * 原始 console 调用 safe 化(无控制台时写 stdout 会 throw)。 ── */
const LOG_MAX = 600;
const logBuf = [];                 // [{t, level, msg}]
const logClients = new Set();      // SSE 订阅响应
const lifeClients = new Set();     // 「服务生命周期」SSE 订阅(前端接「完全退出」通知)
function fmtLogArg(a) {
  if (a instanceof Error) return (a && a.stack) || String(a);
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}
function pushLog(level, args) {
  const line = { t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level,
                 msg: args.map(fmtLogArg).join(' ') };
  logBuf.push(line);
  if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
  const chunk = 'data: ' + JSON.stringify(line) + '\n\n';
  for (const res of logClients) { try { res.write(chunk); } catch { logClients.delete(res); } }
}
/* 生命周期事件(目前只有 shutdown): 服务要退出了, 让**已经开着的页面**先补存再关掉自己。
 * 少了这一步, 用户点了「完全退出」后浏览器窗口还杵在那, 看着就像没退干净。 */
function broadcastLife(event, data) {
  const chunk = 'event: ' + event + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
  for (const res of lifeClients) { try { res.write(chunk); } catch { lifeClients.delete(res); } }
}
const _cLog = console.log.bind(console), _cErr = console.error.bind(console);
const _cWarn = console.warn.bind(console);
console.log = (...a) => { try { _cLog(...a); } catch {} pushLog('info', a); };
console.error = (...a) => { try { _cErr(...a); } catch {} pushLog('error', a); };
// console.warn 以前**漏了包装** → 所有 warn 级别的信息都不进日志页（排查时看不到，
// 而这类消息恰恰常是"能跑但不对劲"的线索）。补上。
console.warn = (...a) => { try { _cWarn(...a); } catch {} pushLog('warn', a); };

/* ── 用户操作日志（「日志」页的第二个板块）──────────────────────────
 *
 * 记录**用户做了什么、以及为什么**（例如"重排逐词时间：锚点率 0.91，12 个词"）。
 * 与服务运行日志分开存：
 *   · 运行日志是 console 的镜像、只保留最近 600 条、重启即清空；
 *   · 操作日志要**跨重启留存**（用户可能过几天回来查"这条字幕什么时候被改的"），
 *     所以按项目落盘到 projects/<id>/oplog.json。
 *
 * 为什么不放 settings.js：那是全局配置（会被提交/备份），操作日志是项目数据。
 */
const OP_LOG_MAX = 500;
/* 注意：操作日志的读写辅助必须定义在 handleRequest **内部**（见 projDir 附近），
 * 因为它们要用 projDir() —— 那是 handleRequest 里的局部函数。
 * 早期放在模块作用域，于是每次调用都 `ReferenceError: projDir is not defined`，
 * 而被 catch 吞掉、只表现为"写不进去"（written: 0），排查了好一阵。 */


/* ── libass 渲染依赖自检 ──
 * editor/vendor/ 在 .gitignore 里（约 18MB），新克隆必须跑一次
 * `node editor/scripts/fetch-vendor.js`。缺了它：字幕列表与时间轴都正常，
 * 但视频画面上没有任何字幕，且样式面板里看不到「ASS 渲染就绪」——
 * 用户很难自己想到是渲染器缺失（实测有人因此以为软件坏了）。 */
const LIBASS_FILES = ['subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm',
                      path.join('fonts', 'NotoSansCJKsc-Regular.otf')];
function libassMissing() {
  const dir = path.join(__dirname, 'vendor');
  return LIBASS_FILES.filter(f => {
    try { return !fs.statSync(path.join(dir, f)).isFile(); } catch { return true; }
  });
}
const LIBASS_HINT = '视频区不显示字幕：缺少 libass 渲染器。'
  + '请在本项目根目录运行  node editor/scripts/fetch-vendor.js  '
  + '（约 18MB；生成后本提示会自动消失，不用重启）';
/* 代码版本戳: 取 editor 下静态资源的最新修改时间。
 * 用途: ① index.html 里的 js/css 引用带上 ?v=<戳>, 改了代码刷新必定拿到新的;
 *      ② /api/version 让**已经开着的页面**发现自己过期了 → 提示用户刷新。
 * (用户报过"改了代码但界面还是老的": 单页应用开着不刷新就一直跑旧 JS)
 * 注意: 版本戳**每 10 秒重算一次** —— 以前是启动时算一次, 结果"改了前端文件但
 * 没重启服务"时 ?v= 不变, 浏览器一直命中旧缓存, 刷新也拿到旧 JS(实测踩过)。 */
function computeStamp() {
  let newest = 0;
  const scan = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'vendor' || e.name === 'node_modules') continue;
        scan(p);
      } else {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch {}
      }
    }
  };
  scan(path.join(ROOT, 'editor'));
  return newest ? String(Math.floor(newest)) : '0';
}
let BUILD_STAMP = computeStamp();
setInterval(() => { BUILD_STAMP = computeStamp(); }, 10000).unref();

/* 给静态资源打版本戳 + 在 HTML 里埋入页面自身的戳, 解决"改了代码界面还是老的" */
function stampUrl(url) {
  if (url.includes('?') || /^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('#')) return url;
  if (/\.(js|css)(\?|$)/i.test(url)) return url + '?v=' + BUILD_STAMP;
  return url;
}
function stampHtml(html) {
  let out = html
    .replace(/(src\s*=\s*["'])([^"']+?)(["'])/gi, (m, p1, url, p2) => p1 + stampUrl(url) + p2)
    .replace(/(href\s*=\s*["'])([^"']+?)(["'])/gi, (m, p1, url, p2) => p1 + stampUrl(url) + p2);
  const inject = '<meta name="build-stamp" content="' + BUILD_STAMP + '"><script>window.__BUILD_STAMP="' + BUILD_STAMP + '";</script>';
  return out.includes('</head>') ? out.replace('</head>', inject + '</head>') : (inject + out);
}
function stampJs(code) {
  // 仅给相对路径的 import/export 规范符加戳(裸模块名不动)
  return code.replace(/(\b(?:from|import)\b\s*\(?\s*(["']))(\.\.?\/[^"']+?)(\2)/g,
    (m, pre, q, spec, post) => pre + (spec.includes('?') ? spec : spec + '?v=' + BUILD_STAMP) + post);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.mkv', '.avi', '.mov'];
const SUB_EXTS = ['.srt', '.ass', '.ssa'];

/* /api/media 视频路径登记表(本地服务安全基线的一部分):
 * 只服务"登记过"的路径 —— 项目 meta 里记录过的(见 writeMeta), 或本进程内经对话框/上传通道
 * 返回过的。早先的实现按任意绝对路径直接读盘, 本机任意页面/进程都能借此把磁盘上的视频读走。 */
const MEDIA_ALLOW = new Set();
const mediaKey = (p) => {
  const n = path.normalize(String(p || '').trim());
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

/* 把 URL 路径安全地映射到 root 下的文件路径, 越界返回 null。
 * 注意 decodeURIComponent 在 path 之前: new URL() 不会解码 %2f, 所以 "/..%2f" 能带着
 * 编码斜杠进到这里, 必须先解码再交给 path.join 归一化, 否则 ../ 会被当普通字符放过。 */
function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { return null; }               // 非法百分号编码(如 /%zz) → 视为越界
  const p = path.normalize(path.join(root, decoded));
  // 防目录穿越: 纯前缀匹配不够 —— "D:\SubFabric-secret" 也 startsWith "D:\SubFabric",
  // 会把同前缀的兄弟目录放行。必须补上路径分隔符做边界(同serveFile 里的 jsDir 写法)。
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

/* ── 波形图: ffmpeg 直读视频音轨生成 PNG; 视频不在服务端留任何副本 ──
 * 注: 本机 ffmpeg 构建对管道不流式输出进度(showwavespic 仅 1 个输出帧), 因此进度由客户端计时提示 */
/** 工具解析: 环境变量 → 常见安装位置 → 交给 PATH */
function resolveTool(envKey, common) {
  if (process.env[envKey]) return process.env[envKey];
  for (const c of common) { try { fs.accessSync(c); return c; } catch {} }
  return null;
}
const FFMPEG = resolveTool('FFMPEG_PATH', ['D:/Program Files/ffmpeg/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe']) || 'ffmpeg';
const FFPROBE = resolveTool('FFPROBE_PATH', ['D:/Program Files/ffmpeg/bin/ffprobe.exe', 'C:/ffmpeg/bin/ffprobe.exe']) || 'ffprobe';

/** 波形 PNG 宽度: 按时长自适应(约 0.25s/像素), 上限 32000(浏览器单边安全上限)。
 *  固定 2400px 时 2.4h 视频每像素 3.5s, 3 秒的字幕块只切到不到 1 个源像素 →
 *  被横向拉成"平顶柱子"(实测块内起伏系数 0.000); 32000px 后同样 3 秒块有 11 个源像素。 */
function waveWidth(duration) {
  const d = duration > 0 ? duration : 600;
  return Math.max(2400, Math.min(32000, Math.round(d * 4)));
}

/** dur 参数缺失/为 0 时(客户端元数据未就绪)用 ffprobe 探测时长, 保证分辨率自适应 */
function probeDuration(videoPath, cb) {
  const p = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { windowsHide: true });
  let out = '';
  let settled = false;                       // spawn 失败时 error 与 close 都会到, 回调只允许落一次
  const finish = (v) => { if (!settled) { settled = true; cb(v); } };
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => cb(0));
  p.on('close', () => { const v = parseFloat(String(out).trim()); cb(isFinite(v) && v > 0 ? v : 0); });
  setTimeout(() => { try { p.kill(); } catch {} }, 15000);
}

/** 对给定视频路径生成波形 PNG(临时文件用完即删), 完成后回调 (err, pngBuffer)。
 *  buildArgs(tmpPng) 返回 ffmpeg 参数; ffmpeg 首次调用偶发失败, 自动重试一次。 */
function renderWaveform(buildArgs, cb, _retry) {
  const tmpPng = path.join(os.tmpdir(), 'ss-wave-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png');
  const proc = spawn(FFMPEG, buildArgs(tmpPng), { windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
  let settled = false;          // error/close/超时可能接连到达(如 kill 之后 close), 收尾只允许一次
  const done = (err) => {
    if (settled) return;
    settled = true;
    fs.unlink(tmpPng, () => {});
    if (err && !_retry) {
      console.log('[waveform] ffmpeg 失败，重试一次：', String(err.message || err).slice(0, 200));
      return setTimeout(() => renderWaveform(buildArgs, cb, true), 400);
    }
    if (err) return cb(err);
    fs.readFile(tmpPng, (e2, buf) => {
      fs.unlink(tmpPng, () => {});
      if (e2) return cb(new Error('waveform read failed'));
      cb(null, buf);
    });
  };
  const timer = setTimeout(() => { try { proc.kill(); } catch {} done(new Error('ffmpeg timeout')); }, 600000);
  proc.on('error', (e) => { clearTimeout(timer); done(new Error('ffmpeg 不可用: ' + e.message)); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) return done(new Error('ffmpeg failed: ' + stderr.slice(-300)));
    done(null);
  });
}

/** 整段波形(仅在拿不到 peaks 时的兜底): -vn 跳过视频解码(只解音轨)。
 *  振幅处理曾用 `volume=18dB` —— 固定 +18dB 会让正常电平的素材直接过载削顶,
 *  画出来是一条实心带(与 peaks 旧版同一个病)。这里换成 **alimiter 软限幅**:
 *  先温和提升 +12dB, 再由 alimiter 兜住峰值(软拐点, 不硬削), 保住起伏。
 *  真正的分辨率由 peaks 通道提供, PNG 只是兜底, 不追求完美。 */
function makeWaveform(videoPath, duration, cb, _retry) {
  if (!(duration > 0)) return probeDuration(videoPath, (dur) => makeWaveform(videoPath, dur, cb, _retry));
  const w = waveWidth(duration);
  renderWaveform((tmp) => ['-hide_banner', '-vn', '-i', videoPath,
    '-filter_complex', `volume=12dB,alimiter=limit=0.95:level=false,showwavespic=s=${w}x160:colors=FFFFFF:scale=sqrt`,
    '-frames:v', '1', '-y', tmp], cb);
}

/** 区间细节波形不再需要(峰值数据方案已覆盖任意缩放) */

/** 区间细节波形不再需要(改为峰值数据方案), 保留整段 PNG 作为兜底 */
function waveformFromTemp(req, res, duration) {
  const tmpVideo = path.join(os.tmpdir(), 'ss-video-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const out = fs.createWriteStream(tmpVideo);
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 32 * 1024 * 1024 * 1024) req.destroy(); });
  req.on('error', () => { out.destroy(); fs.unlink(tmpVideo, () => {}); });
  req.on('end', () => { out.end(); });
  out.on('finish', () => {
    makeWaveform(tmpVideo, duration, (err, buf) => {
      fs.unlink(tmpVideo, () => {});   // 立即删除临时视频(服务端不保存)
      if (err) return send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, String(err.message || err));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      res.end(buf);
    });
  });
  req.pipe(out);
}

/* ── 峰值数据(推荐方案): 每 1/rate 秒一桶, **min/max 双通道**(Uint8, 128=零位),
 *    前端按屏幕像素列矢量绘制 → 任意缩放都锐利, 不会像缩放图片那样发糊 ──
 *
 * 为什么是 min/max 而不是"绝对峰值单通道":
 *   真实波形上下不对称(语音的基频与谐波让正负峰不等高)。只存绝对峰值会把它
 *   画成上下对称的"条形图", 丢掉形态信息; 存 min/max 才能画出真正的包络。
 *
 * 为什么不用固定增益(历史踩坑):
 *   旧实现是 `min(1, peak/32768 * 7.943)` 再 `255*sqrt()` —— 固定 +18dB 撞上
 *   硬钳位, 实测把 **9.8% 的桶钉死在 255**, 有声段动态范围只剩 6.3dB,
 *   画出来是一坨实心带、完全看不出起伏(线性只占 4% 高度是靠"无限拉增益"换来的,
 *   代价就是削顶)。sqrt 还会把弱音整体抬起来, 进一步抹平弱强差异。
 *   现在改为**按素材自适应**: 取 p99.5 分位数当参考电平归一到 0.95,
 *   安静素材自动放大、响亮素材自动压小, 且不硬削。 */
const PEAK_SR = 8000;          // 单声道 8kHz 足够画包络
const PEAK_VER = 2;            // 包络格式版本: 1=旧的单通道abs峰值(已削顶, 需重算), 2=min/max+自适应归一化
const PEAK_REF_PCT = 0.995;   // 参考电平取 p99.5 分位数(抗个别爆音拉低整体增益)
const PEAK_TARGET = 0.95;     // 参考电平映射到 0.95, 留 5% 头顶避免瞬态再削顶

/** 把线性 min/max 包络(0..1)按 p99.5 归一到 0..255, 编成带符号字节(128=零位)。 */
function encodeEnvelope(lo, hi, filled) {
  // ① 先算参考电平: 取所有桶里 |v| 的 p99.5 分位数
  const abs = new Float32Array(filled);
  for (let i = 0; i < filled; i++) {
    const a = hi[i] < 0 ? -hi[i] : hi[i];
    const b = lo[i] < 0 ? -lo[i] : lo[i];
    abs[i] = a > b ? a : b;
  }
  const sorted = Array.prototype.slice.call(abs).sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * PEAK_REF_PCT))] || 1;
  const k = ref > 0 ? PEAK_TARGET / ref : 1;
  // ② 编成 min/max 双通道(128=零位); 用 round 而不是截断, 弱音也能分出灰阶
  const out = Buffer.allocUnsafe(filled * 2);
  for (let i = 0; i < filled; i++) {
    const l = Math.max(-1, Math.min(1, lo[i] * k));
    const h = Math.max(-1, Math.min(1, hi[i] * k));
    out[i * 2] = Math.max(0, Math.min(255, Math.round(128 + l * 127)));
    out[i * 2 + 1] = Math.max(0, Math.min(255, Math.round(128 + h * 127)));
  }
  return out;
}

/** 峰值分桶采集器: 从 s16le 单声道 PCM 流(inSr 采样率)按 1/rate 秒一桶取 min/max 包络。
 *  返回 finish(code, stderr) — 流结束后调用, 返回 {buf, code, stderr}(buf = min/max 双通道)。
 *
 *  total 只是**预分配容量**(有下限/上限防内存爆), 真正决定桶数的是 spb。
 *  spb 必须按 duration/rate 算, **不能**按 total 算:
 *    30s 音频 @rate=100 只需 3000 桶, 但 total 被下限 clamp 到 20000;
 *    若 spb = duration*inSr/total, 就会切出 20000 桶 → 覆盖 200 秒,
 *    而实际音频只有 30 秒 → 前端按 rate 换算时间轴时波形被压到左侧 15%,
 *    整个波形与时间轴错位。(旧实现也有这个隐患, 只是单通道时不易察觉。) */
function attachPeakCollector(readable, duration, rate, inSr) {
  const dur = duration > 0 ? duration : 600;
  const total = Math.max(20000, Math.min(2000000, Math.round(dur * rate)));   // 仅预分配
  const spb = dur * inSr / (dur * rate);                                       // = inSr/rate, 按真实桶密度
  const lo = new Float32Array(total), hi = new Float32Array(total);
  let filled = 0, mn = 0, mx = 0, inBucket = 0, carry = null, touched = false;
  const flush = () => {
    if (filled < total) { lo[filled] = mn; hi[filled] = mx; filled++; }
    mn = 0; mx = 0; inBucket = 0; touched = false;
  };
  readable.on('data', (chunk) => {
    let buf = chunk;
    if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
    const n = buf.length >> 1;
    if (buf.length & 1) carry = buf.subarray(buf.length - 1);
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2) / 32768;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      touched = true;
      if (++inBucket >= spb) flush();
    }
  });
  return (code, stderr) => {
    if (touched && (inBucket > 0 || mx > 0 || mn < 0)) flush();
    return { buf: encodeEnvelope(lo, hi, filled), code, stderr };
  };
}

function buildPeaks(videoPath, duration, rate, cb) {
  const proc = spawn(FFMPEG, ['-hide_banner', '-vn', '-i', videoPath,
    '-f', 's16le', '-ac', '1', '-ar', String(PEAK_SR), '-'], { windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', d => { if (stderr.length < 2000) stderr += d; });
  proc.on('error', (e) => cb(new Error('ffmpeg 不可用: ' + e.message)));
  const finish = attachPeakCollector(proc.stdout, duration, rate, PEAK_SR);
  proc.on('close', (code) => {
    const r = finish(code, stderr);
    if (r.code !== 0) return cb(new Error('ffmpeg failed: ' + String(r.stderr).slice(-200)));
    cb(null, r.buf);
  });
}

function sendPeaks(res, buf, rate) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': buf.length,
    'X-Peak-Rate': String(rate),
    'X-Peak-Ver': String(PEAK_VER),      // 前端据此判断能否按 min/max 双通道解读
    'X-Peak-Ch': '2'                     // 每桶字节数: 2 = [min,max]
  });
  res.end(buf);
}

/** 本地上传视频: 生成峰值后立即删除临时文件(不保存视频) */
function peaksFromTemp(req, res, duration, rate) {
  const tmpVideo = path.join(os.tmpdir(), 'ss-video-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const out = fs.createWriteStream(tmpVideo);
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 32 * 1024 * 1024 * 1024) req.destroy(); });
  req.on('error', () => { out.destroy(); fs.unlink(tmpVideo, () => {}); });
  req.on('end', () => out.end());
  out.on('finish', () => {
    buildPeaks(tmpVideo, duration, rate, (err, buf) => {
      fs.unlink(tmpVideo, () => {});   // 立即删除临时视频
      if (err) return send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, String(err.message || err));
      sendPeaks(res, buf, rate);
    });
  });
  req.pipe(out);
}

function listSamples() {
  const videos = [];
  const subs = [];
  for (const name of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (VIDEO_EXTS.includes(ext)) videos.push({ name, url: '/' + encodeURIComponent(name), size: st.size });
    else if (SUB_EXTS.includes(ext)) subs.push({ name, url: '/' + encodeURIComponent(name), size: st.size, kind: ext.slice(1) });
  }
  return { videos, subs };
}

function send(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}

/** JSON 响应快捷方式。模块级函数声明(有提升): 部分路由在它旧定义点之前就 return,
 *  若用 const 会因 TDZ 在异步回调里炸 ReferenceError(upload-video 踩过这个坑) */
function sendJson(res, code, obj) {
  send(res, code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, JSON.stringify(obj));
}

function serveFile(req, res, filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, '404 Not Found'); }
  if (stat.isDirectory()) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // HTML / 自有 JS: 注入版本戳, 让"改了代码→刷新必拿新版" + 已开页面能发现自己过期
  if (ext === '.html') {
    let html;
    try { html = fs.readFileSync(filePath, 'utf8'); } catch { return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'read error'); }
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, stampHtml(html));
  }
  const jsDir = path.join(ROOT, 'editor', 'js');
  if (ext === '.js' && (filePath === jsDir || filePath.startsWith(jsDir + path.sep))) {
    let code;
    try { code = fs.readFileSync(filePath, 'utf8'); } catch { return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'read error'); }
    return send(res, 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }, stampJs(code));
  }

  const total = stat.size;
  const range = req.headers.range;

  // 小文件 / 文本直接整体返回(禁用缓存,便于编辑后立即重载)
  const noCache = { 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
      if (start === null) start = 0;
      if (end === null || end > total - 1) end = total - 1;
      if (start > end || start >= total) {
        return send(res, 416, { 'Content-Range': `bytes */${total}` }, 'Requested Range Not Satisfiable');
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, Object.assign({
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': chunkSize
      }, noCache));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': total }, noCache));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

/* ═══════════ 项目系统 · 跨请求状态 ═══════════
 * prepareJobs 必须放模块作用域: 若放进下方请求回调, 每个请求都会得到新的空 Set,
 * metaView 会把一切 running 中的提取误判为「服务已重启，提取被中断」。 */
const prepareJobs = new Set();   // 正在跑 prepare 的项目 id(进程内; 服务重启后视为中断)

/* ═══════════ 初稿流水线(ASR) ═══════════
 * 流水线 = 提取音频+波形(startPrepare) → asr.py 语音识别 → 生成初稿字幕。
 * 与 prepareJobs 同理: 这两个容器必须在模块作用域, 放进请求回调会得到新的空容器,
 * 导致运行中的任务被误判为「服务已重启而中断」。 */
const draftJobs = new Set();     // 正在跑"提取之后"阶段的项目 id
const draftProcs = new Map();    // 项目 id → 正在跑的识别子进程(ChildProcess), 删项目/重跑时精确清理
const draftAborts = new Map();   // 项目 id → AbortController(云端识别没有子进程, 靠它取消)
const pendingAsr = new Map();    // prepare 成功后待跑识别的项目 id -> { wordLevel }
const rerecogJobs = new Map();   // 选区重新识别的后台任务: projectId -> job
/* ⚠ 全片逐词重校对的作业也属于这一类。一开始把它写在 handleRequest 里
 *   （`const realignJobs = new Map()`），结果 POST 里 set 成功（size=1）
 *   而紧接着的 GET 读到 size=0 —— 同一进程同一秒、代码里没有任何 delete/clear。
 *   就是本段注释说的"每个请求得到新的空容器"。
 *   教训：**凡是跨请求的作业状态，一律放这一段。** */
const realignJobs = new Map();   // 全片逐词重校对: projectId -> job

const ASR_DIR = path.join(ROOT, 'asr');
const modelsRoot = () => {
  // 用户可在设置里指定模型下载根目录(settings.json 的 modelsRoot 字段); 未指定 → 程序自带目录
  try {
    const mr = readAsrSettings().modelsRoot;
    if (mr && typeof mr === 'string' && mr.trim()) return path.normalize(mr.trim());
  } catch {}
  return path.join(ASR_DIR, 'models');
};
const ASR_SCRIPT = path.join(ASR_DIR, 'asr.py');
const ASR_SETTINGS = path.join(ASR_DIR, 'settings.json');
const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '');

/* 可选识别模型。engine 决定推理方式:
 *   sherpa-onnx  → asr.py(sherpa-onnx, CUDA GPU)
 *   whisper.cpp  → whisper-cli.exe(-oj -ml 1 -sow 词级时间戳)；Vulkan GPU 跑, A 卡/N 卡/Intel 通吃
 *   nemo         → multitalker.py(PyTorch + NeMo, CUDA GPU 专属)
 * 各引擎的 GPU 要求由 asrGpuGateError 逐个校验 —— 都只在 GPU 上推理, 不做 CPU 兜底。
 * draftAllowed:false 的模型**不能创建初稿**, 只能在「选区重新识别」里用。 */
const ASR_MODELS = [
  {
    id: 'parakeet-tdt-0.6b-v2',
    name: 'Parakeet TDT 0.6B v2（英语·快）',
    engine: 'sherpa-onnx',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: ['tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx'],
    sizeMB: 661,
    desc: 'CUDA GPU（N 卡）推理，无 N 卡或 CUDA 环境不可用会直接报错（不支持 CPU）；仅英语',
    dirName: 'parakeet-tdt-0.6b-v2',
    draftAllowed: true,
  },
  {
    id: 'ggml-large-v3-turbo',
    name: 'Whisper large-v3-turbo（英语·质量优先）',
    engine: 'whisper.cpp',
    repo: 'ggerganov/whisper.cpp',
    files: ['ggml-large-v3-turbo.bin'],
    sizeMB: 1549,
    desc: 'whisper.cpp 引擎 + Vulkan GPU：A 卡 / N 卡 / Intel 核显都走 GPU 加速（实测 RTX 4060 Ti 快约 126 倍）；无 Vulkan 驱动直接报错（不支持 CPU）。质量接近 large-v3。',
    dirName: 'ggml-large-v3-turbo',
    draftAllowed: true,
  },
  {
    id: 'multitalker-parakeet-streaming-0.6b-v1',
    name: 'Multitalker Parakeet Streaming 0.6B v1（多说话人·仅重新识别）',
    engine: 'nemo',
    repo: 'nvidia/multitalker-parakeet-streaming-0.6b-v1',
    // 除主权重外还要官方流式分离模型: NeMo 的 SpeakerTaggedASR **即使单说话人模式也要 diar_model 对象**
    // (它读 diar_model._cfg.max_num_of_spks), 所以这 450MB 是必需项, 不是可选项。
    files: ['multitalker-parakeet-streaming-0.6b-v1.nemo', 'multitalker_transcript_config.py',
            'diar_streaming_sortformer_4spk-v2.1.nemo'],
    fileRepos: { 'diar_streaming_sortformer_4spk-v2.1.nemo': 'nvidia/diar_streaming_sortformer_4spk-v2.1' },
    sizeMB: 2825,
    // 只能重新识别, 不能创建初稿 —— 见 draftAllowed
    desc: 'NVIDIA NeMo 流式多说话人 Parakeet（说话人核注入，一次识别就能区分同时说话的多个说话人）。仅 N 卡可用：必须 CUDA GPU，CPU 推理直接报错；只用于「重新识别」，不能创建初稿。权重约 2.3GB，另需 PyTorch + NeMo 运行时（设置里单独安装）',
    dirName: 'multitalker-parakeet-streaming-0.6b-v1',
    draftAllowed: false,
  },
  {
    // 与上面 sherpa-onnx 那条**同一份权重、同一套后处理**, 只换推理后端: 走 OpenVINO,
    // 编码器吃 Intel NPU、预测/联合网络吃核显 —— 于是**没有 N 卡也能用 Parakeet**
    // (sherpa-onnx 那条是 CUDA provider, 官方明确不支持 CPU, 核显/NPU 机器完全用不了)。
    // 模型取自 istupakov/parakeet-tdt-0.6b-v2-onnx(即 NVIDIA parakeet-tdt-0.6b-v2 的参考 ONNX 导出)。
    id: 'parakeet-tdt-0.6b-v2-npu',
    name: 'Parakeet TDT 0.6B v2（英语·Intel NPU）',
    engine: 'openvino',
    repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
    files: ['encoder-model.onnx', 'encoder-model.onnx.data', 'decoder_joint-model.onnx', 'vocab.txt'],
    sizeMB: 2390,
    desc: 'OpenVINO 推理：编码器跑 Intel NPU、预测/联合网络跑核显，没有独显的机器也能用（无需 CUDA）。仅英语；需要 Intel NPU/AI Boost 驱动，NPU 不可用时自动退核显/CPU。首次识别要编译计算图（约 1~3 分钟），之后走缓存几秒',
    dirName: 'parakeet-tdt-0.6b-v2-npu',
    draftAllowed: true,
  },
    {
      // 双引擎：把音频切成多个分片，**同时**交给 NPU 引擎与 GPU(N 卡) 引擎识别，再按时间合并。
      // 两边落在不同硬件上（NPU + Intel 核显 vs N 卡），互不抢占，实测比单引擎快约 1.5~1.7 倍。
      // 依赖两套模型都在（OpenVINO 那套 + sherpa int8 那套），缺任一都不给选（见 alsoNeeds）。
      // 分工比例与分片长度可在「设置 → 性能测试」实测得出，也可手动指定（见 /api/asr/dual）。
      id: 'parakeet-tdt-0.6b-v2-dual',
      name: 'Parakeet TDT 0.6B v2（英语·NPU+GPU 双引擎）',
      engine: 'dual',
      repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
      files: ['encoder-model.onnx', 'encoder-model.onnx.data',
              'decoder_joint-model.onnx', 'vocab.txt'],
      sizeMB: 2390,
      desc: '把音频切片后**同时**交给 Intel NPU 与 N 卡两个引擎识别，再合并时间轴；实测比只用其中一个快约 1.5~1.7 倍。需要两套模型都已下载（NPU 那套 + 「英语·快」那套）。分工比例可在「设置 → 性能测试」实测，也可手动指定',
      dirName: 'parakeet-tdt-0.6b-v2-npu',
      draftAllowed: true,
      alsoNeeds: 'parakeet-tdt-0.6b-v2',
    },
  {
    // 云端识别: 没有本地模型文件、不需要显卡, 只要联网。音频会上传到第三方服务器 —— 由用户在模型下拉里
    // **显式选择**, 绝不作为"本地没装模型"时的兜底（见 resolveAsrModel）。
    // 两个云端引擎(必剪/剪映)互为备份: 免费云端普遍限次/限流, 一个不行就换另一个（见 transcribeCloud）。
    id: 'bcut-asr',
    name: '必剪 ASR（英语·云端免下载）',
    engine: 'bcut',
    cloud: true,
    files: [],
    sizeMB: 0,
    desc: '调用必剪（B 站）云端识别：不用装模型，也不用显卡。13 秒英文音频实测 3 秒返回逐词时间戳。只支持英语，需要联网，音频会上传到 bilibili 服务器，机密素材不要用',
    dirName: '',
    draftAllowed: true,
  },
  {
    id: 'capcut-asr',
    name: '剪映 ASR（英语·云端免下载）',
    engine: 'capcut',
    cloud: true,
    files: [],
    sizeMB: 0,
    desc: '调用剪映（CapCut）云端识别：同样不用装模型、不用显卡。13 秒英文音频实测 3 秒返回逐词时间戳。只支持英语，需要联网，音频会上传到字节跳动服务器，机密素材不要用。与「必剪 ASR」互为备份：一个限流或失败会自动换另一个',
    dirName: '',
    draftAllowed: true,
  },
];
const modelById = (id) => ASR_MODELS.find(m => m.id === id) || null;
/** 能否用于创建初稿(默认可以; draftAllowed===false 的模型只给「重新识别」用) */
const draftAllowedOf = (m) => !!m && m.draftAllowed !== false;

/* 说话人分离模型(两个文件一组): 跑在音频上, 与识别引擎无关 —— 两个 ASR 模型都能用 */
const DIARIZE_MODELS = [
  {
    id: 'pyannote-segmentation-3-0', name: '说话人分段模型',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
    file: 'model.onnx', sizeMB: 7, archive: true,
    inner: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
  },
  {
    id: 'eres2net-sv-en-voxceleb', name: '说话人嵌入模型（英语）',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
    file: 'speaker-embedding.onnx', sizeMB: 26,
  },
];
const DIARIZE_DIR = () => path.join(ASR_DIR, 'models', 'diarize');
const diarizeReady = () => DIARIZE_MODELS.every(m => { try { return fs.statSync(path.join(DIARIZE_DIR(), m.file)).isFile(); } catch { return false; } });

/* whisper.cpp 运行时: 用 ggml 模型才需要。
 * 用第三方预编译的 **Vulkan 版**(ggml-vulkan.dll, 55MB) —— 官方 release 无 GPU 包,
 * 而 Vulkan 版 A 卡/N 卡/Intel 核显通吃(实测 RTX 4060 Ti: encode 20.2s → 0.16s, 126 倍)。
 * 运行时检测到 Vulkan DLL 自动走 GPU; 没有 Vulkan 驱动的机器直接报错(不做 CPU 兜底, ASR 必须 GPU)。 */
const WHISPER_RUNTIME = {
  url: 'https://github.com/jerryshell/whisper.cpp-windows-vulkan-bin/releases/download/v1.0.0/whisper.cpp-windows-vulkan.zip',
  dir: path.join(ASR_DIR, 'whisper.cpp'),
  sizeMB: 18,
};
const whisperCli = () => path.join(WHISPER_RUNTIME.dir, 'whisper-cli.exe');
const whisperRuntimeOk = () => { try { return fs.statSync(whisperCli()).isFile(); } catch { return false; } };
const whisperVulkanOk = () => { try { return fs.statSync(path.join(WHISPER_RUNTIME.dir, 'ggml-vulkan.dll')).isFile(); } catch { return false; } };

/** ASR 必须 GPU: 不做 CPU 兜底。三个引擎各查各的 GPU 依赖, 不满足返回报错文案(null = 通过)。
 *  whisper.cpp → 必须有 Vulkan 运行库(ggml-vulkan.dll); sherpa-onnx → 必须是 CUDA 版(安装器实测后写入 settings);
 *  nemo(multitalker) → 必须有 PyTorch + NeMo, 且 torch 认到 CUDA —— 它**只认 N 卡**, 别的 GPU 也不行。
 *  provider==='cuda' 本身不保证运行时能起来, 但那是安装器 import 实测过的结果 —— 运行时问题交给脚本报详细错。 */
function asrGpuGateError(model) {
  // 云端识别在本机不做任何推理 —— 它不需要 GPU(与三个本地引擎的要求正好相反)
  if (model && model.cloud) return null;
  // OpenVINO(NPU) 后端与 sherpa-onnx 正好相反: 它**不**要求 CUDA —— 编码器跑 Intel NPU、
  // 预测/联合网络跑核显, 设备不可用时 asr_npu.py 自己逐级回退(GPU→CPU)并在日志里写明。
  // 所以这里不能套用下面"必须是 CUDA 版 sherpa-onnx"的那条判断, 否则没有 N 卡的机器
  // 会在创建初稿前就被挡下来。
  if (model && model.engine === 'openvino') return null;
  if (model && model.engine === 'whisper.cpp') {
    if (!whisperRuntimeOk()) return 'whisper.cpp 运行时没装好，到「设置 → 识别模型」下载';
    if (!whisperVulkanOk()) return '未检测到 Vulkan 运行库（ggml-vulkan.dll）。语音识别不支持纯 CPU，要装/更新支持 Vulkan 的显卡驱动，或在设置里重新下载 whisper.cpp 运行时';
    return null;
  }
  if (model && model.engine === 'nemo') {
    const n = nemoProbeCache;
    if (!n || !n.ok) {
      return '「' + model.name + '」需要 NeMo 运行时（PyTorch + NeMo）。到「设置 → 识别模型 → NeMo 运行时（多说话人）」点「安装」，约 5GB，需 N 卡。'
        + (n && n.msg ? '（当前预检：' + n.msg + '）' : '');
    }
    if (!n.cuda) {
      return '「' + model.name + '」没启用 GPU·CUDA（当前是 CPU 版 PyTorch），该模型只能在 NVIDIA 显卡上跑。'
        + (n.gpu ? '' : '未检测到 NVIDIA 显卡；') + '到设置里点「重新安装 NeMo 运行时」，装 CUDA 版 PyTorch。';
    }
    return null;
  }
  if (asrProvider() !== 'cuda') {
    return 'Parakeet 当前是 CPU 推理，语音识别不支持纯 CPU。到「设置 → 识别模型 → Python 环境」点「安装」，换装 CUDA 版 sherpa-onnx（需 N 卡）';
  }
  return null;
}

/* ═══════════ NeMo 运行时(仅 multitalker 模型需要) ═══════════
 * 与 sherpa-onnx 是两套依赖: 前者只要 sherpa-onnx+numpy(约 200MB), 后者要 PyTorch+NeMo(约 5GB)。
 * 所以单独装、单独探测: 设置里一个独立的「NeMo 运行时」条目, 装好之后 multitalker 模型才可用。 */
const NEMO_SCRIPT = path.join(ASR_DIR, 'multitalker.py');
const NEMO_PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const NEMO_NOTE = 'need-pytorch-nemo';
let nemoProbeCache = null;
let nemoProbeInflight = null;    // 在途探测(见下)
/** 探一次 NeMo 运行时: torch / nemo.collections.asr 能否导入 + CUDA 是否可用。结果缓存 5 分钟。
 *  import nemo.collections.asr 要拉 torch, 首次可能要几十秒 —— 与 Python 预检一样放后台跑, 别堵接口。
 *  **在途复用**: 设置面板每秒轮询状态页, 若每次都新起一个进程, 几十秒的导入期里会并发几十个 python;
 *  所以同一时刻只允许一个探测在跑, 其余调用共享它的结果。 */
function probeNemo(force) {
  if (!force && nemoProbeCache && Date.now() - nemoProbeCache.at < 5 * 60 * 1000) return Promise.resolve(nemoProbeCache);
  if (!force && nemoProbeInflight) return nemoProbeInflight;
  const p = new Promise((resolve) => {
    const code = 'import json, torch;'
      + 'info={"torch": torch.__version__, "cuda": bool(torch.cuda.is_available())};'
      + 'info["gpu"]=torch.cuda.get_device_name(0) if info["cuda"] else "";'
      + 'import nemo.collections.asr as na;'
      + 'info["nemo"]=getattr(na, "__version__", "") or "ok";'
      + 'print(json.dumps(info))';
    const p = spawn(ASR_PY, ['-c', code], { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
    let out = '', err = '';
    const done = (r) => { clearTimeout(timer); nemoProbeCache = Object.assign({ at: Date.now() }, r); resolve(nemoProbeCache); };
    const timer = setTimeout(() => { try { p.kill(); } catch {} done({ ok: false, cuda: false, msg: '预检超时（180s）' }); }, 180000);
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('error', e => done({ ok: false, cuda: false, msg: '无法启动 ' + ASR_PY + '：' + e.message }));
    p.on('close', (code) => {
      if (code === 0) {
        let info = null;
        try { info = JSON.parse(out.trim().split('\n').pop()); } catch {}
        if (info) return done({
          ok: true, cuda: !!info.cuda, gpu: info.gpu || '', torch: info.torch || '', nemo: info.nemo || '',
          msg: 'PyTorch ' + info.torch + ' / NeMo ' + (info.nemo || 'ok'),
        });
      }
      const detail = err.trim().split('\n').filter(Boolean).pop() || '';
      done({ ok: false, cuda: false, msg: (code === 0 ? '输出解析失败' : asrExitHint(code)) + (detail ? ' —— ' + detail.slice(0, 200) : '') });
    });
  });
  nemoProbeInflight = p.finally(() => { nemoProbeInflight = null; });
  return p;
}

/* 初稿流水线阶段名(项目列表上直接显示这个文案)。
 * diarize / reseg(语义分句, 所有引擎都走) 均已实现。 */
const STAGE = {
  extract: '提取音频中',
  asr: 'ASR识别中',
  diarize: '区分说话人中',
  cast: '分角色中',
  reseg: '语义分句中',
  translate: '翻译中',
  done: '完毕',
};

// 用户手动续跑满这么多次仍不成功, 就放开「跳过此步」(LLM 偶发怎么重试都不对, 得留条出路)
const SKIP_AFTER_RETRIES = 3;

/* 说话人角色色板(轮转使用): #RRGGBB, 写进中文行行首色标 —— 编辑器的角色色来源 */
const ROLE_PALETTE = ['#ff00d0', '#00b0f0', '#ffb400', '#00d26a', '#b066ff', '#ff5f6b', '#00e0b0', '#c2c2c2'];
/** '#RRGGBB' → ASS 的 'BBGGRR'(裸 6 位 hex) —— 与编辑器 hexToAss 一致, 用法 {\c&HBBGGRR&} */
function assColorFromRgb(hex) {
  const n = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return 'FFFFFF';
  return n.slice(4, 6) + n.slice(2, 4) + n.slice(0, 2);
}
/** 按重叠最大的分离片段给每段 ASR 结果指派说话人, 并重排为 0 起始的 SPK1..N(按出现顺序) */
function assignSpeakers(segments, regions) {
  for (const s of segments) {
    let best = -1, bestOv = 0;
    for (const r of regions) {
      const ov = Math.min(s.end, r.end) - Math.max(s.start, r.start);
      if (ov > bestOv) { bestOv = ov; best = r.speaker; }
    }
    s.speaker = best >= 0 ? best : 0;
  }
  const order = new Map();
  for (const s of segments) {
    if (!order.has(s.speaker)) order.set(s.speaker, order.size);
    s.speaker = order.get(s.speaker);
  }
  return segments;
}

/* 翻译(LLM): 全部服务端发起, 便于把进度写进项目列表。
 * 预设只给常见的 OpenAI 兼容端点; 选 custom 时三项都自己填。 */
const LLM_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', name: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
  // 本地模型：不联网、不需要 API Key。真正的实现在 editor/mt-local.js（CTranslate2 + NLLB），
  // 这里只是一条"让下拉框能选到它"的记录 —— baseUrl/model 留空，llmReady 对它有单独判断。
  { id: 'nllb-local', name: '本地模型 NLLB-200（不联网·用 GPU）', baseUrl: '', model: 'nllb-200-distilled-600M-ct2-int8', local: true },
];
const DEFAULT_TRANSLATE_PROMPT = [
  '你是字幕翻译专家。把用户给出的英文字幕逐行翻译成简体中文。',
  '严格要求：',
  '1) 只输出一个 JSON 数组，形如 ["译文1","译文2"]，不要任何解释或代码块；',
  '2) 数组元素个数必须与输入行数完全相同、顺序一一对应，禁止合并或拆分行；',
  '3) 人名、地名、组织名、作品名、缩写与 [方括号] 内的内容保留原文不译；',
  '4) 译文简洁自然，符合口语，不要逐字直译，不要加引号；',
  '5) 原文为空的行输出空字符串。',
].join('\n');

/** 双引擎的分工配置。ratio='auto' 用性能测试测出来的值（settings.dual），没测过退 1:1
 *  （实测两个引擎速度接近，1:1 是稳妥缺省）。joint 固定 GPU.0 = Intel 核显，**不占 N 卡** ——
 *  N 卡整块留给 sherpa 引擎，两个引擎才不会互相抢。 */
function dualCfg() {
  const s = readAsrSettings() || {};
  const d = s.dual || {};
  const manual = s.dualRatio || 'auto';
  let ratio = (manual && manual !== 'auto') ? manual : (d.ratio || '1:1');
  if (!/^\d+:\d+$/.test(ratio)) ratio = '1:1';
  let sliceSec = Number(d.sliceSec) || 15.01;
  if (!(sliceSec >= 4 && sliceSec <= 60)) sliceSec = 15.01;
  return { ratio: ratio, sliceSec: sliceSec, joint: 'GPU.0',
           source: (manual && manual !== 'auto') ? 'manual' : 'auto' };
}

/** 翻译(LLM)配置。API Key 与 fetch Cookie 同款处理（见 fetchSettings 的迁移逻辑）：
 *  ① 旧版**明文** apiKey 读完即迁成密文 apiKeyEnc 并清掉明文字段；
 *  ② 解密后的明文只用于服务端内部（llmReady / llmChat 等），**绝不回传前端**
 *     —— 对前端一律走 translateCfgPublic()，只回 hasKey。 */
function translateCfg() {
  const t = (readAsrSettings().translate) || {};
  const preset = LLM_PRESETS.find(p => p.id === t.provider) || null;
  let apiKey = String(t.apiKey || '');
  if (apiKey) {
    let enc = '';
    try { enc = secretStore.encrypt(apiKey); } catch (e) { console.error('[translate] API Key 加密失败:', e && e.message); }
    if (enc) {
      try {
        const s = readAsrSettings();
        s.translate = Object.assign({}, s.translate || {}, { apiKey: '', apiKeyEnc: enc });
        writeAsrSettings(s);
        console.log('[translate] API Key 已从明文迁移为密文（' + secretStore.backend() + '）');
      } catch (e) { console.error('[translate] API Key 迁移写盘失败:', e && e.message); }
    }
  } else if (t.apiKeyEnc) {
    try { apiKey = secretStore.decrypt(String(t.apiKeyEnc)); }
    catch (e) {
      console.error('[translate] API Key 解不开（换过机器或 Windows 用户？）：' + ((e && e.message) || e) + '。重新填一次 Key 就能恢复');
      apiKey = '';
    }
  }
  return {
    provider: t.provider || 'deepseek',
    baseUrl: t.baseUrl || (preset ? preset.baseUrl : ''),
    apiKey,
    model: t.model || (preset ? preset.model : ''),
    autoTranslate: t.autoTranslate !== false,
    prompt: t.prompt || DEFAULT_TRANSLATE_PROMPT,
    glossary: t.glossary || '',
    glossaryLang: t.glossaryLang || '简体',
    batchSize: llmText.clampBatchSize(t.batchSize),   // 每批行数(用户可调, 见「全局设置 → 字幕翻译」)
    hasKey: !!apiKey,
  };
}

/* ── 自动纠错用的 LLM 配置 ────────────────────────────────────────
 * 默认**跟随翻译配置**（用户不必配两遍）。想单独用别的模型时，在 asr/settings.json 的
 * correct 段覆盖 —— 典型用途：翻译用在线 API，纠错用**本地部署的模型**
 * （如 Qwen3 量化版，起一个 OpenAI 兼容服务后把 baseUrl 指到 http://127.0.0.1:11434/v1）。
 * 不新写抽象层：llmChat() 本来就只认 provider/baseUrl/apiKey/model 这几个字段。
 *
 * 「跟随翻译」到底是**显式开关**还是**靠空值推断** —— 这里踩过坑：
 * 曾经用"baseUrl 与 model 都为空 ⇒ 跟随翻译"来推断，于是用户取消勾选、
 * 还没填地址时，服务端又把它算回"跟随翻译"，勾选框被回弹、**根本取消不掉**。
 * 现在存显式的 correct.useTranslate；只有该字段不存在（旧配置）时才回退到推断。
 */
function correctUseTranslate(raw) {
  const t = raw || {};
  if (typeof t.useTranslate === 'boolean') return t.useTranslate;
  // 旧配置兼容：没有显式开关时，按"有没有自定义地址/模型"推断
  return !String(t.baseUrl || '').trim() && !String(t.model || '').trim();
}

function correctCfg() {
  const t = (readAsrSettings().correct) || {};
  const base = translateCfg();
  const follow = correctUseTranslate(t);
  /* 跟随翻译时，把自定义值**整体忽略**（`f` 置空对象），地址/模型/Key/provider 一律走 base。
   *
   * ⚠ 这里踩过一次：只把 `follow` 用在 provider 上、却仍用 pick(t.baseUrl, …) 读自定义字段，
   *   于是「勾选用字幕翻译的模型」后实际调用的还是自定义的那个模型 ——
   *   开关看似生效（useTranslate=true），实际没生效。凡是 follow 要管的字段，
   *   都必须从 `f` 取，不能从 `t` 取。 */
  const f = follow ? {} : t;
  const provider = f.provider || '';
  const preset = LLM_PRESETS.find(p => p.id === provider) || null;
  const pick = (v, fb) => (v === undefined || v === null || String(v).trim() === '') ? fb : String(v).trim();
  return {
    provider: provider || base.provider,
    baseUrl: pick(f.baseUrl, preset ? preset.baseUrl : base.baseUrl),
    apiKey: pick(f.apiKey, base.apiKey),
    model: pick(f.model, preset ? preset.model : base.model),
    // 纠错比翻译更考验理解力，默认给多点输出预算（批数多、每批都要出 JSON）
    maxTokens: Math.max(512, Math.min(8192, parseInt(t.maxTokens, 10) || 2048)),
    mode: (t.mode === 'off' || t.mode === 'preview' || t.mode === 'auto') ? t.mode : 'preview',
    ctxLines: Math.max(1, Math.min(8, parseInt(t.ctxLines, 10) || reflectMod.CTX_LINES)),
    batchLines: Math.max(20, Math.min(200, parseInt(t.batchLines, 10) || reflectMod.BATCH_LINES)),
  };
}

/** 纠错配置是否可用（要能发请求：有 baseUrl + model，且要么有 Key 要么是本地地址） */
function correctReady(cfg) {
  const c = cfg || correctCfg();
  if (!c.baseUrl || !c.model) return false;
  if (c.apiKey) return true;
  // 本地部署通常不校验 Key：地址指向本机就放行
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(c.baseUrl);
}

/* ── 热词分析的 LLM 配置 ──────────────────────────────────────────
 * 与 correctCfg 同一套路：默认**跟随翻译配置**（用户不必配两遍），
 * 想单独用别的模型时在 asr/settings.json 的 analyze 段覆盖。
 *
 * 典型用途（也是做这个功能的原因）：翻译用在线 API（快、便宜），
 * 热词分析用**本地 Qwen**（不联网、不花钱、可以反复跑）——
 *   起一个 OpenAI 兼容服务（Ollama: http://127.0.0.1:11434/v1，model=qwen3:8b），
 *   或者在全局设置里直接选「本地模型」。
 *
 * ⚠ 「跟随翻译」用**显式开关** analyze.useTranslate，不靠空值推断 ——
 *   correctCfg 那边踩过：用"baseUrl 与 model 都为空 ⇒ 跟随"推断时，
 *   用户取消勾选、还没填地址，服务端又算回"跟随"，勾选框被回弹、根本取消不掉。
 */
function analyzeUseTranslate(raw) {
  const t = raw || {};
  if (typeof t.useTranslate === 'boolean') return t.useTranslate;
  return !String(t.baseUrl || '').trim() && !String(t.model || '').trim();
}

function analyzeCfg() {
  const t = (readAsrSettings().analyze) || {};
  const base = translateCfg();
  const follow = analyzeUseTranslate(t);
  // 跟随时要管的字段一律从 f 取，不能从 t 取（否则开关看似生效、实际没生效）
  const f = follow ? {} : t;
  const provider = f.provider || '';
  const preset = LLM_PRESETS.find(p => p.id === provider) || null;
  const pick = (v, fb) => (v === undefined || v === null || String(v).trim() === '') ? fb : String(v).trim();
  return {
    provider: provider || base.provider,
    baseUrl: pick(f.baseUrl, preset ? preset.baseUrl : base.baseUrl),
    apiKey: pick(f.apiKey, base.apiKey),
    model: pick(f.model, preset ? preset.model : base.model),
    // 分析一次只回一小段 JSON，但**推理模型（qwen3 等）会先想一大段再答**——
    // 预算给小了会只吐思考、content 为空。默认 4096（实测 qwen3:8b 思考约 1500-2500 token）。
    maxTokens: Math.max(512, Math.min(8192, parseInt(t.maxTokens, 10) || 8192)),
    // 一次最多送几条编辑给模型（多了既费钱又容易让它抓不住重点）
    maxEdits: Math.max(5, Math.min(80, parseInt(t.maxEdits, 10) || 40)),
    useTranslate: follow,
  };
}

/** 分析配置是否可用（要能发请求：有 baseUrl + model，且要么有 Key 要么是本地地址） */
function analyzeReady(cfg) {
  const c = cfg || analyzeCfg();
  if (!c.baseUrl || !c.model) return false;
  if (c.apiKey) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(c.baseUrl);
}

/* 热词分析的请求超时。
 * ⚠ 不能沿用 llmChat 默认的 120s：**推理模型（qwen3 等）会先想一大段**，
 *   本地 8B 冷启动 + 思考实测能超过 120s（qwen3:8b 实测 120s 直接超时）。
 *   而这是用户**主动点一下**才发起的操作，等几分钟是可接受的 —— 宁可慢也不要假失败。
 *   翻译/纠错那种批量调用仍走默认 120s（它们要跑很多批，单批不能太久）。 */
function analyzeTimeoutMs() {
  const n = Number(process.env.SUBFABRIC_ANALYZE_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return Math.min(1800000, n);
  return 600000;   // 10 分钟
}

/**
 * 让 LLM 看一遍"用户改了哪些词"，挑出值得进热词表的。
 *
 * 为什么规则挖完还要 LLM：
 *   · 规则只能看**这一条**编辑，看不出"这个词在好几条里被改成了不同的写法"（其实还是同一个词）
 *   · 分不清同一个词的不同写法哪个才是标准形（Bdubs / B-Dubs / bdubs）
 *   · 判断不了"这个词是 Minecraft 里的专有名词"还是"用户只是顺手改了个语气词"
 *   · 反过来也漏：用户把整句重写了，规则直接跳过，但里面可能就有个专名
 *
 * 返回的每条都带 `why`（模型的理由），界面上直接显示给用户看 —— 让用户能反驳。
 */
/* =========== LLM call plumbing (single entry point) ===========
 * These blocks used to live INSIDE handleRequest. Hotword analysis needs to call
 * llmChat from MODULE scope; nesting it there gave `llmChat is not defined` (hit this).
 * Hoisting is safe: they only depend on llmText (module-level require), fs, console.
 * ============================================================== */
/* ⚠ LlmError 也得在这里：llmChat 现在跑在模块作用域，它抛的正是这个类。
 *   原来 handleRequest 里那行 `const LlmError = llmText.LlmError` 是同一份东西。 */
const LlmError = llmText.LlmError;
/** 诊断转储: 只有设了 SUBFABRIC_LLM_DEBUG=1 才写（默认不留痕 —— 里面是字幕原文与接口回复） */
const LLM_DEBUG = process.env.SUBFABRIC_LLM_DEBUG === '1';
function dumpLlmDebug(file, rec) {
  if (!LLM_DEBUG || !file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(Object.assign({ t: new Date().toISOString() }, rec)) + '\n');
  } catch {}
}

/* ── LLM 调用（唯一的出口）─────────────────────────────────────
 * 用户报「翻译会失效、原因从来定位不到」，根因都在这几行上，逐条治：
 *  ① **思维链**：推理模型(DeepSeek-R1/QwQ/GLM-Z1/Qwen3-thinking…)正文前有  thinking…，
 *     以前完全没剥 → 取 JSON 被思考里的示例数组带偏、逐行兜底把思考当译文 → 行数不符 → 失败。现在统一剥掉。
 *  ② **超时**：以前 fetch 没有超时，服务商挂起就永远等（表现就是"卡住/失效"）。现在 120s（可用 SUBFABRIC_LLM_TIMEOUT_MS 调）。
 *  ③ **自适应 max_tokens**：以前固定 4096，25 行一批 + 思考 token 会被砍成半截 JSON；现在按批量估算。
 *  ④ **错误分型**：net/rate/timeout → 退避重试（尊重 Retry-After）；truncated → 交给调用方拆批（原样重试必然再失败）；
 *     empty → 明确说"模型只吐了思考过程"；format → 换提示词策略。
 *  ⑤ **可见性**：每次失败都 console.error 一条（进应用「日志」页 SSE），带 HTTP 状态/finish_reason/原始回复前 300 字；
 *     设 SUBFABRIC_LLM_DEBUG=1 还会把完整请求+回复落到 projects/<id>/llm-debug.jsonl。
 * ──────────────────────────────────────────────────────────── */
const LLM_TIMEOUT_MS = Number(process.env.SUBFABRIC_LLM_TIMEOUT_MS) || 120000;

async function llmChat(cfg, messages, opts) {
  const o = opts || {};
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const maxTokens = Math.max(256, Math.min(16384, Number(o.maxTokens) || 4096));
  /* 超时：优先 cfg.timeoutMs（按次覆盖，热词分析会用 —— 推理模型慢），
   * 其次 opts.timeoutMs，最后默认值。 */
  const timeoutMs = Number(cfg.timeoutMs || o.timeoutMs) || LLM_TIMEOUT_MS;
  const reqBody = { model: cfg.model, messages, temperature: 0.3, max_tokens: maxTokens };
  if (o.jsonMode) reqBody.response_format = { type: 'json_object' };
  let resp = null, text = '', body = null;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const msg = timeout ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : ('网络错误：' + ((e && e.message) || e));
    console.error(`[llm] ${msg}  url=${url} model=${cfg.model}`);
    throw new LlmError(msg, timeout ? 'timeout' : 'net');
  }
  const retryAfter = Number(resp.headers.get('retry-after')) || 0;
  try { text = await resp.text(); } catch { text = ''; }
  try { body = JSON.parse(text); } catch { body = null; }
  if (!resp.ok) {
    const detail = (body && body.error && (body.error.message || JSON.stringify(body.error))) || text.slice(0, 300) || ('HTTP ' + resp.status);
    const kind = resp.status === 429 ? 'rate' : (resp.status >= 500 ? 'net' : 'http');
    console.error(`[llm] HTTP ${resp.status}（${kind}）model=${cfg.model}：${String(detail).slice(0, 300)}`);
    throw new LlmError(`HTTP ${resp.status}：${String(detail).slice(0, 300)}`, kind, { status: resp.status, retryAfter });
  }
  const choice = body && body.choices && body.choices[0];
  const message = choice && choice.message;
  const finishReason = choice && choice.finish_reason;
  const rawContent = (message && typeof message.content === 'string') ? message.content : '';
  // 思考文本的字段名各家不同：OpenAI/DeepSeek 用 reasoning_content，**Ollama 用 reasoning**。
  // 只认前者的话，本地 Qwen3 被截断时会报成"接口返回内容为空"，看不出真实原因（实测踩过）。
  const reasoning = (message && typeof message.reasoning_content === 'string') ? message.reasoning_content
    : ((message && typeof message.reasoning === 'string') ? message.reasoning : '');
  const content = llmText.stripReasoning(rawContent);
  const debugBase = { kind: o.kind || '', model: cfg.model, status: resp.status, finishReason, maxTokens };

  if (!content) {
    const why = reasoning
      ? `模型只返回了思考过程，content 为空（思考 ${reasoning.length} 字, finish_reason=${finishReason || '?'}）。多为 max_tokens 不够，或该模型不支持非流式输出`
      : `接口返回内容为空（finish_reason=${finishReason || '?'}）`;
    console.error(`[llm] ${why} model=${cfg.model}`);
    dumpLlmDebug(o.debugFile, Object.assign({ error: why, messages, raw: rawContent.slice(0, 20000), reasoning: reasoning.slice(0, 4000) }, debugBase));
    throw new LlmError(why, 'empty', { finishReason });
  }
  if (finishReason === 'length') {
    const why = `输出被 max_tokens 截断（finish_reason=length, max_tokens=${maxTokens}, 已收到 ${content.length} 字）。把「每批行数」调小后重试`;
    console.error(`[llm] ${why}`);
    dumpLlmDebug(o.debugFile, Object.assign({ error: why, messages, raw: rawContent.slice(0, 20000) }, debugBase));
    throw new LlmError(why, 'truncated', { finishReason, partial: content, maxTokens });
  }
  if (llmText.looksLikeReasoning(rawContent)) {
    dumpLlmDebug(o.debugFile, Object.assign({ note: '含思维链，已剥离', messages, raw: rawContent.slice(0, 20000), stripped: content.slice(0, 4000) }, debugBase));
  }
  return { content, finishReason, status: resp.status, maxTokens, strippedReasoning: rawContent.length !== content.length };
}

async function analyzeHotwordsWithLlm(edits) {
  const cfg = analyzeCfg();
  if (!analyzeReady(cfg)) {
    const err = new Error('分析模型没配好：需要在「全局设置」里填接口地址与模型名（本地地址免 Key）');
    err.code = 'not-ready';
    throw err;
  }
  const list = edits.slice(0, cfg.maxEdits);
  const payload = list.map((e, i) => ({
    i: i + 1,
    at: e.target || '',
    before: e.old || '',
    after: e.new || '',
  }));
  const sys = [
    '你在帮一个字幕工具整理「ASR 热词表」。',
    '热词表会喂给语音识别模型，让它在下一份稿子里更倾向识别出这些词。',
    '',
    '用户给的是「他对 ASR 结果做过的修改」：before 是识别出来的，after 是他改成的。',
    '用户改对了的那个词，往往就是 ASR 听错的专有名词 —— 把它加进热词表，下次就不会再错。',
    '',
    '请挑出**值得进热词表**的词，判定标准：',
    '1) 必须是**专有名词或领域术语**：人名、地名、组织名、游戏/作品里的名词、缩写、技术术语；',
    '2) **常见的普通词一律不要**（the / and / home / 然后 / 这个），哪怕用户改过它；',
    '3) 纯语气词、断句调整、标点修正 **不要**；',
    '4) 同一个词的多种写法只能选**一个**标准形（优先用户 after 里那个写法）；',
    '5) 拿不准就不要给 —— 热词加错了会让识别模型**反复吐这个词**，宁可少给。',
    '',
    '严格只输出一个 JSON 数组，不要解释、不要代码块。格式：',
    '[{"term":"标准写法","heard":"原来被识别成什么（没有就空串）","why":"一句话理由","ids":[相关的 i]}]',
    '没有任何合适的词就输出 []。',
    /* ⚠ /no_think 是给**推理模型**（Qwen3 等，Ollama 走的 OpenAI 兼容层）看的开关。
     *   实测 qwen3:8b 在这个任务上会思考 6500+ 字，把 max_tokens 吃光、
     *   finish_reason=length、正文一个字都不吐（服务端只会报"content 为空"）。
     *   这个任务是"照着规则挑词"，不需要长链推理 —— 关掉思考又快又稳。
     *   不认识的模型会把这行当普通文本忽略，无副作用。 */
    '/no_think',
  ].join('\n');
  const r = await llmChat(Object.assign({}, cfg, { timeoutMs: analyzeTimeoutMs() }), [
    { role: 'system', content: sys },
    { role: 'user', content: JSON.stringify(payload) },
  ], {
    /* ⚠ 这里**不能**用 jsonMode。
     * jsonMode 会发 `response_format: {type:'json_object'}`，而我们要的是**数组**；
     * Ollama 的 OpenAI 兼容层收到这个字段就要求必须回一个对象，
     * 于是 qwen3:8b 直接回了空对象 `{}`（实测踩过）。
     * 改成靠下面的"从回复里抠第一个 JSON 数组"来容错，对各家都稳。 */
    jsonMode: false,
    maxTokens: cfg.maxTokens,
  });

  const content = (r && r.content) || '';
  // 模型常把 JSON 包在代码块里，或前后带话 → 抠出第一个数组
  let arr = null;
  const direct = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { arr = JSON.parse(direct); } catch { /* 往下抠 */ }
  if (!Array.isArray(arr)) {
    const m = content.match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch { /* 放弃 */ } }
  }
  if (!Array.isArray(arr)) {
    const err = new Error('分析模型没有返回可解析的 JSON 数组（实际返回：' + content.slice(0, 120) + '）');
    err.code = 'bad-json';
    throw err;
  }
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const term = String(it.term == null ? '' : it.term).trim();
    if (!term) continue;
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      term,
      heard: String(it.heard == null ? '' : it.heard).trim(),
      why: String(it.why == null ? '' : it.why).trim().slice(0, 200),
      ids: Array.isArray(it.ids) ? it.ids.filter(x => Number.isFinite(+x)).map(Number).slice(0, 8) : [],
    });
  }
  return { terms: out, sent: list.length, model: cfg.model, viaTranslate: !!cfg.useTranslate };
}

/** 翻译配置的对外视图: 明文 Key 绝不回传(与 fetchPublicSettings 同一约定) */
function translateCfgPublic(cfg) {
  const c = Object.assign({}, cfg || {});
  delete c.apiKey;
  return c;
}

/** 语义分句的切句规则开关（asr/settings.json 的 resegSplitOnComma）：
 *  默认 **false** —— 只认句末标点(.?!)，逗号降级为行内停顿（长行才用逗号软折）；
 *  设 true 恢复旧行为「遇到逗号也切句」。用户报"断句很碎很不自然"就是旧行为造成的。 */
function resegSplitOnComma() {
  try { return !!readAsrSettings().resegSplitOnComma; } catch { return false; }
}

/** 术语表文本 → 当前目标语言的 [['原文','译法'], …]。
 *  每行一条: '原文=译法' 或 '原文 译法'; '#' 开头为注释;
 *  '##组名' 切换分组(如 ##简体 / ##繁體 / ##English), 翻译时只用当前目标语言那组;
 *  没有分组标记的旧格式(纯行)整份生效; 有分组但当前组为空且只有一组非空 → 用那一组兜底。 */
function parseGlossary(text, lang) {
  const groups = new Map();
  let cur = '', sawSection = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = String(raw).trim();
    if (!l) continue;
    const sec = /^##\s*(.+)$/.exec(l);        // 分组标记要**先**判 —— 否则会被 '#' 注释规则吃掉
    if (sec) { cur = sec[1].trim(); sawSection = true; continue; }
    if (l.startsWith('#')) continue;          // 注释
    // '原文=译法' 优先; 没有等号才退回空格分隔(取**最后一个**空白切, 好让 "Ender Dragon 末影龙" 正确)
    const m = /^(.+?)\s*=\s*(.+)$/.exec(l) || /^(.+)\s+(\S+)$/.exec(l);
    if (!m) continue;
    if (!groups.has(cur)) groups.set(cur, []);
    groups.get(cur).push([m[1].trim(), m[2].trim()]);
  }
  if (!sawSection) return groups.get('') || [];
  const want = groups.get(lang || '简体') || [];
  if (want.length) return want;
  const nonEmpty = [...groups.entries()].filter(([k, v]) => k && v.length);
  return nonEmpty.length === 1 ? nonEmpty[0][1] : [];
}

/** 系统提示词 = 用户提示词 + 术语表块(有术语表时才追加) */
function systemPromptWithGlossary(cfg, strict) {
  const sys = strict
    ? cfg.prompt + '\n\n【极其重要】上一次的回复不是合法 JSON 数组。这一次必须**只输出 JSON 数组本身**：'
      + '以 [ 开头、以 ] 结尾，元素个数等于输入行数，不要任何解释、不要 markdown 代码块、不要编号。'
    : cfg.prompt;
  const g = parseGlossary(cfg.glossary, cfg.glossaryLang);
  if (!g.length) return sys;
  return sys + '\n\n【术语表】下面的词必须按给定译法翻译，不要音译、不要另译（未列出的按常规翻译）：\n'
    + g.map(([a, b]) => `${a} = ${b}`).join('\n');
}
function saveTranslateCfg(patch) {
  const s = readAsrSettings();
  const cur = Object.assign({}, s.translate || {});
  // provider 切换时, 若用户没手改过 baseUrl/model 就跟着预设走
  if (patch.provider && patch.provider !== cur.provider) {
    const preset = LLM_PRESETS.find(p => p.id === patch.provider);
    if (preset) { cur.baseUrl = preset.baseUrl; cur.model = preset.model; }
  }
  const p = Object.assign({}, patch);
  // apiKey 永不落盘明文: 非空 → 加密存 apiKeyEnc; 空串 → 视为「不改」
  // (前端输入框不再回显明文 Key, 留空的含义就是保持原值不变)
  if (Object.prototype.hasOwnProperty.call(p, 'apiKey')) {
    const v = String(p.apiKey || '');
    delete p.apiKey;
    if (v) {
      try { p.apiKeyEnc = secretStore.encrypt(v); }
      catch (e) { console.error('[translate] API Key 加密失败, 暂按明文存:', e && e.message); p.apiKey = v; }
    }
  }
  if (p.apiKeyClear) { delete p.apiKeyClear; p.apiKeyEnc = ''; }   // 显式清除(设置里的「清除已存 Key」链接)
  delete cur.apiKey;                        // 清掉历史明文残留(迁移写盘失败时的兜底)
  s.translate = Object.assign(cur, p);
  writeAsrSettings(s);
  return translateCfg();
}
const llmReady = (cfg) => {
  if (!cfg) return false;
  // 本地引擎不需要接口地址与 Key，只要求模型目录就位（见 mt-local.js 的 probe）
  if (cfg.provider === 'nllb-local') return !!localMt().probe().modelOk;
  return !!(cfg.baseUrl && cfg.apiKey && cfg.model);
};

/** 保存热词分析的 LLM 配置（asr/settings.json 的 analyze 段）。
 *  与 saveTranslateCfg 同一套：provider 切换跟随预设、apiKey 加密落盘、空串=不改。 */
function saveAnalyzeCfg(patch) {
  const s = readAsrSettings();
  const cur = Object.assign({}, s.analyze || {});
  if (patch.provider && patch.provider !== cur.provider) {
    const preset = LLM_PRESETS.find(p => p.id === patch.provider);
    if (preset) { cur.baseUrl = preset.baseUrl; cur.model = preset.model; }
  }
  const p = Object.assign({}, patch);
  if (Object.prototype.hasOwnProperty.call(p, 'apiKey')) {
    const v = String(p.apiKey || '');
    delete p.apiKey;
    if (v) {
      try { p.apiKeyEnc = secretStore.encrypt(v); }
      catch (e) { console.error('[analyze] API Key 加密失败, 暂按明文存:', e && e.message); p.apiKey = v; }
    }
  }
  if (p.apiKeyClear) { delete p.apiKeyClear; p.apiKeyEnc = ''; }
  delete cur.apiKey;
  s.analyze = Object.assign(cur, p);
  writeAsrSettings(s);
  return analyzeCfg();
}

/* ═══════════ 识别提示词 / 热词(提升专有名词识别率) ═══════════
 * 两个引擎各有各的注入方式, 实测(2026-09-25, 本机):
 *  - whisper.cpp: --prompt 初始提示词 —— 直接有效且无副作用("B-dubs/Itho" → "Bdubs/Etho")
 *  - Parakeet:    hotwords_file + hotwords_score —— **必须**配 modified_beam_search, 且热词要
 *                 写成词汇表里的 BPE 片段(asr.py 里转换; 直接写原词会被静默跳过, 看起来像没生效);
 *                 score 实测: 1.5 无效 / 3.0 生效且正确 / ≥6 开始复读热词 / 12 彻底崩坏
 *                 → 默认给 3.0, 上限卡在 6。
 */
function asrHintCfg() {
  const a = (readAsrSettings().asr) || {};
  const sc = Number(a.hotwordsScore);
  return {
    prompt: a.prompt || '',
    hotwordsScore: (isFinite(sc) && sc > 0) ? Math.min(6, sc) : 3,
  };
}
function saveAsrHint(patch) {
  const s = readAsrSettings();
  s.asr = Object.assign({ prompt: '', hotwordsScore: 3 }, s.asr || {}, patch || {});
  writeAsrSettings(s);
  return asrHintCfg();
}
/** 汇总要喂给 ASR 的词: 用户填的识别提示词(逗号/换行分隔) + 术语表「原文」列(自动派生) */
function asrTerms() {
  const hint = asrHintCfg();
  const cfg = translateCfg();
  const terms = [];
  const seen = new Set();
  const add = (t) => {
    const s = String(t == null ? '' : t).trim();
    if (!s || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    terms.push(s);
  };
  for (const part of String(hint.prompt || '').split(/[\n,，、;；]/)) add(part);
  for (const pair of parseGlossary(cfg.glossary, cfg.glossaryLang)) add(pair[0]);
  return { terms, score: hint.hotwordsScore };
}
/** 给 whisper-cli 的 --prompt: 词表拼成短语, 限长(超长会诱发复读幻觉) */
function whisperPrompt(terms) {
  if (!terms || !terms.length) return '';
  return terms.join(', ').slice(0, 300);
}
/** 给 asr.py 的热词参数: 词表写成临时文件(原词, asr.py 负责转 BPE 片段) + 强度 */
function parakeetHotwordArgs() {
  const { terms, score } = asrTerms();
  if (!terms.length) return [];
  try {
    const f = path.join(os.tmpdir(), `kass-hot-${process.pid}-${Date.now().toString(36)}.txt`);
    fs.writeFileSync(f, terms.join('\n') + '\n', 'utf8');
    return ['--hotwords-file', f, '--hotwords-score', String(score)];
  } catch { return []; }
}

/** Python 解释器: 优先本项目 asr/.venv, 其次一键安装的内置 Python, 再次环境变量, 最后交给 PATH */
const EMBEDDED_PY = {
  version: '3.12.10',
  dir: path.join(ASR_DIR, 'runtime-python'),
  zipUrls: [
    'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',
    'https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-embed-amd64.zip',
  ],
  getPipUrl: 'https://bootstrap.pypa.io/get-pip.py',
  pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
};
const embeddedPyExe = () => path.join(EMBEDDED_PY.dir, 'python.exe');

function resolvePython() {
  if (process.env.ASR_PYTHON) return process.env.ASR_PYTHON;
  // settings.json 里的 pythonExe：给"运行时装在别处"的情形用。
  // 为什么不能只靠环境变量：用户是双击 vbs 启动的，环境变量传不进那个进程。
  try {
    const custom = String((readAsrSettings() || {}).pythonExe || '').trim();
    if (custom) { fs.accessSync(custom); return custom; }
  } catch {}
  for (const c of [path.join(ASR_DIR, '.venv', 'Scripts', 'python.exe'),
                   path.join(ASR_DIR, '.venv', 'bin', 'python'),
                   embeddedPyExe()]) {
    try { fs.accessSync(c); return c; } catch {}
  }
  return 'python';
}
let ASR_PY = resolvePython();

/* ── ASR 常驻服务 ──
 * 让引擎的 Python 进程只启动一次、模型只加载一次。实测每次识别省 5~10 秒（82~83%）：
 *   引擎                        冷启动   常驻后每次
 *   NPU（OpenVINO）             6.36s     1.09s
 *   GPU（sherpa-onnx / CUDA）  12.52s     2.23s
 * 这笔开销（启动进程 + 导入 OpenVINO/sherpa 运行时 + 加载模型）与音频长度无关，
 * 所以在短视频、单句重识别、逐片并行这些场景里占比极高。
 * 走服务失败会原样退回 spawn 路径，所以它是纯加速、不改变输出契约。 */
const asrSvc = new asrServiceMod.AsrService({
  python: ASR_PY,
  onLog: (m) => console.log(m),
});
const asrServeOff = () => process.env.SUBFABRIC_ASR_SERVE === '0';

/** 常驻服务只支持真正的引擎脚本。dual(asr_dual.py) 是调度器（自己再起两个进程），不支持 --serve。 */
function asrCanServe(script) {
  if (asrServeOff()) return false;
  const b = path.basename(script || '');
  return b === 'asr.py' || b === 'asr_npu.py';
}
   // let: 一键安装完成后会重新解析(见 startPyEnvSetup)

/** Python 子进程统一环境: 强制 UTF-8 输入输出。
 *  Windows 管道模式下 Python 默认按 GBK 写 stdout/stderr, Node 这边按 UTF-8 解码,
 *  asr.py 的中文日志就成了 ◆◆◆ 乱码(实测「分块 358 段」变「◆◆◆ 358 ◆◆」)。 */
const pySpawnEnv = () => Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

/** 检测 NVIDIA 显卡(驱动自带 nvidia-smi); 返回显卡名或 null。结果由调用方缓存。 */
function detectNvidia() {
  return new Promise((resolve) => {
    const p = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true });
    let out = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 8000);
    p.stdout.on('data', c => { out += c; });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', code => { clearTimeout(t); resolve(code === 0 && out.trim() ? out.trim().split('\n')[0].trim() : null); });
  });
}
let nvidiaCache = { at: 0, name: null };
async function nvidiaGpu() {
  if (Date.now() - nvidiaCache.at < 5 * 60 * 1000) return nvidiaCache.name;
  nvidiaCache = { at: Date.now(), name: await detectNvidia() };
  return nvidiaCache.name;
}
/** Parakeet 推理设备('cuda' = 安装器实测 CUDA 环境通过后写入 settings)。
 *  返回 'cpu' 表示 GPU 环境未就绪 —— ASR 会在创建初稿/选区重识别的 GPU 校验处直接报错, 不做 CPU 兜底 */
const asrProvider = () => { const s = readAsrSettings(); return s.asrProvider === 'cuda' ? 'cuda' : 'cpu'; };

/** 该引擎该用哪个 Python 脚本 + provider 参数。
 *  sherpa-onnx → asr.py(CUDA provider; 官方不支持 CPU); openvino → asr_npu.py(NPU/核显/CPU)。 */
const asrEngineArgs = (model) => {
  const eng = model && model.engine;
  if (eng === 'dual') {
    // 双引擎：脚本自己管两个后端与设备，所以 provider 只作为"非 cuda"的标记，
    // 让它绕过「必须 cuda」的校验 —— 它既用 NPU 也用 N 卡，不该被 GPU 门槛拦住。
    const d = dualCfg();
    return {
      script: path.join(ASR_DIR, 'asr_dual.py'),
      provider: 'dual',
      hotwords: [],                 // 两个后端里有一个不支持热词，统一不带
      extra: ['--ratio', d.ratio, '--slice-sec', String(d.sliceSec), '--joint', d.joint],
    };
  }
  const openvino = eng === 'openvino';
  return {
    script: openvino ? path.join(ASR_DIR, 'asr_npu.py') : ASR_SCRIPT,
    provider: openvino ? 'npu' : 'cuda',
    // 热词只对 sherpa-onnx 后端有效(asr_npu.py 会接受参数并在日志里说明忽略)
    hotwords: openvino ? [] : parakeetHotwordArgs(),
  };
};

/** 子进程退出码 → 人话。经典坑: Windows 上「python」不存在时, Microsoft Store 的
 *  占位别名 python.exe 会启动并退出 9009(它打印的提示是纯文本, 不是 asr.py 的 JSON 日志,
 *  旧版 sink 直接丢弃 → 用户只见「异常退出(代码 9009)」而日志面板空白, 无从排查)。 */
function asrExitHint(code) {
  if (code === 9009) return 'Windows 找不到命令（9009）：通常是 Python 未安装，或只有 Microsoft Store 的占位程序';
  if (code === 3221225477) return '进程崩溃（0xC0000005 内存访问违例）：多半是显卡驱动/运行库冲突，先重试一次；持续出现请带上日志反馈';
  if (code === 1) return '进程报错退出（1）：通常是 Python 依赖缺失，详见日志';
  return '退出码 ' + code;
}

/** 初稿预检: 解释器能启动 + sherpa-onnx/numpy 能导入。结果缓存 5 分钟。
 *  模型文件就绪 ≠ Python 环境就绪 —— 发行包不含 asr/.venv(体积原因),
 *  用户机器上有没有 Python、装没装依赖, 只有真跑一下才知道。 */
let pyProbeCache = null;         // { sherpa:{...}, openvino:{...} } —— 两个后端各探各的
let pyProbeInflight = null;      // 与 probeNemo 同理: 状态页每秒轮询, 在途时复用同一个探测
function probePython(engine) {
  // 预检要 import 的包按引擎而定: sherpa-onnx 后端查 sherpa_onnx, OpenVINO(NPU) 后端查 openvino。
  // 混用会让"装了 openvino 但没装 sherpa-onnx"的机器被误判成环境没装好(反之亦然)。
  const wantOpenvino = engine === 'openvino';
  const cacheKey = wantOpenvino ? 'openvino' : 'sherpa';
  const cached = pyProbeCache && pyProbeCache[cacheKey];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return Promise.resolve(cached);
  if (pyProbeInflight && pyProbeInflight[cacheKey]) return pyProbeInflight[cacheKey];
  const probeCode = wantOpenvino
    ? 'import sys; import openvino; import numpy; print(sys.version.split()[0] + " / openvino " + str(openvino.__version__))'
    : 'import sys; import sherpa_onnx; import numpy; print(sys.version.split()[0] + " / sherpa-onnx " + str(getattr(sherpa_onnx, "__version__", "?")))';
  const p = new Promise((resolve) => {
    const p = spawn(ASR_PY,
      ['-c', probeCode],
      { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
    let out = '', err = '';
    const done = (r) => {
      clearTimeout(timer);
      const rec = Object.assign({ at: Date.now() }, r);
      pyProbeCache = Object.assign({}, pyProbeCache, { [cacheKey]: rec });
      resolve(rec);
    };
    // OpenVINO 首次编译 NPU 计算图可能耗时几分钟, 但预检本身只 import 不编译 —— 10s 足够
    const timer = setTimeout(() => { try { p.kill(); } catch {} done({ ok: false, msg: 'Python 预检超时（10s）' }); }, 10000);
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('error', e => done({ ok: false, msg: '无法启动 ' + ASR_PY + '：' + e.message }));
    p.on('close', (code) => {
      if (code === 0) return done({ ok: true, msg: out.trim() });
      const detail = err.trim().split('\n').filter(Boolean).pop() || '';
      done({ ok: false, msg: asrExitHint(code) + (detail ? ' —— ' + detail : '') });
    });
  });
  pyProbeInflight = Object.assign(pyProbeInflight || {}, { [cacheKey]: p });
  return p.finally(() => {
    if (pyProbeInflight) delete pyProbeInflight[cacheKey];
  });
}

function readAsrSettings() {
  try { return JSON.parse(fs.readFileSync(ASR_SETTINGS, 'utf8')); } catch { return {}; }
}
function writeAsrSettings(obj) {
  fs.mkdirSync(ASR_DIR, { recursive: true });
  const tmp = ASR_SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, ASR_SETTINGS);
}

/* ── 逐句置信度：三档 ──────────────────────────────────────────
 * 置信度由三个信号融合（见 asr/confidence.py）：token 概率、音频质量、稳定性。
 *   · token 概率    —— 解码时本来就算，**零额外开销**
 *   · 音频质量      —— 几毫秒的 numpy，**零额外开销**
 *   · 稳定性        —— 把音频加噪**重跑 tta 遍**，这是唯一的真开销
 * 实测 236 秒音频：tta=2 → 20.8s，tta=0 → 10.7s（稳定性占 10.1s，近乎翻倍）。
 *
 * 所以按"要不要花这份时间"分三档：
 *   off  —— 完全不生成：worker 不重跑，且服务端把逐句 confidence 丢掉、
 *           不写 ASS 注释、界面不显示（列表的置信度徽标与筛选会自然消失）
 *   fast —— 只融合白送的两路（token + 音频），不重跑稳定性
 *   full —— 三路齐全（默认）
 *
 * 两处控制：全局（设置 → 识别增强）+ 项目级（新建稿件的生成设置）。
 * 项目级只在用户**显式**选过时覆盖全局 —— 用 null 表示"跟随全局"，
 * 这样以后改全局设置，老项目会跟着变（而不是把当时的默认值冻在项目里）。 */
const CONFIDENCE_MODES = ['off', 'fast', 'full'];
const CONFIDENCE_TTA = 2;                 // full 档的重跑遍数（与 worker 默认值一致）

/** 把任意输入规整成三档之一；认不出来就返回 fallback */
/** 把任意输入规整成三档之一；认不出来就返回 fallback。
 *  兼容布尔：true → full、false → off —— 早先这个开关就是布尔的，
 *  老项目（project.json 的 draft.confidence）与老设置文件里存的都是 true/false。
 *  `asrConfidenceDefault` 与 `asrConfidenceFor` 都走这里，兼容行为天然一致；
 *  实测踩过：只在 default 里做兼容、漏了 For → 老项目存的 false 会被当成垃圾值
 *  而退回全局（全局若是 full，老项目明明关了却又开始做稳定性重跑）。 */
function normConfMode(v, fallback) {
  if (v === true) return 'full';
  if (v === false) return 'off';
  return CONFIDENCE_MODES.includes(v) ? v : fallback;
}

/** 全局默认：设置里没写过就是 full */
function asrConfidenceDefault() {
  const c = readAsrSettings().confidence || {};
  // 兼容早期写过的布尔形式 {enabled:false} → off
  if (typeof c.enabled === 'boolean') return c.enabled ? 'full' : 'off';
  return normConfMode(c.mode, 'full');
}

/** 项目级 → 有效档位：项目没表态（undefined/null）就跟随全局 */
function asrConfidenceFor(meta) {
  const v = meta && meta.draft ? meta.draft.confidence : undefined;
  return normConfMode(v, asrConfidenceDefault());
}

/** 档位 → worker 的 --tta 参数。off 与 fast 都是 0（都不重跑），
 *  区别在于 off 之后会把逐句 confidence 丢掉 —— 见 draftConfidenceOff()。 */
function ttaArgs(mode) {
  return ['--tta', String(mode === 'full' ? CONFIDENCE_TTA : 0)];
}

/** off 档：把逐句置信度从结果里摘掉（服务端负责，worker 不必知道这个档位）。
 *  这样 ASS 里不会写 SubFabricConfidence 注释，界面也就没有徽标可显示。 */
function stripConfidence(segs) {
  let n = 0;
  for (const s of (segs || [])) {
    if (s && s.confidence) { delete s.confidence; n++; }
    // 词级概率也一并去掉：它是给 make_confidence 用的中间产物，不参与字幕生成
    for (const w of (s && s.words) || []) { if (w && w._p) delete w._p; }
  }
  return n;
}
/** 「生成设置 → 角色分析提示词」: 留空则返回空串, cast.js 会退回内置 CAST_SYSTEM */
function castPromptCfg() {
  try { return String((readAsrSettings().cast || {}).prompt || ''); } catch { return ''; }
}
/* 每个模型一个目录: asr/models/<dirName>。settings.models 记录各模型目录,
 * asrModelDir 是旧字段(仅 parakeet 兼容)。selectedModel = 创建初稿默认用的模型。 */
function modelDirFor(modelId) {
  const s = readAsrSettings();
  if (s.models && s.models[modelId]) return String(s.models[modelId]);
  const m = modelById(modelId);
  return m ? path.join(modelsRoot(), m.dirName) : '';
}
const selectedModelId = () => {
  const s = readAsrSettings();
  return (s.selectedModel && modelById(s.selectedModel)) ? s.selectedModel : ASR_MODELS[0].id;
};
function setSelectedModel(id) {
  const m0 = modelById(id);
  if (!m0 || !draftAllowedOf(m0)) return;      // 只能重新识别的模型不能当"创建初稿默认模型"

  const s = readAsrSettings();
  s.selectedModel = id;
  writeAsrSettings(s);
}

/** 检查某模型目录是否完整(按该模型自己的文件清单); 返回缺失项数组(空 = 可用) */
function missingModelFiles(dir, model) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return ['目录不存在']; }
  const list = (model && model.files) ? model.files : null;
  if (!list) return ['未知模型'];
  return list.filter(f => !names.some(n => n.toLowerCase() === f.toLowerCase()));
}
/** 模型文件是否完整: 文件都在 + 总大小 ≥ 标称值的 90%。
 *  只查名字不够 —— 半截/0 字节的残留文件会让模型"看起来就绪", 加载时才炸(实测踩过)。 */
function modelFilesOk(dir, model) {
  if (!model || missingModelFiles(dir, model).length) return false;
  if (!model.sizeMB) return true;
  let total = 0;
  try {
    for (const f of model.files) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch { return false; }
  return total >= model.sizeMB * 1048576 * 0.9;
}
/** 模型是否可用(文件齐全且大小达标); whisper.cpp 引擎还要求运行时就位 */
function modelReady(modelId) {
  const m = modelById(modelId);
  if (!m) return false;
  if (m.cloud) return true;        // 云端识别: 没有本地文件可查(能不能用取决于联网, 由识别时报错说清)
  const dir = modelDirFor(modelId);
  if (!dir || !modelFilesOk(dir, m)) return false;
  if (m.engine === 'whisper.cpp' && !whisperRuntimeOk()) return false;
  // dual 引擎要两套模型都在（NPU 那套 + sherpa int8 那套）。不这么判的话，
  // 缺一套时会在识别跑到一半才炸，用户看到的是莫名其妙的失败。
  if (m.alsoNeeds) {
    const other = modelById(m.alsoNeeds);
    const od = other ? modelDirFor(m.alsoNeeds) : null;
    if (!other || !od || !modelFilesOk(od, other)) return false;
  }
  return true;
}
/** 当前选中模型的目录(找不到所选就用第一个可用的)
 *  注意: 这是「创建初稿」用的默认模型 —— 只挑 draftAllowed 的, multitalker 那种只能重新识别的模型不参与。 */
function resolveAsrModel() {
  const s = readAsrSettings();
  for (const id of [s.selectedModel, ASR_MODELS[0].id]) {
    const m = modelById(id);
    if (m && draftAllowedOf(m) && modelReady(m.id)) return m;
  }
  // 兜底只在**本地模型**里挑: 云端识别会把音频传到第三方服务器, 不能因为"本地没装模型"就默认替用户上传
  for (const m of ASR_MODELS) if (draftAllowedOf(m) && !m.cloud && modelReady(m.id)) return m;
  return null;
}

/** 项目初稿用的模型(meta.draft.modelId)。只认**能创建初稿**的模型 ——
 *  multitalker 那种 draftAllowed=false 的模型即使被写进 meta 也不会拿来跑初稿。
 *  注意: 必须留在**模块作用域** —— resolveRerecogModel()(选区重新识别)也要用它,
 *  早先它定义在 http 请求回调里, 导致重新识别一调用就 ReferenceError、请求永不返回。 */
function resolveDraftModel(meta) {
  const mid = meta && meta.draft && meta.draft.modelId;
  const m = mid ? modelById(mid) : null;
  return m && draftAllowedOf(m) && modelReady(m.id) ? m : null;
}

/** 用户在设置里指定的「重新识别模型」(空 = 没指定, 沿用项目原来的模型)。
 *  这个设置可以指向任何模型, 包括只能重新识别的 multitalker。 */
const rerecogModelId = () => {
  const s = readAsrSettings();
  return (s.rerecogModel && modelById(s.rerecogModel)) ? s.rerecogModel : '';
};
function setRerecogModel(id) {
  const s = readAsrSettings();
  if (id) s.rerecogModel = id; else delete s.rerecogModel;
  writeAsrSettings(s);
}
/** 选区重新识别用哪个模型: 设置里指定的 → 项目初稿用的 → 创建初稿默认的。
 *  找不到时返回 { error } 给出明确原因(未下载 / 没装运行时), 由调用方转成 400 —— 别静默换模型。 */
function resolveRerecogModel(meta) {
  const sel = rerecogModelId();
  if (sel) {
    const m = modelById(sel);
    if (!modelReady(m.id)) return { error: '「重新识别模型」选中的「' + m.name + '」还没装好，先到设置里下载模型' };
    return { model: m };
  }
  const dm = resolveDraftModel(meta);
  if (dm) return { model: dm };
  const fallback = resolveAsrModel();
  if (fallback) return { model: fallback };
  return { error: '语音识别模型不可用，先到设置里下载' };
}

/* 模型/运行时下载: Node 内置 fetch + Range 断点续传(保持本项目零 npm 依赖)。
 * downloads 是 **Map**(任务名 → 状态) —— 不同模型/运行时/说话人模型可**并行**下载,
 * 互不阻塞(旧版单 downloadState 时, 下着 Parakeet 再点 Whisper 的下载会被静默忽略,
 * 用户看到的就是"下载按钮点了没反应")。 */
const downloads = new Map();   // key: 'model:<id>' | 'runtime' | 'diarize'

/* ── 性能测试（双引擎分工）状态 ──
 * 一次测试要跑 9 次真实识别（3 种分片 × [GPU 基线 / NPU 基线 / 最优配比验证]），
 * 耗时以分钟计，所以做成"启动 + 轮询"而不是同步请求。 */
let perfState = { running: false, pct: 0, msg: '', error: null, result: null, startedAt: 0 };
let perfProc = null;
const dlState = (key, init) => {
  if (init) downloads.set(key, init);
  return downloads.get(key) || { running: false, pct: 0, msg: '', error: null };
};

/** undici 的 "Fetch failed" 毫无信息量, 真正原因在 e.cause.code —— 翻译成用户能自查的人话 */
function netErrMsg(e, url) {
  const cause = (e && e.cause) || {};
  const code = cause.code || e.code || '';
  let host = '';
  try { host = new URL(url).host; } catch {}
  const hint =
    code === 'ENOTFOUND' ? '（域名解析失败：检查网络/DNS，或该域名在当前网络不可达）' :
    (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ECONNABORTED') ? '（连接被重置：网络不稳定或被防火墙干扰，重试通常可恢复）' :
    (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') ? '（连接超时：检查网络/代理）' :
    code === 'EACCES' ? '（连接被拒绝）' : '';
  return `网络错误${code ? '（' + code + '）' : ''}${hint}，连不上 ${host}`;
}

async function downloadFileOnce(url, dest, onProgress) {
  const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  const headers = { 'User-Agent': 'K-ASS-Editor/1.0' };
  if (existing > 0) headers.Range = `bytes=${existing}-`;
  const resp = await fetch(url, { headers, redirect: 'follow' });
  if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
  const resumed = resp.status === 206;
  const len = Number(resp.headers.get('content-length') || 0);
  const total = resumed ? existing + len : len;
  let done = resumed ? existing : 0;
  const ws = fs.createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
  try {
    const reader = resp.body.getReader();
    for (;;) {
      const { done: fin, value } = await reader.read();
      if (fin) break;
      const buf = Buffer.from(value);
      done += buf.length;
      if (!ws.write(buf)) await new Promise(r => ws.once('drain', r));
      if (onProgress) onProgress(done, total);
    }
    await new Promise((res, rej) => ws.end(e => (e ? rej(e) : res())));
  } catch (e) {
    try { ws.destroy(); } catch {}
    throw e;
  }
}

/** 带重试的下载: 失败自动重试(断点续传, 指数退避), 错误翻译成可自查的人话。
 *  背景: 用户朋友机器上下载说话人模型报 "Fetch failed" —— 那是 undici 网络层错误,
 *  可能是瞬时抖动(重试可救)也可能是 github 直连被墙(重试救不了, 需镜像, 见 downloadAny)。 */
async function downloadFile(url, dest, onProgress, attempts = 3) {
  let lastErr = null;
  for (let a = 1; a <= attempts; a++) {
    try { return await downloadFileOnce(url, dest, onProgress); }
    catch (e) {
      lastErr = e;
      if (onProgress) onProgress(-1, -1);      // 通知调用方"这一轮挂了"(调用方可忽略)
      if (a < attempts) await new Promise(r => setTimeout(r, 1500 * a));
    }
  }
  throw new Error(netErrMsg(lastErr, url));
}

/** GitHub 直连在国内网络经常不可达/被重置(实测本机也 502): 失败时自动换镜像网关。
 *  镜像只是加前缀的透明代理, 文件内容一致; 顺序 = 直连优先, 镜像兜底。 */
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/'];
function candidateUrls(url) {
  const u = String(url);
  const gh = u.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (gh) return [u, ...GH_MIRRORS.map(m => m + 'https://github.com/' + gh[1])];
  // HuggingFace: 镜像(hf-mirror)失效时退回官方源, 反之亦然
  if (u.startsWith(HF_ENDPOINT + '/')) {
    const alt = HF_ENDPOINT === 'https://hf-mirror.com' ? 'https://huggingface.co' : 'https://hf-mirror.com';
    return [u, u.replace(HF_ENDPOINT, alt)];
  }
  return [u];
}

/** 依次尝试多个候选源(每个源内部还有 3 次重试); 全挂才报错(附最后一个源的错误) */
async function downloadAny(urls, dest, onProgress) {
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    try { return await downloadFile(urls[i], dest, onProgress); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有下载源均失败');
}

/** 下载一个识别模型到 dir; 完成后登记进 settings.models */
function startModelDownload(model, dir) {
  const key = 'model:' + model.id;
  if (dlState(key).running) return;
  dlState(key, { running: true, kind: 'model', pct: 0, msg: '准备下载…', error: null, modelId: model.id, dir });
  (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < model.files.length; i++) {
        const f = model.files[i];
        // 少数模型的主权重与配套模型分属不同仓库(如 multitalker 的流式分离权重) —— 按文件覆盖仓库
        const repo = (model.fileRepos && model.fileRepos[f]) || model.repo;
        const base = `${HF_ENDPOINT}/${repo}/resolve/main`;
        await downloadAny(candidateUrls(`${base}/${f}`), path.join(dir, f), (done, total) => {
          if (done < 0) return;                       // 重试开始的通知, 进度不回退
          const part = total ? done / total : 0;
          const st = dlState(key);
          st.pct = Math.min(99, Math.round(((i + part) / model.files.length) * 100));
          st.msg = `下载 ${f}：${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`;
        });
      }
      if (!modelFilesOk(dir, model)) throw new Error('下载后模型仍不完整');
      const s = readAsrSettings();
      s.models = Object.assign({}, s.models || {}, { [model.id]: dir });
      writeAsrSettings(s);
      if (!s.selectedModel) setSelectedModel(model.id);
      dlState(key, { running: false, kind: 'model', pct: 100, msg: '下载完成', error: null, modelId: model.id, dir });
    } catch (e) {
      const st = dlState(key);
      st.running = false;
      st.error = String((e && e.message) || e);
      st.msg = '下载失败: ' + st.error;
    }
  })();
}

/** 下载说话人分离模型(两个文件)到 DIARIZE_DIR() */
function startDiarizeDownload() {
  const key = 'diarize';
  if (dlState(key).running) return;
  dlState(key, { running: true, kind: 'diarize', pct: 0, msg: '准备下载分离模型…', error: null, modelId: 'diarize', dir: DIARIZE_DIR() });
  (async () => {
    try {
      fs.mkdirSync(DIARIZE_DIR(), { recursive: true });
      for (let i = 0; i < DIARIZE_MODELS.length; i++) {
        const m = DIARIZE_MODELS[i];
        const dest = path.join(DIARIZE_DIR(), m.file);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) continue;
        const tmp = dest + '.dl';
        await downloadAny(candidateUrls(m.url), tmp, (done, total) => {
          if (done < 0) return;
          const st = dlState(key);
          st.pct = total ? Math.min(99, Math.round((i + done / total) / DIARIZE_MODELS.length * 100)) : 0;
          st.msg = `下载 ${m.name}：${(done / 1048576).toFixed(1)} MB`;
        });
        if (m.archive) {
          // 分段模型是 tar.bz2 归档: 解包取出里面的 model.onnx
          const sysTar = path.join(process.env.SystemRoot || 'C:' + path.sep + 'Windows', 'System32', 'tar.exe');
          const exDir = path.join(DIARIZE_DIR(), '_ex_' + i);
          fs.mkdirSync(exDir, { recursive: true });
          const rr = spawn(sysTar, ['-xf', tmp, '-C', exDir], { windowsHide: true });
          await new Promise((res) => { rr.on('close', res); rr.on('error', res); });
          const inner = m.inner ? path.join(exDir, m.inner) : path.join(exDir, path.basename(m.file));
          if (!fs.existsSync(inner)) throw new Error('归档里未找到 ' + m.file);
          fs.renameSync(inner, dest);
          fs.rmSync(exDir, { recursive: true, force: true });
          fs.unlinkSync(tmp);
        } else {
          fs.renameSync(tmp, dest);
        }
      }
      if (!diarizeReady()) throw new Error('下载后分离模型仍不完整');
      dlState(key, { running: false, kind: 'diarize', pct: 100, msg: '下载完成', error: null, modelId: 'diarize', dir: DIARIZE_DIR() });
    } catch (e) {
      const st = dlState(key);
      st.running = false;
      st.error = String((e && e.message) || e);
      st.msg = '下载失败: ' + st.error;
    }
  })();
}

/* ═══════════ NeMo 运行时安装（仅 multitalker 模型需要） ═══════════
 * 在已有 ASR Python 环境上追加 PyTorch + NeMo。装完**实测 import + CUDA** 才算成功 ——
 * 装到 CPU 版 torch 上等于白装（multitalker 只认 CUDA, 拒绝 CPU 推理）。
 * 进度走 downloads key='nemo', 与其它下载共用设置面板的进度 UI。 */
function startNemoInstall() {
  const key = 'nemo';
  const set = (patch) => dlState(key, Object.assign({ kind: 'nemo', modelId: 'nemo' }, patch));
  set({ running: true, pct: 1, msg: '准备安装 NeMo 运行时…', error: null });
  const prog = (pct, msg) => set({ running: true, pct: Math.max(1, Math.min(99, Math.round(pct))), msg, error: null });
  (async () => {
    const pyExe = ASR_PY;
    try {
      prog(3, '升级 pip…');
      await runCapture(pyExe, ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', NEMO_PIP_INDEX, '--quiet'], 600000);

      // ① PyTorch（约 2.5GB）: 先装 PyPI 通用 wheel, 实测认不到 CUDA 再换 CUDA 专用轮子
      let lines = 0;
      prog(6, '安装 PyTorch（约 2.5GB，首次较慢）…');
      await pipInstallRetry(pyExe, ['-m', 'pip', 'install', 'torch', '-i', NEMO_PIP_INDEX], 3600000,
        () => { lines++; prog(6 + Math.min(24, lines * 0.2), '安装 PyTorch…（已输出 ' + lines + ' 行）'); });
      let probeN = await probeNemo(true);
      if (!probeN.ok || !probeN.cuda) {
        // PyPI 上的 torch 在 Windows 是 CPU-only 轮子(实测 2.14.0+cpu) —— 必须换官方 CUDA 索引重装
        prog(32, '换装 CUDA 版 PyTorch（官方 cu126 索引，约 3GB）…');
        await pipInstallRetry(pyExe, ['-m', 'pip', 'install', '--force-reinstall', 'torch',
          '--index-url', 'https://download.pytorch.org/whl/cu126',
          '--extra-index-url', NEMO_PIP_INDEX], 5400000,
          () => { lines++; prog(32 + Math.min(12, lines * 0.05), '换装 CUDA 版 PyTorch…'); });
        probeN = await probeNemo(true);
      }

      // ② NeMo ASR（体积大头: pytorch-lightning / lhotse / librosa / wandb …）
      let n2 = 0;
      prog(45, '安装 NeMo（nemo_toolkit[asr]，约 2GB）…');
      await pipInstallRetry(pyExe, ['-m', 'pip', 'install', 'nemo_toolkit[asr]', '-i', NEMO_PIP_INDEX], 3600000,
        (line) => { n2++; prog(45 + Math.min(42, n2 * 0.12), '安装 NeMo: ' + String(line).slice(0, 70)); });

      // ③ 实测: torch + nemo.collections.asr 能导入, 且 CUDA 可用
      prog(93, '实测 NeMo 运行时（加载 torch / NeMo，并检查 CUDA）…');
      const fin = await probeNemo(true);
      if (!fin.ok) throw new Error('NeMo 运行时加载失败：' + (fin.msg || ''));
      if (!fin.cuda) throw new Error('装到的 PyTorch 用不了 CUDA，multitalker 只支持 GPU 推理。确认是 NVIDIA 显卡、更新驱动后重试');
      set({ running: false, pct: 100, msg: '安装完成：' + fin.msg + (fin.gpu ? ' · ' + fin.gpu : ''), error: null });
      console.log('[asr] NeMo 运行时就绪:', fin.msg, fin.gpu || '');
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      set({ running: false, pct: 0, msg: '安装失败: ' + msg, error: msg });
      console.error('[asr] NeMo 运行时安装失败:', msg);
    }
  })();
}

/** 下载 whisper.cpp 运行时(zip)并解压出 whisper-cli.exe + DLL */
function startRuntimeDownload() {
  const key = 'runtime';
  if (dlState(key).running) return;
  dlState(key, { running: true, kind: 'runtime', pct: 0, msg: '准备下载运行时…', error: null, modelId: '', dir: WHISPER_RUNTIME.dir });
  (async () => {
    const zip = path.join(os.tmpdir(), `kass-whisper-${Date.now().toString(36)}.zip`);
    const cleanup = () => { try { fs.unlinkSync(zip); } catch {} };
    try {
      fs.mkdirSync(WHISPER_RUNTIME.dir, { recursive: true });
      await downloadAny(candidateUrls(WHISPER_RUNTIME.url), zip, (done, total) => {
        if (done < 0) return;
        const st = dlState(key);
        st.pct = total ? Math.min(99, Math.round(done / total * 100)) : 0;
        st.msg = `下载运行时：${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
      });
      // 解压: Windows 自带的 bsdtar 能解 zip(最可靠); 失败再退回 Expand-Archive。
      // 注意: 必须用**异步 spawn** —— 本环境下 spawnSync 会 EBUSY(实测),
      // 且此处本就在 async IIFE 里, await 天然可用。
      // (这里曾局部 require('child_process') —— 那会遮蔽外层包装器, 解压进程漏出 CHILDREN 登记表)
      const tmpEx = path.join(os.tmpdir(), `kass-whisper-ex-${Date.now().toString(36)}`);
      fs.mkdirSync(tmpEx, { recursive: true });
      const sysTar = path.join(process.env.SystemRoot || 'C:' + path.sep + 'Windows', 'System32', 'tar.exe');
      const runCmd = (cmd, args) => new Promise((resolve) => {
        const p = spawn(cmd, args, { windowsHide: true });
        let out = '';
        const t = setTimeout(() => { try { p.kill(); } catch {} }, 5 * 60 * 1000);
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('error', e => { clearTimeout(t); resolve({ status: -1, out: String((e && e.message) || e) }); });
        p.on('close', c => { clearTimeout(t); resolve({ status: c, out }); });
      });
      let r = await runCmd(sysTar, ['-xf', zip, '-C', tmpEx]);
      if (r.status !== 0) {
        const quote = String.fromCharCode(39);
        const psCmd = '$ErrorActionPreference = "Stop"; Expand-Archive -Path ' + quote + zip.replace(/'/g, quote + quote) + quote
          + ' -DestinationPath ' + quote + tmpEx.replace(/'/g, quote + quote) + quote + ' -Force';
        r = await runCmd('power' + 'shell.exe', ['-NoProfile', '-Command', psCmd]);
      }
      if (r.status !== 0) throw new Error('解压失败: ' + String(r.out || '').slice(-200));
      // 展平: 把所有文件(忽略目录结构)放进 WHISPER_RUNTIME.dir
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) walk(p);
          else fs.copyFileSync(p, path.join(WHISPER_RUNTIME.dir, f.name));
        }
      };
      walk(tmpEx);
      fs.rmSync(tmpEx, { recursive: true, force: true });
      if (!whisperRuntimeOk()) throw new Error('解压后未找到 whisper-cli.exe');
      cleanup();
      if (!whisperVulkanOk()) {
        // 不做 CPU 兜底: 没有 Vulkan 运行库 = ASR 没法跑 GPU, 直接算失败
        const st2 = dlState(key);
        st2.running = false;
        st2.error = '未检测到 Vulkan 运行库（ggml-vulkan.dll）。语音识别不支持纯 CPU，装/更新支持 Vulkan 的显卡驱动后重试';
        st2.msg = '运行时不可用: ' + st2.error;
        return;
      }
      dlState(key, { running: false, kind: 'runtime', pct: 100,
        msg: '运行时就绪（检测到 Vulkan，识别将走 GPU 加速）',
        error: null, modelId: '', dir: WHISPER_RUNTIME.dir });
    } catch (e) {
      cleanup();
      const st = dlState(key);
      st.running = false;
      st.error = String((e && e.message) || e);
      st.msg = '运行时下载失败: ' + st.error;
    }
  })();
}

/* ═══════════ Python 环境一键安装 ═══════════
 * Parakeet(sherpa-onnx) 依赖 Python, 但发行包不带 venv(体积), 用户机器可能没有 Python
 * 或只有 Microsoft Store 占位程序(退出码 9009)。一键安装两条路线:
 *   ① 系统 Python 可用(3.10~3.12) → python -m venv .venv → pip 装 requirements.txt(清华源)
 *   ② 否则 → 下载官方 Embeddable 包(11MB, 解压到 asr/runtime-python, 不写注册表不碰系统)
 *      → 改 _pth 启用 site-packages → get-pip → pip 装依赖
 * 进度走 downloads Map(key='pyenv'), 设置面板与其它下载共用同一套进度 UI。 */

/** 跑一个子进程收集输出; 非零退出抛错(带输出尾部)。 */
function runCapture(cmd, args, timeoutMs, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('执行超时（' + Math.round(timeoutMs / 1000) + 's）: ' + cmd)); }, timeoutMs);
    const feed = (chunk, isErr) => {
      const s = String(chunk);
      if (isErr) err += s; else out += s;
      if (onLine) for (const line of s.split(/\r?\n/)) { const t = line.trim(); if (t) onLine(t); }
    };
    p.stdout.on('data', c => feed(c, false));
    p.stderr.on('data', c => feed(c, true));
    p.on('error', e => { clearTimeout(timer); reject(new Error('无法启动 ' + cmd + ': ' + e.message)); });
    p.on('close', code => {
      clearTimeout(timer);
      const tail = (err || out).trim().split('\n').slice(-3).join(' | ').slice(-300);
      if (code !== 0) reject(new Error('退出码 ' + code + (tail ? ': ' + tail : '')));
      else resolve({ code, stdout: out, stderr: err });
    });
  });
}

/** pip 装大包在 Windows 上偶发「WinError 5 拒绝访问」: 杀软/Defender 实时扫描刚写入的文件,
 *  把它锁住 → pip rename dist-info 失败整个安装中断。属**可重试**错误(已装好的不会重下),
 *  所以这里重试几次再去报错 —— 实测 2.5GB 的 PyTorch 安装踩过两次。 */
async function pipInstallRetry(pyExe, args, timeoutMs, onLine, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await runCapture(pyExe, args, timeoutMs, onLine); }
    catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (!/拒绝访问|WinError 5|Access is denied|being used by another process|另一个程序正在使用/i.test(msg)) throw e;
      if (i < tries - 1) {
        if (onLine) onLine('（安装被文件锁打断, 3 秒后自动重试 ' + (i + 2) + '/' + tries + '）');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

/** pip 装依赖: 进度按输出行数粗略推进(没法拿精确百分比), 最后报 Successfully installed */
async function pipInstall(pyExe, prog, p0, p1) {
  let lines = 0, last = '';
  await runCapture(pyExe, ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', EMBEDDED_PY.pipIndex, '--quiet'], 300000);
  prog(Math.round(p0 + (p1 - p0) * 0.1), '正在下载依赖包（sherpa-onnx / numpy）…');
  await runCapture(pyExe,
    ['-m', 'pip', 'install', '-r', path.join(ASR_DIR, 'requirements.txt'), '-i', EMBEDDED_PY.pipIndex],
    600000,
    (line) => { lines++; last = line; prog(Math.min(p1 - 2, Math.round(p0 + (p1 - p0) * 0.15 + lines * 3)), '依赖安装中: ' + last.slice(0, 60)); });
}

/** 找可用的系统 Python(3.10~3.12, 排除 Store 占位程序); 找不到返回 null */
async function findSystemPython() {
  const candidates = [
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3'] },
  ];
  for (const c of candidates) {
    try {
      const r = await runCapture(c.cmd, [...c.args, '-c', 'import sys; print(sys.version.split()[0])'], 15000);
      const v = r.stdout.trim();
      const m = v.match(/^3\.(\d+)\./);
      if (m && Number(m[1]) >= 10 && Number(m[1]) <= 12) return { cmd: c.cmd, args: c.args, version: v };
    } catch {}
  }
  return null;
}

function startPyEnvSetup() {
  const key = 'pyenv';
  if (dlState(key).running) return;
  dlState(key, { running: true, kind: 'pyenv', pct: 0, msg: '检查 Python 环境…', error: null, modelId: 'pyenv', dir: EMBEDDED_PY.dir });
  (async () => {
    const prog = (pct, msg) => { const st = dlState(key); st.pct = Math.min(99, Math.round(pct)); st.msg = msg; };
    const finishOk = (msg) => {
      ASR_PY = resolvePython();      // 新解释器就位, 让后续识别立即用上
      pyProbeCache = null;           // 强制下次预检重新探测
      dlState(key, { running: false, kind: 'pyenv', pct: 100, msg, error: null, modelId: 'pyenv', dir: EMBEDDED_PY.dir });
    };
    const finishFail = (e) => {
      const st = dlState(key);
      st.running = false;
      st.error = String((e && e.message) || e);
      st.msg = '环境安装失败: ' + st.error;
    };
    const verify = async (pyExe) => {
      const r = await runCapture(pyExe, ['-c', 'import sherpa_onnx, numpy, sys; print(sys.version.split()[0] + " / sherpa-onnx " + str(getattr(sherpa_onnx, "__version__", "?")))'], 60000);
      return r.stdout.trim();
    };
    try {
      let pyExe = null, info = '';

      // 0) 现有解释器已经能用 → 跳过基础安装; 还没上 CUDA 时继续往下做 GPU 升级(有 N 卡才升)。
      //    基础环境与 GPU 解耦: 说话人分离(diarize.py)只依赖基础环境, 无 N 卡也能用。
      try {
        const pre = await probePython('sherpa');
        if (pre.ok) {
          pyExe = ASR_PY;
          info = pre.msg;
          if (asrProvider() === 'cuda') return finishOk('已就绪: ' + info + '（GPU·CUDA）');
          prog(50, '基础环境已就绪，检查 CUDA GPU 升级…');
        }
      } catch {}

      // ① 系统 Python 可用 → 建 venv
      if (!pyExe) {
        prog(3, '检查系统 Python…');
        const sys = await findSystemPython();
        if (sys) {
          prog(6, '系统 Python ' + sys.version + '，创建虚拟环境…');
          const venvDir = path.join(ASR_DIR, '.venv');
          try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch {}
          await runCapture(sys.cmd, [...sys.args, '-m', 'venv', venvDir], 180000);
          const vpy = path.join(venvDir, 'Scripts', 'python.exe');
          prog(15, '虚拟环境已建好，安装 pip…');
          await pipInstall(vpy, prog, 15, 90);
          prog(92, '验证依赖…');
          info = await verify(vpy);
          pyExe = vpy;
        }
      }

      // ② 内置 Python(Embeddable): 解压即用, 不写注册表/不改 PATH, 删目录即卸载
      if (!pyExe) {
        prog(28, '未找到系统 Python，下载内置 Python ' + EMBEDDED_PY.version + '（约 11MB）…');
        const zip = path.join(os.tmpdir(), `kass-py-${Date.now().toString(36)}.zip`);
        try { fs.unlinkSync(zip); } catch {}
        await downloadAny(EMBEDDED_PY.zipUrls, zip, (done, total) => {
          if (done >= 0 && total) prog(28 + Math.min(14, done / total * 14), `下载内置 Python… ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
        });
        prog(44, '解压内置 Python…');
        fs.rmSync(EMBEDDED_PY.dir, { recursive: true, force: true });
        fs.mkdirSync(EMBEDDED_PY.dir, { recursive: true });
        const sysTar = path.join(process.env.SystemRoot || 'C:' + path.sep + 'Windows', 'System32', 'tar.exe');
        await runCapture(sysTar, ['-xf', zip, '-C', EMBEDDED_PY.dir], 300000);
        try { fs.unlinkSync(zip); } catch {}
        // Embeddable 包默认不加载 site-packages: 改 _pth 打开(否则 pip 装的包导不进来)
        prog(50, '启用 site-packages…');
        const pth = fs.readdirSync(EMBEDDED_PY.dir).find(n => /^python\d+\._pth$/i.test(n));
        if (!pth) throw new Error('解压后未找到 python._pth 配置文件');
        const majMin = (EMBEDDED_PY.version.match(/^3\.(\d+)\./) || [])[1] || '12';
        fs.writeFileSync(path.join(EMBEDDED_PY.dir, pth),
          `python3${majMin}.zip\n.\nLib/site-packages\nimport site\n`, 'utf8');
        prog(54, '安装 pip…');
        const getpip = path.join(os.tmpdir(), `get-pip-${Date.now().toString(36)}.py`);
        await downloadAny([EMBEDDED_PY.getPipUrl], getpip, () => {});
        await runCapture(embeddedPyExe(), [getpip, '--no-warn-script-location', '-i', EMBEDDED_PY.pipIndex], 300000);
        try { fs.unlinkSync(getpip); } catch {}
        prog(66, '安装语音识别依赖（sherpa-onnx / numpy，走清华源）…');
        await pipInstall(embeddedPyExe(), prog, 66, 90);
        prog(92, '验证依赖…');
        info = await verify(embeddedPyExe());
        pyExe = embeddedPyExe();
      }
      if (!pyExe) throw new Error('未能准备可用的 Python 环境');

      // ③ CUDA 版 sherpa-onnx(Parakeet 专用): 检测到 N 卡 → 换装(wheel 自带 cuDNN/cuBLAS, 约 190MB,
      //    走 hf-mirror 镜像)。与基础环境解耦: 无 N 卡时基础环境照常完成(说话人分离可用),
      //    Parakeet 则明确标记不可用 —— ASR 必须 GPU, 不做 CPU 兜底。
      const gpuName = await nvidiaGpu();
      if (!gpuName) {
        return finishOk('基础环境就绪: ' + info + '（没检测到 NVIDIA 显卡。说话人分离可用；Parakeet 识别必须 CUDA GPU，不支持 CPU）');
      }
      if (asrProvider() === 'cuda') return finishOk('安装完成: ' + info + ' / GPU·CUDA（' + gpuName + '）');

      let cudaTried = false;
      try {
        // 清掉 pip 中断留下的坏分布(~/~xxx 目录): 残留会让包内新旧 DLL 混装, CUDA EP 版本对不上
        try {
          const spDir = path.join(path.dirname(path.dirname(pyExe)), 'Lib', 'site-packages');
          for (const n of fs.readdirSync(spDir)) {
            if (n.startsWith('~')) { try { fs.rmSync(path.join(spDir, n), { recursive: true, force: true }); } catch {} }
          }
        } catch {}
        prog(94, '检测到 ' + gpuName + '，安装 CUDA 版 sherpa-onnx（约 190MB, 自带 cuDNN 运行库）…');
        const whlName = 'sherpa_onnx-1.13.8%2Bcuda12.cudnn9-cp312-cp312-win_amd64.whl';
        // 注意: 必须保留 wheel 原始文件名 —— pip 靠文件名解析包名/版本, 改名直接报 Invalid wheel filename
        const whl = path.join(os.tmpdir(), decodeURIComponent(whlName));
        try { fs.unlinkSync(whl); } catch {}
        await downloadAny([
          `${HF_ENDPOINT}/csukuangfj2/sherpa-onnx-wheels/resolve/main/cuda/1.13.8/${whlName}`,
          `https://huggingface.co/csukuangfj2/sherpa-onnx-wheels/resolve/main/cuda/1.13.8/${whlName}`,
        ], whl, (done, total) => {
          if (done >= 0 && total) prog(94 + Math.min(4, done / total * 4), `下载 CUDA 版 sherpa-onnx… ${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
        });
        cudaTried = true;
        // 清理上次安装中断留下的坏分布(site-packages/~xxx): 不清会让新旧 DLL 混装,
        // 运行时报「ORT API version 28 not available, only [1,17]」这类诡异错误(实测踩过)
        try {
          const spOut = await runCapture(pyExe, ['-c', "import sysconfig; print(sysconfig.get_paths()['purelib'])"], 30000);
          const sp = spOut.stdout.trim();
          if (sp && fs.existsSync(sp)) {
            for (const n of fs.readdirSync(sp)) {
              if (n.startsWith('~')) { try { fs.rmSync(path.join(sp, n), { recursive: true, force: true }); } catch {} }
            }
          }
        } catch {}
        prog(98, '安装 CUDA 版 sherpa-onnx…');
        await runCapture(pyExe, ['-m', 'pip', 'install', '--force-reinstall', '--no-deps', whl, '-i', EMBEDDED_PY.pipIndex], 600000);
        try { fs.unlinkSync(whl); } catch {}
        // CUDA 运行库: wheel 本体不带 cuBLAS/cuDNN —— 缺了它们 providers_cuda.dll 加载失败(实测),
        // 用 NVIDIA 官方 pip 包补齐(Windows wheel, 走清华源; cuDNN 约 550MB)
        prog(98, '安装 CUDA 运行库（cuBLAS / cuDNN，约 1GB，走清华源）…');
        await runCapture(pyExe,
          ['-m', 'pip', 'install', 'nvidia-cuda-runtime-cu12', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12', 'nvidia-cufft-cu12', 'nvidia-curand-cu12', '-i', EMBEDDED_PY.pipIndex],
          1800000,
          (line) => { if (/Downloading|Installing|Successfully/i.test(line)) prog(98, 'CUDA 运行库: ' + line.slice(0, 60)); });
        // import 验证: CUDA 运行库缺失/驱动过旧会在这里直接抛错
        prog(99, '验证 CUDA 环境…');
        await runCapture(pyExe, ['-c', 'import sherpa_onnx'], 120000);
        const s = readAsrSettings();
        s.asrProvider = 'cuda';
        writeAsrSettings(s);
        finishOk('安装完成: ' + info + ' / GPU·CUDA（' + gpuName + '）');
      } catch (e) {
        if (cudaTried) {
          // 基础环境已装好(说话人分离可用), 但 Parakeet 依赖的 CUDA 版没装上 → 明确失败, 不做 CPU 兜底。
          // 先把基础环境标记为可用, 让 diarize 立即能用; 失败状态只针对 Parakeet 的 CUDA 部分。
          ASR_PY = resolvePython();
          pyProbeCache = null;
          throw new Error('CUDA 版 sherpa-onnx 安装失败: ' + String((e && e.message) || e).slice(0, 200)
            + '。基础环境已就绪（说话人分离可用），Parakeet 识别用不了（必须 CUDA GPU，不支持 CPU）。检查显卡驱动和磁盘空间后重试');
        } else throw e;
      }
    } catch (e) { finishFail(e); }
  })();
}

/** whisper.cpp 引擎: 跑 whisper-cli, 词级时间戳用 -ml 1 -sow(每词一段)。
 *  返回 {segments:[{start,end,text,words:[{word,start,end}]}]} —— 与 asr.py 输出同构。 */
function runWhisperCpp(modelBin, wav, onProgress, opts) {
  const exe = whisperCli();
  const outPrefix = wav + '.cpp';
  const cmd = [exe, '-m', modelBin, '-f', wav, '-oj', '-of', outPrefix, '-ml', '1', '-sow', '-t', '4', '-l', 'en'];
  // 识别提示词: 专有名词给解码器做上下文, 实测能显著修正人名/术语拼写(限长防复读幻觉)
  const wp = whisperPrompt(asrTerms().terms);
  if (wp) cmd.push('--prompt', wp);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0], cmd.slice(1), { windowsHide: true, cwd: WHISPER_RUNTIME.dir });
    if (opts && opts.register) { try { opts.register(p); } catch {} }
    const started = Date.now();
    let lastPct = -1, lastErrLine = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 30 * 60 * 1000);
    // 进度解析: whisper.cpp 的进度条(%)打在 **stderr**, stdout 只有转写结果 —— 之前只看
    // stdout 导致界面永远收不到进度, 一直停在「启动识别引擎…」(用户报"卡住"实为此因)。
    // 注: 原来这里还把 stdout 累加进 out, 但转写结果是走 whisper 自己的 .json 文件读的,
    // out 从头到尾没人读 —— 已删(留着只是白白吃内存, 长音频能攒几百 MB)。
    const sink = (d) => {
      const s = String(d);
      for (const line of s.split(/[\r\n]+/)) {
        const t = line.trim();
        if (!t) continue;
        if (/error|failed|invalid/i.test(t)) lastErrLine = t;
        const m = /(\d{1,3})%\s*?$/.exec(t) || /(\d{1,3})%\s+\[/.exec(t);
        if (m) {
          const pct = Math.min(100, parseInt(m[1], 10));
          if (pct !== lastPct && onProgress) { lastPct = pct; onProgress(pct); }
        }
      }
    };
    p.stdout.on('data', sink);
    p.stderr.on('data', sink);
    // 兜底心跳: 无论进度解析到没有, 每 20s 报一次已运行时长(用户能看到它活着)
    const beat = setInterval(() => {
      if (onProgress) onProgress(Math.max(0, lastPct), Math.round((Date.now() - started) / 1000));
    }, 20000);
    p.on('error', e => { clearTimeout(timer); clearInterval(beat); reject(new Error('无法启动 whisper-cli: ' + e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer); clearInterval(beat);
      const jsonPath = outPrefix + '.json';
      let data = null;
      try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
      for (const f of [outPrefix + '.json', outPrefix + '.txt', outPrefix + '.json.sys', outPrefix + '.txt.sys']) { try { fs.unlinkSync(f); } catch {} }
      if (code !== 0 || !data) {
        const mins = Math.round((Date.now() - started) / 60000);
        const hint = lastErrLine ? '：' + lastErrLine.slice(0, 200) : '';
        return reject(new Error('whisper.cpp 识别失败（退出码 ' + code + '，运行 ' + mins + ' 分钟）' + hint));
      }
      // 每词一段 → 词数组（毫秒 → 秒），修复零时长词段
      const words = [];
      for (const s of (data.transcription || [])) {
        const text = (s.text || '').trim();
        if (!text) continue;
        const off = s.offsets || {};
        const w = { word: text, start: (off.from || 0) / 1000, end: (off.to || 0) / 1000 };
        if (w.end <= w.start) w.end = w.start + 0.2;
        words.push(w);
      }
      if (!words.length) return reject(new Error('未识别到语音内容（whisper.cpp 输出为空）'));
      words.sort((a, b) => a.start - b.start);
      // 分句(与 asr.py 的 words_to_segments 同规则: 句末标点/停顿>0.8s/行长兜底)
      const groups = [];
      let cur = [];
      for (const w of words) {
        if (cur.length) {
          const prev = cur[cur.length - 1];
          const tooLong = (w.start - cur[0].start) > 10 || cur.length >= 30;
          if (/[.?!…]$/.test(prev.word) || (w.start - prev.end) > 0.8 || tooLong) { groups.push(cur); cur = []; }
        }
        cur.push(w);
      }
      if (cur.length) groups.push(cur);
      const segments = groups.map((ws) => ({
        start: +ws[0].start.toFixed(3), end: +ws[ws.length - 1].end.toFixed(3),
        text: ws.map(w => w.word).join(' ').trim(),
        words: ws.map(w => ({ word: w.word, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })),
      }));
      for (let i = 1; i < segments.length; i++) if (segments[i].start < segments[i - 1].end) segments[i].start = segments[i - 1].end;
      resolve({ segments, language: 'en' });
    });
  });
}

/* ═══════════ 简单路由表 ═══════════
 * handleRequest 曾是 2900+ 行的单体函数, 光开头这十几个"查一下就回"的简单端点就占了
 * 40 多行 if。现在把它们抽成这张表: 新增端点 = 加一行, 不用翻 3000 行去找插入点。
 *
 * 只收「同步、无副作用、不碰项目状态」的处理器 —— 也就是原来那些一进函数就return 的分支。
 * 涉及流水线/落盘/共享状态的端点(波形、peaks、项目、ASR、翻译…)仍在 handleRequest 里按原样处理,
 * 因为它们要读写 draftJobs / fetchJobs 等跨请求状态, 拆出去反而要注入一堆东西。
 *
 * 处理器签名统一 (req, res, u) → boolean: 处理了就return true(handleRequest 收尾),
 * 返回 false 表示"不归我管", 继续往下走原来的 if 链。行为与拆分前逐字一致。
 */
const SIMPLE_ROUTES = [
  // 首页: 302 到真正的编辑器页
  ['/', (req, res) => { send(res, 302, { Location: '/editor/index.html' }, ''); return true; }],
  ['/index.html', (req, res) => { send(res, 302, { Location: '/editor/index.html' }, ''); return true; }],

  // 稿件样本清单
  ['/api/samples', (req, res) => {
    send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
      JSON.stringify(listSamples()));
    return true;
  }],

  // 代码版本戳: 已经开着的页面用它判断自己是否已过期 → 提示用户刷新
  ['/api/version', (req, res) => {
    const miss = libassMissing();
    send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
      JSON.stringify({ stamp: BUILD_STAMP, version: APP_VERSION,
                       vendorOk: miss.length === 0,
                       vendorMissing: miss,
                       vendorHint: miss.length ? LIBASS_HINT : '' }));
    return true;
  }],

  // 本机字体清单: 给 ASS 样式面板做候选, 用户填名字就能用系统字体(见 editor/fonts.js)
  ['/api/fonts', (req, res) => {
    let list = [];
    try { list = fonts.listFonts().map(f => f.family); }
    catch (e) { console.error('[fonts] 字体清单读取失败: ' + (e && e.message || e)); }
    sendJson(res, 200, { count: list.length, fonts: list });
    return true;
  }],

  // 字体文件字节。**只按家族名查表**, 不接受路径 —— 页面拿不到任意文件读的能力。
  // 集合字体(.ttc)在这里抽成单个 face 再回, 因为 wasm fontconfig 会静默忽略 .ttc。
  ['/api/font-file', (req, res, u) => {
    const want = u.searchParams.get('name') || '';
    const entry = fonts.findFont(want);
    if (!entry) { sendJson(res, 404, { error: '未找到字体: ' + want }); return true; }
    let buf;
    try { buf = fonts.readFontBytes(entry); }
    catch (e) { sendJson(res, 500, { error: '读取字体失败: ' + (e && e.message || e) }); return true; }
    res.writeHead(200, {
      'Content-Type': 'font/ttf',
      'Cache-Control': 'no-cache',
      'Content-Length': buf.length,
      'X-Font-Family': encodeURIComponent(entry.families[0] || want)
    });
    res.end(buf);
    return true;
  }],

  // 站点图标(内联 SVG, 省得浏览器请求 /favicon.ico 报 404 污染控制台)
  ['/favicon.ico', sendFavicon],
  ['/favicon.svg', sendFavicon],
];

function sendFavicon(req, res) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#6d5efc"/>'
    + '<text x="16" y="24" font-size="20" text-anchor="middle">🎬</text></svg>';
  send(res, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }, svg);
  return true;
}

const SIMPLE_ROUTE_MAP = new Map(SIMPLE_ROUTES);

/* ── 本地服务安全基线(防 DNS rebinding / CSRF) ─────────────────────────
 * 攻击场景: 恶意网页把自己的域名解析到 127.0.0.1, 浏览器就把"同源请求"打到本服务上
 * (服务只绑 127.0.0.1 也拦不住 —— 浏览器视角这就是同源)。两道防线:
 *   ① Host 必须是回环地址 —— rebinding 时浏览器发的是 evil.com, 这里直接 403;
 *   ② 写方法若带 Origin(浏览器必带), 必须同源; 无 Origin 的非浏览器调用(tray/脚本/测试)放行。 */
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function handleRequest(req, res) {
  if (!LOOPBACK_HOST_RE.test(String(req.headers.host || '').trim())) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden: host');
  }
  if (UNSAFE_METHODS.has(req.method)) {
    const origin = String(req.headers.origin || '').trim();
    if (origin && !LOOPBACK_ORIGIN_RE.test(origin)) {
      return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden: origin');
    }
  }
  const u = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = u.pathname;

  // 测试用页面（tests/*.html 的验证页要 fetch /api/*，file:// 下是跨源拿不到数据）
  if (serveTestPage(req, res, pathname)) return;

  // 简单端点先查表(见上方 SIMPLE_ROUTES 注释: 只收同步无副作用的处理器)
  const simple = SIMPLE_ROUTE_MAP.get(pathname);
  if (simple && simple(req, res, u)) return;

  // 波形图: 示例视频直接读磁盘原文件(不复制/不保存), 本地文件走 POST 上传临时文件(用完即删)
  if (pathname === '/api/waveform') {
    console.log('[waveform] GET', pathname + u.search, 'from', req.headers.referer || '-');
    const name = u.searchParams.get('name') || '';
    const dur = parseFloat(u.searchParams.get('dur')) || 0;
    const full = path.join(ROOT, name);
    let okPath = false;
    try { okPath = fs.statSync(full).isFile() && path.dirname(full) === ROOT && VIDEO_EXTS.includes(path.extname(name).toLowerCase()); } catch {}
    if (!okPath) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'video not found');
    makeWaveform(full, dur, (err, buf) => {
      if (err) return send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, String(err.message || err));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      res.end(buf);
    });
    return;
  }
  if (pathname === '/api/waveform-upload' && req.method === 'POST') return waveformFromTemp(req, res, parseFloat(u.searchParams.get('dur')) || 0);

  // 峰值数据: 每 1/rate 秒一个包络值(Uint8 二进制), 前端按像素列矢量绘制(任意缩放都锐利)
  if (pathname === '/api/peaks') {
    console.log('[peaks] GET', pathname + u.search, 'from', req.headers.referer || '-');
    const name = u.searchParams.get('name') || '';
    const dur = parseFloat(u.searchParams.get('dur')) || 0;
    const rate = Math.max(20, Math.min(200, parseFloat(u.searchParams.get('rate')) || 100));
    const full = path.join(ROOT, name);
    let okPath = false;
    try { okPath = fs.statSync(full).isFile() && path.dirname(full) === ROOT && VIDEO_EXTS.includes(path.extname(name).toLowerCase()); } catch {}
    if (!okPath) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'video not found');
    const go = (d) => buildPeaks(full, d, rate, (err, buf) => {
      if (err) return send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, String(err.message || err));
      sendPeaks(res, buf, rate);
    });
    if (dur > 0) go(dur); else probeDuration(full, (d) => go(d));
    return;
  }
  if (pathname === '/api/peaks-upload' && req.method === 'POST') {
    const rate = Math.max(20, Math.min(200, parseFloat(u.searchParams.get('rate')) || 100));
    return peaksFromTemp(req, res, parseFloat(u.searchParams.get('dur')) || 0, rate);
  }
  /** 浏览器选视频的兜底通道: 把上传的视频存成服务端**持久**文件并返回真实路径,
   *  之后与本地路径选视频完全同构(/api/media Range 流式播放、prepare 提取音频波形)。
   *  为什么存持久文件: 项目要"下次打开还在", 而浏览器 File 对象只在本次会话有效。
   *  目标目录: <项目根>/videos/ (文件名去重: 重名追加 -1/-2…) */
  if (pathname === '/api/upload-video' && req.method === 'POST') {
    const name = decodeURIComponent(u.searchParams.get('name') || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'video.mp4';
    const ext = path.extname(name) || '.mp4';
    const base = path.basename(name, ext);
    const dir = path.join(ROOT, 'videos');
    fs.mkdirSync(dir, { recursive: true });
    let finalName = name, n = 0;
    while (fs.existsSync(path.join(dir, finalName))) finalName = `${base}-${++n}${ext}`;
    const dest = path.join(dir, finalName);
    const out = fs.createWriteStream(dest);
    let size = 0, done = false;
    const finish = (code, body) => { if (done) return; done = true; sendJson(res, code, body); };
    // 注意: 用 pipe 就不要再手动 out.end() —— 双重 end 会触发 ERR_STREAM_ALREADY_FINISHED,
    // 流被错误终结后 'finish' 永不触发, 请求挂死(前端兜底通道完全不可用)
    req.on('data', c => { size += c.length; if (size > 32 * 1024 * 1024 * 1024) { req.destroy(); out.destroy(); try { fs.unlinkSync(dest); } catch {} finish(413, { error: '文件超过 32GB 上限' }); } });
    req.on('error', () => { out.destroy(); try { fs.unlinkSync(dest); } catch {} finish(500, { error: '上传中断' }); });
    out.on('error', () => { try { fs.unlinkSync(dest); } catch {} finish(500, { error: '写入失败(磁盘/权限?)' }); });
    out.on('finish', () => {
      let okExt = VIDEO_EXTS.includes(path.extname(dest).toLowerCase());
      if (!okExt) { try { fs.unlinkSync(dest); } catch {} return finish(400, { error: '不支持的格式: ' + path.extname(dest) }); }
      MEDIA_ALLOW.add(mediaKey(dest));   // 上传落盘的视频登记进 /api/media 白名单
      return finish(200, { path: dest, name: finalName, size });
    });
    req.pipe(out);
    return;
  }

  /* ═══════════ 项目系统 ═══════════
   * 每个项目一个目录: projects/<id>/project.json + subtitle.{ass,srt} + audio.wav(16k单声道, 给后续 ASR) + peaks.bin(波形包络缓存)
   * 视频不复制: 元数据里记用户选择的本地路径, 播放走 /api/media 按路径 Range 流式; 文件消失 → 客户端要求重选 */
  const PROJECTS_DIR = path.join(ROOT, 'projects');
  const AUDIO_SR = 16000;      // ASR 友好: 16kHz 单声道 s16
  // prepareJobs 定义在模块作用域(跨请求共享), 见 server 创建之前的说明

  function projDir(id) { return path.join(PROJECTS_DIR, id); }
  function metaPath(id) { return path.join(projDir(id), 'project.json'); }
  const validId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

  /* ── 用户操作日志的读写 ────────────────────────────────────────────
   * 必须放在这里（handleRequest 内部），因为它要用上面的 projDir()。
   * ⚠ 早期放在模块作用域 → 每次调用都 `ReferenceError: projDir is not defined`，
   *   又被 catch 吞掉，只表现为"写不进去"（written: 0），排查了好一阵。
   * 落盘到 projects/<id>/oplog.json：跟着项目走、跨重启留存
   * （服务运行日志是 console 镜像、只留内存、重启即清，两者用途不同）。 */
  const opLogPath = (id) => path.join(projDir(id), 'oplog.json');
  function readOpLog(id) {
    try {
      const a = JSON.parse(fs.readFileSync(opLogPath(id), 'utf8'));
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }
  /** 追加一条：action 机器可读，detail 给用户看，why 说明原因/依据。
   *  返回 { ok } 或 { ok:false, err } —— 把原因带出来，否则只能靠猜。 */
  function appendOpLog(id, entry) {
    try {
      const list = readOpLog(id);
      list.push({
        t: new Date().toISOString(),
        action: String((entry && entry.action) || '').slice(0, 60),
        target: String((entry && entry.target) || '').slice(0, 120),
        detail: String((entry && entry.detail) || '').slice(0, 400),
        why: String((entry && entry.why) || '').slice(0, 400),
      });
      while (list.length > OP_LOG_MAX) list.shift();
      const p = opLogPath(id);
      fs.writeFileSync(p + '.tmp', JSON.stringify(list));
      fs.renameSync(p + '.tmp', p);          // 原子替换，别留半截
      return { ok: true };
    } catch (e) {
      const err = String((e && e.message) || e);
      console.warn('[oplog] 写入失败：' + err);
      return { ok: false, err };
    }
  }

  function readMeta(id) {
    // 并发写(如 sendBeacon 保存与打开同时发生)可能读到写了一半的文件: 重试几次
    for (let i = 0; i < 3; i++) {
      try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); }
      catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); } catch {} }
    }
    return null;
  }
  function writeMeta(meta) {
    fs.mkdirSync(projDir(meta.id), { recursive: true });
    const tmp = metaPath(meta.id) + '.tmp';     // 临时文件 + 原子改名: 并发请求永远读不到半截 JSON
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, metaPath(meta.id));
    // 项目记录过的视频路径登记进 /api/media 白名单(meta 是本进程内唯一可信来源;
    // 新建/重连/下载完成后都会途经这里, 保证创建后立刻可播, 不用等 meta 扫描缓存过期)
    if (meta.video && meta.video.path) MEDIA_ALLOW.add(mediaKey(meta.video.path));
  }
  function touchMeta(meta) { meta.modifiedAt = new Date().toISOString(); writeMeta(meta); }

  /** 对外视图: 元数据 + 派生状态(视频是否还在/资产是否就绪/中断修正) */
  function metaView(meta) {
    const v = Object.assign({}, meta);
    v.videoExists = !!(meta.video && meta.video.path && fs.existsSync(meta.video.path));
  // 正在下载的项目: 视频文件还不存在, 但卡片不该显示"找不到视频"
  v.fetching = !!(meta.draft && meta.draft.status === 'running' && meta.draft.fetch && !v.videoExists);
    // hasPeaks 必须**校验格式版本**: PEAK_VER 升级后老项目的 peaks.bin 是旧格式
    // (单通道 abs 峰值 + 固定增益削顶), 直接拿来画还是一坨实心带。
    // 判为 false → 走 prepare 兜底补跑重算(见 POST /api/projects/:id/prepare)。
    v.hasPeaks = !!(meta.peaks && meta.peaks.file
      && (meta.peaks.ver || 1) === PEAK_VER
      && fs.existsSync(path.join(projDir(meta.id), meta.peaks.file)));
    v.hasAudio = !!(meta.audio && meta.audio.file && fs.existsSync(path.join(projDir(meta.id), meta.audio.file)));
    if (v.prepare && v.prepare.status === 'running' && !prepareJobs.has(meta.id)) {
      v.prepare.status = 'error';
      v.prepare.error = '服务已重启，提取被中断';
    }
    // 初稿: 处于 prepare 阶段时记在 pendingAsr, 之后的阶段记在 draftJobs —— 两者都没有才算意外中断
    if (v.draft && v.draft.status === 'running' && !draftJobs.has(meta.id) && !pendingAsr.has(meta.id)) {
      v.draft = Object.assign({}, v.draft, { status: 'error', error: '服务已重启，处理被中断' });
    }
    return v;
  }

  /** 读满请求体后调用 cb。回调在 **http 请求异步阶段**执行, createServer 的 try/catch 管不到它 ——
   *  回调里一抛异常, 请求就会永久悬着(前端 fetch 永不 settle, 表现成"按钮点了没反应"),
   *  只有全局 uncaughtException 记一条日志。实测踩过: resolveRerecogModel 里一个 ReferenceError
   *  让「选区重新识别」按钮 100% 点不动、连报错提示都没有。
   *  所以这里就地兜住: 抛了就回 500(带原因), 已发过响应则收尾, 绝不让请求悬着。 */
  function readBody(req, res, limit, cb) {
    const chunks = []; let size = 0, dead = false;
    const done = (err, body) => {
      if (dead) return;
      dead = true;
      try { cb(err, body); }
      catch (e) {
        const msg = String((e && e.message) || e);
        console.error('[handler error]', req.method, req.url, '\n', (e && e.stack) || e);
        try {
          if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误：' + msg });
          else res.end();
        } catch {}
      }
    };
    req.on('data', c => { size += c.length; if (size > limit) { dead = true; req.destroy(); return; } chunks.push(c); });
    req.on('error', () => done(new Error('request body 读取失败')));
    req.on('end', () => done(null, Buffer.concat(chunks)));
  }
  /** 后台提取: 一次 ffmpeg 同时产出 audio.wav 与 peaks 原始 PCM(asplit), 全部临时文件成功后原子改名
   *  mode='denoise'(默认): 音频走 afftdn 降噪(内置滤镜, 无需外部模型)后再保存;
   *  mode='raw': 直接抽视频原声, 不做任何处理。
   *  audio.wav 是 ASR(初稿/whisper.cpp/重新识别)与"降噪模式播放"的唯一输入,
   *  模式记录在 meta.audio.mode, 可在编辑器工具栏切换后「重新生成音频」重建。 */
  /* ─────────── 下载初稿流水线（bilibili / YouTube → 下载进项目目录 → 接着跑初稿） ───────────
 * 设计: 用户在"新建项目"里填链接 → 服务端先建项目(卡片立刻可见, 阶段=下载中) →
 *       后台跑 asr/fetch/fetch_cli.py（逐行 JSON 进度, 与 asr/*.py 同一协议）→
 *       下完把 meta.video 指向项目内 video/ 里的文件 + 写 meta.source(给 LLM 分角色用) →
 *       交棒给现有 prepare/ASR 流水线。
 * Cookie/代理 存在 asr/settings.json 的 fetch 段; **对外只回"有没有", 绝不回传值**。 */
const FETCH_SCRIPT = path.join(ASR_DIR, 'fetch', 'fetch_cli.py');
const FETCH_STAGE = '下载中';
/* 敏感值统一走 secret-store(require 在文件头部): bilibili Cookie / LLM API Key 都走密文, 不明文进 settings.json */
const fetchJobs = new Map();          // 项目 id -> { proc }

/** 读 fetch 设置。顺带做两件事：
 *  ① 旧版的**明文** Cookie（fetch.biliCookie）迁成密文（fetch.biliCookieEnc）并清掉明文字段；
 *  ② 解密后的明文只放在内存（__biliCookiePlain），**不回传前端、不进日志**。 */
function fetchSettings() {
  let f = {};
  try { f = readAsrSettings().fetch || {}; } catch { return {}; }
  // 只贴了值的（没有 `SESSDATA=` 前缀）在**读的时候就补上**：这样键名回显、下载、登录检测三处口径一致
  const plainLegacy = normalizeBiliCookie(String(f.biliCookie || ''));
  if (plainLegacy) {
    let enc = '';
    try { enc = secretStore.encrypt(plainLegacy); } catch (e) { console.error('[fetch] Cookie 加密失败:', e && e.message); }
    if (enc) {
      try {
        patchFetchSettings({ biliCookie: '', biliCookieEnc: enc, biliCookieSavedAt: f.biliCookieSavedAt || new Date().toISOString() });
        f = Object.assign({}, f, { biliCookie: '', biliCookieEnc: enc });
        console.log('[fetch] bilibili Cookie 已从明文迁移为密文（' + secretStore.backend() + '）');
      } catch (e) { console.error('[fetch] Cookie 迁移写盘失败:', e && e.message); }
    }
  }
  let plain = plainLegacy;
  if (!plain && f.biliCookieEnc) {
    try { plain = normalizeBiliCookie(secretStore.decrypt(String(f.biliCookieEnc))); }
    catch (e) {
      console.error('[fetch] Cookie 解不开（换过机器或 Windows 用户？）：' + ((e && e.message) || e) + '。重新粘贴一次 Cookie 就能恢复');
      plain = '';
    }
  }
  f.__biliCookiePlain = plain;
  return f;
}
function patchFetchSettings(patch) {
  const s = readAsrSettings();
  s.fetch = Object.assign({}, s.fetch || {}, patch || {});
  writeAsrSettings(s);
  return s.fetch;
}
/** 对外视图: 只给"有没有 cookie"和键名, 值一律不回传 */
function fetchPublicSettings() {
  const f = fetchSettings();
  const ck = String(f.__biliCookiePlain || f.biliCookie || '');
  const keys = ck
    ? Array.from(new Set(ck.split(/[;\n]/).map((x) => String(x).split('=')[0].trim()).filter(Boolean)))
    : [];
  return {
    quality: f.quality || 'best',
    proxy: f.proxy || '',
    cookiesFromBrowser: f.cookiesFromBrowser || '',
    hasBiliCookie: !!ck,
    biliCookieKeys: keys.slice(0, 12),
    biliCookieSavedAt: f.biliCookieSavedAt || '',
    biliCookieEnc: !!f.biliCookieEnc,                 // 磁盘上是密文（不是明文躺着）
    cookieBackend: secretStore.backend(),             // dpapi = 系统级加密 / aes = 本机混淆
    ready: fetchReady(),
  };
}

/** 把 `k=v; k2=v2`（或 JSON）写成 yt-dlp 吃的 Netscape cookies.txt ——
 *  与 asr/fetch/bilibili.py 的 write_netscape 同格式。**下载时不再把明文 Cookie 放命令行**
 *  （命令行在进程列表里谁都能看），改为落到项目目录的 cookie 文件。 */
function writeNetscapeCookieFile(cookieText, dest, domain) {
  const src = String(cookieText || '').trim();
  const pairs = [];
  const addPair = (k, v) => { if (k) pairs.push([String(k).trim(), String(v == null ? '' : v).trim()]); };
  if (src.startsWith('{')) {
    try {
      const obj = JSON.parse(src);
      if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) addPair(k, obj[k]);
    } catch {}
  } else {
    for (const item of src.split(/[;\n]/)) {
      const it = item.trim();
      if (!it || it.indexOf('=') < 0) continue;
      const i = it.indexOf('=');
      addPair(it.slice(0, i), it.slice(i + 1));
    }
  }
  if (!pairs.length) return false;
  const exp = Math.floor(Date.now() / 1000) + 180 * 24 * 3600;
  const lines = ['# Netscape HTTP Cookie File', '# 由 SubFabric 生成（来源：用户在设置里粘贴）', ''];
  for (const [k, v] of pairs) lines.push([domain || '.bilibili.com', 'TRUE', '/', 'FALSE', String(exp), k, v].join('\t'));
  fs.writeFileSync(dest, lines.join('\n') + '\n', 'utf8');
  return true;
}

/** 用一份 Cookie 问 bilibili：**这次到底登录上没有**（保存后 / 打开设置时调用）。
 *  返回 {ok, isLogin, uname, vip, vipLabel, vipDue, message}；任何异常都变成 message，不抛。 */
async function biliLoginCheck(cookieText) {
  const raw = String(cookieText || '').trim();
  if (!raw) return { ok: false, isLogin: false, message: '没有 Cookie' };
  const ck = /[=;]/.test(raw) || raw.startsWith('{') ? raw : ('SESSDATA=' + raw);
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Cookie': ck,
      },
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => null);
    if (!j || typeof j.code !== 'number') return { ok: false, isLogin: false, message: '接口返回看不懂（可能被风控）' };
    const d = j.data || {};
    if (!d.isLogin) {
      return {
        ok: false, isLogin: false, code: j.code,
        message: j.code === -101 ? '未登录：Cookie 不完整或已过期，重新复制一份' : ('未登录（code=' + j.code + '）'),
      };
    }
    const vip = d.vipStatus === 1;
    const vipLabel = vip ? String((d.vip_label && d.vip_label.text) || '大会员') : '';
    return {
      ok: true, isLogin: true, code: j.code,
      uname: String(d.uname || ''), mid: Number(d.mid) || 0,
      vip, vipLabel, vipDue: Number(d.vipDueDate) || 0,
      message: '已登录：' + String(d.uname || '') + (vip ? '（' + vipLabel + '）' : '（普通账号，会员画质拿不到）'),
    };
  } catch (e) {
    const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, isLogin: false, message: t ? '检测超时：网络不通或 bilibili 不可达' : ('检测失败：' + ((e && e.message) || e)) };
  }
}
/** 只认 bilibili / YouTube（用户要求）。
 *  必须按 hostname 严格匹配 —— 曾经用子串匹配, `https://evil.com/bilibili.com`、
 *  `http://内网地址/?youtube.com` 都会被判成真站, 再把整条 URL 原样交给下载内核(SSRF 面)。 */
function fetchSiteOf(url) {
  let u;
  try { u = new URL(normalizeFetchUrl(url)); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');   // 结尾的 "." 是 FQDN 写法, 归一掉再比对
  const isHost = (h) => host === h || host.endsWith('.' + h);
  if (isHost('bilibili.com') || isHost('b23.tv')) return 'bilibili';
  if (isHost('youtube.com') || isHost('youtu.be')) return 'youtube';
  return '';
}
/** 链接规范化: 少写协议头(如 "www.bilibili.com/video/BV…")按 https 处理,
 *  与 yt-dlp 自身的 sanitize_url 行为对齐(它缺协议时补 http, 这里补 https 更稳)。 */
function normalizeFetchUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
}
/** bilibili Cookie 文本规范化: 用户常常**只复制到值**（DevTools / 扩展里点一下就复制了值本身，
 *  形如 `ac87ca47%2C1806119310%2C…`），这种文本里没有任何 name=value →
 *  下载内核解析出来是空 cookie（等于未登录，画质掉回免登录档）。这里补上 SESSDATA=。
 *  规则与 asr/fetch/bilibili.py 的 parse_cookie_input 保持一致。 */
function normalizeBiliCookie(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const bare = s.replace(/;\s*$/, '').trim();
  if (bare.startsWith('{') || /[=;\n\t]/.test(bare)) return s;   // 已经是 name=value / JSON / 多行
  return bare.length >= 20 ? ('SESSDATA=' + bare) : s;
}
/** 分P（bilibili 多P视频）: 缺省 1。链接里自带 ?p=N 时以链接为准（见 fetch_cli 的同名规则）。 */
function normalizePart(v) {
  const n = parseInt(v, 10);
  return (Number.isFinite(n) && n >= 1) ? Math.min(9999, n) : 1;
}
/** 下载内核要 Python 3.8+：先试 ASR 那套, 再试 py -3.12/3.11/3.10、python3、内置 Python。
 *  结果缓存成一个 Promise（探测只做一次）。用异步 spawn —— 本环境 spawnSync 会 EBUSY（实测）。 */
let fetchPyPromise = null;
function pyVersionOk(exe, pre) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(exe, pre.concat(['-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])']), { windowsHide: true });
    } catch { return resolve(false); }
    let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 8000);
    p.stdout.on('data', (c) => { out += c.toString('utf8'); });
    p.on('error', () => { clearTimeout(timer); resolve(false); });
    p.on('close', () => { clearTimeout(timer); resolve(parseInt(out.trim(), 10) >= 308); });
  });
}
function resolveFetchPython() {
  if (!fetchPyPromise) {
    fetchPyPromise = (async () => {
      const cands = [];
      if (ASR_PY && ASR_PY !== 'python') cands.push([ASR_PY, []]);
      cands.push(['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python3', []], [ASR_PY || 'python', []]);
      try { const e = embeddedPyExe(); if (e) cands.push([e, []]); } catch {}
      for (const c of cands) {
        if (await pyVersionOk(c[0], c[1])) return { exe: c[0], pre: c[1] };
      }
      return false;
    })();
  }
  return fetchPyPromise;
}
/** 同步的廉价检查（设置界面用）: 脚本在不在。真正的 Python 版本在跑任务时判定 */
function fetchReady() {
  try { return !!(ASR_PY && fs.existsSync(FETCH_SCRIPT)); } catch { return false; }
}

/** 跑一次 fetch_cli：逐行读 JSON。返回 {error, done} */
function runFetchCli(id, args, onEvent) {
  // 注: 下面这个 async IIFE 不能写成 `new Promise(async (resolve) => ...)`。
  // async executor 里抛出的异常不会被Promise 捕获 —— 会既不 reject 也不 resolve,
  // 调用方(await 此Promise)就永久挂起, 表现为"点下载后一直转圈没反应"。
  // 所以 executor 保持同步, 异步部分交给 promise 链。
  return Promise.resolve()
    .then(() => resolveFetchPython())
    .then((py) => {
      if (!py) {
        return { error: '下载需要一个 Python 3.8 或更高版本。到设置里安装内置 Python，或自己装一个 Python 3.12', done: null };
      }
      return new Promise((resolve) => {
        let proc;
        try {
          proc = spawn(py.exe, py.pre.concat([FETCH_SCRIPT], args), Object.assign({ windowsHide: true }, pySpawnEnv()));
        } catch (e) {
          return resolve({ error: '启动下载进程失败: ' + e.message, done: null });
        }
        fetchJobs.set(id, { proc });
        let buf = '';
        const result = { error: '', done: null };
        const feed = (chunk) => {
          buf += chunk.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let o = null;
            try { o = JSON.parse(line); } catch { pushDraftLog(id, '[下载] ' + line.slice(0, 200)); continue; }
            if (o.type === 'progress') onEvent({ progress: Number(o.pct) || 0, msg: String(o.msg || '') });
            else if (o.type === 'log') pushDraftLog(id, '[下载] ' + String(o.msg || ''));
            else if (o.type === 'error') { result.error = String(o.msg || '下载失败'); pushDraftLog(id, '[下载] ✗ ' + result.error); }
            else if (o.type === 'done') result.done = o;
          }
        };
        proc.stdout.on('data', feed);
        proc.stderr.on('data', (c) => {
          const s = c.toString('utf8').trim();
          if (s) pushDraftLog(id, '[下载] ' + s.slice(0, 200));
        });
        proc.on('error', (e) => { fetchJobs.delete(id); resolve({ error: '下载进程出错: ' + e.message, done: null }); });
        proc.on('close', () => { fetchJobs.delete(id); resolve(result); });
      });
    })
    .catch((e) => ({ error: '下载进程启动失败: ' + ((e && e.message) || e), done: null }));
}

/** 下载 → 落 meta.video / meta.source → 交棒给 prepare（现有流水线） */
async function startFetchJob(id, opts) {
  const meta0 = readMeta(id);
  if (!meta0) return;
  // 必须登记进 draftJobs: metaView 把"running 但没登记"的初稿当成服务重启后的残留
  draftJobs.add(id);
  const dir = path.join(projDir(id), 'video');
  fs.mkdirSync(dir, { recursive: true });
  const f = fetchSettings();
  const quality = String(opts.quality || f.quality || 'best');
  const part = normalizePart(opts.part);
  const srcPath = path.join(projDir(id), 'source.json');
  const args = ['--url', opts.url, '--out', dir, '--quality', quality, '--meta-out', srcPath];
  if (part > 1) args.push('--part', String(part));           // 分P: 链接里自带 ?p=N 时由内核以链接为准
  if (f.proxy) args.push('--proxy', String(f.proxy));
  // Cookie: 明文**不放命令行**（进程列表里谁都能看到），落成项目目录里的 Netscape 文件传过去。
  // 这份文件本来就是下载内核自己会写的（随项目一起删），这里只是提前写、并改用它。
  const ckPlain = String(f.__biliCookiePlain || f.biliCookie || '');
  if (ckPlain) {
    const ckFile = path.join(projDir(id), '_bili_cookies.txt');
    if (writeNetscapeCookieFile(ckPlain, ckFile)) args.push('--cookies-file', ckFile);
    else args.push('--cookies', ckPlain);              // 解析不出 name=value 时退回老办法, 别静默丢
  } else if (f.cookiesFromBrowser) args.push('--cookies-from-browser', String(f.cookiesFromBrowser));
  if (FFMPEG && FFMPEG !== 'ffmpeg') args.push('--ffmpeg', FFMPEG);
  pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] [下载] ' + fetchSiteOf(opts.url)
    + ' · 档位 ' + quality + (part > 1 ? ' · 分P ' + part : '') + ' · ' + opts.url);

  const r = await runFetchCli(id, args, (ev) => {
    const p = Math.max(0, Math.min(100, ev.progress));
    setDraft(id, { stage: FETCH_STAGE, progress: 2 + Math.round(p * 0.24), message: ev.msg || '下载中 …' });
  });

  if (r.error || !r.done || !r.done.file) {
    return finishDraft(id, new Error(r.error || '下载没有产出文件（检查链接、登录态或画质档位）'), { failedStage: FETCH_STAGE });
  }
  const file = String(r.done.file);
  if (!fs.existsSync(file)) return finishDraft(id, new Error('下载完成但文件不见了: ' + file), { failedStage: FETCH_STAGE });

  const meta = readMeta(id);
  if (!meta) return;
  const sm = r.done.meta || {};
  meta.video = { path: file, name: path.basename(file) };
  meta.source = {
    url: sm.url || opts.url, site: sm.source || fetchSiteOf(opts.url), id: sm.id || '',
    title: sm.title || '', description: sm.description || '', uploader: sm.uploader || '',
    duration: sm.duration || 0, uploadDate: sm.uploadDate || '', tags: sm.tags || [],
    viewCount: sm.viewCount || 0, thumbnail: sm.thumbnail || '', height: sm.height || 0,
    qualityPreset: sm.qualityPreset || quality, fileSize: sm.fileSize || 0,
    fetchedAt: sm.fetchedAt || new Date().toISOString(),
  };
  // 名字还是"占位符"(没填 / 用 BV 号兜底) 时, 换成视频真标题；用户手动编辑过的名称不覆盖
  const nm = String(meta.name || '').trim();
  if (!meta.nameCustomized && sm.title && (!nm || /^BV[0-9A-Za-z]+$/.test(nm) || nm === '下载的视频')) meta.name = String(sm.title).slice(0, 60);
  meta.draft = Object.assign({}, meta.draft || {}, { sourceFetched: true });
  writeMeta(meta);
  pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] [下载] 完成: ' + path.basename(file)
    + '（' + (Number(sm.fileSize || 0) / 1048576).toFixed(1) + ' MB）');
  setDraft(id, { stage: STAGE.extract, progress: 26, message: '下载完成，开始提取音频与波形…' });
  pendingAsr.set(id, { wordLevel: !!opts.wordLevel });
  startPrepare(id, file);
  draftJobs.delete(id);        // 交棒完成: 之后由 pendingAsr(→识别) / draftJobs(识别中) 接手
}


/* 画质档位的取值契约(与 asr/fetch 的两张站点表保持一致, 值就是 selector.py 认识的档位名):
 * best / 2160 / 1080 / 720 / 480 / 360 / audio。
 * 界面上的选项硬编码在 index.html 的 #st-fetch-quality 里(那份还多了 UI 需要的顺序),
 * 改档位时要同时改 HTML —— 以前这里还有一份 FETCH_QUALITY_CHOICES 数组, 无人引用已删。 */

function startPrepare(id, videoPath, mode) {
    const denoise = mode !== 'raw';
    if (prepareJobs.has(id)) return;
    const meta = readMeta(id);
    if (!meta) return;
    prepareJobs.add(id);
    meta.prepare = { status: 'running', startedAt: new Date().toISOString(), error: null };
    writeMeta(meta);
    console.log('[project] prepare 开始:', id, videoPath, denoise ? '(降噪)' : '(原声)');

    probeDuration(videoPath, (duration) => {
      if (!(duration > 0)) return finishPrepare(id, new Error('无法探测视频时长(ffprobe 失败或文件不可读)'));
      const wavTmp = path.join(projDir(id), 'audio.wav.tmp');
      const pcmTmp = path.join(projDir(id), 'peaks.pcm.tmp');
      const wavOut = path.join(projDir(id), 'audio.wav');
      const peaksOut = path.join(projDir(id), 'peaks.bin');
      const args = ['-hide_banner', '-vn', '-i', videoPath,
        // afftdn: nr=降噪量(dB) nf=噪声底(dB) tn=自适应噪声跟踪 —— 参数温和, 压底噪而不伤语音清晰度
        '-filter_complex', denoise
          ? `[0:a]aformat=sample_rates=${AUDIO_SR}:channel_layouts=mono,afftdn=nr=12:nf=-25:tn=1,asplit=2[a1][a2]`
          : `[0:a]aformat=sample_rates=${AUDIO_SR}:channel_layouts=mono,asplit=2[a1][a2]`,
        '-map', '[a1]', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', wavTmp,
        '-map', '[a2]', '-f', 's16le', pcmTmp];
      const proc = spawn(FFMPEG, args, { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
      const cleanup = () => { for (const f of [wavTmp, pcmTmp]) fs.unlink(f, () => {}); };
      const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 30 * 60 * 1000);
      proc.on('error', (e) => { clearTimeout(timer); cleanup(); finishPrepare(id, new Error('ffmpeg 不可用: ' + e.message)); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          cleanup();
          const noAudio = /matches no streams|does not contain any stream|Output file #0 does not contain any stream|Output file is empty/i.test(stderr);
          return finishPrepare(id, new Error(noAudio ? '该视频没有音轨，无法提取音频与波形' : ('ffmpeg 失败: ' + stderr.slice(-200))));
        }
        // peaks.pcm.tmp (s16le mono AUDIO_SR) → min/max 分桶包络
        // 复用 attachPeakCollector(与 /api/peaks 同一份实现): 旧代码在这里另抄了一份
        // 分桶逻辑, 两处各自演化 → 固定增益/sqrt 的削顶 bug 要改两遍, 极易漏。
        const rate = 100;
        const rs = fs.createReadStream(pcmTmp);
        const collect = attachPeakCollector(rs, duration, rate, AUDIO_SR);
        rs.on('error', () => { cleanup(); finishPrepare(id, new Error('波形数据读取失败')); });
        rs.on('end', () => {
          const r = collect(0, '');
          const bytes = r.buf.length;
          try {
            fs.writeFileSync(path.join(projDir(id), 'peaks.bin.tmp'), r.buf);
            fs.renameSync(path.join(projDir(id), 'peaks.bin.tmp'), peaksOut);
            fs.renameSync(wavTmp, wavOut);
          } catch (e) { return finishPrepare(id, new Error('保存音频/波形失败: ' + e.message)); }
          cleanup();   // 成功分支也要清: peaks.pcm.tmp 是原始 PCM(≈32KB/秒音频),
                       // 漏删会让每个项目长期白占一份与音频等大的临时文件
          finishPrepare(id, null, { duration, peaksBytes: bytes, audioBytes: fs.statSync(wavOut).size, rate, mode: denoise ? 'denoise' : 'raw' });
        });
      });
    });
  }
  function finishPrepare(id, err, info) {
    prepareJobs.delete(id);
    const meta = readMeta(id);
    if (!meta) return;
    meta.prepare = Object.assign({ status: err ? 'error' : 'done', finishedAt: new Date().toISOString(), error: err ? String(err.message || err) : null }, info || {});
    if (!err && info) {
      if (info.audioBytes) meta.audio = { file: 'audio.wav', bytes: info.audioBytes, mode: info.mode || 'denoise' };
      if (info.peaksBytes) meta.peaks = { file: 'peaks.bin', rate: info.rate || 100, bytes: info.peaksBytes, ver: PEAK_VER, ch: 2 };
      if (info.duration) meta.duration = info.duration;
    }
    touchMeta(meta);
    console.log('[project] prepare', err ? ('失败: ' + err.message) : ('完成: ' + id), info || '');

    // 初稿流水线: 音频/波形就绪后接着跑语音识别
    if (pendingAsr.has(id)) {
      const w = pendingAsr.get(id);
      pendingAsr.delete(id);
      if (err) finishDraft(id, new Error('音频提取失败: ' + String(err.message || err)));
      else safeDraftStep(id, () => startDraftAsr(id, !!w.wordLevel));
    }
  }

  /* ═══════════ 说话人分离（后台, 跑在音频上与引擎无关） ═══════════ */
  function runDiarize(wav, onProgress, speakerCount, log) {
    const segModel = path.join(DIARIZE_DIR(), DIARIZE_MODELS[0].file);
    const embModel = path.join(DIARIZE_DIR(), DIARIZE_MODELS[1].file);
    const outJson = wav + '.diarize.json';
    // 音频时长: 项目里的 audio.wav 固定是 16kHz / 16bit / 单声道 → 字节数 ÷ (16000×2)。
    // 说话人分离**不做分片**（与识别的 25 分钟分片不同），整段一次性喂给模型，耗时随时长线性上升。
    // 原先超时写死 30 分钟 —— 长音频（尤其 CUDA 初始化失败回退 CPU 时）会被这条定时器直接杀掉，
    // 报出来的却是"退出码 1"，看起来像偶发故障。现在上限跟着时长走：至少 30 分钟，按 4 倍时长给，封顶 4 小时。
    let durSec = 0;
    try { durSec = fs.statSync(wav).size / (16000 * 2); } catch {}
    const budgetMs = Math.max(30 * 60 * 1000, Math.min(4 * 3600 * 1000, durSec * 1000 * 4));
    const budgetMin = Math.round(budgetMs / 60000);
    if (log && durSec >= 1800) {
      log('音频约 ' + Math.round(durSec / 60) + ' 分钟：说话人分离整段一次处理，超时上限 ' + budgetMin + ' 分钟');
    }
    return new Promise((resolve, reject) => {
      const p = spawn(ASR_PY, [path.join(ASR_DIR, 'diarize.py'),
        '--segmentation', segModel, '--embedding', embModel, '--audio', wav, '--out', outJson,
      // 0 = 让聚类自己定人数（threshold 生效）; 正数 = 强制聚类数
      '--speakers', String(Number.isFinite(speakerCount) ? Math.max(0, Math.min(20, Math.round(speakerCount))) : 0)],
        { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
      let pyErr = '', timedOut = false, lastLogs = [];
      const startedAt = Date.now();
      const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch {} }, budgetMs);
      const done = (fn) => { clearTimeout(timer); try { fs.unlinkSync(outJson); } catch {} fn(); };
      p.stderr.on('data', d => {
        const s = String(d);
        if (pyErr.length < 2000) pyErr += s;
        for (const line of s.split('\n')) {
          const tt = line.trim();
          if (!tt.startsWith('{')) continue;
          let o; try { o = JSON.parse(tt); } catch { continue; }
          if (o.type === 'progress' && onProgress) onProgress(o.pct, o.msg);
          // 留几行普通日志: 用的 provider(CUDA/CPU)、音频多长、内存多大 —— 出问题时靠它们定位,
          // 而不只是拿到一个干巴巴的"退出码 1"。
          if (o.type === 'log' && o.msg) {
            lastLogs.push(String(o.msg));
            if (lastLogs.length > 6) lastLogs.shift();
          }
        }
      });
      p.on('error', e => done(() => reject(new Error('无法启动分离进程: ' + e.message))));
      p.on('close', c => {
        let data = null;
        try { data = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch {}
        if (c !== 0 || !data || !Array.isArray(data.regions)) {
          const m = /"type":"error","msg":"([^"]*)"/.exec(pyErr || '');
          const mins = Math.round((Date.now() - startedAt) / 60000);
          const tail = lastLogs.length ? '；最后日志：' + lastLogs.slice(-3).join(' / ') : '';
          if (timedOut) {
            return done(() => reject(new Error('区分说话人超时：已跑 ' + mins + ' 分钟（上限 ' + budgetMin
              + ' 分钟）—— 长音频 + CPU 推理最容易触发。看上面日志确认是否回退了 CPU，'
              + '或在设置里关掉「区分说话人」先出稿' + tail)));
          }
          return done(() => reject(new Error((m && m[1]) || ('分离失败（' + asrExitHint(c) + '）'))
            + '（已跑 ' + mins + ' 分钟' + tail + '）'));
        }
        done(() => resolve(data));
      });
    });
  }

  /* ═══════════ 初稿流水线 ═══════════
   * stage 划分: 提取音频+波形(0~28, 由 startPrepare 负责) → 语音识别(28~85)
   *             → 生成字幕(85~100)。状态落在 meta.draft, 前端轮询进度。 */

  const draftLogFile = (id) => path.join(projDir(id), 'draft.log');

  function pushDraftLog(id, msg) {
    try { fs.appendFileSync(draftLogFile(id), msg + '\n', 'utf8'); } catch {}
  }

  function setDraft(id, patch) {
    const meta = readMeta(id);
    if (!meta) return;
    meta.draft = Object.assign(
      { status: 'running', stage: '', progress: 0, message: '', error: null },
      meta.draft || {}, patch);
    touchMeta(meta);
  }

  /** 杀掉某项目正在跑的识别子进程(精确跟踪, 不会误伤无关 python/whisper)。
   *  用途: 删除项目 / 重新开始初稿时, 防止旧进程变孤儿继续烧 CPU 半小时。
   *  云端识别没有子进程, 它是靠 AbortSignal 收手的 —— 这里一并 abort。 */
  function killDraftProc(id) {
    const a = draftAborts.get(id);
    if (a) { try { a.abort(); } catch {} draftAborts.delete(id); }
    const p = draftProcs.get(id);
    if (p) {
      try { if (p.pid) process.kill(-p.pid); } catch {}
      try { p.kill('SIGKILL'); } catch {}
      draftProcs.delete(id);
    }
  }
  function finishDraft(id, err, extra) {
    draftJobs.delete(id);
    pendingAsr.delete(id);
    killDraftProc(id);
    const meta = readMeta(id);
    if (!meta) return;
    const d = Object.assign({ words: 0, lines: 0 }, meta.draft || {}, extra || {});
    d.finishedAt = new Date().toISOString();
    if (err) {
      d.status = 'error';
      // 保留失败时所在阶段, 不要覆盖成"失败" —— 否则卡片上的徽标会显示成「失败 · 失败」
      d.failedStage = d.stage || '';
      d.error = String(err.message || err);
    } else {
      // paused = 初稿已生成、但翻译还没做/没做完 —— **不是完毕**:
      // 步骤条要停在「LLM翻译」、进度停在 86%，让用户一眼看出还差一步
      d.status = (extra && extra.status) || 'done';
      d.error = null; d.failedStage = '';
      if (d.status === 'done') {
        d.stage = STAGE.done; d.progress = 100;
        if (!d.message) d.message = '初稿已生成';
      }
      // paused 的 stage/progress/message 由 extra 带入
    }
    meta.draft = d;
    touchMeta(meta);
    console.log('[project] draft', err ? ('失败: ' + err.message) : ('完成: ' + id));

    /* 初稿成功 → 若项目建的时候勾了"创建后自动处理"，接着跑
     * 反思纠错 + 全片逐词重校对。
     *
     * ⚠ 必须在这里而不是流水线中间：这两步都读**已落盘**的字幕与 asr.json。
     * ⚠ 也不能 await：finishDraft 在子进程回调链里被调用，await 会把整条链挂住。
     *   所以丢给 runAutoPost 自己跑，失败只记日志（初稿已经好了，不该因此判失败）。 */
    if (!err && d.status === 'done' && meta.autoPost) {
      runAutoPost(id).catch(e => {
        const msg = String((e && e.message) || e);
        console.error('[autopost] ' + id + ' 失败：' + msg);
        pushDraftLog(id, apStamp() + '[自动后处理] 失败：' + msg + '（初稿不受影响）');
        const m2 = readMeta(id);
        if (m2 && m2.draft) {
          m2.draft.autoPost = { status: 'error', error: msg, finishedAt: new Date().toISOString() };
          writeMeta(m2);
        }
      });
    }
  }

  /** 秒 → ASS 时间 H:MM:SS.cc。
   *  必须与 main.py 的 format_time 一致: 先整体 round 到厘秒再拆分。
   *  若先拆分再对小数位 round, 0.995~0.999 会进位溢出成 3 位小数 → ASS 解析失败。 */
  function fmtAssTime(sec) {
    let cs = Math.round(Math.max(0, sec) * 100);
    const h = Math.floor(cs / 360000); cs -= h * 360000;
    const m = Math.floor(cs / 6000); cs -= m * 6000;
    const s = Math.floor(cs / 100); cs -= s * 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  /** ASS 时间 'H:MM:SS.cc' → 秒。解析不出来返回 NaN（调用方必须判，别把 NaN 当 0） */
  function assTimeToSec(s) {
    const m = /^(\d+):(\d+):([\d.]+)$/.exec(String(s == null ? '' : s).trim());
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : NaN;
  }

  function fmtSrtTime(sec) {
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(Math.min(999, ms)).padStart(3, '0')}`;
  }

  /** '#RRGGBB' → ASS 的 '&HAABBGGRR'(BGR 顺序), 认不出来时返回 default。
   *  与 main.py 的 hex_to_ass_bgr 保持一致, 两边生成的样式头必须同色。 */
  function hexToAssBgr(color, def) {
    const s = String(color == null ? '' : color).trim().replace(/^#/, '');
    if (!/^[0-9A-Fa-f]{6}$/.test(s)) return def;
    const r = s.slice(0, 2), g = s.slice(2, 4), b = s.slice(4, 6);
    return `&H00${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
  }

  /** ASR 置信度 → ASS 的 Script Info 注释（编辑器据此在列表里标"需复核"）。
   *  与逐词高亮色同一套元数据约定（见 ass.js 的 getScriptInfoComment），
   *  其它 ASS 播放器会忽略 `;` 开头的注释，所以对成品字幕没有任何影响。
   *  格式: `行号:分数:最差词下标` 逗号分隔；没有置信度数据（其它识别引擎）就返回空串。 */
  /** 把「分句前」每个 segment 的 confidence 搬到「分句后」的 segment 上。
   *
   *  为什么需要：语义分句（reseg）是"给同一串词补标点 → 重新切句"，
   *  reseg.js 的 groupsToSegments() 只产出 start/end/text/words，会丢掉 confidence，
   *  于是 asr.json 分句后就没有逐句置信度、ASS 注释也写不出来（实测踩过）。
   *
   *  按**时间重叠加权**而不是词序号：实测 reseg 会在句间挪词（27/11 → 28/10），
   *  按序号会错位；时间区间是稳的，重叠多少就贡献多少。
   *  句被切开 → 两边各拿一部分；被合并 → 按区间长短加权。
   */
  function carryConfidence(oldSegs, newSegs) {
    const src = (oldSegs || []).filter(s => s && s.confidence
      && typeof s.confidence.score === 'number' && Number.isFinite(s.confidence.score));
    if (!src.length) return 0;
    let n = 0;
    for (const seg of (newSegs || [])) {
      if (!seg || !(seg.end > seg.start)) continue;
      let wsum = 0, ssum = 0, best = null, bestOv = 0;
      for (const o of src) {
        const ov = Math.min(seg.end, o.end) - Math.max(seg.start, o.start);
        if (ov <= 0) continue;
        wsum += ov;
        ssum += ov * o.confidence.score;
        if (ov > bestOv) { bestOv = ov; best = o; }
      }
      if (!best) continue;                       // 完全没重叠（理论上不该发生）
      const score = wsum > 0 ? ssum / wsum : best.confidence.score;
      seg.confidence = {
        score: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000,
        // 0.60 与 asr/confidence.py 的 LOW_CONFIDENCE、前端 LOW_CONFIDENCE_UI 同一口径
        low: score < 0.60,
        // 最可疑词的下标只在**整句直接沿用**时才有意义；被切/并过的句子不编造
        worstWord: (bestOv >= (seg.end - seg.start) - 0.02) ? (best.confidence.worstWord ?? null) : null,
        from: 'carry',                            // 标记来源，便于排查
        parts: best.confidence.parts || null,
      };
      n++;
    }
    return n;
  }

  function confidenceMeta(segs) {
    const parts = [];
    for (let i = 0; i < segs.length; i++) {
      const c = segs[i] && segs[i].confidence;
      if (!c || typeof c.score !== 'number' || !Number.isFinite(c.score)) continue;
      const w = Number.isInteger(c.worstWord) && c.worstWord >= 0 ? c.worstWord : '';
      parts.push(i + ':' + Math.max(0, Math.min(1, c.score)).toFixed(2) + ':' + w);
    }
    return parts.length ? parts.join(',') : '';
  }

  /** 把置信度注释插进 ASS 头部（Script Info 段里）。没有数据就原样返回。 */
  function withConfidence(assText, segs) {
    const meta = confidenceMeta(segs);
    if (!meta) return assText;
    const line = '; SubFabricConfidence: ' + meta + '\n';
    // 插在最后一个 Script Info 行之后（即第一个以 [ 开头的小节之前）
    const idx = assText.search(/\n\[/);
    if (idx < 0) return assText + line;
    return assText.slice(0, idx + 1) + line + assText.slice(idx + 1);
  }

  /** ASS 头: 与 main.py generate_ass_header 一致, 保留 Default / 中文字幕 两个样式轨。
   *  label = 识别引擎名(必剪云端 / Parakeet / whisper…), 导出文件里能看出这份初稿是谁识别的。
   *  colors = { zhColor, zhColor2, enColor, enColor2, wordColor }, 缺省时**中英都是白** ——
   *  深色画面下白字最好认, 也避免与 main.py 生成的对白颜色不一致(那边过去硬编码白、样式表却是黄)。
   *  wordColor 会写成 SubFabricWordHighlightColor 元数据, 编辑器据此恢复用户选的逐词高亮色
   *  —— 重新识别/重跑初稿不再把它丢回绿色（上游 2.1.13 修复）。 */
  function assHeader(label, colors) {
    const c = colors || {};
    const enPrimary = hexToAssBgr(c.enColor, '&H00FFFFFF');
    const enSecondary = hexToAssBgr(c.enColor2, '&H0000FFFF');
    const zhPrimary = hexToAssBgr(c.zhColor, '&H00FFFFFF');
    const zhSecondary = hexToAssBgr(c.zhColor2, '&H00FFFFFF');
    const wordColor = /^#[0-9a-f]{6}$/i.test(String(c.wordColor || '')) ? String(c.wordColor).toLowerCase() : '#00ff00';
    return '[Script Info]\n'
      + '; Generated by K-ASS-Editor draft (' + (label || 'Parakeet TDT 0.6B v2') + ')\n'
      + '; SubFabricWordHighlightColor: ' + wordColor + '\n'
      + 'ScriptType: v4.00+\nPlayDepth: 0\nScaledBorderAndShadow: Yes\n'
      + 'PlayResX: 1920\nPlayResY: 1080\nWrapStyle: 3\n\n'
      + '[V4+ Styles]\n'
      + 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
      + 'Style: Default,Comic Sans MS,65,' + enPrimary + ',' + enSecondary + ',&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,3,2,20,20,120,1\n'
      + 'Style: 中文字幕,Comic Sans MS,65,' + zhPrimary + ',' + zhSecondary + ',&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3.0,2,2,10,10,125,1\n\n'
      + '[Events]\n'
      + 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  }

  /** 一个逐词切片: 文本是**整句全文**, 只有当前词用 {\c&H......&}词{\c} 内联高亮。
   *  这是本编辑器判定逐词特效的格式(karaoke.js 的 HL_RE), 不是 \k 系列标签。
   *  name = 说话人(写进 Name 栏, 编辑器据此显示角色); 角色色只上中文行, 英文行保持高亮色。
   *  wordAss = 逐词高亮色的 ASS BGR 串(如 'FFFFFF'); 缺省绿 —— 以前写死绿, 用户改成白色
   *  高亮后重新识别出来的仍是绿的（用户报的 bug）。高亮色存在 ASS 头元数据里, 见 assHeader。
   *  **颜色一律大写**: 上游工具(Subforges)解析 ASS 颜色标签时只认大写十六进制,
   *  小写(&H00ff00&)会被当成不认得 → 逐词高亮在那边直接失效。历史稿件里的小写
   *  值由编辑器加载时 normalizeAssColorTags() 归一化, 不必手工重导。 */
  /** 用户文本 → ASS 安全文本: 花括号会被 libass 当覆盖标签解析, 必须转义(与 karaoke-scribe 同款做法) */
  const escAss = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

  function wordSliceLine(words, idx, start, end, name, wordAss) {
    const hl = wordAss || '00FF00';
    const text = words.map((w, i) => (i === idx ? `{\\c&H${hl}&}${escAss(w.word)}{\\c}` : escAss(w.word))).join(' ');
    return `Dialogue: 0,${fmtAssTime(start)},${fmtAssTime(end)},Default,${name || ''},0,0,0,,${text}\n`;
  }

  /** 读项目现有字幕里的逐词高亮色('#rrggbb'), 没有/读不出时返回 null。
   *  重新识别/重跑初稿会整体覆写字幕文件 —— 覆写前先把用户选过的高亮色读出来, 免得丢回默认绿。 */
  function readSavedWordColor(meta) {
    try {
      const file = meta && meta.subtitle && meta.subtitle.file;
      if (!file) return null;
      const txt = fs.readFileSync(path.join(projDir(meta.id), file), 'utf8');
      const m = /^;\s*SubFabricWordHighlightColor\s*:\s*(#[0-9a-f]{6})\s*$/im.exec(txt);
      return m ? m[1].toLowerCase() : null;
    } catch { return null; }
  }

  /* ── 识别结果 / 译文 读写 ── */
  function readSegments(id) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(projDir(id), 'asr.json'), 'utf8')); }
    catch (e) { throw new Error('读取识别结果失败: ' + e.message); }
    const segs = (data.segments || []).filter(s => s && s.end > s.start);
    if (!segs.length) throw new Error('识别结果为空');
    return segs;
  }
  /** 已有译文(行数对得上才算数, 否则视为无译文) */
  function readTranslations(id, n) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(projDir(id), 'translation.json'), 'utf8'));
      if (Array.isArray(t.lines) && t.lines.length === n) return t.lines;
    } catch {}
    return null;
  }

  /* ── 长稿反思纠错 ──────────────────────────────────────────────
   * 让 LLM **通读全片**（分批 + 相邻批重叠，见 reflect.js），找出语句不通顺之处，
   * 产出两类可执行建议（merge / reidentify）+ 一类提示（gap），并把可执行建议
   * 归并成**去重后的重识别区间**（同稿每段只跑一遍）。
   *
   * 只读不写：这个函数不碰字幕，纯产出建议给预览页。执行由前端确认后调
   * /reidentify 完成 —— 这就是"预览优先、可全部接受"的实现方式。
   */
  /* 纠错单批的 token 预算上限：撞到截断就翻倍重试，最多到这个数。
   * 为什么要自适应：带"思考"的模型（如本地 Qwen3）思考长度与输入成正比，
   * max_tokens 猜小了整批白跑；固定的默认值无法覆盖所有素材长度。 */
  const REFLECT_MAX_TOKENS = 16384;

  async function runReflect(id, onProgress) {
    const cfg = correctCfg();
    if (!correctReady(cfg)) {
      throw new Error('纠错用的模型没配好：先在「全局设置 → 识别增强 → 自动纠错」里填接口地址与模型名'
        + '（默认跟随字幕翻译的配置；也可以用本地部署的 OpenAI 兼容服务）');
    }
    const segs = readSegments(id);
    /* 带上**逐词时间**：行的 start/end 被 reseg 的 groupsToSegments 规整过
     * （后一行起点被推到前一行终点，杜绝重叠），看上去永远严丝合缝；
     * 只有逐词时间还保留着真实间隔 —— findTimeGaps 靠它判定"这段音频没识别出内容"，
     * 否则空档会被行的规整时间掩盖掉（实测：全片唯一 4.75 秒的空档，
     * 按行时间看就是 0，按词时间是 4.75）。 */
    const rows = segs.map(s => ({
      start: s.start, end: s.end, text: String(s.text || ''),
      words: Array.isArray(s.words)
        ? s.words.filter(w => w && Number.isFinite(w.start) && Number.isFinite(w.end))
            .map(w => ({ start: w.start, end: w.end }))
        : [],
    }));
    if (!rows.length) throw new Error('这个稿件还没有可校对的行');

    const zh = readTranslations(id, rows.length);
    if (zh) rows.forEach((r, i) => { r.zh = String(zh[i] == null ? '' : zh[i]); });

    const batches = reflectMod.planBatches(rows, cfg.batchLines, reflectMod.BATCH_OVERLAP);
    const all = [];
    const notes = [];
    /* 单批：撞上 max_tokens 截断就**自动加大预算重试**。
     *
     * 为什么必须自适应（本地模型实测）：Qwen3 这类**带思考**的模型，思考文本与输入长度
     * 成正比 —— 20 行批次光是思考就吃掉 ~1400 token，长批次更多。而 max_tokens 是猜出来的，
     * 猜小了整批白跑（实测 4096 仍有两批被截断）。与其让用户反复试参数，
     * 不如识别出"截断"这个明确的失败信号后翻倍重试。
     *
     * 只在 truncated 时重试：其它错误（认证、网络、格式）翻倍预算没有意义。
     */
    const runBatch = async (user, budget) => {
      try {
        const r = await llmChat(cfg, [
          { role: 'system', content: reflectMod.SYS_PROMPT },
          { role: 'user', content: user },
        ], { jsonMode: true, maxTokens: budget, debugFile: path.join(projDir(id), 'llm-debug.jsonl') });
        return { raw: (r && r.content) || '', budget };
      } catch (e) {
        /* 判定"能不能靠加大预算救回来"。
         *
         * 两个信号都要认：
         *   · kind='truncated' —— 有正文但被切断
         *   · kind='empty' **且** finishReason='length' —— 预算全被"思考"吃完，
         *     连正文都没轮上。带思考的模型（Qwen3 等）在思考较长时先走到这一支，
         *     早期只认 truncated 会漏掉它，自适应重试等于没生效（实测踩过）。
         */
        const kind = e && e.kind;
        const truncated = kind === 'truncated'
          || (kind === 'empty' && e && e.finishReason === 'length');
        const canRetry = truncated && budget < REFLECT_MAX_TOKENS;
        if (!canRetry) throw e;
        const next = Math.min(REFLECT_MAX_TOKENS, budget * 2);
        console.log(`[llm] 纠错某批输出被截断（预算 ${budget}），自动加大到 ${next} 重试`);
        return runBatch(user, next);
      }
    };

    /* 确定性扫一遍"单词被粘住"（toescape / weescape 这类）—— 两处用它：
     *   ① 贴到对应行后面给模型当提示（它才有机会确认并报 reidentify）
     *   ② 模型漏报时**确定性补条目**（下面按批补），保证召回不依赖模型的强弱
     * 为什么需要确定性兜底：实测 qwen3:8b 光靠提示词抓不住这种粘连。
     *
     * ⚠ SUBFABRIC_NO_GLUE_HINT=1 **只关①（提示）**，不关扫描本身 ——
     *   兜底②要照常工作。早先这里写成"关提示时连 scanGluedByRow 也不跑"，
     *   于是 gluedByRow 是空的、兜底循环没东西可遍历，**两个都废了**（实测踩过：
     *   关了提示后 toescape/weescape 两条全丢，notes 也是空的）。
     *   这个开关只用于对照实验，判断"提示"相对"兜底"各自贡献多少。 */
    const glueHintOn = process.env.SUBFABRIC_NO_GLUE_HINT !== '1';
    const gluedByRow = gluedWordsMod.scanGluedByRow(rows);
    if (gluedByRow.size) {
      const n = Array.from(gluedByRow.values()).reduce((a, v) => a + v.length, 0);
      console.log(`[reflect] 扫出 ${n} 处疑似"单词被粘住"（${gluedByRow.size} 行：`
        + [...gluedByRow.keys()].join(',') + `）提示${glueHintOn ? '已开' : '已关·兜底仍生效'}`);
    }

    for (let k = 0; k < batches.length; k++) {
      const [bi, lo, hi] = batches[k];
      if (onProgress) onProgress(k, batches.length, `反思中 … 第 ${k + 1}/${batches.length} 批（第 ${lo}~${hi} 行）`);
      // 提示按开关传；**兜底不看这个开关**（见上面 glueHintOn 的说明）
      const user = reflectMod.buildBatchPrompt(rows, lo, hi, rows.length, bi, batches.length,
        glueHintOn ? gluedByRow : null);
      let raw = '';
      try {
        const out = await runBatch(user, cfg.maxTokens);
        raw = out.raw;
        if (out.budget > cfg.maxTokens) {
          notes.push(`第 ${k + 1} 批输出较长，已自动把预算从 ${cfg.maxTokens} 提到 ${out.budget} 后成功`);
        }
      } catch (e) {
        // 单批失败不该让整个反思白跑：记下原因，用其余批次的结果继续
        notes.push(`第 ${k + 1} 批失败：${String((e && e.message) || e).slice(0, 120)}`);
      }
      const [fs, note] = reflectMod.parseFindings(raw, rows.length, rows);
      if (note) notes.push(`第 ${k + 1} 批：${note}`);
      all.push(...fs);

      /* 本批里扫出粘连、而模型没报到的行 → 确定性地补一条 reidentify。
       * 为什么必须补：漏一行的代价是"这句永远读不通"，而误补一行的代价只是
       * "多听一遍那段音频"（用户还能在预览里取消勾选）。两者不对称，宁可多报。 */
      let added = 0;
      for (const [ln, hits] of gluedByRow) {
        if (ln < lo || ln > hi) continue;
        if (fs.some(f => Number(f.from) <= ln && ln <= Number(f.to))) continue;  // 模型已覆盖
        const first = hits[0];
        all.push({
          kind: 'reidentify', from: ln, to: ln,
          reason: `${first.word} 像是两个词粘在一起（应为「${first.head} ${first.tail}」），这段需要重听`,
          confidence: 0.9,
        });
        added++;
      }
      if (added) notes.push(`第 ${k + 1} 批：另有 ${added} 行是机器扫出的粘连（模型没报到），已一并列入`);
    }

    /* 确定性补一条：扫时间轴找出"有一段音频没被识别出内容"的空档。
     *
     * 为什么不交给模型：模型的输入是**文本**，看不到静音，只能靠语义感觉。
     * 实测（41 行 / 235.6 秒）：全片唯一一处 ≥3 秒空档是 78.2~83.0（4.75 秒），
     * 模型没报成 gap，而是报成 `merge 12~14` —— 于是那段漏掉的内容永远不会被补回来。
     *
     * 这里与模型并行给出，两边的 gap 由 mergeFindings 去重。
     * 找出来的空档**可执行**：用户勾选后会把那段音频重新识别一遍。 */
    const timeGaps = reflectMod.findTimeGaps(rows, { minSec: reflectMod.GAP_MIN_SEC });
    if (timeGaps.length) {
      console.log(`[reflect] 时间轴扫出 ${timeGaps.length} 处空档（≥${reflectMod.GAP_MIN_SEC}s）：`
        + timeGaps.map(g => `${g.start.toFixed(1)}~${g.end.toFixed(1)}s`).join(', '));
    }

    /* 波形检测：**有人在说话、却没有任何字幕盖住**的地方。
     *
     * 与上面 findTimeGaps 的分工（两者互补，都要）：
     *   · findTimeGaps  —— 只看字幕行之间的空档。两行**紧挨着**、但中间那段音频
     *                      本来就没识别出内容，它看不出来。
     *   · 这一条        —— 直接看音频。实测该稿件检出 5 处、共 23.5 秒（例如
     *                      36.2~42.4s 与 138.8~145.7s 在 ASS 里完全没有事件）。
     *
     * 为什么用 ffmpeg silencedetect 取反而不是自己算 RMS：实测音频全程有底噪，
     * 单纯按能量阈值会把整片都判成"有声"；silencedetect 用帧内中位能量模型，
     * 对底噪不敏感。（peaks.bin 也不行：它是被钳位过的显示用包络，不是线性刻度。）
     *
     * 判定用**最终字幕文件**而不是 asr.json —— 用户看到的是前者。
     * 实测两者会分叉（同一稿 asr.json 41 行齐全，ASS 却缺了前 36 秒且只有 37 行乱序）。 */
    let waveGaps = [];
    try {
      const metaW = readMeta(id) || {};
      const wavName = (metaW.audio && metaW.audio.file) || 'audio.wav';
      const wav = path.join(projDir(id), wavName);
      if (fs.existsSync(wav)) {
        const dur = speechGapMod.readWavDuration(wav)
          || (rows.length ? Number(rows[rows.length - 1].end) + 2 : 0);
        // 字幕轨：优先用最终字幕文件（用户看到的），读不到才退回识别行
        let track = null;
        try {
          const sub = (metaW.subtitle && metaW.subtitle.file) || '';
          if (sub && /\.ass$/i.test(sub)) {
            const txt = fs.readFileSync(path.join(projDir(id), sub), 'utf8');
            track = [];
            for (const line of txt.split('\n')) {
              if (!line.startsWith('Dialogue:')) continue;
              const f = line.slice(9).split(',');
              const a = assTimeToSec(f[1]), b = assTimeToSec(f[2]);
              if (Number.isFinite(a) && Number.isFinite(b) && b > a) track.push({ start: a, end: b });
            }
          }
        } catch { /* 读不到就退回识别行 */ }
        if (!track || !track.length) track = rows.map(r => ({ start: r.start, end: r.end }));
        const sil = await audioSlice.detectSilences(FFMPEG, wav);
        waveGaps = speechGapMod.speechGaps(sil, track, dur).map(g => ({
          kind: 'gap',
          // 用行号表达位置：找"这条时间落在哪两行之间"，好让区间规划与预览复用同一套结构
          from: Math.max(1, rows.findIndex(r => Number(r.end) >= g.start) + 1),
          to: Math.max(1, rows.findIndex(r => Number(r.start) >= g.end) + 1),
          start: g.start, end: g.end, dur: g.dur,
          reason: `波形显示这里有人在说话（${g.dur.toFixed(1)} 秒），但字幕轨完全没盖住，疑似漏识别`,
          confidence: 0.95,
          fromWave: true,
        }));
        if (waveGaps.length) {
          console.log(`[reflect] 波形检出 ${waveGaps.length} 处"有声无字幕"：`
            + waveGaps.map(g => `${g.start.toFixed(1)}~${g.end.toFixed(1)}s`).join(', '));
        }
      }
    } catch (e) {
      // 波形检测失败不该让整个反思白跑：记一句提示，其余结果照常
      notes.push('波形漏字幕检测跳过：' + String((e && e.message) || e).slice(0, 100));
    }

    const [findings, dropped] = reflectMod.mergeFindings(all.concat(timeGaps, waveGaps), rows.length);
    /* 传 opts **对象**。
     * ⚠ 这里以前写的是 `planRegions(rows, findings, cfg.ctxLines)` —— 把 ctxLines（数字）
     *   当成 opts 传了进去。新实现读的是 o.padSec / o.maxSec，于是**设置页那两项
     *   「上下文 N 秒 / 单段上限」从来没生效过**，一直在用 reflect.js 里的默认值
     *   （默认恰好也是 2/30，所以从没暴露出来）。ctxLines 是"按行取上下文"时代的
     *   遗留字段，现在不再使用。 */
    const regs0 = (readAsrSettings().correct) || {};
    const regions = reflectMod.planRegions(rows, findings, {
      padSec: Number.isFinite(Number(regs0.padSec)) ? Number(regs0.padSec) : reflectMod.PAD_SEC,
      maxSec: Number.isFinite(Number(regs0.maxSec)) ? Number(regs0.maxSec) : reflectMod.MAX_REGION_SEC,
    });
    const summary = reflectMod.summarize(rows, findings, regions);
    summary.batches = batches.length;
    summary.dropped = dropped;
    summary.model = cfg.model;
    // 同时给出 rows 的时长信息，前端预览要显示"这句多长"以便解释判定
    return { findings, regions, summary, notes, rows: rows.length };
  }

  /** 组装初稿字幕: 英文段 segs + 可选中文译文 trans(长度必须等于 segs)。
   *  有译文时 ASS 会多写一轨「中文字幕」行 —— 那才是本编辑器的双语结构 */
  function writeSubtitle(id, wordLevel, segs, trans) {
    const totalWords = segs.reduce((n, s) => n + ((s.words || []).length), 0);
    const hasTrans = Array.isArray(trans) && trans.length === segs.length;
    const hasSpk = segs.some(s => s.speaker != null);
    // ASS 头署名: 用项目**实际**用的识别引擎(可能是云端备份引擎), 别再写死 Parakeet
    const engineLabel = (() => {
      const meta = readMeta(id);
      const d = (meta && meta.draft) || {};
      const mid = d.usedModelId || d.modelId;
      const m = mid ? modelById(mid) : null;
      return m ? m.name : '';
    })();
    // 部分翻译时 lines 里会有空洞 —— 空洞不写中文行, 免得出现空字幕
    // 用户要求: 翻译写入时把中文的逗号/顿号/句号替换成空格(! ? 保留不动)
    // 口径统一在 llmText.normalizeZhPunctuation(浏览器侧同款见 karaoke.js) ——
    // 以前这条规则散在两处、右键「重新翻译」漏了, 那一路径的中文会带回 ，。 (上游 2.1.13 修复)
    const zhText = (i) => (hasTrans && String(trans[i] || '').trim())
      ? llmText.normalizeZhPunctuation(trans[i]) : null;    // 角色行: 行首色标(角色色) + [SPKn] 标记 + Name 栏 —— 编辑器据此显示角色色与角色列表
    // 角色名: 分角色成功就用真实角色名（[SPKn] → [角色名]）; 没映射上的保留 SPKn
    const castMap = ((readMeta(id) || {}).draft || {}).cast;
    const spkName = (n) => cast.roleNameFor(castMap && castMap.map, n);
    const roleOf = (s) => (hasSpk && s.speaker != null) ? {
      n: s.speaker + 1,
      color: assColorFromRgb(ROLE_PALETTE[s.speaker % ROLE_PALETTE.length]),
    } : null;
    const zhLine = (s, t, role) => {
      const tag = role ? `{\\c&H${role.color}&}[${spkName(role.n)}] ` : '';
      const name = role ? `${spkName(role.n)}` : '';
      return `Dialogue: 0,${fmtAssTime(s.start)},${fmtAssTime(s.end)},中文字幕,${name},0,0,0,,${tag}${escAss(t)}\n`;
    };
    /* 逐词高亮色: 沿用项目现有字幕里用户选过的色(重新识别/重跑初稿不把它丢回绿色), 没有则默认绿。
     * 同一个色也写进 ASS 头元数据, 编辑器打开时据此恢复。 */
    const metaNow = readMeta(id) || {};
    const wordColor = readSavedWordColor(metaNow) || '#00ff00';
    const wordAss = hexToAssBgr(wordColor, '00FF00').replace(/^&H00/, '');
    const styleColors = { wordColor };

    let format, file, text;
    if (!wordLevel) {
      format = 'srt';
      file = 'subtitle.srt';
      // SRT 双语约定: 第 1 行主语言(中文), 其余为副语言
      text = segs.map((s, i) => {
        const role = roleOf(s);
        const zh = zhText(i);
        let body = s.text;
        if (zh) body = role ? `[${spkName(role.n)}] ${zh}\n${s.text}` : `${zh}\n${s.text}`;
        return `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${body}\n\n`;
      }).join('');
    } else if (totalWords < 6) {
      // karaoke.js 的 analyzeKaraoke 要求逐词样式至少 6 个事件才认, 词太少会被当普通整句
      // → 每个切片各自成一行、全是重复整句。这里降级为干净整句(但中文轨照写)。
      pushDraftLog(id, `[提示] 识别内容较短（共 ${totalWords} 词），降级为无逐词效果的整句字幕`);
      format = 'ass';
      file = 'subtitle.ass';
      let out = withConfidence(assHeader(engineLabel, styleColors), segs);
      segs.forEach((s, i) => {
        const zh = zhText(i);
        if (zh) out += zhLine(s, zh, roleOf(s));
        out += `Dialogue: 0,${fmtAssTime(s.start)},${fmtAssTime(s.end)},Default,,0,0,0,,${escAss(s.text)}\n`;
      });
      text = out;
    } else {
      format = 'ass';
      file = 'subtitle.ass';
      let out = withConfidence(assHeader(engineLabel, styleColors), segs);
      segs.forEach((s, i) => {
        const zh = zhText(i);
        if (zh) out += zhLine(s, zh, roleOf(s));
        const ws = s.words || [];
        for (let k = 0; k < ws.length; k++) {
          // 首片起点**必须贴齐句首 s.start**, 不能直接用第一个词的时间:
          //   云端识别(必剪/剪映)给的首词起点常常比句首晚几十毫秒(句前静音不算进词),
          //   以前照抄 ws[0].start 会让英文逐词句整体比中文行晚一截 ——
          //   中英双行时间不一致, 时间轴切不出整块、列表也该记坏行(见 main.js markBadRows)。
          //   现在首片从 s.start 起高亮, 末片收在 s.end, 英文句 == 中文行 == [s.start, s.end]。
          const st = (k === 0) ? s.start : ws[k].start;
          // 每片一直高亮到下一词起点(最后一片到句尾), 与 main.py 生成的结果一致
          const en = (k + 1 < ws.length) ? Math.max(ws[k + 1].start, st + 0.01) : Math.max(s.end, st + 0.01);
          const role = roleOf(s);
          out += wordSliceLine(ws, k, st, en, role ? `${spkName(role.n)}` : '', wordAss);
        }
      });
      text = out;
    }

    const fpath = path.join(projDir(id), file);
    const tmp = fpath + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, fpath);
    const meta = readMeta(id);
    if (meta) { meta.subtitle = { format, file, name: file }; writeMeta(meta); }
    return { format, file, totalWords, hasTrans };
  }

  /* ═══════════ 逐词时间重对齐（TTS 合成 → 重新识别 → 序列对齐） ═══════════
   *
   * 用途：某条字幕的**逐词时间戳糊了**（拖动过、或识别时把词边界摊平了），
   * 但文本是对的。这时用 TTS 把这条字幕念一遍、再识别那段合成语音，
   * 得到的逐词时间是一份**干净的参考节奏**；把它按比例铺回原字幕的时长即可。
   *
   * **只改词级时间，绝不动文本** —— 这是这个功能的硬约束。
   *
   * 为什么用 TTS 而不是直接对原音频做强制对齐：原音频里词边界只能靠识别结果反推，
   * 而我们要修的恰恰就是那份糊掉的识别结果；合成语音的文本已知，节奏干净得多。
   */

  /** 用 Windows 自带的 SAPI 把文本合成成 16k 单声道 WAV。
   *  不引入任何外部依赖：SAPI 是系统组件，且能直接按目标格式输出
   *  （SpeechAudioFormatInfo 指定 16kHz/16bit/单声道）—— 连重采样都省了。 */
  function ttsToWav(text, wavPath, voice, rate) {
    return new Promise((resolve, reject) => {
      const safe = String(text || '').slice(0, 2000);
      if (!safe.trim()) return reject(new Error('没有可合成的文本'));
      // PowerShell 里用单引号字符串，文本内的单引号转义成两个
      const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        voice ? `try { $s.SelectVoice(${lit(voice)}) } catch {}` : '',
        `$s.Rate = ${Number.isFinite(rate) ? Math.max(-10, Math.min(10, rate)) : 0}`,
        '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,'
          + ' [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,'
          + ' [System.Speech.AudioFormat.AudioChannel]::Mono)',
        `$s.SetOutputToWaveFile(${lit(wavPath)}, $f)`,
        `$s.Speak(${lit(safe)})`,
        '$s.Dispose()',
      ].filter(Boolean).join('; ');
      const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { windowsHide: true });
      let err = '';
      const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('TTS 超时（60s）')); }, 60000);
      p.stderr.on('data', d => { if (err.length < 800) err += String(d); });
      p.on('error', e => { clearTimeout(t); reject(new Error('无法启动 PowerShell：' + e.message)); });
      p.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error('TTS 合成失败：' + (err.trim().slice(-200) || ('退出码 ' + code))));
        try { if (!fs.statSync(wavPath).size) throw new Error('空文件'); }
        catch (e) { return reject(new Error('TTS 没产生音频：' + e.message)); }
        resolve(wavPath);
      });
    });
  }

  /** 列出本机可用的英文 SAPI 语音（前端下拉用；取不到就返回空数组，前端用系统默认） */
  function ttsVoices() {
    return new Promise((resolve) => {
      const ps = 'Add-Type -AssemblyName System.Speech;'
        + ' $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;'
        + ' $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {'
        + " $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }; $s.Dispose()";
      let out = '';
      let p;
      try {
        p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
          { windowsHide: true });
      } catch { return resolve([]); }
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve([]); }, 15000);
      p.stdout.on('data', d => { out += d; });
      p.on('error', () => { clearTimeout(t); resolve([]); });
      p.on('close', () => {
        clearTimeout(t);
        resolve(out.split('\n').map(l => l.trim()).filter(Boolean).map((l) => {
          const [name, culture] = l.split('|');
          return { name: name || '', culture: culture || '' };
        }).filter(v => v.name));
      });
    });
  }

  /** 对一批字幕块做重对齐。**只算不写** —— 返回提案，由前端确认后才应用。 */
  /** 重对齐的共享准备：解析模型、设备门禁、TTS 参数、锚点率门槛。
   *  单条重排（realignBlocks）与全片重校对（runFullRealign）都用这一份，
   *  保证两条路径的判定标准完全一致（否则"单条能用、全片说不可信"会很怪）。 */
  function realignPrep(id, opt) {
    const o = (opt || {});
    const meta = readMeta(id);
    if (!meta) throw new Error('项目不存在');
    const rr = resolveRerecogModel(meta);
    if (rr.error) throw new Error(rr.error);
    const model = rr.model;
    const ea = asrEngineArgs(model);
    const gate = asrGpuGateError(model);
    if (gate) throw new Error(gate);
    const mdir = model.cloud ? '' : modelDirFor(model.id);
    if (!model.cloud && (!mdir || missingModelFiles(mdir, model).length)) {
      throw new Error('模型文件不完整（' + model.id + '）');
    }
    /* 设置页里的 TTS 参数与门槛。
     * ⚠ 这里踩过：设置存进了 asr/settings.json，但本函数从没读它、也没把
     *   minAnchorRatio 传给 planBlock —— 于是"最低锚点率"是个**摆设**，
     *   不管怎么调都按代码里的默认值判定。凡是存进设置的值，都要在这里真正用上。 */
    const rs = (readAsrSettings().realign) || {};
    const clamp = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
    };
    return {
      meta, model, ea, mdir, confMode: asrConfidenceFor(meta),
      voice: String((o.voice !== undefined ? o.voice : rs.voice) || '').trim(),
      rate: Number.isFinite(Number(o.rate)) ? Number(o.rate) : clamp(rs.rate, -10, 10, 0),
      minAnchorRatio: clamp(rs.minAnchorRatio, 0.3, 1, alignMod.MIN_ANCHOR_RATIO),
      // 全片重校对的**置信度**门槛（与锚点率门槛不同：那个是"能不能用"，这个是"值不值得改"）
      threshold: clamp(o.threshold !== undefined ? o.threshold : rs.minConfidence, 0.3, 1, 0.7),
    };
  }

  /** 对**一条**字幕做重对齐：TTS 朗读 → ASR 识别 → 序列对齐。
   *  @returns 提案对象（含 words / confidence），**不写任何文件**。 */
  async function realignOne(prep, block, tmpDir, tag) {
    const text = String(block.text || '');
    const spoken = alignMod.ttsText(text);
    const start = Number(block.start), end = Number(block.end);
    const item = {
      start, end, text, ok: false, words: [], anchors: 0, ratio: 0,
      confidence: 0, heard: '', note: '',
    };
    if (!spoken) { item.note = '这条没有可念的文本（可能只有标签）'; return item; }
    if (!(end > start)) { item.note = '时间区间无效'; return item; }
    const wav = path.join(tmpDir, `a-${tag}.wav`);
    const outJson = path.join(tmpDir, `a-${tag}.json`);
    await ttsToWav(spoken, wav, prep.voice, prep.rate);
    // 合成音频走同一套识别参数（含项目当前的逐句置信度档位）
    const asrArgs = [prep.ea.script, '--model', prep.mdir, '--audio', wav,
      '--out', outJson, '--threads', '4', '--provider', prep.ea.provider,
      ...(prep.ea.extra || []), ...(prep.ea.hotwords || []), ...ttaArgs(prep.confMode)];
    await new Promise((res, rej) => {
      const pr = spawn(ASR_PY, asrArgs, { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
      let err = '';
      const t = setTimeout(() => { try { pr.kill(); } catch {} rej(new Error('识别超时（5 分钟）')); }, 5 * 60 * 1000);
      pr.stderr.on('data', d => { if (err.length < 4000) err += String(d); });
      pr.on('error', e => { clearTimeout(t); rej(new Error('无法启动识别进程：' + e.message)); });
      pr.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return rej(new Error('识别失败：' + (err.trim().slice(-200) || ('退出码 ' + code))));
        res();
      });
    });
    const data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    // 合成音频通常只有一句；多句时把它们按序摊平成一个词序列
    const recWords = [];
    for (const s of (data.segments || [])) {
      for (const w of (s.words || [])) {
        if (Number.isFinite(w.start) && Number.isFinite(w.end)) {
          recWords.push({ word: w.word || w.text || '', start: w.start, end: w.end });
        }
      }
    }
    const plan = alignMod.planBlock(text, { start, end }, recWords,
      { minAnchorRatio: prep.minAnchorRatio });   // ← 设置页里那个门槛真正生效的地方
    Object.assign(item, {
      ok: plan.ok, words: plan.words, anchors: plan.anchors, ratio: plan.ratio,
      confidence: plan.confidence, note: plan.note,
      heard: recWords.map(w => w.word).join(' ').slice(0, 200),
    });
    return item;
  }

  /** 对一批字幕块做重对齐（右键「重排逐词时间」走这里）。**只算不写**。 */
  async function realignBlocks(id, blocks, opt) {
    const prep = realignPrep(id, opt);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kass-align-'));
    const out = [];
    try {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        let item;
        try {
          item = await realignOne(prep, b, tmpDir, String(i));
        } catch (e) {
          item = {
            start: Number(b.start), end: Number(b.end), text: String(b.text || ''),
            ok: false, words: [], anchors: 0, ratio: 0, confidence: 0, heard: '',
            note: String((e && e.message) || e).slice(0, 200),
          };
        }
        out.push(Object.assign({ index: i }, item));
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    // 带上本次用的 TTS 参数：操作日志里要能看出"是哪一次、用什么声音跑的"
    return out.map(r => Object.assign(r, { voice: prep.voice || '(系统默认)', rate: prep.rate }));
  }

  /* ── 全片逐词重校对（TTS 朗读 → ASR 识别 → 对齐 → 逐句置信度）──────────
   *
   * 和「重排逐词时间」（右键单条）的区别：这里**逐句自动打分**，只对置信度
   * 达标的句子改逐词时间，不达标的原样保留。
   *
   * 为什么要有这一步：单条重排需要用户先发现"这句的词时间不对"，而几百句的稿子
   * 根本看不出来哪句糊了。这里让它自己逐句体检一遍，把"可信的重排"批量做掉。
   *
   * **只改逐词时间戳**，不动文本、不动整句时间 —— 和单条重排同一约束。
   *
   * 为什么必须逐句串行：TTS（SAPI）与 ASR 都是有状态的外部进程，
   * 并发跑会互相抢设备（ASR 还占着 NPU/GPU），实测并行反而更慢且更不稳。
   */
  /* ═══════════ 建稿后的自动后处理（反思纠错 + 全片逐词重校对）═══════════
   *
   * 用户在「创建稿稿 → 生成方式」里勾了"创建后自动处理"，则 buildDraftSubtitle
   * 出稿、finishDraft 落盘之后，立刻接着跑这两步：
   *   ① 反思纠错：LLM 通读全片，把**达到置信度门槛**的建议直接应用（重识别那几段）
   *   ② 全片逐词重校对：逐句 TTS+识别算置信度，只对达标的句子改逐词时间
   *
   * 为什么放在 finishDraft **之后**而不是插进流水线中间：
   *   这两步都读"已落盘的字幕 + asr.json"，插在中间等于让它们依赖内存里还没写盘的中间态。
   *   而"稿件已经生成好"本身也是个有用的中间状态 —— 后处理失败时用户手上仍有完整初稿。
   *
   * 自动 ≠ 无脑：两步都**只应用达标的**（反思用 confMode 对应的门槛、逐词用 minConfidence），
   *   不达标的原样保留。这样"全自动"不会把关掉的质量问题引进稿子。
   */
  function autoPostConfig() {
    const s = readAsrSettings();
    const a = (s.autoPost) || {};
    return {
      reflect: a.reflect !== false,          // 默认开
      realign: a.realign !== false,          // 默认开
      // 反思：只自动应用"确定性"的发现（合并/空档这种有硬依据的），
      // 模型主观判断的"疑似听错"留给人工 —— 见下面 runAutoReflect 的说明
      reflectKinds: Array.isArray(a.reflectKinds) && a.reflectKinds.length
        ? a.reflectKinds : ['merge', 'gap'],
    };
  }

  /* ⚠ 这几条日志自己带时间戳，**不要**用流水线里那个 `stamp()` ——
   *   它是某个函数内部的 `const`（`const stamp = () => ...`），
   *   本段不在它的作用域里，引用会 ReferenceError（实测：
   *   `[autopost] 失败：stamp is not defined`，而且整个自动流程因此中断）。*/
  const apStamp = () => '[' + new Date().toLocaleTimeString() + '] ';

  /** 自动后处理的主流程。失败只记录、不抛（不能让建稿因此判失败）。 */
  async function runAutoPost(id) {
    const cfg = autoPostConfig();
    if (!cfg.reflect && !cfg.realign) return;
    const meta0 = readMeta(id);
    if (!meta0) return;
    // 标记在跑：metaView 会把它带到前端，卡片上能看见进度
    setDraft(id, {
      stage: STAGE.done, progress: 100, message: '初稿已生成，正在自动后处理…',
      autoPost: { status: 'running', step: '', reflect: null, realign: null },
    });
    pushDraftLog(id, apStamp() + '[自动后处理] 开始');

    let reflectRes = null, realignRes = null;

    if (cfg.reflect) {
      setDraft(id, { autoPost: { status: 'running', step: '反思纠错' } });
      pushDraftLog(id, apStamp() + '[自动后处理] ① 反思纠错：让模型通读全片…');
      try {
        reflectRes = await runAutoReflect(id, cfg);
        pushDraftLog(id, apStamp() + `[自动后处理] ① 完成：${reflectRes.applied} 条已应用`
          + (reflectRes.skipped ? `、${reflectRes.skipped} 条留待人工` : ''));
      } catch (e) {
        reflectRes = { error: String((e && e.message) || e) };
        pushDraftLog(id, apStamp() + '[自动后处理] ① 失败：' + reflectRes.error + '（初稿不受影响）');
      }
    }

    if (cfg.realign) {
      setDraft(id, { autoPost: { status: 'running', step: '全片逐词重校对' } });
      pushDraftLog(id, apStamp() + '[自动后处理] ② 全片逐词重校对：逐句朗读 + 重新识别…');
      try {
        realignRes = await runAutoRealign(id, (pct, msg) => {
          setDraft(id, { autoPost: { status: 'running', step: '全片逐词重校对', pct, msg } });
        });
        pushDraftLog(id, apStamp() + `[自动后处理] ② 完成：${realignRes.applied}/${realignRes.total} 句已改逐词时间`);
      } catch (e) {
        realignRes = { error: String((e && e.message) || e) };
        pushDraftLog(id, apStamp() + '[自动后处理] ② 失败：' + realignRes.error + '（初稿不受影响）');
      }
    }

    const m = readMeta(id);
    if (m && m.draft) {
      m.draft.autoPost = {
        status: 'done', finishedAt: new Date().toISOString(),
        reflect: reflectRes, realign: realignRes,
      };
      m.draft.message = '初稿已生成（含自动纠错与逐词重校对）';
      writeMeta(m);
    }
    pushDraftLog(id, apStamp() + '[自动后处理] 全部结束');
    console.log('[autopost] ' + id + ' 完成');
  }

  /**
   * 自动反思纠错：跑一遍反思，把**有硬依据**的发现拿去重识别。
   *
   * 为什么默认只处理 merge / gap：
   *   · merge（几行本该是一句）与 gap（那段音频没有字幕覆盖）是**确定性**的 ——
   *     前者靠词时间与行时间的关系、后者靠波形静音检测，不依赖模型的主观判断。
   *   · reidentify（"这段疑似听错"）是模型读文字后的判断，可能误判；
   *     自动重识别会覆盖原本正确的文本。这条留给用户在预览里决定。
   *   用户可在 asr/settings.json 的 autoPost.reflectKinds 里放开。
   *
   * ⚠ 这一步**只重识别、不写回字幕**：写回要删掉区间内所有目标行再把新行加回去，
   *   现有实现（main.js 的 applyRecognized + snapRegionsToRows）在浏览器里，
   *   服务端没有等价物。硬造一条未经实测的写回路径，风险大于收益 ——
   *   所以重识别结果留在 job 里，用户在编辑器的反思预览里复核应用。
   *   全片逐词重校对（下一步）是独立的数据通路，不受此影响。
   *
   * 与手动反思共用 runReflect + startReidentifyBatch，判定标准完全一致。
   */
  async function runAutoReflect(id, cfg) {
    const r = await runReflect(id, () => {});
    const all = Array.isArray(r.findings) ? r.findings : [];
    const use = all.filter(f => cfg.reflectKinds.includes(f.kind));
    const skipped = all.length - use.length;
    if (!use.length) return { applied: 0, skipped, findings: all.length, regions: 0, appliedNote: '没有需要自动处理的发现' };
    /* ⚠ `runReflect` 返回的 `rows` 是**行数**（`rows: rows.length`），不是行数组 ——
     *   早期这里写成 `(r.rows || []).map(...)`，直接 ReferenceError:
     *   `(r.rows || []).map is not a function`，整个自动流程断在第一步。
     *   planRegions 要的是 [{start,end}]，从 readSegments 现取。 */
    const segRows = readSegments(id).map(s => ({ start: Number(s.start), end: Number(s.end) }));
    const regions = reflectMod.planRegions(segRows, use,
      { padSec: reflectMod.PAD_SEC, maxSec: reflectMod.MAX_REGION_SEC });
    if (!regions.length) return { applied: 0, skipped, findings: all.length, regions: 0 };
    const meta = readMeta(id);
    const rr = resolveRerecogModel(meta);
    if (rr.error) throw new Error('重识别模型不可用：' + rr.error);
    const job = startReidentifyBatch(id, regions, rr.model);   // 同步返回 job
    await waitJob(job, 60 * 60 * 1000);                        // 等它跑完再往下（串行）
    return {
      applied: use.length, skipped, findings: all.length, regions: regions.length,
      kinds: use.map(f => f.kind),
      rows: job.segments ? job.segments.length : 0,
      appliedNote: '重识别结果已就绪，在编辑器的「反思纠错」预览里复核应用',
    };
  }

  /**
   * 自动全片逐词重校对：跑一遍 runFullRealign，**只把达标的写回**。
   * 复用与手动版同一个 runFullRealign，所以置信度判定完全一致。
   */
  async function runAutoRealign(id, onProgress) {
    const r = await runFullRealign(id, onProgress || (() => {}), {});
    const okItems = r.items.filter(i => i.ok && Array.isArray(i.words) && i.words.length);
    if (!okItems.length) return { applied: 0, total: r.total, threshold: r.threshold };
    const n = await applyRealignToProject(id, okItems);
    return { applied: n, total: r.total, threshold: r.threshold };
  }

  /** 把重校对结果写回字幕（**只改逐词时间戳**）。
   *
   *  自动流程要用，所以从路由里抽出来 —— 手动版由前端在浏览器副本上应用，
   *  这里直接在服务端改文件（自动流程没有前端参与）。
   *
   *  实现上**复用 writeSubtitle**（生成初稿时用的同一个函数），而不是自己拼 ASS：
   *   · 它处理了首片贴齐句首、末片收在句尾、角色色标、中文行等所有细节；
   *     自己再拼一遍必然与初稿不一致（实测差异会体现在"中英双行时间对不上"）。
   *   · 改动只是把 asr.json 里对应句子的 words 换掉，再整体重写。 */
  async function applyRealignToProject(id, items) {
    const meta = readMeta(id);
    if (!meta) throw new Error('项目不存在');
    const segs = readSegments(id);
    if (!segs.length) throw new Error('这个项目还没有识别结果');
    const n = segs.length;
    const trans = readTranslations(id, n);

    let changed = 0;
    for (const it of items) {
      if (!Array.isArray(it.words) || !it.words.length) continue;
      // 先按下标、再用**时间**兜底核对（序号可能因重建而漂移）
      let k = Number(it.index);
      let seg = (k >= 0 && k < n) ? segs[k] : null;
      if (!seg || Math.abs(Number(seg.start) - Number(it.start)) > 0.05) {
        seg = segs.find(s => Math.abs(Number(s.start) - Number(it.start)) <= 0.05) || null;
      }
      if (!seg) continue;
      // 文本必须一致才敢改 —— 万一 ast.json 与传上来的不是同一版，宁可不改
      if (String(seg.text || '').trim() !== String(it.text || '').trim()) continue;
      seg.words = it.words.map(w => ({ word: w.w, start: w.s, end: w.e }));
      changed++;
    }
    if (!changed) return 0;

    // 把改过的 words 落回 asr.json（编辑器打开项目时读的就是它），再重建字幕
    const tmp = path.join(projDir(id), 'asr.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(
      Object.assign({}, JSON.parse(fs.readFileSync(path.join(projDir(id), 'asr.json'), 'utf8')), { segments: segs })
    ));
    fs.renameSync(tmp, path.join(projDir(id), 'asr.json'));

    const wordLevel = !!(meta.draft && meta.draft.wordLevel);
    writeSubtitle(id, wordLevel, segs, trans);
    touchMeta(readMeta(id) || meta);
    return changed;
  }

  /* ── 全片逐词重校对的作业管理 ──────────────────────────────────────
   *
   * 为什么做成后台作业而不是同步请求：全片几百句，每句一次 TTS + 一次识别，
   * 实测单句约 1~2 秒 —— 整片要几分钟到十几分钟，任何 HTTP 超时都撑不住。
   * 所以 POST 立即返回、前端轮询进度（与重识别/反思同一套做法）。
   */
  /* 全片重校对的作业表 `realignJobs` 定义在**模块作用域**（见文件上方
   * "跨请求状态"那段）：跨请求的作业状态放这里会得到新的空容器。 */

  /** 已有作业在跑？（与重识别同一套"看状态不看有无"的判定，别把已完成的当在跑） */
  function realignJobRunning(id) {
    const j = realignJobs.get(id);
    return !!(j && (j.status === 'running' || j.status === 'pending'));
  }

  function realignJobView(j) {
    return {
      status: j.status, pct: j.pct, msg: j.msg, total: j.total, usable: j.usable,
      threshold: j.threshold, items: j.items, error: j.error || '',
    };
  }

  /** 启动全片重校对（后台跑）。同一项目同一时刻只允许一个。 */
  function startFullRealign(id, opt) {
    if (realignJobRunning(id)) {
      throw new Error('这个稿件已经有一个全片重校对在跑了');
    }
    const job = {
      status: 'running', pct: 0, msg: '准备中…', total: 0, usable: 0,
      threshold: 0, items: [], error: '',
    };
    realignJobs.set(id, job);
    const onProgress = (pct, msg) => {
      job.pct = Math.max(0, Math.min(100, Math.round(pct)));
      job.msg = String(msg || '');
    };
    // 刻意不 await：POST 要立刻返回，进度靠轮询
    (async () => {
      try {
        const r = await runFullRealign(id, onProgress, opt);
        job.items = r.items; job.threshold = r.threshold; job.total = r.total;
        job.usable = r.usable;
        job.status = 'done'; job.pct = 100;
        job.msg = `完成：${r.usable}/${r.total} 句达标`;
        console.log(`[realign-full] ${id}：${r.usable}/${r.total} 句达到置信度门槛 `
          + `${(r.threshold * 100).toFixed(0)}%`);
      } catch (e) {
        job.status = 'error';
        job.error = String((e && e.message) || e);
        job.msg = '失败：' + job.error.slice(0, 120);
        console.error('[realign-full] 失败：' + job.error);
      }
    })();
    return job;
  }

  /** 取该项目的**英文逐词句**：只有逐词轨上的句子才谈得上"重校对逐词时间"。 */
  function realignTargets(id, meta) {
    const segs = readSegments(id);
    const kar = meta && meta.kar;
    /* 判断哪一轨是逐词轨：识别结果里带 words 的句子就是。
     * 不带 words 的是中文整句锚点句（翻译结果），它没有逐词时间可改。 */
    return segs.map((s, i) => ({ s, i }))
      .filter(x => Array.isArray(x.s.words) && x.s.words.length
        && Number.isFinite(Number(x.s.start)) && Number.isFinite(Number(x.s.end))
        && Number(x.s.end) > Number(x.s.start)
        && String(x.s.text || '').trim())
      .map(x => ({
        index: x.i,
        start: Number(x.s.start),
        end: Number(x.s.end),
        text: String(x.s.text || '').trim(),
        words: x.s.words.map(w => ({ w: w.w, s: Number(w.s), e: Number(w.e) })),
      }));
  }

  /** 跑全片重校对。onProgress(pct, msg) 回报进度。 */
  async function runFullRealign(id, onProgress, opt) {
    const o = opt || {};
    const prep = realignPrep(id, o);              // 与单条重排共用同一套参数与门槛
    const all = realignTargets(id, prep.meta);
    if (!all.length) {
      throw new Error('这个稿件没有带逐词时间的英文行，没法重校对'
        + '（中文整句轨没有逐词时间；先在「设置 → 逐词转换」把英文转成逐词）');
    }
    /* 单句最小词数：一个词的句子（"Yes."）对齐结果没有意义 ——
     * 起点终点就是句子起止，改不改都一样，还会白跑一次 TTS。 */
    const minWords = Number.isFinite(Number(o.minWords)) ? Math.max(1, Number(o.minWords)) : 2;
    const longEnough = all.filter(t => t.words.length >= minWords);
    /* maxItems：只体检前 N 句。留着有两个用处 ——
     *  ① 用户想先拿一小段试试效果（全片几百句要十几分钟，先看 20 句值不值得跑）
     *  ② 自动化测试不可能等整片跑完
     * 不传 = 全片。 */
    const cap = Number.isFinite(Number(o.maxItems)) && Number(o.maxItems) > 0
      ? Math.floor(Number(o.maxItems)) : longEnough.length;
    const list = longEnough.slice(0, cap);
    const skippedShort = all.length - longEnough.length;

    onProgress(2, `共 ${list.length} 句待体检（跳过 ${skippedShort} 句单词句`
      + (cap < longEnough.length ? `，本次只跑前 ${cap} 句` : '') + '）');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kass-full-'));
    const items = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        onProgress(Math.round(2 + i / list.length * 96),
          `第 ${i + 1}/${list.length} 句：${t.text.slice(0, 34)}…`);
        let item = {
          index: t.index, target: `第 ${t.index + 1} 行`, start: t.start, end: t.end,
          text: t.text, ok: false, confidence: 0, ratio: 0, anchors: 0,
          words: null, heard: '', note: '',
        };
        try {
          const r = await realignOne(prep, t, tmpDir, String(i));
          /* ★ 达标判定用**置信度**，不是 planBlock 的 ok：
           *   ok 只是"锚点率过了最低线"（能用），而这里要决定"值不值得改"，
           *   门槛更高、还要看连续落单和压扁的词。 */
          item = Object.assign(item, r, { ok: r.confidence >= prep.threshold });
          if (!item.ok) {
            item.note = item.note || `置信度 ${(r.confidence * 100).toFixed(0)}% 低于门槛 `
              + `${(prep.threshold * 100).toFixed(0)}%，保留原逐词时间`;
          }
        } catch (e) {
          item.note = String((e && e.message) || e).slice(0, 200);
        }
        items.push(item);
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const usable = items.filter(i => i.ok).length;
    onProgress(100, `完成：${usable}/${items.length} 句达标`);
    return { items, threshold: prep.threshold, total: items.length, usable };
  }

  /* ── 备注（时间点留言；播放时当置顶弹幕显示）────────────────────────
   *
   * 用途：看到某处有问题，不想中断播放去改字幕 —— 直接在备注条上写一句，
   * 记下当时的播放位置；播放到那个时间点会以"置顶弹幕"浮在画面上。
   *
   * 落盘 projects/<id>/notes.json（跟项目走、跨重启留存）。
   * 上限 1000 条：备注是人工写的，不会像日志那样暴涨，但也别无限长。
   *
   * at = 写下时的播放位置（秒）。服务端只负责存，**不校验**它是否在片长内 ——
   * 片长信息在客户端，而且用户完全可能先写备注再加载视频。 */
  const NOTES_MAX = 1000;
  const notesPath = (id) => path.join(projDir(id), 'notes.json');

  function readNotes(id) {
    try {
      const a = JSON.parse(fs.readFileSync(notesPath(id), 'utf8'));
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }

  /** 原子写回。失败要报出来，否则前端以为存上了。 */
  function writeNotes(id, list) {
    const p = notesPath(id);
    fs.writeFileSync(p + '.tmp', JSON.stringify(list, null, 1));
    fs.renameSync(p + '.tmp', p);
  }

  /** 片子多长？优先读项目里的 audio.wav（识别时生成的 16k 单声道），
   *  没有就退回元数据 / 字幕末尾。弹幕判定要用它。 */
  function projectDuration(id, meta) {
    try {
      const wav = path.join(projDir(id), 'audio.wav');
      if (fs.existsSync(wav)) {
        const d = speechGapMod.readWavDuration(wav);
        if (Number.isFinite(d) && d > 0) return d;
      }
    } catch { /* 读不到就往下退 */ }
    const m = meta || readMeta(id) || {};
    const c = Number(m.duration || m.mediaDuration || 0);
    return Number.isFinite(c) && c > 0 ? c : 0;
  }

  /* ═══════════ 项目压缩包：导出 / 导入 ═══════════
   *
   * 导出：只带**人做出来的东西**（字幕 / 识别结果 / 译文 / 备注 / 操作日志 / 建稿日志）。
   *   刻意**不带** `audio.wav`（40 分钟视频就是 40~80 MB，且能从视频重新生成）、
   *   `peaks.bin`（audio.wav 的派生）、视频本体（版权 + 体积）。
   *   一个 40 分钟稿件的包大约 1 MB —— 真正的"分享稿件"。
   *
   * 导入：解包 → 校验 → 建新项目 → 由用户选本地/在线视频 → 复用现有 prepare 流水线
   *   重新生成音频与波形。**包里的 audio.wav / peaks.bin 一律拒绝**：它们可能是
   *   另一个视频的音频，拿它当权威数据比重新生成危险得多。
   *
   * 用 Windows 自带的 bsdtar 建包/解包（本机没有 zip 依赖，项目一直是零依赖；
   * 实测 bsdtar 建包与解包都正常，中文文件名也保留）。失败再退回 Compress-Archive。
   */
  const SYS_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

  /** 跑一个外部命令，返回 { code, out }（与 prepare 里的实现同款：异步 spawn，不阻塞） */
  function runTool(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
      let p;
      try { p = spawn(cmd, args, { windowsHide: true }); }
      catch (e) { return resolve({ code: -1, out: String((e && e.message) || e) }); }
      let out = '';
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -2, out: out + '\n(超时)' }); }, timeoutMs || 10 * 60 * 1000);
      p.stdout.on('data', d => { if (out.length < 8000) out += d; });
      p.stderr.on('data', d => { if (out.length < 8000) out += d; });
      p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: String((e && e.message) || e) }); });
      p.on('close', c => { clearTimeout(t); resolve({ code: c, out }); });
    });
  }

  /** 把项目里该进包的文件打包成 zip。返回 { zipPath, files, bytes } */
  async function packProject(id) {
    const dir = projDir(id);
    const meta = readMeta(id);
    if (!meta) throw new Error('项目不存在');
    const names = fs.readdirSync(dir).filter(f => packMod.shouldPack(f));
    if (!names.length) throw new Error('这个项目里没有可导出的内容');
    // 打包到临时目录，打完直接回给响应，磁盘上不留文件
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kass-pack-'));
    const zipPath = path.join(tmpDir, 'pack.zip');
    let r = await runTool(SYS_TAR, ['-a', '-c', '-f', zipPath, ...names], 10 * 60 * 1000);
    if (r.code !== 0 || !fs.existsSync(zipPath)) {
      // 退回 PowerShell 的 Compress-Archive（bsdtar 不可用/被拦截时）
      const list = names.map(n => path.join(dir, n));
      const ps = 'Compress-Archive -LiteralPath ' + list.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',')
        + ` -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
      const r2 = await runTool('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 10 * 60 * 1000);
      if (r2.code !== 0 || !fs.existsSync(zipPath)) {
        throw new Error('打包失败：bsdtar 与 Compress-Archive 都不可用（' + (r.out || r2.out || '').slice(-160) + '）');
      }
    }
    return { zipPath, tmpDir, files: names, bytes: fs.statSync(zipPath).size };
  }

  /** 解一个上传的项目包到临时目录，返回 { dir, files, manifest } */
  async function unpackProject(zipPath) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kass-unpack-'));
    const r = await runTool(SYS_TAR, ['-x', '-f', zipPath, '-C', tmpDir], 10 * 60 * 1000);
    if (r.code !== 0) {
      const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`;
      const r2 = await runTool('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 10 * 60 * 1000);
      if (r2.code !== 0) {
        throw new Error('解包失败：不是有效的 zip，或解压工具不可用（' + (r.out || r2.out || '').slice(-160) + '）');
      }
    }
    // 有些包会多套一层目录（比如压缩时选的是文件夹）—— 若顶层只有一个目录，就下沉一层
    let base = tmpDir;
    const top = fs.readdirSync(tmpDir);
    if (top.length === 1 && fs.statSync(path.join(tmpDir, top[0])).isDirectory()) {
      const inner = path.join(tmpDir, top[0]);
      if (fs.readdirSync(inner).some(f => packMod.CORE_FILES.includes(f))) base = inner;
    }
    const files = fs.readdirSync(base).filter(f => fs.statSync(path.join(base, f)).isFile());
    const manifest = packMod.validateManifest(files);
    return { dir: base, tmpDir, files, manifest };
  }

  /** 识别完成: 先落英文初稿, 再按设置决定要不要接着翻译 */
  function buildDraftSubtitle(id, wordLevel) {
    setDraft(id, { stage: STAGE.asr, progress: 88, message: '写入初稿字幕 …' });
    let segs, info;
    try {
      segs = readSegments(id);
      info = writeSubtitle(id, wordLevel, segs, null);
    } catch (e) { return finishDraft(id, e); }

    const cfg = translateCfg();
    // 识别还在跑时就点了「翻译」→ 记成排队, 等这一步结束自动接上, 而不是被静默吞掉
    const metaQ = readMeta(id);
    const queued = !!(metaQ && metaQ.draft && metaQ.draft.translateQueued);
    if (queued) { metaQ.draft.translateQueued = false; writeMeta(metaQ); }
    if (cfg.autoTranslate || queued) {
      if (!llmReady(cfg)) {
        return finishDraft(id, null, { status: 'paused', stage: STAGE.translate, progress: 86,
          translated: false, needTranslate: true, lines: segs.length, words: info.totalWords,
          message: '语音识别完成。要生成译文，在右上角「设置」里填接口地址、API Key 和模型名' });
      }
      // ASR 阶段结束要交棒: draftJobs 里还留着本 id(startDraftAsr 成功时不删,
      // 好让 metaView 判定任务仍活着), 不先清掉会让 startTranslate 的防重入直接 return。
      draftJobs.delete(id);
      return startTranslate(id);
    }
    finishDraft(id, null, { status: 'paused', stage: STAGE.translate, progress: 86,
      translated: false, needTranslate: true, lines: segs.length, words: info.totalWords,
      message: `语音识别完成：${segs.length} 行。点「开始翻译」生成中文字幕（或在设置里勾选自动翻译）` });
  }

  /* ── 翻译 ── */
  /* 翻译批量大小：**用户可调**（「全局设置 → 字幕翻译 → 每批行数」，5~100，默认 25）。
   * 过去是写死的 25：小模型希望更小（"返回行数必须等于输入行数"这条对齐越容易整批翻车），
   * 强模型希望更大（请求数更少）。夹取与切批都在 llm-text.js（纯函数，有单测），这里只取配置。 */
  const transBatchSize = (cfg) => llmText.clampBatchSize(cfg && cfg.batchSize);

  /* 解析模型回复的工具都在 editor/llm-text.js（纯函数, 可单测）:
   *  · stripReasoning   —— 剥掉  thinking… 思维链（推理模型必踩的坑, 以前完全没处理）
   *  · parseJsonArray   —— 平衡扫描取**第一个完整闭合**的数组（不再"首个 [ 到末个 ]", 那会被思考里的示例数组带偏）
   *  · parseLineArrayReply —— 标准 JSON 之外的兜底: 逐行纯文本/编号行/引号行, 并过滤思考行与寒暄行
   *    （它内部自己调 parseJsonArray, 所以这里不需要再绑一个别名 —— 以前有, 无人调用已删）
   *  · punctPairsSane   —— 标点密度合理性（防小模型"每词加逗号"） */
  const parseTranslationReply = llmText.parseLineArrayReply;
  const LlmError = llmText.LlmError;


  /** 落盘译文（每批一次），服务重启/刷新后可续翻 */
  function saveTranslations(id, model, lines) {
    const tp = path.join(projDir(id), 'translation.json');
    fs.writeFileSync(tp + '.tmp', JSON.stringify({ model, updatedAt: new Date().toISOString(), lines }));
    fs.renameSync(tp + '.tmp', tp);
  }

  /** 请求一次译文。strict=true 时追加"必须只输出 JSON 数组"的强化指令。 */
  /** 本地引擎的翻译入口。目标语言取自「术语表语言」设置（简体/繁體）。 */
  async function translateLocal(cfg, texts) {
    const lang = String((cfg && cfg.glossaryLang) || '简体');
    const tgt = lang.includes('繁') ? 'zh-Hant' : 'zh';
    const r = await localMt().translate(texts, 'en', tgt, Math.min(512, 128 + texts.length * 24));
    // 术语表：本地模型没有提示词可塞，按"译后替换"生效（不如提示词工程，但可预测）
    let out = r.texts;
    try {
      const pairs = parseGlossary((cfg && cfg.glossary) || '', lang);
      if (pairs && pairs.length) out = mtLocal.applyGlossary(pairs, out);
    } catch {}
    return out;
  }

  async function translateOnce(cfg, texts, strict, opts) {
    const o = opts || {};
    // 本地引擎：不走 llmChat。放在这里而不是 translateLines —— 上面那层的拆批/退避/
    // 等行数校验对本地引擎同样需要，复用它比再写一份可靠。
    if (cfg && cfg.provider === 'nllb-local') {
      const arr = await translateLocal(cfg, texts);
      if (!Array.isArray(arr) || arr.length !== texts.length) {
        throw new LlmError('本地翻译返回行数与输入不一致（' + (arr ? arr.length : 0)
          + ' vs ' + texts.length + '）', 'format');
      }
      return arr;
    }
    const sys = systemPromptWithGlossary(cfg, strict);
    const r = await llmChat(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: texts.join('\n') },
    ], { maxTokens: o.maxTokens, debugFile: o.debugFile, kind: 'translate' });
    const arr = parseTranslationReply(r.content, texts.length);
    if (!arr) {
      const head = String(r.content).slice(0, 300);
      console.error(`[llm] 译文回复不合规（${texts.length} 行, finish_reason=${r.finishReason || '?'}）：${head}`);
      throw new LlmError('返回既不是 JSON 数组、也不是与输入等行数的逐行文本：' + String(r.content).slice(0, 300), 'format', { rawHead: head });
    }
    return arr;
  }

  /** 翻译一组文本，带**升级式重试**，并按错误类型分流（用户报"失效且定位不到"的根治）：
   *  · 原提示词 → 强化指令 → 仍失败就**拆成两半**递归（最多拆到单行）
   *  · `truncated`（输出被 max_tokens 砍断）：原样重试必然再失败 → **直接拆批**；单行还截断就放大 max_tokens 重试
   *  · `rate`/`net`/`timeout`：指数退避（尊重 Retry-After）—— 限流时递归拆半只会把请求数翻倍，所以退避更重要
   *  · `empty`（模型只吐思考过程）：换严格提示词再试一次，仍为空就带着明确原因失败
   *  成功返回与 texts 等长的译文数组；最终失败抛错（调用方决定怎么兜底）。 */
  async function translateLines(cfg, texts, depth = 0, debugFile = null) {
    const maxTokens = Math.min(8192, Math.max(1024, texts.length * 220 + 512));
    let lastErr = null;
    for (const strict of [false, true]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await translateOnce(cfg, texts, strict, { maxTokens, debugFile }); }
        catch (e) {
          lastErr = e;
          const kind = e && e.kind;
          if (kind === 'truncated') break;                       // 截断: 不原地重试
          if (kind === 'net' || kind === 'rate' || kind === 'timeout') {
            const wait = Math.min(10000, (e.retryAfter ? e.retryAfter * 1000 : 900 * Math.pow(3, attempt)));
            await new Promise(r => setTimeout(r, wait));
          } else {
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }
      if (lastErr && lastErr.kind === 'truncated') break;
    }
    // 单行仍然被截断 → 把 max_tokens 放大一倍再试（不能再拆了）
    if (texts.length === 1 && lastErr && lastErr.kind === 'truncated' && depth < 6) {
      try {
        return await translateOnce(cfg, texts, 'strict', { maxTokens: Math.min(16384, maxTokens * 2), debugFile });
      } catch (e) { lastErr = e; }
    }
    if (texts.length > 1 && depth < 5) {
      const mid = Math.ceil(texts.length / 2);
      try {
        const a = await translateLines(cfg, texts.slice(0, mid), depth + 1, debugFile);
        const b = await translateLines(cfg, texts.slice(mid), depth + 1, debugFile);
        return a.concat(b);
      } catch (e) { lastErr = e; }
    }
    throw new Error(String((lastErr && lastErr.message) || lastErr || '翻译失败'));
  }

  async function translateBatch(cfg, segs, idxs, depth, debugFile) {
    try { return { texts: await translateLines(cfg, idxs.map(i => segs[i].text), depth, debugFile) }; }
    catch (e) { return { texts: null, err: String((e && e.message) || e) }; }
  }

  /** 把当前已有译文写进字幕，并按完成度收尾。
   *  部分成功**不回滚**：已翻的行照常写入，只把未完成的记下来交给「重试」补。 */
  function finishTranslate(id, segs, lines) {
    const meta = readMeta(id);
    const trans = lines.some(x => x) ? lines : null;
    let info;
    try {
      info = writeSubtitle(id, !!(meta && meta.draft && meta.draft.wordLevel), segs, trans);
    } catch (e) { draftJobs.delete(id); return finishDraft(id, e); }

    const doneN = lines.filter(x => !!x).length;
    const pendingN = lines.length - doneN;
    if (pendingN === 0) {
      return finishDraft(id, null, {
        translated: true, needTranslate: false, pendingTranslate: 0,
        lines: segs.length, words: info.totalWords,
        message: `初稿已生成：${segs.length} 行（含中文译文）`,
      });
    }
    if (doneN === 0) {
      return finishDraft(id, new Error(
        `翻译失败：${pendingN} 行均未完成。点「重试」可只补未完成的行，已识别的内容不会丢`));
    }
    finishDraft(id, null, {
      status: 'paused', stage: STAGE.translate, progress: 86,
      translated: false, needTranslate: true, pendingTranslate: pendingN, retryable: true,
      lines: segs.length, words: info.totalWords,
      message: `翻译完成 ${doneN}/${lines.length} 行，还有 ${pendingN} 行没翻。点「重试」接着翻`,
    });
  }

  /** 把流水线步骤包一层：任何未捕获异常都记成该项目失败，**绝不能带崩整个服务** ——
   *  这些函数都在子进程/回调里被调用，一抛就是进程级崩溃（实测 buildDraftSubtitle
   *  里引用一个未定义变量就把 server 打挂了）。 */
  function safeDraftStep(id, fn) {
    try { return fn(); }
    catch (e) { finishDraft(id, e); }
  }

  /** 重试：按现有产物决定从哪一步续跑 —— 有识别结果就只补翻译（已有译文不重翻），
   *  识别结果都没有才重跑识别。不会重头再来，所以已有进度不会丢。 */
  function retryDraft(id) {
    const meta = readMeta(id);
    if (!meta) return { error: '项目不存在' };
    if (!meta.draft) return { error: '该项目不是「创建初稿」项目，无法重试' };
    // 同一步正在跑就拒绝：再点一次会开出第二个任务，两个任务抢同一份 asr.json / reseg.json
    if (draftJobs.has(id) || pendingAsr.has(id)) {
      return { error: '这一步正在跑（进度见「详细信息」里的日志），别重复点；它跑完自己会往下走' };
    }
    const hasAsr = fs.existsSync(path.join(projDir(id), 'asr.json'));
    const wordLevel = !!meta.draft.wordLevel;
    const wavOk = fs.existsSync(path.join(projDir(id), 'audio.wav'));
    // 先做校验再计数：配置不全、点了也不会真正跑的情况，不该消耗重试次数
    if (hasAsr && !llmReady(translateCfg())) {
      return { error: '还没配置 LLM（语义分句和翻译都要用）：在右上角「设置」里填接口地址、API Key 和模型名' };
    }
    draftJobs.delete(id);
    pendingAsr.delete(id);
    // 统计用户手动续跑的次数：满 SKIP_AFTER_RETRIES 次仍不成功就放开「跳过此步」
    meta.draft.retries = (meta.draft.retries || 0) + 1;
    writeMeta(meta);

    if (hasAsr) {
      // 语义分句还欠着（LLM 可用 + 没做完/没跳过）→ 先补这一步再往下走。
      // 不再按引擎区分: 所有引擎的初稿都要过语义分句（老项目 resegDone 为空, 重试时正好补上）。
      if (!meta.draft.resegDone && llmReady(translateCfg())) {
        // ★ 必须登记到 draftJobs：metaView 靠它区分"真在跑"和"服务重启被中断"。
        //   漏登记时每批都在正常跑，界面却显示 ✕「服务已重启，处理被中断」→ 用户以为点不动（实测踩过）。
        draftJobs.add(id);
        setDraft(id, { status: 'running', stage: STAGE.reseg, progress: 76, message: '重试语义分句…', error: null, failedStage: '' });
        Promise.resolve(runDraftReseg(id))
          .then(() => continueDraftAfterAsr(id, wordLevel))
          .catch(e => { draftJobs.delete(id); finishDraft(id, e); });
        return { ok: true, from: 'reseg' };
      }
      setDraft(id, { status: 'running', stage: STAGE.translate, progress: 86, message: '准备重试翻译…', error: null });
      Promise.resolve(startTranslate(id)).catch(e => finishDraft(id, e));
      return { ok: true, from: 'translate' };
    }
    if (wavOk) {
      try { fs.unlinkSync(path.join(projDir(id), 'draft.log')); } catch {}
      setDraft(id, { status: 'running', stage: STAGE.asr, progress: 28, message: '重新识别语音…', error: null, failedStage: '' });
      startDraftAsr(id, wordLevel);
      return { ok: true, from: 'asr' };
    }
    pendingAsr.set(id, { wordLevel });
    setDraft(id, { status: 'running', stage: STAGE.extract, progress: 3, message: '重新提取音频与波形…', error: null, failedStage: '' });
    startPrepare(id, meta.video && meta.video.path, (meta.audio && meta.audio.mode) || 'raw');
    return { ok: true, from: 'extract' };
  }

  /* ═══════════ 选区重新识别（后台任务执行器） ═══════════
   * 进度分段: 切音频 0~10 → 识别 10~72 → 翻译 76~97 → 完毕 100。
   * 任务对象挂在 rerecogJobs, 前端每秒轮询 GET 同名接口。 */
  function startRerecognize(id, start, end, model, opt) {
    const o = opt || {};
    // 复用外部 job 对象：批量重识别（纠错机制）逐段驱动同一个 job，
    // 每段识别完把结果**追加**到 job.segments，全部跑完才置 done。
    // 没有外部 job 时就是原来的单区间行为。
    const job = o.job || {
      start, end, status: 'running', stage: '切音频', progress: 2,
      message: '正在切出音频片段…', error: null, segments: null,
      startedAt: new Date().toISOString(),
    };
    if (o.job) {
      job.start = start; job.end = end;
      job.status = 'running'; job.stage = '切音频'; job.progress = 2;
      job.message = '正在切出音频片段…'; job.error = null;
      if (!Array.isArray(job.segments)) job.segments = [];
    }
    rerecogJobs.set(id, job);
    // 收尾时记 finishedAt: GET 路由靠它判断"这条结果已经没人要了", 超时清掉陈旧任务
    const setRr = (patch) => {
      if (patch && (patch.status === 'done' || patch.status === 'error') && !patch.finishedAt) {
        patch = Object.assign({}, patch, { finishedAt: new Date().toISOString() });
      }
      return Object.assign(job, patch);
    };
    // 逐句置信度的档位：按**项目级 → 全局**解析，与创建初稿同一套规则。
    // ⚠ 这个变量以前漏了定义，而下面的常驻服务与 spawn 两处都在用它 ——
    // 结果是**选区/行级重识别一跑就 ReferenceError: confMode is not defined**。
    // 跟着项目设置走是对的：用户在稿件上选了"关闭"，重新识别也不该偷偷跑稳定性。
    const confMode = asrConfidenceFor(readMeta(id));
    (async () => {
      // 从 job 读区间（而不是闭包里的 start/end）：批量模式下每段都会改写它。
      // 下面的代码全部沿用原来的写法，只有这两行是新增的。
      start = job.start; end = job.end;
      try {
        const wav = path.join(projDir(id), 'audio.wav');
        const mdir = model.cloud ? '' : modelDirFor(model.id);
        if (!model.cloud && (!mdir || missingModelFiles(mdir, model).length)) throw new Error('模型文件不完整（' + model.id + '）');
        // GPU 硬校验: ASR 必须跑在 GPU 上, 不做 CPU 兜底
        const gpuGate = asrGpuGateError(model);
        if (gpuGate) throw new Error(gpuGate);
        const segWav = path.join(os.tmpdir(), `kass-rr-${process.pid}-${Date.now().toString(36)}.wav`);
        const outJson = segWav + '.json';
        const cleanup = () => { for (const f of [segWav, outJson]) { try { fs.unlinkSync(f); } catch {} } };

        // 1) 从已保存的音频切出该时间段（-ss 放 -i 前 + -t, 对 PCM 是采样级精确的）
        await new Promise((resolve, reject) => {
          const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', wav,
            '-t', String(end - start), '-vn', '-ac', '1', '-ar', String(AUDIO_SR), '-c:a', 'pcm_s16le', '-y', segWav],
            { windowsHide: true });
          let e2 = '';
          const t = setTimeout(() => { try { ff.kill(); } catch {} }, 5 * 60 * 1000);
          ff.stderr.on('data', d => { if (e2.length < 800) e2 += String(d); });
          ff.on('error', e => { clearTimeout(t); reject(new Error('ffmpeg 不可用: ' + e.message)); });
          ff.on('close', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('切音频失败: ' + e2.slice(-200))); });
        });

        // 2) 识别（按引擎分流: whisper.cpp → whisper-cli；sherpa-onnx → asr.py）
        setRr({ stage: '识别中', progress: 10, message: '识别中（' + model.name + '）…' });
        let data;
        if (model.engine === 'whisper.cpp') {
          const bin = path.join(mdir, model.files[0]);
          data = await runWhisperCpp(bin, segWav, pct =>
            setRr({ progress: 10 + Math.round(pct * 0.62), message: `识别中（whisper.cpp）… ${pct}%` }));
        } else if (model.engine === 'nemo') {
          // NeMo 多说话人: 走 multitalker.py(PyTorch + NeMo, CUDA 专属)。单说话人模式 —— 选区重识别按单人处理
          data = await new Promise((resolve, reject) => {
            const py = spawn(ASR_PY, [NEMO_SCRIPT, '--model', mdir, '--audio', segWav, '--out', outJson,
              '--threads', '4', '--provider', 'cuda'],
              { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
            let pyErr = '';
            const t = setTimeout(() => { try { py.kill(); } catch {} }, 25 * 60 * 1000);
            py.stderr.on('data', d => {
              const s2 = String(d);
              if (pyErr.length < 3000) pyErr += s2;
              for (const line of s2.split('\n')) {
                const tt = line.trim();
                if (!tt.startsWith('{')) continue;
                let o; try { o = JSON.parse(tt); } catch { continue; }
                if (o.type === 'progress') setRr({ stage: '识别中', progress: 10 + Math.round(o.pct * 0.62), message: o.msg });
                else if (o.type === 'log') setRr({ message: o.msg });
              }
            });
            py.on('error', e => { clearTimeout(t); reject(new Error('无法启动识别进程: ' + e.message)); });
            py.on('close', c => {
              clearTimeout(t);
              let out = null;
              try { out = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch {}
              if (c !== 0 || !out || !Array.isArray(out.segments)) {
                const m2 = /"type":"error","msg":"([^"]*)"/.exec(pyErr || '');
                return reject(new Error((m2 && m2[1]) || ('识别失败（' + asrExitHint(c) + '）')));
              }
              resolve(out);
            });
          });
        } else if (model.cloud) {
          // 云端引擎: 选区音频同样转 mp3 上传识别(本地无模型、无子进程); 同样享受"两个引擎互为备份"
          const mp3 = await toCloudAudio(segWav);
          try {
            const used = await transcribeCloud({
              engine: model.engine, audioPath: mp3,
              log: (m) => setRr({ message: m }),
              onProgress: (pct, msg) => setRr({ stage: '识别中', progress: 10 + Math.round(pct * 0.62), message: msg }),
            });
            data = { segments: used.segments };
          } finally { try { fs.unlinkSync(mp3); } catch {} }
        } else {
          const ea = asrEngineArgs(model);
          let servedOk = false;
          if (asrCanServe(ea.script)) {
            // 单行重识别是最典型的短任务：走常驻服务能省掉绝大部分固定开销
            try {
              await asrSvc.transcribe({
                script: ea.script, model: mdir, provider: ea.provider,
                extra: (ea.extra || []).concat(ea.hotwords || []),
                // 常驻服务模式：按项目级→全局解析出的有效值传重跑遍数（关掉=0）。
                // 原来读 readAsrSettings().confidenceTta —— 那个字段从没被写入过，
                // 一直是 undefined，worker 便退回了自己的默认值 2（踩过）。
                audio: segWav, tta: (confMode === 'full' ? CONFIDENCE_TTA : 0), outPath: outJson,
              });
              servedOk = true;
            } catch (e) {
              console.error('[asr-serve] 失败，退回 spawn：' + ((e && e.message) || e));
            }
          }
          data = servedOk ? JSON.parse(fs.readFileSync(outJson, 'utf8'))
            : await new Promise((resolve, reject) => {
            const asrArgs = [ea.script, '--model', mdir, '--audio', segWav,
                             '--out', outJson, '--threads', '4', '--provider', ea.provider,
                             ...(ea.extra || []), ...ea.hotwords, ...ttaArgs(confMode)];
            const py = spawn(ASR_PY, asrArgs,
              { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
            let pyErr = '';
            const t = setTimeout(() => { try { py.kill(); } catch {} }, 25 * 60 * 1000);
            py.stderr.on('data', d => {
              const s = String(d);
              if (pyErr.length < 3000) pyErr += s;
              for (const line of s.split('\n')) {
                const tt = line.trim();
                if (!tt.startsWith('{')) continue;
                let o; try { o = JSON.parse(tt); } catch { continue; }
                if (o.type === 'progress') setRr({ stage: '识别中', progress: 10 + Math.round(o.pct * 0.62), message: o.msg });
                else if (o.type === 'log') setRr({ message: o.msg });
              }
            });
            py.on('error', e => { clearTimeout(t); reject(new Error('无法启动识别进程: ' + e.message)); });
            py.on('close', c => {
              clearTimeout(t);
              let out = null;
              try { out = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch {}
              if (c !== 0 || !out || !Array.isArray(out.segments)) {
                const m = /"type":"error","msg":"([^"]*)"/.exec(pyErr || '');
                return reject(new Error((m && m[1]) || ('识别失败（' + asrExitHint(c) + '）')));
              }
              resolve(out);
            });
          });
        }
        cleanup();

        // 3) 时间戳加回区间偏移
        let segs = data.segments
          .filter(s => s && s.end > s.start)
          .map(s => ({
            start: +(s.start + start).toFixed(3),
            end: +(s.end + start).toFixed(3),
            text: s.text,
            words: (s.words || []).map(w => ({
              word: w.word, start: +(w.start + start).toFixed(3), end: +(w.end + start).toFixed(3),
            })),
          }));
        if (!segs.length) {
          setRr({ status: 'done', stage: '完毕', progress: 100, segments: [],
            message: '该区间没有识别到语音' });
          return;
        }

        // 3.5) 语义分句(所有引擎都做, 与初稿同一条规则) —— LLM 补标点 → 按逗号/句号切句。
        //      语义分句是必经步骤: 没配 LLM 就直接报错, 不许静默降级成引擎自带的断句;
        //      LLM 真跑失败时才是"小区域不致命", 回退到原断句继续走(见下面 catch)。
        if (!llmReady(translateCfg())) {
          throw new Error('没配置 LLM：语义分句走不了，先在右上角「设置」里填接口地址、API Key 和模型名，再重新识别这一段');
        }
        setRr({ stage: '语义分句中', progress: 72, message: '语义分句中 …' });
        try {
          const cfgR = translateCfg();
          const before = segs.length;
          segs = await resegMod.resegWithLLM(
            (messages, o) => llmChat(cfgR, messages, o).then(r => r.content), segs,
            (frac, msg) => setRr({ stage: '语义分句中', progress: 72 + Math.round((frac || 0) * 3), message: msg || '语义分句中 …' }),
            { splitOnComma: resegSplitOnComma(), onLog: (m) => setRr({ message: '语义分句中 … ' + m }) });
          setRr({ message: `语义分句完成：${before} 行 → ${segs.length} 行` });
        } catch (e) {
          setRr({ message: '语义分句失败，按标点/停顿兜底：' + String((e && e.message) || e).slice(0, 80) });
        }

        // 4) 用设置里的 LLM 翻译（没配 Key 的情况在上面 3.5 就被拦下了, 这里只兜"跑到一半配置被清掉"）
        const cfg = translateCfg();
        let warning = null;
        if (llmReady(cfg)) {
          setRr({ stage: '翻译中', progress: 76, message: '翻译中 …' });
          const translations = [];
          const bSize = transBatchSize(cfg);
          const parts = llmText.planChunks(segs, bSize);
          const chunks = parts.length || 1;
          try {
            for (let bi = 0; bi < parts.length; bi++) {
              const part = await translateLines(cfg, parts[bi].map(s => s.text), 0,
                path.join(projDir(id), 'llm-debug.jsonl'));
              translations.push(...part);
              setRr({ progress: 76 + Math.round(((bi + 1) / chunks) * 21),
                message: `翻译中 … ${bi + 1}/${chunks} 批（每批 ${bSize} 行）` });
            }
            if (translations.length === segs.length) segs.forEach((s, i) => { s.zh = String(translations[i] == null ? '' : translations[i]); });
            else warning = '翻译行数不一致，已跳过译文';
          } catch (e) { warning = '翻译失败：' + String((e && e.message) || e); }
        } else {
          warning = 'API Key 为空，本次没翻。点右上角「设置」填好之后，其它区间就能用';
        }

        if (o.batch) {
          // 批量模式：把这一段的结果**追加**到 job.segments，并把状态留在 running
          // —— 前端要等所有区间跑完才写回（写回必须一次做完, 否则行号会串）。
          job.segments = (job.segments || []).concat(segs);
          job.regionDone = (job.regionDone || 0) + 1;
          job.warnings = (job.warnings || []).concat(warning ? [warning] : []);
          return;                                  // 不置 done，交给批量调度器
        }
        setRr({ status: 'done', stage: '完毕', progress: 100, segments: segs, warning,
          message: `识别完成：${segs.length} 行${warning ? `（${warning}）` : '（含中文译文）'}` });
      } catch (e) {
        const msg = String((e && e.message) || e);
        setRr({ status: 'error', error: msg, message: msg });
      }
    })();
    return job;
  }

  /* ── 批量重识别（纠错机制的执行端）──────────────────────────────
   * 输入是 reflectMod.planRegions() 产出的**互不重叠**区间（路由里还会再求一次并）。
   * 逐段调用 startRerecognize()，共用**同一个 job 对象**：
   *   · 每段跑完把结果追加到 job.segments（见 startRerecognize 里的 o.batch 分支）
   *   · 全部跑完才置 done —— 写回必须一次做完，否则先写回的区间会让后面的行号错位
   * 于是"同一稿件只重识别一遍"在服务端也成立：区间已经并过，每段音频只进一次模型。
   */
  /* 任务是否**真的**还在跑。
   *
   * 为什么要这个判断：POST 的互斥检查曾经只看"任务表里有没有这个 id"，不看状态 ——
   * 于是一个**已经跑完或失败**的任务，只要还没被 10 分钟的老化清理掉，
   * 就会把该稿件的下一次重识别挡死，报"这个稿件已有重新识别任务在跑"（用户实测报的 bug）。
   * 前端那边任务已经结束、按钮也恢复了，用户完全不知道为什么被拒。
   *
   * 除了状态，还看"最后一次心跳"：状态卡在 running 但没有心跳超过 15 分钟，
   * 说明这个任务已经不可能再推进（进程被杀、休眠、异常退出没走到收尾），放行新任务，
   * 别让用户永久卡住。 */
  const JOB_STALE_MS = 15 * 60 * 1000;
  function jobStillRunning(job) {
    if (!job || job.status !== 'running') return false;
    const beat = job.updatedAt ? Date.parse(job.updatedAt) : NaN;
    if (Number.isFinite(beat) && Date.now() - beat > JOB_STALE_MS) return false;   // 心跳停了 → 当作死任务
    return true;
  }

  /** 等一个后台作业跑完（自动后处理必须串行：下一步要读上一步的结果）。
   *  与前端轮询同一套判定（jobStillRunning 看状态+心跳），所以"死任务"不会把自动流程挂住。 */
  async function waitJob(job, timeoutMs) {
    const t0 = Date.now();
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 30 * 60 * 1000;
    while (jobStillRunning(job)) {
      if (Date.now() - t0 > limit) throw new Error('等待后台任务超时');
      await new Promise(r => setTimeout(r, 1000));
    }
    if (job && job.status === 'error') throw new Error(job.error || '后台任务失败');
    return job;
  }

  function startReidentifyBatch(id, regions, model) {
    const job = {
      batch: true,
      regions: regions.map(r => ({ start: r.start, end: r.end })),
      regionTotal: regions.length, regionDone: 0,
      start: regions[0].start, end: regions[0].end,
      status: 'running', stage: '切音频', progress: 1,
      message: `纠错重识别：共 ${regions.length} 段 …`, error: null,
      segments: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    rerecogJobs.set(id, job);
    // 心跳：每次读任务状态时刷新。GET /reidentify 与 startRerecognize 的 setRr 都会经过这里
    job.touch = () => { job.updatedAt = new Date().toISOString(); };
    (async () => {
      try {
        for (let i = 0; i < regions.length; i++) {
          if (job.status === 'error') return;              // 中途失败：不再往下跑
          const r = regions[i];
          job.regionIndex = i;
          job.message = `纠错重识别 ${i + 1}/${regions.length} 段（${r.start.toFixed(1)}~${r.end.toFixed(1)}s）…`;
          job.stage = '识别中'; job.progress = Math.round((i / regions.length) * 100);
          // 复用单区间识别：同一 job、batch 模式（追加结果、不置 done）
          startRerecognize(id, r.start, r.end, model, { job, batch: true });
          // 等这一段真正结束（job.status 被单区间流程改成 done/error，batch 模式下
          // 单区间不会置 done，所以这里用一个"本段完成"的标记来等）
          const n0 = (job.segments || []).length;
          const done0 = job.regionDone || 0;
          // 轮询等待：简单可靠，且不会与单区间流程的内部 await 链打架
          const t0 = Date.now();
          // eslint-disable-next-line no-await-in-loop
          while (job.regionDone === done0 && job.status !== 'error' && Date.now() - t0 < 30 * 60 * 1000) {
            job.touch();                       // 心跳：本段还在跑，别被当成死任务
            // eslint-disable-next-line no-await-in-loop
            await new Promise(res => setTimeout(res, 250));
          }
          if (job.status === 'error') return;
          job.progress = Math.round(((i + 1) / regions.length) * 100);
          void n0;
        }
        // 全部跑完 → 排序（区间是按时间递增的，结果天然有序，保险起见排一次）
        const segs = (job.segments || []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
        job.segments = segs;
        job.status = 'done'; job.stage = '完毕'; job.progress = 100;
        job.finishedAt = new Date().toISOString();
        job.warning = (job.warnings || [])[0] || null;
        job.message = `纠错重识别完成：${regions.length} 段 → ${segs.length} 行`
          + (job.warning ? `（${job.warning}）` : '');
      } catch (e) {
        const msg = String((e && e.message) || e);
        job.status = 'error'; job.error = msg; job.message = msg;
        job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }

  /** 任务对象 → 给前端的视图（只暴露需要的字段，别把整个 job 抖出去） */
  function jobView(job) {
    if (!job) return null;
    return {
      batch: !!job.batch,
      regions: job.regions || null,
      regionIndex: job.regionIndex | 0,
      regionTotal: job.regionTotal | 0,
      regionDone: job.regionDone | 0,
      start: job.start, end: job.end,
      status: job.status, stage: job.stage, progress: job.progress,
      message: job.message, error: job.error, warning: job.warning || null,
      // 批量模式下 segments 在跑完前是累加中的，前端只在 done 后写回
      segments: job.status === 'done' ? (job.segments || []) : null,
      finishedAt: job.finishedAt || null,
    };
  }
  /** 纠错反思的互斥标记：同一稿件不并发反思（会重复烧 token 且结果互相覆盖） */
  const reflectBusy = new Set();
  /** 纠错重识别的任务表：与单区间共用 rerecogJobs —— 同一稿件的重识别必须串行，
   *  否则两个任务会同时改同一份字幕。 */
  const jobRerecog = rerecogJobs;

  async function startTranslate(id) {
    const cfg = translateCfg();
    if (!llmReady(cfg)) return finishDraft(id, new Error('还没配置翻译：在主界面右上角「设置」里填接口地址、API Key 和模型名'));
    if (draftJobs.has(id)) return;

    let segs;
    try { segs = readSegments(id); } catch (e) { return finishDraft(id, e); }

    draftJobs.add(id);
    setDraft(id, { status: 'running', stage: STAGE.translate, progress: 86, message: '准备翻译…' });
    pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 开始翻译（模型 ${cfg.model}）`);

    const n = segs.length;
    const lines = readTranslations(id, n) || new Array(n).fill('');
    const todo = [];
    for (let i = 0; i < n; i++) if (!lines[i]) todo.push(i);
    if (!todo.length) {
      pushDraftLog(id, '每行都已有译文，不需要重翻');
      return finishTranslate(id, segs, lines);
    }
    const batchSize = transBatchSize(cfg);
    pushDraftLog(id, `共 ${n} 行，本次需要翻译 ${todo.length} 行（每批 ${batchSize} 行）`);

    const batches = llmText.planChunks(todo, batchSize);

    let failedBatches = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const idxs = batches[bi];
      const t0 = Date.now();
      const r = await translateBatch(cfg, segs, idxs, 0, path.join(projDir(id), 'llm-debug.jsonl'));
      if (r.texts) {
        idxs.forEach((gi, k) => { lines[gi] = String(r.texts[k] == null ? '' : r.texts[k]); });
        saveTranslations(id, cfg.model, lines);      // 每批立刻落盘, 可续翻
        pushDraftLog(id, `第 ${bi + 1}/${batches.length} 批完成（${idxs.length} 行，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      } else {
        failedBatches++;
        pushDraftLog(id, `[错误] 第 ${bi + 1}/${batches.length} 批失败（${idxs.length} 行）：${r.err}`);
      }
      saveTranslations(id, cfg.model, lines);
      setDraft(id, {
        stage: STAGE.translate, progress: 86 + Math.round(((bi + 1) / batches.length) * 12),
        message: `翻译中 … ${bi + 1}/${batches.length} 批${failedBatches ? `（${failedBatches} 批失败）` : ''}`,
      });
    }
    if (failedBatches) pushDraftLog(id, `本轮流式结束：${failedBatches}/${batches.length} 批未成功`);
    return finishTranslate(id, segs, lines);
  }

  /** 语义分句(初稿, 所有引擎共用): 读 asr.json → LLM 补标点 → 按逗号/句号切句 → 写回。
   *  成功后 meta.draft.resegDone = true（重试/跳过逻辑靠它判断这一步还欠不欠着）。 */
  async function runDraftReseg(id) {
    const cfg = translateCfg();
    // 进度条与服务端流水线的顺序一致(识别 → 语义分句 → 说话人分离 → 翻译), 而且不许倒退:
    // 语义分句占 76~82, 说话人分离接在 82 之后; 从当前值接着走, 绝不硬跳回 76。
    const curDraft = (readMeta(id) || {}).draft || {};
    const base = Math.max(76, Math.min(Number(curDraft.progress) || 0, 80));
    const span = Math.max(1, 82 - base);
    setDraft(id, { status: 'running', stage: STAGE.reseg, progress: base, message: '语义分句中 …', error: null, failedStage: '' });
    pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 开始语义分句（LLM 补标点 → 按逗号/句号切句）`);
    const p = path.join(projDir(id), 'asr.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const before = (data.segments || []).length;
    // 断点续跑：每批成功就落盘 reseg.json（词表指纹对得上才复用）。重试 / 服务重启后跳过做过的批次 ——
    // 1.2 万词 = 52 批，重跑一遍要几分钟、几十次模型调用，以前每次重试都从第 1 批从头来。
    const ckPath = path.join(projDir(id), 'reseg.json');
    const loadCheckpoint = () => { try { return JSON.parse(fs.readFileSync(ckPath, 'utf8')); } catch { return null; } };
    const saveCheckpoint = (idx, pairs, meta) => {
      try {
        const ck = loadCheckpoint() || {};
        if (ck.model !== cfg.model || ck.words !== meta.words || ck.sig !== meta.sig) {
          ck.model = cfg.model; ck.words = meta.words; ck.sig = meta.sig; ck.batches = {};
        }
        ck.batches = ck.batches || {};
        ck.batches[String(idx)] = pairs;
        ck.total = meta.total; ck.updatedAt = new Date().toISOString();
        fs.writeFileSync(ckPath + '.tmp', JSON.stringify(ck));
        fs.renameSync(ckPath + '.tmp', ckPath);
      } catch {}
    };
    const stats = {};
    const segs2 = await resegMod.resegWithLLM(
      // chat 注入: 带上诊断转储文件, 并把 llmChat 的新返回形状(content+元数据)拆成纯文本给 reseg
      (messages, o) => llmChat(cfg, messages, Object.assign({ debugFile: path.join(projDir(id), 'llm-debug.jsonl') }, o))
        .then(r => r.content),
      data.segments || [],
      (frac, msg) => setDraft(id, { stage: STAGE.reseg, progress: base + Math.round((frac || 0) * span), message: msg || '语义分句中 …' }),
      {
        splitOnComma: resegSplitOnComma(),
        model: cfg.model,
        stats, loadCheckpoint, saveCheckpoint,
        onLog: (m) => pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [分句] ${m}`),
      });
    // 分句会重建句子（丢掉 confidence），这里把原句的置信度按时间重叠搬过去 ——
    // 否则 asr.json 分句后没有逐句置信度，ASS 注释写不出来，界面也看不到。
    {
      const carried = carryConfidence(data.segments, segs2);
      pushDraftLog(id, `[分句] 置信度已随分句迁移到 ${carried} 行`);
    }
    data.segments = segs2;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
    // 统计：抢救 / 放弃 / 续跑各几批 —— 出问题时用户一眼能看出是哪一类
    const stamp1 = '[' + new Date().toLocaleTimeString() + '] ';
    if (stats.salvaged && stats.salvaged.length) pushDraftLog(id, stamp1 + `[分句] ${stats.salvaged.length} 批标点密度异常，已只保留句末标点`);
    if (stats.skipped && stats.skipped.length) pushDraftLog(id, stamp1 + `[分句] ${stats.skipped.length} 批没做出标点，这些词按停顿兜底（其余批次正常）`);
    const meta = readMeta(id);
    if (meta && meta.draft) { meta.draft.resegDone = true; writeMeta(meta); }
    pushDraftLog(id, stamp1 + `语义分句完成：${before} 行 → ${segs2.length} 行`
      + (stats.skipped && stats.skipped.length ? `（${stats.skipped.length} 批按停顿兜底）` : ''));
  }

  /** 识别之后的两步收尾（模块级, retryDraft 也走这里）:
   *  勾了「区分说话人」且分离模型就绪（且没被跳过）→ 先分离再生成字幕; 否则直接生成。 */
  function continueDraftAfterAsr(id, wordLevel) {
    const meta0 = readMeta(id);
    const d0 = (meta0 && meta0.draft) || {};
    const wantSpk = !!d0.speakers && diarizeReady() && !d0.diarizeSkipped;

    /** 分角色开关（默认开; 关掉就完全不动, 行为与以前一致） */
    const castOn = () => {
      try { return (readAsrSettings().cast || {}).enabled !== false; } catch { return true; }
    };
    const stamp = () => '[' + new Date().toLocaleTimeString() + '] ';
    const cfgLLM = translateCfg();
    const castUsable = () => castOn() && llmReady(cfgLLM);
    // 注意: llmChat 返回的是 { content, finishReason, ... } —— 必须取 .content（分句那边也是这么用的）
    const llmCall = (msgs) => llmChat(cfgLLM, msgs, { jsonMode: true, maxTokens: 1200 }).then((r) => r.content);

    if (wantSpk) {
      const wav = path.join(projDir(id), 'audio.wav');
      // ① 阵容推断（说话人分离**之前**）: 用 LLM 判断有几个人物 → 作为 SPK 数传给 diarize.py。
      //    diarize.py 的 num_clusters 是**强制**聚类数, 不传就永远按 6 人分（2 人视频会被硬拆）。
      const pre = castUsable()
        ? cast.inferCast({
            source: meta0.source,
            userCount: Number(d0.speakerCount) || 0,
            systemPrompt: castPromptCfg(),
            call: llmCall,
            log: (m) => pushDraftLog(id, stamp() + m),
          }).catch((e) => ({ characters: [], speakerCount: Number(d0.speakerCount) || 0, error: String((e && e.message) || e) }))
        : Promise.resolve({ characters: [], speakerCount: Number(d0.speakerCount) || 0, error: '' });

      pre.then((cs) => {
        if (cs && cs.characters && cs.characters.length) {
          const m1 = readMeta(id);
          if (m1 && m1.draft) {
            m1.draft.cast = { characters: cs.characters, map: {}, extra: [], at: new Date().toISOString(), source: 'llm' };
            m1.draft.speakerCount = cs.speakerCount;
            writeMeta(m1);
          }
          setDraft(id, { cast: ((readMeta(id) || {}).draft || {}).cast || null });
          pushDraftLog(id, stamp() + '说话人分离按 ' + cs.speakerCount + ' 人');
        }
        const spkCount = (cs && Number(cs.speakerCount)) || Number(d0.speakerCount) || 0;
        setDraft(id, { stage: STAGE.diarize, progress: 82, message: '区分说话人中 …' });
        return runDiarize(wav, (pct, msg) => setDraft(id, { stage: STAGE.diarize, progress: 82 + Math.round((pct || 0) * 0.03), message: msg || '区分说话人中 …' }), spkCount,
          (m) => pushDraftLog(id, stamp() + m));
      }).then((r) => safeDraftStep(id, async () => {
        let segs = [];
        try {
          const d = JSON.parse(fs.readFileSync(path.join(projDir(id), 'asr.json'), 'utf8'));
          assignSpeakers(d.segments || [], r.regions || []);
          const tmp = path.join(projDir(id), 'asr.json') + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(d));
          fs.renameSync(tmp, path.join(projDir(id), 'asr.json'));
          segs = d.segments || [];
        } catch (e) { return finishDraft(id, e); }

        // ② SPK → 真实角色名（分离**之后**）: 把每个 SPK 的台词样本喂给 LLM。
        //    没映射上的保留 SPKn（识别出的说话人比人物多时就是这种）。
        const m2 = readMeta(id);
        const saved = (m2 && m2.draft && m2.draft.cast) || null;
        if (castUsable() && saved && Array.isArray(saved.characters) && saved.characters.length && segs.length) {
          setDraft(id, { stage: STAGE.cast, progress: 86, message: '分角色中 …' });
          try {
            const mr = await cast.mapSpeakers({
              source: m2.source, characters: saved.characters, segments: segs,
              call: llmCall, log: (m) => pushDraftLog(id, stamp() + m),
            });
            const m3 = readMeta(id);
            if (m3 && m3.draft) {
              m3.draft.cast = Object.assign({}, saved, {
                map: mr.map || {}, extra: mr.extra || [], unlisted: mr.unlisted || [],
                mappedAt: new Date().toISOString(),
              });
              writeMeta(m3);
            }
            if (mr.error) pushDraftLog(id, stamp() + '[分角色] ' + mr.error + '（这些说话人保留 SPK 编号）');
          } catch (e) {
            // 分角色失败绝不影响出稿
            pushDraftLog(id, stamp() + '[分角色] 失败: ' + ((e && e.message) || e) + '（保留 SPK 编号）');
          }
        }
        buildDraftSubtitle(id, wordLevel);
      })).catch((e) => { draftJobs.delete(id); finishDraft(id, e); });
      return;
    }
    // 不做说话人分离: 没有 SPK 可分, 直接出稿（也不白花一次模型调用）
    buildDraftSubtitle(id, wordLevel);
  }

  /* ── 长音频分片（云端与本地共用）────────────────────────────────────
   *  为什么要分片：云端免费接口对长音频容易超时/限流（几小时基本必挂）；本地 whisper 对长音频也不友好
   *  （显存占用大、出错重来代价高）。做法：25 分钟一片，切点优先落在静音中点，片间不重叠，
   *  每片的时间戳加回片起点后合并。云端片间随机等 10~15 秒（模拟人类节奏，降低风控概率），本地不等。
   *  短视频（≤ 25 分钟 + 1 分钟）完全走原路径：不做静音检测、不切片，行为与以前一致。 */
  const CHUNK_MIN_SEC = asrChunks.CHUNK_SEC + asrChunks.MIN_TAIL_SEC;

  /* 静音检测与切片都用 editor/audio-slice.js（真 ffmpeg）—— 抽出去是为了让
     tools/chunk_probe.mjs 能跑**同一份实现**做离线验证，而不是在探针里另抄一遍。 */
  const detectSilences = (wav, timeoutMs) => audioSlice.detectSilences(FFMPEG, wav, timeoutMs);
  const sliceAudio = (wav, start, end, out, asMp3) => audioSlice.sliceAudio(FFMPEG, wav, start, end, out, asMp3);
  /** 分片数据落盘（用户要的「返回分片数据」）：projects/<id>/asr-chunks.json + 草稿摘要 */
  function writeChunkReport(id, info) {
    try {
      const rec = {
        createdAt: new Date().toISOString(),
        engine: info.engine || '',
        duration: info.duration,
        chunkSec: asrChunks.CHUNK_SEC,
        source: info.source || 'nominal',            // silence = 按静音切 / nominal = 名义切点
        silenceCount: info.silenceCount || 0,
        chunks: (info.plan || []).map((c, i) => Object.assign({}, c, (info.perChunk && info.perChunk[i]) || {})),
      };
      fs.writeFileSync(path.join(projDir(id), 'asr-chunks.json'), JSON.stringify(rec, null, 2));
      const meta = readMeta(id);
      if (meta && meta.draft) {
        meta.draft.chunks = { count: rec.chunks.length, chunkSec: rec.chunkSec, source: rec.source };
        writeMeta(meta);
      }
      return rec;
    } catch { return null; }
  }

  /** 云端分片：逐片转 mp3 → 逐片走云端（每片各自享受必剪↔剪映回退）→ 片间随机等 10~15 秒 → 合并 */
  function transcribeCloudChunked(o) {
    const id = o.id;
    const cloudLog = (m) => pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] ' + m);
    const tmp = [];
    let used = null;
    cloudLog('[分片] 音频 ' + Math.round(o.duration / 60) + ' 分钟 → 切 ' + o.plan.length + ' 片（每片约 '
      + Math.round(asrChunks.CHUNK_SEC / 60) + ' 分钟，' + (o.source === 'silence' ? '按静音切' : '按固定时长切')
      + '），片间随机等 10~15 秒');
    return asrChunks.runChunks({
      chunks: o.plan, signal: o.ctl.signal, log: cloudLog,
      waitBetweenMs: () => asrChunks.randomWaitMs(),          // 云端: 片间 10~15 秒随机
      onProgress: (done, total) => setDraft(id, {
        stage: STAGE.asr, progress: 30 + Math.round((done / total) * 45), message: '第 ' + done + '/' + total + ' 片识别中 …',
      }),
      runOne: async (c) => {
        const mp3 = path.join(os.tmpdir(), 'ss-chunk-' + process.pid + '-' + c.index + '-' + Date.now().toString(36) + '.mp3');
        tmp.push(mp3);
        await sliceAudio(o.wav, c.start, c.end, mp3, true);
        let mb = 0; try { mb = fs.statSync(mp3).size / 1048576; } catch {}
        cloudLog('第 ' + (c.index + 1) + '/' + o.plan.length + ' 片已转 mp3（' + mb.toFixed(1) + ' MB），开始上传');
        const r = await transcribeCloud({
          engine: o.engine, audioPath: mp3, signal: o.ctl.signal, log: cloudLog,
          onProgress: (pct, msg) => setDraft(id, {
            stage: STAGE.asr,
            progress: 30 + Math.round(((c.index + (Number(pct) || 0) / 100) / o.plan.length) * 45),
            message: '第 ' + (c.index + 1) + '/' + o.plan.length + ' 片：' + msg,
          }),
        });
        used = r;
        return r;
      },
    }).then((r) => {
      const segments = asrChunks.mergeChunkSegments(r.parts);
      writeChunkReport(id, { engine: o.engine, duration: o.duration, plan: o.plan, perChunk: r.perChunk, silenceCount: o.silenceCount, source: o.source });
      cloudLog('[分片] 合并完成：' + segments.length + ' 句（分片数据见 asr-chunks.json）');
      return { segments, used };
    }).finally(() => { for (const f of tmp) { try { fs.unlinkSync(f); } catch {} } });
  }

  /** 本地分片：逐片切片 → 逐片识别（片间不等候）→ 合并。runOne(slicePath, chunk) 返回该片的 {segments} */
  function transcribeLocalChunked(o) {
    const id = o.id;
    const lg = (m) => pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] ' + m);
    const tmp = [];
    lg('[分片] 音频 ' + Math.round(o.duration / 60) + ' 分钟 → 切 ' + o.plan.length + ' 片（每片约 '
      + Math.round(asrChunks.CHUNK_SEC / 60) + ' 分钟，' + (o.source === 'silence' ? '按静音切' : '按固定时长切')
      + '）；本地识别片间不等候');
    return asrChunks.runChunks({
      chunks: o.plan, log: lg, waitBetweenMs: null,            // 本地: 片间不等候
      onProgress: (done, total) => setDraft(id, {
        stage: STAGE.asr, progress: 30 + Math.round((done / total) * 45), message: '第 ' + done + '/' + total + ' 片识别中 …',
      }),
      runOne: async (c) => {
        const slice = path.join(os.tmpdir(), 'ss-slice-' + process.pid + '-' + c.index + '-' + Date.now().toString(36) + '.wav');
        tmp.push(slice);
        await sliceAudio(o.wav, c.start, c.end, slice, false);
        return await o.runOne(slice, c);
      },
    }).then((r) => {
      const segments = asrChunks.mergeChunkSegments(r.parts);
      writeChunkReport(id, { engine: o.engine, duration: o.duration, plan: o.plan, perChunk: r.perChunk, silenceCount: o.silenceCount, source: o.source });
      lg('[分片] 合并完成：' + segments.length + ' 句（分片数据见 asr-chunks.json）');
      return { segments };
    }).finally(() => { for (const f of tmp) { try { fs.unlinkSync(f); } catch {} } });
  }

  /** 两个云端引擎都只收 flac/aac/m4a/mp3/wav；而项目里的 audio.wav 是 16k 单声道 PCM（1 小时 ≈ 115MB），
   *  上传太费流量：统一转成 16kHz 单声道 64kbps mp3（1 小时 ≈ 28MB），上传完即删。 */
  function toCloudAudio(wav) {
    return new Promise((resolve, reject) => {
      const out = path.join(os.tmpdir(), `ss-cloud-${process.pid}-${Date.now().toString(36)}.mp3`);
      const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out], { windowsHide: true });
      const t = setTimeout(() => { try { p.kill(); } catch {} }, 30 * 60 * 1000);
      let err = '';
      p.stderr.on('data', d => { if (err.length < 800) err += String(d); });
      p.on('error', e => { clearTimeout(t); reject(new Error('ffmpeg 不可用: ' + e.message)); });
      p.on('close', c => {
        clearTimeout(t);
        if (c !== 0) return reject(new Error('音频转 mp3 失败: ' + err.slice(-200)));
        try { if (!fs.statSync(out).size) throw new Error('空文件'); }
        catch (e) { return reject(new Error('音频转 mp3 结果异常: ' + e.message)); }
        resolve(out);
      });
    });
  }

  /* ── 云端引擎表 + 「互为备份」的调用 ──────────────────────────────
   * 免费云端服务普遍限次/限流，所以两个云端引擎(必剪 / 剪映)互为备份：选中的那个失败就自动换另一个重试。
   * 只做「云端 → 云端」的回退 —— 本地模型可能没装/没 GPU，而且**本地任务绝不该被悄悄改成上传**；
   * 用户主动取消(abort)也不回退。 */
  const CLOUD_ASR = [
    { engine: 'bcut', modelId: 'bcut-asr', name: '必剪 ASR', where: 'bilibili 服务器', client: bcutAsr },
    { engine: 'capcut', modelId: 'capcut-asr', name: '剪映 ASR', where: '字节跳动服务器', client: capcutAsr },
  ];
  async function transcribeCloud({ engine, audioPath, log, onProgress, signal }) {
    const primary = CLOUD_ASR.find(x => x.engine === engine) || CLOUD_ASR[0];
    const order = [primary, ...CLOUD_ASR.filter(x => x !== primary)];
    let lastErr = null;
    for (let i = 0; i < order.length; i++) {
      const c = order[i];
      try {
        if (i === 0) log(`[提示] ${c.name}：音频会上传到${c.where}（机密素材请换本地模型）`);
        else {
          log(`[备份引擎] 改用「${c.name}」重试（前一个失败：${lastErr ? lastErr.message : '未知'}）`);
          onProgress(32, `改用「${c.name}」重试 …`);
        }
        const r = await c.client.transcribe({ audioPath, signal, log, onProgress });
        return { segments: r.segments, engine: c.engine, modelId: c.modelId, name: c.name, fallback: i > 0 };
      } catch (e) {
        if (signal && signal.aborted) throw e;          // 用户取消: 不换引擎
        lastErr = e;
        log(`[失败] ${c.name}：${e.message}`);
      }
    }
    throw lastErr || new Error('云端识别失败（两个引擎都没成功）');
  }

  async function startDraftAsr(id, wordLevel) {
    const meta0 = readMeta(id) || {};
    const wantId = meta0.draft && meta0.draft.modelId;
    const want = wantId ? modelById(wantId) : null;
    // 硬拦: 只能重新识别的模型(如 multitalker)不许拿来创建初稿
    if (want && !draftAllowedOf(want)) {
      return finishDraft(id, new Error('「' + want.name + '」只能用于重新识别，不能创建初稿。到「设置 → 识别模型」给初稿换一个模型'));
    }
    const model = resolveDraftModel(meta0);
    if (!model) return finishDraft(id, new Error('语音识别模型不可用，先到设置里下载，或换一个已经装好的模型'));
    // GPU 硬校验: ASR 必须跑在 GPU 上, 不做 CPU 兜底
    const gpuGate = asrGpuGateError(model);
    if (gpuGate) {
      pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [GPU 校验失败] ${gpuGate}`);
      return finishDraft(id, new Error(gpuGate));
    }
    const mdir = modelDirFor(model.id);
    // 逐句置信度：项目级设置优先，没表态就跟随全局。算一次，三处 spawn 与常驻服务共用。
    const confMode = asrConfidenceFor(meta0);   // off | fast | full
    draftJobs.add(id);
    const wav = path.join(projDir(id), 'audio.wav');
    const outJson = path.join(projDir(id), 'asr.json');
    try { fs.unlinkSync(draftLogFile(id)); } catch {}
    try { fs.unlinkSync(outJson); } catch {}
    // 换任务/重试时, 精确清掉本项目遗留的识别进程(实测重复启动会双跑抢资源)
    killDraftProc(id);
    setDraft(id, { status: 'running', stage: STAGE.asr, progress: 30, message: '启动识别引擎…' });
    // 长音频 → 先规划分片（静音优先）。短视频不走这里：不做静音检测、不切片，行为与以前完全一致。
    const durSec = Number(meta0.duration) || Number(meta0.prepare && meta0.prepare.duration) || 0;
    let chunkPlan = null, chunkSilences = [];
    if (durSec > CHUNK_MIN_SEC) {
      setDraft(id, { stage: STAGE.asr, progress: 30, message: '分析静音，准备分片 …' });
      pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] [分片] 音频较长（' + Math.round(durSec / 60) + ' 分钟），先找静音切点 …');
      chunkSilences = await detectSilences(wav);
      const plan1 = asrChunks.planAudioChunks({ duration: durSec, silences: chunkSilences });
      chunkPlan = plan1.length > 1 ? plan1 : null;
      pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] [分片] 找到 ' + chunkSilences.length + ' 段静音 → '
        + (chunkPlan ? chunkPlan.length + ' 片' : '不需要分片'));
    }
    pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 开始语音识别（模型：${model.name}，逐词：${wordLevel ? '开' : '关'}）`);
    if (model.engine === 'whisper.cpp') {
      // GPU 校验已在上面的 asrGpuGateError 通过: 走到这里必然有 Vulkan 运行库
      pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [提示] whisper.cpp GPU·Vulkan 推理`);
    }

    // 识别完成后的收尾三段式: reseg(语义分句) → diarize(区分说话人) → 生成字幕 ——
    // 顺序就是这样: **先把行切开, 再往这些行上标说话人**（进度浮层的步骤条同一顺序）。
    // 三步都与识别引擎无关: 分离跑在音频上, 任何引擎都能配;
    // 语义分句**所有引擎都做**, 没配 LLM 就直接失败停在这里, 不会跳过它往下走。
    const finishAsr = () => {
      // off 档：在往下走之前把逐句置信度摘掉。
      // 这里是所有识别路径的汇合点（本地/分片/整段/whisper.cpp/云端），
      // 而且**在语义分句之前** —— 于是 ASS 里不会写 SubFabricConfidence 注释，
      // 界面也就没有徽标可显示，"关"是彻底的。
      // worker 那边只是不重跑稳定性（--tta 0）；token 概率与音频质量是解码时白送的，
      // 让 worker 为它们再跑一遍反而更麻烦，所以"丢弃"这一步放在服务端做。
      if (confMode === 'off') {
        try {
          const p = outJson;
          const d = JSON.parse(fs.readFileSync(p, 'utf8'));
          const n = stripConfidence(d.segments);
          fs.writeFileSync(p + '.tmp', JSON.stringify(d));
          fs.renameSync(p + '.tmp', p);
          pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [置信度] 已关闭：不生成逐句置信度（省掉稳定性重跑，识别更快）`);
          if (n) pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [置信度] 已丢弃 ${n} 行的置信度数据`);
        } catch (e) {
          pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [置信度] 丢弃失败（不影响识别）：${(e && e.message) || e}`);
        }
      }
      // 语义分句是**必经步骤**: 没配 LLM 就在这里失败, 绝不静默降级成引擎自带的断句往下走。
      // retryDraft 对「没配 LLM」也是直接拒绝(连重试次数都不涨), 所以出路只有一条: 把 Key 填上。
      if (!llmReady(translateCfg())) {
        setDraft(id, { stage: STAGE.reseg, message: '语义分句需要 LLM …', error: null, failedStage: '' });
        pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [错误] 没配置 LLM，语义分句走不了，流水线停在这一步`);
        return finishDraft(id, new Error('没配置 LLM：语义分句走不了，先在右上角「设置」里填接口地址、API Key 和模型名，再点「重试」'));
      }
      runDraftReseg(id)
        .then(() => continueDraftAfterAsr(id, wordLevel))
        .catch(e => { draftJobs.delete(id); finishDraft(id, e); });
    };

    // ── whisper.cpp 引擎: whisper-cli(词级用 -ml 1 -sow), 结果转成 asr.json ──
    if (model.engine === 'whisper.cpp') {
      const bin = path.join(mdir, model.files[0]);
      if (chunkPlan) {
        transcribeLocalChunked({
          id, wav, plan: chunkPlan, duration: durSec, engine: model.engine,
          silenceCount: chunkSilences.length, source: chunkSilences.length ? 'silence' : 'nominal',
          runOne: (slice, c) => runWhisperCpp(bin, slice, (pct, secs) => {
            const t = (secs != null) ? '（本片已运行 ' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒）' : '';
            setDraft(id, {
              stage: STAGE.asr,
              progress: 30 + Math.round(((c.index + (Number(pct) || 0) / 100) / chunkPlan.length) * 45),
              message: '第 ' + (c.index + 1) + '/' + chunkPlan.length + ' 片：whisper.cpp·GPU·Vulkan … ' + pct + '% ' + t,
            });
          }, { register: p => draftProcs.set(id, p) }),
        }).then((r) => {
          try {
            fs.writeFileSync(outJson + '.tmp', JSON.stringify({ segments: r.segments }));
            fs.renameSync(outJson + '.tmp', outJson);
          } catch (e) { return finishDraft(id, e); }
          pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] 识别完成 ' + r.segments.length
            + ' 行（' + chunkPlan.length + ' 片合并）');
          finishAsr();
        }).catch((e) => { draftJobs.delete(id); finishDraft(id, e); });
        return;
      }
      runWhisperCpp(bin, wav, (pct, secs) => {
        const t = (secs != null) ? `（已运行 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒）` : '';
        setDraft(id, { stage: STAGE.asr, progress: 30 + Math.round(pct * 0.45), message: `识别中（whisper.cpp·GPU·Vulkan）… ${pct}% ${t}` });
      }, { register: p => draftProcs.set(id, p) }).then(r => {
        try {
          fs.writeFileSync(outJson + '.tmp', JSON.stringify(r));
          fs.renameSync(outJson + '.tmp', outJson);
        } catch (e) { return finishDraft(id, e); }
        pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 识别完成 ${r.segments.length} 行`);
        finishAsr();
      }).catch(e => { draftJobs.delete(id); finishDraft(id, e); });
      return;
    }

    // ── 云端引擎(必剪 / 剪映): 没有本地模型、没有子进程, 走"转 mp3 → 上传 → 提交 → 轮询" ──
    // 取消靠 AbortController(见 killDraftProc); 两个引擎互为备份(转 mp3 只做一次, 失败换引擎直接复用)。
    if (model.cloud && chunkPlan) {
      const ctl = new AbortController();
      draftAborts.set(id, ctl);
      transcribeCloudChunked({
        id, engine: model.engine, wav, plan: chunkPlan, ctl, duration: durSec,
        silenceCount: chunkSilences.length, source: chunkSilences.length ? 'silence' : 'nominal',
      }).then((r) => {
        draftAborts.delete(id);
        const segments = r.segments || [];
        if (!segments.length) {
          return finishDraft(id, new Error(((r.used && r.used.name) || '云端识别')
            + ' 没有识别到语音。音频可能是纯音乐或静音，也可能这一段没人说话'));
        }
        try {
          fs.writeFileSync(outJson + '.tmp', JSON.stringify({ segments }));
          fs.renameSync(outJson + '.tmp', outJson);
          const meta1 = readMeta(id);
          if (meta1 && meta1.draft && r.used) {
            meta1.draft.usedModelId = r.used.modelId;
            meta1.draft.engine = r.used.engine;
            writeMeta(meta1);
          }
        } catch (e) { return finishDraft(id, e); }
        finishAsr();
      }).catch((e) => { draftAborts.delete(id); draftJobs.delete(id); finishDraft(id, e); });
      return;
    }

    if (model.cloud) {
      const ctl = new AbortController();
      draftAborts.set(id, ctl);
      const cloudLog = (m) => pushDraftLog(id, `[${new Date().toLocaleTimeString()}] ${m}`);
      // 云端客户端报的是它自己的绝对刻度(最后到 86); 这里映射进本流水线的 ASR 段(30~75) ——
      // 后面还排着语义分句(76~82)与说话人分离(82~86), ASR 不能提前跑到 86。
      const cloudProg = (pct, msg) => setDraft(id, {
        stage: STAGE.asr, progress: 30 + Math.round((Number(pct) || 0) * 0.45), message: msg,
      });
      toCloudAudio(wav)
        .then(async (mp3) => {
          let mb = 0;
          try { mb = fs.statSync(mp3).size / 1048576; } catch {}
          cloudLog(`已转 mp3（${mb.toFixed(1)} MB），开始上传`);
          try {
            return await transcribeCloud({
              engine: model.engine, audioPath: mp3, signal: ctl.signal,
              log: cloudLog, onProgress: cloudProg,
            });
          } finally { try { fs.unlinkSync(mp3); } catch {} }   // 传完/失败都要清临时 mp3
        })
        .then((used) => {
          draftAborts.delete(id);
          if (!used.segments.length) {
            return finishDraft(id, new Error(`${used.name} 没有识别到语音。音频可能是纯音乐或静音，也可能这一段没人说话`));
          }
          try {
            fs.writeFileSync(outJson + '.tmp', JSON.stringify({ segments: used.segments }));
            fs.renameSync(outJson + '.tmp', outJson);
            // 记下**实际**用的引擎(可能是备份引擎): ASS 头署名与重试都用它
            const meta1 = readMeta(id);
            if (meta1 && meta1.draft) { meta1.draft.usedModelId = used.modelId; meta1.draft.engine = used.engine; writeMeta(meta1); }
          } catch (e) { return finishDraft(id, e); }
          finishAsr();                                   // 云端断句也照样过语义分句
        })
        .catch((e) => {
          draftAborts.delete(id);
          draftJobs.delete(id);
          finishDraft(id, e);
        });
      return;
    }

    // ── sherpa-onnx 引擎: asr.py ──
    // 预检通过才 spawn: 给远程用户可操作的修复指引, 而不是一句「异常退出(9009)」
    probePython(model.engine).then(pre => {
      const ts = () => new Date().toLocaleTimeString();
      if (!pre.ok) {
        pushDraftLog(id, `[${ts()}] [预检失败] ${pre.msg}`);
        pushDraftLog(id, `[${ts()}] [修复方法] ① 安装 Python 3.10~3.12（python.org，安装时勾选 Add python.exe to PATH）`);
        pushDraftLog(id, `[${ts()}] [修复方法] ② 在程序目录 asr\\ 下执行: py -3.12 -m venv .venv`);
        pushDraftLog(id, `[${ts()}] [修复方法] ③ asr\\.venv\\Scripts\\pip.exe install -r requirements.txt`);
        draftJobs.delete(id);
        return finishDraft(id, new Error('语音识别需要 Python 环境。到「设置 → 识别模型 → Python 环境」点「安装」（详见日志：' + pre.msg + '）'));
      }
      pushDraftLog(id, `[${ts()}] Python: ${ASR_PY}${pre.msg ? '（' + pre.msg + '）' : ''}`);
      pushDraftLog(id, `[${ts()}] [提示] Parakeet 推理设备：GPU·CUDA（已通过 GPU 校验；运行时报 CUDA 错误就重新安装一次）`);

      if (chunkPlan) {
        // 本地 sherpa: 逐片切片 → 逐片跑 asr.py → 合并。片间不等候（本地没有限流问题）。
        const runOneSlice = (slice, c) => new Promise((resolve, reject) => {
          const outP = path.join(projDir(id), 'asr.chunk' + c.index + '.json');
          let sliceErr = '', sbuf = '';
          const ea = asrEngineArgs(model);
          const asrArgs = [ea.script, '--model', mdir, '--audio', slice,
                           '--out', outP, '--threads', '4', '--provider', ea.provider,
                           ...(ea.extra || []), ...ea.hotwords, ...ttaArgs(confMode)];
          const pr = spawn(ASR_PY, asrArgs,
            { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
          draftProcs.set(id, pr);
          const sink2 = (chunk) => {
            sbuf += String(chunk);
            let i;
            while ((i = sbuf.indexOf('\n')) >= 0) {
              const line = sbuf.slice(0, i).trim();
              sbuf = sbuf.slice(i + 1);
              if (!line) continue;
              const clean = line.replace(/\0/g, '').replace(/\x1b\[[0-9;]*m/g, '');
              if (!line.startsWith('{')) { if (clean.trim()) pushDraftLog(id, '[py] ' + clean); continue; }
              let o; try { o = JSON.parse(line); } catch { continue; }
              if (o.type === 'progress') {
                setDraft(id, {
                  stage: STAGE.asr,
                  progress: 30 + Math.round(((c.index + (Number(o.pct) || 0) / 100) / chunkPlan.length) * 45),
                  message: '第 ' + (c.index + 1) + '/' + chunkPlan.length + ' 片：' + (o.msg || ''),
                });
              } else if (o.type === 'log') {
                pushDraftLog(id, '[' + new Date().toLocaleTimeString() + '] ' + o.msg);
              } else if (o.type === 'error') {
                sliceErr = o.msg;
                pushDraftLog(id, '[错误] ' + o.msg);
              }
            }
          };
          pr.stderr.on('data', sink2);
          pr.stdout.on('data', sink2);
          pr.on('error', e => reject(new Error('无法启动识别进程（Python: ' + ASR_PY + '）: ' + e.message)));
          pr.on('close', (code) => {
            let parsed = null;
            try { parsed = JSON.parse(fs.readFileSync(outP, 'utf8')); } catch {}
            try { fs.unlinkSync(outP); } catch {}
            if (code !== 0) return reject(new Error(sliceErr || ('识别进程异常退出（' + asrExitHint(code) + '）')));
            if (!parsed) return reject(new Error('这一片的识别结果读不出来（' + outP + '）'));
            resolve(parsed);
          });
        });
        transcribeLocalChunked({
          id, wav, plan: chunkPlan, duration: durSec, engine: model.engine,
          silenceCount: chunkSilences.length, source: chunkSilences.length ? 'silence' : 'nominal',
          runOne: runOneSlice,
        }).then((r) => {
          try {
            fs.writeFileSync(outJson + '.tmp', JSON.stringify({ segments: r.segments }));
            fs.renameSync(outJson + '.tmp', outJson);
          } catch (e) { return finishDraft(id, e); }
          finishAsr();
        }).catch((e) => { draftJobs.delete(id); finishDraft(id, e); });
        return;
      }
      let lastErr = '', buf = '';
      const ea = asrEngineArgs(model);
      const asrArgs = [ea.script, '--model', mdir, '--audio', wav,
                       '--out', outJson, '--threads', '4', '--provider', ea.provider,
                       ...(ea.extra || []), ...ea.hotwords, ...ttaArgs(confMode)];
      const proc = spawn(ASR_PY, asrArgs,
        { windowsHide: true, cwd: ASR_DIR, env: pySpawnEnv() });
      draftProcs.set(id, proc);

      const sink = (chunk) => {
        buf += String(chunk);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          // 非 JSON 行(Python traceback / Store 占位提示 / onnxruntime C++ 报错)原样进日志;
          // 顺手清掉 UTF-16 残留的 \0 和 ANSI 颜色码(onnxruntime 的 C++ 输出混着来, 不清没法看)
          const clean = line.replace(/\0/g, '').replace(/\x1b\[[0-9;]*m/g, '');
          if (!line.startsWith('{')) { if (clean.trim()) pushDraftLog(id, `[py] ${clean}`); continue; }
          let o; try { o = JSON.parse(line); } catch { if (clean.trim()) pushDraftLog(id, `[py] ${clean}`); continue; }
          if (o.type === 'progress') {
            setDraft(id, { stage: STAGE.asr, progress: 30 + Math.round(o.pct * 0.55), message: o.msg });
          } else if (o.type === 'log') {
            pushDraftLog(id, `[${new Date().toLocaleTimeString()}] ${o.msg}`);
          } else if (o.type === 'error') {
            lastErr = o.msg;
            pushDraftLog(id, `[错误] ${o.msg}`);
          }
        }
      };
      proc.stderr.on('data', sink);
      proc.stdout.on('data', sink);
      proc.on('error', e => finishDraft(id, new Error('无法启动识别进程（Python: ' + ASR_PY + '）: ' + e.message)));
      proc.on('close', (code) => {
        if (code !== 0) { draftJobs.delete(id); return finishDraft(id, new Error(lastErr || ('识别进程异常退出（' + asrExitHint(code) + '）'))); }
        finishAsr();
      });
    });
  }

  /** 逐文件深删目录: 项目删除已由 UI 二次确认, 逐个 unlink 以兼容
   *  会拦截"批量递归删除"的 fs 代理环境(rmSync 递归整目录会被强制要求确认)。 */
  function rmDirDeep(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) rmDirDeep(p);
      else { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }
    fs.rmdirSync(dir);
  }

  /** 把选择器返回的原始文本规整成一个**真实存在**的路径。
   *  实测该对话框的返回值会带脏东西（用户报过 `...生肉.mp4` 后面粘上 `10000 46000000` 之类
   *  的杂物），而脏路径的典型表现就是「文件明明在，却报不存在」。这里做两层收尾：
   *  ① 去掉 BOM / NUL / 首尾空白；② 若整串不是已存在的文件，就从后往前找**存在的最长前缀**
   *  —— 只在真的命中磁盘上的文件时才采纳，所以不会凭空猜出一个错路径。
   *  目录不做前缀回溯（父目录必然存在，回溯会把用户选错成上级目录）。
   */
  function normalizePickedPath(raw, wantDir) {
    const s = String(raw || '').replace(/\uFEFF/g, '').replace(/\u0000/g, '').trim();
    if (!s) return null;
    const ok = (p) => {
      try { const st = fs.statSync(p); return wantDir ? st.isDirectory() : st.isFile(); }
      catch { return false; }
    };
    if (ok(s)) return s;
    if (wantDir) return null;
    for (let i = s.length - 1; i > 2; i--) {
      const cand = s.slice(0, i).replace(/[\s\u0000]+$/, '');
      if (cand.length > 2 && ok(cand)) return cand;
    }
    return null;
  }

  /** 原生「打开文件 / 选择文件夹」对话框(Windows PowerShell)。
   *
   *  结果经**临时文件**回传，不走 stdout —— 这是关键：PowerShell 的 stdout 会混入
   *  对话框自身的输出与编码差异（实测同一脚本换个启动方式就变成 UTF-16LE 带 BOM，
   *  Node 按 UTF-8 解出来是夹着 NUL 的乱码）。直接拼接 stdout 字符串就是这样坏掉的。
   */
  function nativePick(kind, cb) {
    const isFolder = kind === 'folder';
    const filter = kind === 'python'
      ? 'Python|python.exe|Executable|*.exe|All files|*.*'
      : (kind === 'audio'
        ? 'Audio/Video|*.wav;*.mp3;*.m4a;*.flac;*.mp4;*.mkv;*.mov;*.webm|All files|*.*'
        : (kind === 'video'
          ? 'Video|*.mp4;*.m4v;*.webm;*.mkv;*.avi;*.mov|All files|*.*'
          : 'Subtitle|*.srt;*.ass;*.ssa|All files|*.*'));
    const title = kind === 'python' ? '选择 Python 解释器（python.exe）'
      : (kind === 'audio' ? '选择测试用音频/视频'
        : (kind === 'video' ? 'Select video file' : 'Select subtitle file'));
    const tmp = path.join(os.tmpdir(), `kass-pick-${process.pid}-${Date.now().toString(36)}.txt`);
    const tmpPs = tmp.replace(/'/g, "''");
    const ps = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      // 只有 TopMost 不够: Windows 前台锁会阻止后台进程的窗口获得焦点/激活,
      // 实测对话框开在浏览器后面, 用户根本不知道已经弹出来了 —— 必须显式抢前台
      "Add-Type -Namespace Kass -Name FG -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' | Out-Null",
      '$form = New-Object System.Windows.Forms.Form',
      '$form.TopMost = $true',
      '$form.Opacity = 0',
      '$form.ShowInTaskbar = $false',
      isFolder ? '$d = New-Object System.Windows.Forms.FolderBrowserDialog'
               : '$d = New-Object System.Windows.Forms.OpenFileDialog',
      isFolder ? "$d.Description = '选择语音识别模型存放目录(必须为空目录)'"
               : `$d.Title = '${title}'`,
      isFolder ? '$d.ShowNewFolderButton = $true' : `$d.Filter = '${filter}'`,
      ...(isFolder ? [] : ['$d.CheckFileExists = $true']),
      '$null = $form.CreateControl()',                       // 确保句柄已创建, 否则 SetForegroundWindow 拿不到 Handle
      '$null = [Kass.FG]::SetForegroundWindow($form.Handle)',
      '$null = $form.Activate()',
      '$r = $d.ShowDialog($form)',
      `$p = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { ${isFolder ? '$d.SelectedPath' : '$d.FileName'} } else { '' }`,
      // 显式 UTF-8 无 BOM 写盘, 与 Node 侧的读取编码对齐
      `[System.IO.File]::WriteAllText('${tmpPs}', $p, (New-Object System.Text.UTF8Encoding($false)))`,
    ].join('; ');

    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
    let errText = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); cb(r); } };
    p.stdout.on('data', () => {});                     // 丢弃: 只看临时文件
    p.stderr.on('data', d => { if (errText.length < 1500) errText += String(d); });
    // **不能无限等**: 某些环境(服务/计划任务/无交互桌面会话)里 WinForms ShowDialog 永远不可见也不返回,
    // 用户视角就是"点浏览没反应"。35s 还没结果就按 cancelled 返回, 前端会自动降级到浏览器选文件。
    const timer = setTimeout(() => { try { p.kill(); } catch {} finish({ cancelled: true, fallback: true, error: '系统对话框未能打开（已超时）' }); }, 35 * 1000);
    p.on('error', () => {
      cleanup();
      finish({ cancelled: true, fallback: true, error: '无法打开系统对话框' });
    });
    p.on('close', () => {
      let raw = '';
      try { raw = fs.readFileSync(tmp, 'utf8'); } catch {}
      cleanup();
      if (!raw.trim() && errText.trim()) {
        return finish({ cancelled: true, fallback: true, error: '系统对话框出错: ' + errText.trim().slice(0, 300) });
      }
      if (!raw.trim()) return finish({ cancelled: true });
      const resolved = normalizePickedPath(raw, isFolder);
      if (!resolved) {
        return finish({ cancelled: true, error: '对话框返回的路径无法解析（' + raw.trim().slice(0, 200) + '）' });
      }
      if (kind === 'video') MEDIA_ALLOW.add(mediaKey(resolved));   // 用户亲手选的视频登记进 /api/media 白名单
      finish({ path: resolved, name: path.basename(resolved) });
    });
  }

  // ── 路由 ──
  if (pathname === '/api/pick' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let kind = 'video';
      try { kind = (JSON.parse(body.toString('utf8')) || {}).kind || 'video'; } catch {}
      nativePick(kind, r => sendJson(res, 200, r));   // 'video' | 'sub' | 'folder' 统一走一个实现
    });
  }

  /* ═══════════ 初稿 / 语音识别模型 ═══════════ */
/* 下载相关的设置路由: GET/POST /api/fetch/settings（Cookie 只写不读回） */
  if (pathname === '/api/fetch/settings' && req.method === 'GET') {
    return sendJson(res, 200, fetchPublicSettings());
  }
  /* 用已保存的 Cookie 检测登录态（打开设置面板时调一次） */
  if (pathname === '/api/fetch/check-cookie' && req.method === 'GET') {
    const f = fetchSettings();
    const ck = String(f.__biliCookiePlain || '');
    if (!ck) return sendJson(res, 200, { ok: false, isLogin: false, message: '还没有保存 Cookie' });
    biliLoginCheck(ck).then((c) => sendJson(res, 200, c))
      .catch((e) => sendJson(res, 200, { ok: false, isLogin: false, message: String((e && e.message) || e) }));
    return;
  }
  /* 只解析视频元数据（不下载）: 给「稿件预览」在创建项目前确认目标视频。
   * 复用下载内核的 --simulate（它把 meta 直接放进 done 事件里，不用读临时文件）。 */
  if (pathname === '/api/fetch/probe' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let d = {};
      try { d = JSON.parse(body.toString('utf8') || '{}') || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const url = normalizeFetchUrl(d.url);
      if (!url) return sendJson(res, 400, { error: '请先填视频链接' });
      const site = fetchSiteOf(url);
      if (!site) return sendJson(res, 400, { error: '只支持 bilibili 与 YouTube 链接（其他站点暂不支持）' });
      if (!fetchReady()) return sendJson(res, 400, { error: '下载内核不可用：需要一个 Python 3.8 或更高版本。到设置里安装内置 Python' });
      void (async () => {
        const f = fetchSettings();
        const part = normalizePart(d.part);
        const args = ['--url', url, '--out', os.tmpdir(), '--simulate'];
        if (part > 1) args.push('--part', String(part));
        if (f.proxy) args.push('--proxy', String(f.proxy));
        const ckPlain = String(f.__biliCookiePlain || f.biliCookie || '');
        if (ckPlain) {
          const ckFile = path.join(os.tmpdir(), 'sf-probe-cookies.txt');
          if (writeNetscapeCookieFile(ckPlain, ckFile)) args.push('--cookies-file', ckFile);
        } else if (f.cookiesFromBrowser) args.push('--cookies-from-browser', String(f.cookiesFromBrowser));
        // id 用 '__probe__': 只用于 fetchJobs 占位，pushDraftLog 写不进去会被静默吞掉
        const r = await runFetchCli('__probe__', args, () => {});
        if (r.error) return sendJson(res, 400, { error: r.error });
        const m = (r.done && r.done.meta) || null;
        if (!m || (!m.title && !m.id)) {
          return sendJson(res, 400, { error: '没解析到视频信息（检查链接、登录态或代理）' });
        }
        return sendJson(res, 200, { source: {
          url: m.url || url, site: m.source || site, id: m.id || '',
          title: m.title || '', description: m.description || '', uploader: m.uploader || '',
          duration: m.duration || 0, uploadDate: m.uploadDate || '', tags: m.tags || [],
          viewCount: m.viewCount || 0, thumbnail: m.thumbnail || '', height: m.height || 0,
        } });
      })().catch((e) => {
        try { sendJson(res, 500, { error: '解析失败: ' + String((e && e.message) || e) }); } catch {}
      });
    });
  }
  if (pathname === '/api/fetch/settings' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, async (err, body) => {
      try {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let d = null;
      try { d = JSON.parse(body.toString('utf8') || '{}') || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const patch = {};
      if (d.quality !== undefined) patch.quality = String(d.quality || 'best');
      if (d.proxy !== undefined) patch.proxy = String(d.proxy || '').trim();
      if (d.cookiesFromBrowser !== undefined) patch.cookiesFromBrowser = String(d.cookiesFromBrowser || '').trim();
      let newCookie = '';
      let cookieFixed = false;
      if (d.biliCookie !== undefined) {
        const rawIn = String(d.biliCookie || '').trim();        // 空字符串 = 清除
        newCookie = normalizeBiliCookie(rawIn);
        cookieFixed = !!rawIn && rawIn !== newCookie;           // 只贴了值 → 补成 SESSDATA=
        try { patch.biliCookieEnc = newCookie ? secretStore.encrypt(newCookie) : ''; }
        catch (e) { return sendJson(res, 500, { error: 'Cookie 加密失败: ' + ((e && e.message) || e) }); }
        patch.biliCookie = '';                                  // ★ 明文绝不落盘
        patch.biliCookieSavedAt = newCookie ? new Date().toISOString() : '';
      }
      patchFetchSettings(patch);
      const out = fetchPublicSettings();
      if (d.biliCookie !== undefined) {
        out.cookieFixed = cookieFixed;
        out.check = newCookie ? await biliLoginCheck(newCookie) : null;   // 存完立刻验证能不能登录
      }
      return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
    });
  }

  if (pathname === '/api/asr/status' && req.method === 'GET') {
    // 预热预检缓存。**必须按当前所选引擎探** —— 写死 probePython()（=sherpa）时，
    // 选的是 NPU 引擎就永远拿不到 openvino 的探测结果，界面会一直停在检测中…（实测踩过）。
    const _selForProbe = modelById(selectedModelId()) || resolveAsrModel();
    probePython(_selForProbe && _selForProbe.engine).catch(() => {});
    nvidiaGpu().catch(() => {});            // 后台探测 N 卡(缓存 5 分钟)
    probeNemo().catch(() => {});            // 后台预检 NeMo 运行时(仅 multitalker 需要; 缓存 5 分钟)
    let pythonOk = false;
    try { pythonOk = fs.statSync(ASR_PY).isFile(); } catch {}
    const nemo = nemoProbeCache || { ok: false, cuda: false, msg: '预检中…' };
    const models = ASR_MODELS.map(m => {
      // 云端模型没有本地文件: dir/missing/ready 都得走另一套判定, 否则会被显示成"未下载"
      const dir = m.cloud ? '' : modelDirFor(m.id);
      const missing = m.cloud ? [] : missingModelFiles(dir, m);
      const filesOk = m.cloud ? true : (!missing.length && modelFilesOk(dir, m));
      const ready = filesOk && (m.engine !== 'whisper.cpp' || whisperRuntimeOk());
      // usable: 文件齐 + 该引擎的运行时都就位(NeMo 模型还要 torch/NeMo + CUDA) —— 重新识别下拉按它标记"可用"
      const usable = ready && (m.engine !== 'nemo' || (nemo.ok && nemo.cuda));
      return {
        id: m.id, name: m.name, engine: m.engine, desc: m.desc, sizeMB: m.sizeMB,
        dir, missing, ready, usable, cloud: !!m.cloud,
        draftAllowed: draftAllowedOf(m),
        needRuntime: m.engine === 'whisper.cpp' && !whisperRuntimeOk(),
        needNemo: m.engine === 'nemo' && !(nemo.ok && nemo.cuda),
      };
    });
    /* ⚠ 下面整段包在 async IIFE 里，只为了 `await nvidiaGpu()` 一个字段。
     *   原来的写法是直接读 `nvidiaCache.name`（后台探测的缓存）：服务器刚起来时缓存是空的，
     *   于是第一次查状态就回 gpu:null —— 前端把 null 当成"没有 N 卡"，给 Multitalker 卡打上
     *   「只支持 N 卡。当前没检测到 N 卡，无法下载」的**误报**（用户实测撞到过）。
     *   改成等这次探测完再回：nvidia-smi 毫秒级 + 8 秒超时，比 NeMo 那种要导入 torch 的 30 秒轻得多。
     *   现在 gpu:null 只有一种含义了：真的没有 N 卡。 */
    return (async () => sendJson(res, 200, {
      models,
      selectedModel: selectedModelId(),
      rerecogModel: rerecogModelId(),        // 「重新识别模型」设置(空 = 沿用项目原有模型)
      // 逐句置信度的全局默认（设置页开关用；项目级覆盖见 project.json 的 draft.confidence）
      confidence: { mode: asrConfidenceDefault(), tta: CONFIDENCE_TTA, modes: CONFIDENCE_MODES },
      nemo: {                                // NeMo 运行时(仅 multitalker 模型需要)
        ok: !!nemo.ok, cuda: !!nemo.cuda, gpu: nemo.gpu || '', torch: nemo.torch || '', nemoVer: nemo.nemo || '',
        msg: nemo.msg || '', script: NEMO_SCRIPT, install: NEMO_NOTE,
      },
      runtime: { ok: whisperRuntimeOk(), dir: WHISPER_RUNTIME.dir, url: WHISPER_RUNTIME.url, sizeMB: WHISPER_RUNTIME.sizeMB },
      diarize: { ready: diarizeReady(), models: DIARIZE_MODELS },
      // 兼容旧前端字段
      ready: models.some(m => m.ready),
      // pythonProbe 现在按引擎分键（{sherpa:{…}, openvino:{…}}）。旧前端读的是 .ok/.msg，
      // 于是永远拿到 undefined 并判成"环境不可用"（实测踩过）。这里把**当前所选引擎**的
      // 结果同时扁平暴露，新旧前端都能正确显示。
      pythonProbeFlat: (() => {
        const sel = modelById(selectedModelId()) || resolveAsrModel();
        const key = (sel && sel.engine === 'openvino') ? 'openvino' : 'sherpa';
        const r = pyProbeCache && pyProbeCache[key];
        return r ? { ok: !!r.ok, msg: r.msg || '', engine: key, at: r.at } : null;
      })(),
      python: ASR_PY, pythonOk,
      // Python 环境预检(结果缓存 5 分钟; 触发后台探测, 下次轮询就有)
      pythonProbe: pyProbeCache,
      provider: asrProvider(),              // Parakeet 推理设备: 'cpu' | 'cuda'
      /* ⚠ 这里原来直接读 `nvidiaCache.name`（后台探测的缓存）。
       *   服务器刚起来时缓存还是空的，于是第一次查状态就返回 gpu:null ——
       *   前端把 null 当成"没有 N 卡"，给 Multitalker 卡打上
       *   「只支持 N 卡。当前没检测到 N 卡，无法下载」的**误报**（用户实测撞到过）。
       *   改成**等这次探测完**再回：nvidia-smi 是毫秒级 + 8 秒超时，
       *   比 NeMo 那种要导入 torch 的 30 秒轻得多，等得起。
       *   现在 gpu:null 只有一种含义了：真的没有 N 卡。 */
      gpu: await nvidiaGpu().catch(() => null),
      /* gpu 为空到底是"没 N 卡"还是"还没探测"—— 告诉前端这个信号，
       * 免得它在探测期间误报"没检测到 N 卡"。
       * 走到这里时 nvidiaGpu() 已经 await 过了；只有它超时/null 才会是空，
       * 而 5 分钟内再次查询命中缓存，所以 pending 基本只在"探测失败"时为真。 */
      gpuPending: !nvidiaCache.name && (Date.now() - nvidiaCache.at) < 9000,
      // 并行下载: Map → 数组(每项含 key), 前端按 key 匹配各自的进度
      downloads: Array.from(downloads.entries()).map(([key, v]) => Object.assign({ key }, v)),
      // 兼容旧前端: 单任务时代的字段(任意一个在跑就给它的状态)
      download: (() => { for (const v of downloads.values()) if (v.running) return v; return { running: false, kind: '', pct: 0, msg: '', error: null }; })(),
      modelsRoot: modelsRoot(),
      settingsDir: ASR_DIR,
    }))();
  }
  /** 安装 NeMo 运行时（仅 multitalker 模型需要）: 在 ASR Python 环境里追加 PyTorch + NeMo。
   *  与 sherpa-onnx 环境是**两套依赖**（约 200MB vs 约 5GB），所以单独装、单独报进度（downloads key='nemo'）。
   *  必须 N 卡: multitalker 只认 CUDA, 装到 CPU 版 torch 上等于白装, 这里直接拦。 */
  /* 指定 Python 解释器：给"运行时装在别处"用（例如复用另一份安装里的 torch+NeMo）。
   * 传空串 = 恢复默认（自带的 runtime-python / asr/.venv）。 */
  if (pathname === '/api/asr/set-python' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let p = '';
      try { p = String((JSON.parse(body.toString('utf8')) || {}).exe || '').trim(); } catch {}
      if (p) {
        try {
          if (!fs.statSync(p).isFile()) return sendJson(res, 400, { error: '不是一个文件：' + p });
        } catch { return sendJson(res, 400, { error: '找不到这个解释器：' + p }); }
      }
      const s = readAsrSettings();
      if (p) s.pythonExe = p; else delete s.pythonExe;
      writeAsrSettings(s);
      ASR_PY = resolvePython();
      // 解释器换了 → 所有预检结果作废
      pyProbeCache = null;
      pyProbeInflight = null;
      nemoProbeCache = null;
      nemoProbeInflight = null;
      // 同样按所选引擎探：否则换完解释器界面还停在检测中…
      const _sel2 = modelById(selectedModelId()) || resolveAsrModel();
      probePython(_sel2 && _sel2.engine).catch(() => {});
      probeNemo(true).catch(() => {});      // probeNemo 只接受 force 一个参数
      return sendJson(res, 200, { ok: true, python: ASR_PY });
    });
  }
  if (pathname === '/api/asr/install-nemo' && req.method === 'POST') {
    return void (async () => {
      const pyOk = (() => { try { return fs.statSync(ASR_PY).isFile(); } catch { return false; } })();
      if (!pyOk) {
        return sendJson(res, 400, { error: '还没有 Python 环境。先在上面「Python 环境」点「安装」，NeMo 运行时是在它之上再加 PyTorch 和 NeMo' });
      }
      const gpu = await nvidiaGpu().catch(() => null);      // 探测带 5 分钟缓存, 没有缓存时现测一次
      if (!gpu) return sendJson(res, 400, { error: 'NeMo 多说话人模型只能在 NVIDIA 显卡（N 卡）上跑，这台机器没检测到 NVIDIA 显卡，不支持 CPU，装不了也用不了' });
      if (dlState('nemo').running) return sendJson(res, 200, { started: true, already: true });
      startNemoInstall();
      return sendJson(res, 200, { started: true });
    })();
  }
  /* 长稿反思纠错：配置读写（全局设置页用）。
   * GET  → { mode, padSec, maxSec, batchLines, useTranslate, provider, baseUrl, model, hasKey, ready, presets }
   * POST → 局部更新，写进 asr/settings.json 的 correct 段。
   * 「用哪个模型」默认跟随字幕翻译；要单独指向**本地部署**（如 Qwen3 量化版起
   * OpenAI 兼容服务）就在设置页填自己的 baseUrl/model —— 本机地址免 API Key。 */
  if (pathname === '/api/asr/correct' && (req.method === 'GET' || req.method === 'POST')) {
    const view = () => {
      const raw = (readAsrSettings().correct) || {};
      const cfg = correctCfg();
      const base = translateCfg();
      // 显式开关（旧配置回退到"有没有自定义地址"的推断，见 correctUseTranslate）
      const useTranslate = correctUseTranslate(raw);
      return {
        mode: cfg.mode,
        // 预览时前后各留多少秒 / 单段上限 —— 直接决定"要重识别多少音频"
        padSec: Number.isFinite(Number(raw.padSec)) ? Number(raw.padSec) : reflectMod.PAD_SEC,
        maxSec: Number.isFinite(Number(raw.maxSec)) ? Number(raw.maxSec) : reflectMod.MAX_REGION_SEC,
        batchLines: cfg.batchLines,
        useTranslate,
        provider: String(raw.provider || ''),
        baseUrl: String(raw.baseUrl || ''),
        model: String(raw.model || ''),
        hasKey: !!String(raw.apiKey || '').trim() || !!(useTranslate && base.apiKey),
        // 最终会用的模型（跟随翻译时显示翻译的模型名，用户才知道真正调的是谁）
        effectiveModel: cfg.model,
        effectiveBaseUrl: cfg.baseUrl,
        ready: correctReady(cfg),
        presets: LLM_PRESETS.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, local: !!p.local })),
      };
    };
    if (req.method === 'GET') return sendJson(res, 200, view());
    return readBody(req, res, 16 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let p;
      try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const s = readAsrSettings();
      const cur = Object.assign({}, s.correct);
      if (p.mode !== undefined) {
        if (!['off', 'preview', 'auto'].includes(p.mode)) return sendJson(res, 400, { error: 'mode 必须是 off / preview / auto' });
        cur.mode = p.mode;
      }
      if (p.padSec !== undefined) cur.padSec = Math.max(0, Math.min(15, Number(p.padSec) || 0));
      if (p.maxSec !== undefined) cur.maxSec = Math.max(3, Math.min(120, Number(p.maxSec) || 0));
      if (p.batchLines !== undefined) cur.batchLines = Math.max(20, Math.min(200, parseInt(p.batchLines, 10) || 0));
      if (p.provider !== undefined) cur.provider = String(p.provider || '').trim();
      if (p.baseUrl !== undefined) cur.baseUrl = String(p.baseUrl || '').trim();
      if (p.model !== undefined) cur.model = String(p.model || '').trim();
      if (p.apiKey !== undefined) cur.apiKey = String(p.apiKey || '').trim();
      /* 「跟随字幕翻译的模型」是**显式开关**，不是靠空值推断。
       * 早期只处理 `=== true`，于是前端的 `useTranslate:false` 被完全忽略 ——
       * 用户取消勾选后，服务端仍按"地址为空 ⇒ 跟随翻译"算回去，勾选框被回弹、
       * **根本取消不掉**（实测复现）。现在 true/false 都记下来。
       *
       * 关掉时**不清空**已填的地址/模型：用户可能只是切过去看一眼再切回来，
       * 清空会让他重填一遍（原本清空是为了让"跟随翻译"立即生效，现在有显式开关就不需要了）。 */
      if (p.useTranslate !== undefined) cur.useTranslate = p.useTranslate === true;
      s.correct = cur;
      try { writeAsrSettings(s); } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
      console.log('[asr] 纠错配置已更新：mode=' + (cur.mode || 'preview')
        + ' 模型=' + correctCfg().model + ' 就绪=' + correctReady(correctCfg()));
      return sendJson(res, 200, Object.assign({ ok: true }, view()));
    });
  }

  /* 逐句置信度：三档 off / fast / full。
   * GET  → { mode, tta, modes }（没设置过 = full）
   * POST → { mode: 'off'|'fast'|'full' }；也兼容早期的 { enabled: bool }
   * 只影响**以后**的初稿/重新识别；已有稿子的置信度已经写进 ASS，不受影响。 */
  if (pathname === '/api/asr/confidence' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        mode: asrConfidenceDefault(), tta: CONFIDENCE_TTA, modes: CONFIDENCE_MODES,
      });
    }
    return readBody(req, res, 8 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let j;
      try { j = JSON.parse(body.toString('utf8')) || {}; }
      catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      // 兼容：早期前端发的是 { enabled: true/false }
      let mode = j.mode;
      if (mode === undefined && typeof j.enabled === 'boolean') mode = j.enabled ? 'full' : 'off';
      if (!CONFIDENCE_MODES.includes(mode)) {
        return sendJson(res, 400, { error: 'mode 必须是 off / fast / full 之一' });
      }
      const s = readAsrSettings();
      // 只留 mode 一个字段：早期写过的 enabled 一并清掉，避免两个来源打架
      s.confidence = { mode };
      try { writeAsrSettings(s); } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
      const desc = { off: '关闭（不生成置信度，识别最快）',
                     fast: '快速（只用词级概率+音频质量，不做稳定性重跑）',
                     full: '完整（含稳定性重跑 ' + CONFIDENCE_TTA + ' 遍，约慢一倍）' }[mode];
      console.log('[asr] 逐句置信度 = ' + mode + ' —— ' + desc);
      return sendJson(res, 200, { ok: true, mode, tta: CONFIDENCE_TTA });
    });
  }
  /** 校验用户选的目录能否用来放模型: 必须存在、且是空目录 */
  if (pathname === '/api/asr/check-dir' && req.method === 'POST') {    return readBody(req, res, 64 * 1024, (err, body) => {
      let p = '';
      try { p = String((JSON.parse(body.toString('utf8')) || {}).dir || '').trim(); }
      catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      if (!p) return sendJson(res, 200, { ok: false, empty: false, reason: '未选择目录' });
      let st = null;
      try { st = fs.statSync(p); } catch { return sendJson(res, 200, { ok: false, empty: false, reason: '目录不存在或无法访问' }); }
      if (!st.isDirectory()) return sendJson(res, 200, { ok: false, empty: false, reason: '选择的不是目录' });
      let names = [];
      try { names = fs.readdirSync(p); } catch { return sendJson(res, 200, { ok: false, empty: false, reason: '无法读取目录内容' }); }
      const empty = names.length === 0;
      return sendJson(res, 200, { ok: empty, empty, count: names.length,
        reason: empty ? '' : `这个目录不是空的（已有 ${names.length} 项），换一个空目录` });
    });
  }
  /** 下载识别模型(带 modelId)或 whisper.cpp 运行时(kind='runtime')。
   *  并行友好: 不同 modelId/kind 的任务各自独立跑, 重复点同一个任务会被幂等忽略。 */
  if (pathname === '/api/asr/download' && req.method === 'POST') {
    /* 回调改成 **async** —— 只为了下面能 `await nvidiaGpu()`（见那里的注释：读缓存会误拦下载）。 */
    return readBody(req, res, 64 * 1024, async (err, body) => {
      let p = {}, modelId = '', kind = 'model';
      try {
        const j = JSON.parse(body.toString('utf8')) || {};
        p = String(j.dir || '').trim(); modelId = String(j.modelId || '').trim(); kind = j.kind || 'model';
      } catch {}
      if (kind === 'runtime') {
        if (whisperRuntimeOk()) return sendJson(res, 200, { started: false, ready: true });
        if (dlState('runtime').running) return sendJson(res, 200, { started: true, kind: 'runtime', already: true });
        startRuntimeDownload();
        return sendJson(res, 200, { started: true, kind: 'runtime' });
      }
      if (kind === 'diarize') {
        if (diarizeReady()) return sendJson(res, 200, { started: false, ready: true });
        if (dlState('diarize').running) return sendJson(res, 200, { started: true, kind: 'diarize', already: true });
        startDiarizeDownload();
        return sendJson(res, 200, { started: true, kind: 'diarize' });
      }
      if (kind === 'pyenv') {
        if (dlState('pyenv').running) return sendJson(res, 200, { started: true, kind: 'pyenv', already: true });
        startPyEnvSetup();
        return sendJson(res, 200, { started: true, kind: 'pyenv' });
      }
      const model = modelById(modelId) || resolveAsrModel() || ASR_MODELS[0];
      if (!model) return sendJson(res, 400, { error: '未知模型' });
      // 云端模型没有文件可下(它的 dirName 是空串, 不拦的话会把模型根目录当成本模型目录"采纳")
      if (model.cloud) return sendJson(res, 400, { error: '「' + model.name + '」是云端识别，不用下载模型，直接用' });
      // Parakeet 连下载都拦: 它只能 CUDA GPU 推理, 无 N 卡机器下了也用不了, 不浪费 661MB。
      // NeMo(multitalker) 同理, 而且还要额外的 PyTorch+NeMo 运行时 —— 没 N 卡别下 2.3GB。
      if (model.engine === 'sherpa-onnx' && asrProvider() !== 'cuda') {
        return sendJson(res, 400, { error: 'Parakeet 需要 CUDA GPU（N 卡），不支持 CPU。当前环境没启用 GPU·CUDA，先在「Python 环境」装好（需 N 卡）再下载' });
      }
      /* ⚠ 这里以前是 `nvidiaGpu().catch(()=>{})` 打后台 + 紧接着读 `nvidiaCache.name` ——
       *   冷启动后**第一次**点下载时缓存还是空的，于是明明是 N 卡机器也会被回一句
       *   「这台机器没检测到 NVIDIA 显卡…不能下载」拦下来（与列表卡那次误报同源）。
       *   改成 await：nvidia-smi 毫秒级 + 8 秒超时，在用户点「下载」这个节骨眼上等得起。 */
      const gpuNameForDl = await nvidiaGpu().catch(() => null);
      if (model.engine === 'nemo' && !gpuNameForDl) {
        return sendJson(res, 400, { error: '「' + model.name + '」只支持 N 卡（NVIDIA 显卡）。这台机器没检测到 NVIDIA 显卡，该模型不支持 CPU，不能下载' });
      }
      const key = 'model:' + model.id;
      // 未指定目录 → 模型根目录(modelsRoot 可被用户指定)下的 <dirName>
      if (!p) p = path.join(modelsRoot(), model.dirName);
      // 目录里已经有完整模型(文件齐且大小达标) → 直接采纳, 不用重下
      if (modelFilesOk(p, model)) {
        const s = readAsrSettings();
        s.models = Object.assign({}, s.models || {}, { [model.id]: p });
        writeAsrSettings(s);
        return sendJson(res, 200, { started: false, ready: true, dir: p });
      }
      if (dlState(key).running) return sendJson(res, 200, { started: true, dir: p, modelId: model.id, already: true });
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      // 「目录必须为空」曾挡死重试: 上次下载中途失败留下的不完整文件让重试永远 400。
      // 现在只拒绝**无关文件** —— 目录里是本模型的(可能不完整的)文件/临时文件就放行,
      // downloadFile 会按 Range 从断点续传, 不会重头下。
      const foreign = names.filter(n =>
        !model.files.some(f =>
          n.toLowerCase() === f.toLowerCase() ||
          n.toLowerCase() === (f + '.dl').toLowerCase() ||
          /\.(dl|tmp|part|crdownload)$/i.test(n)));
      if (foreign.length) {
        return sendJson(res, 400, { error: `目录里有无关文件（${foreign.slice(0, 3).join('、')}${foreign.length > 3 ? ' 等' : ''}）。请换一个空目录，或删掉这些文件后重试` });
      }
      startModelDownload(model, p);
      return sendJson(res, 200, { started: true, dir: p, modelId: model.id });
    });
  }
  /** 指定模型下载根目录(空串 = 恢复默认 asr/models) */
  if (pathname === '/api/asr/set-dir' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let p;
      try { p = String((JSON.parse(body.toString('utf8')) || {}).dir || '').trim(); } catch { p = ''; }
      const s = readAsrSettings();
      if (p) {
        let st = null;
        try { st = fs.statSync(p); } catch {}
        if (!st || !st.isDirectory()) {
          // 目录不存在就尝试创建(用户可能直接填了一个还不存在的路径)
          try { fs.mkdirSync(p, { recursive: true }); } catch { return sendJson(res, 400, { error: '目录无法创建: ' + p }); }
        }
        s.modelsRoot = p;
      } else {
        delete s.modelsRoot;      // 恢复默认
      }
      writeAsrSettings(s);
      return sendJson(res, 200, { ok: true, modelsRoot: modelsRoot() });
    });
  }
  /** 用资源管理器打开模型目录(打开下载位置/排查模型文件) */
  if (pathname === '/api/asr/open-dir' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let which = 'models';
      try { which = String((JSON.parse(body.toString('utf8')) || {}).which || 'models'); } catch {}
      let dir = modelsRoot();
      if (which === 'runtime') dir = WHISPER_RUNTIME.dir;
      else if (which === 'settings') dir = ASR_DIR;
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      let ok = false;
      try {
        const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        ok = true;
      } catch {}
      return sendJson(res, 200, { ok, dir });
    });
  }
  /** 删除一个模型(连同目录) */
  if (pathname === '/api/asr/delete' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let modelId = '';
      try { modelId = String((JSON.parse(body.toString('utf8')) || {}).modelId || ''); } catch {}
      const m = modelById(modelId);
      if (!m) return sendJson(res, 400, { error: '未知模型' });
      // 云端模型没有本地文件 —— 而且 modelDirFor 会返回模型根目录本身, 真删下去会清空整个 models!
      if (m.cloud) return sendJson(res, 400, { error: '「' + m.name + '」是云端识别，本地没有模型文件可删' });
      const dir = modelDirFor(m.id);
      if (dir && dir.startsWith(modelsRoot()) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      const s = readAsrSettings();
      if (s.models) delete s.models[m.id];
      writeAsrSettings(s);
      return sendJson(res, 200, { deleted: true, id: m.id });
    });
  }
  /** 选择创建初稿用的模型 */
  if (pathname === '/api/asr/select' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let modelId = '';
      try { modelId = String((JSON.parse(body.toString('utf8')) || {}).modelId || ''); } catch {}
      const m = modelById(modelId);
      if (!m) return sendJson(res, 400, { error: '未知模型' });
      // 只能重新识别的模型不能当"创建初稿默认模型" —— 用「重新识别模型」下拉来选它
      if (!draftAllowedOf(m)) {
        return sendJson(res, 400, { error: '「' + m.name + '」只能用于重新识别，不能创建初稿。重新识别要用它，就在上面「重新识别模型」里选' });
      }
      setSelectedModel(m.id);
      return sendJson(res, 200, { selected: m.id });
    });
  }
  /** 选择「重新识别」用的模型(可指向任意模型, 含只能重新识别的 multitalker) */
  if (pathname === '/api/asr/select-rerecog' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      let modelId = '';
      try { modelId = String((JSON.parse(body.toString('utf8')) || {}).modelId || ''); } catch {}
      if (modelId && !modelById(modelId)) return sendJson(res, 400, { error: '未知模型' });
      setRerecogModel(modelId);      // 空串 = 恢复"沿用项目原有模型"
      return sendJson(res, 200, { rerecogModel: rerecogModelId() });
    });
  }

  /* ═══════════ 翻译(LLM) 配置 ═══════════ */
  if (pathname === '/api/translate/config' && req.method === 'GET') {
    const c = translateCfg();
    return sendJson(res, 200, {
      presets: LLM_PRESETS, cfg: translateCfgPublic(c), ready: llmReady(c), defaultPrompt: DEFAULT_TRANSLATE_PROMPT,
    });
  }
  if (pathname === '/api/translate/config' && req.method === 'POST') {
    return readBody(req, res, 256 * 1024, (err, body) => {
      let p = {};
      try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const keep = {};
      for (const k of ['provider', 'baseUrl', 'apiKey', 'apiKeyClear', 'model', 'autoTranslate', 'prompt', 'glossary', 'glossaryLang', 'batchSize']) {
        if (Object.prototype.hasOwnProperty.call(p, k)) keep[k] = p[k];
      }
      const c = saveTranslateCfg(keep);
      return sendJson(res, 200, { cfg: translateCfgPublic(c), ready: llmReady(c) });
    });
  }
  /* 识别提示词 / 热词: 存 asr/settings.json 的 asr 段 */
  /* LLM 分角色开关 + 角色分析提示词（asr/settings.json 的 cast 段; enabled 默认开）
   * prompt 留空 = 用 cast.js 内置的 CAST_SYSTEM，GET 一并把内置文案给前端做占位。 */
  if (pathname === '/api/cast/config' && req.method === 'GET') {
    let on = true, prompt = '';
    try { const c0 = readAsrSettings().cast || {}; on = c0.enabled !== false; prompt = String(c0.prompt || ''); } catch {}
    const c = translateCfg();
    return sendJson(res, 200, {
      enabled: on, prompt, defaultPrompt: cast.DEFAULT_CAST_PROMPT,
      llmReady: llmReady(c), model: c.model || '', baseUrl: c.baseUrl || '',
    });
  }
  if (pathname === '/api/cast/config' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let d = null;
      try { d = JSON.parse(body.toString('utf8') || '{}') || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      try {
        const st = readAsrSettings();
        const patch = { enabled: d.enabled !== false };
        if (Object.prototype.hasOwnProperty.call(d, 'prompt')) patch.prompt = String(d.prompt || '').slice(0, 8000);
        st.cast = Object.assign({}, st.cast || {}, patch);
        writeAsrSettings(st);
      } catch (e) { return sendJson(res, 500, { error: '保存失败: ' + e.message }); }
      let on = true, prompt = '';
      try { const c0 = readAsrSettings().cast || {}; on = c0.enabled !== false; prompt = String(c0.prompt || ''); } catch {}
      return sendJson(res, 200, { enabled: on, prompt });
    });
  }
  if (pathname === '/api/asr/hint') {
    // GET 顺带返回实际会喂给引擎的词(用户填的 + 术语表原文列自动派生的), 便于核对
    if (req.method === 'GET') return sendJson(res, 200, Object.assign({ hint: asrHintCfg() }, asrTerms()));
    if (req.method === 'POST') {
      return readBody(req, res, 256 * 1024, (err, body) => {
        let p = {};
        try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const keep = {};
        for (const k of ['prompt', 'hotwordsScore']) if (Object.prototype.hasOwnProperty.call(p, k)) keep[k] = p[k];
        return sendJson(res, 200, { hint: saveAsrHint(keep) });
      });
    }
    return sendJson(res, 405, { error: '仅支持 GET / POST' });
  }

  /* 热词分析的模型配置（全局设置里选）—— 存 asr/settings.json 的 analyze 段。
   * 默认跟随翻译配置；想单独用别的模型（典型：翻译用在线、分析用本地 Qwen）就关掉跟随。
   * GET 顺带把 LLM_PRESETS 给前端填下拉框，并把"跟随翻译时实际会用哪个模型"讲清楚。 */
  if (pathname === '/api/analyze/config' && req.method === 'GET') {
    const c = analyzeCfg();
    const t = translateCfg();
    return sendJson(res, 200, {
      presets: LLM_PRESETS,
      cfg: translateCfgPublic(c),
      ready: analyzeReady(c),
      useTranslate: !!c.useTranslate,
      translate: { provider: t.provider, baseUrl: t.baseUrl, model: t.model, ready: llmReady(t) },
      hasKey: !!c.apiKey,
      limits: { maxEdits: c.maxEdits, maxTokens: c.maxTokens },
    });
  }
  if (pathname === '/api/analyze/config' && req.method === 'POST') {
    return readBody(req, res, 256 * 1024, (err, body) => {
      if (err) return sendJson(res, 413, { error: '请求体过大' });
      let p = {};
      try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const keep = {};
      for (const k of ['provider', 'baseUrl', 'apiKey', 'apiKeyClear', 'model', 'useTranslate', 'maxEdits']) {
        if (Object.prototype.hasOwnProperty.call(p, k)) keep[k] = p[k];
      }
      const c = saveAnalyzeCfg(keep);
      return sendJson(res, 200, { cfg: translateCfgPublic(c), ready: analyzeReady(c), useTranslate: !!c.useTranslate });
    });
  }

  /* 从操作日志挖 ASR 热词候选 —— 用户把 A 改成 B，就是"B 才是对的词"的弱标注。
   * 把 B 喂回 ASR 当热词，下一份稿子就不会再听错（越用越准的闭环）。
   *
   * GET  /api/projects/:id/hotword-candidates
   *        → { candidates:[{term,count,edits,samples,lastAt,score}], stats, current:[已有热词] }
   * POST /api/projects/:id/hotword-candidates  { selected:[词] }
   *        → 把选中的词**追加**进识别提示词（不覆盖用户已有的），返回新的热词表
   *
   * 注意：**只加不减**。用户手动删掉的词不会被这里重新加回来 —— 因为
   * 挖矿结果先给用户勾选，勾了才写；没勾的不会动。
   */
  const mHot = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/hotword-candidates$/.exec(pathname);
  if (mHot) {
    const pid = mHot[1];
    if (!fs.existsSync(projDir(pid))) return sendJson(res, 404, { error: '项目不存在' });

    if (req.method === 'GET') {
      const cur = asrTerms();
      const entries = readOpLog(pid);
      const r = hotwordsMod.mineHotwords(entries, { exclude: cur.terms });
      const wantLlm = /[?&]llm=1\b/.test(req.url || '');
      const base = {
        candidates: r.candidates,
        stats: r.stats,
        current: { terms: cur.terms, score: cur.score },
      };
      if (!wantLlm) {
        const c = analyzeCfg();
        return sendJson(res, 200, Object.assign(base, {
          llm: { requested: false, ready: analyzeReady(c), model: c.model, useTranslate: !!c.useTranslate },
        }));
      }
      /* ── LLM 分析（可选）──
       * 规则挖出来的候选先照常返回，LLM 的部分单独放在 llmTerms 里 ——
       * 这样模型挂了也不会连规则的结果一起丢掉。
       * ⚠ handleRequest 是同步函数，这里用 IIFE 包一层异步（与其它异步路由同一套路）。 */
      const cfgA = analyzeCfg();
      (async () => {
        try {
          const llm = await analyzeHotwordsWithLlm(r.edits || []);
          sendJson(res, 200, Object.assign(base, {
            llmTerms: llm.terms,
            llm: { requested: true, ok: true, sent: llm.sent, model: llm.model, viaTranslate: llm.viaTranslate },
          }));
        } catch (e) {
          sendJson(res, 200, Object.assign(base, {
            llmTerms: [],
            llm: {
              requested: true, ok: false,
              code: e.code || 'error',
              error: String((e && e.message) || e).slice(0, 300),
              ready: analyzeReady(cfgA), model: cfgA.model, useTranslate: !!cfgA.useTranslate,
            },
          }));
        }
      })();
      return;
    }

    if (req.method === 'POST') {
      return readBody(req, res, 256 * 1024, (err, body) => {
        if (err) return sendJson(res, 413, { error: '请求体过大' });
        let p = {};
        try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const picked = Array.isArray(p.selected) ? p.selected : [];
        if (!picked.length) return sendJson(res, 400, { error: '没有选中任何热词' });

        const cur = asrTerms();
        const seen = new Set(cur.terms.map(t => String(t).toLowerCase()));
        const added = [];
        for (const raw of picked) {
          const w = String(raw == null ? '' : raw).trim();
          if (!w) continue;
          if (seen.has(w.toLowerCase())) continue;
          seen.add(w.toLowerCase());
          added.push(w);
        }
        if (!added.length) {
          return sendJson(res, 200, { added: [], terms: cur.terms, note: '选中的词都已经在热词表里了' });
        }
        /* 写进 prompt（逗号分隔）—— 它与术语表「原文」列一起会被 asrTerms() 汇总。
         * ⚠ 保留用户原有的写法与顺序：只在末尾追加，不做任何重排。 */
        const oldPrompt = String(asrHintCfg().prompt || '').trim();
        const nextPrompt = oldPrompt ? (oldPrompt.replace(/[,\s]+$/, '') + ', ' + added.join(', ')) : added.join(', ');
        const hint = saveAsrHint({ prompt: nextPrompt });
        appendOpLog(pid, {
          action: 'hotwords',
          target: `${added.length} 个词`,
          detail: `从操作日志挖出的热词已加入：${added.join(', ')}`,
          why: '你在字幕里把这些词改对过，加进热词表后下次识别不会再听错',
        });
        const after = asrTerms();
        return sendJson(res, 200, { added, hint, terms: after.terms, score: after.score });
      });
    }
    return sendJson(res, 405, { error: '仅支持 GET / POST' });
  }

  /* 双引擎分工比例：供「识别模型」页的下拉读写。
   * ratio='auto' 时用性能测试测出的值（settings.dual），没测过就退 1:1。 */
  if (pathname === '/api/asr/dual' && req.method === 'GET') {
    const s = readAsrSettings() || {};
    return sendJson(res, 200, { cfg: dualCfg(), manual: s.dualRatio || 'auto',
                                measured: s.dual || null });
  }
  if (pathname === '/api/asr/dual' && req.method === 'POST') {
    return readBody(req, res, 32 * 1024, (err, body) => {
      let v = 'auto';
      try { v = String((JSON.parse(body.toString('utf8')) || {}).ratio || 'auto'); } catch {}
      if (v !== 'auto' && !/^\d+:\d+$/.test(v)) {
        return sendJson(res, 400, { error: 'ratio 应为 auto 或形如 "1:1"' });
      }
      const s = readAsrSettings();
      s.dualRatio = v;
      writeAsrSettings(s);
      return sendJson(res, 200, { ok: true, cfg: dualCfg() });
    });
  }

  /* ── 性能测试：测出本机 NPU/GPU 的最佳分工 ── */
  if (pathname === '/api/asr/perf/state' && req.method === 'GET') {
    // 顺便带上已应用的配置，省得前端再要一个设置接口
    return sendJson(res, 200, Object.assign({}, perfState,
      { dual: (readAsrSettings() || {}).dual || null }));
  }
  if (pathname === '/api/asr/perf/apply' && req.method === 'POST') {
    return readBody(req, res, 32 * 1024, (err, body) => {
      let ratio = '', sliceSec = 0;
      try {
        const b = JSON.parse(body.toString('utf8')) || {};
        ratio = String(b.ratio || '');
        sliceSec = Number(b.sliceSec) || 0;
      } catch {}
      if (!/^\d+:\d+$/.test(ratio) || !(sliceSec > 0)) {
        return sendJson(res, 400, { error: 'ratio 形如 "1:1"，sliceSec 为正数' });
      }
      const s = readAsrSettings();
      s.dual = { ratio: ratio, sliceSec: sliceSec, updatedAt: new Date().toISOString() };
      writeAsrSettings(s);
      return sendJson(res, 200, { ok: true, dual: s.dual });
    });
  }
  if (pathname === '/api/asr/perf/start' && req.method === 'POST') {
    if (perfState.running) return sendJson(res, 200, { started: false, already: true, state: perfState });
    return readBody(req, res, 32 * 1024, (err, body) => {
      let b = {};
      try { b = JSON.parse(body.toString('utf8')) || {}; } catch {}
      const audio = String(b.audio || '').trim();
      if (!audio || !fs.existsSync(audio)) {
        return sendJson(res, 400, { error: '需要一份 16kHz 单声道 wav 作为测试素材' });
      }
      const slices = String(b.slices || '8,15.01,28');
      const audioSec = Math.max(30, Math.min(600, Number(b.audioSec) || 60));
      const out = path.join(ASR_DIR, 'perf-result.json');
      const args = [path.join(ASR_DIR, 'asr_perf.py'), '--audio', audio,
                    '--slices', slices, '--audio-sec', String(audioSec),
                    '--python', ASR_PY, '--out', out];
      if (b.modelNpu) args.push('--model-npu', String(b.modelNpu));
      if (b.modelGpu) args.push('--model-gpu', String(b.modelGpu));
      perfState = { running: true, pct: 0, msg: '启动中…', error: null, result: null,
                    startedAt: Date.now() };
      let proc;
      try {
        proc = spawn(ASR_PY, args, { windowsHide: true, cwd: ROOT,
                                     env: pySpawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        perfState = Object.assign({}, perfState, { running: false, error: String(e && e.message || e) });
        return sendJson(res, 500, { error: perfState.error });
      }
      perfProc = proc;
      const onLine = (buf) => {
        for (const line of String(buf).split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          let o = null;
          try { o = JSON.parse(t); } catch { continue; }
          if (o.type === 'progress') {
            perfState.pct = o.pct || perfState.pct;
            perfState.msg = o.msg || perfState.msg;
          } else if (o.type === 'log') {
            perfState.msg = o.msg || perfState.msg;
          } else if (o.type === 'result') {
            perfState.result = o.data || null;      // 完整结果直接带回来，省一次读文件
          } else if (o.type === 'error') {
            perfState.error = o.msg || '测试失败';
          }
        }
      };
      proc.stdout.on('data', onLine);
      proc.stderr.on('data', onLine);
      proc.on('close', (code) => {
        perfProc = null;
        perfState.running = false;
        if (code !== 0 && !perfState.error) perfState.error = '测试脚本退出码 ' + code;
        else if (code === 0 && !perfState.result) {
          try { perfState.result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
        }
      });
      return sendJson(res, 200, { started: true, state: perfState });
    });
  }
  /* ── 性能测试：测出本机 NPU/GPU 的最佳分工 ── */
  if (pathname === '/api/asr/perf/state' && req.method === 'GET') {
    // 顺便带上已应用的配置，省得前端再要一个设置接口
    return sendJson(res, 200, Object.assign({}, perfState,
      { dual: (readAsrSettings() || {}).dual || null }));
  }
  /* 自动找一份测试音频：优先用最近项目里的音频（就是识别实际吃的那份，最贴近真实负载）。
   * 直接用项目音频还有个好处：不必要求用户手动转成 16kHz wav。 */
  if (pathname === '/api/asr/perf/auto-audio' && req.method === 'GET') {
    try {
      const dirs = fs.readdirSync(PROJECTS_DIR).filter((n) => n.startsWith('p-'))
        .map((n) => path.join(PROJECTS_DIR, n))
        .map((p) => { try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; } })
        .filter(Boolean).sort((a, b) => b.m - a.m);
      for (const d of dirs) {
        for (const name of ['audio.wav', 'source16k.wav']) {
          const f = path.join(d.p, name);
          if (fs.existsSync(f) && fs.statSync(f).size > 100000) {
            return sendJson(res, 200, { path: f,
              why: path.basename(d.p) + '/' + name });
          }
        }
      }
      return sendJson(res, 200, { error: '没找到现成音频：先随便导入一个视频建过一次初稿，或手动选择 wav' });
    } catch (e) {
      return sendJson(res, 200, { error: '查找失败：' + String((e && e.message) || e) });
    }
  }
  if (pathname === '/api/asr/perf/apply' && req.method === 'POST') {
    return readBody(req, res, 32 * 1024, (err, body) => {
      let ratio = '', sliceSec = 0;
      try {
        const b = JSON.parse(body.toString('utf8')) || {};
        ratio = String(b.ratio || '');
        sliceSec = Number(b.sliceSec) || 0;
      } catch {}
      if (!/^\d+:\d+$/.test(ratio) || !(sliceSec > 0)) {
        return sendJson(res, 400, { error: 'ratio 形如 "1:1"，sliceSec 为正数' });
      }
      const s = readAsrSettings();
      s.dual = { ratio: ratio, sliceSec: sliceSec, updatedAt: new Date().toISOString() };
      writeAsrSettings(s);
      return sendJson(res, 200, { ok: true, dual: s.dual });
    });
  }
  if (pathname === '/api/asr/perf/start' && req.method === 'POST') {
    if (perfState.running) return sendJson(res, 200, { started: false, already: true, state: perfState });
    return readBody(req, res, 32 * 1024, (err, body) => {
      let b = {};
      try { b = JSON.parse(body.toString('utf8')) || {}; } catch {}
      const audio = String(b.audio || '').trim();
      if (!audio || !fs.existsSync(audio)) {
        return sendJson(res, 400, { error: '需要一份 16kHz 单声道 wav 作为测试素材' });
      }
      const slices = String(b.slices || '8,15.01,28');
      const audioSec = Math.max(30, Math.min(600, Number(b.audioSec) || 60));
      const out = path.join(ASR_DIR, 'perf-result.json');
      const args = [path.join(ASR_DIR, 'asr_perf.py'), '--audio', audio,
                    '--slices', slices, '--audio-sec', String(audioSec),
                    '--python', ASR_PY, '--out', out];
      if (b.modelNpu) args.push('--model-npu', String(b.modelNpu));
      if (b.modelGpu) args.push('--model-gpu', String(b.modelGpu));
      perfState = { running: true, pct: 0, msg: '启动中…', error: null, result: null,
                    startedAt: Date.now() };
      let proc;
      try {
        proc = spawn(ASR_PY, args, { windowsHide: true, cwd: ROOT,
                                     env: pySpawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        perfState = Object.assign({}, perfState, { running: false, error: String(e && e.message || e) });
        return sendJson(res, 500, { error: perfState.error });
      }
      perfProc = proc;
      const onLine = (buf) => {
        for (const line of String(buf).split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          let o = null;
          try { o = JSON.parse(t); } catch { continue; }
          if (o.type === 'progress') {
            perfState.pct = o.pct || perfState.pct;
            perfState.msg = o.msg || perfState.msg;
          } else if (o.type === 'log') {
            perfState.msg = o.msg || perfState.msg;
          } else if (o.type === 'result') {
            perfState.result = o.data || null;      // 完整结果直接带回来，省一次读文件
          } else if (o.type === 'error') {
            perfState.error = o.msg || '测试失败';
          }
        }
      };
      proc.stdout.on('data', onLine);
      proc.stderr.on('data', onLine);
      proc.on('close', (code) => {
        perfProc = null;
        perfState.running = false;
        if (code !== 0 && !perfState.error) perfState.error = '测试脚本退出码 ' + code;
        else if (code === 0 && !perfState.result) {
          try { perfState.result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
        }
      });
      return sendJson(res, 200, { started: true, state: perfState });
    });
  }
  /* 本地翻译引擎状态：设置页显示"模型在不在 / 服务起没起"，并可预热 */
  if (pathname === '/api/mt/local/status' && req.method === 'GET') {
    return sendJson(res, 200, localMt().probe());
  }
  if (pathname === '/api/mt/local/start' && req.method === 'POST') {
    localMt().ensure()
      .then(port => sendJson(res, 200, { ok: true, port, model: localMt().probe().model }))
      .catch(e => sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }));
    return;
  }
  if (pathname === '/api/translate/test' && req.method === 'POST') {
    const c = translateCfg();
    if (!llmReady(c)) return sendJson(res, 400, { error: '先填接口地址、API Key 和模型名' });
    llmChat(c, [{ role: 'user', content: '只回复一个单词：ok' }], { maxTokens: 512 })
      .then(r => sendJson(res, 200, { ok: true, reply: String(r.content).slice(0, 200) }))
      .catch(e => sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }));
    return;
  }
  /* 单条翻译: 字幕列表/时间轴右键「重新翻译」—— 把一条英文行翻成中文行(前端自动回填) */
  if (pathname === '/api/translate/one' && req.method === 'POST') {
    const c = translateCfg();
    if (!llmReady(c)) return sendJson(res, 400, { error: '还没配置翻译：先在设置里填接口地址、API Key 和模型名' });
    return readBody(req, res, 64 * 1024, (err, body) => {
      let text = '';
      try { text = String((JSON.parse(body.toString('utf8')) || {}).text || '').trim(); } catch {}
      if (!text) return sendJson(res, 400, { error: '缺少 text' });
      translateLines(c, [text], 0)
        // 与写初稿同一口径: 中文里的 ，、。 → 空格(! ? 保留)。在这里归一,
        // 所有调用方(右键「重新翻译」等)拿到的就是干净文本, 不会再漏。
        .then(arr => sendJson(res, 200, { zh: llmText.normalizeZhPunctuation((arr && arr[0]) || '') }))
        .catch(e => sendJson(res, 500, { error: String((e && e.message) || e) }));
    });
  }
  /* 运行日志 SSE: UI「日志」页实时显示(连接即回放历史缓冲, 之后实时推送) */
  if (pathname === '/api/logs/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    for (const line of logBuf) { try { res.write('data: ' + JSON.stringify(line) + '\n\n'); } catch {} }
    logClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(hb); logClients.delete(res); });
    return;
  }

  /* 前端错误上报: 浏览器 sendBeacon 把 JS 报错送进来 → 进运行日志(UI 可见) */
  if (pathname === '/api/logs/client' && req.method === 'POST') {
    return readBody(req, res, 64 * 1024, (err, body) => {
      const msg = String(body || '').slice(0, 4000);
      if (msg.trim()) console.error(msg);       // 走 console 拦截 → 环形缓冲 + SSE 广播
      return sendJson(res, 200, { ok: true });
    });
  }

  /* 生命周期 SSE: 页面常驻订阅一条 —— 托盘点「完全退出」时服务在这里广播 shutdown,
   * 页面收到后补存一次(靠 beforeunload 的 sendBeacon)并尝试关掉自己的窗口。 */
  if (pathname === '/api/lifecycle' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 5000\n\n');
    lifeClients.add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(hb); lifeClients.delete(res); });
    return;
  }

  /* 完全退出 —— 托盘图标右键的唯一入口。
   * 只认两种请求: ① 托盘发来的(带 X-SubFabric-Quit 头, 跨站页面设不了这个头 ——
   * 用了会被 CORS 预检拦下); ② 本机同源的页面 POST(带 Origin)。
   * 这样别的网页即使用 <img src="…/api/quit"> 也顶不掉用户正在用的编辑器。 */
  if (pathname === '/api/quit' && req.method === 'POST') {
    const origin = String(req.headers.origin || '');
    const byTray = req.headers['x-subfabric-quit'] === '1';
    const sameOrigin = !!origin && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
    if (!byTray && !sameOrigin) return sendJson(res, 403, { error: 'forbidden' });
    console.log('[quit] 收到完全退出请求（来源：' + (byTray ? '托盘图标/本机命令' : origin) + '）');
    sendJson(res, 200, { ok: true, pid: process.pid });   // 先把响应冲回去, 托盘据此判定成功
    setTimeout(() => shutdown(byTray ? '托盘图标' : '页面请求'), 120);
    return;
  }

  /* 前端诊断上报: 页面把布局/运行状态快照回传, 落到 .diag.json 供排查(不影响任何功能) */
  if (pathname === '/api/diag' && req.method === 'POST') {
    return readBody(req, res, 128 * 1024, (err, body) => {
      try { fs.writeFileSync(path.join(ROOT, '.diag.json'), body.toString('utf8')); } catch {}
      console.log('[diag] 收到前端诊断快照 (' + body.length + ' 字节)');
      sendJson(res, 200, { ok: true });
    });
  }

  /* /api/media 只服务登记过的视频路径(见 MEDIA_ALLOW 的定义处注释)。
   * meta 扫描加 3 秒缓存: 播放视频会发大量 Range 请求, 不能每个请求都把 projects/ 读一遍; */
  let mediaMetaCache = { at: 0, set: new Set() };
  function mediaAllowed(p) {
    if (!p) return false;
    const key = mediaKey(p);
    if (MEDIA_ALLOW.has(key)) return true;
    const now = Date.now();
    if (now - mediaMetaCache.at > 3000) {
      const set = new Set();
      let ids = [];
      try { ids = fs.readdirSync(PROJECTS_DIR); } catch {}
      for (const id of ids) {
        if (!validId(id)) continue;
        const meta = readMeta(id);
        const vp = meta && meta.video && meta.video.path;
        if (vp) set.add(mediaKey(vp));
      }
      mediaMetaCache = { at: now, set };
    }
    return mediaMetaCache.set.has(key);
  }
  if (pathname === '/api/media' && req.method === 'GET') {
    const p = u.searchParams.get('path') || '';
    const full = path.normalize(p);
    if (!mediaAllowed(full)) {
      return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'forbidden: video path not registered');
    }
    let ok = false;
    try { ok = fs.statSync(full).isFile() && VIDEO_EXTS.includes(path.extname(full).toLowerCase()); } catch {}
    if (!ok) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'video not found: ' + p);
    return serveFile(req, res, full);      // serveFile 自带 Range 支持
  }

  /* action 段允许连字符（如 tts-voices）。原来只写 [a-z]+，于是带连字符的路由
   * **整条正则都不匹配** → 直接 404，而 `if (pm)` 里的分支根本不会被求值
   * （实测：加 tts-voices 时踩到，排查了一阵才意识到不是路由写错、是没匹配上）。 */
  let pm = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})(?:\/([a-z][a-z-]*))?$/.exec(pathname);
  if (pathname === '/api/projects' && req.method === 'GET') {
    const items = [];
    let ids = [];
    try { ids = fs.readdirSync(PROJECTS_DIR); } catch {}
    for (const id of ids) {
      if (!validId(id)) continue;
      const meta = readMeta(id);
      if (!meta) continue;
      const v = metaView(meta);
      items.push({ id, name: meta.name, modifiedAt: meta.modifiedAt, createdAt: meta.createdAt,
        video: meta.video, videoExists: v.videoExists,
        fetching: !!v.fetching, format: meta.subtitle && meta.subtitle.format,
        subName: meta.subtitle && meta.subtitle.name, prepare: meta.prepare, draft: v.draft });
    }
    items.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
    return sendJson(res, 200, { projects: items });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    return readBody(req, res, 256 * 1024 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let data; try { data = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      // 再规整一次: 客户端送来的路径若带杂物, 这里同样能从"存在的最长前缀"里救回来
/* 创建接口里的"链接模式"分支: data.fetch.url 非空时不要求本地视频文件,
 * 先建项目(卡片立刻出现, 阶段=下载中)再后台下载, 下完接现有 prepare/ASR 流水线。 */
      const fetchUrl = normalizeFetchUrl((data.fetch && data.fetch.url) || '');
      if (fetchUrl) {
        const site = fetchSiteOf(fetchUrl);
        if (!site) return sendJson(res, 400, { error: '只支持 bilibili 与 YouTube 链接（其他站点暂不支持）' });
        if (!fetchReady()) return sendJson(res, 400, { error: '下载内核不可用：需要一个 Python 3.8 或更高版本。到设置里安装内置 Python' });
        const mF = (String(data.modelId || '').trim() && modelById(String(data.modelId).trim())) || resolveAsrModel();
        if (!mF) return sendJson(res, 400, { error: '还没有语音识别模型，先到设置里下载（Parakeet 或 Whisper large-v3-turbo 都行）' });
        if (!draftAllowedOf(mF)) return sendJson(res, 400, { error: '「' + mF.name + '」只能用于重新识别，不能创建初稿' });
        const idF = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        fs.mkdirSync(projDir(idF), { recursive: true });
        const nowF = new Date().toISOString();
        const bv = (fetchUrl.match(/\/(BV[0-9A-Za-z]+)/) || [])[1];
        const nameF = String(data.name || '').trim() || bv || '下载的视频';
        const wordLevelF = !!data.wordLevel;
        const wantSpkF = !!data.speakers && wordLevelF;
        const spkCountF = Math.max(1, Math.min(12, parseInt(data.speakerCount, 10) || 6));
        const metaF = {
          id: idF, name: nameF, nameCustomized: !!String(data.name || '').trim(), createdAt: nowF, modifiedAt: nowF,
          video: { path: '', name: '' },
          prepare: { status: 'none' },
          draft: {
            status: 'running', stage: FETCH_STAGE, progress: 1, message: '准备下载…', error: null,
            wordLevel: wordLevelF, lines: 0, words: 0, translated: false, needTranslate: false,
            modelId: mF.id, engine: mF.engine || '',
            speakers: wantSpkF, speakerCount: wantSpkF ? spkCountF : 0,
            fetch: { url: fetchUrl, site: site, quality: String((data.fetch && data.fetch.quality) || ''),
                     part: normalizePart(data.fetch && data.fetch.part) },
            startedAt: nowF,
          },
        };
        writeMeta(metaF);
        if (data.autoPost) { const mF2 = readMeta(idF); if (mF2) { mF2.autoPost = true; writeMeta(mF2); } }
        pushDraftLog(idF, '[' + new Date().toLocaleTimeString() + '] 新建项目（下载初稿）: ' + fetchUrl);
        Promise.resolve()
          .then(() => startFetchJob(idF, {
            url: fetchUrl,
            quality: String((data.fetch && data.fetch.quality) || ''),
            part: normalizePart(data.fetch && data.fetch.part),
            wordLevel: wordLevelF,
          }))
          .catch((e) => finishDraft(idF, e, { failedStage: FETCH_STAGE }));
        return sendJson(res, 200, metaView(readMeta(idF)));
      }

      const vpRaw = String((data.video && data.video.path) || '');
      const vp = normalizePickedPath(vpRaw, false) || vpRaw;
      let ok = false;
      try { ok = fs.statSync(vp).isFile() && VIDEO_EXTS.includes(path.extname(vp).toLowerCase()); } catch {}
      if (!ok) return sendJson(res, 400, { error: '视频文件不存在或格式不支持: ' + vp });
      // 初稿模式: 不要求字幕文件, 由服务端识别后生成
      const draftOn = !!data.draft;
      const wordLevel = !!data.wordLevel;
      const draftModelId = String((data.modelId || '')).trim();
      // 说话人分离: 用户勾选 + 告知的说话人数量(没填默认 6, 交给聚类模型)
      // SRT(逐词关) 没有角色概念 —— 前端会禁用开关, 这里再兜一层: 关掉逐词就不做说话人分离,
      // 否则会白跑一遍分离、生成的角色标注在 SRT 里也无处安放
      const wantSpeakers = !!data.speakers && !!data.wordLevel;
      const speakerCount = Math.max(1, Math.min(12, parseInt(data.speakerCount, 10) || 6));
      // 逐句置信度：三档。off/fast/full = 用户显式选过；**没给就存 null**（跟随全局设置），
      // 这样以后改全局设置，这个项目重新识别时会跟着变，而不是把当时的默认值冻住。
      const confidenceF = CONFIDENCE_MODES.includes(data.confidence) ? data.confidence : null;
      let format = null, file = null, subName = '', subText = '';

      if (draftOn) {
        const m = (draftModelId && modelById(draftModelId)) || resolveAsrModel();
        if (!m) return sendJson(res, 400, { error: '还没有语音识别模型，先到设置里下载（Parakeet 或 Whisper large-v3-turbo 都行）' });
        // 只能重新识别的模型(如 multitalker)一律不许创建初稿
        if (!draftAllowedOf(m)) {
          return sendJson(res, 400, { error: '「' + m.name + '」只能用于重新识别，不能创建初稿。改选 Parakeet TDT 或 Whisper large-v3-turbo' });
        }
        const mdir = m.cloud ? '' : modelDirFor(m.id);
        if (!m.cloud && missingModelFiles(mdir, m).length) return sendJson(res, 400, { error: `模型 ${m.name} 不完整，到设置里重新下载` });
        if (m.engine === 'whisper.cpp' && !whisperRuntimeOk()) return sendJson(res, 400, { error: 'whisper.cpp 运行时没装好，到设置里下载' });
        if (wantSpeakers && !diarizeReady()) return sendJson(res, 400, { error: '说话人分离模型没装好，先到设置里下载（约 32MB）' });
      } else {
        subName = String((data.subtitle && data.subtitle.name) || '');
        subText = String((data.subtitle && data.subtitle.text) || '');
        const m = /\.(srt|ass|ssa)$/i.exec(subName);
        if (!m) return sendJson(res, 400, { error: '字幕文件需为 .srt / .ass / .ssa' });
        format = m[1].toLowerCase() === 'srt' ? 'srt' : 'ass';
      }
      file = format === 'srt' ? 'subtitle.srt' : (format === 'ass' ? 'subtitle.ass' : null);

      const id = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      fs.mkdirSync(projDir(id), { recursive: true });
      if (file) fs.writeFileSync(path.join(projDir(id), file), subText, 'utf8');
      const now = new Date().toISOString();
      const meta = {
        id, name: String(data.name || '').trim() || path.basename(vp, path.extname(vp)),
        nameCustomized: !!String(data.name || '').trim(),
        createdAt: now, modifiedAt: now,
        video: { path: vp, name: path.basename(vp) },
        prepare: { status: 'none' }
      };
      if (file) meta.subtitle = { format, file, name: subName };
      /* 区域字幕导入（按时间区间裁剪）：把区间记下来。
       * 意义不只是"存个说明" —— 裁过的稿子时间轴从区间起点才开始，
       * 之后"波形漏字幕检测""行间空档检测"这类功能必须知道这件事，
       * 否则会把区间外的正常音频当成"漏字幕"。 */
      if (!draftOn && data.region && typeof data.region === 'object') {
        const rs = Number(data.region.start), re = data.region.end == null ? null : Number(data.region.end);
        if (Number.isFinite(rs) && rs >= 0 && (re === null || (Number.isFinite(re) && re > rs))) {
          meta.region = { start: rs, end: re, importedAt: now };
        }
      }
      /* 创建后自动处理（反思纠错 + 全片逐词重校对）：在创建页勾选。
       * 存在 meta 上而不是全局设置 —— 它是**这个项目**的选择，
       * 之后可以在项目详情里看到"这个稿子是自动处理过的"。 */
      if (draftOn && data.autoPost) meta.autoPost = true;
      if (draftOn) {
        const draftModel = (draftModelId && modelById(draftModelId)) || resolveAsrModel() || null;
        meta.draft = {
          status: 'running', stage: STAGE.extract, progress: 3,
          message: '提取音频与波形…', wordLevel, lines: 0, words: 0,
          translated: false, needTranslate: false,
          modelId: draftModel ? draftModel.id : null,
          engine: draftModel ? (draftModel.engine || '') : '',
          speakers: wantSpeakers, speakerCount: wantSpeakers ? speakerCount : 0,
          // true/false = 用户在建稿页显式选过；null = 跟随全局设置（见 asrConfidenceFor）
          confidence: confidenceF,
          startedAt: now, error: null,
        };
      }
      writeMeta(meta);
      if (draftOn) pendingAsr.set(id, { wordLevel });   // prepare 完成后由 finishPrepare 接手识别
      startPrepare(id, vp);       // 后台提取音频 + 波形
      return sendJson(res, 200, metaView(readMeta(id)));   // 重读: startPrepare 已把 prepare 置为 running
    });
  }
  /* ═══ 项目压缩包：导出 / 导入（在 if (pm) 之外 —— 导入没有项目 id，
   *     导出虽然带 id 但要能在任意路径命中，所以都自取 pathname）═══ */

  /** 导出：只含"人做出来的东西"（字幕/识别结果/译文/备注/日志）。
   *  不含视频与 audio.wav / peaks.bin —— 那是派生数据，导入端从视频重新生成。 */
  {
    const mExp = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/export-pack$/.exec(pathname);
    if (mExp && req.method === 'GET') {
      const pid = mExp[1];
      return (async () => {
        let packed = null;
        try {
          packed = await packProject(pid);
          const meta = readMeta(pid) || {};
          const safe = String(meta.name || pid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || pid;
          const buf = fs.readFileSync(packed.zipPath);
          console.log(`[pack] 导出 ${pid}：${packed.files.length} 个文件，${(buf.length / 1024).toFixed(0)} KB`);
          // 文件名走 RFC 5987，中文项目名也能正确落地
          return send(res, 200, {
            'Content-Type': 'application/zip',
            'Content-Disposition':
              `attachment; filename="subfabric-${pid}.zip"; filename*=UTF-8''${encodeURIComponent(safe)}.zip`,
            'Content-Length': String(buf.length),
            'Cache-Control': 'no-cache',
          }, buf);
        } catch (e) {
          return sendJson(res, 500, { error: String((e && e.message) || e) });
        } finally {
          if (packed) { try { fs.rmSync(packed.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        }
      })();
    }
  }

  /** 导入：上传 zip（原始二进制）→ 解包 → 校验 → 建新项目。
   *  **不在这里跑 prepare** —— 视频要由用户在导入端选（本地或在线），
   *  选完再走现有的提取流程生成 audio.wav 与波形。 */
  if (pathname === '/api/projects/import-pack' && req.method === 'POST') {
    const tmpZip = path.join(os.tmpdir(), 'kass-import-' + Date.now().toString(36)
      + '-' + Math.random().toString(36).slice(2) + '.zip');
    const out = fs.createWriteStream(tmpZip);
    let size = 0;
    let dead = false;
    req.on('data', c => {
      size += c.length;
      if (size > 512 * 1024 * 1024) { dead = true; req.destroy(); }   // 512MB 上限
    });
    req.on('error', () => { dead = true; out.destroy(); });
    req.on('end', () => { out.end(); });
    out.on('error', () => { dead = true; });
    out.on('finish', () => {
      if (dead) { fs.unlink(tmpZip, () => {}); return sendJson(res, 400, { error: '上传中断或文件过大（上限 512MB）' }); }
      (async () => {
        let unpacked = null;
        try {
          unpacked = await unpackProject(tmpZip);
          const mf = unpacked.manifest;
          if (!mf.ok) return sendJson(res, 400, { error: mf.error });
          // 建新项目：新 id（同一个包可导入多次），不覆盖已有项目
          const newId = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
          const now = new Date().toISOString();
          fs.mkdirSync(projDir(newId), { recursive: true });
          const copied = [];
          let meta = null;
          for (const f of unpacked.files) {
            if (!packMod.shouldPack(f)) continue;      // 派生文件与杂物一律不落盘
            const buf = fs.readFileSync(path.join(unpacked.dir, f));
            if (buf.length > 64 * 1024 * 1024) continue;   // 单个核心文件不该这么大
            if (f === 'project.json') {
              try { meta = JSON.parse(buf.toString('utf8')); } catch { meta = null; }
              continue;                                   // meta 要改写后再写
            }
            fs.writeFileSync(path.join(projDir(newId), f), buf);
            copied.push(f);
          }
          const newMeta = packMod.remapMeta(meta, newId, now);
          if (!newMeta.subtitle) {
            // 包里的 project.json 没记字幕文件时按实际存在的补
            newMeta.subtitle = copied.includes('subtitle.ass')
              ? { format: 'ass', file: 'subtitle.ass', name: 'subtitle.ass' }
              : { format: 'srt', file: 'subtitle.srt', name: 'subtitle.srt' };
          }
          writeMeta(newMeta);
          if (fs.existsSync(path.join(projDir(newId), 'draft.log'))) {
            pushDraftLog(newId, '[' + new Date().toLocaleTimeString() + '] 从项目包导入'
              + (meta && meta.name ? '：' + meta.name : ''));
          }
          console.log(`[pack] 导入 → ${newId}：${copied.length} 个文件`
            + `（视频与音频待用户选择后重新生成）`);
          return sendJson(res, 200, {
            ok: true, id: newId, files: copied,
            // 让前端知道"还差什么"：视频没选、音频没生成
            needVideo: true, prepare: 'none',
            missing: mf.missing,
          });
        } catch (e) {
          return sendJson(res, 500, { error: String((e && e.message) || e) });
        } finally {
          try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
          if (unpacked) { try { fs.rmSync(unpacked.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        }
      })();
    });
    req.pipe(out);
    return;
  }

  if (pm) {
    const id = pm[1], action = pm[2] || '';
    const meta = readMeta(id);
    if (!meta) return sendJson(res, 404, { error: '项目不存在' });

    if (!action && req.method === 'GET') return sendJson(res, 200, metaView(meta));

    /* ═══════════ 长稿反思纠错（预览优先） ═══════════
     * GET  /api/projects/:id/reflect
     *   让 LLM 通读全片（分批 + 相邻批重叠），返回**建议**与**去重后的重识别区间**。
     *   只读不写：这一步不碰字幕。前端把它渲染成预览清单。
     *   同步接口而不是后台任务：一次反思通常十几秒到一两分钟（取决于批数与模型），
     *   用户点了就在等这个结果，给个转圈比轮询简单可靠。批数多时前端会显示进度文案。
     */
    if (action === 'reflect' && req.method === 'GET') {
      if (reflectBusy.has(id)) return sendJson(res, 409, { error: '这个稿件正在反思中，等它跑完' });
      reflectBusy.add(id);
      return (async () => {
        try {
          const out = await runReflect(id);
          return sendJson(res, 200, out);
        } catch (e) {
          return sendJson(res, 500, { error: String((e && e.message) || e) });
        } finally {
          reflectBusy.delete(id);
        }
      })();
    }

    /* POST /api/projects/:id/reidentify   批量重识别（按区间，每段只跑一次）
     * 请求体: { regions: [{start, end}], why? }
     * 区间由前端从 reflect 的结果里取（reflectMod.planRegions 已保证互不重叠），
     * 这里**再校验一遍**：合并重叠/相接的区间并限定数量上限，
     * 这样"同一稿件只重识别一遍"这条约束在服务端也成立，不只靠前端自觉。
     * 返回: { start, end, status, stage, progress, message, error, regions, done, ... }
     * 前端轮询同一个地址的 GET 拿进度。
     */
    if (action === 'reidentify' && req.method === 'POST') {
      return readBody(req, res, 256 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { error: String(err.message) });
        let list = [];
        try {
          const p = JSON.parse(body.toString('utf8')) || {};
          list = Array.isArray(p.regions) ? p.regions : [];
        } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const ranges = [];
        for (const r of list) {
          const a = parseFloat(r && r.start), b = parseFloat(r && r.end);
          if (Number.isFinite(a) && Number.isFinite(b) && b > a && a >= 0) ranges.push({ start: a, end: b });
        }
        if (!ranges.length) return sendJson(res, 400, { error: '没有有效的区间' });
        if (ranges.length > 200) return sendJson(res, 400, { error: '区间太多了（超过 200 段），分批来' });
        // 服务端再求一次并：重叠或相接的合成一段 —— 保证每段音频只识别一次
        ranges.sort((x, y) => x.start - y.start);
        const merged = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
          else merged.push({ start: r.start, end: r.end });
        }
        const wav = path.join(projDir(id), 'audio.wav');
        if (!fs.existsSync(wav)) return sendJson(res, 400, { error: '该项目没有已保存的音频（audio.wav），无法重新识别' });
        const rr = resolveRerecogModel(meta);
        if (rr.error) return sendJson(res, 400, { error: rr.error });
        const gpuGate = asrGpuGateError(rr.model);
        if (gpuGate) return sendJson(res, 400, { error: gpuGate });
        /* 互斥只看"真的还在跑"的任务。
         * 早期是 `jobRerecog.has(id)` —— 只要 Map 里还有条目就拒绝，
         * 于是一个**已完成/失败**、尚未被老化清理的旧任务会把稿件挡死
         * （用户实测："纠错重识别启动失败：这个稿件已有重新识别任务在跑"）。
         * 已完成的任务会被新任务直接覆盖，不需要等 10 分钟。 */
        const prevJob = jobRerecog.get(id);
        if (jobStillRunning(prevJob)) return sendJson(res, 409, { error: '这个稿件已有重新识别任务在跑' });
        const job = startReidentifyBatch(id, merged, rr.model);
        return sendJson(res, 200, jobView(job));
      });
    }
    if (action === 'reidentify' && req.method === 'GET') {
      const job = jobRerecog.get(id);
      if (!job) return sendJson(res, 200, { job: null });
      return sendJson(res, 200, { job: jobView(job) });
    }

    /* 全片逐词重校对：逐句 TTS 朗读 → 重新识别 → 对齐，算出**每句的置信度**，
     * 只对达标的句子改逐词时间（不达标的原样保留）。
     *
     * POST → 启动后台作业，立即返回 { job }
     * GET  → 轮询 { job }
     * 只算不写：返回的 items 里带每句的新逐词时间，由前端确认后应用
     * （与反思纠错、单条重排同一套"预览优先"约定）。 */
    if (action === 'realign-full' && req.method === 'POST') {
      return readBody(req, res, 64 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { error: String(err.message) });
        let o = {};
        try { o = body && body.length ? JSON.parse(body.toString('utf8')) : {}; }
        catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        try {
          const job = startFullRealign(id, o);
          return sendJson(res, 200, { job: realignJobView(job) });
        } catch (e) {
          return sendJson(res, 409, { error: String((e && e.message) || e) });
        }
      });
    }
    if (action === 'realign-full' && req.method === 'GET') {
      const job = realignJobs.get(id);
      if (!job) return sendJson(res, 200, { job: null });
      return sendJson(res, 200, { job: realignJobView(job) });
    }

    /* 逐词时间重对齐：只算不写。
     * body: { blocks:[{text,start,end}], voice?, rate? }
     * → { blocks:[{index,start,end,text,ok,words:[{w,s,e}],anchors,ratio,note,heard}] }
     *
     * 前端拿到提案后自己决定应用哪些、并负责写回 —— 服务端不碰字幕文件，
     * 与"反思纠错只产出建议"是同一套约定（预览优先）。 */
    if (action === 'realign' && req.method === 'POST') {
      return readBody(req, res, 512 * 1024, async (err, body) => {
        if (err) return sendJson(res, 400, { error: String(err.message) });
        let data;
        try { data = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const raw = Array.isArray(data && data.blocks) ? data.blocks : [];
        if (!raw.length) return sendJson(res, 400, { error: '没有要处理的字幕块' });
        if (raw.length > 200) return sendJson(res, 400, { error: '一次最多处理 200 条（实测每条约 1~2 秒）' });
        const blocks = raw.map((b) => ({
          text: String((b && b.text) || ''),
          start: Number(b && b.start),
          end: Number(b && b.end),
        })).filter(b => b.text.trim());
        if (!blocks.length) return sendJson(res, 400, { error: '这些块都没有可念的文本' });
        try {
          const t0 = Date.now();
          const result = await realignBlocks(id, blocks, { voice: data.voice, rate: data.rate });
          const okN = result.filter(r => r.ok).length;
          console.log(`[align] 逐词重对齐：${blocks.length} 条 → 可用 ${okN} 条，`
            + `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          return sendJson(res, 200, { blocks: result, total: blocks.length, usable: okN });
        } catch (e) {
          return sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
    }

    // 本机可用的 TTS 语音（前端下拉）—— 不依赖网络，纯 SAPI 枚举
    if (action === 'tts-voices' && req.method === 'GET') {
      return ttsVoices().then(v => sendJson(res, 200, { voices: v }))
        .catch(() => sendJson(res, 200, { voices: [] }));
    }

    /* 逐词重排（TTS 对齐）的设置：读 / 写。
     * GET  → { voice, rate, minAnchorRatio, voices }
     * POST → 局部更新（存 asr/settings.json 的 realign 段）
     * 这几个值只影响**以后**的重排，不碰已有字幕。 */
    if (action === 'realign-settings' && (req.method === 'GET' || req.method === 'POST')) {
      const view = async () => {
        const raw = (readAsrSettings().realign) || {};
        const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
        return {
          voice: String(raw.voice || ''),
          rate: num(raw.rate, 0),
          minAnchorRatio: num(raw.minAnchorRatio, alignMod.MIN_ANCHOR_RATIO),
          // 全片重校对的置信度门槛（与锚点率门槛不同：那个是"能不能用"，这个是"值不值得改"）
          minConfidence: num(raw.minConfidence, 0.7),
          voices: await ttsVoices().catch(() => []),
        };
      };
      if (req.method === 'GET') return view().then(v => sendJson(res, 200, v));
      return readBody(req, res, 16 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { error: String(err.message) });
        let p;
        try { p = JSON.parse(body.toString('utf8')) || {}; }
        catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const s = readAsrSettings();
        const cur = Object.assign({}, s.realign);
        if (p.voice !== undefined) cur.voice = String(p.voice || '').trim().slice(0, 120);
        if (p.rate !== undefined) cur.rate = Math.max(-3, Math.min(3, parseInt(p.rate, 10) || 0));
        if (p.minAnchorRatio !== undefined) {
          cur.minAnchorRatio = Math.max(0.3, Math.min(1, Number(p.minAnchorRatio) || 0.6));
        }
        if (p.minConfidence !== undefined) {
          cur.minConfidence = Math.max(0.3, Math.min(1, Number(p.minConfidence) || 0.7));
        }
        s.realign = cur;
        try { writeAsrSettings(s); } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
        console.log('[align] 重排设置已更新：语音=' + (cur.voice || '(默认)')
          + ' 语速=' + cur.rate + ' 最低锚点率=' + cur.minAnchorRatio
          + ' 重校对置信度门槛=' + cur.minConfidence);
        return view().then(v => sendJson(res, 200, Object.assign({ ok: true }, v)));
      });
    }


    /* 备注（时间点留言）：读 / 新增 / 删除 / 全量替换。
     * GET    → { notes:[{id,at,text,danmaku,createdAt}], duration }
     * POST   → 新增一条（body: { at, text, danmaku }）
     * PATCH  → 改一条（body: { id, text?, danmaku? }）
     * DELETE → 删一条（?id=…）
     *
     * danmaku = 这条备注在播放时以弹幕显示多久（秒）。允许 2~5 秒 ——
     * 太短看不清、太长会和下一条叠在一起。 */
    if (action === 'notes' && ['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const DUR_MIN = 2, DUR_MAX = 5;
      const clampDur = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(DUR_MIN, Math.min(DUR_MAX, n)) : 2.5;
      };
      const view = () => {
        const m = readMeta(id) || {};
        return { notes: readNotes(id), duration: projectDuration(id, m) };
      };
      if (req.method === 'GET') return sendJson(res, 200, view());

      if (req.method === 'DELETE') {
        const want = String((u.searchParams.get('id') || '')).trim();
        if (!want) return sendJson(res, 400, { error: '缺少 id' });
        const list = readNotes(id).filter(n => String(n.id) !== want);
        try { writeNotes(id, list); }
        catch (e) { return sendJson(res, 500, { error: '删除失败：' + ((e && e.message) || e) }); }
        return sendJson(res, 200, { ok: true, removed: 1, notes: list });
      }

      return readBody(req, res, 64 * 1024, (err2, body) => {
        if (err2) return sendJson(res, 400, { error: String(err2.message) });
        let d;
        try { d = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const list = readNotes(id);
        try {
          if (req.method === 'POST') {
            const text = String((d && d.text) || '').trim();
            if (!text) return sendJson(res, 400, { error: '备注内容不能为空' });
            if (text.length > 2000) return sendJson(res, 400, { error: '备注最长 2000 字' });
            const n = {
              id: 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
              at: Math.max(0, Number(d.at) || 0),
              text,
              danmaku: clampDur(d.danmaku),
              createdAt: new Date().toISOString(),
            };
            list.push(n);
            while (list.length > NOTES_MAX) list.shift();
            writeNotes(id, list);
            console.log(`[notes] 新增备注 @${n.at.toFixed(2)}s（${n.text.slice(0, 30)}…）`);
            return sendJson(res, 200, { ok: true, note: n, notes: list });
          }
          // PATCH
          const want = String((d && d.id) || '').trim();
          const i = list.findIndex(n => String(n.id) === want);
          if (i === -1) return sendJson(res, 404, { error: '找不到这条备注' });
          if (d.text !== undefined) {
            const t2 = String(d.text).trim();
            if (!t2) return sendJson(res, 400, { error: '备注内容不能为空' });
            list[i].text = t2.slice(0, 2000);
          }
          if (d.danmaku !== undefined) list[i].danmaku = clampDur(d.danmaku);
          if (d.at !== undefined) list[i].at = Math.max(0, Number(d.at) || 0);
          writeNotes(id, list);
          return sendJson(res, 200, { ok: true, note: list[i], notes: list });
        } catch (e) {
          console.error('[notes] 写入失败：' + ((e && e.message) || e));
          return sendJson(res, 500, { error: '备注保存失败：' + ((e && e.message) || e) });
        }
      });
    }

    /* 手动补跑"创建后自动处理"（反思纠错 + 全片逐词重校对）。
     * 建稿时自动跑过一次但失败了（网络/模型/超时），用户不该被迫重建整个项目。 */
    if (action === 'autopost' && req.method === 'POST') {
      const m = readMeta(id);
      if (!m) return sendJson(res, 404, { error: '项目不存在' });
      if (!m.draft || m.draft.status !== 'done') {
        return sendJson(res, 409, { error: '初稿还没生成完，等它好了再跑自动处理' });
      }
      const ap = (m.draft && m.draft.autoPost) || null;
      if (ap && ap.status === 'running') {
        return sendJson(res, 409, { error: '自动处理正在跑，请等它结束' });
      }
      m.autoPost = true;
      writeMeta(m);
      runAutoPost(id).catch(e => {
        const msg = String((e && e.message) || e);
        console.error('[autopost] ' + id + ' 失败：' + msg);
        pushDraftLog(id, stamp() + '[自动后处理] 失败：' + msg);
      });
      return sendJson(res, 200, { ok: true, started: true });
    }

    /* 用户操作日志：读 / 追加。
     * GET  → { entries:[{t,action,target,detail,why}] }（最近 500 条，跨重启留存）
     * POST → 追加一条；前端在各处编辑动作里带上"做了什么 + 为什么"。
     * 落盘失败不报错给用户（日志是辅助信息，不该挡住正常编辑）。 */
    if (action === 'oplog' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') {
        return sendJson(res, 200, { entries: readOpLog(id) });
      }
      return readBody(req, res, 64 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { error: String(err.message) });
        let d;
        try { d = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const items = Array.isArray(d && d.entries) ? d.entries : [d];
        if (items.length > 200) return sendJson(res, 400, { error: '一次最多写入 200 条' });
        let n = 0;
        const errs = [];
        for (const e of items) {
          const r = appendOpLog(id, e);
          if (r.ok) n++;
          else if (errs.length < 3) errs.push(r.err);
        }
        return sendJson(res, 200, { ok: n > 0, written: n, errors: errs });
      });
    }

    if (action === 'info' && req.method === 'PUT') {
      return readBody(req, res, 8 * 1024, (err, body) => {
        if (err) return sendJson(res, 400, { error: String(err.message) });
        let data;
        try { data = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        if (!data || typeof data.name !== 'string') return sendJson(res, 400, { error: '项目名称格式无效' });
        const name = data.name.trim();
        if (!name) return sendJson(res, 400, { error: '项目名称不能为空' });
        if (name.length > 60) return sendJson(res, 400, { error: '项目名称不能超过 60 个字符' });
        // 在请求体读完后重新读取，避免用路由入口处的旧对象覆盖后台任务状态。
        const current = readMeta(id);
        if (!current) return sendJson(res, 404, { error: '项目不存在' });
        current.name = name;
        current.nameCustomized = true;
        touchMeta(current);
        return sendJson(res, 200, { ok: true, name: current.name, modifiedAt: current.modifiedAt });
      });
    }

    // 重试：按现有产物决定从哪一步续跑（有识别结果就只补翻译，不重头来）
    if (action === 'retry' && req.method === 'POST') {
      const r = retryDraft(id);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, { started: true, from: r.from, draft: (metaView(readMeta(id)) || {}).draft || null });
    }

    // 跳过此步：重试满 SKIP_AFTER_RETRIES 次仍不成功后的出路。
    // 按失败所在阶段分流: 语义分句/说话人分离跳过后继续流水线, 翻译跳过则保留纯英文初稿。
    // 语音识别不可跳过。
    if (action === 'skip' && req.method === 'POST') {
      const d = (metaView(meta) || {}).draft || {};
      if (d.status === 'running') return sendJson(res, 400, { error: '该步骤正在运行，等它结束（或失败）后再跳过' });
      if ((d.retries || 0) < SKIP_AFTER_RETRIES) {
        return sendJson(res, 400, { error: `重试满 ${SKIP_AFTER_RETRIES} 次后才能跳过此步（当前已重试 ${d.retries || 0} 次）` });
      }
      const failedStage = d.failedStage || '';
      const wordLevel = !!meta.draft.wordLevel;
      draftJobs.delete(id);
      pendingAsr.delete(id);
      if (failedStage === STAGE.reseg && !meta.draft.resegDone) {
        meta.draft.resegDone = true; meta.draft.resegSkipped = true; writeMeta(meta);
        pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 已跳过语义分句（按标点/停顿兜底切句）`);
        setDraft(id, { status: 'running', message: '继续处理（已跳过语义分句）…', error: null, failedStage: '' });
        Promise.resolve().then(() => continueDraftAfterAsr(id, wordLevel)).catch(e => finishDraft(id, e));
        return sendJson(res, 200, { skipped: true, draft: (metaView(readMeta(id)) || {}).draft || null });
      }
      if (failedStage === STAGE.diarize && !meta.draft.diarizeSkipped) {
        meta.draft.diarizeSkipped = true; writeMeta(meta);
        pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 已跳过说话人分离（不写角色标注）`);
        setDraft(id, { status: 'running', message: '继续处理（已跳过说话人分离）…', error: null, failedStage: '' });
        Promise.resolve().then(() => buildDraftSubtitle(id, wordLevel)).catch(e => finishDraft(id, e));
        return sendJson(res, 200, { skipped: true, draft: (metaView(readMeta(id)) || {}).draft || null });
      }
      if (d.skippedTranslate) return sendJson(res, 400, { error: '翻译已经跳过了' });
      finishDraft(id, null, {
        status: 'done', stage: STAGE.done, progress: 100,
        translated: false, needTranslate: false, skippedTranslate: true, pendingTranslate: 0,
        message: '已跳过翻译：初稿保留语音识别结果（英文），之后仍可在卡片上点「翻译」补中文',
      });
      return sendJson(res, 200, { skipped: true, draft: (metaView(readMeta(id)) || {}).draft || null });
    }

    /* ═══════════ 选区重新识别（后台任务） ═══════════
     * 流程: 从项目已保存的 audio.wav 里切出 [start,end) → asr.py 识别(时间戳加回偏移)
     *       → 用设置里的 LLM 翻译 → 结果落在任务对象里, 前端轮询取走写回字幕块。
     *  做成后台任务而不是同步接口: 识别+翻译可能要几分钟, 期间用户要能继续播放/编辑,
     *  区域进度常驻画在时间轴上。 */
    if (action === 'rerecognize' && req.method === 'POST') {
      return readBody(req, res, 64 * 1024, (err, body) => {
        let start = NaN, end = NaN;
        try {
          const p = JSON.parse(body.toString('utf8')) || {};
          start = parseFloat(p.start); end = parseFloat(p.end);
        } catch {}
        if (!(start >= 0) || !(end > start)) return sendJson(res, 400, { error: '时间范围无效' });
        const wav = path.join(projDir(id), 'audio.wav');
        if (!fs.existsSync(wav)) return sendJson(res, 400, { error: '该项目没有已保存的音频（audio.wav），无法重新识别' });
        // 模型: 设置里的「重新识别模型」优先(可指定只做重新识别的 multitalker), 否则沿用项目初稿模型
        const rr = resolveRerecogModel(meta);
        if (rr.error) return sendJson(res, 400, { error: rr.error });
        const model = rr.model;
        // GPU 硬校验: 三个引擎都必须在各自 GPU 上跑, 不做 CPU 兜底(multitalker 连 CPU 版 torch 都拒)
        const gpuGate = asrGpuGateError(model);
        if (gpuGate) return sendJson(res, 400, { error: gpuGate });
        const prev = rerecogJobs.get(id);
        if (prev && prev.status === 'running') return sendJson(res, 400, { error: '已有一个重新识别任务在运行' });
        startRerecognize(id, start, end, model);
        return sendJson(res, 200, { started: true, model: { id: model.id, name: model.name } });
      });
    }
    // 任务状态(前端每秒轮询): {status, stage, progress, message, error, segments}
    if (action === 'rerecognize' && req.method === 'GET') {
      const job = rerecogJobs.get(id) || null;
      // 完成/失败的任务留 10 分钟给前端取结果, 之后清掉 —— 否则任务对象永远赖在 Map 里:
      //   ① 用户刷新页面后重开项目, 这个陈旧 job 会让下一次「重新识别」被
      //      "已有一个重新识别任务在运行" 永久挡住(实测: 刷新后按钮就废了);
      //   ② 每个项目的完整识别结果常驻内存, 长会话下白占。
      if (job && job.status !== 'running' && job.finishedAt
          && Date.now() - Date.parse(job.finishedAt) > 10 * 60 * 1000) {
        rerecogJobs.delete(id);
        return sendJson(res, 200, { job: null });
      }
      return sendJson(res, 200, { job });
    }

    // 手动触发翻译(自动翻译没勾选时点「翻译」按钮走这里)
    if (action === 'translate' && req.method === 'POST') {
      const cfg = translateCfg();
      if (!llmReady(cfg)) return sendJson(res, 400, { error: '还没配置翻译：在主界面右上角「设置」里填接口地址、API Key 和模型名' });
      // 识别/提取还在跑时字幕文件还不存在 —— 此时允许**排队**，而不是报"没有字幕"
      const inFlight = draftJobs.has(id) || pendingAsr.has(id);
      if (!meta.subtitle && !inFlight) return sendJson(res, 400, { error: '该项目还没有初稿字幕' });
      return readBody(req, res, 64 * 1024, (err, body) => {
        let redo = false;
        try { redo = !!(JSON.parse(body.toString('utf8') || '{}') || {}).redo; } catch {}
        if (inFlight) {
          setDraft(id, { translateQueued: true });
          return sendJson(res, 200, { queued: true, draft: (metaView(readMeta(id)) || {}).draft || null });
        }
        if (redo) { try { fs.unlinkSync(path.join(projDir(id), 'translation.json')); } catch {} }
        draftJobs.delete(id);   // 同上: 手动触发前先清防重入标记
        setDraft(id, {
          retries: (((meta.draft || {}).retries) || 0) + 1,   // 手动续跑计数(见 SKIP_AFTER_RETRIES)
          status: 'running', stage: STAGE.translate, progress: 86, message: '准备翻译…', error: null,
        });
        Promise.resolve(startTranslate(id)).catch(e => finishDraft(id, e));
        return sendJson(res, 200, { started: true, draft: (metaView(readMeta(id)) || {}).draft || null });
      });
    }

    // 初稿进度详情: 状态 + 滚动日志(供列表上的「详细信息」页面轮询)
    if (action === 'draft' && req.method === 'GET') {
      let log = '';
      try { log = fs.readFileSync(draftLogFile(id), 'utf8'); } catch {}
      return sendJson(res, 200, { draft: metaView(meta).draft || null, log });
    }
    if (!action && req.method === 'DELETE') {
      // 先停掉该项目还在跑的初稿任务(识别进程精确跟踪, 只杀自己的, 不误伤别的 python)
      draftJobs.delete(id);
      killDraftProc(id);
      // 注意: 逐文件删除而不是 rmSync 递归 —— 部分 fs 代理环境会对"批量递归删除"
      // (条目数超阈值)强制要求确认, 把整目录 rmSync 拦下来导致「删除失败」。
      // 项目删除在 UI 上已经过用户二次确认, 这里逐个 unlink 即可正常工作。
      try { rmDirDeep(projDir(id)); } catch (e) { return sendJson(res, 500, { error: String(e.message) }); }
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'subtitle' && (req.method === 'PUT' || req.method === 'POST')) {
      // 字幕自动保存: 原文整体覆写; sendBeacon 只能 POST, 所以 PUT/POST 都收
      return readBody(req, res, 256 * 1024 * 1024, (err2, body) => {
        if (err2) return sendJson(res, 400, { error: String(err2.message) });
        const file = meta.subtitle && meta.subtitle.file;
        if (!file) return sendJson(res, 400, { error: '项目缺少字幕文件信息' });
        try {
          const subTmp = path.join(projDir(id), file) + '.tmp';
          fs.writeFileSync(subTmp, body, 'utf8');
          fs.renameSync(subTmp, path.join(projDir(id), file));  // 原子替换, 打开方不会读到半截字幕
          touchMeta(meta);
        } catch (e) {
          // 写盘失败要**报出来**（磁盘满/权限/被占用），否则前端以为存上了
          console.error('[subtitle] 保存失败：' + ((e && e.message) || e));
          return sendJson(res, 500, { error: '字幕保存失败：' + ((e && e.message) || e) });
        }
        return sendJson(res, 200, { ok: true, savedAt: meta.modifiedAt });
      });
      /* ⚠ 这里曾经是 `return finish(200, {...})` —— **finish 根本不存在**，
       *   于是每次自动保存都抛 ReferenceError、被外层 handler 捕获成
       *   "[handler error] PUT .../subtitle"，返回 500。
       *   实测某次编辑会话里累计 **58 次**这样的失败：文件其实已经由上面的
       *   write+rename 写进去了，但前端收到 500 会认为没存上 ——
       *   用户那边的表现就是"改了半天，稿子莫名其妙缺内容"。
       *   下面那两行 req.pipe(out) 是更早的流式落盘实现留下的死代码（out 也不存在），
       *   一并删掉。 */
    }
    if (action === 'subtitle' && req.method === 'GET') {
      const file = meta.subtitle && meta.subtitle.file;
      return serveFile(req, res, path.join(projDir(id), file || 'subtitle.ass'));
    }
    if (action === 'relink' && req.method === 'POST') {
      return readBody(req, res, 64 * 1024, (err2, body) => {
        if (err2) return sendJson(res, 400, { error: String(err2.message) });
        let vp; try { vp = (JSON.parse(body.toString('utf8')) || {}).videoPath || ''; } catch { vp = ''; }
        let ok = false;
        try { ok = fs.statSync(vp).isFile() && VIDEO_EXTS.includes(path.extname(vp).toLowerCase()); } catch {}
        if (!ok) return sendJson(res, 400, { error: '视频文件不存在或格式不支持: ' + vp });
        meta.video = { path: vp, name: path.basename(vp) };
        touchMeta(meta);
        const v = metaView(meta);
        if (!v.hasPeaks) startPrepare(id, vp, (meta.audio && meta.audio.mode) || 'raw');
        return sendJson(res, 200, metaView(meta));
      });
    }
    if (action === 'prepare' && req.method === 'POST') {
      if (!(meta.video && meta.video.path)) return sendJson(res, 400, { error: '项目还没有视频' });
      const v = metaView(meta);
      if (!v.videoExists && v.fetching) return sendJson(res, 400, { error: '视频还在下载，等下载完成再看' });
    if (!v.videoExists) return sendJson(res, 400, { error: '视频文件找不到了，重新选一个' });
      if (prepareJobs.has(id)) return sendJson(res, 409, { error: '音频正在提取中，请等它完成' });
      // body 可选: {mode:'raw'|'denoise', force:true}
      //   force=true → 编辑器「重新生成音频」: 按指定模式重抽 audio.wav 与波形(字幕不动)
      //   无 force   → 兜底补跑: 只有缺 peaks 才跑, 模式沿用项目当前设置
      return readBody(req, res, 4 * 1024, (err2, body) => {
        let opts = {};
        if (!err2 && body && body.length) { try { opts = JSON.parse(body.toString('utf8')) || {}; } catch {} }
        const curMode = (meta.audio && meta.audio.mode) || 'raw';
        const mode = opts.mode === 'raw' || opts.mode === 'denoise' ? opts.mode : curMode;
        if (!opts.force && v.hasPeaks) return sendJson(res, 200, metaView(readMeta(id)));
        startPrepare(id, meta.video.path, mode);
        return sendJson(res, 200, metaView(readMeta(id)));
      });
    }
    if (action === 'peaks' && req.method === 'GET') {
      const f = meta.peaks && meta.peaks.file;
      let buf = null;
      try { buf = fs.readFileSync(path.join(projDir(id), f)); } catch {}
      if (!buf) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'peaks not ready');
      return sendPeaks(res, buf, (meta.peaks && meta.peaks.rate) || 100);
    }
    if (action === 'audio' && req.method === 'GET') {
      return serveFile(req, res, path.join(projDir(id), (meta.audio && meta.audio.file) || 'audio.wav'));
    }
  }

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');
  serveFile(req, res, filePath);
}

/* 兜底: 处理器里抛异常绝不能让请求一直悬着 —— 前端会卡死在「读取中…」且没有任何提示。
 * (实测用户报过设置面板识别模型区永远显示"读取中") 这里统一回 500 JSON, 把原因带回前端。 */
const server = http.createServer((req, res) => {
  try { handleRequest(req, res); }
  catch (e) {
    const msg = String((e && e.message) || e);
    console.error('[handler error]', req.method, req.url, '\n', (e && e.stack) || e);
    try {
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误：' + msg });
      else res.end();
    } catch {}
  }
});
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', (e && e.stack) || e);      // 记日志但不让进程死掉(本地工具优先可用)
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', (e && e.stack) || e);
});

server.listen(PORT, HOST, () => {
  console.log(`[subtitle-editor] node ${process.version}`);
  console.log(`[subtitle-editor] serving ${ROOT}`);
  console.log(`[subtitle-editor] open  http://${HOST}:${PORT}/`);
  // libass 渲染依赖自检：缺了就直说。否则用户只会看到"视频上没有字幕"，
  // 而列表与时间轴都正常，很难想到是渲染器缺失。
  // 用 console.error 而不是 console.warn —— 日志面板只包装了 log/error，
  // warn 既进不了日志也进不了 UI 的日志页（实测踩过）。
  {
    const miss = libassMissing();
    if (miss.length) {
      console.error('[subtitle-editor] ⚠ 缺少 libass 渲染依赖，视频区不会显示字幕：'
        + miss.join('、'));
      console.error('[subtitle-editor]   修复：在项目根目录运行  node editor/scripts/fetch-vendor.js'
        + '（约 18MB；生成后刷新页面即可，不用重启）');
    }
  }
  startTray();     // 托盘图标(Windows): 右键 → 完全退出
});
server.on('error', (e) => {
  // 端口被占用/被拒绝时给出可读提示, 而不是抛一堆栈
  console.error('[subtitle-editor] 启动失败：' + String((e && e.message) || e)
    + (e && e.code === 'EADDRINUSE' ? '（端口 ' + PORT + ' 已被占用：是不是已经开着一个？）' : ''));
});

/* ═══════════ 完全退出 ═══════════
 * 为什么需要它: 发行版是 GUI 子系统的 SubFabric.exe —— 双击后**没有控制台窗口**,
 * 关掉浏览器页面服务照旧在后台跑, 用户以前只能去任务管理器杀进程; 再双击一次也只会
 * 被"端口 8321 已被占用"顶回来。托盘图标(见 startTray)右键「完全退出」就是那个出口。
 *
 * 顺序: ①通知页面收尾(sendBeacon 补存 + 自己关窗) → ②杀子进程 → ③关服务/断长连接 → ④退出。
 * 每一步都有超时兜底 —— 有子进程赖着不走在 Windows 上 close() 可能一直等, 不能让用户晾着。 */
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown] 完全退出：' + (reason || '未注明来源'));
  broadcastLife('shutdown', { reason: String(reason || ''), pid: process.pid });

  // ② ~600ms 后动手: 给页面一点时间把最后一个防抖保存(sendBeacon)发出来
  setTimeout(() => {
    try { if (_localMt) _localMt.stop(); } catch {}
    for (const p of CHILDREN) {
      if (p === trayProc) continue;    // 托盘自己收图标(强杀会留下 Windows"幽灵图标")
      try { p.kill(); } catch {}       // ffmpeg / Python 识别 / 文件选择器
    }
    try {
      server.close(() => {});
      // SSE 与媒体流是长连接, 不主动销毁的话 close() 会一直等它们自己断
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch {}
    setTimeout(() => process.exit(0), 250);
  }, 600);

  // 兜底: 无论如何 4 秒内进程必须消失(端口随之释放)
  setTimeout(() => process.exit(0), 4000);
}

/* ── 任务栏托盘图标(仅 Windows) ─────────────────────────────────
 * 用系统自带的 PowerShell + WinForms NotifyIcon 实现 —— SEA 版 exe 里装不了 npm 原生
 * 模块(托盘类库都要编译原生插件), 而 Windows 一定自带 powershell.exe 与 .NET。
 * 图标脚本: editor/scripts/tray.ps1(菜单: 打开界面 / 完全退出)。
 * 关掉方式: 环境变量 SUBFABRIC_TRAY=0, 或启动参数 --no-tray(自动化测试/无桌面环境)。 */
let trayProc = null;
function startTray() {
  if (process.platform !== 'win32') return;
  if (process.env.SUBFABRIC_TRAY === '0' || process.env.SUBFABRIC_NO_TRAY) return;
  if (process.argv.includes('--no-tray')) return;
  const script = path.join(__dirname, 'scripts', 'tray.ps1');
  if (!fs.existsSync(script)) return;                 // 老版本目录里没有托盘脚本就安静跳过
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', script,
                '-Port', String(PORT), '-ServerPid', String(process.pid), '-Exe', process.execPath,
                '-Version', APP_VERSION];
  const ico = path.join(__dirname, 'scripts', 'tray.ico');
  if (fs.existsSync(ico)) args.push('-Icon', ico);
  try {
    trayProc = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    trayProc.on('error', (e) => {
      trayProc = null;
      console.error('[tray] 托盘图标启动失败：' + ((e && e.message) || e));
    });
    trayProc.on('close', () => { trayProc = null; });
    console.log('[tray] 托盘图标已就绪（右键图标 → 完全退出）');
  } catch (e) {
    console.error('[tray] 托盘图标启动失败：' + ((e && e.message) || e));
  }
}
