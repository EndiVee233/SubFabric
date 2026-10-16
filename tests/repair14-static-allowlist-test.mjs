import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolatedServer } from './helpers/isolated-server.mjs';

const s = await isolatedServer();
const put = (name, text) => { const file = path.join(s.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const raw = url => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port: s.port, path: url, headers: { Origin: s.origin } }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});
try {
  for (const name of ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm', 'fonts/NotoSansCJKsc-Regular.otf']) put('editor/vendor/' + name, 'isolated resource');
  // 按真实 HTTP 响应递归加载浏览器 script/style/import 图，新增依赖遗漏会直接失败。
  const seen = new Set(), queue = ['/editor/studio.html'];
  while (queue.length) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    const response = await s.call(url); assert.equal(response.status, 200, url);
    const text = await response.text();
    const refs = url.endsWith('.html') ? [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
      : [...text.matchAll(/(?:from\s*|import\s*\()?['"]((?:\.{1,2}\/|\/)[^'"\n]+\.js(?:\?[^'"\n]*)?)['"]/g)].map(m => m[1]);
    for (const ref of refs) if (!ref.startsWith('#') && !/^[a-z]+:/i.test(ref)) queue.push(new URL(ref, s.origin + url).pathname);
  }
  assert.ok(seen.has('/editor/region-merge.js')); assert.ok(seen.has('/editor/danmaku.js'));
  for (const [url, type] of [['/editor/lang/zh-CN.json', 'application/json'], ['/editor/vendor/subtitles-octopus-worker.wasm', 'application/wasm'], ['/editor/vendor/fonts/NotoSansCJKsc-Regular.otf', 'font/otf'], ['/editor/vendor/subtitles-octopus-worker.js', 'text/javascript']]) {
    const r = await s.call(url); assert.equal(r.status, 200); assert.ok(r.headers.get('content-type').startsWith(type));
  }
  for (const name of ['asr/settings.json', 'projects/p-static/subtitle.srt', 'dev/editor/server.js', 'logs/server.log', 'build/SubFabric.exe', '.git/config', '.diag.json', 'editor/.env', 'editor/vendor/private.json', 'editor/js/unlisted.js']) put(name, 'private-data');
  put('tests/example.html', '<p>test-mode</p>');
  for (const url of ['/asr/settings.json', '/projects/p-static/subtitle.srt', '/dev/editor/server.js', '/logs/server.log', '/build/SubFabric.exe', '/.git/config', '/.diag.json', '/editor/.env', '/editor/server.js', '/editor/secret-store.js', '/editor/asr-service.js', '/editor/fonts.js', '/editor/vendor/private.json', '/editor/js/unlisted.js', '/tests/example.html', '/__test/example.html', '/editor/js/%2e%2e%2fserver.js', '/editor/js/%252e%252e%252fserver.js', '/editor/js/%2e%2e%5csecret-store.js', '/%2egit/config', '/editor/js/main.js%3A%3A%24DATA', '/editor/js/main.js%00', '/%zz']) {
    const r = await raw(url); assert.ok([403, 404].includes(r.status), url + ': ' + r.status); assert.ok(!r.body.includes('private-data'));
  }
  assert.equal((await s.call('/editor/js/main.js', { method: 'POST' })).status, 405);
  assert.ok([403,404].includes((await s.call('/editor/index.html')).status));
  // 明确样例目录仍可提供中文文件；其他根目录同名文件不公开。
  put('samples/示例.srt', 'sample-subtitle'); put('示例.srt', 'private-data');
  const samples = await (await s.call('/api/samples')).json(); assert.equal(samples.subs.length, 1);
  assert.equal(await (await s.call(samples.subs[0].url)).text(), 'sample-subtitle');
  assert.equal((await s.call('/' + encodeURIComponent('示例.srt'))).status, 403);
  // 项目字幕及登记媒体使用受控 API，Range/HEAD 保持可用。
  const video = put('projects/p-static/video/片段.mp4', '0123456789');
  put('projects/p-static/project.json', JSON.stringify({ id: 'p-static', video: { path: video }, subtitle: { file: 'subtitle.srt' } }));
  assert.equal(await (await s.call('/api/projects/p-static/subtitle')).text(), 'private-data');
  const media = '/api/media?path=' + encodeURIComponent(video);
  let r = await s.call(media, { headers: { Range: 'bytes=2-5' } }); assert.equal(r.status, 206); assert.equal(await r.text(), '2345');
  r = await s.call(media, { method: 'HEAD', headers: { Range: 'bytes=2-5' } }); assert.equal(r.status, 206); assert.equal(r.headers.get('content-length'), '4'); assert.equal(await r.text(), '');
  const privateDir = path.join(s.root, 'projects/private'); put('projects/private/main.js', 'private-data');
  fs.renameSync(path.join(s.root, 'editor/js'), path.join(s.root, 'editor/js-original'));
  fs.symlinkSync(privateDir, path.join(s.root, 'editor/js'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await s.call('/editor/js/main.js')).status, 403);
} finally { await s.close(); }

const test = await isolatedServer({ env: { SUBFABRIC_TEST_MODE: '1' } });
try {
  const dir = path.join(test.root, 'tests'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'example.html'), '<p>test-mode</p>'); fs.writeFileSync(path.join(dir, 'private.json'), 'private');
  assert.equal((await test.call('/__test/example.html')).status, 200);
  assert.equal((await test.call('/__test/private.json')).status, 404);
  fs.renameSync(dir, dir + '-original');
  fs.symlinkSync(dir + '-original', dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await test.call('/__test/example.html')).status, 404);
} finally { await test.close(); }
console.log('repair14: complete browser resource graph, wasm/font/shared modules, private/encoded/link rejection, test-mode and media Range/HEAD passed');
