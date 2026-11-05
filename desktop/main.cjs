'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startBackend } = require('./backend.cjs');
const { sameOrigin, externalURL } = require('./security.cjs');
const {
  LEGACY_PORTS, migrateLegacyWorkspace, migrateLegacyProfile, hasWorkspaceState,
  readReport, writeReport, importLegacyBrowserState, applyBrowserState
} = require('./migration.cjs');

let backend, window, tray, quitting = false, quitPending = false, ready = false, trayHintShown = false, storageError = null;
let browserMigration = null;
const smokeReport = process.env.SUBFABRIC_ELECTRON_SMOKE_REPORT;

/* ── 数据目录与旧版继承 ──────────────────────────────────────────────────
 * 当前版本与旧 SEA 一样以程序目录为 root。首个 Electron 版的 AppData workspace
 * 只迁移用户状态，逐文件校验、只补缺且不删除来源；当前文件永远优先。
 * Chromium 配置在 Electron 初始化前复制，避免两个 LevelDB 被交叉合并。 */
const programRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.SUBFABRIC_DESKTOP_DATA
  || (app.isPackaged ? programRoot : path.join(programRoot, 'build/electron-dev-data')));
const profileRoot = path.join(dataRoot, '.profile');
const legacyProfile = path.resolve(process.env.SUBFABRIC_LEGACY_PROFILE
  || path.join(app.getPath('appData'), 'SubFabric Electron'));
const legacyWorkspace = path.resolve(process.env.SUBFABRIC_LEGACY_WORKSPACE || path.join(legacyProfile, 'workspace'));
const hadLegacyElectron = hasWorkspaceState(legacyWorkspace);
const browserReport = readReport(dataRoot).browser;
const shouldMigrateBrowser = app.isPackaged && !hadLegacyElectron && hasWorkspaceState(dataRoot)
  && browserReport?.status !== 'complete';
app.setName('SubFabric');
/* ── 播放性能：别让 Chromium 把"看不见的窗口"降级 ─────────────────────────
 * 窗口被别的窗口盖住、最小化到任务栏、或通过远程桌面/虚拟显示器使用时，Chromium
 * 会把渲染进程当成后台：rAF 挂起、定时器节流到 1Hz、合成器停摆。编辑器里直接表现
 * 为「点播放没反应」「跳转后画面要等好几秒才动」「时间轴游标卡住」。
 * 这三个开关是 Chromium 给"要持续渲染的应用"准备的正式开关，关掉降级即可。
 * 硬件解码不需要开关：GPU 支持时 Chromium 自动选硬解（解码器是否在跑可以在页面里用
 * navigator.mediaCapabilities.decodingInfo().powerEfficient 复核），所以这里只开
 * GPU 光栅化，不动 blocklist（强开有把驱动搞崩的风险）。 */
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-gpu-rasterization');
if (!app.requestSingleInstanceLock()) { quitting = true; app.exit(0); }
else {
  app.on('second-instance', () => showWindow());
  (async () => {
    try {
      fs.mkdirSync(dataRoot, { recursive: true });
      const probe = path.join(dataRoot, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      const workspace = await migrateLegacyWorkspace(legacyWorkspace, dataRoot);
      const profile = await migrateLegacyProfile(legacyProfile, profileRoot);
      app.setPath('userData', profileRoot);
      if (workspace.files || profile.files) writeReport(dataRoot, { filesystem: { status: 'complete', workspace, profile } });
    } catch (error) {
      storageError = '无法安全继承程序数据：\n' + dataRoot + '\n' + error.message
        + '\n\n旧数据未被删除。请检查目录写权限后重试，或把 SubFabric 安装到有写权限的目录。';
    }
    app.whenReady().then(launch).catch(async error => {
      if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ ok: false, error: error.message }, null, 2));
      else await dialog.showMessageBox({ type: 'error', title: 'SubFabric', message: 'SubFabric 启动失败', detail: error.message });
      await quitApp(1);
    });
  })();
}

function trayIconPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'tray.ico') : path.join(__dirname, '../build/installer/logo.ico');
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/* 右下角托盘图标：点关闭只隐藏，右键「完全退出」才结束进程（与旧版一致）。 */
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(trayIconPath()));
    tray.setToolTip('SubFabric');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开界面', click: showWindow },
      { label: '打开数据目录', click: () => shell.openPath(dataRoot) },
      { type: 'separator' },
      { label: '完全退出', click: () => requestQuit('托盘菜单') }
    ]));
    tray.on('double-click', showWindow);
  } catch (error) {
    tray = null;   // 托盘建不起来就退回「关窗即退出」，不能让窗口无法关闭。
    console.error('[tray] 托盘图标创建失败：' + (error && error.message));
  }
}

function hideToTray() {
  if (!window || window.isDestroyed()) return;
  window.hide();
  if (tray && !trayHintShown) {
    trayHintShown = true;
    try {
      tray.displayBalloon({
        title: 'SubFabric 仍在运行',
        content: '右键任务栏托盘图标，选择「完全退出」才会结束程序。'
      });
    } catch {}
  }
}

async function external(url) {
  if (!externalURL(url)) return;
  const result = await dialog.showMessageBox(window, { type: 'question', message: 'Open this link in your browser?', detail: url, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0 });
  if (result.response === 1) await shell.openExternal(url);
}
function legacyPorts() {
  const value = process.env.SUBFABRIC_LEGACY_BROWSER_PORTS;
  if (!value) return LEGACY_PORTS;
  return value.split(',').map(part => Number(part.trim()));
}
async function openMigrationBrowser(url) {
  const executable = process.env.SUBFABRIC_MIGRATION_BROWSER;
  if (!executable) return shell.openExternal(url);
  const args = ['--no-first-run', '--no-default-browser-check'];
  if (process.env.SUBFABRIC_MIGRATION_BROWSER_PROFILE) args.push('--user-data-dir=' + path.resolve(process.env.SUBFABRIC_MIGRATION_BROWSER_PROFILE));
  args.push('--new-window', url);
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
  child.unref();
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}

async function flush() {
  if (!window || window.isDestroyed() || !ready) return;
  let timer;
  try {
    await Promise.race([
      window.webContents.executeJavaScript('(async () => { if (typeof window.__subfabricFlushSave !== "function") throw new Error("Editor is not ready to save"); await window.__subfabricFlushSave(); return true; })()'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Saving timed out; the window was kept open')), 10000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function requestQuit(source) {
  if (quitPending) return;
  quitPending = true;
  try {
    if (window && !window.isDestroyed()) {
      if (!window.isVisible()) window.showInactive();
      await window.webContents.executeJavaScript('document.documentElement.inert = true');
    }
    await flush();
    console.log('[quit] 完全退出（来源：' + (source || '未注明') + '）');
    await quitApp(0);
  } catch (error) {
    const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Your latest edits could not be saved', detail: error.message, buttons: ['Keep editing', 'Exit without saving'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) await quitApp(0);
  } finally {
    if (!quitting && window && !window.isDestroyed()) {
      await window.webContents.executeJavaScript('document.documentElement.inert = false').catch(() => {});
    }
    quitPending = false;
  }
}

async function quitApp(code) {
  if (quitting) return;
  quitting = true;
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  if (backend) {
    try { await backend.stop(); }
    catch (error) { if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ ok: false, error: error.message })); code = 1; }
  }
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(code);
}

app.on('before-quit', event => { if (!quitting) { event.preventDefault(); requestQuit('系统退出'); } });
app.on('window-all-closed', () => { if (!quitting) quitApp(0); });

async function launch() {
  if (storageError) {
    if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ ok: false, error: storageError }, null, 2));
    else await dialog.showMessageBox({ type: 'error', title: 'SubFabric', message: '程序目录不可写', detail: storageError });
    await quitApp(1);
    return;
  }
  const resourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '../build/electron-stage');
  backend = await startBackend({ resourceRoot, dataRoot, port: smokeReport ? 0 : Number(process.env.SUBFABRIC_DESKTOP_PORT || 8325), onExit: () => { if (!quitting) quitApp(1); } });
  if (quitting) { await backend.stop(); return; }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    title: 'SubFabric', backgroundColor: '#16181d', show: false,
    icon: path.join(dataRoot, 'editor/assets/app-logo.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false }
  });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url).catch(() => {}); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url, backend.origin)) { event.preventDefault(); external(url).catch(() => {}); } });
  window.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url, backend.origin)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (!quitting) quitApp(1); });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (tray) hideToTray(); else requestQuit('关闭窗口');
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开数据目录', click: () => shell.openPath(dataRoot) },
      { type: 'separator' },
      { label: '完全退出', click: () => requestQuit('菜单') }
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] }
  ]));
  if (shouldMigrateBrowser) {
    try {
      browserMigration = await importLegacyBrowserState({ ports: legacyPorts(), openExternal: openMigrationBrowser });
      if (browserMigration.keys) {
        // A JSON response on the backend origin gives us a minimal same-origin page.
        // Import before Studio modules read their preferences; existing keys always win.
        await window.loadURL(backend.origin + '/api/version');
        browserMigration.imported = await applyBrowserState(window, browserMigration.values);
      } else browserMigration.imported = 0;
      writeReport(dataRoot, { browser: { status: 'complete', origins: browserMigration.origins, keys: browserMigration.keys, imported: browserMigration.imported } });
    } catch (error) {
      browserMigration = { error: error.message };
      writeReport(dataRoot, { browser: { status: 'pending', error: error.message } });
      await dialog.showMessageBox(window, {
        type: 'warning', title: 'SubFabric', message: '旧浏览器界面设置暂未迁移',
        detail: error.message + '\n\n项目、模型与服务端设置已保留，旧浏览器数据也未被修改。完全退出旧版后，下次启动会自动重试。'
      });
    }
  }
  await window.loadURL(backend.origin + '/editor/studio.html');
  createTray();
  ready = true;
  if (smokeReport) await smoke();
  else window.show();
}

async function smoke() {
  window.showInactive();
  const renderer = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    function check() {
      if (typeof window.__subfabricFlushSave === 'function') resolve({ title: document.title, app: !!document.getElementById('app'), node: typeof require, process: typeof process, textLength: document.body.innerText.length });
      else if (Date.now() > deadline) reject(new Error('Studio initialization timed out'));
      else setTimeout(check, 100);
    }
    check();
  })`);
  if (!renderer.app || renderer.node !== 'undefined' || renderer.process !== 'undefined' || renderer.textLength < 100) throw Error('Renderer or isolation smoke failed');
  if (!tray) throw Error('Tray icon was not created');
  if (path.resolve(app.getPath('userData')) !== path.resolve(dataRoot, '.profile')) throw Error('Chromium profile is not inside the program directory');
  for (const relative of ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm', 'fonts/NotoSansCJKsc-Regular.otf']) {
    const result = await fetch(backend.origin + '/editor/vendor/' + relative, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw Error('Bundled renderer unavailable: ' + relative);
  }
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 1200))');
  await flush();
  const image = await window.webContents.capturePage();
  fs.writeFileSync(smokeReport.replace(/\.json$/, '') + '.png', image.toPNG());
  // 关窗必须只是隐藏到托盘，而不是退出。
  window.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  const hiddenToTray = !!tray && !window.isDestroyed() && !window.isVisible();
  if (!hiddenToTray) throw Error('Closing the window must hide it to the tray');
  const smokeKeys = (process.env.SUBFABRIC_ELECTRON_SMOKE_LOCALSTORAGE || '').split(',').map(key => key.trim()).filter(Boolean);
  if (smokeKeys.length) renderer.migrationValues = await window.webContents.executeJavaScript(`Object.fromEntries(${JSON.stringify(smokeKeys)}.map(key => [key, localStorage.getItem(key)]))`);
  const [projectsResponse, asrResponse] = await Promise.all([
    fetch(backend.origin + '/api/projects', { signal: AbortSignal.timeout(5000) }),
    fetch(backend.origin + '/api/asr/status', { signal: AbortSignal.timeout(10000) })
  ]);
  if (!projectsResponse.ok || !asrResponse.ok) throw Error('Migrated backend state could not be read');
  const projects = await projectsResponse.json(), asr = await asrResponse.json();
  const projectList = Array.isArray(projects) ? projects : (Array.isArray(projects.projects) ? projects.projects : []);
  const info = {
    ok: true, packaged: app.isPackaged, electron: process.versions.electron,
    backendVersion: backend.version, backendPid: backend.pid, port: backend.port,
    dataRoot: backend.dataRoot, programRoot, userData: app.getPath('userData'), tray: !!tray,
    hiddenToTray, windowTitle: window.getTitle(), renderer, flushed: true,
    projectIds: projectList.map(project => project.id),
    asrModels: Array.isArray(asr.models) ? asr.models.map(model => ({ id: model.id, dir: model.dir, missing: model.missing, filesOk: model.filesOk, ready: model.ready })) : [],
    migration: readReport(dataRoot), browserMigration: browserMigration && { keys: browserMigration.keys, imported: browserMigration.imported, origins: browserMigration.origins, error: browserMigration.error }
  };
  await backend.stop();
  info.backendStopped = backend.child.exitCode !== null;
  if (!info.backendStopped) throw Error('Backend did not stop cleanly');
  fs.writeFileSync(smokeReport, JSON.stringify(info, null, 2) + '\n');
  await quitApp(0);
}
