/* Safe, deterministic JavaScript regression entry point.
 * Usage: node tests/run-all.mjs [--report <file>] [test-name.mjs ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const HELPERS = new Set(['gen-lang.mjs', 'gen-fixture.mjs', 'ass-fixture.mjs', 'run-all.mjs']);
const EXCLUDED = {
  'colorfix-test.mjs': 'requires a real user project',
  'font-status-test.mjs': 'requires a real GUI and project',
};
const DIAGNOSTICS = new Set(['rows-timeline-test.mjs']);
const TIMEOUT_MS = 180000;
const MAX_BUFFER = 64 * 1024 * 1024;

function parseArgs(args) {
  const files = [];
  let report = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') {
      if (!args[i + 1] || report) throw new Error('--report requires one output path');
      report = path.resolve(args[++i]);
    } else if (args[i].startsWith('--')) {
      throw new Error(`Unknown option: ${args[i]}`);
    } else files.push(args[i]);
  }
  if (new Set(files).size !== files.length) throw new Error('Duplicate test selection');
  for (const file of files) {
    if (!/^[\w-]+\.mjs$/.test(file) || HELPERS.has(file) || EXCLUDED[file]
      || !fs.existsSync(path.join(TESTS, file))) throw new Error(`Invalid test selection: ${file}`);
  }
  return { files, report };
}

function run(args, timeout = TIMEOUT_MS) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, SUBFABRIC_TEST_ISOLATED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER, windowsHide: true,
  });
}

function outputOf(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function failureOf(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit ${result.status}`;
}

function isPartial(output) {
  return /^(?:\s*(?:SKIP\b|\[SKIP\]|[（(]跳过[:：）)]|\(skip(?:ped)?\b))/im.test(output);
}

async function main() {
  const { files: requested, report: reportPath } = parseArgs(process.argv.slice(2));
  const setup = run([path.join(TESTS, 'gen-fixture.mjs')]);
  if (setup.error || setup.status !== 0) {
    console.error(`Fixture setup failed: ${failureOf(setup)}\n${outputOf(setup).split('\n').slice(-12).join('\n')}`);
    process.exitCode = 1;
    return;
  }

  const candidates = fs.readdirSync(TESTS).filter(file => file.endsWith('.mjs') && !HELPERS.has(file)).sort();
  const files = requested.length ? requested : candidates;
  const selected = files.filter(file => !EXCLUDED[file]);
  const results = [];
  const started = Date.now();
  console.log(`Running ${selected.length} isolated JavaScript tests serially...`);

  for (const file of selected) {
    const testStarted = performance.now();
    const result = run([path.join(TESTS, file)]);
    const durationMs = performance.now() - testStarted;
    const output = outputOf(result);
    const status = result.status === 0 && !result.error && !result.signal
      ? (isPartial(output) ? 'partial' : DIAGNOSTICS.has(file) ? 'diagnostic' : 'passed') : 'failed';
    const entry = { file, status, exitCode: result.status, signal: result.signal || null,
      durationMs };
    if (status !== 'passed') entry.output = output.split('\n').slice(-30).join('\n');
    if (result.error) entry.error = result.error.message;
    results.push(entry);
    console.log(`  ${status === 'failed' ? 'FAIL' : status === 'partial' ? 'PARTIAL' : 'PASS'} ${file}`);
    if (status === 'failed') console.error(output.slice(-16000) || failureOf(result));
  }

  const counts = Object.fromEntries(['passed', 'partial', 'diagnostic', 'failed'].map(status =>
    [status, results.filter(item => item.status === status).length]));
  const report = { generatedAt: new Date().toISOString(), node: process.version,
    isolated: true, selected: selected.length, excluded: Object.fromEntries(Object.entries(EXCLUDED)
      .filter(([file]) => !requested.length || requested.includes(file))), durationMs: Date.now() - started,
    counts, results };
  console.log(`\nPassed ${counts.passed}, partial ${counts.partial}, failed ${counts.failed}; excluded ${Object.keys(report.excluded).length}.`);

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${path.relative(ROOT, reportPath)}`);
  }
  if (counts.failed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
