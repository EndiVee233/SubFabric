import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolatedServer } from './helpers/isolated-server.mjs';

const s = await isolatedServer();
try {
  const make = id => {
    const dir = path.join(s.root, 'projects', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name: id, subtitle: { file: 'subtitle.ass' } }));
    fs.writeFileSync(path.join(dir, 'subtitle.ass'), 'initial'); return dir;
  };
  const dir = make('p-save'); make('p-other');
  const revision = async id => (await s.call(`/api/projects/${id}/subtitle`)).headers.get('etag').replaceAll('"', '');
  const base = await revision('p-save');
  function upload(client, seq, method = 'PUT', rev = base, id = 'p-save') {
    let resolve;
    const result = new Promise(r => { resolve = r; });
    const req = http.request(`${s.origin}/api/projects/${id}/subtitle?revision=${rev}&client=${client}&seq=${seq}`, {
      method, headers: { Origin: s.origin }
    }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) })); });
    req.on('error', e => resolve({ error: e }));
    return { req, result };
  }
  const a = upload('window_A_123', 1), b = upload('window_B_123', 1);
  a.req.write('AAAA-'); b.req.write('BBBB-');
  b.req.end('end'); assert.equal((await b.result).status, 200);
  a.req.end('end'); assert.equal((await a.result).status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.ass'), 'utf8'), 'BBBB-end');
  const next = await revision('p-save');
  const put = upload('same_window_123', 1, 'PUT', next);
  const beacon = upload('same_window_123', 2, 'POST', next);
  put.req.write('older-'); beacon.req.write('newer-');
  put.req.end('body'); assert.equal((await put.result).status, 200);
  beacon.req.end('body'); const saved = await beacon.result;
  assert.equal(saved.status, 200); assert.equal(saved.body.revision, await revision('p-save'));
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.ass'), 'utf8'), 'newer-body');
  const late = upload('same_window_123', 1, 'POST', next); late.req.end('older-body');
  assert.equal((await late.result).status, 409);
  const broken = upload('broken_window_123', 1, 'PUT', saved.body.revision);
  broken.req.write('incomplete');
  const other = upload('other_window_123', 1, 'PUT', await revision('p-other'), 'p-other');
  other.req.end('independent'); assert.equal((await other.result).status, 200);
  broken.req.destroy(); await broken.result;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.ass'), 'utf8'), 'newer-body');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
  const noRevision = await s.call('/api/projects/p-save/subtitle', { method: 'PUT', body: 'bad' });
  assert.equal(noRevision.status, 428);
  console.log('repair02: interleaved uploads, two windows, PUT/beacon ordering, independent project and abort cleanup passed');
} finally { await s.close(); }
