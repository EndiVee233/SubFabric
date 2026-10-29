import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 速度测试与运行时修复的静态契约（不 spawn 进程、不装包）。
 *
 * 历史故障：Faster-Whisper-XXL 写 %TEMP% 里的 input.json 报 PermissionError。
 * 2026-10-21 起 VibeVoice / NeMo / whisper.cpp 运行时已停用；这里同时守住：
 *  - bench 工作目录仍在 projects/.bench；
 *  - 退役引擎有统一兜底，下载/安装接口明确拒绝。
 */
const root = path.resolve(import.meta.dirname, '..');
const server = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8').replace(/\r\n/g, '\n');
const project = fs.readFileSync(path.join(root, 'editor/js/project.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.match(server, /function benchWorkRoot\(\) \{\n  const base = path\.join\(ROOT, 'projects', '\.bench'\);/,
  'bench work root lives under projects/ (XXL can write there)');
assert.match(server, /const dir = fs\.mkdtempSync\(path\.join\(benchWorkRoot\(\), 'run-'\)\);/,
  'bench clip uses the project-side work root');
const benchClip = server.slice(server.indexOf('function benchClip'), server.indexOf('function benchSpawn'));
assert.ok(benchClip.length > 0, 'benchClip is present');
assert.doesNotMatch(benchClip, /os\.tmpdir/,
  'bench must not put XXL output under %TEMP% (PermissionError on input.json)');

// 退役引擎：统一兜底 + 安装/下载接口拒绝
assert.match(server, /const RETIRED_ENGINES = new Set\(\['sherpa-onnx', 'whisper\.cpp', 'nemo', 'dual', 'vibevoice'\]\)/);
assert.match(server, /function benchSupported\(model\) \{[\s\S]*?isRetiredEngine\(model\.engine\)/);
assert.match(server, /whisper\.cpp 运行时已停用/);
assert.match(server, /VibeVoice 运行时已停用/);
assert.match(server, /NeMo 运行时已停用/);
assert.match(server, /双引擎与双引擎性能测试已停用/);

// Faster-Whisper 的就地修复入口仍在；VibeVoice 修复入口已注释。
assert.match(project, /async function benchInstallRuntime/);
assert.match(project, /data-fix="runtime:faster-whisper"/);
assert.ok(project.includes('// if (r.engine === \'vibevoice\''), 'VibeVoice 修复分支应保持注释');
assert.match(css, /\.bench-fix-row/);

console.log('asr-bench-repair-test: ok');
