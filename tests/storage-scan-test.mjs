import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { StorageService, removeDeep, within } = require('../editor/storage-scan.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-storage-'));
const root = path.join(temp, 'root');
const put = (relative, content) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const daysAgo = (file, days) => {
  const when = new Date(Date.now() - days * 86400000);
  fs.utimesSync(file, when, when);
};

/* ── 夹具：项目 / 模型 / 运行时 / 缓存 / 日志 ─────────────────────── */
put('projects/p-keep/project.json', JSON.stringify({ id: 'p-keep', name: '保留项目' }));
put('projects/p-keep/subtitle.ass', '[Script Info]\nTitle: keep me\n');
put('projects/p-keep/audio.wav', 'x'.repeat(2048));
put('projects/p-keep/peaks.bin', 'x'.repeat(512));
put('projects/p-keep/asr.json', 'x'.repeat(256));
put('projects/p-keep/video/source.mp4', 'x'.repeat(4096));
put('projects/p-busy/project.json', JSON.stringify({ id: 'p-busy', name: '正在识别' }));
put('projects/p-busy/audio.wav', 'x'.repeat(128));
put('projects/p-clean/project.json', JSON.stringify({ id: 'p-clean', name: '无中间文件' }));
put('projects/p-clean/subtitle.ass', 'keep');
put('asr/models/selected-model/weights.bin', 'x'.repeat(1024));
put('asr/models/spare-model/weights.bin', 'x'.repeat(2048));
put('asr/models/spare-model/config.json', '{}');
put('asr/runtime-python/python.exe', 'x'.repeat(100));
put('asr/whisper.cpp/whisper-cli.exe', 'x'.repeat(100));
put('asr/runtime-vibevoice/model.bin', 'x'.repeat(300));
put('asr/ytdlp/yt-dlp.exe', 'x'.repeat(50));
put('asr/__pycache__/asr.cpython-311.pyc', 'x'.repeat(400));
put('editor/__pycache__/x.pyc', 'x'.repeat(64));
const oldLog = put('logs/launcher-console.log', 'x'.repeat(700));
const newLog = put('logs/today.log', 'x'.repeat(900));
const asrOldLog = put('asr/logs/asr.log', 'x'.repeat(300));
daysAgo(oldLog, 30);
daysAgo(asrOldLog, 15);
put('logs/keep.ini', 'not a log');

const busy = new Set(['p-busy']);
const service = new StorageService({
  root,
  protectedModels: new Set(['selected-model']),
  protectedRuntimes: new Set(['whisper.cpp', 'ytdlp']),
  isProjectBusy: id => busy.has(id),
});

const scan = await service.scan();
const byName = name => scan.items.filter(item => item.name === name);

/* 分类与条目 */
assert.equal(scan.ok, true);
assert.ok(scan.disk.total > 0, 'disk stats are reported');
assert.deepEqual(scan.categories.map(c => c.id), ['project', 'model', 'runtime', 'cache', 'log']);
assert.deepEqual(scan.categories.find(c => c.id === 'project').count, 2, 'only projects with intermediates are listed');
assert.deepEqual(scan.categories.find(c => c.id === 'model').count, 2);
assert.deepEqual(scan.categories.find(c => c.id === 'runtime').count, 4);
assert.deepEqual(scan.categories.find(c => c.id === 'cache').count, 2);

const keepProject = byName('保留项目')[0];
assert.equal(keepProject.size, 2048 + 512 + 256, 'project item only sums regenerable intermediates');
assert.equal(keepProject.removable, true);
assert.deepEqual(keepProject.targets.sort(), [
  'projects/p-keep/asr.json', 'projects/p-keep/audio.wav', 'projects/p-keep/peaks.bin',
].sort());
assert.ok(!keepProject.targets.some(t => t.includes('subtitle.ass')), 'subtitles are never part of the cleanup set');

const busyProject = byName('正在识别')[0];
assert.equal(busyProject.removable, false, 'projects with a running job cannot be cleaned');
assert.match(busyProject.reason, /进行中/);

const selectedModel = byName('selected-model')[0];
assert.equal(selectedModel.removable, false, 'the selected model is protected');
const spareModel = byName('spare-model')[0];
assert.equal(spareModel.removable, true);
assert.equal(spareModel.size, 2050);

assert.equal(byName('runtime-python')[0].removable, false, 'base python runtime is protected');
assert.equal(byName('whisper.cpp')[0].removable, false, 'the active backend runtime is protected');
assert.equal(byName('ytdlp')[0].removable, false, 'link downloader is protected');
assert.equal(byName('runtime-vibevoice')[0].removable, true, 'an unused runtime can be cleaned');

assert.equal(byName('launcher-console.log')[0].removable, true, 'logs older than 7 days are listed');
assert.equal(byName('asr.log')[0].removable, true);
assert.equal(byName('today.log').length, 0, 'recent logs are kept out of the list');

/* 受保护条目即使被伪造请求也不能删 */
const before = await service.clean([selectedModel.id, busyProject.id]);
assert.equal(before.ok, true);
assert.equal(before.removed.length, 0);
assert.equal(before.failed.length, 2);
assert.ok(fs.existsSync(path.join(root, 'asr/models/selected-model/weights.bin')));
assert.ok(fs.existsSync(path.join(root, 'projects/p-busy/audio.wav')));

/* 未知 id 不会碰任何文件 */
const forged = await service.clean(['project:0000000000000000']);
assert.equal(forged.removed.length, 0);
assert.match(forged.failed[0].error, /重新扫描/);

/* 正常清理：只删选中项，用户资产原样保留 */
const result = await service.clean([spareModel.id, byName('runtime-vibevoice')[0].id, keepProject.id, byName('asr.log')[0].id, byName('launcher-console.log')[0].id, byName('__pycache__').map(i => i.id)[0]]);
assert.equal(result.ok, true, JSON.stringify(result.failed));
assert.equal(result.failed.length, 0);
assert.ok(result.freed >= 2050 + 300 + 2816 + 300 + 700, 'freed bytes cover every removed target');
assert.ok(!fs.existsSync(path.join(root, 'asr/models/spare-model')));
assert.ok(!fs.existsSync(path.join(root, 'asr/runtime-vibevoice')));
assert.ok(!fs.existsSync(path.join(root, 'projects/p-keep/audio.wav')));
assert.ok(fs.existsSync(path.join(root, 'projects/p-keep/subtitle.ass')), 'subtitle survives cleanup');
assert.ok(fs.existsSync(path.join(root, 'projects/p-keep/project.json')));
assert.ok(fs.existsSync(path.join(root, 'projects/p-keep/video/source.mp4')), 'source video survives cleanup');
assert.ok(fs.existsSync(path.join(root, 'asr/models/selected-model/weights.bin')));
assert.ok(fs.existsSync(path.join(root, 'logs/today.log')));
assert.ok(fs.existsSync(path.join(root, 'logs/keep.ini')), 'non-log files are untouched');
assert.ok(!fs.existsSync(path.join(root, 'asr/models/spare-model')), 'model directory removed recursively');

/* 同一条目不能删第二次（登记表已更新） */
const again = await service.clean([spareModel.id]);
assert.equal(again.removed.length, 0);
assert.equal(again.failed.length, 1);

/* 扫描过期后拒绝清理 */
service.scannedAt = Date.now() - 31 * 60 * 1000;
const expired = await service.clean([byName('runtime-python')[0].id]);
assert.equal(expired.ok, false);
assert.match(expired.error, /过期/);

/* 路径边界与链接：不跟随、不越界 */
assert.equal(within(path.join(root, 'projects'), path.join(root, 'projects/p-keep')), true);
assert.equal(within(path.join(root, 'projects'), path.join(root, 'projects-evil')), false);
assert.equal(within(path.join(root, 'projects'), root), false);

const linkDir = path.join(root, 'asr/models/link-model');
let linkMade = false;
try {
  fs.symlinkSync(path.join(root, 'asr/models/spare-model'), linkDir, 'dir');
  linkMade = true;
} catch { /* Windows 无开发者模式时跳过链接断言 */ }
if (linkMade) {
  const linked = await service.scan();
  const linkItem = linked.items.find(item => item.name === 'link-model');
  assert.ok(!linkItem || linkItem.size === 0, 'symlinked model directories are not measured');
  const outside = path.join(temp, 'outside.txt');
  fs.writeFileSync(outside, 'do not delete');
  const linkFile = path.join(root, 'logs/outside.log');
  try {
    fs.symlinkSync(outside, linkFile, 'file');
    const withLink = await service.scan();
    assert.ok(!withLink.items.some(item => item.name === 'outside.log'), 'symlinked logs are skipped');
    await removeDeep(linkFile);
    assert.ok(fs.existsSync(outside), 'removing a symlink must not delete its target');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not delete');
  } catch (error) {
    assert.fail('symlink handling failed: ' + error.message);
  }
  fs.unlinkSync(linkDir);
}

/* removeDeep 对目录与文件都返回合理字节数 */
put('scratch/a.bin', 'x'.repeat(10));
put('scratch/nested/b.bin', 'x'.repeat(20));
assert.equal(await removeDeep(path.join(root, 'scratch')), 30);
assert.equal(fs.existsSync(path.join(root, 'scratch')), false);

fs.rmSync(temp, { recursive: true, force: true });
console.log('Storage scan: categories, protection rules, whitelist deletion and traversal guards passed');
