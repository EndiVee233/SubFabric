// Backward-compatible alias for the maintained isolated JavaScript test runner.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [path.join(root, 'tests/run-all.mjs'),
  '--report', path.join(root, '_test/maintenance/js-results.json'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: process.env, windowsHide: true,
});
if (result.error) throw result.error;
if (result.signal) process.exitCode = 1;
else process.exitCode = result.status ?? 1;
