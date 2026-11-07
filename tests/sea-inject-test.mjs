import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const script = path.resolve(import.meta.dirname, '../editor/scripts/inject_postject.mjs');
const source = fs.readFileSync(script, 'utf8').replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(script).href));
for (const explicit of [false, true]) {
  const fallback = path.join('npm-tools', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const expected = explicit ? path.join('explicit', 'npx-cli.js') : fallback;
  const calls = [];
  vm.runInNewContext(source, {
    process: { execPath: path.join('bundled-node', 'node.exe'), argv: ['node', 'inject', 'app.exe', 'sea.blob'],
      env: { PATH: 'npm-tools', SUBFABRIC_NPX_CLI: explicit ? expected : '' }, exit: code => { throw Error('exit ' + code); } },
    join: path.join, dirname: path.dirname, delimiter: path.delimiter, fileURLToPath,
    existsSync: file => file === fallback || (explicit && file === expected),
    spawnSync(exe, args, opts) { calls.push({ exe, args, opts }); return { status: 0 }; },
    console: { log() {}, error() {} },
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].args[0], expected);
  assert.equal(calls[0].args[2], 'postject'); assert.equal(calls[0].opts.shell, false);
}
console.log('SEA injection: bundled Node without npm discovers PATH npm; explicit override remains available');
