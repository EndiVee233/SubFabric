/* 主页「可编辑」卡圆环：最近 7 天每个项目操作日志计数。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const s = await isolatedServer();
try {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const mk = (id, name, entries) => {
    const dir = path.join(s.root, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name }));
    fs.writeFileSync(path.join(dir, 'oplog.json'), JSON.stringify(entries));
  };
  mk('p-a', '项目 A', [
    { t: iso(now - 3600000), action: 'edit' },
    { t: iso(now - 2 * 86400000), action: 'split' },
    { t: iso(now - 30 * 86400000), action: 'old' },
  ]);
  mk('p-b', '项目 B', [{ t: iso(now - 23 * 3600000), action: 'edit' }]);
  mk('p-empty', '空项目', []);
  const r = await s.call('/api/oplog/stats?days=7');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.total, 3);
  assert.deepEqual(j.projects.map(p => [p.id, p.count]), [['p-a', 2], ['p-b', 1]]);
  const old = await (await s.call('/api/oplog/stats?days=1')).json();
  assert.equal(old.total, 2, '最近 1 天只统计一天内的日志');
  console.log('oplog-stats: 最近改动按项目计数与时间窗口通过');
} finally { await s.close(); }
