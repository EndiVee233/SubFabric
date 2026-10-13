import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { serverFunctions } from './helpers/server-functions.mjs';
const { readBody, invokeRequest } = serverFunctions(['requestError', 'invokeRequest', 'readBody'], {
  console: { error() {} }, sendJson(res, code, body) { assert.equal(res.writableEnded, false); res.status = code; res.body = body; res.headersSent = true; res.end(); }
});
const response = () => { const r = new EventEmitter(); r.writableEnded = false; r.ends = 0; r.end = () => { r.ends++; r.writableEnded = true; }; return r; };
const tick = () => new Promise(r => setImmediate(r));
for (const cb of [() => { throw Error('sync'); }, async () => { await Promise.resolve(); throw Error('async'); },
  async () => { await Promise.resolve(); fs.writeFileSync('Z:/nonexistent/subfabric-file', 'fail'); }]) {
  const req = new PassThrough(), res = response(); readBody(req, res, 1024, cb); req.end('body'); await tick();
  assert.equal(res.status, 500); assert.equal(res.ends, 1);
}
{
  const req = new PassThrough(), res = response(); let called = false;
  readBody(req, res, 2, () => { called = true; }); req.end('oversized'); await tick();
  assert.equal(res.status, 413); assert.equal(called, false); assert.equal(res.ends, 1);
}
{
  const req = new PassThrough(), res = response(); let called = false;
  readBody(req, res, 1024, () => { called = true; }); req.write('partial'); req.aborted = true; req.emit('aborted'); req.end(); await tick();
  assert.equal(called, false); assert.equal(res.ends, 0);
}
{
  const res = response(); await invokeRequest({}, res, async () => { res.end(); await Promise.resolve(); throw Error('after send'); }); assert.equal(res.ends, 1);
  const disconnected = response(); disconnected.destroyed = true;
  await invokeRequest({}, disconnected, async () => { throw Error('closed'); }); assert.equal(disconnected.ends, 0);
}
console.log('repair10: sync/async/write errors, size limit, disconnect and already-sent errors finish exactly once passed');
