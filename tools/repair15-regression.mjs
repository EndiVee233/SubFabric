// 本轮安全回归入口：内存/合成夹具/临时服务，避免已有真机测试写入真实设置。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = path.join(root, 'tests');
const excluded = new Map([
  ['colorfix-test.mjs', '需要真实用户项目'], ['correct-switch-test.mjs', '会改运行中服务的真实设置'],
  ['font-picker-test.mjs', '需要真实 GUI/浏览器与运行中服务'], ['font-status-test.mjs', '需要真实 GUI 与项目'],
]);
const helpers = new Set(['run-all.mjs', 'gen-fixture.mjs', 'gen-lang.mjs', 'ass-fixture.mjs']);
const env = { ...process.env, SUBFABRIC_TEST_ISOLATED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
const run = file => spawnSync(process.execPath, [path.join(tests, file)], { cwd: root, env, windowsHide: true,
  encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
if (!fs.existsSync(path.join(tests, 'fixture.ass'))) {
  const r = run('gen-fixture.mjs'); if (r.status !== 0) throw Error(r.stderr || r.stdout);
}
const requested = process.argv.slice(2);
if (requested.some(f => !/^[\w-]+\.mjs$/.test(f) || helpers.has(f) || excluded.has(f) || !fs.existsSync(path.join(tests, f)))) throw Error('Invalid test selection');
const resultFile = path.join(root, 'docs/repair15-regression-results.json');
const result = requested.length && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  : { passed: [], partial: [], failed: [], excluded: Object.fromEntries(excluded) };
if (requested.length) {
  result.passed = result.passed.filter(f => !requested.includes(f));
  result.partial = result.partial.filter(f => !requested.includes(f));
  result.failed = result.failed.filter(r => !requested.includes(r.file));
}
for (const file of fs.readdirSync(tests).filter(f => f.endsWith('.mjs') && !helpers.has(f)).sort()) {
  if (requested.length && !requested.includes(file)) continue;
  if (excluded.has(file)) { console.log('SKIP ' + file + ': ' + excluded.get(file)); continue; }
  const r = run(file), output = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) {
    const partial = /跳过|skipped/i.test(output); result[partial ? 'partial' : 'passed'].push(file);
    console.log('PASS ' + file + (partial ? ' (含明确跳过项)' : ''));
  } else {
    result.failed.push({ file, code: r.status, error: r.error?.message, output: output.trim().split('\n').slice(-25).join('\n') });
    console.log('FAIL ' + file + '\n' + result.failed.at(-1).output);
  }
}
fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
console.log(`RESULT passed=${result.passed.length} partial=${result.partial.length} failed=${result.failed.length} excluded=${excluded.size}`);
if (result.failed.length) process.exitCode = 1;
