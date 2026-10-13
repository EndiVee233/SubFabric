import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsrService } from '../editor/asr-service.js';
import { fakeAsr, tick } from './helpers/fake-asr.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-lifecycle-'));
const opts = owner => ({ owner, script: path.join(root, 'asr.py'), model: 'test', provider: 'cpu', audio: 'memory', outPath: path.join(root, owner + '.json') });
try {
  for (const ready of [false, true]) {
    const fake = fakeAsr(), svc = new AsrService({ python: 'mock', spawnImpl: fake.spawnImpl });
    const result = svc.transcribe(opts('shutdown')).catch(e => e);
    if (ready) { fake.processes[0].reply({ type: 'ready' }); await tick(); }
    await svc.stopAll(5); assert.equal((await result).name, 'AbortError');
    assert.deepEqual(svc.status(), []); assert.equal(fake.processes[0].alive, false);
    assert.equal(fs.existsSync(opts('shutdown').outPath), false);
  }
  const fake = fakeAsr(), svc = new AsrService({ python: 'mock', spawnImpl: fake.spawnImpl });
  const a = svc.transcribe(opts('A')).catch(e => e), b = svc.transcribe(opts('B'));
  const p = fake.processes[0]; p.reply({ type: 'ready' }); await tick();
  svc.cancelOwner('A'); assert.equal((await a).name, 'AbortError');
  p.reply({ type: 'ok', id: 1, segments: [{ text: 'late A' }] });
  p.reply({ type: 'ok', id: 2, segments: [{ text: 'B' }] });
  assert.equal((await b).segments[0].text, 'B');
  assert.equal(fs.existsSync(opts('A').outPath), false); assert.equal(JSON.parse(fs.readFileSync(opts('B').outPath)).segments[0].text, 'B');
  await svc.stopAll(5); assert.equal(p.alive, false);
  console.log('repair07: shutdown before ready/during recognition, bounded forced stop, per-owner cancel and shared worker late output passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
