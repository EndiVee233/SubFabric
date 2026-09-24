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
  }

  /** 原生「打开文件」对话框(Windows PowerShell); 返回 {path,name} 或 {cancelled:true} */
  function nativePick(kind, cb) {
    const filter = kind === 'video'
      ? 'Video|*.mp4;*.m4v;*.webm;*.mkv;*.avi;*.mov|All files|*.*'
      : 'Subtitle|*.srt;*.ass;*.ssa|All files|*.*';
    const title = kind === 'video' ? 'Select video file' : 'Select subtitle file';
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$form = New-Object System.Windows.Forms.Form',
      '$form.TopMost = $true',
      '$form.Opacity = 0',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Title = '${title}'`,
      `$d.Filter = '${filter}'`,
      "$d.CheckFileExists = $true",
      "if ($d.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }"
    ].join('; ');
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 5 * 60 * 1000);
    p.on('error', () => { clearTimeout(timer); cb({ cancelled: true, error: '无法打开系统文件对话框' }); });
    p.on('close', () => {
      clearTimeout(timer);
      const pth = out.trim();
      cb(pth ? { path: pth, name: path.basename(pth) } : { cancelled: true });
    });
  }

  // ── 路由 ──
  if (pathname === '/api/pick' && req.method === 'POST') {
    return readBody(req, 64 * 1024, (err, body) => {
      let kind = 'video';
      try { kind = (JSON.parse(body.toString('utf8')) || {}).kind || 'video'; } catch {}
      nativePick(kind, r => sendJson(res, 200, r));
    });
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
        subName: meta.subtitle && meta.subtitle.name, prepare: meta.prepare });
    }
    items.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
    return sendJson(res, 200, { projects: items });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    return readBody(req, 256 * 1024 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: String(err.message) });
      let data; try { data = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      const vp = String((data.video && data.video.path) || '');
      let ok = false;
      try { ok = fs.statSync(vp).isFile() && VIDEO_EXTS.includes(path.extname(vp).toLowerCase()); } catch {}
      if (!ok) return sendJson(res, 400, { error: '视频文件不存在或格式不支持: ' + vp });
      const subName = String((data.subtitle && data.subtitle.name) || '');
      const subText = String((data.subtitle && data.subtitle.text) || '');
      const m = /\.(srt|ass|ssa)$/i.exec(subName);
      if (!m) return sendJson(res, 400, { error: '字幕文件需为 .srt / .ass / .ssa' });
      const format = m[1].toLowerCase() === 'srt' ? 'srt' : 'ass';
      const id = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const file = format === 'srt' ? 'subtitle.srt' : 'subtitle.ass';
      fs.mkdirSync(projDir(id), { recursive: true });
      fs.writeFileSync(path.join(projDir(id), file), subText, 'utf8');
      const now = new Date().toISOString();
      const meta = {
        id, name: String(data.name || '').trim() || path.basename(vp, path.extname(vp)),
        createdAt: now, modifiedAt: now,
        video: { path: vp, name: path.basename(vp) },
        subtitle: { format, file, name: subName },
        prepare: { status: 'none' }
      };
      writeMeta(meta);
      startPrepare(id, vp);       // 后台提取音频 + 波形
      return sendJson(res, 200, metaView(readMeta(id)));   // 重读: startPrepare 已把 prepare 置为 running
    });
  }
  if (pm) {
    const id = pm[1], action = pm[2] || '';
    const meta = readMeta(id);
    if (!meta) return sendJson(res, 404, { error: '项目不存在' });

    if (!action && req.method === 'GET') return sendJson(res, 200, metaView(meta));
    if (!action && req.method === 'DELETE') {
      try { fs.rmSync(projDir(id), { recursive: true, force: true }); } catch (e) { return sendJson(res, 500, { error: String(e.message) }); }
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
});

server.listen(PORT, HOST, () => {
  console.log(`[subtitle-editor] serving ${ROOT}`);
  console.log(`[subtitle-editor] open  http://${HOST}:${PORT}/`);
});
