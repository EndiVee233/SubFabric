import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedServer } from './helpers/isolated-server.mjs';

// 保留真实路由、队列和初稿收尾，用文件控制隔离进程中的识别完成顺序。
const server = await isolatedServer({
  prepare(_root, editor) {
    const file = path.join(editor, 'server.js');
    const src = fs.readFileSync(file, 'utf8');
    const listen = 'server.listen(PORT, HOST,';
    assert.ok(src.includes(listen));
    fs.writeFileSync(file, src.replace(listen, `
modelReady = () => true;
modelAllowedForUser = () => true;
missingModelFiles = () => [];
asrGpuGateError = () => '';
translateCfg = () => ({ baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'fixture' });
const fixtureSpawn = spawn;
spawn = (exe, args, opts) => exe === FFMPEG && args.includes('-ss')
  ? fixtureSpawn(process.execPath, ['-e', ''], opts)
  : fixtureSpawn(exe, args, opts);
const fixtureAsr = async dir => {
  fs.writeFileSync(path.join(dir, 'started'), '');
  const gate = path.join(dir, 'finish');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(gate) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  if (!fs.existsSync(gate) || fs.readFileSync(gate, 'utf8') === 'fail') throw new Error('fixture ASR failure');
  return { segments: [{ start: 0, end: 1, text: 'Hello', words: [] }] };
};
runFasterWhisper = (_wav, _model, _progress, opts) => fixtureAsr(opts.outRoot);
runCrispAsr = (_model, wav) => fixtureAsr(path.dirname(wav));
toCloudAudio = async wav => wav + '.mp3';
transcribeCloud = ({ audioPath, engine }) => fixtureAsr(path.dirname(audioPath))
  .then(result => ({ ...result, engine, name: engine, modelId: engine + '-asr' }));
runDraftReseg = id => {
  setDraft(id, { stage: STAGE.reseg });
  return new Promise(() => {});
};
resegMod.resegWithLLM = () => new Promise(() => {});
` + listen));
  },
});

const whisper = 'faster-whisper-large-v2';
const whisperVulkan = 'whisper-large-v2-vulkan';
const qwen = 'qwen3-asr-1.7b-vulkan';
const parakeet = 'parakeet-tdt-0.6b-v2-vulkan';
const projectDir = id => path.join(server.root, 'projects', id);
const started = id => fs.existsSync(path.join(projectDir(id), 'started'));
const finish = (id, result = 'ok') => fs.writeFileSync(path.join(projectDir(id), 'finish'), result);

function project(id, modelId) {
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio.wav'), '');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    id, name: id, draft: { status: 'error', stage: 'ASR识别中', modelId },
  }));
}

async function call(id, action, method = 'GET', body) {
  const url = '/api/projects/' + id + (action ? '/' + action : '');
  const response = await server.call(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const data = await response.json();
  assert.ok(response.ok, url + ' ' + JSON.stringify(data));
  return data;
}

async function waitFor(test, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(25);
  }
  assert.fail(message + '\n' + server.output());
}

try {
  for (const [id, model] of [
    ['w1', whisper], ['w2', whisperVulkan], ['w3', whisper], ['w-del', whisper],
    ['q1', qwen], ['q2', qwen], ['rr', whisper],
    ...Array.from({ length: 5 }, (_, i) => ['p' + i, parakeet]),
    ...Array.from({ length: 3 }, (_, i) => ['cloud' + i, 'bcut-asr']),
  ]) project(id, model);

  for (const id of ['w1', 'w2', 'w3', 'q1', 'q2', 'w-del']) await call(id, 'retry', 'POST');
  await call('rr', 'rerecognize', 'POST', { start: 0, end: 1 });
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4', 'cloud0', 'cloud1', 'cloud2']) await call(id, 'retry', 'POST');
  await waitFor(() => ['w1', 'w2', 'q1', 'p0', 'p1', 'p2', 'p3', 'cloud0', 'cloud1', 'cloud2'].every(started),
    'eligible jobs should start independently');
  for (const id of ['w3', 'q2', 'p4', 'w-del']) {
    assert.equal(started(id), false);
    const { draft } = await call(id, 'draft');
    assert.equal(draft.status, 'running');
    assert.equal(draft.stage, '识别排队中');
  }
  assert.equal((await call('rr', 'rerecognize')).job.stage, '识别排队中');
  assert.equal(started('rr'), false);
  await call('w-del', '', 'DELETE');

  finish('q1');
  await waitFor(() => started('q2'), 'Qwen should acquire the slot during semantic segmentation');
  assert.equal((await call('q1', 'draft')).draft.stage, '语义分句中');
  assert.equal(started('w3'), false, 'Whisper still has two running jobs');

  finish('w1', 'fail');
  await waitFor(() => started('w3'), 'a failed recognition must release its slot to the oldest eligible job');
  assert.equal((await call('w1', 'draft')).draft.status, 'error');
  finish('w2');
  await waitFor(() => started('rr'), 'region recognition should share the initial-draft queue');
  assert.equal(fs.existsSync(projectDir('w-del')), false, 'a deleted queued job must never start');

  project('w4', whisper);
  await call('w4', 'retry', 'POST');
  assert.equal((await call('w4', 'draft')).draft.stage, '识别排队中');
  finish('rr');
  await waitFor(() => started('w4'), 'region recognition must release its slot before semantic segmentation');
  assert.equal((await call('rr', 'rerecognize')).job.stage, '语义分句中');

  finish('p0');
  await waitFor(() => started('p4'), 'the fifth Parakeet job should start when one of its four slots frees up');

  finish('w3');
  for (const id of ['q3', 'q4']) {
    project(id, qwen);
    await call(id, 'retry', 'POST');
  }
  await waitFor(() => started('q3'), 'Qwen should be able to use two slots');
  finish('w4');
  await waitFor(async () => (await call('w4', 'draft')).draft.stage === '语义分句中', 'Whisper should leave the queue');
  assert.equal(started('q4'), false, 'Qwen should remain capped at two even when the shared pool has a free slot');
  assert.equal((await call('q4', 'draft')).draft.stage, '识别排队中');
  console.log('asr-concurrency-test: ok');
} finally {
  await server.close();
}
