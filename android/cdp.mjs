import { execFileSync } from 'node:child_process';
const adb = process.env.SUBFABRIC_ADB || 'adb';
const device = process.env.SUBFABRIC_DEVICE || '127.0.0.1:58526';
export function shell(...args) { return execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim(); }
export async function connect() {
  const pid = shell('shell', 'pidof', 'com.subfabric.android');
  if (!/^\d+$/.test(pid)) throw new Error('Launch the prototype in WSA first');
  shell('forward', 'tcp:19325', `localabstract:webview_devtools_remote_${pid}`);
  const targets = await (await fetch('http://127.0.0.1:19325/json')).json();
  const target = targets.find(target => target.url === 'https://subfabric.local/');
  if (!target) throw new Error('No prototype WebView debugging target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const waiting = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); const request = waiting.get(message.id);
    if (request) { waiting.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { waiting.delete(key); reject(new Error(`${method} timed out`)); }, 180000);
      waiting.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  return { send, evaluate, close: () => { socket.close(); shell('forward', '--remove', 'tcp:19325'); } };
}

if (process.argv[2] === 'eval') {
  const client = await connect();
  try { console.log(JSON.stringify(await client.evaluate(process.argv[3]), null, 2)); } finally { client.close(); }
}
