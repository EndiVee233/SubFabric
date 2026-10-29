'use strict';
const { app, BrowserWindow, dialog, Menu, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./backend.cjs');
const { sameOrigin, externalURL } = require('./security.cjs');
let backend, window, quitting = false, closePending = false, ready = false;
const smokeReport = process.env.SUBFABRIC_ELECTRON_SMOKE_REPORT;
if (smokeReport) app.setPath('userData', path.join(path.dirname(path.resolve(smokeReport)), 'electron-smoke-profile'));
app.setName('SubFabric Electron');
if (!app.requestSingleInstanceLock()) { quitting = true; app.exit(0); }
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(launch).catch(async error => {
    if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ ok: false, error: error.message }, null, 2));
    else await dialog.showMessageBox({ type: 'error', title: 'SubFabric Electron', message: 'SubFabric could not start', detail: error.message });
    await quitApp(1);
  });
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
async function requestClose() {
  if (closePending) return;
  closePending = true;
  try {
    if (window && !window.isDestroyed()) await window.webContents.executeJavaScript('document.documentElement.inert = true');
    await flush(); await quitApp(0);
  }
  catch (error) {
    const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Your latest edits could not be saved', detail: error.message, buttons: ['Keep editing', 'Exit without saving'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) await quitApp(0);
  } finally {
    if (!quitting && window && !window.isDestroyed()) await window.webContents.executeJavaScript('document.documentElement.inert = false').catch(() => {});
    closePending = false;
  }
}
async function quitApp(code) {
  if (quitting) return;
  quitting = true;
  if (backend) {
    try { await backend.stop(); }
    catch (error) { if (smokeReport) fs.writeFileSync(smokeReport, JSON.stringify({ ok: false, error: error.message })); code = 1; }
  }
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(code);
}
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); requestClose(); } });
app.on('window-all-closed', () => { if (!quitting) quitApp(0); });
async function launch() {
  const dataRoot = path.join(app.getPath('userData'), 'workspace');
  const resourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '../build/electron-stage');
  backend = await startBackend({ resourceRoot, dataRoot, port: smokeReport ? 0 : Number(process.env.SUBFABRIC_DESKTOP_PORT || 8325), onExit: () => { if (!quitting) quitApp(1); } });
  if (quitting) { await backend.stop(); return; }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    title: 'SubFabric Electron', backgroundColor: '#16181d', show: false,
    icon: path.join(dataRoot, 'editor/assets/app-logo.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false }
  });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url).catch(() => {}); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url, backend.origin)) { event.preventDefault(); external(url).catch(() => {}); } });
  window.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url, backend.origin)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (!quitting) quitApp(1); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); requestClose(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [ { label: 'Open data directory', click: () => shell.openPath(dataRoot) }, { label: 'Exit', accelerator: 'Alt+F4', click: requestClose } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] }
  ]));
  await window.loadURL(backend.origin + '/editor/studio.html');
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
  for (const relative of ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm', 'fonts/NotoSansCJKsc-Regular.otf']) {
    const result = await fetch(backend.origin + '/editor/vendor/' + relative, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw Error('Bundled renderer unavailable: ' + relative);
  }
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 1200))');
  await flush();
  const image = await window.webContents.capturePage();
  fs.writeFileSync(smokeReport.replace(/\.json$/, '') + '.png', image.toPNG());
  const info = { ok: true, packaged: app.isPackaged, electron: process.versions.electron, backendVersion: backend.version, backendPid: backend.pid, port: backend.port, dataRoot: backend.dataRoot, renderer, flushed: true };
  await backend.stop();
  info.backendStopped = backend.child.exitCode !== null;
  if (!info.backendStopped) throw Error('Backend did not stop cleanly');
  fs.writeFileSync(smokeReport, JSON.stringify(info, null, 2) + '\n');
  await quitApp(0);
}
