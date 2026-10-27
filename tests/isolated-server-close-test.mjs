import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server = await isolatedServer();
let closed = false;
server.child.once('close', () => { closed = true; });
const timers = new Set();
const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = setTimer(() => { timers.delete(timer); fn(...args); }, ms);
  timers.add(timer); return timer;
};
globalThis.clearTimeout = timer => { timers.delete(timer); return clearTimer(timer); };
try {
  await server.close();
  assert.equal(closed, true, 'cleanup must wait until the process and its pipes have closed');
  assert.equal(fs.existsSync(server.root), false);
  assert.equal(timers.size, 0, 'successful cleanup must clear its timeout');
  await server.close();
  console.log('isolated server: process/pipe closure, timeout release and repeated cleanup verified');
} finally {
  globalThis.setTimeout = setTimer; globalThis.clearTimeout = clearTimer;
  for (const timer of timers) clearTimer(timer);
  await server.close();
}
