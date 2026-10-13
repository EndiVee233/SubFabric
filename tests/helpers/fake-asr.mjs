import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
export function fakeAsr() {
  const processes = [];
  const spawnImpl = () => {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.requests = []; p.kills = []; p.alive = true;
    p.stdin = new Writable({ write(data, encoding, callback) { p.requests.push(JSON.parse(String(data))); callback(); } });
    p.kill = signal => { p.kills.push(signal); p.alive = false; p.emit('close', 0); };
    p.reply = obj => p.stdout.write(JSON.stringify(obj) + '\n');
    processes.push(p); return p;
  };
  return { processes, spawnImpl };
}
export const tick = () => new Promise(r => setImmediate(r));
