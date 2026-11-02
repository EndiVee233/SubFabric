/**
 * 存储空间扫描与安全清理（服务端，无 DOM）。
 *
 * 设计原则：
 *  1. **只扫白名单目录**：项目中间文件、ASR 模型、可选运行时、缓存、日志。
 *     用户素材（projects/*\/video、videos/）不在清理范围，避免"清缓存清掉原片"。
 *  2. **id 由服务端生成**：客户端只回传 id，路径永远来自上一次扫描的登记表，
 *     再按前缀边界复核一次；不接受客户端拼路径。
 *  3. **不跟随符号链接**：统计与删除都用 lstat，链接本身按链接处理，绝不深入。
 *  4. **在用资源一律保护**：当前选中/重识别模型、ASR 基础运行时、正在跑任务的项目，
 *     标记为不可清理并给出原因，而不是只靠前端禁用按钮。
 *  5. **删除可重试**：Windows 上文件句柄释放有延迟，EBUSY/EPERM 退避重试。
 *
 * 纯 Node，便于单测；server.js 只负责注入状态与路由。
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/** 项目目录里可由源视频/字幕重新生成的中间产物。
 *  字幕、项目元数据、备注与操作日志不在此列 —— 那是用户成果。 */
const PROJECT_INTERMEDIATE = Object.freeze(['audio.wav', 'peaks.bin', 'asr.json', 'reseg.json', 'draft.log']);

/** asr/ 下可整体删除的运行时目录（基础 Python 环境单独保护）。 */
const RUNTIMES = Object.freeze(['runtime-python', '.venv', 'whisper.cpp', 'crispasr', 'faster-whisper-xxl', 'runtime-vibevoice', 'ytdlp']);
const BASE_RUNTIMES = Object.freeze(['runtime-python', '.venv']);

/** 纯缓存目录：删掉只会触发重建。 */
const CACHE_DIRS = Object.freeze(['asr/__pycache__', 'editor/__pycache__', 'tools/__pycache__']);

const LOG_DIRS = Object.freeze(['logs', 'asr/logs']);
const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const CATEGORY_ORDER = Object.freeze(['project', 'model', 'runtime', 'cache', 'log']);
const CATEGORY_NAMES = Object.freeze({
  project: '项目中间文件', model: '语音模型', runtime: 'ASR 运行时', cache: '缓存', log: '日志',
});

const MAX_SCAN_MS = 20000;
const MAX_ENTRIES = 200000;
const MAX_LOG_ITEMS = 120;

function within(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
function itemId(kind, relative) {
  return kind + ':' + crypto.createHash('sha1').update(kind + '\u0000' + relative).digest('hex').slice(0, 16);
}
function posix(relative) {
  return relative.split(path.sep).join('/');
}

/** 遍历统计。预算按"条数 + 截止时间"双限，超大目录不会把一次请求拖成几十秒。 */
async function measure(target, budget) {
  const out = { size: 0, files: 0, dirs: 0, mtime: 0, truncated: false };
  let stat;
  try { stat = await fsp.lstat(target); } catch { return out; }
  if (stat.isSymbolicLink()) return out;
  if (!stat.isDirectory()) {
    out.size = stat.size; out.files = 1; out.mtime = stat.mtimeMs;
    return out;
  }
  out.dirs = 1;
  const stack = [target];
  while (stack.length) {
    if (budget.expired() || budget.left <= 0) { out.truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      let child;
      try { child = await fsp.lstat(abs); } catch { continue; }
      budget.left--;
      if (child.isSymbolicLink()) continue;          // 链接既不计数也不深入
      if (child.isDirectory()) { out.dirs++; stack.push(abs); }
      else if (child.isFile()) {
        out.size += child.size;
        out.files++;
        if (child.mtimeMs > out.mtime) out.mtime = child.mtimeMs;
      }
      if (budget.expired() || budget.left <= 0) { out.truncated = true; break; }
    }
  }
  return out;
}

/** 删除（不跟随链接）。返回释放的字节数。 */
async function removeDeep(target, attempt = 0) {
  let stat;
  try { stat = await fsp.lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    await fsp.unlink(target);
    return stat.isDirectory() ? 0 : stat.size;
  }
  let freed = 0;
  for (const name of await fsp.readdir(target)) freed += await removeDeep(path.join(target, name), attempt);
  try {
    await fsp.rmdir(target);
  } catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code) && attempt < 7) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return freed + await removeDeep(target, attempt + 1);
    }
    throw error;
  }
  return freed;
}

class StorageService {
  /**
   * @param {object} options
   * @param {string} options.root         程序目录（projects/、asr/、logs/ 的父目录）
   * @param {(id:string)=>boolean} [options.isProjectBusy] 项目是否有识别/导出任务在跑
   * @param {(id:string)=>boolean} [options.isModelBusy]   模型是否被当前进程占用
   * @param {Set<string>} [options.protectedModels]        当前选中/重识别的模型 id
   * @param {Set<string>} [options.protectedRuntimes]      当前必需、不允许删除的运行时目录名
   * @param {number} [options.logKeepMs]                   日志保留期，默认 7 天
   */
  constructor(options = {}) {
    this.root = path.resolve(options.root || '.');
    this.asrDir = path.join(this.root, 'asr');
    this.protectedModels = options.protectedModels || new Set();
    this.protectedRuntimes = new Set([...BASE_RUNTIMES, ...(options.protectedRuntimes || [])]);
    this.isProjectBusy = options.isProjectBusy || (() => false);
    this.isModelBusy = options.isModelBusy || (() => false);
    this.logKeepMs = Number.isFinite(options.logKeepMs) ? options.logKeepMs : LOG_KEEP_MS;
    this.registry = new Map();
    this.scannedAt = 0;
  }

  dir(...parts) { return path.join(this.root, ...parts); }

  async listProjects() {
    const base = this.dir('projects');
    let entries;
    try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
    return entries.filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name)).map(entry => entry.name);
  }

  async projectName(id) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir('projects'), id, 'project.json'), 'utf8'));
      const name = typeof meta.name === 'string' ? meta.name.trim() : '';
      return name.slice(0, 80);
    } catch { return id; }
  }

  /**
   * 扫描一次。返回分类汇总与可清理条目；同时刷新清理用的登记表。
   * @returns {Promise<object>}
   */
  async scan() {
    const started = Date.now();
    const debug = process.env.SUBFABRIC_STORAGE_DEBUG === '1';
    const mark = label => { if (debug) console.log('[storage:debug] ' + label + ' ' + (Date.now() - started) + 'ms'); };
    mark('start');
    const budget = { left: MAX_ENTRIES, deadline: started + MAX_SCAN_MS, expired() { return Date.now() > this.deadline; } };
    const items = [];
    this.registry = new Map();

    const push = (item) => {
      if (!item.size && item.category !== 'project') return;
      this.registry.set(item.id, item);
      items.push(item);
    };

    /* ── 项目中间文件 ─────────────────────────────────────────── */
    for (const id of await this.listProjects()) {
      const dir = this.dir('projects', id);
      const present = [];
      let size = 0, mtime = 0, files = 0;
      for (const name of PROJECT_INTERMEDIATE) {
        const abs = path.join(dir, name);
        let stat;
        try { stat = await fsp.lstat(abs); } catch { continue; }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        present.push(name);
        size += stat.size;
        files++;
        if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
      }
      if (!present.length) continue;
      const busy = !!this.isProjectBusy(id);
      push({
        id: itemId('project', id),
        category: 'project',
        name: await this.projectName(id),
        detail: present.join(' · '),
        path: posix(path.join('projects', id)),
        targets: present.map(name => posix(path.join('projects', id, name))),
        size, files,
        mtime: mtime ? new Date(mtime).toISOString() : null,
        removable: !busy,
        reason: busy ? '识别或导出进行中' : '',
        protected: busy ? ['正在跑任务'] : [],
      });
    }

    mark('projects');
    mark('projects');
    /* ── 语音模型 ─────────────────────────────────────────────── */
    const modelsDir = this.dir('asr', 'models');
    let modelEntries = [];
    try { modelEntries = await fsp.readdir(modelsDir, { withFileTypes: true }); } catch { /* 未安装模型 */ }
    for (const entry of modelEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const abs = path.join(modelsDir, entry.name);
      const measured = await measure(abs, budget);
      const busy = this.isModelBusy(entry.name) || this.protectedModels.has(entry.name);
      push({
        id: itemId('model', entry.name),
        category: 'model',
        name: entry.name,
        detail: busy ? '当前模型或重识别模型' : '重新使用需要再次下载',
        path: posix(path.join('asr', 'models', entry.name)),
        targets: [posix(path.join('asr', 'models', entry.name))],
        size: measured.size,
        files: measured.files,
        mtime: measured.mtime ? new Date(measured.mtime).toISOString() : null,
        removable: !busy,
        reason: busy ? '正在使用或已选中' : '',
        protected: busy ? ['当前识别配置'] : [],
        truncated: measured.truncated,
      });
    }

    mark('models');
    mark('models');
    /* ── ASR 运行时 ───────────────────────────────────────────── */
    for (const name of RUNTIMES) {
      const abs = this.dir('asr', name);
      let stat;
      try { stat = await fsp.lstat(abs); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const measured = await measure(abs, budget);
      const busy = this.protectedRuntimes.has(name);
      push({
        id: itemId('runtime', name),
        category: 'runtime',
        name,
        detail: busy ? '当前识别链路需要它' : '未启用后端，删除后可重新安装',
        path: posix(path.join('asr', name)),
        targets: [posix(path.join('asr', name))],
        size: measured.size,
        files: measured.files,
        mtime: measured.mtime ? new Date(measured.mtime).toISOString() : null,
        removable: !busy,
        reason: busy ? '基础环境或当前后端' : '',
        protected: busy ? ['当前识别后端'] : [],
        truncated: measured.truncated,
      });
    }

    /* ── 缓存 ─────────────────────────────────────────────────── */
    for (const relative of CACHE_DIRS) {
      const abs = this.dir(...relative.split('/'));
      let stat;
      try { stat = await fsp.lstat(abs); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const measured = await measure(abs, budget);
      push({
        id: itemId('cache', relative),
        category: 'cache',
        name: relative.split('/').slice(-1)[0],
        detail: '解释器字节码缓存，删除后自动重建',
        path: relative,
        targets: [relative],
        size: measured.size,
        files: measured.files,
        mtime: measured.mtime ? new Date(measured.mtime).toISOString() : null,
        removable: true,
        reason: '',
        protected: [],
        truncated: measured.truncated,
      });
    }

    /* ── 日志（只列保留期之外的） ─────────────────────────────── */
    const now = Date.now();
    const logs = [];
    for (const relative of LOG_DIRS) {
      const base = this.dir(...relative.split('/'));
      let entries = [];
      try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(?:log|txt)$/i.test(entry.name)) continue;
        const abs = path.join(base, entry.name);
        let stat;
        try { stat = await fsp.lstat(abs); } catch { continue; }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (now - stat.mtimeMs < this.logKeepMs) continue;
        logs.push({
          id: itemId('log', posix(path.join(relative, entry.name))),
          category: 'log',
          name: entry.name,
          detail: relative.replace(/\//g, ' / ') + ' · 超过 7 天',
          path: posix(path.join(relative, entry.name)),
          targets: [posix(path.join(relative, entry.name))],
          size: stat.size, files: 1,
          mtime: new Date(stat.mtimeMs).toISOString(),
          removable: true, reason: '', protected: [],
        });
      }
    }
    logs.sort((a, b) => b.size - a.size);
    logs.slice(0, MAX_LOG_ITEMS).forEach(push);

    mark('logs');
    mark('logs');
    /* ── 汇总 ─────────────────────────────────────────────────── */
    items.sort((a, b) => (CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)) || b.size - a.size);
    const categories = CATEGORY_ORDER.map(category => {
      const list = items.filter(item => item.category === category);
      return {
        id: category, name: CATEGORY_NAMES[category],
        count: list.length,
        size: list.reduce((sum, item) => sum + item.size, 0),
        cleanable: list.filter(item => item.removable).reduce((sum, item) => sum + item.size, 0),
        removable: list.filter(item => item.removable).length,
      };
    });
    mark('before-disk');
    const disk = await this.disk();
    mark('disk');
    this.scannedAt = Date.now();
    return {
      ok: true,
      root: this.root,
      scannedAt: new Date(this.scannedAt).toISOString(),
      durationMs: Date.now() - started,
      truncated: items.some(item => item.truncated) || budget.expired(),
      disk,
      categories,
      items,
      summary: {
        cleanableBytes: categories.reduce((sum, category) => sum + category.cleanable, 0),
        removable: items.filter(item => item.removable).length,
        total: items.length,
      },
    };
  }

  async disk() {
    try {
      const stat = await fsp.statfs(this.root);
      const block = Number(stat.bsize) || 4096;
      const total = Number(stat.blocks) * block;
      const free = Number(stat.bavail) * block;
      return { total, free, used: Math.max(0, total - free) };
    } catch { return { total: 0, free: 0, used: 0 }; }
  }

  /** 删除前复核：路径必须落在本次扫描登记的根目录里，且不是根本身。 */
  allowedTarget(entry, abs) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.targets) || !entry.targets.length) return false;
    const roots = {
      project: [this.dir('projects')],
      model: [this.dir('asr', 'models')],
      runtime: [this.asrDir],
      cache: [this.root],
      log: [this.root],
    }[entry.category];
    if (!roots) return false;
    return roots.some(base => within(base, abs) && !samePath(base, abs));
  }

  /**
   * 清理指定条目。只接受扫描登记过的 id；逐项复核并返回明细。
   * @param {string[]} ids
   */
  async clean(ids) {
    if (!Array.isArray(ids) || !ids.length) return { ok: false, error: '没有选中任何条目' };
    if (!this.scannedAt || Date.now() - this.scannedAt > 30 * 60 * 1000) {
      return { ok: false, error: '扫描结果已过期，请重新扫描' };
    }
    const unique = [...new Set(ids)].slice(0, 200);
    const removed = [];
    const failed = [];
    let freed = 0;
    for (const id of unique) {
      const entry = this.registry.get(id);
      if (!entry) { failed.push({ id, error: '条目已变化，请重新扫描' }); continue; }
      if (!entry.removable) { failed.push({ id, name: entry.name, error: entry.reason || '该条目受保护' }); continue; }
      if (entry.category === 'project' && this.isProjectBusy(path.basename(entry.path))) {
        failed.push({ id, name: entry.name, error: '识别或导出进行中' }); continue;
      }
      let freedHere = 0;
      let error = '';
      for (const relative of entry.targets) {
        const abs = path.resolve(this.root, relative);
        if (!this.allowedTarget(entry, abs)) { error = '路径不在允许范围内'; continue; }
        try {
          let stat;
          try { stat = await fsp.lstat(abs); } catch { continue; }   // 已被别处删掉
          if (stat.isSymbolicLink()) { await fsp.unlink(abs); continue; }
          freedHere += await removeDeep(abs);
        } catch (e) {
          error = (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'))
            ? '文件正被占用，可稍后再试' : String((e && e.message) || e);
        }
      }
      freed += freedHere;
      if (error) failed.push({ id, name: entry.name, error });
      else { removed.push({ id, name: entry.name, size: freedHere }); this.registry.delete(id); }
    }
    return { ok: true, freed, removed, failed };
  }
}

module.exports = {
  StorageService,
  PROJECT_INTERMEDIATE,
  RUNTIMES,
  BASE_RUNTIMES,
  CACHE_DIRS,
  LOG_DIRS,
  LOG_KEEP_MS,
  CATEGORY_NAMES,
  itemId,
  measure,
  removeDeep,
  within,
};
