import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import updaterModule from '../desktop/update.cjs';

const { createUpdater, selectUpdate, fetchWithElectron } = updaterModule;
const repository = 'https://github.com/EndiVee233/SubFabric/releases/download/';
const installer = Buffer.from('test installer bytes');
const digest = createHash('sha256').update(installer).digest('hex');
function release(version, published, { prerelease = true, draft = false, suffix = '', sha = digest } = {}) {
  const patch = version.split('.').slice(0, 3).join('.');
  const tag = 'v' + patch + (prerelease ? '-beta.1' : '');
  const name = 'SubFabric-' + version + suffix + '-setup.exe';
  return { tag_name: tag, published_at: published, prerelease, draft, assets: [{
    name, browser_download_url: repository + tag + '/' + name, state: 'uploaded', digest: 'sha256:' + sha, size: installer.length
  }] };
}

const current = '1.5.12.8';
const installed = release(current, '2026-11-11T02:00:00Z');
const next = release('1.5.12.1', '2026-11-12T02:00:00Z');
const releases = [
  release('3.0.0.1', '2026-11-13T02:00:00Z', { draft: true }),
  release('2.4.0.1', '2026-10-01T02:00:00Z', { prerelease: false }),
  release('1.5.20.1', '2026-11-13T02:00:00Z', { suffix: '-sea' }),
  release('1.5.19.1', '2026-11-13T02:00:00Z', { sha: '' }),
  { tag_name: 'android-v9.0.0', published_at: '2026-11-13T02:00:00Z', assets: next.assets },
  release('1.5.11.1', '2026-11-13T02:00:00Z'),
  release('1.5.12.10', '2026-11-10T02:00:00Z'), installed, next
];
assert.equal(selectUpdate(releases, current, true)?.version, '1.5.12.1');
assert.equal(selectUpdate(releases, '1.5.12.1', true), null);
const stable = release('1.5.12.9', '2026-11-13T02:00:00Z', { prerelease: false });
assert.equal(selectUpdate([next, stable], current, false)?.version, '1.5.12.9');
assert.equal(selectUpdate([next], current, false), null);
assert.equal(selectUpdate([{ ...stable, assets: [{ ...stable.assets[0], browser_download_url: 'https://elsewhere.example/test.exe' }] }], current, false), null);
const request = new EventEmitter();
request.abort = () => request.emit('close');
request.end = () => request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/installer');
const redirect = await fetchWithElectron({ request: () => request }, next.assets[0].browser_download_url, {
  redirect: 'manual', signal: AbortSignal.timeout(1000)
});
assert.equal(redirect.status, 302);
assert.match(redirect.headers.get('location'), /^https:\/\/release-assets\.githubusercontent\.com\//);

const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'subfabric-update-'));
const cacheRoot = path.join(profileRoot, 'updates');
let checks = 0, downloads = 0, installs = 0, aborts = 0, mode = 'wrong-hash';
let updater;
try {
  updater = createUpdater({
    profileRoot, cacheRoot, version: current, beta: true, publish() {},
    async fetcher(url, { signal, redirect }) {
      if (url.startsWith('https://api.github.com/')) {
        assert.equal(redirect, 'error');
        checks++;
        if (mode === 'slow-check') {
          await delay(10000, undefined, { signal }).catch(error => { aborts++; throw error; });
        }
        if (mode === 'paginated' && new URL(url).searchParams.get('page') === '1') {
          return Response.json([], { headers: { link: '<https://api.github.com/?page=2>; rel="next"' } });
        }
        return Response.json(mode === 'current' ? [installed] : [installed, next]);
      }
      assert.equal(redirect, 'manual');
      if (url.startsWith('https://github.com/')) {
        downloads++;
        return Response.redirect(mode === 'bad-redirect'
          ? 'https://unrelated.example/installer.exe' : 'https://release-assets.githubusercontent.com/installer', 302);
      }
      assert.equal(url, 'https://release-assets.githubusercontent.com/installer');
      return new Response(mode === 'wrong-hash' ? Buffer.alloc(installer.length) : installer);
    },
    async install(filename, version) {
      assert.equal(version, '1.5.12.1');
      assert.deepEqual(await fs.readFile(filename), installer);
      installs++;
    }
  });
  async function waitFor(predicate) {
    for (let i = 0; i < 300; i++) {
      if (predicate(updater.snapshot())) return;
      await delay(10);
    }
    assert.fail(JSON.stringify(updater.snapshot()));
  }

  updater.start();
  updater.command('disable');
  assert.equal(updater.snapshot().enabled, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(profileRoot, 'update-settings.json'), 'utf8')).enabled, false);
  updater.command('check');
  updater.command('check');
  await waitFor(state => state.error === 'download');
  assert.equal(checks, 1);
  await assert.rejects(fs.stat(path.join(profileRoot, 'updates/setup.exe')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(profileRoot, 'updates/setup.part')), { code: 'ENOENT' });

  mode = 'bad-redirect';
  updater.command('check');
  await waitFor(state => state.error === 'download');
  assert.equal(downloads, 2);

  mode = 'good';
  updater.command('check');
  await waitFor(state => state.phase === 'ready');
  assert.equal(updater.snapshot().percent, 100);
  assert.equal(downloads, 3);
  updater.command('check');
  await waitFor(state => state.phase === 'ready');
  assert.equal(downloads, 3, 'verified cache should prevent another download');
  updater.command('install');
  updater.command('install');
  await waitFor(state => state.phase === 'ready');
  assert.equal(installs, 1, 'double click must not start a second installer');
  await fs.writeFile(path.join(profileRoot, 'updates/setup.exe'), 'modified installer');
  updater.command('install');
  await waitFor(state => state.error === 'download');
  assert.equal(installs, 1, 'reverify the on-disk installer before handing it to NSIS');

  mode = 'slow-check';
  updater.command('enable');
  await waitFor(state => state.phase === 'checking');
  updater.command('disable');
  await waitFor(state => state.phase === 'idle');
  assert.equal(aborts, 1);

  mode = 'current';
  updater.command('check');
  await waitFor(state => state.phase === 'current');
  await assert.rejects(fs.stat(path.join(profileRoot, 'updates/setup.exe')), { code: 'ENOENT' });
  assert.equal(createUpdater({ profileRoot, cacheRoot, version: current, publish() {} }).snapshot().enabled, false);
  mode = 'paginated';
  updater.command('check');
  await waitFor(state => state.phase === 'ready');
  assert.equal(updater.snapshot().available, '1.5.12.1');
  console.log('Windows update: release selection, integrity, cache, settings, cancellation and install hand-off PASS');
} finally {
  updater?.stop();
  await fs.rm(profileRoot, { recursive: true, force: true });
}
