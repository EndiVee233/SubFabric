import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
try {
  const status = await (await server.call('/api/asr/status')).json();
  const fw = (status.models || []).find(m => m.id === 'faster-whisper-large-v2');
  assert.ok(fw, '状态里应有 faster-whisper-large-v2');
  assert.ok(fw.params, 'Whisper large-v2 应带参数摘要');
  assert.equal(fw.params.count, 7);
  assert.ok(fw.params.summary.includes('VAD 关'), '默认摘要应显示 VAD 关');

  const got = await (await server.call('/api/asr/params?model=faster-whisper-large-v2')).json();
  assert.equal(got.ok, true);
  assert.equal(got.values.vad, false);
  assert.equal(got.values.vadThreshold, 0.05);
  assert.equal(got.isDefault, true);
  assert.equal(got.schema.find(f => f.key === 'vad').type, 'bool');

  const saved = await (await server.call('/api/asr/params', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'faster-whisper-large-v2',
      values: { vad: true, vadThreshold: 0.2, vadMethod: 'silero_v5', vocalExtract: false, wordTimestamps: false, language: 'zh', prompt: '术语 A' },
    }),
  })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.values.vad, true);
  assert.equal(saved.values.vadMethod, 'silero_v5');
  assert.equal(saved.values.prompt, '术语 A');
  assert.equal(saved.isDefault, false);

  const again = await (await server.call('/api/asr/params?model=faster-whisper-large-v2')).json();
  assert.equal(again.values.vadThreshold, 0.2);
  assert.equal(again.isDefault, false);
  const settings = JSON.parse(fs.readFileSync(path.join(server.root, 'asr/settings.json'), 'utf8'));
  assert.equal(settings.modelParams['faster-whisper-large-v2'].vad, true);

  const status2 = await (await server.call('/api/asr/status')).json();
  const fw2 = status2.models.find(m => m.id === 'faster-whisper-large-v2');
  assert.ok(fw2.params.summary.includes('VAD 开'));
  assert.equal(fw2.params.isDefault, false);

  const bad = await server.call('/api/asr/params', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'faster-whisper-large-v2', values: { vadThreshold: 'nope' } }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /阈值/);

  const reset = await (await server.call('/api/asr/params', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'faster-whisper-large-v2', reset: true }),
  })).json();
  assert.equal(reset.ok, true);
  assert.equal(reset.isDefault, true);
  assert.equal(reset.values.vad, false);
  const after = JSON.parse(fs.readFileSync(path.join(server.root, 'asr/settings.json'), 'utf8'));
  assert.equal(after.modelParams, undefined, '恢复默认后应删掉该模型的覆盖值');

  const cpp = await (await server.call('/api/asr/params?model=ggml-large-v3-turbo')).json();
  assert.equal(cpp.ok, true);
  assert.equal(cpp.values.threads, 4);
  assert.ok(cpp.schema.some(f => f.key === 'language'));

  const none = await server.call('/api/asr/params?model=parakeet-tdt-0.6b-v2');
  assert.equal(none.status, 400, '未登记参数的模型不能凭空返回 schema');
  console.log('asr-params-api-test: ok');
} finally {
  await server.close();
}
