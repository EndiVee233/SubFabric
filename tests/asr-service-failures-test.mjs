import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsrService } from '../editor/asr-service.js';
import { fakeAsr, tick } from './helpers/fake-asr.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-failures-'));
const opts = (owner) => ({ owner, script: 'asr.py', model: 'mock', provider: 'cpu',
  audio: 'mock', outPath: path.join(root, owner + '.json') });
try {
  for (const ready of [false, true]) {
    for (const event of ['close', 'error']) {
      const fake = fakeAsr();
      const svc = new AsrService({ python: 'mock', spawnImpl: fake.spawnImpl });
      try {
        const a = svc.transcribe(opts('A')).catch(e => e);
        const b = svc.transcribe(opts('B')).catch(e => e);
        const proc = fake.processes[0];
        if (ready) { proc.reply({ type: 'ready' }); await tick(); }
        if (event === 'close') proc.emit('close', 7);
        else proc.emit('error', new Error('spawn failed'));
        for (const error of await Promise.all([a, b])) {
          assert.match(error.message, event === 'error' ? /启动失败：spawn failed/ : ready ? /退出（代码 7）$/ : /模型未就绪$/);
        }
        assert.deepEqual(svc.status(), []);
        assert.equal(svc.owners.size, 0);
        assert.equal(fs.existsSync(opts('A').outPath), false);
        const retry = svc.transcribe(opts('retry'));
        const replacement = fake.processes[1];
        replacement.reply({ type: 'ready' }); await tick();
        proc.emit('close', 7);  // 旧进程的迟到事件不能清掉替代 worker。
        replacement.reply({ type: 'ok', id: 1, segments: [{ text: 'retry' }] });
        assert.equal((await retry).segments[0].text, 'retry');
      } finally { await svc.stopAll(5); }
    }
  }
  const fake = fakeAsr();
  const timers = new Map();
  const clock = { setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const svc = new AsrService({ python: 'mock', spawnImpl: fake.spawnImpl, clock });
  try {
    const result = svc.transcribe(opts('failure')).catch(e => e);
    const proc = fake.processes[0];
    proc.reply({ type: 'ready' }); await tick();
    proc.reply({ type: 'error', id: 1, msg: 'recognition failed' });
    assert.equal((await result).message, 'recognition failed');
    assert.equal(timers.size, 1);
    assert.equal(svc.owners.size, 0);
    const callbacks = [...timers.values()]; timers.clear();
    callbacks.forEach(fn => fn());
    assert.deepEqual(svc.status(), []);
    await tick();
  } finally { await svc.stopAll(5); }
  console.log('ASR failures: before/after ready, concurrent rejection, replacement and failed-job idle cleanup passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
