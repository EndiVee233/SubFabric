import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

/* 「已校对」标签：realignSkip 写进 project.json，供全片逐词重校对跳过。 */
const s = await isolatedServer();
try {
  const dir = path.join(s.root, 'projects/p-skip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-skip', name: 'skip', subtitle: { file: 'subtitle.ass' } }));

  let r = await s.call('/api/projects/p-skip/realign-skip', { method: 'POST', body: JSON.stringify({ skip: ['12.345', '99.001', '3.5'] }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).count, 3);
  let meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.deepEqual(meta.realignSkip.sort(), ['12.345', '3.5', '99.001']);

  // 去重 + 过滤非法值
  r = await s.call('/api/projects/p-skip/realign-skip', { method: 'POST', body: JSON.stringify({ skip: ['1.000', '1.000', 'abc', '', '2.5.5', -1] }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).count, 1);
  meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.deepEqual(meta.realignSkip, ['1.000']);

  // 打开项目时 metaView 带回 realignSkip
  const g = await s.call('/api/projects/p-skip');
  const gm = await g.json();
  assert.deepEqual(gm.realignSkip, ['1.000']);

  // 非法请求
  assert.equal((await s.call('/api/projects/p-skip/realign-skip', { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await s.call('/api/projects/p-skip/realign-skip', { method: 'POST', body: JSON.stringify({ skip: new Array(20001).fill('1.0') }) })).status, 400);

  console.log('realign-skip: 写入/去重/非法过滤/随项目返回 全部通过');
} finally {
  await s.close();
}
