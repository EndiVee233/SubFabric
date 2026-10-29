import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { startBackend } = require('../desktop/backend.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceRoot = path.join(root, 'build/electron-stage');
if (!fs.existsSync(resourceRoot)) { console.log('SKIP backend smoke: run desktop/stage.mjs first'); }
else {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-electron-backend-'));
  let backend;
  try {
    backend = await startBackend({ resourceRoot, dataRoot, port: 0 });
    assert.equal(backend.version, 'beta 1.5.1.1');
    assert.equal(backend.nodeVersion, JSON.parse(fs.readFileSync(path.join(resourceRoot, 'manifest.json'), 'utf8')).nodeVersion);
    for (const route of ['/editor/studio.html', '/editor/js/main.js', '/editor/vendor/subtitles-octopus-worker.wasm', '/api/projects', '/api/asr/status']) {
      const response = await fetch(backend.origin + route, { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, route);
    }
    fs.mkdirSync(path.join(dataRoot, 'projects/keep'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'projects/keep/user.txt'), 'preserve user file');
    await backend.stop(); assert.equal(backend.child.exitCode, 0);
    backend = await startBackend({ resourceRoot, dataRoot, port: 0 });
    assert.equal(fs.readFileSync(path.join(dataRoot, 'projects/keep/user.txt'), 'utf8'), 'preserve user file');
    backend.child.disconnect();
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Disconnect did not stop backend')), 7000); backend.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    assert.equal(backend.child.exitCode, 0);
    console.log('Electron backend smoke PASS: bundled Node, ready handshake, APIs, vendor, restart data retention, clean quit and IPC-disconnect cleanup');
  } finally { if (backend) await backend.stop(); fs.rmSync(dataRoot, { recursive: true, force: true }); }
}
