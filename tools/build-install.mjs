import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROTECTED = new Set(['vendor', 'models', 'runtime-python', 'runtime-vibevoice', 'whisper.cpp', 'crispasr', 'ytdlp', 'projects', 'logs', 'node_modules', '__pycache__', '.venv']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.py', '.ps1', '.cmd', '.bat', '.command', '.svg', '.ico', '.png', '.md']);
/** 递归复制目录：**不要用 fs.cpSync**。
 *  Windows + 非 ASCII 源路径（中文项目目录很常见）时，cpSync 会让整个进程 fast-fail
 *  （0xC0000409，没有任何错误输出），打包步骤会静默崩掉 —— repair12 那条测试就是被它
 *  卡在 0xC0000409 上的（测试的临时目录叫「源码」「安装」）。copyFileSync 走同样的路径完全正常，
 *  所以这里自己递归一遍，代价只有几行。 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}

export function sourceFiles(dev) {
  const result = [];
  function walk(dir, relative) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) throw Error('Source links are not allowed: ' + e.name);
      if (e.name.startsWith('.') || PROTECTED.has(e.name.toLowerCase())) continue;
      const rel = path.join(relative, e.name), full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if ((SOURCE_EXT.has(path.extname(e.name).toLowerCase()) || e.name === 'requirements.txt') && !['settings.json', 'perf-result.json'].includes(e.name.toLowerCase())) result.push(rel);
    }
  }
  for (const dir of ['editor', 'asr', 'tests', 'tools']) walk(path.join(dev, dir), dir);
  for (const file of ['main.py', 'start-editor.bat', 'start-editor.command']) if (fs.existsSync(path.join(dev, file))) result.push(file);
  return result;
}
const defaultRun = (command, args, cwd, env) => {
  const r = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true, timeout: 30 * 60 * 1000 });
  if (r.error || r.status !== 0) throw r.error || Error(command + ' failed: ' + r.status);
};
function safeInstallPath(inst, rel) {
  const target = path.resolve(inst, rel), relative = path.relative(inst, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Invalid install path');
  for (let p = target; p !== path.dirname(p); p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('Install links are not allowed: ' + p);
  }
  return target;
}
export function installStaged(dev, inst, files, hooks = {}) {
  if (!fs.statSync(inst).isDirectory()) throw Error('Installation directory does not exist');
  const lockPath = path.join(inst, '.subfabric-update.lock');
  const lock = fs.openSync(lockPath, 'wx');
  let stage, keep = false;
  const changes = [], madeDirs = [];
  try {
    stage = fs.mkdtempSync(path.join(path.dirname(inst), '.subfabric-update-'));
    const staged = path.join(stage, 'new'), backup = path.join(stage, 'backup');
    for (const rel of files) {
      safeInstallPath(inst, rel);
      const dest = path.join(staged, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(rel === 'SubFabric.exe' ? path.join(dev, 'build/SubFabric.exe') : path.join(dev, rel), dest);
    }
    // 先移开旧 EXE：运行中被占用会在更新源码之前失败，更新期间也不能启动混合版本。
    for (const rel of ['SubFabric.exe', ...files.filter(f => f !== 'SubFabric.exe')]) {
      const target = safeInstallPath(inst, rel), saved = path.join(backup, rel);
      const existed = fs.existsSync(target);
      if (existed && !fs.lstatSync(target).isFile()) throw Error('Install target is not a file: ' + rel);
      const missing = []; for (let p = path.dirname(target); !fs.existsSync(p); p = path.dirname(p)) missing.push(p);
      for (const p of missing.reverse()) { fs.mkdirSync(p); madeDirs.push(p); }
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      if (existed) fs.renameSync(target, saved);
      changes.push({ rel, target, saved, existed });
      if (rel !== 'SubFabric.exe') {
        hooks.beforeApply?.(rel);
        fs.renameSync(path.join(staged, rel), target);
      }
    }
    hooks.beforeApply?.('SubFabric.exe');
    fs.renameSync(path.join(staged, 'SubFabric.exe'), path.join(inst, 'SubFabric.exe'));
  } catch (error) {
    const failures = [];
    for (const c of changes.reverse()) {
      try { if (fs.existsSync(c.target)) fs.unlinkSync(c.target); if (c.existed) fs.renameSync(c.saved, c.target); }
      catch (e) { failures.push(e.message); }
    }
    for (const dir of madeDirs.reverse()) { try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') failures.push(e.message); } }
    if (failures.length) {
      keep = true;
      fs.writeFileSync(path.join(stage, 'RECOVERY.json'), JSON.stringify({ changes, failures }, null, 2));
      throw Error(error.message + '; rollback needs recovery from ' + stage);
    }
    throw error;
  } finally {
    fs.closeSync(lock); fs.unlinkSync(lockPath);
    if (stage && !keep) fs.rmSync(stage, { recursive: true, force: true });
  }
}
export async function buildAndInstall(config, hooks = {}) {
  const dev = path.resolve(config.dev), inst = path.resolve(config.inst);
  if (dev === inst) throw Error('Source and installation must be different directories');
  const run = hooks.run || defaultRun, env = { ...process.env, npm_config_cache: path.join(dev, '.npm-cache') };
  const server = path.join(dev, 'editor/server.js');
  const version = /APP_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(server, 'utf8'))?.[1];
  if (!version) throw Error('APP_VERSION missing');
  run(process.execPath, ['--check', server], dev, env);
  const exe = path.join(dev, 'build/SubFabric.exe'), previous = exe + '.previous-' + process.pid;
  if (fs.existsSync(exe)) fs.renameSync(exe, previous);
  try {
    run(config.python, ['-u', path.join(dev, 'build_exe.py')], dev, env);
    const fd = fs.openSync(exe, 'r'), magic = Buffer.alloc(2);
    try { if (fs.fstatSync(fd).size < 3 || fs.readSync(fd, magic) !== 2 || magic.toString() !== 'MZ') throw Error('Invalid EXE output'); }
    finally { fs.closeSync(fd); }
  } catch (e) {
    if (fs.existsSync(exe)) fs.unlinkSync(exe);
    if (fs.existsSync(previous)) fs.renameSync(previous, exe);
    throw e;
  }
  if (fs.existsSync(previous)) fs.unlinkSync(previous);
  const files = sourceFiles(dev);
  if (config.package) {
    if (!config.iscc || !fs.existsSync(config.iscc)) throw Error('Inno Setup compiler not found');
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-package-'));
    try {
      for (const rel of files) { const dest = path.join(packageRoot, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(dev, rel), dest); }
      copyDir(path.join(dev, 'build/installer'), path.join(packageRoot, 'build/installer'));
      fs.copyFileSync(exe, path.join(packageRoot, 'build/SubFabric.exe'));
      const vendor = fs.existsSync(path.join(dev, 'editor/vendor')) ? path.join(dev, 'editor/vendor') : path.join(inst, 'editor/vendor');
      if (!fs.existsSync(vendor)) throw Error('Package requires editor/vendor');
      copyDir(vendor, path.join(packageRoot, 'editor/vendor'));
      const iss = path.join(packageRoot, 'build/installer/SubFabric.iss');
      run(config.iscc, [iss], packageRoot, env);
      const name = `SubFabric-${version}-setup.exe`, packaged = path.join(packageRoot, 'build/installer', name);
      if (!fs.existsSync(packaged)) throw Error('Installer output missing');
      fs.copyFileSync(packaged, path.join(dev, 'build/installer', name));
    } finally { fs.rmSync(packageRoot, { recursive: true, force: true }); }
  }
  if (config.install) installStaged(dev, inst, [...files, 'SubFabric.exe'], hooks);
  return { version, installed: !!config.install, packaged: !!config.package };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), base = process.env.SUBFABRIC_BASE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (args.some(a => !['--no-install', '--package'].includes(a))) { console.error('Unknown build argument'); process.exitCode = 1; }
  else {
    const inst = process.env.SUBFABRIC_INST || base;
    try {
      const result = await buildAndInstall({ dev: process.env.SUBFABRIC_DEV || path.join(base, 'dev'), inst,
        python: process.env.SUBFABRIC_PY || path.join(inst, 'asr/runtime-python/python.exe'),
        iscc: process.env.SUBFABRIC_ISCC || path.join(process.env.LOCALAPPDATA || '', 'Programs/Inno Setup 6/ISCC.exe'),
        install: !args.includes('--no-install'), package: args.includes('--package') });
      console.log(JSON.stringify(result));
    } catch (e) { console.error('[ERROR] ' + e.message); process.exitCode = 1; }
  }
}
