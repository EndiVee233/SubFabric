import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { zipFixture } from './helpers/zip-fixture.mjs';
const s = await isolatedServer();
const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => /^kass-(import|unpack)-/.test(n)));
const sub = '1\n00:00:01,000 --> 00:00:02,000\nreal subtitle\n';
try {
  const importPack = async files => {
    const r = await s.call('/api/projects/import-pack', { method: 'POST', body: zipFixture(files) });
    return { status: r.status, data: await r.json() };
  };
  for (const files of [
    [{ name: 'subtitle.srt', body: sub, declaredBytes: 64 * 1024 * 1024 + 1 }],
    [{ name: '../subtitle.srt', body: sub }], [{ name: '/subtitle.srt', body: sub }],
    [{ name: 'subtitle.srt', body: sub, attr: 0xa1ff0000 }],
    [{ name: 'subtitle.srt', body: sub }, { name: 'a/subtitle.srt', body: sub }],
    [{ name: 'subtitle.srt', body: sub, declaredBytes: 1 }],
    [{ name: 'subtitle.srt', body: 'invalid subtitle' }],
    Array.from({ length: 129 }, (_, i) => ({ name: i ? `file${i}.txt` : 'subtitle.srt', body: sub }))
  ]) {
    const result = await importPack(files); assert.equal(result.status, 400, JSON.stringify(result));
    /* 失败响应先于清理落盘：服务端在 finally 里删除刚建的项目目录，与客户端收到 400
     * 之间存在毫秒级竞态（实测本机稳定复现：响应到达时目录仍在，几百毫秒内消失）。
     * 轮询等待真实的“无残留”，不把异步清理的时序抖动误报成回归。 */
    const projectsDir = path.join(s.root, 'projects');
    let leftovers = null;
    for (let i = 0; i < 30; i++) {
      leftovers = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [];
      if (!leftovers.length) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.deepEqual(leftovers, [], '失败导入不得留下项目目录');
  }
  const result = await importPack([{ name: '合法包装/subtitle.srt', body: sub }, { name: '合法包装/project.json', body: '{"name":"合法"}' },
    { name: '合法包装/unrelated.txt', body: 'do not import' }]);
  assert.equal(result.status, 200);
  const dir = path.join(s.root, 'projects', result.data.id);
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.srt'), 'utf8'), sub);
  assert.equal(fs.existsSync(path.join(dir, 'unrelated.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'))).name, '合法');
  // 临时上传/解压目录同样在响应之后清理；轮询等待它们真实消失，再断言无残留。
  let tmpLeftovers = null;
  for (let i = 0; i < 30; i++) {
    tmpLeftovers = fs.readdirSync(os.tmpdir()).filter(n => /^kass-(import|unpack)-/.test(n) && !before.has(n));
    if (!tmpLeftovers.length) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.deepEqual(tmpLeftovers, [], '导入不得留下临时上传/解压目录');
  console.log('repair09: preflight size/count/path/link, actual output bound, invalid subtitle cleanup and wrapped core-only import passed');
} finally { await s.close(); }
