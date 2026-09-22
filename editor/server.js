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

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');
  serveFile(req, res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`[subtitle-editor] serving ${ROOT}`);
  console.log(`[subtitle-editor] open  http://${HOST}:${PORT}/`);
});
