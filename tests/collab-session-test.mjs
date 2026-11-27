import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AssDoc } from '../editor/js/ass.js';

const { createCollabSession } = createRequire(import.meta.url)('../editor/collab-session.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-collab-'));
const file = path.join(root, 'subtitle');
function open(format, text) {
  fs.writeFileSync(file, text);
  let clock = 100, writes = 0, fail = false;
  const room = createCollabSession({
    format, text, now: () => clock,
    persist({ expected, text: next }) {
      if (fail) throw new Error('disk unavailable');
      if (fs.readFileSync(file, 'utf8') !== expected) throw new Error('subtitle changed on disk');
      if (expected === next) return;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, next, { flag: 'wx' });
      fs.renameSync(tmp, file);
      writes++;
    }
  });
  const submit = (member, requestId, row, lease, command) => room.submit(member, {
    sessionId: room.sessionId, requestId, entryId: row.id, version: row.version, token: lease.token, ...command
  });
  return { room, submit, writes: () => writes, tick: () => { clock += 15_001; }, fail: value => { fail = value; } };
}

try {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n<i>甲</i>\n\n2\n00:00:04,000 --> 00:00:05,000\n乙\n';
  const srtTest = open('srt', srt);
  const { room, submit } = srtTest;
  const initial = room.snapshot();
  const [a, b] = initial.entries;
  assert.equal(initial.text, srt, 'opening is byte-preserving');
  const aLock = room.lock('host', a.id);
  assert.equal(room.lock('member', a.id).reason, 'locked');
  const bLock = room.lock('member', b.id);
  assert.ok(aLock.ok && bLock.ok);
  const move = { op: 'time', start: 7, end: 8 };
  const moved = submit('host', 'move', a, aLock, move);
  assert.equal(moved.revision, 1);
  const second = submit('member', 'write', b, bLock, { op: 'text', text: '<b>新乙</b>\r\nline 2' });
  assert.equal(second.revision, 2, 'the other entry keeps its own base version');
  assert.deepEqual(room.snapshot().entries.map(x => [x.id, x.text]), [[b.id, '<b>新乙</b>\nline 2'], [a.id, '<i>甲</i>']]);
  assert.equal(room.snapshot().text, fs.readFileSync(file, 'utf8'));
  assert.throws(() => createCollabSession({ format: 'srt', text: '# ignored\n' + srt, persist() {} }), /round trip/);
  assert.equal(submit('host', 'stale', a, aLock, move).reason, 'conflict');
  srtTest.tick();
  assert.deepEqual(submit('host', 'move', a, aLock, move), moved, 'lost reply can be recovered after lease expires');
  assert.equal(submit('host', 'move', a, aLock, { ...move, end: 9 }).reason, 'request_reused');
  assert.equal(room.lock('host', a.id, aLock.token).reason, 'expired');
  const newLock = room.lock('member', a.id);
  room.release('host', a.id, aLock.token);
  const current = room.snapshot().entries[1];
  assert.equal(submit('host', 'late', current, aLock, move).reason, 'expired');
  assert.equal(submit('member', 'bad-version', current, newLock, { ...move, sessionId: 'other-room' }).reason, 'invalid_request');
  assert.equal(submit('member', 'invalid', current, newLock, { op: 'text', text: 'one\n\nsecond' }).reason, 'invalid_edit');
  assert.equal(submit('member', 'same', current, newLock, move).unchanged, true);
  assert.equal(srtTest.writes(), 2, 'no duplicate or no-op write');
  srtTest.fail(true);
  assert.equal(submit('member', 'retry', current, newLock, { ...move, end: 9 }).reason, 'save_failed');
  assert.equal(room.snapshot().revision, 2, 'failed disk write publishes no revision');
  srtTest.fail(false);
  fs.writeFileSync(file, 'external edit');
  assert.equal(submit('member', 'retry', current, newLock, { ...move, end: 9 }).reason, 'save_failed');
  assert.equal(submit('member', 'external-noop', current, newLock, move).reason, 'save_failed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'external edit');
  fs.writeFileSync(file, room.snapshot().text);
  assert.equal(submit('member', 'retry', current, newLock, { ...move, end: 9 }).revision, 3);
  room.release('member', 'nonexistent');

  const ass = '\uFEFF' + fs.readFileSync(new URL('./fixture.ass', import.meta.url), 'utf8');
  const unsupported = ass.replace('MarginV, Effect, Text', 'MarginV, Custom, Text');
  assert.notEqual(unsupported, ass);
  assert.throws(() => createCollabSession({ format: 'ass', text: unsupported, persist() {} }), /Unsupported ASS event format/);
  const assTest = open('ass', ass);
  const start = assTest.room.snapshot();
  assert.equal(start.text, ass);
  const pair = start.entries.find(e => e.zh?.includes('第1句') && e.words.length >= 4);
  const next = start.entries.find(e => e.zh?.includes('第2句'));
  assert.ok(pair && next);
  assert.ok(pair.eventLines.zh.length === 1 && pair.eventLines.en.length >= 4);
  const untouched = new AssDoc(start.text);
  const nextOriginal = [...next.eventLines.zh, ...next.eventLines.en].map(i => untouched.lines[i]);
  const lease = assTest.room.lock('editor', pair.id);
  const word = pair.words[0];
  const adjusted = assTest.submit('editor', 'word', pair, lease, {
    op: 'word', index: 0, edge: 'word-end', time: word.end - 0.1
  });
  assert.ok(adjusted.ok, adjusted.reason);
  assert.ok(Math.abs(adjusted.entry.words[0].end - (word.end - 0.1)) < 0.02);
  assert.equal(adjusted.entry.words[1].start, pair.words[1].start, 'independent handle preserves the next word');
  const expanded = assTest.submit('editor', 'en', adjusted.entry, lease, {
    op: 'text', side: 'en', text: 'row1 alpha beta gamma delta epsilon'
  });
  assert.ok(expanded.ok, expanded.reason);
  assert.equal(expanded.entry.id, pair.id);
  assert.equal(expanded.entry.words.length, 6);
  const changedZh = assTest.submit('editor', 'zh', expanded.entry, lease, {
    op: 'text', side: 'zh', text: '[甲]    第一行\\N第二行'
  });
  assert.ok(changedZh.ok, changedZh.reason);
  assert.equal(changedZh.entry.zh, '[甲] 第一行\\N第二行');
  const after = assTest.room.snapshot();
  assert.ok(after.text.startsWith('\uFEFF'));
  const afterDoc = new AssDoc(after.text);
  const nextEntry = after.entries.find(e => e.id === next.id);
  assert.equal(nextEntry.version, 0);
  assert.deepEqual([...nextEntry.eventLines.zh, ...nextEntry.eventLines.en].map(i => afterDoc.lines[i]), nextOriginal);
  assert.equal(after.text, fs.readFileSync(file, 'utf8'));
  console.log('collab-session: two editors, stable SRT/ASS targets, retries, leases and durable save ordering passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
