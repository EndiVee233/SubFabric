/* 批量创建初稿：接口/串行作业契约。
 *
 *  fixture 是一个「有视频、无字幕」的项目；隔离环境里没有 ASR 模型，作业应把这一项
 *  标记为失败而不是让接口 500，也不会生成半截字幕。前端静态契约另外检查按钮/弹窗/轮询。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const sid = 'p-batch-fixture';
const server = await isolatedServer();
try {
  const dir = path.join(server.root, 'projects', sid);
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(server.root, 'fixture.mp4');
  fs.writeFileSync(video, '');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id: sid, name: '批量测试项目', video: { path: video, name: 'fixture.mp4' },
    prepare: { status: 'done' }, createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
  }));

  const r = await server.call('/api/projects/batch-draft', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [sid], options: { wordLevel: true } }),
  });
  assert.equal(r.status, 200, '批量接口返回 200');
  const job = await r.json();
  assert.match(job.id, /^bd-/, '返回批量作业 id');
  assert.equal(job.total, 1);
  assert.equal(job.items[0].name, '批量测试项目', '作业项带项目名');

  let final = job;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 200));
    const pr = await server.call('/api/projects/batch-draft/' + job.id);
    assert.equal(pr.status, 200);
    final = await pr.json();
    if (final.status !== 'running') break;
  }
  assert.equal(final.status, 'done', '作业结束');
  assert.equal(final.failed, 1, '没有模型时该项失败');
  assert.match(final.items[0].error, /模型|识别/, '失败原因可读：' + final.items[0].error);

  const missing = await server.call('/api/projects/batch-draft/bd-does-not-exist');
  assert.equal(missing.status, 404, '过期/不存在的作业 404');

  const empty = await server.call('/api/projects/batch-draft', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }),
  });
  assert.equal(empty.status, 400, '空选择 400');

  const ui = fs.readFileSync(new URL('../editor/js/project.js', import.meta.url), 'utf8');
  const tpl = fs.readFileSync(new URL('../tools/templates/studio.html', import.meta.url), 'utf8');
  assert.match(tpl, /id="btn-batch-draft"/, '项目列表有批量初稿入口');
  assert.match(tpl, /id="batch-draft-overlay"/, '有批量选择弹窗');
  assert.match(ui, /bdEligible = ps => ps\.filter\(p => p && p\.videoExists && !p\.format/, '只选有视频、无字幕项目');
  assert.match(ui, /\/api\/projects\/batch-draft/, '前端调用批量接口并轮询');
  assert.match(ui, /setTimeout\(bdPoll, 1600\)/, '轮询批量进度');
  console.log('batch-draft: 接口 200/404/400、串行失败项与前端入口/轮询通过');
} finally {
  await server.close();
}
