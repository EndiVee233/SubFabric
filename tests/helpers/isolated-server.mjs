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
  /* 个别测试需要在服务启动**之前**写隔离副本里的 asr/settings.json（例如指定 Python
   * 解释器，ASR_PY 在启动时就解析好了，后写不生效）。回调只拿到隔离副本的 root。 */
  if (typeof options.prepare === 'function') await options.prepare(root, editor);
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(editor, 'server.js'), '--no-tray'], {
    cwd: options.cwd || root, windowsHide: true,
    env: { ...process.env, PORT: String(port), SUBFABRIC_TRAY: '0', ...options.env }
  });
  let childClosed = false;
  const closed = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const call = (url, init = {}) => fetch(origin + url, { ...init,
    headers: { Origin: origin, ...init.headers } });
  const waitForClose = async () => {
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      if (!childClosed) {
        // Windows 的 child.kill() 直接终结服务，绕过 shutdown，会留下持有临时目录的硬件探针。
        // 先让隔离服务按生产退出路径回收自己登记的子进程；超时才强制终止。
        if (child.exitCode === null) {
          try {
            const response = await call('/api/quit', { method: 'POST', signal: AbortSignal.timeout(1000) });
            await response.arrayBuffer();
          } catch {}
        }
        if (!await waitForClose()) {
          child.kill('SIGKILL');
          if (!await waitForClose()) throw new Error('Isolated server did not close; temporary files retained');
        }
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return closePromise;
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
