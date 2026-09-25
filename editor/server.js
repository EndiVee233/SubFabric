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
const { spawn } = require('child_process');
const resegMod = require('./reseg.js');   // 语义分句(LLM 补标点 → 按标点切句), whisper 专用

const ROOT = path.resolve(__dirname, '..'); // D:\subtitle
const PORT = process.env.PORT ? Number(process.env.PORT) : 8321;
const HOST = '127.0.0.1';
const APP_VERSION = '1.2.5'; // 与打版号一致; 改了就顺手同步这里

/* 代码版本戳: 取 editor 下静态资源的最新修改时间(启动时算一次)。
 * 用途: ① index.html 里的 js/css 引用带上 ?v=<戳>, 改了代码刷新必定拿到新的;
 *      ② /api/version 让**已经开着的页面**发现自己过期了 → 提示用户刷新。
 * (用户报过"改了代码但界面还是老的": 单页应用开着不刷新就一直跑旧 JS) */
const BUILD_STAMP = (() => {
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
})();

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

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const p = path.normalize(path.join(root, decoded));
  if (!p.startsWith(root)) return null; // 防目录穿越
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
  const done = (err) => {
    fs.unlink(tmpPng, () => {});
    if (err && !_retry) {
      console.log('[waveform] ffmpeg 失败, 重试一次:', String(err.message || err).slice(0, 200));
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

/** 整段波形: -vn 跳过视频解码(只解音轨); volume=18dB + scale=sqrt 拉起语音振幅(线性只占图高 4%);
 *  宽度按时长自适应, 保证字幕块内能看到真实的语音起伏。 */
function makeWaveform(videoPath, duration, cb, _retry) {
  if (!(duration > 0)) return probeDuration(videoPath, (dur) => makeWaveform(videoPath, dur, cb, _retry));
  const w = waveWidth(duration);
  renderWaveform((tmp) => ['-hide_banner', '-vn', '-i', videoPath,
    '-filter_complex', `volume=18dB,showwavespic=s=${w}x160:colors=FFFFFF:scale=sqrt`,
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

/* ── 峰值数据(推荐方案): 每 1/rate 秒一个包络值(Uint8),
 *    前端按屏幕像素列矢量绘制 → 任意缩放都锐利, 不会像缩放图片那样发糊 ── */
const PEAK_SR = 8000;          // 单声道 8kHz 足够画包络
const PEAK_GAIN = 7.943;       // ≈ +18dB, 把语音振幅拉起来(线性下只占 4% 高度)

/** 峰值分桶采集器: 从 s16le 单声道 PCM 流(inSr 采样率)按 1/rate 秒一桶取包络。
 *  返回 finish(code, stderr) — 流结束后调用, 返回 {buf, code, stderr}。 */
function attachPeakCollector(readable, duration, rate, inSr) {
  const total = Math.max(20000, Math.min(2000000, Math.round((duration > 0 ? duration : 600) * rate)));
  const spb = (duration > 0 ? duration * inSr / total : inSr / rate);   // 每桶样本数(可为小数)
  const out = Buffer.allocUnsafe(total);
  let filled = 0, peak = 0, inBucket = 0, carry = null;
  const flush = () => {
    const norm = Math.min(1, (peak / 32768) * PEAK_GAIN);
    if (filled < total) out[filled++] = Math.min(255, Math.round(255 * Math.sqrt(norm)));
    peak = 0; inBucket = 0;
  };
  readable.on('data', (chunk) => {
    let buf = chunk;
    if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
    const n = buf.length >> 1;
    if (buf.length & 1) carry = buf.subarray(buf.length - 1);
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 2);
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      if (++inBucket >= spb) flush();
    }
  });
  return (code, stderr) => {
    if (inBucket > 0 || peak > 0) flush();
    return { buf: out.subarray(0, filled), code, stderr };
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
    'X-Peak-Rate': String(rate)
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
const pendingAsr = new Map();    // prepare 成功后待跑识别的项目 id -> { wordLevel }
const rerecogJobs = new Map();   // 选区重新识别的后台任务: projectId -> job

const ASR_DIR = path.join(ROOT, 'asr');
const modelsRoot = () => path.join(ASR_DIR, 'models');
const ASR_SCRIPT = path.join(ASR_DIR, 'asr.py');
const ASR_SETTINGS = path.join(ASR_DIR, 'settings.json');
const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '');

/* 可选识别模型。engine 决定推理方式:
 *   sherpa-onnx  → asr.py(sherpa-onnx)
 *   whisper.cpp  → whisper-cli.exe(-oj -ml 1 -sow 词级时间戳)；CPU 跑, A 卡(无 CUDA)也能用 */
const ASR_MODELS = [
  {
    id: 'parakeet-tdt-0.6b-v2',
    name: 'Parakeet TDT 0.6B v2（英语·快）',
    engine: 'sherpa-onnx',
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: ['tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx'],
    sizeMB: 661,
    desc: 'CPU 约 7~19 倍实时，标点与词级时间戳质量好；仅英语',
    dirName: 'parakeet-tdt-0.6b-v2',
  },
  {
    id: 'ggml-large-v3-turbo',
    name: 'Whisper large-v3-turbo（英语·质量优先）',
    engine: 'whisper.cpp',
    repo: 'ggerganov/whisper.cpp',
    files: ['ggml-large-v3-turbo.bin'],
    sizeMB: 1549,
    desc: 'whisper.cpp 引擎，运行时带 Vulkan 后端：A 卡 / N 卡 / Intel 核显都走 GPU 加速（实测 RTX 4060 Ti 快约 126 倍）；无 Vulkan 驱动自动回退 CPU。质量接近 large-v3。',
    dirName: 'ggml-large-v3-turbo',
  },
];
const MODEL_PATTERNS = [/^encoder.*\.onnx$/i, /^decoder.*\.onnx$/i, /^joiner.*\.onnx$/i, /^tokens\.txt$/i,
                        /^ggml-.*\.bin$/i];
const modelById = (id) => ASR_MODELS.find(m => m.id === id) || null;

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
 * 运行时检测到 Vulkan DLL 自动走 GPU; 没有 Vulkan 驱动的机器 whisper.cpp 会自动回退 CPU。 */
const WHISPER_RUNTIME = {
  url: 'https://github.com/jerryshell/whisper.cpp-windows-vulkan-bin/releases/download/v1.0.0/whisper.cpp-windows-vulkan.zip',
  dir: path.join(ASR_DIR, 'whisper.cpp'),
  sizeMB: 18,
};
const whisperCli = () => path.join(WHISPER_RUNTIME.dir, 'whisper-cli.exe');
const whisperRuntimeOk = () => { try { return fs.statSync(whisperCli()).isFile(); } catch { return false; } };
const whisperVulkanOk = () => { try { return fs.statSync(path.join(WHISPER_RUNTIME.dir, 'ggml-vulkan.dll')).isFile(); } catch { return false; } };

/* 初稿流水线阶段名(项目列表上直接显示这个文案)。
 * diarize / reseg(语义分句, whisper 专用) 均已实现。 */
const STAGE = {
  extract: '提取音频中',
  asr: 'ASR识别中',
  diarize: '区分说话人中',
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

function translateCfg() {
  const t = (readAsrSettings().translate) || {};
  const preset = LLM_PRESETS.find(p => p.id === t.provider) || null;
  return {
    provider: t.provider || 'deepseek',
    baseUrl: t.baseUrl || (preset ? preset.baseUrl : ''),
    apiKey: t.apiKey || '',
    model: t.model || (preset ? preset.model : ''),
    autoTranslate: !!t.autoTranslate,
    prompt: t.prompt || DEFAULT_TRANSLATE_PROMPT,
    glossary: t.glossary || '',
    glossaryLang: t.glossaryLang || '简体',
    hasKey: !!t.apiKey,
  };
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
  s.translate = Object.assign(cur, patch);
  writeAsrSettings(s);
  return translateCfg();
}
const llmReady = (cfg) => !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.model);

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

/** Python 解释器: 优先本项目 asr/.venv, 其次环境变量, 最后交给 PATH */
function resolvePython() {
  if (process.env.ASR_PYTHON) return process.env.ASR_PYTHON;
  for (const c of [path.join(ASR_DIR, '.venv', 'Scripts', 'python.exe'),
                   path.join(ASR_DIR, '.venv', 'bin', 'python')]) {
    try { fs.accessSync(c); return c; } catch {}
  }
  return 'python';
}
const ASR_PY = resolvePython();

function readAsrSettings() {
  try { return JSON.parse(fs.readFileSync(ASR_SETTINGS, 'utf8')); } catch { return {}; }
}
function writeAsrSettings(obj) {
  fs.mkdirSync(ASR_DIR, { recursive: true });
  const tmp = ASR_SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, ASR_SETTINGS);
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
  if (!modelById(id)) return;
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
/** 模型是否可用(目录完整); whisper.cpp 引擎还要求运行时就位 */
function modelReady(modelId) {
  const m = modelById(modelId);
  if (!m) return false;
  const dir = modelDirFor(modelId);
  if (!dir || missingModelFiles(dir, m).length) return false;
  if (m.engine === 'whisper.cpp' && !whisperRuntimeOk()) return false;
  return true;
}
/** 当前选中模型的目录(找不到所选就用第一个可用的) */
function resolveAsrModel() {
  const s = readAsrSettings();
  for (const id of [s.selectedModel, ASR_MODELS[0].id]) {
    const m = modelById(id);
    if (m && modelReady(m.id)) return m;
  }
  for (const m of ASR_MODELS) if (modelReady(m.id)) return m;
  return null;
}

/* 模型/运行时下载: Node 内置 fetch + Range 断点续传(保持本项目零 npm 依赖) */
let downloadState = { running: false, kind: '', pct: 0, msg: '', error: null, modelId: '' };

async function downloadFile(url, dest, onProgress) {
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

/** 下载一个识别模型到 dir; 完成后登记进 settings.models */
function startModelDownload(model, dir) {
  if (downloadState.running) return;
  downloadState = { running: true, kind: 'model', pct: 0, msg: '准备下载…', error: null, modelId: model.id, dir };
  (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const base = `${HF_ENDPOINT}/${model.repo}/resolve/main`;
      for (let i = 0; i < model.files.length; i++) {
        const f = model.files[i];
        await downloadFile(`${base}/${f}`, path.join(dir, f), (done, total) => {
          const part = total ? done / total : 0;
          downloadState.pct = Math.min(99, Math.round(((i + part) / model.files.length) * 100));
          downloadState.msg = `下载 ${f}：${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`;
        });
      }
      if (missingModelFiles(dir, model).length) throw new Error('下载后模型仍不完整');
      const s = readAsrSettings();
      s.models = Object.assign({}, s.models || {}, { [model.id]: dir });
      writeAsrSettings(s);
      if (!s.selectedModel) setSelectedModel(model.id);
      downloadState = { running: false, kind: 'model', pct: 100, msg: '下载完成', error: null, modelId: model.id, dir };
    } catch (e) {
      downloadState.running = false;
      downloadState.error = String((e && e.message) || e);
      downloadState.msg = '下载失败: ' + downloadState.error;
    }
  })();
}

/** 下载说话人分离模型(两个文件)到 DIARIZE_DIR() */
function startDiarizeDownload() {
  if (downloadState.running) return;
  downloadState = { running: true, kind: 'diarize', pct: 0, msg: '准备下载分离模型…', error: null, modelId: 'diarize', dir: DIARIZE_DIR() };
  (async () => {
    try {
      fs.mkdirSync(DIARIZE_DIR(), { recursive: true });
      for (let i = 0; i < DIARIZE_MODELS.length; i++) {
        const m = DIARIZE_MODELS[i];
        const dest = path.join(DIARIZE_DIR(), m.file);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) continue;
        const tmp = dest + '.dl';
        await downloadFile(m.url, tmp, (done, total) => {
          downloadState.pct = total ? Math.min(99, Math.round((i + done / total) / DIARIZE_MODELS.length * 100)) : 0;
          downloadState.msg = `下载 ${m.name}：${(done / 1048576).toFixed(1)} MB`;
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
      downloadState = { running: false, kind: 'diarize', pct: 100, msg: '下载完成', error: null, modelId: 'diarize', dir: DIARIZE_DIR() };
    } catch (e) {
      downloadState.running = false;
      downloadState.error = String((e && e.message) || e);
      downloadState.msg = '下载失败: ' + downloadState.error;
    }
  })();
}

/** 下载 whisper.cpp 运行时(zip)并解压出 whisper-cli.exe + DLL */
function startRuntimeDownload() {
  if (downloadState.running) return;
  downloadState = { running: true, kind: 'runtime', pct: 0, msg: '准备下载运行时…', error: null, modelId: '', dir: WHISPER_RUNTIME.dir };
  (async () => {
    const zip = path.join(os.tmpdir(), `kass-whisper-${Date.now().toString(36)}.zip`);
    const cleanup = () => { try { fs.unlinkSync(zip); } catch {} };
    try {
      fs.mkdirSync(WHISPER_RUNTIME.dir, { recursive: true });
      await downloadFile(WHISPER_RUNTIME.url, zip, (done, total) => {
        downloadState.pct = total ? Math.min(99, Math.round(done / total * 100)) : 0;
        downloadState.msg = `下载运行时：${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
      });
      // 解压: Windows 自带的 bsdtar 能解 zip(最可靠); 失败再退回 Expand-Archive。
      // 注意: 必须用**异步 spawn** —— 本环境下 spawnSync 会 EBUSY(实测),
      // 且此处本就在 async IIFE 里, await 天然可用。
      const { spawn } = require('child_process');
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
      let n = 0;
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) walk(p);
          else { fs.copyFileSync(p, path.join(WHISPER_RUNTIME.dir, f.name)); n++; }
        }
      };
      walk(tmpEx);
      fs.rmSync(tmpEx, { recursive: true, force: true });
      if (!whisperRuntimeOk()) throw new Error('解压后未找到 whisper-cli.exe');
      cleanup();
      downloadState = { running: false, kind: 'runtime', pct: 100,
        msg: whisperVulkanOk() ? '运行时就绪（检测到 Vulkan，识别将走 GPU 加速）' : '运行时就绪（未检测到 Vulkan，将用 CPU 模式）',
        error: null, modelId: '', dir: WHISPER_RUNTIME.dir };
    } catch (e) {
      cleanup();
      downloadState.running = false;
      downloadState.error = String((e && e.message) || e);
      downloadState.msg = '运行时下载失败: ' + downloadState.error;
    }
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
    let out = '';
    const started = Date.now();
    let lastPct = -1, lastErrLine = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 30 * 60 * 1000);
    // 进度解析: whisper.cpp 的进度条(%)打在 **stderr**, stdout 只有转写结果 —— 之前只看
    // stdout 导致界面永远收不到进度, 一直停在「启动识别引擎…」(用户报"卡住"实为此因)。
    const sink = (d) => {
      const s = String(d);
      out += s;
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
        return reject(new Error('whisper.cpp 转写失败（退出码 ' + code + '，运行 ' + mins + ' 分钟）' + hint));
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
      const segments = groups.map((ws, i) => ({
        start: +ws[0].start.toFixed(3), end: +ws[ws.length - 1].end.toFixed(3),
        text: ws.map(w => w.word).join(' ').trim(),
        words: ws.map(w => ({ word: w.word, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })),
      }));
      for (let i = 1; i < segments.length; i++) if (segments[i].start < segments[i - 1].end) segments[i].start = segments[i - 1].end;
      resolve({ segments, language: 'en' });
    });
  });
}

function handleRequest(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = u.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 302, { Location: '/editor/index.html' }, '');
  }
  if (pathname === '/api/samples') {
    const body = JSON.stringify(listSamples());
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, body);
  }
  // 代码版本戳: 已经开着的页面用它判断自己是否已过期 → 提示用户刷新
  if (pathname === '/api/version') {
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
      JSON.stringify({ stamp: BUILD_STAMP, version: APP_VERSION }));
  }
  // 站点图标(内联 SVG, 省得浏览器请求 /favicon.ico 报 404 污染控制台)
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#6d5efc"/>'
      + '<text x="16" y="24" font-size="20" text-anchor="middle">🎬</text></svg>';
    return send(res, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }, svg);
  }

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

  /* ═══════════ 项目系统 ═══════════
   * 每个项目一个目录: projects/<id>/project.json + subtitle.{ass,srt} + audio.wav(16k单声道, 给后续 ASR) + peaks.bin(波形包络缓存)
   * 视频不复制: 元数据里记用户选择的本地路径, 播放走 /api/media 按路径 Range 流式; 文件消失 → 客户端要求重选 */
  const PROJECTS_DIR = path.join(ROOT, 'projects');
  const AUDIO_SR = 16000;      // ASR 友好: 16kHz 单声道 s16
  // prepareJobs 定义在模块作用域(跨请求共享), 见 server 创建之前的说明

  function projDir(id) { return path.join(PROJECTS_DIR, id); }
  function metaPath(id) { return path.join(projDir(id), 'project.json'); }
  const validId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

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
  }
  function touchMeta(meta) { meta.modifiedAt = new Date().toISOString(); writeMeta(meta); }

  /** 对外视图: 元数据 + 派生状态(视频是否还在/资产是否就绪/中断修正) */
  function metaView(meta) {
    const v = Object.assign({}, meta);
    v.videoExists = !!(meta.video && meta.video.path && fs.existsSync(meta.video.path));
    v.hasPeaks = !!(meta.peaks && meta.peaks.file && fs.existsSync(path.join(projDir(meta.id), meta.peaks.file)));
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

  function readBody(req, limit, cb) {
    const chunks = []; let size = 0, dead = false;
    req.on('data', c => { size += c.length; if (size > limit) { dead = true; req.destroy(); return; } chunks.push(c); });
    req.on('error', () => { if (!dead) { dead = true; cb(new Error('request body 读取失败')); } });
    req.on('end', () => { if (!dead) cb(null, Buffer.concat(chunks)); });
  }
  const sendJson = (res, code, obj) => send(res, code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, JSON.stringify(obj));

  /** 后台提取: 一次 ffmpeg 同时产出 audio.wav 与 peaks 原始 PCM(asplit), 全部临时文件成功后原子改名 */
  function startPrepare(id, videoPath) {
    if (prepareJobs.has(id)) return;
    const meta = readMeta(id);
    if (!meta) return;
    prepareJobs.add(id);
    meta.prepare = { status: 'running', startedAt: new Date().toISOString(), error: null };
    writeMeta(meta);
    console.log('[project] prepare 开始:', id, videoPath);

    probeDuration(videoPath, (duration) => {
      if (!(duration > 0)) return finishPrepare(id, new Error('无法探测视频时长(ffprobe 失败或文件不可读)'));
      const wavTmp = path.join(projDir(id), 'audio.wav.tmp');
      const pcmTmp = path.join(projDir(id), 'peaks.pcm.tmp');
      const wavOut = path.join(projDir(id), 'audio.wav');
      const peaksOut = path.join(projDir(id), 'peaks.bin');
      const args = ['-hide_banner', '-vn', '-i', videoPath,
        '-filter_complex', `[0:a]aformat=sample_rates=${AUDIO_SR}:channel_layouts=mono,asplit=2[a1][a2]`,
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
        // peaks.pcm.tmp (s16le mono AUDIO_SR) → 分桶包络
        const rate = 100;
        const total = Math.max(20000, Math.min(2000000, Math.round(duration * rate)));
        const inSr = AUDIO_SR;
        const spb = duration * inSr / total;
        const buckets = Buffer.allocUnsafe(total);
        let filled = 0, peak = 0, inBucket = 0, carry = null;
        const flush = () => {
          const norm = Math.min(1, (peak / 32768) * PEAK_GAIN);
          if (filled < total) buckets[filled++] = Math.min(255, Math.round(255 * Math.sqrt(norm)));
          peak = 0; inBucket = 0;
        };
        const rs = fs.createReadStream(pcmTmp);
        rs.on('data', (chunk) => {
          let buf = chunk;
          if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
          const n = buf.length >> 1;
          if (buf.length & 1) carry = buf.subarray(buf.length - 1);
          for (let i = 0; i < n; i++) {
            const s = buf.readInt16LE(i * 2);
            const a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            if (++inBucket >= spb) flush();
          }
        });
        rs.on('error', () => { cleanup(); finishPrepare(id, new Error('波形数据读取失败')); });
        rs.on('end', () => {
          if (inBucket > 0 || peak > 0) flush();
          try {
            fs.writeFileSync(path.join(projDir(id), 'peaks.bin.tmp'), buckets.subarray(0, filled));
            fs.renameSync(path.join(projDir(id), 'peaks.bin.tmp'), peaksOut);
            fs.renameSync(wavTmp, wavOut);
          } catch (e) { return finishPrepare(id, new Error('保存音频/波形失败: ' + e.message)); }
          cleanup();   // 成功分支也要清: peaks.pcm.tmp 是原始 PCM(≈32KB/秒音频),
                       // 漏删会让每个项目长期白占一份与音频等大的临时文件
          finishPrepare(id, null, { duration, peaksBytes: filled, audioBytes: fs.statSync(wavOut).size, rate });
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
      if (info.audioBytes) meta.audio = { file: 'audio.wav', bytes: info.audioBytes };
      if (info.peaksBytes) meta.peaks = { file: 'peaks.bin', rate: info.rate || 100, bytes: info.peaksBytes };
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
  function runDiarize(wav, onProgress) {
    const segModel = path.join(DIARIZE_DIR(), DIARIZE_MODELS[0].file);
    const embModel = path.join(DIARIZE_DIR(), DIARIZE_MODELS[1].file);
    const outJson = wav + '.diarize.json';
    return new Promise((resolve, reject) => {
      const p = spawn(ASR_PY, [path.join(ASR_DIR, 'diarize.py'),
        '--segmentation', segModel, '--embedding', embModel, '--audio', wav, '--out', outJson],
        { windowsHide: true, cwd: ASR_DIR });
      let buf = '', pyErr = '';
      const timer = setTimeout(() => { try { p.kill(); } catch {} }, 30 * 60 * 1000);
      const done = (fn) => { clearTimeout(timer); try { fs.unlinkSync(outJson); } catch {} fn(); };
      p.stderr.on('data', d => {
        const s = String(d);
        if (pyErr.length < 2000) pyErr += s;
        for (const line of s.split('\n')) {
          const tt = line.trim();
          if (!tt.startsWith('{')) continue;
          let o; try { o = JSON.parse(tt); } catch { continue; }
          if (o.type === 'progress' && onProgress) onProgress(o.pct, o.msg);
        }
      });
      p.on('error', e => done(() => reject(new Error('无法启动分离进程: ' + e.message))));
      p.on('close', c => {
        let data = null;
        try { data = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch {}
        if (c !== 0 || !data || !Array.isArray(data.regions)) {
          const m = /"type":"error","msg":"([^"]*)"/.exec(pyErr || '');
          return done(() => reject(new Error((m && m[1]) || ('分离失败（退出码 ' + c + '）'))));
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
   *  用途: 删除项目 / 重新开始初稿时, 防止旧进程变孤儿继续烧 CPU 半小时。 */
  function killDraftProc(id) {
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

  function fmtSrtTime(sec) {
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(Math.min(999, ms)).padStart(3, '0')}`;
  }

  /** ASS 头: 与 main.py generate_ass_header 一致, 保留 Default / 中文字幕 两个样式轨 */
  function assHeader() {
    return '[Script Info]\n'
      + '; Generated by K-ASS-Editor draft (Parakeet TDT 0.6B v2)\n'
      + 'ScriptType: v4.00+\nPlayDepth: 0\nScaledBorderAndShadow: Yes\n'
      + 'PlayResX: 1920\nPlayResY: 1080\nWrapStyle: 3\n\n'
      + '[V4+ Styles]\n'
      + 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
      + 'Style: Default,Comic Sans MS,65,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,3,2,20,20,120,1\n'
      + 'Style: 中文字幕,Comic Sans MS,65,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3.0,2,2,10,10,125,1\n\n'
      + '[Events]\n'
      + 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  }

  /** 一个逐词切片: 文本是**整句全文**, 只有当前词用 {\c&H00ff00&}词{\c} 内联高亮。
   *  这是本编辑器判定逐词特效的格式(karaoke.js 的 HL_RE), 不是 \k 系列标签。
   *  name = 说话人(写进 Name 栏, 编辑器据此显示角色); 角色色只上中文行, 英文行保持绿色高亮。 */
  /** 用户文本 → ASS 安全文本: 花括号会被 libass 当覆盖标签解析, 必须转义(与 karaoke-scribe 同款做法) */
  const escAss = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

  function wordSliceLine(words, idx, start, end, name) {
    const text = words.map((w, i) => (i === idx ? `{\\c&H00ff00&}${escAss(w.word)}{\\c}` : escAss(w.word))).join(' ');
    return `Dialogue: 0,${fmtAssTime(start)},${fmtAssTime(end)},Default,${name || ''},0,0,0,,${text}\n`;
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

  /** 组装初稿字幕: 英文段 segs + 可选中文译文 trans(长度必须等于 segs)。
   *  有译文时 ASS 会多写一轨「中文字幕」行 —— 那才是本编辑器的双语结构 */
  function writeSubtitle(id, wordLevel, segs, trans) {
    const totalWords = segs.reduce((n, s) => n + ((s.words || []).length), 0);
    const hasTrans = Array.isArray(trans) && trans.length === segs.length;
    const hasSpk = segs.some(s => s.speaker != null);
    // 部分翻译时 lines 里会有空洞 —— 空洞不写中文行, 免得出现空字幕
    // 用户要求: 翻译写入时把中文的逗号/顿号/句号替换成空格(! ? 保留不动)
    const zhText = (i) => (hasTrans && String(trans[i] || '').trim())
      ? String(trans[i]).replace(/\n/g, ' ').replace(/[，、。]/g, ' ') : null;
    // 角色行: 行首色标(角色色) + [SPKn] 标记 + Name 栏 —— 编辑器据此显示角色色与角色列表
    const roleOf = (s) => (hasSpk && s.speaker != null) ? {
      n: s.speaker + 1,
      color: assColorFromRgb(ROLE_PALETTE[s.speaker % ROLE_PALETTE.length]),
    } : null;
    const zhLine = (s, t, role) => {
      const tag = role ? `{\\c&H${role.color}&}[SPK${role.n}] ` : '';
      const name = role ? `SPK${role.n}` : '';
      return `Dialogue: 0,${fmtAssTime(s.start)},${fmtAssTime(s.end)},中文字幕,${name},0,0,0,,${tag}${escAss(t)}\n`;
    };

    let format, file, text;
    if (!wordLevel) {
      format = 'srt';
      file = 'subtitle.srt';
      // SRT 双语约定: 第 1 行主语言(中文), 其余为副语言
      text = segs.map((s, i) => {
        const role = roleOf(s);
        const zh = zhText(i);
        let body = s.text;
        if (zh) body = role ? `[SPK${role.n}] ${zh}\n${s.text}` : `${zh}\n${s.text}`;
        return `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${body}\n\n`;
      }).join('');
    } else if (totalWords < 6) {
      // karaoke.js 的 analyzeKaraoke 要求逐词样式至少 6 个事件才认, 词太少会被当普通整句
      // → 每个切片各自成一行、全是重复整句。这里降级为干净整句(但中文轨照写)。
      pushDraftLog(id, `[提示] 识别内容较短（共 ${totalWords} 词），降级为无逐词效果的整句字幕`);
      format = 'ass';
      file = 'subtitle.ass';
      let out = assHeader();
      segs.forEach((s, i) => {
        const zh = zhText(i);
        if (zh) out += zhLine(s, zh, roleOf(s));
        out += `Dialogue: 0,${fmtAssTime(s.start)},${fmtAssTime(s.end)},Default,,0,0,0,,${escAss(s.text)}\n`;
      });
      text = out;
    } else {
      format = 'ass';
      file = 'subtitle.ass';
      let out = assHeader();
      segs.forEach((s, i) => {
        const zh = zhText(i);
        if (zh) out += zhLine(s, zh, roleOf(s));
        const ws = s.words || [];
        for (let k = 0; k < ws.length; k++) {
          const st = ws[k].start;
          // 每片一直高亮到下一词起点(最后一片到句尾), 与 main.py 生成的结果一致
          const en = (k + 1 < ws.length) ? Math.max(ws[k + 1].start, st + 0.01) : Math.max(s.end, st + 0.01);
          const role = roleOf(s);
          out += wordSliceLine(ws, k, st, en, role ? `SPK${role.n}` : '');
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
          message: '语音识别完成。想自动翻译请在右上角「设置」里填接口地址 / API Key / 模型名' });
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
  const TRANS_BATCH = 25;

  function parseJsonArray(text) {
    // 模型常返回 ```json ... ``` 或前后带解释, 这里抠出第一个完整数组
    let s = String(text || '').trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; }
    catch { return null; }
  }

  /** 解析模型的译文回复。除了标准 JSON 数组，还要容忍「逐行纯文本」这种常见跑偏 ——
   *  实测模型会无视 JSON 要求、直接把译文一行行吐出来（用户报的失败正是这个），
   *  这种回复本身是**可用的**，没必要判为失败。 */
  function parseTranslationReply(text, n) {
    const arr = parseJsonArray(text);
    if (arr && arr.length === n) return arr.map(v => String(v == null ? '' : v));

    let s = String(text || '');
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1];
    const chatty = /^\s*(好的|当然|以下是|下面是|翻译如下|这是|注意|说明|Sure|Here|The |Output|Translations)/i;
    const out = [];
    for (let line of s.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line === '[' || line === ']') continue;
      line = line.replace(/^\s*\d+\s*[.、):：]\s*/, '');          // 去掉 "1. " / "2)" 之类编号
      line = line.replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
      if (!line || line === '[' || line === ']' || chatty.test(line)) continue;
      out.push(line);
    }
    return out.length === n ? out : null;
  }

  async function llmChat(cfg, messages) {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, max_tokens: 4096 }),
    });
    let body = null;
    try { body = await resp.json(); } catch { body = null; }
    if (!resp.ok) {
      const msg = body && body.error && (body.error.message || JSON.stringify(body.error));
      throw new Error(msg || ('HTTP ' + resp.status));
    }
    const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (!content) throw new Error('接口返回内容为空');
    return content;
  }

  /** 落盘译文（每批一次），服务重启/刷新后可续翻 */
  function saveTranslations(id, model, lines) {
    const tp = path.join(projDir(id), 'translation.json');
    fs.writeFileSync(tp + '.tmp', JSON.stringify({ model, updatedAt: new Date().toISOString(), lines }));
    fs.renameSync(tp + '.tmp', tp);
  }

  /** 请求一次译文。strict=true 时追加"必须只输出 JSON 数组"的强化指令。 */
  async function translateOnce(cfg, texts, strict) {
    const sys = systemPromptWithGlossary(cfg, strict);
    const content = await llmChat(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: texts.join('\n') },
    ]);
    const arr = parseTranslationReply(content, texts.length);
    if (!arr) throw new Error('返回既不是 JSON 数组、也不是与输入等行数的逐行文本：' + String(content).slice(0, 120));
    return arr;
  }

  /** 翻译一组文本，带**升级式重试**：原提示词 → 强化指令 → 仍失败就**拆成两半**递归。
   *  实测模型偶发无视 JSON 要求直接吐译文行，且同一批用同样提示词重试必然再失败，
   *  所以要换策略 + 缩小批次，而不是原地重试。最多拆到单行。
   *  成功返回与 texts 等长的译文数组；最终失败抛错（调用方决定怎么兜底）。 */
  async function translateLines(cfg, texts, depth = 0) {
    let lastErr = '';
    for (const strict of [false, true]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await translateOnce(cfg, texts, strict); }
        catch (e) {
          lastErr = String((e && e.message) || e);
          await new Promise(r => setTimeout(r, 800));
        }
      }
    }
    if (texts.length > 1 && depth < 5) {
      const mid = Math.ceil(texts.length / 2);
      try {
        const a = await translateLines(cfg, texts.slice(0, mid), depth + 1);
        const b = await translateLines(cfg, texts.slice(mid), depth + 1);
        return a.concat(b);
      } catch (e) { lastErr = String((e && e.message) || e); }
    }
    throw new Error(lastErr || '翻译失败');
  }

  async function translateBatch(cfg, segs, idxs, depth) {
    try { return { texts: await translateLines(cfg, idxs.map(i => segs[i].text), depth) }; }
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
      message: `翻译完成 ${doneN}/${lines.length} 行，还有 ${pendingN} 行未完成 —— 点「重试」续翻`,
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
    const hasAsr = fs.existsSync(path.join(projDir(id), 'asr.json'));
    const wordLevel = !!meta.draft.wordLevel;
    const wavOk = fs.existsSync(path.join(projDir(id), 'audio.wav'));
    // 先做校验再计数：配置不全、点了也不会真正跑的情况，不该消耗重试次数
    if (hasAsr && !llmReady(translateCfg())) {
      return { error: '翻译未配置：请先在右上角「设置」里填写接口地址 / API Key / 模型名' };
    }
    draftJobs.delete(id);
    pendingAsr.delete(id);
    // 统计用户手动续跑的次数：满 SKIP_AFTER_RETRIES 次仍不成功就放开「跳过此步」
    meta.draft.retries = (meta.draft.retries || 0) + 1;
    writeMeta(meta);

    if (hasAsr) {
      // 语义分句还欠着（whisper 项目 + LLM 可用 + 没做完/没跳过）→ 先补这一步再往下走
      if (!meta.draft.resegDone && meta.draft.engine === 'whisper.cpp' && llmReady(translateCfg())) {
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
    startPrepare(id, meta.video && meta.video.path);
    return { ok: true, from: 'extract' };
  }

  /* ═══════════ 选区重新识别（后台任务执行器） ═══════════
   * 进度分段: 切音频 0~10 → 识别 10~72 → 翻译 76~97 → 完毕 100。
   * 任务对象挂在 rerecogJobs, 前端每秒轮询 GET 同名接口。 */
  function startRerecognize(id, start, end, model) {
    const job = {
      start, end, status: 'running', stage: '切音频', progress: 2,
      message: '正在切出音频片段…', error: null, segments: null,
      startedAt: new Date().toISOString(),
    };
    rerecogJobs.set(id, job);
    const setRr = (patch) => Object.assign(job, patch);
    (async () => {
      try {
        const wav = path.join(projDir(id), 'audio.wav');
        const mdir = modelDirFor(model.id);
        if (!mdir || missingModelFiles(mdir, model).length) throw new Error('模型文件不完整（' + model.id + '）');
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
        } else {
          data = await new Promise((resolve, reject) => {
            const py = spawn(ASR_PY, [ASR_SCRIPT, '--model', mdir, '--audio', segWav, '--out', outJson, '--threads', '4',
              ...parakeetHotwordArgs()],
              { windowsHide: true, cwd: ASR_DIR });
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
                return reject(new Error((m && m[1]) || ('识别失败（退出码 ' + c + '）')));
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

        // 3.5) 语义分句(仅 whisper: 它常整段不给标点) —— LLM 补标点 → 按逗号/句号切句。
        //      重识别是小区域, 失败不致命: 回退到原启发式分组继续走。
        if (model.engine === 'whisper.cpp' && llmReady(translateCfg())) {
          setRr({ stage: '语义分句中', progress: 72, message: '语义分句中 …' });
          try {
            const cfgR = translateCfg();
            const before = segs.length;
            segs = await resegMod.resegWithLLM(
              (messages) => llmChat(cfgR, messages), segs,
              (frac, msg) => setRr({ stage: '语义分句中', progress: 72 + Math.round((frac || 0) * 3), message: msg || '语义分句中 …' }));
            setRr({ message: `语义分句完成：${before} 行 → ${segs.length} 行` });
          } catch (e) {
            setRr({ message: '语义分句失败，按标点/停顿兜底：' + String((e && e.message) || e).slice(0, 80) });
          }
        }

        // 4) 用设置里的 LLM 翻译（Key 为空/未配置 → 明确提示, 只返回识别结果）
        const cfg = translateCfg();
        let warning = null;
        if (llmReady(cfg)) {
          setRr({ stage: '翻译中', progress: 76, message: '翻译中 …' });
          const translations = [];
          const chunks = Math.ceil(segs.length / TRANS_BATCH) || 1;
          try {
            for (let i = 0; i < segs.length; i += TRANS_BATCH) {
              const part = await translateLines(cfg, segs.slice(i, i + TRANS_BATCH).map(s => s.text));
              translations.push(...part);
              setRr({ progress: 76 + Math.round((Math.floor(i / TRANS_BATCH) + 1) / chunks * 21),
                message: `翻译中 … ${Math.floor(i / TRANS_BATCH) + 1}/${chunks} 批` });
            }
            if (translations.length === segs.length) segs.forEach((s, i) => { s.zh = String(translations[i] == null ? '' : translations[i]); });
            else warning = '翻译行数不一致，已跳过译文';
          } catch (e) { warning = '翻译失败：' + String((e && e.message) || e); }
        } else {
          warning = 'API Key 为空，未翻译 —— 点右上角「⚙ 设置」填写后可对其它区间使用';
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

  async function startTranslate(id) {
    const cfg = translateCfg();
    if (!llmReady(cfg)) return finishDraft(id, new Error('翻译未配置：请先在主界面右上角「设置」里填写接口地址 / API Key / 模型名'));
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
    pushDraftLog(id, `共 ${n} 行，本次需要翻译 ${todo.length} 行`);

    const batches = [];
    for (let i = 0; i < todo.length; i += TRANS_BATCH) batches.push(todo.slice(i, i + TRANS_BATCH));

    let failedBatches = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const idxs = batches[bi];
      const t0 = Date.now();
      const r = await translateBatch(cfg, segs, idxs, 0);
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

  /** 该项目初稿用哪个模型: meta.draft.modelId 优先, 回退当前选中 */
  function resolveDraftModel(meta) {
    const mid = meta && meta.draft && meta.draft.modelId;
    const m = mid ? modelById(mid) : null;
    return m && modelReady(m.id) ? m : null;
  }

  /** 语义分句(whisper 初稿专用): 读 asr.json → LLM 补标点 → 按逗号/句号切句 → 写回。
   *  成功后 meta.draft.resegDone = true（重试/跳过逻辑靠它判断这一步还欠不欠着）。 */
  async function runDraftReseg(id) {
    const cfg = translateCfg();
    setDraft(id, { status: 'running', stage: STAGE.reseg, progress: 76, message: '语义分句中 …', error: null, failedStage: '' });
    pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 开始语义分句（LLM 补标点 → 按逗号/句号切句）`);
    const p = path.join(projDir(id), 'asr.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const before = (data.segments || []).length;
    const segs2 = await resegMod.resegWithLLM(
      (messages) => llmChat(cfg, messages),
      data.segments || [],
      (frac, msg) => setDraft(id, { stage: STAGE.reseg, progress: 76 + Math.round((frac || 0) * 8), message: msg || '语义分句中 …' }));
    data.segments = segs2;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
    const meta = readMeta(id);
    if (meta && meta.draft) { meta.draft.resegDone = true; writeMeta(meta); }
    pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 语义分句完成：${before} 行 → ${segs2.length} 行`);
  }

  /** 识别之后的两步收尾（模块级, retryDraft 也走这里）:
   *  勾了「区分说话人」且分离模型就绪（且没被跳过）→ 先分离再生成字幕; 否则直接生成。 */
  function continueDraftAfterAsr(id, wordLevel) {
    const meta0 = readMeta(id);
    const d0 = (meta0 && meta0.draft) || {};
    const wantSpk = !!d0.speakers && diarizeReady() && !d0.diarizeSkipped;
    if (wantSpk) {
      const wav = path.join(projDir(id), 'audio.wav');
      setDraft(id, { stage: STAGE.diarize, progress: 82, message: '区分说话人中 …' });
      runDiarize(wav, (pct, msg) => setDraft(id, { stage: STAGE.diarize, progress: 82 + Math.round((pct || 0) * 0.03), message: msg || '区分说话人中 …' }))
        .then(r => safeDraftStep(id, () => {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(projDir(id), 'asr.json'), 'utf8'));
            assignSpeakers(d.segments || [], r.regions || []);
            const tmp = path.join(projDir(id), 'asr.json') + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(d));
            fs.renameSync(tmp, path.join(projDir(id), 'asr.json'));
          } catch (e) { return finishDraft(id, e); }
          buildDraftSubtitle(id, wordLevel);
        }))
        .catch(e => { draftJobs.delete(id); finishDraft(id, e); });
      return;
    }
    buildDraftSubtitle(id, wordLevel);
  }

  function startDraftAsr(id, wordLevel) {
    const model = resolveDraftModel(readMeta(id));
    if (!model) return finishDraft(id, new Error('语音识别模型不可用：请先在设置里下载模型（或换一个已就绪的模型）'));
    const mdir = modelDirFor(model.id);
    draftJobs.add(id);
    const wav = path.join(projDir(id), 'audio.wav');
    const outJson = path.join(projDir(id), 'asr.json');
    try { fs.unlinkSync(draftLogFile(id)); } catch {}
    try { fs.unlinkSync(outJson); } catch {}
    // 换任务/重试时, 精确清掉本项目遗留的识别进程(实测重复启动会双跑抢资源)
    killDraftProc(id);
    setDraft(id, { status: 'running', stage: STAGE.asr, progress: 30, message: '启动识别引擎…' });
    pushDraftLog(id, `[${new Date().toLocaleTimeString()}] 开始语音识别（模型：${model.name}，逐词：${wordLevel ? '开' : '关'}）`);
    if (model.engine === 'whisper.cpp') {
      // GPU(Vulkan)/CPU 模式自动检测: 有 ggml-vulkan.dll 就走 GPU(实测 126 倍于 CPU encode)
      const mode = whisperVulkanOk() ? 'GPU·Vulkan' : 'CPU';
      pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [提示] whisper.cpp ${mode} 推理`
        + (whisperVulkanOk() ? '' : '（未检测到 ggml-vulkan.dll，将用 CPU，速度较慢；可在设置里重新下载运行时获取 GPU 版）'));
    }

    // 识别完成后的收尾三段式: reseg(语义分句, 仅 whisper) → diarize(区分说话人) → 生成字幕。
    // 分离跑在音频上、与识别引擎无关(Parakeet / whisper.cpp 都能配);
    // reseg 只对 whisper 做(它常整段不给标点, 启发式切句会糊成超长行; Parakeet 标点质量好)。
    const finishAsr = () => {
      if (model.engine === 'whisper.cpp') {
        const cfg = translateCfg();
        if (llmReady(cfg)) {
          // whisper 专用: LLM 补标点 → 按逗号/句号切句(用户规则)。
          // 失败可重试/跳过 —— 跳过时按原启发式(标点/停顿/行长)分组。
          runDraftReseg(id)
            .then(() => continueDraftAfterAsr(id, wordLevel))
            .catch(e => { draftJobs.delete(id); finishDraft(id, e); });
          return;
        }
        pushDraftLog(id, `[${new Date().toLocaleTimeString()}] [提示] API Key 为空，跳过语义分句（按标点/停顿兜底切句）`);
      }
      continueDraftAfterAsr(id, wordLevel);
    };

    // ── whisper.cpp 引擎: whisper-cli(词级用 -ml 1 -sow), 结果转成 asr.json ──
    if (model.engine === 'whisper.cpp') {
      const bin = path.join(mdir, model.files[0]);
      runWhisperCpp(bin, wav, (pct, secs) => {
        const t = (secs != null) ? `（已运行 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒）` : '';
        setDraft(id, { stage: STAGE.asr, progress: 30 + Math.round(pct * 0.45), message: `识别中（whisper.cpp·${whisperVulkanOk() ? 'GPU' : 'CPU'}）… ${pct}% ${t}` });
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

    // ── sherpa-onnx 引擎: asr.py ──
    let lastErr = '', buf = '';
    const proc = spawn(ASR_PY,
      [ASR_SCRIPT, '--model', mdir, '--audio', wav, '--out', outJson, '--threads', '4',
        ...parakeetHotwordArgs()],
      { windowsHide: true, cwd: ASR_DIR });
    draftProcs.set(id, proc);

    const sink = (chunk) => {
      buf += String(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
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
      if (code !== 0) { draftJobs.delete(id); return finishDraft(id, new Error(lastErr || ('识别进程异常退出（代码 ' + code + '）'))); }
      finishAsr();
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
    const filter = kind === 'video'
      ? 'Video|*.mp4;*.m4v;*.webm;*.mkv;*.avi;*.mov|All files|*.*'
      : 'Subtitle|*.srt;*.ass;*.ssa|All files|*.*';
    const title = kind === 'video' ? 'Select video file' : 'Select subtitle file';
    const tmp = path.join(os.tmpdir(), `kass-pick-${process.pid}-${Date.now().toString(36)}.txt`);
    const tmpPs = tmp.replace(/'/g, "''");

    const ps = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$form = New-Object System.Windows.Forms.Form',
      '$form.TopMost = $true',
      '$form.Opacity = 0',
      isFolder ? '$d = New-Object System.Windows.Forms.FolderBrowserDialog'
               : '$d = New-Object System.Windows.Forms.OpenFileDialog',
      isFolder ? "$d.Description = '选择语音识别模型存放目录(必须为空目录)'"
               : `$d.Title = '${title}'`,
      isFolder ? '$d.ShowNewFolderButton = $true' : `$d.Filter = '${filter}'`,
      ...(isFolder ? [] : ['$d.CheckFileExists = $true']),
      '$r = $d.ShowDialog($form)',
      `$p = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { ${isFolder ? '$d.SelectedPath' : '$d.FileName'} } else { '' }`,
      // 显式 UTF-8 无 BOM 写盘, 与 Node 侧的读取编码对齐
      `[System.IO.File]::WriteAllText('${tmpPs}', $p, (New-Object System.Text.UTF8Encoding($false)))`,
    ].join('; ');

    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
    let errText = '';
    p.stdout.on('data', () => {});                     // 丢弃: 只看临时文件
    p.stderr.on('data', d => { if (errText.length < 1500) errText += String(d); });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 5 * 60 * 1000);
    p.on('error', () => {
      clearTimeout(timer); cleanup();
      cb({ cancelled: true, error: '无法打开系统对话框' });
    });
    p.on('close', () => {
      clearTimeout(timer);
      let raw = '';
      try { raw = fs.readFileSync(tmp, 'utf8'); } catch {}
      cleanup();
      if (!raw.trim() && errText.trim()) {
        return cb({ cancelled: true, error: '系统对话框出错: ' + errText.trim().slice(0, 300) });
      }
      if (!raw.trim()) return cb({ cancelled: true });
      const resolved = normalizePickedPath(raw, isFolder);
      if (!resolved) {
        return cb({ cancelled: true, error: '对话框返回的路径无法解析（' + raw.trim().slice(0, 200) + '）' });
      }
      cb({ path: resolved, name: path.basename(resolved) });
    });
  }

  // ── 路由 ──
  if (pathname === '/api/pick' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (err, body) => {
      let kind = 'video';
      try { kind = (JSON.parse(body.toString('utf8')) || {}).kind || 'video'; } catch {}
      nativePick(kind, r => sendJson(res, 200, r));   // 'video' | 'sub' | 'folder' 统一走一个实现
    });
  }

  /* ═══════════ 初稿 / 语音识别模型 ═══════════ */
  if (pathname === '/api/asr/status' && req.method === 'GET') {
    let pythonOk = false;
    try { pythonOk = fs.statSync(ASR_PY).isFile(); } catch {}
    const models = ASR_MODELS.map(m => {
      const dir = modelDirFor(m.id);
      const missing = missingModelFiles(dir, m);
      return {
        id: m.id, name: m.name, engine: m.engine, desc: m.desc, sizeMB: m.sizeMB,
        dir, missing, ready: !missing.length && (m.engine !== 'whisper.cpp' || whisperRuntimeOk()),
        needRuntime: m.engine === 'whisper.cpp' && !whisperRuntimeOk(),
      };
    });
    return sendJson(res, 200, {
      models,
      selectedModel: selectedModelId(),
      runtime: { ok: whisperRuntimeOk(), dir: WHISPER_RUNTIME.dir, url: WHISPER_RUNTIME.url, sizeMB: WHISPER_RUNTIME.sizeMB },
      diarize: { ready: diarizeReady(), models: DIARIZE_MODELS },
      // 兼容旧前端字段
      ready: models.some(m => m.ready),
      python: ASR_PY, pythonOk,
      download: downloadState,
    });
  }
  /** 校验用户选的目录能否用来放模型: 必须存在、且是空目录 */
  if (pathname === '/api/asr/check-dir' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (err, body) => {
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
        reason: empty ? '' : `目录不是空的（已有 ${names.length} 项），请选择一个空目录` });
    });
  }
  /** 下载识别模型(带 modelId)或 whisper.cpp 运行时(kind='runtime') */
  if (pathname === '/api/asr/download' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (err, body) => {
      let p = {}, modelId = '', kind = 'model';
      try {
        const j = JSON.parse(body.toString('utf8')) || {};
        p = String(j.dir || '').trim(); modelId = String(j.modelId || '').trim(); kind = j.kind || 'model';
      } catch {}
      if (kind === 'runtime') {
        if (whisperRuntimeOk()) return sendJson(res, 200, { started: false, ready: true });
        startRuntimeDownload();
        return sendJson(res, 200, { started: true, kind: 'runtime' });
      }
      if (kind === 'diarize') {
        if (diarizeReady()) return sendJson(res, 200, { started: false, ready: true });
        startDiarizeDownload();
        return sendJson(res, 200, { started: true, kind: 'diarize' });
      }
      const model = modelById(modelId) || resolveAsrModel() || ASR_MODELS[0];
      if (!model) return sendJson(res, 400, { error: '未知模型' });
      // 未指定目录 → 用默认目录(asr/models/<dirName>)
      if (!p) p = path.join(modelsRoot(), model.dirName);
      // 目录里已经有完整模型 → 直接采纳, 不用重下
      if (missingModelFiles(p, model).length === 0) {
        const s = readAsrSettings();
        s.models = Object.assign({}, s.models || {}, { [model.id]: p });
        writeAsrSettings(s);
        return sendJson(res, 200, { started: false, ready: true, dir: p });
      }
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      if (names.length) return sendJson(res, 400, { error: `目录不是空的（已有 ${names.length} 项）。请选择一个空目录，避免模型文件与你的其它文件混在一起` });
      startModelDownload(model, p);
      return sendJson(res, 200, { started: true, dir: p, modelId: model.id });
    });
  }
  /** 删除一个模型(连同目录) */
  if (pathname === '/api/asr/delete' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (err, body) => {
      let modelId = '';
      try { modelId = String((JSON.parse(body.toString('utf8')) || {}).modelId || ''); } catch {}
      const m = modelById(modelId);
      if (!m) return sendJson(res, 400, { error: '未知模型' });
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
    return readBody(req, 64 * 1024, (err, body) => {
      let modelId = '';
      try { modelId = String((JSON.parse(body.toString('utf8')) || {}).modelId || ''); } catch {}
      if (!modelById(modelId)) return sendJson(res, 400, { error: '未知模型' });
      setSelectedModel(modelId);
      return sendJson(res, 200, { selected: modelId });
    });
  }

  /* ═══════════ 翻译(LLM) 配置 ═══════════ */
  if (pathname === '/api/translate/config' && req.method === 'GET') {
    const c = translateCfg();
    return sendJson(res, 200, {
      presets: LLM_PRESETS, cfg: c, ready: llmReady(c), defaultPrompt: DEFAULT_TRANSLATE_PROMPT,
    });
  }
  if (pathname === '/api/translate/config' && req.method === 'POST') {
    return readBody(req, 256 * 1024, (err, body) => {
      let p = {};
      try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const keep = {};
      for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'autoTranslate', 'prompt', 'glossary', 'glossaryLang']) {
        if (Object.prototype.hasOwnProperty.call(p, k)) keep[k] = p[k];
      }
      const c = saveTranslateCfg(keep);
      return sendJson(res, 200, { cfg: c, ready: llmReady(c) });
    });
  }
  /* 识别提示词 / 热词: 存 asr/settings.json 的 asr 段 */
  if (pathname === '/api/asr/hint') {
    // GET 顺带返回实际会喂给引擎的词(用户填的 + 术语表原文列自动派生的), 便于核对
    if (req.method === 'GET') return sendJson(res, 200, Object.assign({ hint: asrHintCfg() }, asrTerms()));
    if (req.method === 'POST') {
      return readBody(req, 256 * 1024, (err, body) => {
        let p = {};
        try { p = JSON.parse(body.toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const keep = {};
        for (const k of ['prompt', 'hotwordsScore']) if (Object.prototype.hasOwnProperty.call(p, k)) keep[k] = p[k];
        return sendJson(res, 200, { hint: saveAsrHint(keep) });
      });
    }
    return sendJson(res, 405, { error: '仅支持 GET / POST' });
  }

  if (pathname === '/api/translate/test' && req.method === 'POST') {
    const c = translateCfg();
    if (!llmReady(c)) return sendJson(res, 400, { error: '请先填写接口地址 / API Key / 模型名' });
    llmChat(c, [{ role: 'user', content: '只回复一个单词：ok' }])
      .then(t => sendJson(res, 200, { ok: true, reply: String(t).slice(0, 200) }))
      .catch(e => sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }));
    return;
  }
  if (pathname === '/api/media' && req.method === 'GET') {
    const p = u.searchParams.get('path') || '';
    const full = path.normalize(p);
    let ok = false;
    try { ok = fs.statSync(full).isFile() && VIDEO_EXTS.includes(path.extname(full).toLowerCase()); } catch {}
    if (!ok) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'video not found: ' + p);
    return serveFile(req, res, full);      // serveFile 自带 Range 支持
  }

  let pm = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})(?:\/([a-z]+))?$/.exec(pathname);
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
        video: meta.video, videoExists: v.videoExists, format: meta.subtitle && meta.subtitle.format,
        subName: meta.subtitle && meta.subtitle.name, prepare: meta.prepare, draft: v.draft });
    }
    items.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
    return sendJson(res, 200, { projects: items });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    return readBody(req, 256 * 1024 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let data; try { data = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      // 再规整一次: 客户端送来的路径若带杂物, 这里同样能从"存在的最长前缀"里救回来
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
      let format = null, file = null, subName = '', subText = '';

      if (draftOn) {
        const m = (draftModelId && modelById(draftModelId)) || resolveAsrModel();
        if (!m) return sendJson(res, 400, { error: '尚未配置语音识别模型：请先在设置里下载（Parakeet / Whisper large-v3-turbo 均可）' });
        const mdir = modelDirFor(m.id);
        if (missingModelFiles(mdir, m).length) return sendJson(res, 400, { error: `模型 ${m.name} 不完整: 请在设置里重新下载` });
        if (m.engine === 'whisper.cpp' && !whisperRuntimeOk()) return sendJson(res, 400, { error: 'whisper.cpp 运行时未就绪：请在设置里下载' });
        if (wantSpeakers && !diarizeReady()) return sendJson(res, 400, { error: '说话人分离模型未就绪：请先在设置里下载（约 32MB）' });
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
        createdAt: now, modifiedAt: now,
        video: { path: vp, name: path.basename(vp) },
        prepare: { status: 'none' }
      };
      if (file) meta.subtitle = { format, file, name: subName };
      if (draftOn) {
        const draftModel = (draftModelId && modelById(draftModelId)) || resolveAsrModel() || null;
        meta.draft = {
          status: 'running', stage: STAGE.extract, progress: 3,
          message: '提取音频与波形…', wordLevel, lines: 0, words: 0,
          translated: false, needTranslate: false,
          modelId: draftModel ? draftModel.id : null,
          engine: draftModel ? (draftModel.engine || '') : '',
          speakers: wantSpeakers, speakerCount: wantSpeakers ? speakerCount : 0,
          startedAt: now, error: null,
        };
      }
      writeMeta(meta);
      if (draftOn) pendingAsr.set(id, { wordLevel });   // prepare 完成后由 finishPrepare 接手识别
      startPrepare(id, vp);       // 后台提取音频 + 波形
      return sendJson(res, 200, metaView(readMeta(id)));   // 重读: startPrepare 已把 prepare 置为 running
    });
  }
  if (pm) {
    const id = pm[1], action = pm[2] || '';
    const meta = readMeta(id);
    if (!meta) return sendJson(res, 404, { error: '项目不存在' });

    if (!action && req.method === 'GET') return sendJson(res, 200, metaView(meta));

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
      return readBody(req, 64 * 1024, (err, body) => {
        let start = NaN, end = NaN;
        try {
          const p = JSON.parse(body.toString('utf8')) || {};
          start = parseFloat(p.start); end = parseFloat(p.end);
        } catch {}
        if (!(start >= 0) || !(end > start)) return sendJson(res, 400, { error: '时间范围无效' });
        const wav = path.join(projDir(id), 'audio.wav');
        if (!fs.existsSync(wav)) return sendJson(res, 400, { error: '该项目没有已保存的音频（audio.wav），无法重新识别' });
        // 模型: 该项目初稿用的优先, 否则当前选中的
        const model = resolveDraftModel(meta) || resolveAsrModel();
        if (!model) return sendJson(res, 400, { error: '语音识别模型不可用，请先完成模型下载' });
        const prev = rerecogJobs.get(id);
        if (prev && prev.status === 'running') return sendJson(res, 400, { error: '已有一个重新识别任务在运行' });
        startRerecognize(id, start, end, model);
        return sendJson(res, 200, { started: true, model: { id: model.id, name: model.name } });
      });
    }
    // 任务状态(前端每秒轮询): {status, stage, progress, message, error, segments}
    if (action === 'rerecognize' && req.method === 'GET') {
      return sendJson(res, 200, { job: rerecogJobs.get(id) || null });
    }

    // 手动触发翻译(自动翻译没勾选时点「翻译」按钮走这里)
    if (action === 'translate' && req.method === 'POST') {
      const cfg = translateCfg();
      if (!llmReady(cfg)) return sendJson(res, 400, { error: '翻译未配置：请先在主界面右上角「设置」里填写接口地址 / API Key / 模型名' });
      // 识别/提取还在跑时字幕文件还不存在 —— 此时允许**排队**，而不是报"没有字幕"
      const inFlight = draftJobs.has(id) || pendingAsr.has(id);
      if (!meta.subtitle && !inFlight) return sendJson(res, 400, { error: '该项目还没有初稿字幕' });
      return readBody(req, 64 * 1024, (err, body) => {
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

    // 初稿进度详情: 状态 + 滚动日志(供列表上的「查看进度」弹窗轮询)
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
      return readBody(req, 256 * 1024 * 1024, (err2, body) => {
        if (err2) return sendJson(res, 400, { error: String(err2.message) });
        const file = meta.subtitle && meta.subtitle.file;
        if (!file) return sendJson(res, 400, { error: '项目缺少字幕文件信息' });
        const subTmp = path.join(projDir(id), file) + '.tmp';
        fs.writeFileSync(subTmp, body, 'utf8');
        fs.renameSync(subTmp, path.join(projDir(id), file));   // 原子替换, 打开方不会读到半截字幕
        touchMeta(meta);
        return sendJson(res, 200, { ok: true, savedAt: meta.modifiedAt });
      });
    }
    if (action === 'subtitle' && req.method === 'GET') {
      const file = meta.subtitle && meta.subtitle.file;
      return serveFile(req, res, path.join(projDir(id), file || 'subtitle.ass'));
    }
    if (action === 'relink' && req.method === 'POST') {
      return readBody(req, 64 * 1024, (err2, body) => {
        if (err2) return sendJson(res, 400, { error: String(err2.message) });
        let vp; try { vp = (JSON.parse(body.toString('utf8')) || {}).videoPath || ''; } catch { vp = ''; }
        let ok = false;
        try { ok = fs.statSync(vp).isFile() && VIDEO_EXTS.includes(path.extname(vp).toLowerCase()); } catch {}
        if (!ok) return sendJson(res, 400, { error: '视频文件不存在或格式不支持: ' + vp });
        meta.video = { path: vp, name: path.basename(vp) };
        touchMeta(meta);
        const v = metaView(meta);
        if (!v.hasPeaks) startPrepare(id, vp);
        return sendJson(res, 200, metaView(meta));
      });
    }
    if (action === 'prepare' && req.method === 'POST') {
      if (!(meta.video && meta.video.path)) return sendJson(res, 400, { error: '项目还没有视频' });
      const v = metaView(meta);
      if (!v.videoExists) return sendJson(res, 400, { error: '视频文件不存在，请先重新选择' });
      if (!v.hasPeaks) startPrepare(id, meta.video.path);
      return sendJson(res, 200, metaView(readMeta(id)));
    }
    if (action === 'peaks' && req.method === 'GET') {
      const v = metaView(meta);
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
});
server.on('error', (e) => {
  // 端口被占用/被拒绝时给出可读提示, 而不是抛一堆栈
  console.error('[subtitle-editor] 启动失败：' + String((e && e.message) || e)
    + (e && e.code === 'EADDRINUSE' ? '（端口 ' + PORT + ' 已被占用：是不是已经开着一个？）' : ''));
});
