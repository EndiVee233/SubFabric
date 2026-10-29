'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const { syncPayload, digest } = require('./security.cjs');
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Backend process tree did not terminate')), 5000);
    function finish(error) { clearTimeout(timer); child.removeListener('exit', exited); if (error) reject(error); else resolve(); }
    function exited() { finish(); }
    child.once('exit', exited);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', error => { try { child.kill(); } catch { finish(error); } });
      killer.on('exit', code => { if (code !== 0 && child.exitCode === null) { try { child.kill(); } catch { finish(Error('taskkill failed: ' + code)); } } });
    } else { try { child.kill('SIGKILL'); } catch (error) { finish(error); } }
  });
}
async function startBackend({ resourceRoot, dataRoot, port = 8325, onExit = () => {} }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid desktop port');
  const manifest = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'manifest.json'), 'utf8'));
  const node = path.join(resourceRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  if (digest(node) !== manifest.nodeSha256) throw Error('Node runtime integrity check failed');
  syncPayload(path.join(resourceRoot, 'payload'), dataRoot, manifest);
  const token = crypto.randomBytes(32).toString('hex');
  const env = { ...process.env, SUBFABRIC_TRAY: '0', SUBFABRIC_DESKTOP: '1', SUBFABRIC_CONTROL_TOKEN: token };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'SUBFABRIC_TEST_MODE']) delete env[key];
  const child = fork(path.join(dataRoot, 'editor/server.js'), ['--no-tray', '--port', String(port)], {
    execPath: node, execArgv: [], cwd: dataRoot, windowsHide: true, env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stopping = false, exited = false, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on('error', () => {}); // Keep a handler after startup, including IPC-close races.
  child.on('exit', (code, signal) => { exited = true; if (!stopping) onExit({ code, signal }); });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(Error('Backend startup timed out')), 30000);
    function cleanup() { clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', earlyExit); child.removeListener('message', ready); }
    function fail(error) { stopping = true; cleanup(); killTree(child).catch(() => {}).finally(() => reject(error)); }
    function earlyExit(code) { fail(Error('Backend exited during startup (' + code + '): ' + stderr)); }
    function ready(message) {
      if (message?.type !== 'subfabric-ready') return;
      if (message.pid !== child.pid || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 || message.version !== manifest.appVersion || message.nodeVersion !== manifest.nodeVersion) return fail(Error('Invalid backend ready message'));
      cleanup(); resolve(message);
    }
    child.once('error', fail); child.once('exit', earlyExit); child.on('message', ready);
  });
  const origin = 'http://127.0.0.1:' + info.port;
  try {
    const response = await fetch(origin + '/api/version', { signal: AbortSignal.timeout(5000) });
    const version = await response.json();
    if (!response.ok || version.version !== info.version || exited) throw Error('Backend version handshake failed');
  } catch (error) { stopping = true; await killTree(child); throw error; }
  let stopPromise;
  return {
    ...info, origin, child, dataRoot,
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopping = true;
        if (exited) return;
        const done = new Promise(resolve => child.once('exit', resolve));
        try {
          const response = await fetch(origin + '/api/quit', { method: 'POST', headers: { 'X-SubFabric-Token': token, 'X-SubFabric-Quit': '1' }, signal: AbortSignal.timeout(2000) });
          if (!response.ok) throw Error('Quit request rejected');
        } catch { if (child.connected) child.send({ type: 'subfabric-quit' }, () => {}); }
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), 6000); });
        const clean = await Promise.race([done.then(() => true), timeout]); clearTimeout(timer);
        if (!clean) await killTree(child);
      })();
      return stopPromise;
    }
  };
}
module.exports = { startBackend, killTree };
