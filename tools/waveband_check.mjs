/* 波形带集成验证: 加载真实 index.html + timeline.js, 造带波形的中英配对轨,
 * 调真实 draw(), 检查: 波形带/字幕轨不重叠、所有轨道都在面板内、波形有起伏。
 * 跑法: node tools/waveband_check.mjs
 * 产出: outputs/waveband-check.png + 退出码
 */
import { launch, sleep } from './lib/cdp.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = process.cwd();
const EDITOR = resolve(ROOT, 'editor');
const OUT = resolve(ROOT, 'outputs');
mkdirSync(OUT, { recursive: true });

/* 造一份真实的 peaks.bin(min/max 双通道), 用 Node 侧复现 server.js 的分桶+编码 */
const DUR = 30, RATE = 100, SR = 16000, PEAK_SR = 8000;
const phrases = [[0.6, 3.4], [4.2, 6.9], [7.6, 9.1], [10.4, 13.9], [14.6, 16.3], [17.1, 20.2],
  [21.0, 23.4], [24.1, 26.0], [26.8, 29.4]];
const N = DUR * RATE;
const lo = new Float32Array(N), hi = new Float32Array(N);
{
  const total = N, spb = DUR * PEAK_SR / total;
  let idx = 0, mn = 0, mx = 0, inB = 0, phase = 0;
  const spbSamples = spb;
  for (let i = 0; i < DUR * PEAK_SR; i++) {
    const t = i / PEAK_SR;
    let env = 0.01;
    for (const [a, b] of phrases) {
      if (t < a || t > b) continue;
      const u = (t - a) / (b - a);
      const gate = Math.min(1, u * 16) * Math.min(1, (1 - u) * 12);
      const syl = 0.4 + 0.6 * Math.abs(Math.sin(u * Math.PI * (b - a) * 5.2));
      env = Math.max(env, gate * syl * (0.72 + 0.28 * Math.sin(u * Math.PI * (b - a) * 1.9 + 0.7)));
    }
    const f0 = 128 + 36 * Math.sin(t * 1.6);
    phase += 2 * Math.PI * f0 / PEAK_SR;
    const v = (0.6 * Math.sin(phase) + 0.26 * Math.sin(phase * 2) + 0.13 * Math.sin(phase * 3)) * env * 0.3;
    if (v < mn) mn = v; if (v > mx) mx = v;
    if (++inB >= spbSamples && idx < total) { lo[idx] = mn; hi[idx] = mx; idx++; mn = 0; mx = 0; inB = 0; }
  }
  while (idx < total) { lo[idx] = mn; hi[idx] = mx; idx++; mn = 0; mx = 0; }
}
const abs = [];
for (let i = 0; i < N; i++) abs.push(Math.max(Math.abs(hi[i]), Math.abs(lo[i])));
const sorted = abs.slice().sort((a, b) => a - b);
const ref = sorted[Math.floor(sorted.length * 0.995)] || 1;
const k = 0.95 / ref;
const pbuf = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  pbuf[i * 2] = Math.max(0, Math.min(255, Math.round(128 + Math.max(-1, Math.min(1, lo[i] * k)) * 127)));
  pbuf[i * 2 + 1] = Math.max(0, Math.min(255, Math.round(128 + Math.max(-1, Math.min(1, hi[i] * k)) * 127)));
}
await writeFile(resolve(EDITOR, '_wb_peaks.bin'), pbuf);
console.log('peaks.bin:', pbuf.length, '字节, 桶数 =', N);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.bin': 'application/octet-stream', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  let f = null;
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    f = join(EDITOR, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  } catch {}
  if (!f || !f.startsWith(EDITOR)) { res.writeHead(404).end('nf'); return; }
  let buf = null;
  try { buf = await readFile(f); } catch {}
  if (!buf) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  res.end(buf);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

const b = await launch({ port: 9441, width: 1400, height: 900 });
try {
  await b.goto(BASE + '/index.html');

  await sleep(1200);

  const res = await b.eval(`(async () => {
    const { Timeline } = await import('./js/timeline.js');
    const DUR = ${DUR};
    const wrap = document.getElementById('tl-canvas-wrap');
    if (!wrap) return { err: '找不到 #tl-canvas-wrap' };
    wrap.style.height = '420px';                     // 给足空间
    const cv = document.getElementById('timeline');
    if (!cv) return { err: '找不到 #timeline' };
    const W = wrap.clientWidth, H = wrap.clientHeight;

    const tl = Object.create(Timeline.prototype);
    tl.ctx = cv.getContext('2d'); tl.canvas = cv;
    tl.peaks = { data: new Uint8Array(await (await fetch('_wb_peaks.bin')).arrayBuffer()), rate: 100, ch: 2 };
    tl._waveCache = null;
    tl.waveform = null; tl.waveformReady = false;
    tl.showFilm = false; tl.follow = false; tl._viewReady = true;
    tl.duration = DUR; tl.viewStart = 0; tl.pxPerSec = W / DUR;
    tl.selected = null; tl.rangeSel = null; tl.reRecogRegion = null;
    tl._drag = null; tl._wordDrag = null; tl._selCueRef = null; tl.accent = '#ff7a45';
    tl._cssW = () => W; tl._cssH = () => H;
    tl.lanes = [{ color: '#4fd1a5', label: '', merged: true, cues: [
      { start: 0.6, end: 3.4, text: 'gone', text2: '[xarasi] 你说它们',
        words: [{s:0.7,w:'They'},{s:1.3,w:'are'},{s:2.0,w:'just'},{s:2.6,w:'gone'}] },
      { start: 4.2, end: 6.9, text: 'stop', text2: '[xarasi] 他们垮台了',
        words: [{s:4.4,w:'They'},{s:5.1,w:'stop'}] },
    ]}];
    cv.width = W * 2; cv.height = H * 2;
    cv.getContext('2d').setTransform(2,0,0,2,0,0);
    tl.draw(0, false);
    // 影子画布: 把 tl 画到独立 canvas 上, 提到视口固定位置供截图。
    // (不能移动原 canvas —— 它依赖父容器尺寸, 移走后会拿到 0 宽高)
    const shot = document.createElement('canvas');
    shot.width = W * 2; shot.height = H * 2;
    shot.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483000;' +
      'width:' + W + 'px;height:' + H + 'px;border:1px solid #2a2a33;';
    document.documentElement.appendChild(shot);
    const sctx = shot.getContext('2d');
    sctx.setTransform(2,0,0,2,0,0);
    tl.ctx = sctx; tl.canvas = shot;
    tl._resize = () => {};                    // 别让 ResizeObserver 改回来
    tl.draw(0, false);

    const waveH = tl._waveH();
    const waveTop = tl._filmH() + 20 + 6;
    const lane0 = tl._laneTop(0);
    const lane0H = tl._laneH(0);
    const bottom = tl._lanesBottom();

    // 在波形带区域量墨迹
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0, minL = 255;
    const y0 = waveTop * 2, y1 = (waveTop + waveH) * 2;
    for (let y = y0; y < y1; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      if (d[i+3] < 40) continue;
      const l = 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
      if (l < minL) minL = l;
      if (l > 45) ink++;
    }
    return { W, H, waveH, waveTop, lane0, lane0H, bottom,
             waveBottom: waveTop + waveH, ink, minL: +minL.toFixed(1),
             fits: bottom <= H + 0.5,
             cssH: getComputedStyle(document.documentElement).getPropertyValue('--accent') };
  })()`);

  console.log('\n=== 布局集成量测 ===');
  console.log(JSON.stringify(res, null, 2));
  if (res.err) throw new Error(res.err);

  /* 布局已改为「字幕块半透明叠在波形上」(不再上下分离), 断言随之更新。
   * 依据: 用户给的参考图 —— 字幕块框内可见波形, 块间缝隙露出完整波形。*/
  const checks = [
    ['有波形数据时波形带存在 (h>0)', res.waveH > 0],
    ['波形带达到理想高度 (>=64px)', res.waveH >= 64],
    ['轨道与波形**同起点**(重叠, 非上下分离)', res.lane0 === res.waveTop],
    ['轨道覆盖整个波形带高度', res.lane0H >= res.waveH],
    ['轨道不溢出面板', res.fits],
    ['波形带画出了实质内容 (墨迹>2万)', res.ink > 20000],
  ];

  console.log('\n=== 断言 ===');
  let ok = true;
  for (const [nm, p] of checks) { console.log((p ? '  PASS  ' : '  FAIL  ') + nm); if (!p) ok = false; }

  await b.shot(resolve(OUT, 'waveband-check.png'));
  console.log('\n截图 → outputs/waveband-check.png');
  const errs = b.logs.filter((l) => /SyntaxError|Uncaught|ReferenceError|TypeError/i.test(l));
  console.log('页面异常:', errs.length ? errs.slice(0, 3) : '无');
  process.exitCode = (ok && !errs.length) ? 0 : 1;
} catch (e) {
  console.error('探针失败:', e.message);
  process.exitCode = 1;
} finally {
  b.close(); srv.close();
  try { unlinkSync(resolve(EDITOR, '_wb_peaks.bin')); } catch {}
}
