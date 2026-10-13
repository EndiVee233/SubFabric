import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolatedServer } from './helpers/isolated-server.mjs';
const s = await isolatedServer();
try {
  const dir = path.join(s.root, 'projects/p-meta'); fs.mkdirSync(dir, { recursive: true });
  const metaFile = path.join(dir, 'project.json');
  const initial = { id: 'p-meta', name: 'old', subtitle: { file: 'subtitle.ass' }, peaks: { file: 'peaks.bin', ver: 2 },
    draft: { status: 'running', progress: 4 }, video: { path: '', name: '' } };
  fs.writeFileSync(metaFile, JSON.stringify(initial)); fs.writeFileSync(path.join(dir, 'subtitle.ass'), 'old');
  fs.writeFileSync(path.join(dir, 'peaks.bin'), 'isolated');
  const video = path.join(s.root, 'video.mp4'); fs.writeFileSync(video, 'isolated');
  let resolve;
  const result = new Promise(r => { resolve = r; });
  const req = http.request(s.origin + '/api/projects/p-meta/relink', { method: 'POST', headers: { Origin: s.origin } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ code: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
  });
  req.write('{"videoPath":'); await new Promise(r => setTimeout(r, 80));
  // 隔离夹具模拟任务在上传期间完成；名称更新走真实 HTTP 路由。
  const completed = JSON.parse(fs.readFileSync(metaFile)); completed.draft = { status: 'done', progress: 100, words: 123 };
  fs.writeFileSync(metaFile, JSON.stringify(completed));
  const rename = await s.call('/api/projects/p-meta/info', { method: 'PUT', body: '{"name":"new name"}' }); assert.equal(rename.status, 200);
  req.end(JSON.stringify(video) + '}'); assert.equal((await result).code, 200);
  const meta = JSON.parse(fs.readFileSync(metaFile));
  assert.equal(meta.name, 'new name'); assert.equal(meta.draft.progress, 100); assert.equal(meta.draft.words, 123); assert.equal(meta.video.path, video);
  const sub = await s.call('/api/projects/p-meta/subtitle');
  const save = await s.call('/api/projects/p-meta/subtitle?revision=' + sub.headers.get('etag').replaceAll('"', ''), { method: 'PUT', body: 'new' }); assert.equal(save.status, 200);
  const saved = JSON.parse(fs.readFileSync(metaFile));
  assert.equal(saved.name, meta.name); assert.deepEqual(saved.draft, meta.draft); assert.deepEqual(saved.video, meta.video);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
  console.log('repair06: slow relink upload retains concurrent name/task changes and subtitle save fields passed');
} finally { await s.close(); }
