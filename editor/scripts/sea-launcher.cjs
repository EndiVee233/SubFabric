/* SubFabric 单文件启动器(打进 SEA exe 的入口脚本)。
 *
 * 目标: 用户双击 SubFabric.exe 就能打开界面 —— 无需装 Node、无需手动开浏览器。
 * 行为:
 *   ① 若 8321 已有实例在跑(比如用户重复双击) → 直接开浏览器指向它, 本进程退出;
 *   ② 否则从 exe 同目录加载 editor/server.js 并执行(Module._compile 方式,
 *      让 server.js 里的 __dirname 指向 <exe目录>/editor, ROOT 解析才正确);
 *   ③ 轮询端口就绪后自动打开浏览器。
 * 注意: 打包后的 exe 启动时 Node 会尝试从 exe 自身读资源, require 内置模块正常;
 *      用户代码必须走 Module._compile 注入, 不能直接 require 相对路径(SEA 不支持)。 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/* GUI 子系统构建下没有控制台, console 写 stdout 可能 throw(EBADF) —— 全部静默化。
 * 运行日志改为进 UI「日志」页(server.js 的 SSE 缓冲), 这里只留安全兜底。 */
for (const k of ['log', 'error', 'warn', 'info']) {
  const orig = typeof console[k] === 'function' ? console[k].bind(console) : () => {};
  console[k] = (...a) => { try { orig(...a); } catch {} };
}

const PORT = 8321;
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}/`;

function probePort() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, HOST);
    s.setTimeout(500);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => { try { s.destroy(); } catch {} resolve(false); });
    s.on('timeout', () => { try { s.destroy(); } catch {} resolve(false); });
  });
}

function openBrowser(url) {
  /* 优先 Edge 应用模式(--app): 独立无边框窗口、无地址栏 → 桌面应用观感。
   * 注意: 不带 --user-data-dir —— 独立新 profile 会触发 Edge 首次运行的"登录到 Edge"
   * 向导(实测点了确定窗口直接没了); 用用户现有 Edge 配置则早已初始化, 直接开窗口。 */
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const cand = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const edge = cand.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  try {
    if (edge) {
      spawn(edge, ['--app=' + url, '--no-first-run', '--no-default-browser-check'],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
  } catch {}
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}

(async () => {
  const exeDir = path.dirname(process.execPath);
  try { process.chdir(exeDir); } catch {}

  if (await probePort()) {                    // 已有实例: 只开页面, 不重复起服务
    openBrowser(URL);
    setTimeout(() => process.exit(0), 300);
    return;
  }

  const serverPath = path.join(exeDir, 'editor', 'server.js');
  if (!fs.existsSync(serverPath)) {
    console.error('[SubFabric] 未找到 editor/server.js。把 SubFabric.exe 放在解压后的目录根下再双击。');
    setTimeout(() => process.exit(1), 4000);
    return;
  }

  const m = new Module(serverPath, null);
  m.filename = serverPath;
  m.paths = Module._nodeModulePaths(path.dirname(serverPath));
  try {
    m._compile(fs.readFileSync(serverPath, 'utf8'), serverPath);
  } catch (e) {
    console.error('[SubFabric] 服务启动失败:', (e && e.stack) || e);
    setTimeout(() => process.exit(1), 4000);
    return;
  }

  // 服务就绪(端口可连)后开浏览器; 最多等 20s
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await probePort()) { openBrowser(URL); return; }
  }
  console.error('[SubFabric] 服务在 20 秒内未能就绪(端口 ' + PORT + ')。');
})();
