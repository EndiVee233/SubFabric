import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function isolatedServer(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subfabric-repair-'));
  const editor = path.join(root, 'editor');
  fs.cpSync(path.join(options.source || SOURCE, 'editor'), editor, { recursive: true,
    filter: p => !/[\\/](vendor|node_modules)([\\/]|$)/.test(p) });
  fs.mkdirSync(path.join(root, 'asr'), { recursive: true });
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(editor, 'server.js'), '--no-tray'], {
    cwd: options.cwd || root, windowsHide: true,
    env: { ...process.env, PORT: String(port), SUBFABRIC_TRAY: '0', ...options.env }
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const call = (url, init = {}) => fetch(origin + url, { ...init,
    headers: { Origin: origin, ...init.headers } });
  const close = async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (child.exitCode !== null) throw Error(output);
      try { if ((await call('/api/version')).ok) break; } catch {}
      if (Date.now() > deadline) throw Error('Isolated server timeout: ' + output);
      await new Promise(r => setTimeout(r, 50));
    }
    return { root, port, origin, child, call, close, output: () => output,
      settings: value => fs.writeFileSync(path.join(root, 'asr/settings.json'), JSON.stringify(value)) };
  } catch (e) { await close(); throw e; }
}
