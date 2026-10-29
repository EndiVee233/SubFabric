'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./backend.cjs');
const { sameOrigin, externalURL } = require('./security.cjs');

let backend, window, tray, quitting = false, quitPending = false, ready = false, trayHintShown = false, storageError = null;
const smokeReport = process.env.SUBFABRIC_ELECTRON_SMOKE_REPORT;

/* ── 数据目录 ─────────────────────────────────────────────────────────────
 * 与旧版一致：代码、项目、视频、模型、设置、日志都放在**程序目录**，
 * 不再写入用户文件夹（AppData\Roaming）里的 workspace。
 * 因此 Chromium 的 userData（localStorage、缓存）也重定向到程序目录下的 .profile，
 * 否则主题、欢迎页等界面偏好仍会落到用户目录。
 * 开发运行用 build/electron-dev-data，避免覆盖源码；测试可用 SUBFABRIC_DESKTOP_DATA 指定。 */
const programRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..');
const dataRoot = path.resolve(process.env.SUBFABRIC_DESKTOP_DATA
  || (app.isPackaged ? programRoot : path.join(programRoot, 'build/electron-dev-data')));
try {
  fs.mkdirSync(dataRoot, { recursive: true });
  const probe = path.join(dataRoot, '.write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  app.setPath('userData', path.join(dataRoot, '.profile'));
} catch (error) {
  storageError = '无法写入程序目录：\n' + dataRoot + '\n' + error.message
    + '\n\n请把 SubFabric 安装到有写权限的目录（安装向导默认位置即可）。';
}
app.setName('SubFabric');

if (!app.requestSingleInstanceLock()) { quitting = true; app.exit(0); }
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(launch).catch(async error => {
    if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ ok: false, error: error.message }, null, 2));
    else await dialog.showMessageBox({ type: 'error', title: 'SubFabric', message: 'SubFabric 启动失败', detail: error.message });
    await quitApp(1);
  });
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
  const info = {
    ok: true, packaged: app.isPackaged, electron: process.versions.electron,
    backendVersion: backend.version, backendPid: backend.pid, port: backend.port,
    dataRoot: backend.dataRoot, programRoot, userData: app.getPath('userData'), tray: !!tray,
    hiddenToTray, windowTitle: window.getTitle(), renderer, flushed: true
  };
  await backend.stop();
  info.backendStopped = backend.child.exitCode !== null;
  if (!info.backendStopped) throw Error('Backend did not stop cleanly');
  fs.writeFileSync(smokeReport, JSON.stringify(info, null, 2) + '\n');
  await quitApp(0);
}
