import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
try {
  const dir = path.join(server.root, 'videos'); fs.mkdirSync(dir);
  const original = Buffer.from('existing video must survive');
  fs.writeFileSync(path.join(dir, 'concurrent.mp4'), original);
  const uploads = await Promise.all(Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
    const payload = Buffer.alloc(65536, 65 + index);
    const req = http.request(server.origin + '/api/upload-video?name=concurrent.mp4', {
      method: 'POST', agent: false,
      headers: { Origin: server.origin, 'Content-Length': payload.length },
    }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => {
        try { resolve({ index, status: res.statusCode, ...JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('upload timed out')));
    req.on('error', reject);
    req.flushHeaders();
    setTimeout(() => req.end(payload), 30);
  })));
  assert.equal(new Set(uploads.map(x => x.path)).size, uploads.length);
  for (const upload of uploads) {
    assert.equal(upload.status, 200);
    assert.equal(upload.size, 65536);
    assert.equal(path.dirname(upload.path), dir);
    assert.deepEqual(fs.readFileSync(upload.path), Buffer.alloc(65536, 65 + upload.index));
    const media = await server.call('/api/media?path=' + encodeURIComponent(upload.path));
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.alloc(65536, 65 + upload.index));
  }
  assert.deepEqual(fs.readFileSync(path.join(dir, 'concurrent.mp4')), original);
  console.log('12 simultaneous uploads: unique names, exact payloads, media access and existing video preserved');
} finally { await server.close(); }
