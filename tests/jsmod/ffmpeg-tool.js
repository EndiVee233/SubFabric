/**
 * ffmpeg / ffprobe 的定位与自动获取。
 *
 * 为什么要单独一个模块：ffmpeg 原本只是"环境变量 → 两个硬编码路径 → PATH"三段式，
 * 找不到就把裸字符串 'ffmpeg' 交给 spawn —— 结果是子进程 ENOENT，而所有调用处
 * 都把异常吞掉了，于是"没装 ffmpeg"会表现成"没有可用编码器"，界面上看起来像是
 * 显卡驱动问题。这里把"找工具"这件事做成显式、可诊断、能自愈的：
 *
 *   1. 环境变量 FFMPEG_PATH / FFPROBE_PATH（用户显式指定，最高优先级，绝不覆盖）
 *   2. 程序自带目录（下文 TOOL_DIR）—— 上次自动下载到这里的
 *   3. 常见安装路径
 *   4. PATH
 *   5. 都没有 → 可以按需自动下载一份放进 TOOL_DIR
 *
 * 下载来源用 gyan.dev 的 essentials 构建（Windows 上最常用的 ffmpeg 静态分发，
 * 单 zip、含 ffmpeg/ffprobe/ffplay、约 30MB）。解包用 Windows 自带 tar，
 * 不额外依赖 7zip —— 项目本来就是"后端零 npm 依赖"。
 *
 * 所有跨请求状态（下载进度）都放模块作用域。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** 自动下载的落点：<repo>/tools/ffmpeg/（与 tools/ 下其它脚本同级，已在 .gitignore 排除产物） */
const TOOL_DIR = path.resolve(__dirname, '..', 'tools', 'ffmpeg');

/**
 * 下载源。**顺序有意义**：实测同一台机器上 GitHub 约 800KB/s，gyan.dev 只有约 64KB/s
 * （109MB 的包：GitHub 约 2 分钟，gyan.dev 要 29 分钟）。所以 GitHub 优先，gyan.dev 兜底。
 *
 * GitHub 的资产名带版本号（ffmpeg-9.0.2-essentials_build.zip），不能写死 URL，
 * 先问 API 要最新 release 再挑资产；API 限流或网络不通时退回 gyan.dev 的滚动地址。
 */
const GITHUB_REPO = 'GyanD/codexffmpeg';
const FALLBACK_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const ASSET_RE = /ffmpeg-[\d.]+-essentials_build\.zip$/i;

const DOWNLOAD = {
  win32: {
    probe: 'ffprobe.exe',
    ffmpeg: 'ffmpeg.exe',
  },
};
const SUPPORTED = () => !!DOWNLOAD[process.platform];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function runnable(bin) {
  if (!bin) return false;
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return r.status === 0;
}

/**
 * 下载一个文件到 dest。
 *
 * 为什么有 via='powershell' 这条路：实测有些 Windows 机器（装了 TLS 拦截 / 企业代理 /
 * 缺中间证书）Node 的 fetch 会报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，而系统证书库是好的
 * —— 此时 `node --use-system-ca` 能过，但我们改不了**正在运行**的进程的 TLS 选项，
 * 所以改用 PowerShell 的 Invoke-WebRequest（走 Windows 证书库）兜底。
 * 这个项目本来就用 PowerShell 做原生文件对话框，不算新增依赖。
 *
 * @param {'node'|'powershell'} via
 */
async function downloadOne(url, dest, report, via) {
  if (via === 'node') {
    /* 卡死检测：实测遇到过连接建立后只下到 19MB 就不再出数据、也不报错的死连接。
     * 只靠一个"总超时"会干等 30 分钟，所以这里用"无数据 60 秒即中止"的看门狗：
     * 每收到一块数据就把计时器重置。 */
    const ctl = new AbortController();
    const STALL_MS = 60 * 1000;
    let stallTimer = setTimeout(() => ctl.abort(new Error('下载卡住（60 秒没有收到数据）')), STALL_MS);
    const bump = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ctl.abort(new Error('下载卡住（60 秒没有收到数据）')), STALL_MS);
    };
    try {
      const resp = await fetch(url, {
        redirect: 'follow', headers: { 'User-Agent': 'SubFabric/1.0' },
        signal: ctl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total = Number(resp.headers.get('content-length') || 0);
      const ws = fs.createWriteStream(dest);
      let done = 0;
      let lastTick = 0;
      try {
        const reader = resp.body.getReader();
        for (;;) {
          const { done: fin, value } = await reader.read();
          if (fin) break;
          bump();
          const buf = Buffer.from(value);
          done += buf.length;
          if (!ws.write(buf)) await new Promise(r => ws.once('drain', r));
          const now = Date.now();
          if (now - lastTick > 200) {          // 节流，别把前端刷爆
            lastTick = now;
            report(total ? 3 + (done / total) * 80 : 10,
              `下载中 ${(done / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`);
          }
        }
        await new Promise((res, rej) => ws.end(e => (e ? rej(e) : res())));
      } catch (e) {
        try { ws.destroy(); } catch { /* ignore */ }
        throw e;
      }
      return;
    } finally {
      clearTimeout(stallTimer);
    }
  }

  // PowerShell：拿不到总大小（Invoke-WebRequest 不回报），靠轮询文件大小显示已下载量
  if (process.platform !== 'win32') throw new Error('PowerShell 兜底仅适用于 Windows');
  const esc = (s) => String(s).replace(/'/g, "''");
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    `Invoke-WebRequest -Uri '${esc(url)}' -OutFile '${esc(dest)}' -UseBasicParsing`,
  ].join('; ');
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, timeout: 30 * 60 * 1000, encoding: 'utf8',
  });
  if (child.status !== 0) {
    throw new Error('PowerShell 下载失败: ' + String(child.stderr || '').trim().split(/\r?\n/).slice(-1)[0]);
  }
  report(83, '下载完成');
}

/**
 * 取一段 JSON。Node 的 fetch 在缺中间证书的机器上会挂，此时用 PowerShell 再试一次
 * （走 Windows 证书库）。这样即使 Node 的 TLS 有问题，也能解析到 GitHub 的快源地址。
 */
async function fetchJson(url, timeoutMs = 15000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'SubFabric/1.0', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    if (process.platform !== 'win32') throw e;
    const esc = (s) => String(s).replace(/'/g, "''");
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
      `$r = Invoke-WebRequest -Uri '${esc(url)}' -UseBasicParsing -Headers @{'User-Agent'='SubFabric/1.0'}`,
      '$r.Content',
    ].join('; ');
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: timeoutMs + 5000, encoding: 'utf8',
    });
    if (child.status !== 0) throw e;
    return JSON.parse(child.stdout);
  }
}

/**
 * 依次尝试的候选下载地址。
 * @returns {Promise<Array<{url:string, name:string}>>}
 */
async function downloadSources() {
  const out = [];
  try {
    const j = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    const asset = (j.assets || []).find(a => ASSET_RE.test(a.name || ''));
    if (asset && asset.browser_download_url) {
      out.push({ url: asset.browser_download_url, name: asset.name });
    }
  } catch { /* 拿不到就用兜底地址 */ }
  out.push({ url: FALLBACK_URL, name: 'ffmpeg-release-essentials.zip' });
  return out;
}

/** 在某个目录下深度优先找可执行文件名（解包后层级不固定）。 */
function findIn(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findIn(path.join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 自动下载落点里的 ffmpeg/ffprobe（不论解包成什么层级都能找到）。 */
function bundled() {
  const spec = DOWNLOAD[process.platform];
  if (!spec) return { ffmpeg: null, ffprobe: null };
  return {
    ffmpeg: findIn(TOOL_DIR, spec.ffmpeg) || (isFile(path.join(TOOL_DIR, spec.ffmpeg)) ? path.join(TOOL_DIR, spec.ffmpeg) : null),
    ffprobe: findIn(TOOL_DIR, spec.probe) || (isFile(path.join(TOOL_DIR, spec.probe)) ? path.join(TOOL_DIR, spec.probe) : null),
  };
}

const COMMON_PATHS = {
  win32: {
    ffmpeg: ['D:/Program Files/ffmpeg/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe',
      'C:/Program Files/ffmpeg/bin/ffmpeg.exe'],
    ffprobe: ['D:/Program Files/ffmpeg/bin/ffprobe.exe', 'C:/ffmpeg/bin/ffprobe.exe',
      'C:/Program Files/ffmpeg/bin/ffprobe.exe'],
  },
};

/**
 * 解析一个工具。返回 { bin, source, ok }：
 *   source = 'env' | 'bundled' | 'common' | 'path' | 'missing'
 * 命中但跑不起来的会继续往后找（用户可能把 FFMPEG_PATH 指到一个空文件上）。
 */
function resolve(name, envKey) {
  const spec = DOWNLOAD[process.platform];
  const exe = spec ? spec[name] : name;

  const env = String(process.env[envKey] || '').trim();
  if (env) {
    if (runnable(env)) return { bin: env, source: 'env', ok: true };
    // 显式指定却跑不起来：如实报告，不要偷偷换成别处的版本（用户会以为自己的配置生效了）
    return { bin: env, source: 'env', ok: false, error: `${envKey} 指向的文件无法运行: ${env}` };
  }

  const b = bundled();
  const bundledBin = name === 'ffmpeg' ? b.ffmpeg : b.ffprobe;
  if (bundledBin && runnable(bundledBin)) return { bin: bundledBin, source: 'bundled', ok: true };

  const common = (COMMON_PATHS[process.platform] || {})[name] || [];
  for (const c of common) {
    if (isFile(c) && runnable(c)) return { bin: c, source: 'common', ok: true };
  }

  // PATH：交给 spawn 解析一次；跑得通就记裸名
  if (runnable(exe)) return { bin: exe, source: 'path', ok: true };

  return { bin: exe, source: 'missing', ok: false, error: `找不到可用的 ${name}` };
}

/** 当前解析结果（每次调用都重新探测 —— 下载完成后要立刻生效，不能吃旧缓存）。 */
function locate() {
  const ffmpeg = resolve('ffmpeg', 'FFMPEG_PATH');
  const ffprobe = resolve('ffprobe', 'FFPROBE_PATH');
  return {
    ffmpeg, ffprobe,
    ok: ffmpeg.ok && ffprobe.ok,
    toolDir: TOOL_DIR,
    canAutoDownload: SUPPORTED() && !(ffmpeg.source === 'env' && !ffmpeg.ok),
  };
}

/* 下载进度放模块作用域（跨请求可见）。 */
const downloadState = {
  running: false, pct: 0, message: '', error: '', startedAt: 0, finishedAt: 0,
};
function state() {
  return Object.assign({}, downloadState, { toolDir: TOOL_DIR, supported: SUPPORTED() });
}
function patch(p) {
  Object.assign(downloadState, p, {});
  return state();
}

/**
 * 下载并安装一份 ffmpeg 到 TOOL_DIR。
 * 幂等：已有可用副本时直接返回；正在下载则拒绝重入。
 *
 * @param {(pct:number, msg:string)=>void} [onProgress]
 */
async function ensureFfmpeg(onProgress = () => {}) {
  const spec = DOWNLOAD[process.platform];
  if (!spec) {
    throw new Error('自动下载目前只支持 Windows；其它系统请用 FFMPEG_PATH 指定路径，或把 ffmpeg 加入 PATH');
  }
  const cur = locate();
  if (cur.ok && cur.ffmpeg.source !== 'missing') {
    return { ok: true, already: true, ...cur };
  }
  if (downloadState.running) throw new Error('ffmpeg 正在下载中，请稍候');

  patch({ running: true, pct: 0, message: '准备下载…', error: '', startedAt: Date.now(), finishedAt: 0 });
  const report = (pct, message) => {
    patch({ pct: Math.max(0, Math.min(100, Math.round(pct))), message });
    try { onProgress(pct, message); } catch { /* 忽略回调异常 */ }
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ffmpeg-'));
  const zip = path.join(tmpDir, 'ffmpeg.zip');
  try {
    fs.mkdirSync(TOOL_DIR, { recursive: true });

    report(2, '连接下载服务器…');
    const sources = await downloadSources();
    let lastErr = null;
    let got = false;
    for (const src of sources) {
      for (const via of ['node', 'powershell']) {
        try {
          report(3, `连接 ${src.url.includes('github') ? 'GitHub' : 'gyan.dev'}（${via === 'node' ? '直连' : '系统证书'}）…`);
          await downloadOne(src.url, zip, report, via);
          const size = fs.statSync(zip).size;
          if (size < 10 * 1024 * 1024) throw new Error(`文件太小（${size} 字节），可能不是完整的 ffmpeg 包`);
          got = true;
          break;
        } catch (e) {
          lastErr = e;
          try { if (fs.existsSync(zip)) fs.unlinkSync(zip); } catch { /* ignore */ }
        }
      }
      if (got) break;
    }
    if (!got) throw new Error('所有下载源都失败：' + String((lastErr && lastErr.message) || lastErr));
    report(86, '解压中…');

    /* 用系统自带 tar 解 zip。Windows 10 1803+ 自带 bsdtar，能直接解 zip；
     * 项目打包项目包（project-pack.js）用的也是它，所以这不是新依赖。 */
    const unpackDir = path.join(tmpDir, 'unpack');
    fs.mkdirSync(unpackDir, { recursive: true });
    const tar = spawnSync('tar', ['-xf', zip, '-C', unpackDir], {
      encoding: 'utf8', windowsHide: true, timeout: 180000,
    });
    if (tar.status !== 0) {
      throw new Error('解压失败（系统 tar 不可用或压缩包损坏）: ' + String(tar.stderr || '').slice(0, 200));
    }

    const srcFfmpeg = findIn(unpackDir, spec.ffmpeg);
    const srcFfprobe = findIn(unpackDir, spec.probe);
    if (!srcFfmpeg || !srcFfprobe) throw new Error('解压后没找到 ffmpeg.exe / ffprobe.exe');

    report(94, '安装中…');
    // 放在 bin/ 子目录，与管理其它工具的习惯一致
    const binDir = path.join(TOOL_DIR, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(srcFfmpeg, path.join(binDir, spec.ffmpeg));
    fs.copyFileSync(srcFfprobe, path.join(binDir, spec.probe));

    const after = locate();
    if (!after.ok) throw new Error('安装完成但 ffmpeg 仍无法运行');
    patch({ running: false, pct: 100, message: '已就绪', finishedAt: Date.now() });
    return { ok: true, already: false, ...after };
  } catch (e) {
    const msg = String((e && e.message) || e);
    patch({ running: false, message: '下载失败', error: msg, finishedAt: Date.now() });
    throw new Error(msg);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  TOOL_DIR,
  locate,
  ensureFfmpeg,
  state,
  patch,
  findIn,
  runnable,
  SUPPORTED,
};
