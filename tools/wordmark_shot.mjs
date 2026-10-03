/* 逐词标记块位置验证: 起一个临时静态服务(只需 editor/ 目录), 用无头浏览器
 * 加载真实 timeline.js, 造一个含 words 的合并轨, 量"标记块"落在块的哪个位置, 并截图。
 * 跑法: node tools/wordmark_shot.mjs
 * 产出: outputs/wordmark-check.png + 退出码
 * 注: 必须走 http:// —— file:// 下浏览器会用 CORS 拦掉 ESM 动态导入。
 */
import { launch, sleep } from './lib/cdp.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const EDITOR = resolve(ROOT, 'editor');
const OUT = resolve(ROOT, 'outputs');
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = join(EDITOR, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(EDITOR)) { res.writeHead(403).end(); return; }
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = 'http://127.0.0.1:' + PORT;
console.log('临时静态服务:', BASE);

const b = await launch({ port: 9413, width: 1280, height: 820 });
try {
  await b.goto(BASE + '/index.html');
  await sleep(1500);

  /* 直接调 timeline 的绘制: 造一条合并轨(高 74) + 带 words 的块,
   * 画到一个独立 canvas 上, 再逐像素量标记块位置。
   * 走的是真实 _drawLanes → _drawBlockText → _drawWordAxis 全链路。 */
  const res = await b.eval(`(async () => {
    const { Timeline } = await import('./js/timeline.js');
    const cv = document.createElement('canvas');
    const W = 760, H = 74, LANE_GAP = 6;
    cv.width = W * 2; cv.height = H * 2;                 // 固定 2x, 免得 dpr 干扰量测
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    cv.id = 'probe';
    // 固定到视口左上角并抬高 z-index: 否则它被追加在页面最底部,
    // captureScreenshot 截的是视口, 根本看不到这块探针画布。
    cv.style.cssText = 'position:fixed;left:20px;top:20px;z-index:99999;' +
      'border:1px solid #333;background:#000;';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);

    const tl = Object.create(Timeline.prototype);
    tl.ctx = ctx; tl.canvas = cv; tl.accent = '#ff7a45';
    tl.lanes = [{ color: '#4fd1a5', label: '', merged: true, cues: [{
      start: 0, end: 8, text: 'gone', text2: '[xarasi] 你说它们',
      words: [
        { s: 0.2, w: 'They' }, { s: 1.1, w: 'are' }, { s: 2.0, w: 'just' },
        { s: 3.0, w: 'gone' }, { s: 4.2, w: 'now' },
      ],
    }]}];
    tl.duration = 10; tl.viewStart = 0; tl.pxPerSec = 90;
    tl.selected = null; tl.rangeSel = null; tl.reRecogRegion = null;
    tl._drag = null; tl._wordDrag = null; tl._selCueRef = null;
    tl.peaks = null; tl.waveform = null; tl.waveformReady = false;
    tl.showFilm = false; tl._viewReady = true;
    tl._cssW = () => W; tl._cssH = () => H;
    tl._filmH = () => 0;
    tl._laneTop = () => 0; tl._laneH = () => H;
    tl.follow = false;
    tl._drawLanes(ctx, W, 0);

    // 量测: 标记块是浅灰竖条(#8a8a95-ish), 中文是绿色, 词文本是浅色。
    // 逐行统计"既不是绿、也不是底色"的亮像素 → 标记+词文本行。
    const d = ctx.getImageData(0, 0, W * 2, H * 2).data;
    const rows = [];
    for (let y = 0; y < H * 2; y++) {
      let n = 0;
      for (let x = 0; x < W * 2; x += 2) {
        const i = (y * W * 2 + x) * 4;
        const r = d[i], g = d[i+1], bl = d[i+2], al = d[i+3];
        if (al < 40) continue;
        const lum = 0.299*r + 0.587*g + 0.114*bl;
        if (lum < 55) continue;                 // 底色/描边太暗
        if (g > r + 30) continue;               // 绿色=中文行, 排除
        n++;
      }
      if (n > 0) rows.push({ y: y / 2, n });
    }
    if (!rows.length) return { err: 'no rows' };
    const top = rows[0].y, bot = rows[rows.length-1].y;

    // 找块边框: 绿色描边所在行
    let borderY = -1;
    for (let y = 0; y < H*2; y++) {
      let n = 0;
      for (let x = 0; x < W*2; x += 2) {
        const i = (y*W*2+x)*4;
        const r=d[i], g=d[i+1], bl=d[i+2], al=d[i+3];
        if (al>40 && g > r + 20 && g > 60) n++;
      }
      if (n > W) { borderY = y/2; break; }      // 横贯整宽 = 上下边框
    }
    return {
      W, H, rowTop: top, rowBot: bot,
      rowH: +(bot - top + 1).toFixed(1),
      borderTop: borderY,
      // 逐词标记是竖条: 找"每列都有"的行(竖条贯穿) —— 用行内像素数的分布判断
      rowsSample: rows.filter((r,i)=>i%3===0).slice(0,14).map(r=>r.y),
    };
  })()`);

  console.log('\n=== 真实渲染量测(合并轨 H=74) ===');
  console.log(JSON.stringify(res, null, 2));

  // 独立复核几何真值(直接问 timeline 自己)
  const truth = await b.eval(`(async () => {
    const { Timeline } = await import('./js/timeline.js');
    const tl = Object.create(Timeline.prototype);
    const band = { y: 4, h: 66 };                 // bandOf(合并轨 laneH=74)
    const g = tl._wordGeom(band);
    return { band, g, markPct: +(((g.markTop+g.markBot)/2 - band.y)/band.h*100).toFixed(1),
             gapToBottom: (band.y+band.h) - g.markBot };
  })()`);
  console.log('\n=== _wordGeom 真值 ===');
  console.log(JSON.stringify(truth, null, 2));

  const checks = [
    ['标记中心在块下半部 (>70%)', truth.markPct > 70],
    ['标记底距块底 2.5px(贴底)', Math.abs(truth.gapToBottom - 2.5) < 0.01],
    ['标记高 = 20px(合并轨)', truth.g.markH === 20],
    ['标记宽 = 8px(拖动中 10)', truth.g.markW === 8 && truth.g.markWHot === 10],
    ['标记不越出块底', truth.g.markBot <= truth.band.y + truth.band.h],
    ['标记顶在块内', truth.g.markTop >= truth.band.y],
    ['标记高度为正(顶<底)', truth.g.markTop < truth.g.markBot],
    ['分隔线仍在中文行之下', truth.g.axisY >= truth.band.y + Math.round(truth.band.h*0.30)],
    ['分隔线不压标记行', truth.g.axisY <= truth.g.markTop],
  ];
  console.log('\n=== 断言 ===');
  let ok = true;
  for (const [n, p] of checks) { console.log((p?'  PASS  ':'  FAIL  ')+n); if(!p) ok=false; }

  await b.shot(resolve(OUT, 'wordmark-check.png'));
  console.log('\n截图 → outputs/wordmark-check.png');
  // 过滤无关噪声: 临时静态服务器没有 favicon/部分资源, 必然 404 —— 与被测代码无关。
  // 只把**脚本级**异常算失败(SyntaxError / ReferenceError / TypeError / Uncaught)。
  const logs = b.logs.filter(l => /SyntaxError|ReferenceError|TypeError|Uncaught|exception/i.test(l)
    && !/Failed to load resource/i.test(l));
  console.log('控制台异常:', logs.length ? logs.slice(0,5) : '无');
  process.exitCode = (ok && !logs.length) ? 0 : 1;
} catch (e) {
  console.error('探针失败:', e.message);
  process.exitCode = 1;
} finally {
  b.close();
  srv.close();
}
