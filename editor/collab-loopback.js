'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');

const HOST = '127.0.0.1';
const credential = () => randomBytes(24).toString('base64url');
const assets = new Map([
  ['/', ['editor/collab.html', 'text/html; charset=utf-8']],
  ['/room.js', ['editor/js/collab-room.js', 'text/javascript; charset=utf-8']],
  ['/room.css', ['editor/css/collab.css', 'text/css; charset=utf-8']]
]);

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 128 * 1024) { req.resume(); return null; }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

function startCollabLoopback({ session, readAsset, onClose }) {
  const host = credential();
  const invite = credential();
  const actors = new Map([[host, { id: 'host', owner: true, stream: null }]]);
  let sequence = 0, stopped = false, snapshot = session.snapshot();
  const sockets = new Set();

  function sendEvent(actor, data) {
    const stream = actor.stream;
    if (!stream || stream.destroyed) return;
    if (stream.writableLength > 64 * 1024) return stream.destroy();
    stream.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(ping);
    for (const actor of actors.values()) {
      sendEvent(actor, { closed: true });
      actor.stream?.end();
    }
    actors.clear();
    listener.close();
    const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 500);
    timer.unref();
    onClose();
  }

  async function route(req, res) {
    const authority = HOST + ':' + listener.address()?.port;
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== 'http://' + authority) ||
        (req.method === 'POST' && req.headers.origin !== 'http://' + authority)) {
      return reply(res, 403, { reason: 'origin' });
    }
    const url = new URL(req.url, 'http://' + authority);
    if (url.origin !== 'http://' + authority) return reply(res, 403, { reason: 'origin' });
    const path = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const asset = assets.get(path);
    if (asset && req.method === 'GET') {
      const bytes = readAsset(asset[0]);
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      return res.end(bytes);
    }
    if (stopped) return reply(res, 410, { reason: 'ended' });
    const auth = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || '')?.[1];
    if (path === '/api/join' && req.method === 'POST') {
      if (auth !== invite) return reply(res, 401, { reason: 'unauthorized' });
      if (actors.size >= 5) return reply(res, 409, { reason: 'full' });
      const token = credential();
      actors.set(token, { id: 'guest-' + (++sequence), owner: false, stream: null, lastSeen: Date.now() });
      return reply(res, 200, { token });
    }
    const actor = actors.get(auth);
    if (!actor) return reply(res, 401, { reason: 'unauthorized' });
    actor.lastSeen = Date.now();
    if (path === '/api/snapshot' && req.method === 'GET') {
      return reply(res, 200, { ...snapshot, owner: actor.owner, participant: actor.id });
    }
    if (path === '/api/events' && req.method === 'GET') {
      actor.stream?.end();
      actor.stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      sendEvent(actor, { revision: snapshot.revision });
      res.on('close', () => { if (actor.stream === res) { actor.stream = null; actor.lastSeen = Date.now(); } });
      return;
    }
    if (!['/api/lock', '/api/release', '/api/intent', '/api/receipt', '/api/end', '/api/leave'].includes(path) || req.method !== 'POST') {
      return reply(res, 404, { reason: 'unknown_route' });
    }
    const data = await readJson(req);
    if (stopped || actors.get(auth) !== actor) return reply(res, 410, { reason: 'ended' });
    if (!data) return reply(res, 400, { reason: 'invalid_request' });
    if (path === '/api/receipt') {
      if (typeof data.requestId !== 'string' || !/^[\w-]{1,80}$/.test(data.requestId)) {
        return reply(res, 400, { reason: 'invalid_request' });
      }
      return reply(res, 200, { result: session.receipt(actor.id, data.requestId) });
    }
    if (path === '/api/end') {
      if (!actor.owner) return reply(res, 403, { reason: 'forbidden' });
      reply(res, 200, { ok: true });
      return close();
    }
    if (path === '/api/leave') {
      if (actor.owner) return reply(res, 403, { reason: 'forbidden' });
      actor.stream?.end();
      actors.delete(auth);
      session.releaseMember(actor.id);
      return reply(res, 200, { ok: true });
    }
    if (typeof data.entryId !== 'string' || !/^[1-9]\d{0,7}$/.test(data.entryId) ||
        (data.token !== undefined && typeof data.token !== 'string')) {
      return reply(res, 400, { reason: 'invalid_request' });
    }
    if (path === '/api/lock') {
      const result = session.lock(actor.id, data.entryId, data.token);
      return reply(res, result.ok ? 200 : 409, result);
    }
    if (path === '/api/release') {
      session.release(actor.id, data.entryId, data.token);
      return reply(res, 200, { ok: true });
    }
    const result = session.submit(actor.id, data);
    if (result.ok && result.revision > snapshot.revision) {
      snapshot = session.snapshot();
      for (const peer of actors.values()) sendEvent(peer, { revision: snapshot.revision });
    }
    return reply(res, result.ok ? 200 : 409, result);
  }

  const listener = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) reply(res, 500, { reason: 'internal' });
      else res.destroy();
    });
  });
  listener.maxConnections = 24;
  listener.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const ping = setInterval(() => {
    for (const [token, actor] of actors) {
      if (!actor.owner && !actor.stream && Date.now() - actor.lastSeen > 120_000) {
        actors.delete(token);
        session.releaseMember(actor.id);
      } else sendEvent(actor, { revision: snapshot.revision });
    }
  }, 10_000);
  ping.unref();

  return new Promise((resolve, reject) => {
    listener.on('error', error => { close(); reject(error); });
    listener.listen(0, HOST, () => {
      const url = 'http://' + HOST + ':' + listener.address().port + '/';
      resolve({ hostUrl: url + '#host=' + host, inviteUrl: url + '#invite=' + invite, close });
    });
  });
}

module.exports = { startCollabLoopback };
