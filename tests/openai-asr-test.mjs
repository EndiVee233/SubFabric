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
sliceAudio = async (wav, start, end, out, asMp3) => {
  if (!asMp3) throw new Error('Expected MP3');
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
  if (info.project === 'p-empty' && info.start === 60) text = '  ';
  return Response.json({ text, usage: { seconds: info.end - info.start } }, { headers: { 'x-request-id': 'req_fixture' } });
};
translateCfg = () => fs.existsSync(path.join(ROOT, 'without-translation'))
  ? {} : { baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'fixture', autoTranslate: false };
startTranslate = async id => finishDraft(id, null);
alignDraftAsrJson = async id => {
  const file = path.join(projDir(id), 'asr.json');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const seg of result.segments) {
    seg.words = [{ word: 'Hello', start: seg.start, end: seg.start + 0.5 },
      { word: 'world.', start: seg.start + 0.5, end: seg.start + 1 }];
  }
  fs.writeFileSync(file, JSON.stringify(result));
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
  assert.ok(fs.existsSync(path.join(plain.dir, 'subtitle.srt')));
  const stored = JSON.parse(fs.readFileSync(path.join(plain.dir, 'asr.json'), 'utf8')).segments;
  assert.equal(plain.draft.resegDone, true);
  assert.ok(stored.length > 30, 'text-only drafts split the original five upload chunks');
  assert.ok(stored.every(seg => seg.words.length === 0 && seg.end - seg.start <= 10 + 1e-8));
  assert.equal(stored.map(seg => seg.text).join(' '), Array(5).fill(punctuated).join(' '));
  assert.equal(stored.at(-1).end, 302);
  assert.equal(fs.existsSync(path.join(plain.dir, 'subtitle.ass')), false);
  const report = JSON.parse(fs.readFileSync(path.join(plain.dir, 'asr-chunks.json'), 'utf8'));
  assert.equal(report.source, 'silence');
  assert.equal(report.chunkSec, 60);
  assert.deepEqual(report.chunks.map(({ start, end }) => [start, end]),
    [[0, 72], [72, 136], [136, 196], [196, 256], [256, 302]]);
  assert.deepEqual(report.chunks.map(chunk => chunk.cut ?? null), ['silence', 'silence', 'nominal', 'nominal', null]);
  const empty = await draft('p-empty', { duration: 120 });
  assert.equal(empty.draft.error, null);
  assert.match(fs.readFileSync(path.join(empty.dir, 'draft.log'), 'utf8'), /未返回转录文本 .*1:00–2:00.*req_fixture/);
  const emptyReport = JSON.parse(fs.readFileSync(path.join(empty.dir, 'asr-chunks.json'), 'utf8'));
  assert.deepEqual(emptyReport.chunks.map(chunk => [chunk.segments, chunk.textChars, chunk.requestId, chunk.usageSeconds]),
    [[1, 12, 'req_fixture', 60], [0, 0, 'req_fixture', 60]]);
  const aligned = await draft('p-aligned', { align: true });
  assert.equal(aligned.draft.error, null);
  assert.ok(fs.existsSync(path.join(aligned.dir, 'subtitle.ass')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(aligned.dir, 'asr.json'), 'utf8')).segments[0].words.length, 2);

  const translationOff = path.join(server.root, 'without-translation');
  fs.writeFileSync(translationOff, '');
  try {
    const cached = await draft('p-cached', { duration: 60,
      cachedSegments: [{ start: 0, end: 60, text: punctuated, words: [] }] });
    assert.equal(cached.draft.status, 'paused');
    assert.equal(cached.draft.resegDone, true);
    assert.ok(fs.existsSync(path.join(cached.dir, 'subtitle.srt')));
    assert.ok(cached.draft.lines > 1);
  } finally { fs.unlinkSync(translationOff); }

  const quota = await draft('p-quota');
  assert.match(quota.draft.error, /OpenAI API 余额不足/);
  const calls = fs.readFileSync(path.join(server.root, 'openai-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.project), [
    'p-plain', 'p-plain', 'p-plain', 'p-plain', 'p-plain', 'p-empty', 'p-empty', 'p-aligned', 'p-quota',
  ]);
  assert.equal(server.output().includes(key), false);
  assert.deepEqual(await (await post('/api/asr/openai-key', { clear: true })).json(), { hasKey: false });
  assert.equal((await modelStatus()).usable, false);
  console.log('openai-asr-test: ok');
} finally {
  await server.close();
}
