/* 波形绘制端到端验证: 起临时静态服务, 用无头浏览器加载**真实** timeline.js,
 * 把真实的 peaks 数据(server.js 新分桶产物)喂进去, 逐像素量"起伏度", 并截图。
 * 跑法: node tools/wave_verify.mjs
 * 产出: outputs/wave-verify.png + 退出码
 */
import { launch, sleep } from './lib/cdp.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = process.cwd();
const EDITOR = resolve(ROOT, 'editor');
const OUT = resolve(ROOT, 'outputs');
const TMP = resolve(ROOT, '_t');
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

/* ── 1. 在 Node 侧跑真实分桶, 产出 peaks.bin 供页面加载 ── */
const src = await readFile(resolve(EDITOR, 'server.js'), 'utf8');
const grab = (re, label) => {
  const m = src.match(re);
  if (!m) { console.error('抽取失败: ' + label); process.exit(1); }
  return m[0];
};
const mod = [
  grab(/const PEAK_SR = \d+;[\s\S]*?const PEAK_TARGET = [\d.]+;/, '常量'),
  grab(/function encodeEnvelope\(lo, hi, filled\) \{[\s\S]*?\n\}/, 'encodeEnvelope'),
  grab(/function attachPeakCollector\(readable, duration, rate, inSr\) \{[\s\S]*?\n\}/, 'attachPeakCollector'),
  'module.exports = { PEAK_SR, PEAK_VER, attachPeakCollector };',
].join('\n\n');
await writeFile(resolve(TMP, '_peaks_mod2.js'), mod);
const M = await import('file:///' + resolve(TMP, '_peaks_mod2.js').replace(/\\/g, '/'));

/* 造一段有起伏的音频(同 peaks_e2e 的素材特征) */
const DUR = 30, SR = 16000;
const pcmFull = Buffer.alloc(DUR * SR * 2);
{
  const phrases = [[0.6, 3.4], [4.2, 6.9], [7.6, 9.1], [10.4, 13.9], [14.6, 16.3], [17.1, 20.2],
    [21.0, 23.4], [24.1, 26.0], [26.8, 29.4]];
  let phase = 0;
  for (let i = 0; i < DUR * SR; i++) {
    const t = i / SR;
    let env = 0.008;
    for (const [a, b] of phrases) {
      if (t < a || t > b) continue;
      const u = (t - a) / (b - a);
      const gate = Math.min(1, u * 16) * Math.min(1, (1 - u) * 12);
      const syl = 0.4 + 0.6 * Math.abs(Math.sin(u * Math.PI * (b - a) * 5.2));
      env = Math.max(env, gate * syl * (0.72 + 0.28 * Math.sin(u * Math.PI * (b - a) * 1.9 + 0.7)));
    }
    const f0 = 128 + 36 * Math.sin(t * 1.6) - 20 * Math.sin(t * 0.55);
    phase += 2 * Math.PI * f0 / SR;
    const s0 = 0.6 * Math.sin(phase) + 0.26 * Math.sin(phase * 2) + 0.13 * Math.sin(phase * 3)
      + 0.06 * Math.sin(phase * 4.7) + 0.02 * (Math.random() * 2 - 1);
    pcmFull.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 * env * 0.30 * 32767))), i * 2);
  }
}
function resampleTo(b, from, to) {
  if (from === to) return b;
  const nOut = Math.floor(b.length / 2 * to / from), out = Buffer.alloc(nOut * 2), ratio = from / to;
  for (let i = 0; i < nOut; i++) {
    const x = i * ratio, i0 = Math.floor(x), fr = x - i0;
    const a = i0 * 2 < b.length ? b.readInt16LE(i0 * 2) : 0;
    const c = (i0 + 1) * 2 < b.length ? b.readInt16LE((i0 + 1) * 2) : a;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (c - a) * fr))), i * 2);
  }
  return out;
}
const { Readable } = await import('node:stream');
const pcm8 = resampleTo(pcmFull, SR, M.PEAK_SR);
const st = Readable.from([pcm8]);
const collect = M.attachPeakCollector(st, DUR, 100, M.PEAK_SR);
const peaksBuf = await new Promise((r) => st.on('end', () => r(collect(0, '').buf)));
await writeFile(resolve(TMP, 'peaks-new.bin'), peaksBuf);
await writeFile(resolve(EDITOR, '_peaks_new.bin'), peaksBuf);   // 文件名须与 render() 读取的一致
console.log('peaks.bin:', peaksBuf.length, '字节 (ch=2, ver=' + M.PEAK_VER + ')');

/* 旧格式对照: 单通道 abs 峰值 + 固定增益(用诊断里的老算法) */
const oldBuf = Buffer.alloc(Math.floor(DUR * 100));
{
  const total = 20000, spb = DUR * M.PEAK_SR / total;
  let peak = 0, inB = 0, i = 0;
  const push = () => { if (i < oldBuf.length) oldBuf[i++] = Math.min(255, Math.round(255 * Math.sqrt(Math.min(1, (peak / 32768) * 7.943)))); peak = 0; inB = 0; };
  for (let k = 0; k < pcm8.length; k += 2) {
    const a = Math.abs(pcm8.readInt16LE(k));
    if (a > peak) peak = a;
    if (++inB >= spb) push();
  }
  while (i < oldBuf.length) push();
}
await writeFile(resolve(EDITOR, '_peaks_old.bin'), oldBuf);

/* ── 2. 静态服务 ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.bin': 'application/octet-stream' };
const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const f = join(EDITOR, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(EDITOR)) { res.writeHead(403).end(); return; }
    const buf = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

/* ── 3. 页面里真实渲染 + 量测 ── */
const b = await launch({ port: 9421, width: 1280, height: 900 });
try {
  await b.goto(BASE + '/index.html');
  await sleep(1200);

  const res = await b.eval(`(async () => {
    const DUR = ${DUR};   // Node 侧的素材时长, 注入页面
    let slot = 0;          // 局部计数器: 用 out.__n 会拿到 undefined→NaN→cssText 整条失效
    const { Timeline } = await import('./js/timeline.js');
    const W = 560, H = 150, WAVE_H = 120;
    const out = {};

    async function render(binUrl, ch, label) {
      const raw = new Uint8Array(await (await fetch(binUrl)).arrayBuffer());
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:' + (16 + slot * (W + 16)) + 'px;top:16px' +
        ';z-index:2147483000;width:' + W + 'px;height:' + H + 'px;';
      document.documentElement.appendChild(holder);
      let envNonZero = -1;
      const cv = document.createElement('canvas');
      cv.width = W * 2; cv.height = H * 2;
      // 不设 CSS width/height —— 让 canvas 保持 1:1 物理像素, 避免任何缩放导致的量测错位
      cv.style.cssText = 'display:block;width:' + (W*2) + 'px;height:' + (H*2) + 'px;';
      holder.appendChild(cv);
      const ctx = cv.getContext('2d');
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, W, H);

      const tl = Object.create(Timeline.prototype);
      tl.ctx = ctx; tl.canvas = cv; tl.peaks = { data: raw, rate: 100, ch };
      const _dbg = { rawLen: raw.length, ch, n: ch===1?raw.length:(raw.length>>1), firstBytes: Array.from(raw.slice(0,4)) };
      tl._waveCache = null;
      tl.duration = DUR; tl.viewStart = 0; tl.pxPerSec = W / DUR;
      tl.waveform = null; tl.waveformReady = false;
      tl._cssW = () => W;
      tl._drawWaveLayer(ctx, W, 10, WAVE_H);

      // 回报 _waveEnvelope 自身算出的有声列, 与渲染结果对照 → 区分"算法错"还是"画错"
      const _e = tl._waveEnvelope(W);
      let _nz = 0; for (let i=0;i<W;i++) if (Math.abs(_e.env[i*2])>0.01||Math.abs(_e.env[i*2+1])>0.01) _nz++;
      envNonZero = _nz;

      /* 量测: 逐列找"最亮像素"作为波形边缘, 而不是拿固定亮度阈值。
       * 教训: 渐变填充在黑底上的实际亮度只有 ~160, 用 lum<40 当"底色判据"虽然能过,
       * 但若填充色再暗一点就会把整片波形误杀成"只有 2 列有声"。*/
      /* 坐标: 绘制在 setTransform(2,0,0,2) 下用逻辑坐标, getImageData 返回**物理**像素。
       * 所以量测一律用物理坐标: topPx = 10*2, cyPx = (10+WAVE_H/2)*2, x 走 0..PW-1。
       * (之前误用 W*2 作宽、CSS 缩放后又按逻辑坐标算 cy, 导致整块量测错位 → 误判"几乎空白") */
      const PW = cv.width, PH = cv.height;
      const d = ctx.getImageData(0, 0, PW, PH).data;
      const top = 10 * 2, hPx = WAVE_H * 2, cy = (10 + WAVE_H / 2) * 2;
      // 背景亮度基准: 取该画布的众数亮度附近的最小值(底色)
      let minLum = 255;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i+3] < 40) continue;
        const l = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        if (l < minLum) minLum = l;
      }
      const thr = minLum + 18;   // 相对底色的相对阈值, 不写死绝对亮度
      const halves = [];
      const upDn = [];
      for (let x = 0; x < PW; x++) {
        let up = 0, dn = 0;
        for (let y = top; y < top + hPx; y++) {
          const i = (y * PW + x) * 4;
          if (d[i+3] < 40) continue;
          const l = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
          if (l < thr) continue;
          if (y < cy) up = Math.max(up, cy - y); else dn = Math.max(dn, y - cy);
        }
        halves.push(Math.max(up, dn));
        upDn.push([up, dn]);
      }
      const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
      const meanH = mean(halves);
      const voiced = halves.filter(v => v > meanH * 0.15 + 1);
      const vs = voiced.slice().sort((a,b)=>a-b);
      const q = p => vs.length ? vs[Math.min(vs.length-1, Math.floor(vs.length*p))] : 0;
      const med = q(0.5);
      // 上下不对称度: |up-dn| / (up+dn) —— 真实波形应显著>0, 对称条形图≈0
      let asym = 0, an = 0;
      for (const [up, dn] of upDn) {
        if (up + dn > 6) { asym += Math.abs(up - dn) / (up + dn); an++; }
      }
      out[label] = {
        cvW: cv.width, cvH: cv.height, cssW: cv.clientWidth, cssH: cv.clientHeight,
        minLum: +minLum.toFixed(1), thr: +thr.toFixed(1),
        inkPixels: (()=>{let n=0;for(let i=0;i<d.length;i+=4){if(d[i+3]<40)continue;
          const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];if(l>thr)n++;}return n;})(),
        envNonZero, _dbg,
        colHist: (()=>{ // 每 100 列(物理)统计一次墨迹数, 定位像素到底分布在哪
          const h=[]; for(let c=0;c<10;c++){let n=0;
            for(let x=c*PW/10;x<(c+1)*PW/10;x++){for(let y=top;y<top+hPx;y++){
              const i=(y*PW+x)*4; if(d[i+3]<40)continue;
              const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; if(l>thr)n++;}}
            h.push(n);} return h;})(),
        // 音节间隙: 半高 < 中位 25% 且连续 ≥3 像素的区段数(实心带没有间隙)
        gaps: (()=>{ const m=halves.slice().sort((a,b)=>a-b); const med=m[m.length>>1]||1;
          let n=0,run=0; for(const v of halves){ if(v<med*0.25){run++; if(run===3)n++;} else run=0; } return n; })(),
        // 边缘锐度: 相邻列半高的平均跳变(实心带=平顶, 跳变小)
        edge: (()=>{ let s=0,n=0; for(let i=1;i<halves.length;i++){ s+=Math.abs(halves[i]-halves[i-1]); n++; } return n? +(s/n).toFixed(2):0; })(),
        voicedCols: voiced.length,
        medHalf: +(med/2).toFixed(1),
        v10: +(q(0.1)/2).toFixed(1), v90: +(q(0.9)/2).toFixed(1),
        relVar: med>0 ? +(((q(0.9)-q(0.1))/med)).toFixed(3) : 0,   // 有声段起伏
        asym: an ? +(asym/an).toFixed(3) : 0,                        // 上下不对称度
        peakUse: +(Math.max(...halves)/ (hPx/2) *100).toFixed(0),    // 纵向利用率%
      };
      slot++;
    }

    await render('_peaks_old.bin', 1, 'old');
    await render('_peaks_new.bin', 2, 'new');

    return out;
  })()`);

  console.log('\n=== 真实渲染量测(WAVE_H=100px) ===');
  for (const k of ['old', 'new']) {
    const r = res[k];
    if (!r) { console.log(k, '缺失'); continue; }
    console.log(`  rawLen=${r._dbg.rawLen} ch=${r._dbg.ch} n=${r._dbg.n} 首字节=${JSON.stringify(r._dbg.firstBytes)} → env有声列=${r.envNonZero} 墨迹=${r.inkPixels}`);
    console.log(`${k === 'old' ? '旧(单通道+固定增益)' : '新(min/max+自适应)'}: ` +
      `有声列=${r.voicedCols} 半高中位=${r.medHalf}px p10=${r.v10} p90=${r.v90} ` +
      `起伏=${r.relVar} 不对称=${r.asym} 纵向利用=${r.peakUse}% 音节间隙=${r.gaps} 边缘锐度=${r.edge}`);
  }

  const o = res.old, n = res.new;
  /* 判据说明（都基于"实心带 vs 有起伏"这个可判定的形态差异）:
   *  - 核心指标: 旧实心带的有声段起伏被削到接近 0, 新实现应显著更高
   *  - 静音段占比: 实心带没有"音节间留白", 新实现应能数出明显的间隙
   *  - 纵向利用率: 旧实现几乎顶满(98%, 全是噪声), 新实现应留出余量
   *  - 上下不对称: 取决于素材。本探针素材是恒定响度合成音, min/max 天然接近对称,
   *    所以只做"新实现不低于旧实现"的弱断言, 真正的形态验证靠截图肉眼确认。 */
  /* 判据（挑真正能区分"实心带"与"有起伏"的指标）:
   *  - gaps  音节间隙数: 实心带被削平 → 找不到低振幅区段; 有起伏 → 音节间有明显停顿
   *  - edge  边缘锐度: 相邻列半高的平均跳变。实心带是平顶(跳变小), 真波形跳变大
   *  这两个比"相对离散度"更可靠 —— 后者会被"整体顶满"拉高/压低, 容易误判。 */
  const checks = [
    ['新实现有音节间隙(旧实现几乎没有)', n && o && n.gaps > o.gaps],
    ['新实现边缘更锐(起伏真实)', n && o && n.edge > o.edge],
    /* 纵向利用率: 新实现应与旧实现相当(都接近满幅)。曾把它写成"必须 <96%",
       但那假设错了 —— 修复的目标正是让波形**长满**画布(旧实现的问题是"长满但平",
       新实现是"长满且有起伏")。所以只断言"不低于旧的 90%"。*/
    ['新实现纵向利用率不低于旧实现', n && o && n.peakUse > o.peakUse * 0.9],
    ['新实现渲染出实质墨迹(>5万)', n && n.inkPixels > 50000],
    ['新实现有声列数合理(>W 的 50%)', n && n.voicedCols > 560 * 0.5],
    ['旧实现被削平成实心带(gaps 极少)', o && o.gaps <= 2],
  ];

  console.log('\n=== 断言 ===');
  let ok = true;
  for (const [nm, p] of checks) { console.log((p ? '  PASS  ' : '  FAIL  ') + nm); if (!p) ok = false; }

  await b.shot(resolve(OUT, 'wave-verify.png'));
  console.log('\n截图 → outputs/wave-verify.png');
  const errs = b.logs.filter((l) => /SyntaxError|Uncaught|ReferenceError|TypeError/i.test(l));
  console.log('页面异常:', errs.length ? errs.slice(0, 3) : '无');
  process.exitCode = (ok && !errs.length) ? 0 : 1;
} catch (e) {
  console.error('探针失败:', e.message);
  process.exitCode = 1;
} finally {
  b.close(); srv.close();
  for (const f of ['_peaks_new.bin', '_peaks_old.bin']) {
    try { (await import('node:fs')).unlinkSync(resolve(EDITOR, f)); } catch {}
  }
}
