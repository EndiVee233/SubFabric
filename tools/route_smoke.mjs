/* 路由冒烟测试: 逐个敲 handleRequest 认识的所有 /api 路由, 断言「有响应、不 500、穿越被拦」。
 *
 * 用途: 给 server.js 的路由层重构(路由表拆分)兜底 —— 重构前后各跑一遍, 对比
 * 每个路由的「状态码 + 是否有响应」, 确认只是换了分发方式、没改行为。
 *
 * 跑法(两个终端):
 *   PORT=8399 node editor/server.js
 *   node tools/route_smoke.mjs
 *
 * 路径清单从 server.js 实际代码提取(grep "pathname === '/api"), 不手写, 避免漂移。
 * 不依赖真实项目数据: 无 projects/ 时各路由走各自的空态分支 —— 这本身就是要保持的行为。
 */
'use strict';
import http from 'http';
import net from 'node:net';

const PORT = Number(process.env.PORT || 8399);
const HOST = '127.0.0.1';

/* 无副作用的 GET 路由(不会改数据、不会起后台任务、不会拉起ffmpeg)。
 * POST 路由刻意不碰: 多数会写盘/起进程, 冒烟测试不该有副作用。 */
const ROUTES = [
  ['GET', '/'],
  ['GET', '/index.html'],
  ['GET', '/api/samples'],
  ['GET', '/api/version'],
  ['GET', '/api/fonts'],
  ['GET', '/api/font-file?name=Arial'],
  ['GET', '/favicon.ico'],
  ['GET', '/favicon.svg'],
  ['GET', '/api/waveform'],
  ['GET', '/api/peaks'],
  ['GET', '/api/projects'],
  ['GET', '/api/asr/status'],
  ['GET', '/api/asr/hint'],
  ['GET', '/api/fetch/settings'],
  ['GET', '/api/fetch/check-cookie'],
  ['GET', '/api/cast/config'],
  ['GET', '/api/diag'],
  /* 静态资源(经safeJoin) */
  ['GET', '/editor/index.html'],
  ['GET', '/editor/js/main.js'],
  ['GET', '/editor/css/style.css'],
  /* 目录穿越: 必须是 403/404, 绝不能 200 */
  ['GET', '/..%2f..%2fetc%2fhosts'],
  ['GET', '/../SubFabric-secret/secret.txt'],
  ['GET', '/editor/../../outside.txt'],
  /* 未知路由: 走静态回落, 不应是 500 */
  ['GET', '/no-such-path-xyz'],
];

function req(method, p) {
  return new Promise((resolve) => {
    const r = http.request({ host: HOST, port: PORT, method, path: p, timeout: 8000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, err: 'TIMEOUT(挂死)' }); });
    r.end();
  });
}

function waitPort(deadline = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(PORT, HOST);
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - t0 > deadline) reject(new Error('服务未启动'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

(async () => {
  try { await waitPort(); }
  catch { console.error(`✗ 127.0.0.1:${PORT} 无服务。先跑: PORT=${PORT} node editor/server.js`); process.exit(2); }

  const rows = [];
  for (const [m, p] of ROUTES) rows.push({ m, p, ...(await req(m, p)) });

  let bad = 0;
  console.log('方法 路径'.padEnd(48) + '状态  字节');
  console.log('-'.repeat(72));
  for (const r of rows) {
    const bad1 = [];
    if (r.status === 0 || r.status === -1) bad1.push('无响应/挂死');
    if (r.status === 500) bad1.push('★500');
    if (isTraversal(r.p) && r.status === 200) bad1.push('★穿越成功!');
    if (bad1.length) bad++;
    console.log(`${r.m} ${r.p}`.padEnd(48) + String(r.status).padEnd(6) + String(r.bytes).padEnd(6) + bad1.join(' '));
  }
  console.log('-'.repeat(72));
  console.log(bad ? `✗ ${bad}/${rows.length} 个路由异常` : `✓ ${rows.length} 个路由全部有响应, 无 500, 穿越被拦`);
  process.exit(bad ? 1 : 0);
})();

function isTraversal(p) {
  return /%2f/i.test(p) || p.includes('..');
}
