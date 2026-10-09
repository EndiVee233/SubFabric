/* HTTP 层探针: 面向「跨请求状态 + 状态机」的接口行为锁, 给 handleRequest 拆分兜底。
 *
 * 与 route_smoke.mjs 的分工: 那个只验「有响应/不 500/穿越被拦」的冒烟网, 且刻意不碰 POST;
 * 这个自起服务实例, 真建项目走完整生命周期(创建→改名→字幕读写→prepare→peaks/audio→删除),
 * 并锁定守卫(Host/Origin/穿越/media 白名单)与响应形状(apiKey 不外泄等)。
 *
 * 跑法(单终端, 自带服务启停):
 *   node tools/http_layer_probe.mjs
 *
 * 副作用管理:
 *   - 探针项目建在 projects/ 下, 结束时 DELETE + fs.rm 双保险清理;
 *   - 动过 asr/settings.json 的用例先备份、finally 还原;
 *   - /api/pick /api/translate/test /api/quit(真退出) 刻意不碰: 前者拉系统对话框,
 *     后两者分别是外呼 LLM 与杀服务 —— 只测它们的守卫分支。
 */
'use strict';
import http from 'http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PROBE_PORT || 8413);
const ORIGIN = `http://${HOST}:${PORT}`;

let checks = 0, bad = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else { bad++; console.log(`  ✗ ${label}${detail ? ' —— ' + detail : ''}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

/* ── HTTP 客户端 ── */
function call(method, p, { headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: HOST, port: PORT, method, path: p, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json,
                  text: buf.toString('utf8') });
      });
    });
    r.on('error', (e) => resolve({ status: 0, err: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, err: 'TIMEOUT(挂死)' }); });
    if (body != null) r.write(body);
    r.end();
  });
}
const j = (o) => Buffer.from(JSON.stringify(o), 'utf8');
function waitPort(deadline = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const once = () => {
      const s = net.connect(PORT, HOST);
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => { s.destroy(); Date.now() - t0 > deadline ? reject(new Error('服务未启动')) : setTimeout(once, 200); });
    };
    once();
  });
}
async function until(fn, deadlineMs, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

/* ── 服务进程 ── */
const server = spawn(process.execPath, [path.join(ROOT, 'editor', 'server.js')],
  { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
// 副作用还原登记: settings.json 备份 + 探针自己建的项目目录(只删自己的, 绝不动 projects/ 下其他用户数据)
const SETTINGS = path.join(ROOT, 'asr', 'settings.json');
const settingsBackup = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS) : null;
let probeProjectDir = null;
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

/* ── ffmpeg 探测(与 server.js resolveTool 同一候选序) ── */
function findFfmpeg() {
  const cand = [process.env.FFMPEG_PATH,
    'D:/Program Files/ffmpeg/bin/ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe'].filter(Boolean);
  for (const c of cand) { try { if (fs.existsSync(c)) return c; } catch {} }
  const w = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout) return w.stdout.trim().split(/\r?\n/)[0];
  return null;
}

(async () => {
  try { await waitPort(); } catch {
    console.error('✗ 探针服务未就绪:\n' + serverLog.slice(-2000));
    server.kill(); process.exit(2);
  }

  /* ═══ A. 守卫层 ═══ */
  section('A. 守卫(Host/Origin/穿越/白名单)');
  let r = await call('GET', '/api/version', { headers: { Host: 'evil.com' } });
  ok(r.status === 403, '伪造 Host 被拒', `status=${r.status}`);

  r = await call('POST', '/api/lifecycle', { headers: { Origin: 'https://evil.com' }, body: j({}) });
  ok(r.status === 403, '跨源 POST 被拒', `status=${r.status}`);

  r = await call('POST', '/api/quit', { headers: { Origin: 'https://evil.com' }, body: j({}) });
  ok(r.status === 403, '/api/quit 跨源被拒(不真退)', `status=${r.status}`);
  r = await call('GET', '/api/version');
  ok(r.status === 200, '守卫误伤检查: 正常请求仍通', `status=${r.status}`);

  r = await call('GET', '/..%2f..%2fetc%2fhosts');
  ok(r.status === 403 || r.status === 404, '编码穿越被拦', `status=${r.status}`);
  r = await call('GET', '/%zz');
  ok(r.status !== 500 && r.status !== 0 && r.status !== -1, '非法百分号编码不 500 不挂死', `status=${r.status}`);
  r = await call('GET', '/editor/../../outside.txt');
  ok(r.status === 403 || r.status === 404, '明文穿越被拦', `status=${r.status}`);

  r = await call('GET', '/api/media?path=' + encodeURIComponent(path.join(ROOT, 'editor', 'server.js')));
  ok(r.status === 403, '/api/media 未登记路径被拒', `status=${r.status}`);
  r = await call('GET', '/api/media');
  ok(r.status !== 200, '/api/media 缺参数不 200', `status=${r.status}`);

  /* ═══ B. 只读端点形状 ═══ */
  section('B. 只读端点形状');
  const src = fs.readFileSync(path.join(ROOT, 'editor', 'server.js'), 'utf8');
  const APP_VERSION = (/@?APP_VERSION\s*=\s*'([^']+)'/.exec(src) || [])[1] || '';
  r = await call('GET', '/api/version');
  ok(r.status === 200 && r.json && r.json.version === APP_VERSION,
    '/api/version 与 APP_VERSION 一致', JSON.stringify(r.json).slice(0, 80));

  r = await call('GET', '/api/samples');
  ok(r.status === 200 && r.json && Array.isArray(r.json.videos) && Array.isArray(r.json.subs),
    '/api/samples 返回 videos/subs 数组');

  r = await call('GET', '/api/translate/config');
  ok(r.status === 200 && r.json && !('apiKey' in r.json),
    '/api/translate/config 不回传 apiKey', JSON.stringify(r.json || {}).slice(0, 100));
  r = await call('GET', '/api/cast/config');
  ok(r.status === 200 && r.json && !('apiKey' in r.json), '/api/cast/config 不回传 apiKey');

  r = await call('GET', '/api/fetch/settings');
  ok(r.status === 200 && r.json && typeof r.json.hasBiliCookie === 'boolean'
     && typeof r.json.biliCookieEnc === 'boolean' && Array.isArray(r.json.biliCookieKeys),
    '/api/fetch/settings 只回「有没有」, 不回值');
  ok(r.json && !('biliCookie' in r.json) && !('proxy' in r.json && typeof r.json.proxy !== 'string'),
    'settings 视图无明文 Cookie 字段');

  r = await call('GET', '/api/asr/status');
  ok(r.status === 200 && r.json && Array.isArray(r.json.models) && r.json.models.length > 0
     && typeof r.json.pythonOk === 'boolean', '/api/asr/status 结构完整',
    r.status === 200 ? '' : `status=${r.status}`);

  r = await call('GET', '/api/asr/hint');
  ok(r.status === 200, '/api/asr/hint 200', `status=${r.status}`);
  { // lifecycle 与 logs 一样是 SSE 长连接: 只验响应头
    const sse = await new Promise((resolve) => {
      const rq = http.request({ host: HOST, port: PORT, path: '/api/lifecycle', timeout: 6000 }, (res) => {
        resolve({ status: res.statusCode, ct: String(res.headers['content-type'] || '') });
        rq.destroy();
      });
      rq.on('error', () => resolve({ status: 0, ct: '' }));
      rq.end();
    });
    ok(sse.status === 200 && sse.ct.includes('text/event-stream'),
      '/api/lifecycle 是 SSE', `status=${sse.status} ct=${sse.ct}`);
  }
  r = await call('POST', '/api/logs/client', { body: j({ level: 'info', msg: 'http_layer_probe 打点' }) });
  ok(r.status === 200, '/api/logs/client 200', `status=${r.status}`);
  r = await call('POST', '/api/diag', { body: j({}) });
  ok(r.status === 200 && r.buf.length > 0, '/api/diag 200 且有正文', `status=${r.status}`);

  { // SSE 头部形状(读完头就断, 不消费流)
    const sse = await new Promise((resolve) => {
      const rq = http.request({ host: HOST, port: PORT, path: '/api/logs/stream', timeout: 6000 }, (res) => {
        resolve({ status: res.statusCode, ct: String(res.headers['content-type'] || '') });
        rq.destroy();
      });
      rq.on('error', () => resolve({ status: 0, ct: '' }));
      rq.end();
    });
    ok(sse.status === 200 && sse.ct.includes('text/event-stream'),
      '/api/logs/stream 是 SSE', `status=${sse.status} ct=${sse.ct}`);
  }

  /* ═══ C. fetch 设置写读回(动 settings.json, 开头已备份) ═══ */
  section('C. fetch 设置 POST→GET 往返');
  r = await call('POST', '/api/fetch/settings', { body: j({ proxy: ' 127.0.0.1:9 ' }) });
  ok(r.status === 200, 'POST fetch/settings 200', `status=${r.status} ${r.text.slice(0, 80)}`);
  r = await call('GET', '/api/fetch/settings');
  ok(r.json && r.json.proxy === '127.0.0.1:9', 'proxy 保存时去除首尾空白', JSON.stringify(r.json && r.json.proxy));

  /* ═══ D. 项目生命周期(要 ffmpeg) ═══ */
  section('D. 项目生命周期');
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.log('  ! 未找到 ffmpeg, 项目生命周期用例跳过(守卫/形状用例不受影响)');
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-http-probe-'));
    const vp = path.join(tmpDir, 'probe.mp4');
    // testsrc 只有视频轨 —— prepare 要提取音频, 必须带一条 sine 音轨, 否则 ffmpeg 抽音轨直接失败
    const g = spawnSync(ffmpeg, ['-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', vp],
      { encoding: 'utf8', timeout: 60000 });
    if (g.status !== 0 || !fs.existsSync(vp)) {
      console.log('  ! 测试视频生成失败, 项目生命周期用例跳过');
    } else {
      const srtText = '1\n00:00:00,000 --> 00:00:01,000\nhttp-probe-marker\n';
      let pid = null;
      try {
        r = await call('POST', '/api/projects', { timeout: 30000,
          body: j({ name: 'http层探针', video: { path: vp }, subtitle: { name: 'probe.srt', text: srtText } }) });
        ok(r.status === 200 && /^[A-Za-z0-9_-]{1,64}$/.test(r.json.id || ''),
          '创建项目(SRT+无初稿)', `status=${r.status} ${r.text.slice(0, 120)}`);
        pid = (r.json || {}).id;
        if (pid) probeProjectDir = path.join(ROOT, 'projects', pid);

        if (pid) {
          r = await call('GET', '/api/projects');
          ok(r.json && r.json.projects.some(p => p.id === pid), '项目出现在列表');

          r = await call('GET', '/api/projects/' + pid);
          ok(r.status === 200 && r.json && r.json.videoExists === true, '项目详情 videoExists=true');

          r = await call('PUT', '/api/projects/' + pid + '/info', { body: j({ name: '改名后的项目' }) });
          ok(r.status === 200 && r.json && r.json.ok === true, 'PUT info 改名');
          r = await call('GET', '/api/projects/' + pid);
          ok(r.json && r.json.name === '改名后的项目', '改名落库');

          r = await call('GET', '/api/projects/' + pid + '/subtitle');
          ok(r.status === 200 && r.text.includes('http-probe-marker'), 'GET subtitle 原文可读');

          r = await call('PUT', '/api/projects/' + pid + '/subtitle',
            { body: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nrewritten-marker\n', 'utf8') });
          ok(r.status === 200 && r.json && r.json.ok === true, 'PUT subtitle 覆写');
          r = await call('GET', '/api/projects/' + pid + '/subtitle');
          ok(r.text.includes('rewritten-marker'), '覆写后可读回');

          r = await call('GET', '/api/projects/' + pid + '/draft');
          ok(r.status === 200, 'GET draft(无初稿) 200', `status=${r.status}`);
          r = await call('GET', '/api/projects/' + pid + '/rerecognize');
          ok(r.status === 200, 'GET rerecognize 200', `status=${r.status}`);

          r = await call('POST', '/api/projects/' + pid + '/relink', { body: j({ videoPath: vp }) });
          ok(r.status === 200 && r.json && r.json.videoExists === true, 'POST relink 同路径重连');

          const peaksReady = await until(async () => {
            const x = await call('GET', '/api/projects/' + pid + '/peaks');
            return x.status === 200 ? x : null;
          }, 30000);
          ok(!!peaksReady, 'prepare 产出 peaks(轮询≤30s)');
          ok(peaksReady && String(peaksReady.headers['content-type'] || '').includes('octet-stream'),
            'peaks 是二进制流');
          r = await call('GET', '/api/projects/' + pid + '/audio');
          // .wav 不在 MIME 表 → application/octet-stream 是既有行为(前端按数组缓冲播放), 只锁状态与正文
          ok(r.status === 200 && r.buf.length > 0, 'prepare 产出 audio.wav', `status=${r.status} bytes=${r.buf.length}`);

          r = await call('POST', '/api/projects/' + pid + '/prepare', { body: j({}) });
          ok(r.status === 200, 'prepare 兜底(已就绪)直接 200', `status=${r.status}`);

          r = await call('POST', '/api/projects/' + pid + '/prepare',
            { body: j({ force: true, mode: 'denoise' }), timeout: 30000 });
          ok(r.status === 200, 'prepare force+denoise 受理', `status=${r.status}`);
          const done = await until(async () => {
            const x = await call('GET', '/api/projects/' + pid);
            const st = x.json && x.json.prepare && x.json.prepare.status;
            return st && st !== 'running' ? st : null;
          }, 45000);
          ok(done === 'done', 'denoise 重提取完成无错', `终态=${done === null ? '超时' : done}`);

          r = await call('POST', '/api/projects/' + pid + '/retry', { body: j({}) });
          ok(r.status === 400, '无初稿项目 retry 被拒(400)', `status=${r.status}`);

          r = await call('DELETE', '/api/projects/' + pid);
          ok(r.status === 200, 'DELETE 项目');
          r = await call('GET', '/api/projects/' + pid);
          ok(r.status === 404, '删后 404');
          pid = null;   // 已删, finally 不再重复清理
        }

        r = await call('POST', '/api/projects', { body: j({ name: '坏路径', video: { path: 'D:/不存在/xx.mp4' } }) });
        ok(r.status === 400, '创建时视频不存在被拒(400)', `status=${r.status}`);
        r = await call('GET', '/api/projects/p-no-such-project');
        ok(r.status === 404 && r.json && r.json.error === '项目不存在', '未知项目 404');
      } finally {
        if (pid) { try { await call('DELETE', '/api/projects/' + pid); } catch {} }
        if (probeProjectDir) { try { fs.rmSync(probeProjectDir, { recursive: true, force: true }); } catch {} }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
})().catch((e) => { bad++; console.log('  ✗ 探针自身异常: ' + ((e && e.stack) || e)); })
.finally(() => {
  // 还原 settings.json(用例 C 动过)
  try {
    if (settingsBackup != null) fs.writeFileSync(SETTINGS, settingsBackup);
    else if (fs.existsSync(SETTINGS)) fs.unlinkSync(SETTINGS);
  } catch {}
  server.kill();
  setTimeout(() => {
    console.log(`\n${bad ? `✗ ${bad}/${checks} 项失败` : `✓ ${checks} 项全部通过`}`);
    process.exit(bad ? 1 : 0);
  }, 300);
});
