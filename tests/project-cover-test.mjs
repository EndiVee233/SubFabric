import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedServer } from './helpers/isolated-server.mjs';

if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) {
  console.log('[SKIP] Project cover conversion needs FFmpeg on PATH');
  process.exit(0);
}

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const onlineUrl = 'https://i.ytimg.com/vi/cover-fixture/hqdefault.jpg';
const server = await isolatedServer({ prepare(root, editor) {
  const make = (id, fields = {}) => {
    const dir = path.join(root, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name: '稿件：封面', ...fields }));
    return dir;
  };
  const video = path.join(root, 'fixture.mp4');
  make('p-video', { video: { path: video } });
  const legacy = make('p-legacy', { cover: { file: 'cover.jpg' } });
  make('p-online', { source: { thumbnail: onlineUrl, title: '在线封面' } });
  make('p-untrusted', { source: { thumbnail: 'http://127.0.0.1/cover.jpg' } });
  for (const output of [video, path.join(legacy, 'cover.jpg')]) {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180',
      '-frames:v', '1', '-threads', '1', ...(output.endsWith('.jpg') ? ['-update', '1'] : []), output],
    { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  // Only the public CDN response is simulated. The real HTTP routes and PNG encoder run normally.
  const js = path.join(editor, 'server.js');
  let source = fs.readFileSync(js, 'utf8');
  const target = '  const response = await fetch(url, { redirect: \'error\', signal: AbortSignal.timeout(12000) })';
  assert.ok(source.includes(target));
  source = source.replace(target, `  const response = await (async () => {
    if (url !== ${JSON.stringify(onlineUrl)}) throw new Error('Unexpected cover origin');
    fs.appendFileSync(${JSON.stringify(path.join(root, 'thumbnail-fetches'))}, '1');
    return new Response(fs.readFileSync(${JSON.stringify(path.join(legacy, 'cover.jpg'))}));
  })()`);
  fs.writeFileSync(js, source);
} });

try {
  const download = id => server.call(`/api/projects/${id}/cover?download=1`);
  const checkPng = async response => {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 8), signature);
    return bytes;
  };
  const fresh = await server.call('/api/projects/p-video');
  assert.equal((await fresh.json()).coverAvailable, true);
  const generated = await checkPng(await download('p-video'));
  assert.equal(generated.readUInt32BE(16), 640, 'local video frame keeps the existing preview scale');

  const oldImage = path.join(server.root, 'projects/p-legacy/cover.jpg');
  const legacyBytes = fs.readFileSync(oldImage);
  const legacy = await download('p-legacy');
  assert.match(legacy.headers.get('content-disposition'), /^attachment;/);
  assert.equal(decodeURIComponent(legacy.headers.get('content-disposition').split("filename*=UTF-8''")[1]), '稿件：封面 - 封面.png');
  assert.equal((await checkPng(legacy)).readUInt32BE(16), 320, 'old cover is converted at its original dimensions');
  assert.deepEqual(fs.readFileSync(oldImage), legacyBytes);

  const previews = await Promise.all([
    server.call('/api/projects/p-online/cover?png=1'),
    download('p-online'),
  ]);
  const pixels = await Promise.all(previews.map(checkPng));
  assert.deepEqual(pixels[0], pixels[1], 'preview and download use the same PNG');
  const list = await (await server.call('/api/projects')).json();
  assert.match(list.projects.find(p => p.id === 'p-online').cover, /^\/api\/projects\/p-online\/cover\?v=/);
  assert.deepEqual(await checkPng(await download('p-online')), pixels[0]);
  assert.equal((await download('p-untrusted')).status, 404);
  assert.equal(fs.readFileSync(path.join(server.root, 'thumbnail-fetches'), 'utf8'), '1');
  console.log('project-cover: real PNG from video, legacy JPEG and cached online cover');
} finally {
  await server.close();
}
