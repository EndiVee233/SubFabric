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

const ROOT = path.resolve(__dirname, '..'); // D:\subtitle
const PORT = process.env.PORT ? Number(process.env.PORT) : 8321;
const HOST = '127.0.0.1';

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
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** 波形 PNG 宽度: 按时长自适应(约 0.25s/像素), 上限 32000(浏览器单边安全上限)。
 *  固定 2400px 时 2.4h 视频每像素 3.5s, 3 秒的字幕块只切到不到 1 个源像素 →
 *  被横向拉成"平顶柱子"(实测块内起伏系数 0.000); 32000px 后同样 3 秒块有 11 个源像素。 */
function waveWidth(duration) {
  const d = duration > 0 ? duration : 600;
  return Math.max(2400, Math.min(32000, Math.round(d * 4)));
}

/** dur 参数缺失/为 0 时(客户端元数据未就绪)用 ffprobe 探测时长, 保证分辨率自适应 */
function probeDuration(videoPath, cb) {
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  const p = spawn(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { windowsHide: true });
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

function buildPeaks(videoPath, duration, rate, cb) {
  const total = Math.max(20000, Math.min(2000000, Math.round((duration > 0 ? duration : 600) * rate)));
  const spb = (duration > 0 ? duration * PEAK_SR / total : PEAK_SR / rate);   // 每桶样本数(可为小数)
  const proc = spawn(FFMPEG, ['-hide_banner', '-vn', '-i', videoPath,
    '-f', 's16le', '-ac', '1', '-ar', String(PEAK_SR), '-'], { windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', d => { if (stderr.length < 2000) stderr += d; });
  const out = Buffer.allocUnsafe(total);
  let filled = 0, peak = 0, inBucket = 0, carry = null;
  const flush = () => {
    const norm = Math.min(1, (peak / 32768) * PEAK_GAIN);
    if (filled < total) out[filled++] = Math.min(255, Math.round(255 * Math.sqrt(norm)));
    peak = 0; inBucket = 0;
  };
  proc.stdout.on('data', (chunk) => {
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
  proc.on('error', (e) => cb(new Error('ffmpeg 不可用: ' + e.message)));
  proc.on('close', (code) => {
    if (inBucket > 0 || peak > 0) flush();
    if (code !== 0) return cb(new Error('ffmpeg failed: ' + stderr.slice(-200)));
    cb(null, out.subarray(0, filled));
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = u.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 302, { Location: '/editor/index.html' }, '');
  }
  if (pathname === '/api/samples') {
    const body = JSON.stringify(listSamples());
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, body);
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

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');
  serveFile(req, res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`[subtitle-editor] serving ${ROOT}`);
  console.log(`[subtitle-editor] open  http://${HOST}:${PORT}/`);
});
