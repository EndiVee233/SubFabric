import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import packMod from '../editor/project-pack.js';
import { serverFunctions } from './helpers/server-functions.mjs';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { zipFixture } from './helpers/zip-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-export-'));
const project = path.join(root, "中文项目'甲"), elsewhere = path.join(root, '其他启动目录');
fs.mkdirSync(project); fs.mkdirSync(elsewhere);
const sub = '1\n00:00:01,000 --> 00:00:02,000\n当前目标文本\n';
const content = { 'project.json': JSON.stringify({ name: '当前项目', subtitle: { file: 'subtitle.srt' } }),
  'subtitle.srt': sub, 'notes.json': '[{"text":"备注"}]', 'asr.json': '{"segments":[]}' };
for (const [name, body] of Object.entries(content)) {
  fs.writeFileSync(path.join(project, name), body); fs.writeFileSync(path.join(elsewhere, name), 'wrong-cwd');
}
for (const file of ['audio.wav', 'peaks.bin', 'settings.json', '.private', 'unrelated.txt']) fs.writeFileSync(path.join(project, file), 'excluded');
const globals = { fs, path, os: { tmpdir: () => root }, packMod, projDir: () => project,
  readMeta: () => JSON.parse(content['project.json']), setTimeout, clearTimeout, SYS_TAR: 'preferred-tar' };
const unpack = serverFunctions(['unpackProject'], { fs, path, os: { tmpdir: () => root }, packMod, AbortSignal, Transform, pipeline, zlib }).unpackProject;
const checkPack = async packed => {
  const extracted = await unpack(packed.zipPath);
  try {
    assert.deepEqual(Array.from(extracted.files).sort(), Object.keys(content).sort());
    for (const [name, body] of Object.entries(content)) assert.equal(fs.readFileSync(path.join(extracted.dir, name), 'utf8'), body);
  } finally { fs.rmSync(extracted.dir, { recursive: true, force: true }); fs.rmSync(packed.tmpDir, { recursive: true, force: true }); }
};
try {
  // 可移植行为测试执行生产打包函数；模拟工具按真实 cwd/-C 读文件，禁止从启动目录读同名内容。
  const calls = [];
  const pack = serverFunctions(['packProject'], { ...globals, runTool: async (cmd, args, timeout, cwd) => {
    calls.push({ cmd, cwd }); assert.equal(cwd, project);
    const base = args[args.indexOf('-C') + 1], names = args.slice(args.indexOf('-C') + 2);
    assert.equal(base, project);
    fs.writeFileSync(args[args.indexOf('-f') + 1], zipFixture(names.map(name => ({ name, body: fs.readFileSync(path.join(base, name)) }))));
    return { code: 0, out: '' };
  } }).packProject;
  const packed = await pack('p'); assert.equal(packed.tool, 'tar'); assert.equal(calls.length, 1); await checkPack(packed);
  const bad = serverFunctions(['packProject'], { ...globals, runTool: async (cmd, args) => {
    if (cmd === 'preferred-tar') fs.writeFileSync(args[args.indexOf('-f') + 1], 'partial');
    return { code: 1, out: 'injected failure' };
  } }).packProject;
  await assert.rejects(bad('p'), /打包失败/);
  assert.deepEqual(fs.readdirSync(root).filter(n => /^kass-(pack|unpack)-/.test(n)), []);
  // runTool 本体确实透传 cwd，不修改当前进程目录；启动失败、超时均结束。
  const runTool = serverFunctions(['runTool'], { spawn, setTimeout, clearTimeout }).runTool;
  const originalCwd = process.cwd();
  const cwdResult = await runTool(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], 5000, elsewhere);
  assert.equal(cwdResult.code, 0); assert.equal(cwdResult.out, elsewhere); assert.equal(process.cwd(), originalCwd);
  assert.equal((await runTool(path.join(root, 'missing-tool.exe'), [], 5000, elsewhere)).code, -1);
  assert.equal((await runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 50, elsewhere)).code, -2);
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe');
    // 真正 Windows 工具 + 中文/引号路径：首选成功只能调用一次；缺失 tar 时实际 PowerShell 回退。
    for (const fallback of [false, true]) {
      const used = [];
      const actual = serverFunctions(['packProject'], { ...globals, SYS_TAR: fallback ? path.join(root, 'missing-tar.exe') : tar,
        runTool: async (...args) => { used.push(args[0]); return runTool(...args); } }).packProject;
      const p = await actual('p'); assert.equal(p.tool, fallback ? 'PowerShell' : 'tar');
      assert.equal(used.length, fallback ? 2 : 1); await checkPack(p);
    }
    // HTTP 导出 -> 导入往返，服务从含同名文件的另一目录启动；成功响应后无导出临时目录。
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('kass-pack-')));
    const s = await isolatedServer({ cwd: elsewhere });
    try {
      const dir = path.join(s.root, 'projects/p-export'); fs.mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(content)) fs.writeFileSync(path.join(dir, name), body);
      fs.writeFileSync(path.join(dir, 'audio.wav'), 'excluded');
      const r = await s.call('/api/projects/p-export/export-pack'); assert.equal(r.status, 200);
      const bytes = Buffer.from(await r.arrayBuffer()); assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8/);
      const imported = await s.call('/api/projects/import-pack', { method: 'POST', body: bytes }); assert.equal(imported.status, 200);
      const id = (await imported.json()).id;
      assert.equal(await (await s.call(`/api/projects/${id}/subtitle`)).text(), sub);
      assert.equal(fs.existsSync(path.join(s.root, 'projects', id, 'audio.wav')), false);
      assert.ok(/\[pack\].*，tar/.test(s.output()));
      assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('kass-pack-') && !before.has(n)), []);
    } finally { await s.close(); }
  } else console.log('repair15: actual Windows tar/PowerShell cases skipped on this platform');
  console.log('repair15: explicit cwd/core-only, Unicode/namesake, tar preference, real fallback, failure cleanup and export/import round-trip passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
