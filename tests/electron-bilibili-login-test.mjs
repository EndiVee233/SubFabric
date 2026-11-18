import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import {
  LOGIN_ROUTE, allowedLoginURL, sessionValue, createBilibiliLogin,
} from '../desktop/bilibili-login.cjs';

const loginURL = 'https://passport.bilibili.com/login';
const valid = { name: 'SESSDATA', domain: '.bilibili.com', secure: true, path: '/', value: 'fixture-only' };
const invalid = [
  { name: 'bili_jct' }, { domain: 'other.bilibili.com' }, { domain: 'bilibili.com.example.org' },
  { path: '/login' }, { secure: false }, { value: 'x;y' }, { value: 'x\ny' }, { value: '' },
];
assert.equal(sessionValue(valid), valid.value);
for (const change of invalid) assert.equal(sessionValue({ ...valid, ...change }), '');
assert.ok(allowedLoginURL(loginURL));
assert.ok(allowedLoginURL('https://www.bilibili.com/'));
for (const url of ['http://passport.bilibili.com/login', 'https://bilibili.com.example.org/', 'https://passport.bilibili.com:444/', 'https://name@passport.bilibili.com/', 'https://127.0.0.1/']) {
  assert.equal(allowedLoginURL(url), false, url);
}

const windows = [], states = [];
class Window extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
    windows.push(this);
  }
  focus() { this.focused = true; }
  removeMenu() {}
  isDestroyed() { return !!this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  async loadURL(url) { assert.equal(url, loginURL); }
}

let clears = 0, requests = 0, success = true;
const partition = new EventEmitter();
partition.cookies = new EventEmitter();
partition.clearStorageData = async () => { clears++; };
partition.setPermissionCheckHandler = fn => assert.equal(fn(), false);
partition.setPermissionRequestHandler = fn => fn(null, 'media', result => assert.equal(result, false));
const session = { fromPartition(name, options) {
  assert.equal(name, 'subfabric-bilibili-login');
  assert.equal(options.cache, false);
  return partition;
} };
const backend = { origin: 'http://127.0.0.1:8325', token: 'test-control-key', child: {
  connected: true,
  send(message, callback) { states.push(message); callback(); },
} };
const login = createBilibiliLogin({
  BrowserWindow: Window, session, backend, parent: { isDestroyed: () => false },
  fetcher: async (url, options) => {
    requests++;
    assert.equal(url, backend.origin + LOGIN_ROUTE + '/complete');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-SubFabric-Token'], backend.token);
    assert.equal(JSON.parse(options.body).session === valid.value, true);
    return new Response(null, { status: success ? 200 : 409 });
  },
});
const cookieChanged = (cookie, removed = false) => partition.cookies.emit('changed', null, cookie, 'explicit', removed);
login.open();
await setImmediate();
assert.equal(states.at(-1).state, 'pending');
const window = windows[0];
assert.equal(window.options.webPreferences.session, partition);
assert.equal(window.options.webPreferences.sandbox, true);
assert.equal(window.options.webPreferences.contextIsolation, true);
assert.equal(window.options.webPreferences.nodeIntegration, false);
assert.deepEqual(window.openHandler(), { action: 'deny' });
let blocked = false;
window.webContents.emit('will-redirect', { url: 'https://example.org/', preventDefault() { blocked = true; } });
assert.equal(blocked, true);
login.open();
assert.equal(windows.length, 1);
assert.equal(window.focused, true);
for (const change of invalid) cookieChanged({ ...valid, ...change });
cookieChanged(valid, true);
assert.equal(requests, 0);
cookieChanged(valid);
cookieChanged(valid);
await setImmediate();
assert.equal(requests, 1);
assert.equal(window.isDestroyed(), true);
assert.equal(clears, 2);
assert.equal(partition.cookies.listenerCount('changed'), 0);

login.open();
await setImmediate();
windows[1].emit('close');
await setImmediate();
assert.equal(requests, 1);
assert.equal(windows[1].isDestroyed(), true);

success = false;
login.open();
await setImmediate();
cookieChanged(valid);
await setImmediate();
assert.equal(requests, 2);
assert.deepEqual(states, ['idle', 'pending', 'saved', 'pending', 'cancelled', 'pending', 'error']
  .map(state => ({ type: 'subfabric-bilibili-login-state', state })));
console.log('Electron bilibili login PASS: isolated window, navigation, cookie scope, save, cancellation, and validation failure');
