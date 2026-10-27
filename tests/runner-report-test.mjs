import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-runner-report-'));
try {
  const tests = path.join(root, 'tests'); fs.mkdirSync(tests);
  fs.copyFileSync(fileURLToPath(new URL('./run-all.mjs', import.meta.url)), path.join(tests, 'run-all.mjs'));
  fs.writeFileSync(path.join(tests, 'gen-fixture.mjs'), '');
  fs.writeFileSync(path.join(tests, 'passed-test.mjs'), 'await new Promise(r => setTimeout(r, 20));');
  fs.writeFileSync(path.join(tests, 'partial-test.mjs'), 'console.log("SKIP: controlled optional fixture");');
  fs.writeFileSync(path.join(tests, 'failed-test.mjs'), 'throw new Error("controlled failure");');
  const reportPath = path.join(root, 'report.json');
  const result = spawnSync(process.execPath, [path.join(tests, 'run-all.mjs'), '--report', reportPath],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, 'failed assertions must still fail the runner');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report.counts, { passed: 1, partial: 1, diagnostic: 0, failed: 1 });
  for (const entry of report.results) {
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs > 0);
  }
  assert.ok(report.results.find(entry => entry.file === 'passed-test.mjs').durationMs >= 20);
  assert.match(report.results.find(entry => entry.status === 'failed').output, /controlled failure/);
  console.log('runner report: actual elapsed times and passed/partial/failed classifications verified');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
