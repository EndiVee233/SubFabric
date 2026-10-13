import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAndInstall } from '../tools/build-install.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-build-'));
const dev = path.join(root, '源码'), inst = path.join(root, '安装');
const put = (base, name, text) => { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const snapshot = base => {
  const out = {}; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else out[path.relative(base, f)] = { data: fs.readFileSync(f).toString('base64'), mtime: fs.statSync(f).mtimeMs };
  } }; walk(base); return out;
};
put(dev, 'editor/server.js', "const APP_VERSION = '1.2.3';\n"); put(dev, 'editor/js/new.js', 'new code');
put(dev, 'asr/asr.py', 'new source'); put(dev, 'asr/settings.json', 'do not copy'); put(dev, 'editor/vendor/secret.bin', 'do not copy');
put(dev, 'asr/requirements.txt', 'source requirements');
put(inst, 'SubFabric.exe', 'MZold'); put(inst, 'editor/server.js', 'old source');
for (const file of ['asr/models/model.bin', 'asr/settings.json', 'asr/runtime-python/env.bin', 'editor/vendor/font.bin', 'projects/p/subtitle.srt']) put(inst, file, 'protected');
const config = { dev, inst, python: 'mock-python', install: false, package: false };
const run = (cmd, args, cwd) => { if (cmd === 'mock-python') put(dev, 'build/SubFabric.exe', 'MZnew');
  else if (cmd === config.iscc) put(cwd, 'build/installer/SubFabric-1.2.3-setup.exe', 'MZinstaller'); };
try {
  const before = snapshot(inst);
  await buildAndInstall(config, { run }); assert.deepEqual(snapshot(inst), before);
  await assert.rejects(buildAndInstall({ ...config, install: true }, { run: cmd => { if (cmd === 'mock-python') throw Error('build failed'); } }), /build failed/);
  assert.deepEqual(snapshot(inst), before);
  await assert.rejects(buildAndInstall({ ...config, install: true }, { run, beforeApply(rel) { if (rel.replaceAll('\\', '/') === 'asr/asr.py') throw Error('update failed'); } }), /update failed/);
  // 文件恢复原字节；移动恢复也保留原修改时间。
  assert.deepEqual(snapshot(inst), before);
  config.iscc = path.join(root, 'mock-iscc'); put(root, 'mock-iscc', 'mock');
  put(dev, 'build/installer/SubFabric.iss', 'mock');
  await buildAndInstall({ ...config, package: true }, { run }); assert.deepEqual(snapshot(inst), before);
  assert.ok(fs.existsSync(path.join(dev, 'build/installer/SubFabric-1.2.3-setup.exe')));
  await buildAndInstall({ ...config, install: true }, { run });
  assert.equal(fs.readFileSync(path.join(inst, 'SubFabric.exe'), 'utf8'), 'MZnew');
  assert.equal(fs.readFileSync(path.join(inst, 'editor/server.js'), 'utf8'), "const APP_VERSION = '1.2.3';\n");
  assert.equal(fs.readFileSync(path.join(inst, 'asr/requirements.txt'), 'utf8'), 'source requirements');
  for (const [file, old] of Object.entries(before)) if (!['SubFabric.exe', 'editor/server.js'].includes(file.replaceAll('\\', '/'))) assert.deepEqual(snapshot(inst)[file], old);
  assert.equal(fs.existsSync(path.join(inst, 'editor/vendor/secret.bin')), false);
  assert.equal(fs.readdirSync(root).some(n => n.startsWith('.subfabric-update-')), false);
  // 真实 batch 入口 + 路径覆盖，执行隔离的微型 Python 构建脚本。
  const python = fileURLToPath(new URL('../../asr/runtime-python/python.exe', import.meta.url));
  if (fs.existsSync(python)) {
    fs.mkdirSync(path.join(dev, 'tools'), { recursive: true });
    fs.copyFileSync(new URL('../tools/build-install.mjs', import.meta.url), path.join(dev, 'tools/build-install.mjs'));
    put(dev, 'build_exe.py', "import os\nos.makedirs('build',exist_ok=True)\nopen('build/SubFabric.exe','wb').write(b'MZisolated')\n");
    const checkpoint = snapshot(inst);
    const entry = fileURLToPath(new URL('../../build_and_install.cmd', import.meta.url));
    const result = spawnSync('cmd.exe', ['/d', '/c', entry, '--no-install'], { windowsHide: true, encoding: 'utf8', cwd: root,
      env: { ...process.env, SUBFABRIC_DEV: dev, SUBFABRIC_INST: inst, SUBFABRIC_PY: python } });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.deepEqual(snapshot(inst), checkpoint);
  } else console.log('repair12: batch entry skipped: installed Python unavailable');
  console.log('repair12: no-install zero writes, build/update failure rollback, protected data, package staging and path overrides passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
