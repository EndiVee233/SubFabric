'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FORBIDDEN = new Set(['settings.json', 'perf-result.json', 'models', 'runtime-python', 'runtime-vibevoice', 'whisper.cpp', 'crispasr', 'faster-whisper-xxl', 'ytdlp', 'logs', 'projects', 'videos', 'node_modules', '__pycache__']);
function sourcePath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':') || relative.includes('\0')) throw Error('Invalid payload path');
  const parts = relative.split('/');
  if (!['editor', 'asr'].includes(parts[0]) || parts.some(p => !p || p.startsWith('.') || FORBIDDEN.has(p.toLowerCase()))) throw Error('Unsafe payload path: ' + relative);
  if (parts.some(p => /[ .]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Invalid Windows payload path');
  const allowed = /^editor\/[a-z0-9-]+\.js$/i.test(relative)
    || relative === 'editor/studio.html' || relative === 'editor/wordlist-en.json'
    || /^editor\/(?:js\/[a-z0-9-]+\.js|css\/[a-z0-9-]+\.css|lang\/zh-CN\.json|themes\/[a-z0-9-]+\.theme\.json|assets\/app-logo\.png)$/i.test(relative)
    || ['editor/scripts/7z.exe', 'editor/scripts/7z-README.txt', 'editor/vendor/subtitles-octopus.js', 'editor/vendor/subtitles-octopus-worker.js', 'editor/vendor/subtitles-octopus-worker.wasm', 'editor/vendor/fonts/NotoSansCJKsc-Regular.otf'].includes(relative)
    || /^asr\/(?:[a-z0-9_]+\.py|requirements\.txt|fetch\/[a-z0-9_]+\.py|fetch\/README\.md)$/i.test(relative);
  if (!allowed) throw Error('Non-source payload path: ' + relative);
  return relative;
}
function safePath(root, relative) {
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Path outside payload root');
  for (let p = full; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('Links are not allowed: ' + p);
    if (p === path.dirname(p)) break;
  }
  return full;
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function syncPayload(source, destination, manifest) {
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid backend manifest');
  if (!manifest.files.some(entry => entry.path === 'editor/server.js')) throw Error('Backend entry missing from manifest');
  const seen = new Set();
  // Validate ALL inputs before changing any files; only code and renderer resources can be replaced.
  const entries = manifest.files.map(entry => {
    const relative = sourcePath(entry.path);
    if (seen.has(relative.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid manifest entry');
    seen.add(relative.toLowerCase());
    const src = safePath(source, relative), dst = safePath(destination, relative);
    if (!fs.statSync(src).isFile() || digest(src) !== entry.sha256) throw Error('Backend integrity check failed: ' + relative);
    return { ...entry, src, dst };
  });
  for (const entry of entries) {
    if (fs.existsSync(entry.dst) && digest(entry.dst) === entry.sha256) continue;
    fs.mkdirSync(path.dirname(entry.dst), { recursive: true });
    const temp = entry.dst + '.electron-new-' + crypto.randomBytes(8).toString('hex');
    try { fs.copyFileSync(entry.src, temp); fs.renameSync(temp, entry.dst); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return entries.length;
}
function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}
function externalURL(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}
module.exports = { sourcePath, safePath, digest, syncPayload, sameOrigin, externalURL };
