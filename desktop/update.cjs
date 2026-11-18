'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Writable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { safePath } = require('./security.cjs');

const REPOSITORY = 'EndiVee233/SubFabric';
const RELEASES = 'https://api.github.com/repos/' + REPOSITORY + '/releases?per_page=100';
const MAX_INSTALLER = 1024 * 1024 * 1024;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const ACTIONS = ['check', 'enable', 'disable', 'install'];
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function compareVersion(left, right, parts = 4) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < parts; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function selectUpdate(releases, current, beta) {
  if (!Array.isArray(releases)) throw Error('Invalid GitHub releases response');
  const candidates = [];
  for (const release of releases) {
    const tag = /^v(\d{1,5}\.\d{1,5}\.\d{1,5})(?:-beta\.\d+)?$/.exec(release.tag_name);
    const published = Date.parse(release.published_at);
    if (!tag || !Number.isFinite(published) || release.draft || (!beta && release.prerelease)) continue;
    for (const asset of release.assets || []) {
      const match = /^SubFabric-(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})-setup\.exe$/.exec(asset.name);
      if (!match || !match[1].startsWith(tag[1] + '.') || asset.state !== 'uploaded') continue;
      const url = 'https://github.com/' + REPOSITORY + '/releases/download/' + release.tag_name + '/' + asset.name;
      if (asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)
        || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_INSTALLER) continue;
      candidates.push({ version: match[1], published, url, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size });
    }
  }
  candidates.sort((a, b) => compareVersion(b.version, a.version, 3) || b.published - a.published || compareVersion(b.version, a.version));
  const installed = candidates.find(item => item.version === current);
  return candidates.find(item => {
    const patch = compareVersion(item.version, current, 3);
    if (item.version === current || patch < 0 || (installed && item.published <= installed.published)) return false;
    return installed || compareVersion(item.version, current) > 0;
  }) || null;
}

async function readReleases(fetcher, signal, current) {
  const releases = [];
  for (let page = 1; page <= 5; page++) {
    const response = await fetcher(RELEASES + '&page=' + page, {
      signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json' }
    });
    if (!response.ok || !response.body) throw Error('GitHub releases: HTTP ' + response.status);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Error('GitHub releases response is too large');
      chunks.push(chunk);
    }
    const entries = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(entries)) throw Error('Invalid GitHub releases response');
    releases.push(...entries);
    if (!response.headers.get('link')?.includes('rel="next"')
      || entries.some(entry => entry.assets?.some(asset => asset.name === 'SubFabric-' + current + '-setup.exe'))) break;
  }
  return releases;
}

// Electron net.fetch cancels manual redirects without exposing their Location.
// Use ClientRequest for assets so each redirect can be verified before following it.
function fetchWithElectron(net, url, options) {
  if (options.redirect !== 'manual') return net.fetch(url, { ...options, credentials: 'omit' });
  const { signal } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual', credentials: 'omit' });
    function abort() { request.abort(); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal.removeEventListener('abort', abort));
    request.on('error', reject);
    request.once('redirect', (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.once('response', response => {
      const status = response.statusCode;
      resolve(new Response(status === 200 ? Readable.toWeb(response) : null, { status }));
      if (status !== 200) request.abort();
    });
    request.end();
  });
}

async function installerResponse(fetcher, url, signal) {
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetcher(url, { signal, redirect: 'manual' });
    if (response.status === 200 && response.body) return response;
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) throw Error('GitHub installer: HTTP ' + response.status);
    const target = new URL(response.headers.get('location'), url);
    if (target.protocol !== 'https:' || target.port || target.username || target.password || !ASSET_HOSTS.has(target.hostname)) {
      throw Error('Unexpected GitHub asset redirect');
    }
    url = target.href;
  }
  throw Error('Too many GitHub asset redirects');
}

function verifier(asset, progress) {
  const hash = createHash('sha256');
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > asset.size) return done(Error('Installer exceeds the published size'));
      hash.update(chunk);
      progress(Math.floor(bytes * 100 / asset.size));
      done(null, chunk);
    },
    flush(done) {
      done(bytes === asset.size && hash.digest('hex') === asset.sha256 ? null : Error('Installer SHA-256 or size does not match GitHub'));
    }
  });
}

function createUpdater({ profileRoot, cacheRoot, version, beta, publish, install, fetcher = fetch }) {
  const prefs = () => safePath(profileRoot, 'update-settings.json');
  const setup = () => safePath(cacheRoot, 'setup.exe');
  const partial = () => safePath(cacheRoot, 'setup.part');
  let enabled = true;
  try { enabled = JSON.parse(fs.readFileSync(prefs(), 'utf8')).enabled !== false; } catch {}
  let state = { version, enabled, phase: 'idle', available: '', percent: 0, error: '' };
  let candidate, operation, automatic, initial, interval, closed = false;
  const update = fields => { state = { ...state, ...fields }; if (!closed) publish(state); };

  async function verifyCached(asset, signal) {
    await pipeline(fs.createReadStream(setup()), verifier(asset, () => {}), new Writable({
      write(_chunk, _encoding, done) { done(); }
    }), { signal });
  }

  async function cacheInstaller(asset, signal) {
    try { await verifyCached(asset, signal); return; } catch { signal.throwIfAborted(); }
    const target = setup();
    const staging = partial();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(staging, { force: true });
    try {
      const response = await installerResponse(fetcher, asset.url, signal);
      await pipeline(response.body, verifier(asset, percent => {
        if (percent !== state.percent) update({ percent });
      }), fs.createWriteStream(staging, { flags: 'wx' }), { signal });
      await fsp.rename(staging, target);
    } finally {
      await fsp.rm(staging, { force: true });
    }
  }

  async function check(isAutomatic) {
    if (closed || operation || state.phase === 'installing' || (isAutomatic && !enabled)) return;
    const controller = new AbortController();
    operation = controller;
    automatic = isAutomatic;
    let phase = 'check';
    try {
      update({ phase: 'checking', error: '' });
      const releases = await readReleases(fetcher, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), version);
      const next = selectUpdate(releases, version, beta);
      if (!next) {
        await fsp.unlink(setup()).catch(() => {}); // A just-restarted installer may still hold its image open.
        candidate = null;
        update({ phase: 'current', available: '', percent: 0 });
        return;
      }
      phase = 'download';
      candidate = null;
      update({ phase: 'downloading', available: next.version, percent: 0 });
      await cacheInstaller(next, AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)]));
      controller.signal.throwIfAborted();
      candidate = next;
      update({ phase: 'ready', percent: 100 });
    } catch (error) {
      if (controller.signal.aborted) update({ phase: 'idle', available: '', percent: 0 });
      else {
        console.warn('[update]', error.message);
        update({ phase: candidate ? 'ready' : 'error', error: phase });
      }
    } finally {
      operation = null;
    }
  }

  async function apply() {
    if (closed || operation || !candidate || state.phase !== 'ready') return;
    update({ phase: 'installing', error: '' });
    try {
      await verifyCached(candidate, AbortSignal.timeout(30000));
    } catch (error) {
      console.warn('[update]', error.message);
      candidate = null;
      update({ phase: 'error', error: 'download' });
      return;
    }
    if (closed) return;
    try {
      await install(setup(), candidate.version);
      update({ phase: 'ready' });
    } catch (error) {
      console.warn('[update]', error.message);
      update({ phase: 'ready', error: 'install' });
    }
  }

  function setEnabled(value) {
    if (value === enabled) return;
    try {
      const file = prefs();
      const temp = safePath(profileRoot, 'update-settings.tmp');
      fs.writeFileSync(temp, JSON.stringify({ enabled: value }) + '\n');
      fs.renameSync(temp, file);
      enabled = value;
      update({ enabled, error: '' });
      if (enabled) void check(true);
      else if (automatic) operation?.abort();
    } catch (error) {
      console.warn('[update]', error.message);
      update({ error: 'settings' });
    }
  }

  return {
    start() {
      publish(state);
      initial = setTimeout(() => void check(true), 4000);
      interval = setInterval(() => void check(true), CHECK_INTERVAL);
    },
    command(action) {
      if (closed || state.phase === 'installing') return;
      if (action === 'check') void check(false);
      if (action === 'install') void apply();
      if (action === 'enable' || action === 'disable') setEnabled(action === 'enable');
    },
    stop() {
      closed = true;
      clearTimeout(initial);
      clearInterval(interval);
      operation?.abort();
    },
    snapshot() { return state; }
  };
}

module.exports = { createUpdater, selectUpdate, fetchWithElectron, ACTIONS };
