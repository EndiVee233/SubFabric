import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { isolatedServer } from './helpers/isolated-server.mjs';

const id = 'p-collab-loopback';
const source = '1\n00:00:01,000 --> 00:00:02,000\n第一句\n\n2\n00:00:04,000 --> 00:00:05,000\n第二句\n';
const hash = text => createHash('sha256').update(text).digest('hex');

const srv = await isolatedServer({ prepare(root) {
  const dir = path.join(root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name: '协作测试', subtitle: { file: 'subtitle.srt', format: 'srt' } }));
  fs.writeFileSync(path.join(dir, 'subtitle.srt'), source);
}});
const open = (revision, existingOnly = false) => srv.call('/api/collab/open', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: id, revision, existingOnly })
});
const saveLegacy = (text, revision) => srv.call('/api/projects/' + id + '/subtitle?revision=' + revision, {
  method: 'PUT', body: text
});
let events;
try {
  assert.equal((await open('', true)).status, 404);
  assert.equal((await open('0'.repeat(64))).status, 409);
  // Keep an old editor's streaming PUT in flight. Opening while it still owns
  // a write must fail even though its current on-disk revision still matches.
  const upload = http.request(srv.origin + '/api/projects/' + id + '/subtitle?revision=' + hash(source), {
    method: 'PUT', headers: { Origin: srv.origin, 'Content-Type': 'text/plain' }
  });
  try {
    upload.write(source);
    const projectDir = path.join(srv.root, 'projects', id);
    const deadline = Date.now() + 3000;
    while (!fs.readdirSync(projectDir).some(name => /^subtitle\.srt\..+\.tmp$/.test(name))) {
      if (Date.now() > deadline) throw new Error('Legacy upload did not start');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal((await open(hash(source))).status, 409);
    const response = new Promise((resolve, reject) => {
      upload.once('error', reject);
      upload.once('response', res => { res.resume(); resolve(res.statusCode); });
    });
    upload.end();
    assert.equal(await response, 200);
  } finally { upload.destroy(); }

  const opened = await open(hash(source));
  assert.equal(opened.status, 200, await opened.clone().text());
  const { hostUrl, inviteUrl } = await opened.json();
  assert.deepEqual(await (await open('', true)).json(), { hostUrl, inviteUrl });
  const host = new URL(hostUrl), invitation = new URL(inviteUrl);
  assert.equal(host.hostname, '127.0.0.1');
  assert.notEqual(host.origin, srv.origin);
  assert.equal(invitation.origin, host.origin);
  const hostToken = new URLSearchParams(host.hash.slice(1)).get('host');
  const invite = new URLSearchParams(invitation.hash.slice(1)).get('invite');
  const room = (api, token, body) => fetch(host.origin + '/api/' + api, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: host.origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000)
  });
  assert.equal((await room('snapshot', invite)).status, 401);
  assert.equal((await room('join', 'wrong', {})).status, 401);
  assert.equal((await room('projects', hostToken)).status, 404);
  assert.equal((await fetch(host.origin + '/editor/server.js')).status, 401);
  assert.equal((await fetch(host.origin + '/', { headers: { Origin: 'http://example.test' } })).status, 403);
  assert.match(await (await fetch(host.origin)).text(), /本机协作/);
  assert.match(await (await fetch(host.origin + '/room.js')).text(), /connect\(\)/);
  const guest = (await (await room('join', invite, {})).json()).token;
  assert.equal((await room('end', guest, {})).status, 403);
  const first = await (await room('snapshot', hostToken)).json();
  const second = await (await room('snapshot', guest)).json();
  assert.equal(first.owner, true);
  assert.equal(second.owner, false);
  assert.equal(first.sessionId, second.sessionId);
  const response = await room('events', guest);
  events = response.body.getReader();
  assert.match(Buffer.from((await events.read()).value).toString(), /"revision":0/);

  const [a, b] = first.entries;
  const aLock = await (await room('lock', hostToken, { entryId: a.id })).json();
  assert.equal((await room('lock', guest, { entryId: a.id })).status, 409);
  const bLock = await (await room('lock', guest, { entryId: b.id })).json();
  const intent = (entry, lock, requestId, command) => ({
    ...command, requestId, sessionId: first.sessionId, entryId: entry.id, version: entry.version, token: lock.token
  });
  const aEdit = intent(a, aLock, 'host-text', { op: 'text', text: '主机提交' });
  const bEdit = intent(b, bLock, 'guest-time', { op: 'time', start: 6, end: 7 });
  const saved = await (await room('intent', hostToken, aEdit)).json();
  assert.equal(saved.revision, 1);
  assert.deepEqual(await (await room('receipt', hostToken, { requestId: aEdit.requestId })).json(), { result: saved });
  assert.deepEqual(await (await room('receipt', guest, { requestId: aEdit.requestId })).json(), { result: null });
  assert.match(Buffer.from((await events.read()).value).toString(), /"revision":1/);
  assert.deepEqual(await (await room('intent', hostToken, aEdit)).json(), saved);
  assert.equal((await (await room('intent', guest, bEdit)).json()).revision, 2);
  const current = await (await room('snapshot', guest)).json();
  assert.deepEqual(current.entries.map(row => [row.start, row.end, row.text]), [[1, 2, '主机提交'], [6, 7, '第二句']]);
  const disk = fs.readFileSync(path.join(srv.root, 'projects', id, 'subtitle.srt'), 'utf8');
  assert.equal(current.text, disk);
  assert.equal((await saveLegacy('old overwrite', hash(disk))).status, 409);
  if (process.platform === 'win32') {
    assert.equal((await srv.call('/api/projects/' + id.toUpperCase() + '/subtitle?revision=' + hash(disk), {
      method: 'PUT', body: 'case alias overwrite'
    })).status, 409);
  }
  assert.equal((await srv.call('/api/projects/' + id + '/translate', { method: 'POST', body: '{}' })).status, 409);
  assert.equal((await srv.call('/api/projects/' + id, { method: 'DELETE' })).status, 409);
  assert.equal((await srv.call('/api/projects/' + id + '/export-pack')).status, 409);
  assert.equal((await room('leave', guest, {})).status, 200);
  assert.equal((await room('snapshot', guest)).status, 401);
  assert.equal((await room('lock', hostToken, { entryId: b.id })).status, 200);
  assert.equal((await room('end', hostToken, {})).status, 200);
  assert.equal((await saveLegacy('stale', hash(source))).status, 409);
  assert.equal((await saveLegacy(disk, hash(disk))).status, 200);
  console.log('collab loopback: authenticated two-client SSE, edits, lagging legacy writes and room shutdown passed');
} finally {
  await events?.cancel().catch(() => {});
  await srv.close();
}
