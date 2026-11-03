import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { syncPayload, digest, sourcePath, sameOrigin, externalURL } = require('../desktop/security.cjs');
const {
  migrateLegacyWorkspace, migrateLegacyProfile, importLegacyBrowserState, applyBrowserState
} = require('../desktop/migration.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-electron-test-'));
try {
  const source = path.join(temp, 'source'), data = path.join(temp, 'data');
  fs.mkdirSync(path.join(source, 'editor'), { recursive: true });
  fs.mkdirSync(path.join(data, 'asr/models'), { recursive: true });
  fs.mkdirSync(path.join(data, 'projects/keep'), { recursive: true });
  fs.writeFileSync(path.join(source, 'editor/server.js'), 'packaged source');
  fs.writeFileSync(path.join(data, 'asr/settings.json'), 'private settings');
  fs.writeFileSync(path.join(data, 'asr/models/keep.bin'), 'model');
  fs.writeFileSync(path.join(data, 'projects/keep/keep.txt'), 'user project');
  const manifest = { format: 1, files: [{ path: 'editor/server.js', sha256: digest(path.join(source, 'editor/server.js')) }] };
  assert.equal(syncPayload(source, data, manifest), 1);
  assert.equal(syncPayload(source, data, manifest), 1);
  assert.equal(fs.readFileSync(path.join(data, 'asr/settings.json'), 'utf8'), 'private settings');
  assert.equal(fs.readFileSync(path.join(data, 'asr/models/keep.bin'), 'utf8'), 'model');
  assert.equal(fs.readFileSync(path.join(data, 'projects/keep/keep.txt'), 'utf8'), 'user project');

  // First-Electron AppData workspace: migrate every user-state class without
  // replacing current files, copying application source, or deleting the source.
  const legacy = path.join(temp, 'legacy-workspace');
  for (const [relative, text] of [
    ['asr/settings.json', 'legacy settings'], ['asr/models/model.bin', 'model bytes'],
    ['asr/runtime-python/python.exe', 'python runtime'], ['asr/faster-whisper-xxl/engine.exe', 'asr runtime'],
    ['projects/legacy/project.json', '{"id":"legacy"}'], ['projects/keep/keep.txt', 'must not replace current'],
    ['videos/source.webm', 'video'], ['logs/old.log', 'log'], ['tools/ffmpeg/bin/ffmpeg.exe', 'ffmpeg'],
    ['samples/demo.mp4', 'sample media'],
    ['editor/server.js', 'must never migrate old code']
  ]) {
    fs.mkdirSync(path.dirname(path.join(legacy, relative)), { recursive: true });
    fs.writeFileSync(path.join(legacy, relative), text);
  }
  const workspaceResult = await migrateLegacyWorkspace(legacy, data);
  assert.equal(workspaceResult.files, 8);
  assert.equal(fs.readFileSync(path.join(data, 'asr/settings.json'), 'utf8'), 'private settings');
  assert.equal(fs.readFileSync(path.join(data, 'asr/models/model.bin'), 'utf8'), 'model bytes');
  assert.equal(fs.readFileSync(path.join(data, 'projects/keep/keep.txt'), 'utf8'), 'user project');
  assert.equal(fs.readFileSync(path.join(data, 'projects/legacy/project.json'), 'utf8'), '{"id":"legacy"}');
  assert.equal(fs.existsSync(path.join(data, 'editor/server.js')), true);
  assert.equal(fs.readFileSync(path.join(data, 'editor/server.js'), 'utf8'), 'packaged source');
  assert.equal(fs.readFileSync(path.join(legacy, 'asr/models/model.bin'), 'utf8'), 'model bytes');
  assert.equal((await migrateLegacyWorkspace(legacy, data)).files, 0, 'restart must be idempotent');

  // Absolute paths inside the migrated root must follow the new location; external
  // paths (for example a video on another drive) must remain untouched.
  const rebaseLegacy = path.join(temp, 'rebase-legacy'), rebaseData = path.join(temp, 'rebase-data');
  const legacyModel = path.join(rebaseLegacy, 'asr/models/model.bin');
  const legacyVideo = path.join(rebaseLegacy, 'videos/local.webm');
  const externalVideo = path.join(temp, 'external.mp4');
  for (const [file, text] of [[legacyModel, 'model'], [legacyVideo, 'local video'], [externalVideo, 'external video']]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  fs.mkdirSync(path.join(rebaseLegacy, 'asr'), { recursive: true });
  fs.writeFileSync(path.join(rebaseLegacy, 'asr/settings.json'), JSON.stringify({
    modelsRoot: path.join(rebaseLegacy, 'asr/models'),
    pythonExe: path.join(rebaseLegacy, 'asr/runtime-python/python.exe'),
    models: { model: path.join(rebaseLegacy, 'asr/models/model') }
  }));
  fs.mkdirSync(path.join(rebaseLegacy, 'projects/local'), { recursive: true });
  fs.mkdirSync(path.join(rebaseLegacy, 'projects/external'), { recursive: true });
  fs.writeFileSync(path.join(rebaseLegacy, 'projects/local/project.json'), JSON.stringify({ video: { path: legacyVideo } }));
  fs.writeFileSync(path.join(rebaseLegacy, 'projects/external/project.json'), JSON.stringify({ video: { path: externalVideo } }));
  const rebased = await migrateLegacyWorkspace(rebaseLegacy, rebaseData);
  assert.equal(rebased.rebased, 2);
  const rebasedSettings = JSON.parse(fs.readFileSync(path.join(rebaseData, 'asr/settings.json'), 'utf8'));
  assert.equal(rebasedSettings.modelsRoot, path.join(rebaseData, 'asr/models'));
  assert.equal(rebasedSettings.pythonExe, path.join(rebaseData, 'asr/runtime-python/python.exe'));
  assert.equal(rebasedSettings.models.model, path.join(rebaseData, 'asr/models/model'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(rebaseData, 'projects/local/project.json'), 'utf8')).video.path, path.join(rebaseData, 'videos/local.webm'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(rebaseData, 'projects/external/project.json'), 'utf8')).video.path, externalVideo);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rebaseLegacy, 'asr/settings.json'), 'utf8')).modelsRoot, path.join(rebaseLegacy, 'asr/models'));

  const legacyProfile = path.join(temp, 'legacy-profile'), profile = path.join(temp, 'current-profile');
  fs.mkdirSync(path.join(legacyProfile, 'Local Storage/leveldb'), { recursive: true });
  fs.writeFileSync(path.join(legacyProfile, 'Local Storage/leveldb/CURRENT'), 'leveldb');
  fs.writeFileSync(path.join(legacyProfile, 'Preferences'), '{}');
  await migrateLegacyProfile(legacyProfile, profile);
  assert.equal(fs.readFileSync(path.join(profile, 'Local Storage/leveldb/CURRENT'), 'utf8'), 'leveldb');
  fs.writeFileSync(path.join(legacyProfile, 'Local Storage/leveldb/LOG'), 'must not merge into existing leveldb');
  await migrateLegacyProfile(legacyProfile, profile);
  assert.equal(fs.existsSync(path.join(profile, 'Local Storage/leveldb/LOG')), false);

  // Browser origins: POSTs are origin-bound and the canonical first port wins
  // only for duplicate keys; keys unique to VBS fallback ports are retained.
  const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const ports = [await freePort(), await freePort()];
  const browserResult = await importLegacyBrowserState({ ports, timeoutMs: 5000, openExternal: async start => {
    const route = new URL(start).pathname;
    for (const [index, port] of ports.entries()) {
      const origin = 'http://127.0.0.1:' + port;
      const page = await fetch(origin + route);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /localStorage/);
      const rejected = await fetch(origin + route, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(rejected.status, 403);
      const response = await fetch(origin + route, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, values: { shared: index === 0 ? 'canonical' : 'fallback', ['port-' + port]: 'kept' } })
      });
      assert.equal(response.status, 200);
    }
  } });
  assert.equal(browserResult.values.shared, 'canonical');
  assert.equal(browserResult.keys, 3);
  const store = new Map([['shared', 'current wins']]);
  const localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) };
  const imported = await applyBrowserState({ webContents: { executeJavaScript: async code => vm.runInNewContext(code, { localStorage }) } }, browserResult.values);
  assert.equal(imported, 2);
  assert.equal(store.get('shared'), 'current wins');

  for (const value of ['../editor/a.js', 'editor/../asr/settings.json', 'asr/settings.json', 'asr/models/x', 'editor\\x', 'editor/x:ads', 'editor/.hidden', 'projects/x']) assert.throws(() => sourcePath(value));
  const bad = { ...manifest, files: [{ ...manifest.files[0], sha256: '0'.repeat(64) }] };
  assert.throws(() => syncPayload(source, data, bad), /integrity/);
  assert.throws(() => syncPayload(source, data, { ...manifest, files: [...manifest.files, ...manifest.files] }));
  assert.equal(sameOrigin('http://127.0.0.1:8325/editor/studio.html', 'http://127.0.0.1:8325'), true);
  for (const url of ['http://127.0.0.1:8326/', 'https://evil.example/', 'file:///C:/private', 'javascript:alert(1)']) assert.equal(sameOrigin(url, 'http://127.0.0.1:8325'), false);
  assert.equal(externalURL('https://github.com/EndiVee233/SubFabric'), true);
  for (const url of ['file:///C:/private', 'javascript:alert(1)', 'https://user:pass@host/']) assert.equal(externalURL(url), false);
  for (const value of ['editor/package.json', 'editor/server.js.', 'editor/server.js ', 'editor/con.js', 'asr/custom-data.json']) assert.throws(() => sourcePath(value));
  assert.throws(() => syncPayload(source, data, { format: 1, files: [] }), /manifest/);
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  for (const rule of ['nodeIntegration: false', 'contextIsolation: true', 'sandbox: true', 'webSecurity: true', 'requestSingleInstanceLock', 'setWindowOpenHandler', 'will-attach-webview', 'await flush()']) assert.ok(main.includes(rule), rule);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.runAfterFinish, false);
  assert.equal(pkg.build.nsis.include, 'installer.nsh');
  assert.ok(pkg.build.files.includes('migration.cjs'));
  const installer = fs.readFileSync(path.join(root, 'desktop/installer.nsh'), 'utf8');
  for (const rule of ['GetDParameter $R0', 'com.endivee233.subfabric.electron', 'WOW6432Node', '8F4E7C2A-9B1D-4A6E-8F3B-2C5D7E9A1B4C']) assert.ok(installer.includes(rule), rule);
  assert.ok(fs.readFileSync(path.join(root, 'desktop/builder.cjs'), 'utf8').includes("to: 'tray.ico'"), 'tray icon must be packaged');
  assert.ok(!fs.existsSync(path.join(root, 'package.json')), 'Do not alter backend mixed module inference');
  console.log('Electron desktop: payload integrity, data preservation, path guards, navigation policy, isolated package boundary PASS');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
