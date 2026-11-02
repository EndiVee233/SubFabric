import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

/* 隔离服务：ROOT 是临时目录，全部删除都发生在临时项目/模型/日志里。 */
const server = await isolatedServer({
  prepare(root) {
    const put = (relative, content) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    put('projects/p-api/project.json', JSON.stringify({ id: 'p-api', name: '接口验证项目' }));
    put('projects/p-api/subtitle.ass', '[Script Info]\nTitle: keep\n');
    put('projects/p-api/audio.wav', 'x'.repeat(1200));
    put('projects/p-api/peaks.bin', 'x'.repeat(300));
    put('projects/p-api/video/source.mp4', 'x'.repeat(2000));
    put('asr/models/current-model/w.bin', 'x'.repeat(600));
    put('asr/models/spare-model/w.bin', 'x'.repeat(900));
    put('asr/runtime-python/python.exe', 'x'.repeat(80));
    put('asr/runtime-vibevoice/v.bin', 'x'.repeat(400));
    put('asr/ytdlp/yt-dlp.exe', 'x'.repeat(60));
    put('logs/old.log', 'x'.repeat(500));
    const old = new Date(Date.now() - 20 * 86400000);
    fs.utimesSync(path.join(root, 'logs/old.log'), old, old);
    fs.writeFileSync(path.join(root, 'asr/settings.json'), JSON.stringify({
      selectedModel: 'current-model', rerecogModel: 'current-model', models: {}, asrProvider: 'cuda',
    }));
  },
});

try {
  /* 未扫描前不能清理 */
  const early = await server.call('/api/storage/clean', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['project:x'] }),
  });
  assert.equal(early.status, 409, 'clean before any scan is rejected');

  const response = await server.call('/api/storage');
  assert.equal(response.status, 200);
  const scan = await response.json();
  assert.equal(scan.ok, true);
  assert.ok(scan.disk.total > 0);
  assert.deepEqual(scan.categories.map(c => c.id), ['project', 'model', 'runtime', 'cache', 'log']);
  assert.ok(scan.summary.cleanableBytes > 0);

  const project = scan.items.find(item => item.name === '接口验证项目');
  assert.ok(project, 'project intermediates are listed');
  assert.equal(project.size, 1500);
  assert.equal(project.removable, true);
  assert.ok(fs.existsSync(path.join(server.root, 'projects/p-api/subtitle.ass')));

  const current = scan.items.find(item => item.name === 'current-model');
  assert.equal(current.removable, false, 'selected model is protected over HTTP too');
  const spare = scan.items.find(item => item.name === 'spare-model');
  assert.equal(spare.removable, true);
  assert.equal(scan.items.find(item => item.name === 'runtime-python').removable, false);
  assert.equal(scan.items.find(item => item.name === 'ytdlp').removable, false);
  assert.equal(scan.items.find(item => item.name === 'old.log').removable, true);

  /* 参数校验 */
  for (const body of ['', '{', '{}', '{"ids":"x"}', '{"ids":[]}']) {
    const bad = await server.call('/api/storage/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(bad.status, 400, `invalid body ${JSON.stringify(body)} is rejected`);
  }
  const wrongMethod = await server.call('/api/storage/clean');
  assert.equal(wrongMethod.status, 404);
  const wrongRoute = await server.call('/api/storage/nope');
  assert.equal(wrongRoute.status, 404);

  /* 受保护条目 + 正常条目混在一起：只删后者，并逐项报告失败 */
  const clean = await server.call('/api/storage/clean', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [current.id, spare.id, project.id] }),
  });
  assert.equal(clean.status, 200);
  const result = await clean.json();
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 2);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /使用|保护/);
  assert.equal(result.freed, 900 + 1500);
  assert.ok(!fs.existsSync(path.join(server.root, 'asr/models/spare-model')));
  assert.ok(!fs.existsSync(path.join(server.root, 'projects/p-api/audio.wav')));
  assert.ok(fs.existsSync(path.join(server.root, 'projects/p-api/subtitle.ass')), 'subtitle survives');
  assert.ok(fs.existsSync(path.join(server.root, 'projects/p-api/video/source.mp4')), 'source video survives');
  assert.ok(fs.existsSync(path.join(server.root, 'asr/models/current-model/w.bin')), 'protected model survives');

  /* 重新扫描后已删除条目消失、剩余占用更新 */
  const again = await (await server.call('/api/storage')).json();
  assert.equal(again.items.some(item => item.name === 'spare-model'), false);
  assert.equal(again.items.some(item => item.name === '接口验证项目'), false, 'only intermediates were removed, so the project leaves the list');

  /* 未知 id 不会越界删除 */
  const forged = await server.call('/api/storage/clean', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['project:deadbeefdeadbeef', 'runtime:..%2f..%2fsecret'] }),
  });
  assert.equal((await forged.json()).removed.length, 0);

  console.log('Storage API: scan categories, protection, validation and whitelist deletion passed');
} finally {
  await server.close();
}
