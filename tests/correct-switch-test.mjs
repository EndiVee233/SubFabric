import assert from 'node:assert/strict';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
const customUrl = 'http://127.0.0.1:11434/v1';
const customModel = 'qwen3:8b';

async function get(url) {
  const response = await server.call(url);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  return response.json();
}

async function post(url, value) {
  const response = await server.call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value) });
  const data = await response.json();
  assert.equal(response.status, 200, `${url}: ${data.error || response.status}`);
  return data;
}

try {
  server.settings({ translate: { provider: 'custom', baseUrl: 'http://127.0.0.1:11435/v1',
    model: 'fixture-translate' }, correct: { useTranslate: true, mode: 'preview' } });
  const translate = await get('/api/translate/config');
  const translateModel = translate.cfg.model;
  assert.ok(translateModel && translateModel !== customModel);

  const initial = await get('/api/asr/correct');
  assert.equal(initial.effectiveModel, translateModel);
  assert.equal(initial.effectiveBaseUrl, 'http://127.0.0.1:11435/v1');

  let value = await post('/api/asr/correct', { useTranslate: false, baseUrl: customUrl, model: customModel });
  assert.equal(value.effectiveModel, customModel);
  assert.equal(value.effectiveBaseUrl, customUrl);

  value = await post('/api/asr/correct', { useTranslate: true });
  assert.equal(value.useTranslate, true);
  assert.equal(value.effectiveModel, translateModel);
  assert.equal(value.effectiveBaseUrl, 'http://127.0.0.1:11435/v1');
  assert.equal(value.model, customModel, 'custom values remain available when switching back');

  for (const want of [false, true, false, true]) {
    value = await post('/api/asr/correct', { useTranslate: want });
    assert.equal(value.useTranslate, want);
    assert.equal(value.effectiveModel, want ? translateModel : customModel);
  }
  console.log('Correct-model follow switch: isolated settings, effective model/address, retained custom values and repeated toggles passed');
} finally {
  await server.close();
}
