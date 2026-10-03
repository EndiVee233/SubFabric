/* 矮面板下的字幕块可见性截图验证: 复现用户报告的场景
 * (面板很矮 + 有波形 → 修复前字幕块整条消失), 并在旁边给出修复后的对照。
 * 跑法: node tools/lane_shot.mjs
 * 产出: outputs/lane-compare.png
 */
import { launch, sleep } from './lib/cdp.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = process.cwd();
const EDITOR = resolve(ROOT, 'editor');
const DUR = 30, RATE = 100, N = DUR * RATE;

/* 造一份真实 peaks.bin(min/max 双通道) */
const lo = new Float32Array(N), hi = new Float32Array(N);
{
  const phrases = [[0.6, 3.4], [4.2, 6.9], [7.6, 9.1], [10.4, 13.9], [14.6, 16.3], [17.1, 20.2], [21, 23.4], [24.1, 26], [26.8, 29.4]];
  const spb = 30 * 8000 / N;
  let idx = 0, mn = 0, mx = 0, inB = 0, phase = 0;
  for (let i = 0; i < 30 * 8000; i++) {
    const t = i / 8000;
    let env = 0.01;
    for (const [a, b] of phrases) {
      if (t < a || t > b) continue;
      const u = (t - a) / (b - a);
      env = Math.max(env, Math.min(1, u * 16) * Math.min(1, (1 - u) * 12)
        * (0.4 + 0.6 * Math.abs(Math.sin(u * Math.PI * (b - a) * 5.2)))
        * (0.72 + 0.28 * Math.sin(u * Math.PI * (b - a) * 1.9 + 0.7)));
    }
    const f0 = 128 + 36 * Math.sin(t * 1.6);
    phase += 2 * Math.PI * f0 / 8000;
    const v = (0.6 * Math.sin(phase) + 0.26 * Math.sin(phase * 2) + 0.13 * Math.sin(phase * 3)) * env * 0.3;
    if (v < mn) mn = v; if (v > mx) mx = v;
    if (++inB >= spb && idx < N) { lo[idx] = mn; hi[idx] = mx; idx++; mn = 0; mx = 0; inB = 0; }
  }
  while (idx < N) { lo[idx] = mn; hi[idx] = mx; idx++; mn = 0; mx = 0; }
}
const abs = []; for (let i = 0; i < N; i++) abs.push(Math.max(Math.abs(hi[i]), Math.abs(lo[i])));
const sorted = abs.slice().sort((a, b) => a - b);
const k = 0.95 / (sorted[Math.floor(sorted.length * 0.995)] || 1);
const pbuf = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  pbuf[i * 2] = Math.max(0, Math.min(255, Math.round(128 + Math.max(-1, Math.min(1, lo[i] * k)) * 127)));
  pbuf[i * 2 + 1] = Math.max(0, Math.min(255, Math.round(128 + Math.max(-1, Math.min(1, hi[i] * k)) * 127)));
}
await writeFile(resolve(EDITOR, '_lane_peaks.bin'), pbuf);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.bin': 'application/octet-stream' };
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

const b = await launch({ port: 9451, width: 1180, height: 760 });
try {
  await b.goto(BASE + '/index.html');
  await sleep(1200);

  /* 两种面板高度: 矮(100px, 修复前字幕块消失) 与 正常(300px) */
  const res = await b.eval(`(async () => {
    const { Timeline } = await import('./js/timeline.js');
    const DUR = ${DUR};
    const peaks = new Uint8Array(await (await fetch('_lane_peaks.bin')).arrayBuffer());
    const out = {};
    let slot = 0;
    for (const H of [100, 300]) {
      const W = 900;
      const cv = document.createElement('canvas');
      cv.width = W * 2; cv.height = H * 2;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:16px;top:' + (16 + slot * (H + 70)) +
        'px;z-index:2147483000;';
      document.documentElement.appendChild(wrap);
      wrap.appendChild(cv);
      // 原点在画布内偏移: draw() 假定 (0,0) 是面板左上角
      const ctx = cv.getContext('2d');
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#6d6d7a';
      ctx.font = '12px "Microsoft YaHei", sans-serif';
      ctx.fillText('面板高 ' + H + 'px', 6, -6);

      const tl = Object.create(Timeline.prototype);
      tl.ctx = ctx; tl.canvas = cv;
      Object.defineProperty(tl, '_cssH', { value: () => H });
      tl._cssW = () => W;
      tl.peaks = { data: peaks, rate: 100, ch: 2 };
      tl._waveCache = null;
      tl.waveform = null; tl.waveformReady = false;
      tl.showFilm = false; tl.follow = false; tl._viewReady = true;
      tl.duration = DUR; tl.viewStart = 0; tl.pxPerSec = W / DUR;
      tl.selected = null; tl.rangeSel = null; tl.reRecogRegion = null;
      tl._drag = null; tl._wordDrag = null; tl._selCueRef = null; tl.accent = '#ff7a45';
      tl.lanes = [{ color: '#4fd1a5', label: '', merged: true, cues: [
        { start: 0.6, end: 3.4, text: 'gone', text2: '[xarasi] 你说它们',
          words: [{s:0.7,w:'They'},{s:1.3,w:'are'},{s:2.0,w:'just'},{s:2.6,w:'gone'}] },
        { start: 4.2, end: 6.9, text: 'stop', text2: '[xarasi] 他们垮台了',
          words: [{s:4.4,w:'They'},{s:5.1,w:'stop'}] },
      ]}];
      cv.width = W * 2; cv.height = H * 2;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      tl.draw(0, false);

      // 在字幕轨区域量"字幕块像素": 块有绿色/青色描边, 与波形(灰)不同
      const laneTop = tl._laneTop(0), laneH = tl._laneH(0);
      const d = ctx.getImageData(0, 0, W * 2, H * 2).data;
      let cueInk = 0;
      for (let y = Math.max(0, laneTop * 2); y < Math.min(H * 2, (laneTop + laneH) * 2); y++) {
        for (let x = 0; x < W * 2; x += 2) {
          const i = (y * W * 2 + x) * 4;
          if (d[i + 3] < 100) continue;
          const r = d[i], g = d[i + 1], bl = d[i + 2];
          if (g > r + 25 && g > 90) cueInk++;       // 绿/青色 = 字幕块描边
        }
      }
      out['h' + H] = { waveH: tl._waveH(), laneTop, laneH, bottom: tl._lanesBottom(),
                       fits: tl._lanesBottom() <= H + 0.5, cueInk };
      slot++;
    }
    return out;
  })()`);

  console.log('\n=== 各面板高度下的实测 ===');
  for (const k of Object.keys(res)) {
    const r = res[k];
    console.log(`面板${k.slice(1)}px: 波高=${String(r.waveH).padStart(2)} 轨道顶=${String(r.laneTop).padStart(3)} ` +
      `轨高=${String(r.laneH).padStart(3)} 轨道底=${String(r.bottom).padStart(3)} ` +
      `在面板内=${r.fits ? '✓' : '✗'} 字幕块像素=${r.cueInk}`);
  }

  const checks = [
    ['矮面板(100px) 轨道不溢出', res.h100 && res.h100.fits],
    ['矮面板(100px) 字幕块真的画出来了(像素>500)', res.h100 && res.h100.cueInk > 500],
    ['正常面板(300px) 字幕块可见', res.h300 && res.h300.cueInk > 500],
    ['正常面板 波形带保持理想高度 64', res.h300 && res.h300.waveH === 64],
  ];
  console.log('\n=== 断言 ===');
  let ok = true;
  for (const [nm, p] of checks) { console.log((p ? '  PASS  ' : '  FAIL  ') + nm); if (!p) ok = false; }

  await b.shot(resolve(ROOT, 'outputs/lane-compare.png'));
  console.log('\n截图 → outputs/lane-compare.png');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('探针失败:', e.message);
  process.exitCode = 1;
} finally {
  b.close(); srv.close();
  try { unlinkSync(resolve(EDITOR, '_lane_peaks.bin')); } catch {}
}
