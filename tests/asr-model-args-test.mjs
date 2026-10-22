import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Parakeet / VibeVoice 的参数必须真的落到 worker 命令行。
 *
 * 这是纯静态契约检查（不加载模型、不 spawn）：`asr-params.js` 的 schema 键、`server.js`
 * 的取值与 CLI 拼装、两个 Python worker 的 argparse 三者一一对应；任一侧改名都会在这里失败，
 * 而不是等到用户点了识别才静默用默认值。
 */
const require = createRequire(import.meta.url);
const params = require('../editor/asr-params.js');
const root = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');

const contracts = [
  ['sherpa-onnx', ['threads', 'blankPenalty'],
    [['--blank-penalty', 'mp.blankPenalty'], ['--threads', 'ea.threads']]],
  ['vibevoice', ['acousticChunkSize', 'maxNewTokens'],
    [['--acoustic-tokenizer-chunk-size', 'mp.acousticChunkSize'], ['--max-new-tokens', 'mp.maxNewTokens']]],
];
for (const [engine, keys, flags] of contracts) {
  const schema = params.schemaFor({ engine });
  for (const key of keys) {
    assert.ok(schema.some(f => f.key === key), `${engine} schema exposes ${key}`);
    assert.match(SRC, new RegExp('mp\\.' + key + '\\b'), `server.js reads ${key} from the model params`);
  }
  for (const [flag, value] of flags) {
    assert.ok(SRC.includes(`'${flag}', String(${value}`),
      `${engine} passes ${flag} from ${value} to the worker`);
  }
}

// Parakeet NPU 没有可暴露参数：不能凭空出现 --blank-penalty / --threads 的假开关。
assert.equal(params.schemaFor({ engine: 'openvino' }).length, 0);
assert.equal(params.schemaFor({ engine: 'dual' }).length, 0);
assert.match(SRC, /const openvino = eng === 'openvino';[\s\S]*?extra: openvino \? \[\] : \['--blank-penalty'/,
  'NPU Parakeet does not receive the CUDA-only blank penalty');

// 常驻识别服务把构造期参数放进 worker，并计入缓存键；否则改参数不会生效。
const calls = SRC.match(/asrSvc\.transcribe\(\{[\s\S]*?\n\s*\}\);/g) || [];
assert.equal(calls.length, 1, 'resident-ASR call site (draft only; realign no longer ASR)');
for (const call of calls) {
  assert.match(call, /variant: ea\.variant \|\| ''/, 'resident worker key includes the runtime variant');
  assert.match(call, /threads: ea\.threads \|\| 0/, 'resident worker receives the configured thread count');
}

// worker 侧 argparse 必须接受这些开关（拼错就是「unrecognized arguments」整次识别失败）。
const asrPy = fs.readFileSync(path.join(root, 'asr/asr.py'), 'utf8');
assert.match(asrPy, /add_argument\("--blank-penalty"/);
const vibevoicePy = fs.readFileSync(path.join(root, 'asr/vibevoice.py'), 'utf8');
assert.match(vibevoicePy, /"--acoustic-tokenizer-chunk-size"/);
assert.match(vibevoicePy, /"--max-new-tokens"/);

console.log('asr-model-args-test: ok');
