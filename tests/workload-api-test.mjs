import assert from 'node:assert/strict';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
try {
  for (const name of ['workload', 'workload-panel']) {
    const response = await server.call('/editor/js/' + name + '.js?v=fixture');
    assert.equal(response.status, 200, 'forecast imports must be in the static resource allowlist');
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /export function/);
  }
  for (const file of ['/editor/js/workload-private.js', '/asr/settings.json']) {
    assert.equal((await server.call(file)).status, 403, 'new imports do not broaden static file access');
  }
  console.log('Workload API: both frontend imports served; unrelated and private paths remain denied');
} finally { await server.close(); }
