import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const s = await isolatedServer();
try {
  const id = 'ggml-large-v3-turbo', file = 'ggml-large-v3-turbo.bin';
  const root = path.join(s.root, 'models');
  const dir = path.join(root, id);
  const make = p => { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, file), 'model'); };
  const remove = async p => {
    s.settings({ modelsRoot: root, models: { [id]: p } });
    const r = await s.call('/api/asr/delete', { method: 'POST', body: JSON.stringify({ modelId: id }) });
    assert.equal(r.status, 200); return r.json();
  };
  make(dir);
  assert.equal((await remove(dir)).deleted, true);
  assert.equal(fs.existsSync(dir), false);
  for (const p of [root, root + '-backup', path.join(s.root, 'custom')]) {
    make(p);
    const r = await remove(p);
    assert.equal(r.deleted, false); assert.equal(r.detached, true);
    assert.equal(fs.readFileSync(path.join(p, file), 'utf8'), 'model');
  }
  make(dir); fs.writeFileSync(path.join(dir, 'my-notes.txt'), 'keep');
  assert.equal((await remove(dir)).deleted, true);
  assert.equal(fs.readFileSync(path.join(dir, 'my-notes.txt'), 'utf8'), 'keep');
  fs.rmSync(dir, { recursive: true });
  const target = path.join(s.root, 'link-target'); make(target);
  fs.symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await remove(dir)).deleted, false);
  assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), 'model');
  console.log('repair01: model directory, root, sibling, custom, unrelated files and link behavior passed');
} finally { await s.close(); }
