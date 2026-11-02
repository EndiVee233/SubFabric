'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

// Only user-owned state is migrated. Application source and packaged runtimes are never
// copied over a new installation. Sources stay in place as a rollback path.
const WORKSPACE_STATE = [
  'asr/settings.json', 'asr/perf-result.json', 'asr/.qwen-runtime-ok.json',
  'asr/models', 'asr/runtime-python', 'asr/runtime-vibevoice', 'asr/whisper.cpp',
  'asr/crispasr', 'asr/faster-whisper-xxl', 'asr/ytdlp', 'asr/logs', 'asr/.venv',
  'projects', 'videos', 'logs', 'samples', 'tools/ffmpeg'
];
const PROFILE_STATE = ['Local Storage/leveldb', 'Preferences', 'Secure Preferences'];
const LEGACY_PORTS = [8321, 8322, 8323, 8324];

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function samePath(a, b) { return path.resolve(a) === path.resolve(b); }
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function assertRealFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw Error('Migration links are not allowed: ' + file);
  return stat;
}
async function copyMissing(source, destination, options = {}) {
  const result = { files: 0, bytes: 0, skipped: 0, copied: [] };
  if (!fs.existsSync(source)) return result;
  if (fs.existsSync(destination) && options.preserveTree) {
    result.skipped++;
    return result;
  }
  const stat = assertRealFile(source);
  if (stat.isDirectory()) {
    if (fs.existsSync(destination) && !assertRealFile(destination).isDirectory()) throw Error('Migration destination is not a directory: ' + destination);
    await fs.promises.mkdir(destination, { recursive: true });
    for (const name of await fs.promises.readdir(source)) {
      const nested = await copyMissing(path.join(source, name), path.join(destination, name), options);
      result.files += nested.files; result.bytes += nested.bytes; result.skipped += nested.skipped;
      result.copied.push(...nested.copied);
    }
    return result;
  }
  if (!stat.isFile()) throw Error('Unsupported migration entry: ' + source);
  if (fs.existsSync(destination)) { result.skipped++; return result; }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temp = destination + '.migration-' + crypto.randomBytes(8).toString('hex');
  try {
    await fs.promises.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
    if (await digest(source) !== await digest(temp)) throw Error('Migrated file failed integrity verification: ' + source);
    await fs.promises.rename(temp, destination);
    result.files++; result.bytes += stat.size; result.copied.push(destination);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return result;
}
function mergeResult(target, addition) {
  target.files += addition.files; target.bytes += addition.bytes; target.skipped += addition.skipped;
  target.copied.push(...addition.copied);
}
function rebasePath(value, legacyRoot, dataRoot) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const relative = path.relative(legacyRoot, value);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return value;
  return path.join(dataRoot, relative);
}
function rewriteJson(file, mutate) {
  let before;
  try { before = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return false; }   // A malformed legacy JSON is preserved rather than blocking startup.
  const after = mutate(structuredClone(before));
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  const temp = file + '.rebase-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temp, JSON.stringify(after, null, 2));
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return true;
}
function rebaseCopiedState(copied, legacyRoot, dataRoot) {
  let rebased = 0;
  for (const file of copied) {
    if (!inside(dataRoot, file)) continue;
    const relative = path.relative(dataRoot, file).split(path.sep).join('/');
    if (relative === 'asr/settings.json') {
      rebased += rewriteJson(file, settings => {
        if (typeof settings.modelsRoot === 'string') settings.modelsRoot = rebasePath(settings.modelsRoot, legacyRoot, dataRoot);
        if (typeof settings.pythonExe === 'string') settings.pythonExe = rebasePath(settings.pythonExe, legacyRoot, dataRoot);
        if (settings.models && typeof settings.models === 'object' && !Array.isArray(settings.models)) {
          for (const [id, directory] of Object.entries(settings.models)) settings.models[id] = rebasePath(directory, legacyRoot, dataRoot);
        }
        return settings;
      }) ? 1 : 0;
    } else if (/^projects\/[^/]+\/project\.json$/.test(relative)) {
      rebased += rewriteJson(file, project => {
        if (project.video && typeof project.video === 'object') project.video.path = rebasePath(project.video.path, legacyRoot, dataRoot);
        return project;
      }) ? 1 : 0;
    }
  }
  return rebased;
}
async function migrateLegacyWorkspace(legacyRoot, dataRoot) {
  const result = { files: 0, bytes: 0, skipped: 0, copied: [], rebased: 0 };
  if (!legacyRoot || !fs.existsSync(legacyRoot) || samePath(legacyRoot, dataRoot)) return result;
  if (inside(legacyRoot, dataRoot) || inside(dataRoot, legacyRoot)) throw Error('Legacy and current data directories must not contain each other');
  for (const relative of WORKSPACE_STATE) {
    mergeResult(result, await copyMissing(path.join(legacyRoot, relative), path.join(dataRoot, relative)));
  }
  result.rebased = rebaseCopiedState(result.copied, legacyRoot, dataRoot);
  delete result.copied;
  return result;
}
async function migrateLegacyProfile(legacyProfile, profileRoot) {
  const result = { files: 0, bytes: 0, skipped: 0, copied: [] };
  if (!legacyProfile || !fs.existsSync(legacyProfile) || samePath(legacyProfile, profileRoot)) return result;
  for (const relative of PROFILE_STATE) {
    // LevelDB files from two profiles must never be interleaved. If a current profile
    // already exists, its complete Local Storage directory wins.
    mergeResult(result, await copyMissing(path.join(legacyProfile, relative), path.join(profileRoot, relative), { preserveTree: true }));
  }
  delete result.copied;
  return result;
}
function hasWorkspaceState(root) {
  return !!root && WORKSPACE_STATE.some(relative => fs.existsSync(path.join(root, relative)));
}
function readReport(dataRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(dataRoot, '.migration-v1.json'), 'utf8')); }
  catch { return {}; }
}
function writeReport(dataRoot, patch) {
  const report = { ...readReport(dataRoot), ...patch, updatedAt: new Date().toISOString() };
  const file = path.join(dataRoot, '.migration-v1.json');
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(temp, file);
  return report;
}
function migrationPage() {
  return '<!doctype html><meta charset="utf-8"><title>SubFabric 状态迁移</title>'
    + '<style>body{font:16px system-ui;max-width:620px;margin:12vh auto;padding:24px;background:#16181d;color:#f4f4f5}p{color:#b7bdc9}code{color:#8ec5ff}</style>'
    + '<h1>正在继承旧版界面设置</h1><p id="state">请保持此页面打开，不要关闭 SubFabric。</p>'
    + '<script>(async()=>{const state=document.getElementById("state");try{const values={};'
    + 'for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);values[key]=localStorage.getItem(key)}'
    + 'const response=await fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:1,values})});'
    + 'const result=await response.json();if(!response.ok)throw Error(result.error||"迁移请求失败");'
    + 'if(result.next){location.replace(result.next)}else{state.textContent="界面设置已继承，可以关闭此页面并返回 SubFabric。";document.title="SubFabric 迁移完成"}'
    + '}catch(error){state.textContent="迁移未完成："+error.message+"。旧数据未被修改，请重试。"}})();</script>';
}
function parseBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Error('Browser state is too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.version !== 1 || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw Error('Invalid browser state');
        for (const [key, value] of Object.entries(body.values)) if (typeof key !== 'string' || typeof value !== 'string') throw Error('Invalid browser state entry');
        resolve(body.values);
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}
async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const error = error => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}
async function importLegacyBrowserState({ ports = LEGACY_PORTS, openExternal, timeoutMs = 60000 } = {}) {
  if (typeof openExternal !== 'function') throw Error('A browser opener is required');
  if (!Array.isArray(ports) || !ports.length || new Set(ports).size !== ports.length
    || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw Error('Invalid legacy browser ports');
  const token = crypto.randomBytes(32).toString('hex');
  const states = new Map(), servers = new Map();
  let timer, settled = false, finish = () => {};
  const cleanup = () => {
    clearTimeout(timer);
    for (const server of servers.values()) { server.closeAllConnections?.(); server.close(); }
  };
  try {
    for (const port of ports) {
      const origin = 'http://127.0.0.1:' + port;
      const route = '/__subfabric-migrate__/' + token;
      const server = http.createServer(async (req, res) => {
        const send = (status, body, type = 'application/json; charset=utf-8') => {
          res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
          res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
        };
        try {
          if (req.headers.host !== '127.0.0.1:' + port || new URL(req.url, origin).pathname !== route) return send(404, { error: 'Not found' });
          if (req.method === 'GET') return send(200, migrationPage(), 'text/html; charset=utf-8');
          if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
          if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Wrong origin' });
          const values = await parseBody(req);
          states.set(origin, values);
          const index = ports.indexOf(port);
          const next = ports[index + 1];
          send(200, { ok: true, next: next ? 'http://127.0.0.1:' + next + route : null });
          if (states.size === ports.length) finish();
        } catch (error) { if (!res.headersSent) send(400, { error: error.message }); }
      });
      await listen(server, port);
      servers.set(port, server);
    }
    const completion = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Legacy browser migration timed out')), timeoutMs);
      finish = () => {
        if (settled) return;
        settled = true;
        const values = {};
        // The canonical SEA port (8321) wins if the VBS launcher previously split
        // preferences across several origins; keys unique to other ports survive.
        for (const port of [...ports].reverse()) Object.assign(values, states.get('http://127.0.0.1:' + port));
        resolve({ values, origins: [...states.keys()], keys: Object.keys(values).length });
      };
    });
    await openExternal('http://127.0.0.1:' + ports[0] + '/__subfabric-migrate__/' + token);
    return await completion;
  } finally { cleanup(); }
}
async function applyBrowserState(window, values) {
  const entries = Object.entries(values || {});
  if (!entries.length) return 0;
  return window.webContents.executeJavaScript(`(() => {
    const values = ${JSON.stringify(Object.fromEntries(entries))};
    let imported = 0;
    for (const [key, value] of Object.entries(values)) {
      if (localStorage.getItem(key) === null) { localStorage.setItem(key, value); imported++; }
    }
    return imported;
  })()`);
}
module.exports = {
  WORKSPACE_STATE, LEGACY_PORTS, migrateLegacyWorkspace, migrateLegacyProfile,
  hasWorkspaceState, readReport, writeReport, importLegacyBrowserState, applyBrowserState,
  copyMissing, digest
};
