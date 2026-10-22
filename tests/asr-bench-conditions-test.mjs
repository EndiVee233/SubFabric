import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「全模型速度」的测试条件（逐词 / 置信度 / 分角色识别 / 说话人区分）。
 *
 * 目标：让速度测试与创建稿件页用同一组开关，并把置信度的稳定性重跑与
 * 说话人分离、分角色识别等后处理真实计入总倍率。这里做静态契约保护，
 * 不启动模型、不调用 LLM。
 */
const root = path.resolve(import.meta.dirname, '..');
const server = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');
const project = fs.readFileSync(path.join(root, 'editor/js/project.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const production = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.equal(production, template, 'production studio.html stays byte-identical to the template');
for (const id of ['bench-word', 'bench-confidence', 'bench-cast', 'bench-speakers', 'bench-speaker-count']) {
  assert.match(template, new RegExp(`id="${id}"`), `bench condition control exists: ${id}`);
}
assert.match(template, /id="bench-seconds"[^>]*max="600"/, 'bench supports 5–10 minute clips');
assert.match(server, /Math\.min\(600, Number\(b\.seconds\) \|\| 20\)/, 'server accepts up to 600s');
assert.match(server, /const details = b\.details === true;/, 'bench can return transcript text for WER analysis');
assert.match(server, /confidence: benchConfidenceSummary\(segments\)/, 'bench reports confidence stats');
assert.match(project, /<th>置信度<\/th>/, 'bench table shows confidence');

// 服务端：条件归一化、置信度进入 asrArgsFor、逐词可关（faster-whisper）、后处理只跑一次。
assert.match(server, /function normalizeBenchConditions\(raw\)/);
assert.match(server, /const confidence = CONFIDENCE_MODES\.includes\(c\.confidence\) \? c\.confidence : asrConfidenceDefault\(\);/);
assert.match(server, /speakers: c\.speakers === true \|\| cast/,
  'cast implies speakers (same prerequisite as the create-project page)');
assert.match(server, /wordTimestamps: word && mp\.wordTimestamps !== false/,
  'the word switch reaches Faster-Whisper');
assert.match(server, /asrArgsFor\(ea, mdir, wav, outPath, confMode\)/,
  'the confidence mode reaches the resident/spawn ASR arguments');
assert.match(server, /const post = await benchPostProcess\(clip\.wav, postSegments, conditions\);/);
assert.match(server, /function benchDiarize\(wav, speakerCount, onProgress\)/);
assert.match(server, /async function benchCast\(segments, speakerCount\)/);
assert.match(server, /r\.postSec = \+Number\(post\.sec \|\| 0\)\.toFixed\(3\);/);
assert.match(server, /r\.speed = \+\(Number\(r\.audioSec\) \/ Math\.max\(0\.001, r\.totalSec\)\)\.toFixed\(2\);/);

// 前端：开关随请求发出、结果表展示识别/后处理/总耗时、分角色依赖说话人。
assert.match(project, /const conditions = \{\n    word:/);
assert.match(project, /JSON\.stringify\(\{ audio: benchAudio, models: ids, seconds, conditions \}\)/);
assert.match(project, /<th>识别<\/th><th>后处理<\/th><th>总耗时<\/th><th>倍率<\/th>/);
assert.match(project, /cast\.addEventListener\('change', \(\) => \{ if \(cast\.checked\) speakers\.checked = true; \}\);/);
assert.match(project, /speakers\.addEventListener\('change', \(\) => \{ if \(!speakers\.checked\) cast\.checked = false; \}\);/);
assert.match(project, /bench-fix-status/);
assert.match(css, /\.bench-conditions \{/);
assert.match(css, /\.bench-check \{[^}]*white-space: nowrap; \}/,
  'condition labels stay on one line (置信度 must not wrap)');
assert.match(css, /\.bench-fix-status/);

console.log('asr-bench-conditions-test: ok');
