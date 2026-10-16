import http from 'node:http';
export async function mockLlm(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const result = await handler(body, requests.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const content = result && result.__rawContent ? String(result.content || '') : JSON.stringify(result);
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(r => server.close(r)) };
}
export async function until(fn) {
  const deadline = Date.now() + 12000;
  for (;;) { const value = await fn(); if (value) return value;
    if (Date.now() > deadline) throw Error('Timed out waiting for task');
    await new Promise(r => setTimeout(r, 25)); }
}
