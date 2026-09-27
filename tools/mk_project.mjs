// 建一个测试项目(视频 + ASS 字幕), 供浏览器复现用。
// 用法: node tools/mk_project.mjs [视频路径] [字幕路径] [项目名]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8321';
const video = path.resolve(process.argv[2] || 'tmp-test/sample.mp4');
const sub = path.resolve(process.argv[3] || 'tmp-test/sample.ass');
const name = process.argv[4] || 'BugRepro';

const body = {
  name,
  video: { path: video },
  subtitle: { name: path.basename(sub), text: readFileSync(sub, 'utf8') },
};
const r = await fetch(BASE + '/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const j = await r.json();
if (!r.ok) { console.error('创建失败', r.status, j); process.exit(1); }
console.log('projectId=' + j.id);
writeFileSync('tmp-test/last-project.txt', j.id);
