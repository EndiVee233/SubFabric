import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const requests = [];
const replies = [];
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
  const { status = 200, headers = {}, body } = replies.shift() || { status: 500, body: { error: { message: 'Unexpected request' } } };
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + upstream.address().port;
const server = await isolatedServer();
const key = 'anthropic-fixture-key';
const cfg = { provider: 'anthropic', baseUrl: base, model: 'claude-fixture', apiKey: key };
const project = '/api/projects/p-claude';
const text = value => ({ type: 'text', text: value });
const thinking = { type: 'thinking', thinking: 'internal reasoning' };
function reply(content, stop_reason = 'end_turn') {
  replies.push({ body: { type: 'message', content, stop_reason } });
}
async function call(url, data, status = 200) {
  const res = await server.call(url, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const body = await res.text();
  assert.equal(res.status, status, body);
  assert.ok(!body.includes('fixture-key') && !body.includes('apiKeyEnc'));
  return JSON.parse(body);
}
function request(url, model = cfg.model, apiKey = key) {
  const req = requests.shift();
  assert.ok(req);
  assert.equal(req.url, url);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['x-api-key'], apiKey);
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.body.model, model);
  assert.ok(Number.isInteger(req.body.max_tokens) && req.body.max_tokens > 0);
  assert.ok(req.body.messages.every(m => m.role === 'user' || m.role === 'assistant'));
  assert.equal(req.body.response_format, undefined);
  assert.equal(req.body.temperature, undefined);
  return req.body;
}

try {
  const dir = path.join(server.root, 'projects/p-claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-claude', name: 'test', subtitle: { file: 'subtitle.ass' } }));
  fs.writeFileSync(path.join(dir, 'asr.json'), JSON.stringify({ segments: [{ start: 0, end: 2, text: 'Hello' }] }));

  const config = await call('/api/translate/config');
  assert.equal(config.presets.find(p => p.id === 'anthropic').baseUrl, 'https://api.anthropic.com/v1');
  const scheme = await call('/api/translate/schemes', { ...cfg, name: 'Claude', activate: true });
  assert.equal(scheme.schemes[0].provider, 'anthropic');
  assert.equal(scheme.schemes[0].hasKey, true);
  reply([thinking, text('o'), text('k')]);
  assert.equal((await call('/api/translate/schemes/test', { id: scheme.savedId })).reply, 'ok');
  assert.equal(request('/v1/messages').system, undefined);

  reply([text('1. 你'), text('好')]);
  assert.equal((await call('/api/translate/one', { text: 'Hello' })).zh, '你好');
  assert.match(request('/v1/messages').system, /字幕翻译专家/);

  reply([text('[{"src":"Alex","dst":"亚历克斯"}]')]);
  assert.equal((await call(project + '/glossary-review', {})).terms[0].dst, '亚历克斯');
  assert.match(request('/v1/messages').system, /JSON/);

  // The default correction model follows the active translation scheme, including
  // its protocol and key. A thinking-only truncation must trigger a larger budget.
  reply([thinking], 'max_tokens');
  reply([text('{"findings":[]}')]);
  assert.deepEqual((await call(project + '/reflect')).findings, []);
  const first = request('/v1/messages');
  const second = request('/v1/messages');
  assert.ok(second.max_tokens > first.max_tokens);
  assert.match(second.system, /findings/);

  const correction = await call('/api/asr/correct', {
    useTranslate: false, provider: 'anthropic', baseUrl: base + '/correction/v1/', model: 'correct-fixture',
    apiKey: 'correct-fixture-key',
  });
  assert.equal(correction.ready, true);
  reply([text('{"findings":[]}')]);
  assert.deepEqual((await call(project + '/reflect')).findings, []);
  request('/correction/v1/messages', 'correct-fixture', 'correct-fixture-key');
  await call('/api/asr/correct', { useTranslate: true });
  reply([text('{"findings":[]}')]);
  assert.deepEqual((await call(project + '/reflect')).findings, []);
  request('/v1/messages');

  await call('/api/analyze/config', {
    useTranslate: false, provider: 'anthropic', baseUrl: base + '/analysis/v1/messages/?tenant=test',
    model: 'analyze-fixture', apiKey: 'analyze-fixture-key',
  });
  reply([text('[]')]);
  assert.equal((await call(project + '/hotword-candidates?llm=1')).llm.ok, true);
  assert.match(request('/analysis/v1/messages?tenant=test', 'analyze-fixture', 'analyze-fixture-key').system, /JSON 数组/);

  const saved = JSON.parse(fs.readFileSync(path.join(server.root, 'asr/settings.json'), 'utf8'));
  for (const section of ['translate', 'correct', 'analyze']) {
    assert.ok(saved[section].apiKeyEnc);
    assert.ok(!saved[section].apiKey);
  }

  // An independent legacy OpenAI-compatible analysis URL keeps its protocol
  // and cannot inherit the Anthropic translation credential.
  server.settings({ ...saved, analyze: { baseUrl: base + '/legacy/v1', model: 'legacy' } });
  replies.push({ body: { choices: [{ message: { content: '[]' } }] } });
  assert.equal((await call(project + '/hotword-candidates?llm=1')).llm.ok, true);
  const legacy = requests.shift();
  assert.equal(legacy.url, '/legacy/v1/chat/completions');
  assert.equal(legacy.headers['x-api-key'], undefined);
  assert.ok(!legacy.headers.authorization.includes(key));
  assert.equal(legacy.body.messages[0].role, 'system');
  assert.equal(legacy.body.temperature, 0.3);

  replies.push({ status: 429, headers: { 'Retry-After': '1' },
    body: { type: 'error', error: { message: 'Rate limit: ' + key } } });
  const rate = await call('/api/translate/test', {});
  assert.equal(rate.ok, false);
  assert.match(rate.error, /429.*Rate limit/);
  request('/v1/messages');

  replies.push({ status: 307, headers: { Location: base + '/unexpected' } });
  assert.equal((await call('/api/translate/test', {})).ok, false);
  request('/v1/messages');
  assert.deepEqual(requests, [], 'redirects do not forward the Anthropic key');
  assert.deepEqual(replies, []);
  console.log('Anthropic Messages: schemes, translation, glossary, correction, analysis, key storage, truncation and HTTP errors passed');
} finally {
  await server.close();
  await new Promise(resolve => upstream.close(resolve));
}
