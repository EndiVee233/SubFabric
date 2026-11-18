import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
    /* 版本号只维护在 editor/server.js 一处，这里从源文件取，避免每次发版都要改测试 */
    const expectedVersion = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8'))[1];
    assert.equal(backend.version, expectedVersion);
    assert.equal(backend.nodeVersion, JSON.parse(fs.readFileSync(path.join(resourceRoot, 'manifest.json'), 'utf8')).nodeVersion);
    for (const route of ['/editor/studio.html', '/editor/js/main.js', '/editor/vendor/subtitles-octopus-worker.wasm', '/api/projects', '/api/asr/status']) {
      const response = await fetch(backend.origin + route, { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, route);
    }
    const loginRoute = backend.origin + '/api/fetch/bilibili-login';
    const auth = { 'X-SubFabric-Token': backend.token };
    const signal = AbortSignal.timeout(5000);
    const publishLoginState = state => new Promise((resolve, reject) => {
      backend.child.send({ type: 'subfabric-bilibili-login-state', state }, error => error ? reject(error) : resolve());
    });
    await publishLoginState('idle');
    assert.equal((await fetch(loginRoute, { signal })).status, 404);
    assert.deepEqual(await (await fetch(loginRoute, { headers: auth, signal })).json(), { state: 'idle' });
    const open = once(backend.child, 'message', { signal });
    assert.equal((await fetch(loginRoute, { method: 'POST', headers: auth, signal })).status, 202);
    assert.deepEqual((await open)[0], { type: 'subfabric-bilibili-login-open' });
    await publishLoginState('pending');
    const complete = (headers, body) => fetch(loginRoute + '/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal,
    });
    assert.equal((await complete({}, '{}')).status, 403);
    assert.equal((await complete({ ...auth, Origin: backend.origin }, '{}')).status, 404);
    assert.equal((await complete(auth, '{}')).status, 400);
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
