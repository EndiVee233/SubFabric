import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedServer } from './helpers/isolated-server.mjs';

const key = 'fixture-credential-for-openai-asr';
const punctuated = (
  'The first recorded sentence has enough words for an ordinary subtitle. '
  + 'The next statement will continue after the speaker takes a short breath. '
  + 'The last line ends the test without changing any of the original words. '
).repeat(3).trim();
const server = await isolatedServer({
  prepare(_root, editor) {
    const file = path.join(editor, 'server.js');
    const source = fs.readFileSync(file, 'utf8');
    const listen = 'server.listen(PORT, HOST,';
    assert.ok(source.includes(listen) && source.includes('const sliceAudio ='));
    assert.ok(source.includes('const detectSilences ='));
    fs.writeFileSync(file, source.replace('const sliceAudio =', 'let sliceAudio =')
      .replace('const detectSilences =', 'let detectSilences =').replace(listen, `
detectSilences = async wav => path.basename(path.dirname(wav)) === 'p-plain'
  ? [{ start: 71, end: 73 }, { start: 135, end: 137 }] : [];
let currentProject = '';
const counts = new Map();
for (const cloud of CLOUD_ASR) {
  cloud.client.transcribe = async () => {
    if (currentProject === 'p-bcut') return { segments: [{ text: 'First cloud.' }] };
    if (cloud.engine === 'bcut') throw new Error('fixture unavailable');
    return { segments: currentProject === 'p-cloud' ? [{ text: 'Cloud result.' }] : [] };
  };
}
const available = ['qwen3-asr-1.7b', 'whisperx-large-v2', 'parakeet-tdt-0.6b-v2-vulkan'];
modelReady = id => {
  if (id === 'gpt-transcribe') return !!openAiAsrKey();
  if (currentProject === 'p-no-local') return false;
  if (currentProject === 'p-whisper' && id === available[0]) return false;
  if (currentProject === 'p-parakeet' && id !== available[2]) return false;
  return available.includes(id);
};
asrGpuGateError = () => null;
modelAllowedForUser = () => true;
runLocalClip = async model => {
  const target = { 'p-local': available[2], 'p-qwen': available[0], 'p-whisper': available[1], 'p-parakeet': available[2] };
  return { segments: model.id === target[currentProject] ? [{ text: 'Local result.' }] : [] };
};
sliceAudio = async (wav, start, end, out, asMp3) => {
  currentProject = path.basename(path.dirname(wav));
  fs.writeFileSync(out, JSON.stringify({ start, end, project: path.basename(path.dirname(wav)) }));
};
const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url !== 'https://api.openai.com/v1/audio/transcriptions') return fixtureFetch(url, options);
  if (options.method !== 'POST' || options.body.get('model') !== 'gpt-transcribe'
      || options.headers.Authorization !== 'Bearer ' + ${JSON.stringify(key)}) throw new Error('Unexpected OpenAI request');
  const info = JSON.parse(await options.body.get('file').text());
  fs.appendFileSync(path.join(ROOT, 'openai-calls.jsonl'), JSON.stringify(info) + '\\n');
  if (info.project === 'p-quota') return Response.json({ error: { code: 'credit_balance_exhausted' } }, { status: 429 });
  let text = 'Hello world.';
  if (info.project === 'p-plain') text = ${JSON.stringify(punctuated)};
  const counter = info.project + ':' + info.start;
  counts.set(counter, (counts.get(counter) || 0) + 1);
  if (info.start === 60 && ['p-empty', 'p-bcut', 'p-cloud', 'p-local', 'p-retry', 'p-qwen', 'p-whisper', 'p-parakeet', 'p-no-local'].includes(info.project)) {
    if (info.project === 'p-retry') text = counts.get(counter) < 3 ? ' ' : 'Recovered.';
    else if (info.project === 'p-empty' && counts.get(counter) > 3) text = 'Recovered.';
    else text = ' ';
  }
  return Response.json({ text, usage: { seconds: info.end - info.start } }, { headers: { 'x-request-id': 'req_fixture' } });
};
translateCfg = () => ({ baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'fixture', autoTranslate: false });
startTranslate = async id => finishDraft(id, null);
draftAlignerReady = async () => !fs.existsSync(path.join(ROOT, 'without-aligner'));
realignPrep = async id => ({ meta: { id } });
realignAlignBatch = async (prep, segments) => ({
  items: segments.map((seg, idx) => {
    if (prep.meta.id === 'p-partial-align' && idx === 1) return { ok: false, words: [] };
    const ws = seg.text.split(/ +/), start = seg.start + 0.1, step = (seg.end - start - 0.1) / ws.length;
    return { ok: true, words: ws.map((w, i) => ({ w, s: start + i * step, e: start + (i + 1) * step })) };
  }),
});
runDraftReseg = async id => {
  const stored = readSegments(id);
  if (!stored.every(seg => seg.words.length > 0)) throw new Error('OpenAI entered reseg before alignment');
};
` + listen));
  },
});

async function post(url, body) {
  return server.call(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function modelStatus() {
  const status = await (await server.call('/api/asr/status')).json();
  assert.equal(JSON.stringify(status).includes(key), false);
  return status.models.find(m => m.id === 'gpt-transcribe');
}

async function draft(id, { align = false, duration = 3, cachedSegments = null } = {}) {
  const dir = path.join(server.root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio.wav'), 'fixture');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name: id, duration,
    draft: { status: 'error', modelId: 'gpt-transcribe', engine: 'openai-asr', align, wordLevel: align } }));
  if (cachedSegments) {
    fs.writeFileSync(path.join(dir, 'asr.json'), JSON.stringify({ segments: cachedSegments }));
  }
  assert.equal((await post('/api/projects/' + id + '/retry', {})).status, 200);
  for (let i = 0; i < 120; i++) {
    const state = await (await server.call('/api/projects/' + id + '/draft')).json();
    if (state.draft.status !== 'running') return { ...state, dir };
    await delay(25);
  }
  assert.fail('Draft did not complete: ' + server.output());
}

try {
  const initial = await modelStatus();
  assert.equal(initial.cloud, true);
  assert.equal(initial.nativeWordLevel, false);
  assert.equal(initial.requiresAlignment, true);
  assert.equal(initial.usable, false);
  const missing = await draft('p-missing');
  assert.match(missing.draft.error, /填写 OpenAI API Key/);

  assert.deepEqual(await (await post('/api/asr/openai-key', { apiKey: key })).json(), { hasKey: true });
  const settings = fs.readFileSync(path.join(server.root, 'asr/settings.json'), 'utf8');
  assert.equal(settings.includes(key), false);
  assert.match(JSON.parse(settings).openAiAsrKeyEnc, /^(dpapi|aes):/);
  assert.equal((await modelStatus()).usable, true);

  const plain = await draft('p-plain', { duration: 302 });
  assert.equal(plain.draft.error, null);
  assert.equal(plain.draft.align, true);
  assert.equal(plain.draft.wordLevel, true);
  assert.ok(fs.existsSync(path.join(plain.dir, 'subtitle.ass')));
  assert.equal(fs.existsSync(path.join(plain.dir, 'subtitle.srt')), false);
  const stored = JSON.parse(fs.readFileSync(path.join(plain.dir, 'asr.json'), 'utf8')).segments;
  assert.equal(stored.length, 5);
  assert.ok(stored.every(seg => seg.words.length > 0 && seg.start === seg.words[0].start
    && seg.end === seg.words.at(-1).end));
  assert.equal(stored[0].start, 0.1, 'use measured word start even at the beginning of a chunk');
  assert.equal(stored.map(seg => seg.text).join(' '), Array(5).fill(punctuated).join(' '));
  const report = JSON.parse(fs.readFileSync(path.join(plain.dir, 'asr-chunks.json'), 'utf8'));
  assert.equal(report.source, 'silence');
  assert.equal(report.chunkSec, 60);
  assert.deepEqual(report.chunks.map(({ start, end }) => [start, end]),
    [[0, 72], [72, 136], [136, 196], [196, 256], [256, 302]]);
  assert.deepEqual(report.chunks.map(chunk => chunk.cut ?? null), ['silence', 'silence', 'nominal', 'nominal', null]);
  const empty = await draft('p-empty', { duration: 120 });
  assert.match(empty.draft.error, /1:00–2:00.*请重试识别/);
  assert.match(empty.draft.failedStage, /ASR/);
  for (const name of ['asr.json', 'reseg.json', 'subtitle.ass']) assert.equal(fs.existsSync(path.join(empty.dir, name)), false);
  const reportFor = dir => JSON.parse(fs.readFileSync(path.join(dir, 'asr-chunks.json'), 'utf8')).chunks;
  const fullChain = ['gpt-transcribe', 'gpt-transcribe', 'gpt-transcribe', 'bcut-asr', 'capcut-asr',
    'qwen3-asr-1.7b', 'whisperx-large-v2', 'parakeet-tdt-0.6b-v2-vulkan'];
  assert.deepEqual(reportFor(empty.dir)[1].attempts.map(a => a.model), fullChain);
  assert.equal(reportFor(empty.dir)[1].failed, true);
  assert.equal((await post('/api/projects/p-empty/retry', {})).status, 200);
  for (let i = 0; i < 120 && !fs.existsSync(path.join(empty.dir, 'subtitle.ass')); i++) await delay(25);
  assert.ok(fs.existsSync(path.join(empty.dir, 'subtitle.ass')), 'manual retry recovers missing block');
  for (const [id, wanted, n] of [['p-retry', 'gpt-transcribe', 3], ['p-cloud', 'capcut-asr', 5],
    ['p-local', 'parakeet-tdt-0.6b-v2-vulkan', 8]]) {
    const result = await draft(id, { duration: 120 });
    assert.equal(result.draft.error, null);
    const detail = reportFor(result.dir)[1];
    assert.equal(detail.model, wanted);
    assert.deepEqual(detail.attempts.map(a => a.model), fullChain.slice(0, n));
    assert.ok(JSON.parse(fs.readFileSync(path.join(result.dir, 'asr.json'))).segments[1].start >= 60);
  }
  for (const [id, chain] of [
    ['p-bcut', fullChain.slice(0, 4)], ['p-qwen', fullChain.slice(0, 6)],
    ['p-whisper', [...fullChain.slice(0, 5), 'whisperx-large-v2']],
    ['p-parakeet', [...fullChain.slice(0, 5), 'parakeet-tdt-0.6b-v2-vulkan']],
  ]) {
    const r = await draft(id, { duration: 120 });
    assert.equal(r.draft.error, null);
    assert.deepEqual(reportFor(r.dir)[1].attempts.map(a => a.model), chain);
  }
  const unavailableLocal = await draft('p-no-local', { duration: 120 });
  assert.match(unavailableLocal.draft.error, /请重试识别/);
  assert.equal(reportFor(unavailableLocal.dir)[1].attempts.length, 5);
  assert.equal(fs.existsSync(path.join(unavailableLocal.dir, 'reseg.json')), false);
  const aligned = await draft('p-aligned', { align: true });
  assert.equal(aligned.draft.error, null);
  assert.ok(fs.existsSync(path.join(aligned.dir, 'subtitle.ass')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(aligned.dir, 'asr.json'), 'utf8')).segments[0].words.length, 2);

  const cached = await draft('p-cached', { duration: 60,
    cachedSegments: [{ start: 0, end: 60, text: punctuated, words: [] }] });
  assert.equal(cached.draft.error, null);
  assert.equal(cached.draft.align, true);
  assert.ok(fs.existsSync(path.join(cached.dir, 'subtitle.ass')));
  const partial = await draft('p-partial-align', { duration: 120 });
  assert.match(partial.draft.error, /分块对齐失败/);
  assert.equal(fs.existsSync(path.join(partial.dir, 'subtitle.ass')), false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(partial.dir, 'asr.json'), 'utf8')).segments.every(s => !s.words.length),
    'failed alignment preserves the original cached transcript for retry');
  const partialMetaFile = path.join(partial.dir, 'project.json');
  const oldMeta = JSON.parse(fs.readFileSync(partialMetaFile, 'utf8'));
  Object.assign(oldMeta.draft, { retries: 10, failedStage: '语义分句中' });
  fs.writeFileSync(partialMetaFile, JSON.stringify(oldMeta));
  const skip = await post('/api/projects/p-partial-align/skip', {});
  assert.equal(skip.status, 400);
  assert.match((await skip.json()).error, /需要完成对齐/);
  const alignerOff = path.join(server.root, 'without-aligner');
  fs.writeFileSync(alignerOff, '');
  try {
    const unavailable = await draft('p-no-aligner');
    assert.match(unavailable.draft.error, /没有可用的对齐模型/);
    assert.equal(fs.existsSync(path.join(unavailable.dir, 'asr.json')), false);
  } finally { fs.unlinkSync(alignerOff); }

  const quota = await draft('p-quota');
  assert.match(quota.draft.error, /OpenAI API 余额不足/);
  const calls = fs.readFileSync(path.join(server.root, 'openai-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c => c.project === 'p-empty' && c.start === 0).length, 1);
  assert.equal(calls.filter(c => c.project === 'p-empty' && c.start === 60).length, 4);
  assert.equal(calls.filter(c => c.project === 'p-quota').length, 1);
  assert.equal(calls.filter(c => c.project === 'p-plain').length, 5);
  assert.equal(server.output().includes(key), false);
  assert.deepEqual(await (await post('/api/asr/openai-key', { clear: true })).json(), { hasKey: false });
  assert.equal((await modelStatus()).usable, false);
  console.log('openai-asr-test: ok');
} finally {
  await server.close();
}
