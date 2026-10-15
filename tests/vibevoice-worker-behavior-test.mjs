import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = path.join(root, '..', 'asr', 'runtime-python', 'python.exe');
if (!fs.existsSync(py)) {
  console.log('vibevoice-worker-behavior: skipped (bundled CUDA Python unavailable)');
  process.exit(0);
}
const script = String.raw`
import sys, os
sys.path.insert(0, os.getcwd())
from asr.vibevoice import normalize_segments
raw = [
  {"Start": 0.2, "End": 1.4, "Speaker": "SPEAKER_00", "Content": "one"},
  {"Start": 1.0, "End": 2.0, "Speaker": "SPEAKER_01", "Content": "two"},
]
rows = normalize_segments(raw, 3.0)
assert rows[0]["start"] == 0.2 and rows[1]["start"] == 1.0
assert rows[0]["speaker"] == 0 and rows[1]["speaker"] == 1
assert normalize_segments("malformed", 3.0) == []
try:
    normalize_segments([{"Start": 0.0, "Content": "missing end"}], 3.0)
except RuntimeError:
    pass
else:
    raise AssertionError("missing timestamps must be rejected")
`;
  const result = spawnSync(py, ['-c', script], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONPATH: root } });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log('vibevoice-worker-behavior: strict timestamp validation and overlapping speakers passed');
const deviceResult = spawnSync(py, ['-B', path.join(root, 'tests/vibevoice-worker-test.py')], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
assert.equal(deviceResult.status, 0, deviceResult.stderr || deviceResult.stdout);
console.log('vibevoice-worker-behavior: CUDA-only loading, NF4 state, CPU/offload rejection and decode shape passed');
