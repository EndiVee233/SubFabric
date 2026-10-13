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
    assert.deepEqual(fs.existsSync(path.join(s.root, 'projects')) ? fs.readdirSync(path.join(s.root, 'projects')) : [], []);
  }
  const result = await importPack([{ name: '合法包装/subtitle.srt', body: sub }, { name: '合法包装/project.json', body: '{"name":"合法"}' },
    { name: '合法包装/unrelated.txt', body: 'do not import' }]);
  assert.equal(result.status, 200);
  const dir = path.join(s.root, 'projects', result.data.id);
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.srt'), 'utf8'), sub);
  assert.equal(fs.existsSync(path.join(dir, 'unrelated.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'))).name, '合法');
  const leftovers = fs.readdirSync(os.tmpdir()).filter(n => /^kass-(import|unpack)-/.test(n) && !before.has(n));
  assert.deepEqual(leftovers, []);
  console.log('repair09: preflight size/count/path/link, actual output bound, invalid subtitle cleanup and wrapped core-only import passed');
} finally { await s.close(); }
