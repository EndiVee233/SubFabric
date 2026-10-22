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

  // 已停用模型：状态里不出现，参数接口也不接受
  for (const id of ['ggml-large-v3-turbo', 'parakeet-tdt-0.6b-v2', 'vibevoice-asr-4bit',
    'multitalker-parakeet-streaming-0.6b-v1', 'parakeet-tdt-0.6b-v2-dual']) {
    assert.equal((status.models || []).some(m => m.id === id), false, id + ' 不应出现在状态里');
    const gone = await server.call('/api/asr/params?model=' + encodeURIComponent(id));
    assert.equal(gone.status, 400, id + ' 的参数接口应返回 400');
  }

  const qwen = (status.models || []).find(m => m.id === 'qwen3-asr-1.7b');
  assert.ok(qwen, '状态里应有 Qwen3-ASR');
  assert.equal(qwen.params.count, 2);
  assert.match(qwen.params.summary, /分块 150s/);
  const qp = await (await server.call('/api/asr/params?model=qwen3-asr-1.7b')).json();
  assert.equal(qp.ok, true);
  assert.equal(qp.values.chunkSec, 150);
  assert.equal(qp.values.maxNewTokens, 4096);

  const none = await server.call('/api/asr/params?model=bcut-asr');
  assert.equal(none.status, 400, '未登记参数的模型不能凭空返回 schema');
  console.log('asr-params-api-test: ok');
} finally {
  await server.close();
}
