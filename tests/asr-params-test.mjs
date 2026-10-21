import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const params = require('../editor/asr-params.js');

const fw = { id: 'fw', engine: 'faster-whisper' };
const cpp = { id: 'cpp', engine: 'whisper.cpp' };
const crisp = { id: 'crisp', engine: 'crispasr' };
const cloud = { id: 'cloud', engine: 'bcut', cloud: true };

assert.equal(params.schemaFor(fw).length, 7);
assert.equal(params.schemaFor(cpp).length, 4);
assert.equal(params.schemaFor(crisp).length, 2);
assert.equal(params.schemaFor(cloud).length, 0);

const fwDefaults = params.defaultsFor(fw);
assert.deepEqual(fwDefaults, {
  language: 'en', vad: false, vadThreshold: 0.05, vadMethod: 'pyannote_v3',
  vocalExtract: true, wordTimestamps: true, prompt: '',
});
assert.deepEqual(params.defaultsFor(cpp), { language: 'en', threads: 4, wordThreshold: 0.01, prompt: '' });
assert.deepEqual(params.defaultsFor(crisp), { threads: 6, wordThreshold: 0.01 });

// 保存值只覆盖已知键，非法值回落默认
const resolved = params.resolveFor(fw, {
  vad: true, vadThreshold: '0.2', vadMethod: 'silero_v5', language: 'zh',
  vocalExtract: false, wordTimestamps: false, prompt: '  hello  ', unknown: 1,
});
assert.equal(resolved.vad, true);
assert.equal(resolved.vadThreshold, 0.2);
assert.equal(resolved.vadMethod, 'silero_v5');
assert.equal(resolved.language, 'zh');
assert.equal(resolved.vocalExtract, false);
assert.equal(resolved.prompt, 'hello');
assert.equal('unknown' in resolved, false);
assert.equal(params.resolveFor(fw, { vadThreshold: 'nope', vadMethod: 'nope' }).vadThreshold, 0.05);
assert.equal(params.resolveFor(fw, { vadThreshold: 'nope', vadMethod: 'nope' }).vadMethod, 'pyannote_v3');

// 提交校验：越界会被夹到范围内，非法类型返回明确错误
const ok = params.normalizeFor(cpp, { threads: 99, language: 'auto', wordThreshold: 0.5, prompt: 'x'.repeat(400) });
assert.equal(ok.ok, true);
assert.equal(ok.values.threads, 32, '线程数应夹到 max');
assert.equal(ok.values.language, 'auto');
assert.equal(ok.values.wordThreshold, 0.5);
assert.equal(ok.values.prompt.length, 300);
const badNum = params.normalizeFor(fw, { vadThreshold: 'abc' });
assert.equal(badNum.ok, false);
assert.equal(badNum.errors[0].key, 'vadThreshold');
const badSelect = params.normalizeFor(fw, { vadMethod: 'nope' });
assert.equal(badSelect.ok, false);
assert.equal(badSelect.errors[0].key, 'vadMethod');
assert.equal(params.normalizeFor(cpp, null).ok, false);

assert.equal(params.isDefaultFor(fw, {}), true);
assert.equal(params.isDefaultFor(fw, { vad: false, vadThreshold: 0.05 }), true);
assert.equal(params.isDefaultFor(fw, { vad: true }), false);
assert.ok(params.summaryFor(fw, { vad: true, vadThreshold: 0.1 }).includes('VAD 开'));
assert.ok(params.summaryFor(cpp, { threads: 8 }).includes('线程 8'));

console.log('asr-params-test: ok');
