import assert from 'node:assert/strict';
import http from 'node:http';
import { isolatedServer } from './helpers/isolated-server.mjs';
const token = 'isolated-native-token';
const s = await isolatedServer({ env: { SUBFABRIC_CONTROL_TOKEN: token } });
try {
  const route = '/api/asr/delete', body = '{"modelId":"bcut"}';
  const write = headers => fetch(s.origin + route, { method: 'POST', headers, body });
  for (const origin of [s.origin, `http://localhost:${s.port}`, `http://[::1]:${s.port}`]) assert.equal((await write({ Origin: origin })).status, 400);
  for (const origin of [`http://127.0.0.1:${s.port + 1}`, `https://127.0.0.1:${s.port}`, 'http://evil.example', 'null']) {
    assert.equal((await write({ Origin: origin })).status, 403);
    assert.equal((await fetch(s.origin + '/api/version', { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await write({})).status, 403);
  assert.equal((await write({ 'X-SubFabric-Token': 'wrong' })).status, 403);
  assert.equal((await write({ 'X-SubFabric-Token': token })).status, 400);
  const hostStatus = await new Promise(resolve => { http.get(s.origin + '/api/version', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(s.origin + '/api/version')).status, 200);
  console.log('repair11: actual port aliases, wrong port/protocol/external/null/missing Origin, native token and Host guard passed');
} finally { await s.close(); }
