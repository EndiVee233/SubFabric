import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const params = require('../editor/asr-params.js');

const fw = { id: 'fw', engine: 'faster-whisper' };
const cpp = { id: 'cpp', engine: 'whisper.cpp' };
const crisp = { id: 'crisp', engine: 'crispasr' };
const sherpa = { id: 'sherpa', engine: 'sherpa-onnx' };
const vibevoice = { id: 'vv', engine: 'vibevoice' };
const cloud = { id: 'cloud', engine: 'bcut', cloud: true };

assert.equal(params.schemaFor(fw).length, 7);
assert.equal(params.schemaFor(cpp).length, 4);
assert.equal(params.schemaFor(crisp).length, 2);
assert.equal(params.schemaFor(sherpa).length, 2);
assert.equal(params.schemaFor(vibevoice).length, 2);
assert.equal(params.schemaFor(cloud).length, 0);
assert.equal(params.schemaFor({ engine: 'openvino' }).length, 0, 'NPU Parakeet 没有可暴露的运行时参数');
assert.equal(params.schemaFor({ engine: 'nemo' }).length, 0);

const fwDefaults = params.defaultsFor(fw);
assert.deepEqual(fwDefaults, {
  language: 'en', vad: false, vadThreshold: 0.05, vadMethod: 'pyannote_v3',
  vocalExtract: true, wordTimestamps: true, prompt: '',
});
assert.deepEqual(params.defaultsFor(cpp), { language: 'en', threads: 4, wordThreshold: 0.01, prompt: '' });
assert.deepEqual(params.defaultsFor(crisp), { threads: 6, wordThreshold: 0.01 });
assert.deepEqual(params.defaultsFor(sherpa), { threads: 4, blankPenalty: 0.5 });
assert.deepEqual(params.defaultsFor(vibevoice), { acousticChunkSize: 32000, maxNewTokens: 8192 });

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
assert.ok(params.summaryFor(sherpa, { threads: 8, blankPenalty: 0.5 }).includes('blank 惩罚 0.5'));
assert.ok(params.summaryFor(vibevoice, { maxNewTokens: 16384 }).includes('16384'));

// Parakeet CUDA：线程与 blank 惩罚夹取范围
const parakeetOk = params.normalizeFor(sherpa, { threads: 99, blankPenalty: -1 });
assert.equal(parakeetOk.ok, true);
assert.equal(parakeetOk.values.threads, 32);
assert.equal(parakeetOk.values.blankPenalty, 0);
assert.equal(params.resolveFor(sherpa, { threads: '8', blankPenalty: '0.7' }).threads, 8);
assert.equal(params.resolveFor(sherpa, { threads: '8', blankPenalty: '0.7' }).blankPenalty, 0.7);

// VibeVoice 分块必须是 3200 的倍数：越界先夹取，再吸附到合法步长
const vv = params.normalizeFor(vibevoice, { acousticChunkSize: 33000, maxNewTokens: 999999 });
assert.equal(vv.ok, true);
assert.equal(vv.values.acousticChunkSize, 32000);
assert.equal(vv.values.maxNewTokens, 32768);
assert.equal(params.normalizeFor(vibevoice, { acousticChunkSize: 100 }).values.acousticChunkSize, 3200);
assert.equal(params.normalizeFor(vibevoice, { acousticChunkSize: 40000 }).values.acousticChunkSize, 41600);
assert.equal(params.normalizeFor(vibevoice, { maxNewTokens: 1024 }).values.maxNewTokens, 1024);
assert.equal(params.isDefaultFor(vibevoice, {}), true);
assert.equal(params.isDefaultFor(vibevoice, { maxNewTokens: 16384 }), false);

console.log('asr-params-test: ok');
