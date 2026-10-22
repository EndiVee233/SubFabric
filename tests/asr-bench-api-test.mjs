import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
const wav = path.join(os.tmpdir(), `sf-bench-api-${Date.now()}.wav`);
fs.writeFileSync(wav, Buffer.alloc(44));
try {
  const idle = await (await server.call('/api/asr/bench/state')).json();
  assert.equal(idle.running, false);
  assert.deepEqual(idle.results, []);

  const noAudio = await server.call('/api/asr/bench/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models: ['parakeet-tdt-0.6b-v2'] }),
  });
  assert.equal(noAudio.status, 400);
  assert.match((await noAudio.json()).error, /测试音频/);

  const noModels = await server.call('/api/asr/bench/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: wav, models: [] }),
  });
  assert.equal(noModels.status, 400);
  assert.match((await noModels.json()).error, /至少选择/);

  const unknown = await server.call('/api/asr/bench/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: wav, models: ['not-a-model'] }),
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /未知模型/);

  const cloud = await server.call('/api/asr/bench/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: wav, models: ['bcut-asr'] }),
  });
  assert.equal(cloud.status, 400, '云端模型没有本地可测文件');

  console.log('asr-bench-api-test: ok');
} finally {
  try { fs.unlinkSync(wav); } catch {}
  await server.close();
}
