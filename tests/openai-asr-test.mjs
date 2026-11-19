import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedServer } from './helpers/isolated-server.mjs';

const key = 'fixture-credential-for-openai-asr';
const server = await isolatedServer({
  prepare(_root, editor) {
    const file = path.join(editor, 'server.js');
    const source = fs.readFileSync(file, 'utf8');
    const listen = 'server.listen(PORT, HOST,';
    assert.ok(source.includes(listen) && source.includes('const sliceAudio ='));
    fs.writeFileSync(file, source.replace('const sliceAudio =', 'let sliceAudio =').replace(listen, `
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
  return Response.json({ text: 'Hello world.' });
};
translateCfg = () => ({ baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'fixture', autoTranslate: false });
runDraftReseg = async () => {};
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

async function draft(id, { align = false, duration = 3 } = {}) {
  const dir = path.join(server.root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio.wav'), 'fixture');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name: id, duration,
    draft: { status: 'error', modelId: 'gpt-transcribe', engine: 'openai-asr', align, wordLevel: align } }));
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
  assert.deepEqual(stored.map(seg => [seg.start, seg.end, seg.words.length]), [[0, 150, 0], [150, 300, 0], [300, 302, 0]]);
  const aligned = await draft('p-aligned', { align: true });
  assert.equal(aligned.draft.error, null);
  assert.ok(fs.existsSync(path.join(aligned.dir, 'subtitle.ass')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(aligned.dir, 'asr.json'), 'utf8')).segments[0].words.length, 2);

  const quota = await draft('p-quota');
  assert.match(quota.draft.error, /OpenAI API 余额不足/);
  const calls = fs.readFileSync(path.join(server.root, 'openai-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.project), ['p-plain', 'p-plain', 'p-plain', 'p-aligned', 'p-quota']);
  assert.equal(server.output().includes(key), false);
  assert.deepEqual(await (await post('/api/asr/openai-key', { clear: true })).json(), { hasKey: false });
  assert.equal((await modelStatus()).usable, false);
  console.log('openai-asr-test: ok');
} finally {
  await server.close();
}
