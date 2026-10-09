/* 视频区就地编辑（单击字幕 → 就地改那一段；双击字幕 → 整行弹窗）端到端验证 · **ASS 路径**。
 * 跑法: node tools/videoedit_probe.mjs
 * 产出: outputs/videoedit-*.png + 控制台断言
 *
 * 为什么要有像素校验：
 *   ASS 字幕是 libass 画在 canvas 上的，**没有按行的 DOM**。
 *   如果只用"程序自己算的坐标"去点、再拿"程序自己算的坐标"判断命中，那是自证 —— 估歪了测试也照样过。
 *   所以这里截图后自带 PNG 解码（zlib.inflateSync，不依赖 ffmpeg/第三方库），扫出字幕文字带的真实像素位置，
 *   再和程序给的位置对比；"点第 2 段"用的 x 也是从像素里量出来的段间空格位置，不是程序算的。
 * SRT 路径见 tools/videoedit_srt_probe.mjs（那边 DOM 即真值，不需要截图）。
 */
import { createRequire } from 'node:module';
import { launch, sleep } from './lib/cdp.mjs';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'outputs');
const TMP = resolve(ROOT, 'tmp-test');
const BASE = 'http://127.0.0.1:8321';
const { AssDoc } = require_(resolve(ROOT, 'editor/js/ass.js'));
const { buildWordSpecs } = require_(resolve(ROOT, 'editor/js/karaoke.js'));

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};

/* ── 1. 夹具: 视频 + 中英双语 ASS（结构与真实稿件一致: 中文整句 + 英文逐词切片） ── */
const VIDEO = resolve(TMP, 'sample.mp4');
if (!existsSync(VIDEO)) {
  console.error('缺测试视频 ' + VIDEO + '\n用 ffmpeg 生成一个即可:\n'
    + '  ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=10:duration=12" -pix_fmt yuv420p -c:v libx264 ' + VIDEO);
  process.exit(1);
}
const ZH1 = '一路打到决赛 才有机会击败Flame';
const ZH2 = '他亲手封禁了我们服务器的几百名玩家 自己却从未接近过死亡';

const ASS_HEAD = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,20,20,120,1
Style: 中文字幕,Noto Sans CJK SC,64,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,20,20,125,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.10,0:00:00.20,Default,,0,0,0,,seed
Dialogue: 0,0:00:00.10,0:00:00.20,中文字幕,,0,0,0,,种子
`;

/** 造一份 n 行的中英双语 ASS（中文整句 + 英文逐词切片，与真实稿件同一套结构） */
function buildAss(rows) {
  const doc = new AssDoc(ASS_HEAD);
  const row = (zhText, enText, start, end) => {
    let ev = doc.sorted.filter(e => e.style === '中文字幕').pop();
    ev = doc.insertAfterEvent(ev);
    doc.setEventTime(ev, start, end);
    doc.setEventText(ev, zhText);
    let enEv = doc.sorted.filter(e => e.style === 'Default').pop();
    enEv = doc.insertAfterEvent(enEv);
    doc.setEventTime(enEv, start, end);
    doc.setEventText(enEv, enText);
    const tokens = enText.split(/\s+/);
    const span = (end - start) / tokens.length;
    const sent = {
      style: 'Default', start, end, text: enText, events: [enEv],
      words: tokens.map((w, i) => ({ w, s: start + span * i, e: start + span * (i + 1) })),
      proto: { layer: '0', name: '', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } },
      highlightTag: '{\\c&H00FF00&}'
    };
    doc.replaceEvents([enEv], buildWordSpecs(sent));
  };
  for (const r of rows) row(...r);
  return doc.serialize();
}
// 中文行带行首角色标签 + **行内第二个色标**（验证"仅替换"不会把行内标签/其它片段弄丢）
const ASS_TEXT = buildAss([
  ['[Wemmbu] 一路打到决赛 {\\c&H7F00FF&}才有机会击败Flame',
    'battling my way to the finale to even have a chance at defeating Flame.', 1, 6],
  [ZH2, "He's personally banned hundreds of players off our server, without even coming close to death himself once.", 6.5, 11],
]);
writeFileSync(resolve(TMP, 'sample.ass'), ASS_TEXT, 'utf8');

/* 阶段 2 用：**两行时间重叠**（时间轴上 Shift 拖块就允许重叠）→ 画面上同时出现 4 条线。
 * 四行的文本长度刻意各不相同：这样"哪条带属于哪一行"可以被字宽证据独立判出来。 */
const OVER = {
  zh1: '[Wemmbu] 一二三四五六七八九十',
  en1: 'this is the first row of the overlapping pair',
  zh2: '[eggchan] 短句',
  en2: 'and this is the second row',
};
const ASS_OVERLAP = buildAss([
  [OVER.zh1, OVER.en1, 1, 6],
  [OVER.zh2, OVER.en2, 4.5, 10],
]);

/* ── 2. 起服务 + 建项目 ── */
const srv = spawn(process.execPath, [resolve(ROOT, 'editor/server.js')], { stdio: 'ignore' });
async function waitHttp(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}
if (!await waitHttp(BASE + '/editor/index.html')) { console.error('服务没起来'); srv.kill(); process.exit(1); }
const pr = await fetch(BASE + '/api/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '【探针】视频区就地编辑', video: { path: VIDEO }, subtitle: { name: 'sample.ass', text: ASS_TEXT } })
});
const proj = await pr.json();
if (!pr.ok) { console.error('建项目失败', pr.status, proj); srv.kill(); process.exit(1); }
console.log('projectId =', proj.id);
const subFile = resolve(ROOT, 'projects', proj.id, 'subtitle.ass');

/* ── 3. 像素工具：自带 PNG 解码（不依赖 ffmpeg/第三方库，沙箱里也能跑） ── */
function pngGray(pngPath) {
  const buf = readFileSync(pngPath);
  let pos = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = color === 6 ? 4 : color === 2 ? 3 : color === 0 || color === 4 ? 1 : 0;
  if (!bpp || depth !== 8) throw new Error('不支持的 PNG: colorType=' + color + ' depth=' + depth);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, bb = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += bb;
      else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) {
        const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const i = x * bpp;
      out[y * w + x] = bpp >= 3 ? Math.round(0.299 * line[i] + 0.587 * line[i + 1] + 0.114 * line[i + 2]) : line[i];
    }
    prev = line;
  }
  return { w, h, buf: out };
}
const gray = pngGray;
/** 在 [x0,x1)×[y0,y1) 里找"亮像素"(文字)的分布：逐行计数 + 逐列计数 */
function inkProfile(g, box, thr = 60) {
  const rows = [], cols = new Array(Math.max(0, box.x1 - box.x0)).fill(0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = box.y0; y < box.y1; y++) {
    let n = 0;
    for (let x = box.x0; x < box.x1; x++) {
      if (g.buf[y * g.w + x] >= thr) { n++; cols[x - box.x0]++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    rows.push(n);
  }
  return { rows, cols, minX, maxX, minY, maxY };
}
/** 连续的文字带（行亮像素数 > 阈值的一段 y） */
function bands(profile, box, minCount = 6) {
  const out = [];
  let cur = null;
  profile.rows.forEach((n, i) => {
    if (n > minCount) { if (!cur) cur = { y0: box.y0 + i, y1: box.y0 + i }; else cur.y1 = box.y0 + i; }
    else if (cur) { if (cur.y1 - cur.y0 >= 4) out.push(cur); cur = null; }
  });
  if (cur && cur.y1 - cur.y0 >= 4) out.push(cur);
  return out;
}
/** 某个矩形里的墨迹统计（亮像素个数 / 左右边界 / 纵向重心） */
function inkStats(g, x0, x1, y0, y1, thr = 60) {
  let n = 0, minX = Infinity, maxX = -Infinity, sumY = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (g.buf[y * g.w + x] >= thr) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; sumY += y; }
    }
  }
  return { n, minX, maxX, cy: n ? sumY / n : 0 };
}

/* ── 4. 浏览器 ── */
const b = await launch({ url: `${BASE}/editor/index.html#/project/${proj.id}`, width: 1600, height: 1000 });
let exitCode = 1;
try {
  const key = async (keyName, vk) => {
    const base = { key: keyName, code: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await b.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
    await b.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  };
  /** 读 libass 画布 alpha → 文字带（探针自己实现，独立于 videoedit.js 的 _scanInk） */
  const inkBands = () => b.eval(`(() => {
    const cv = document.querySelector('#video-stage canvas');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width, H = cv.height, rows = new Array(H).fill(0);
    for (let y = 0, i = 3; y < H; y++) { let n = 0; for (let x = 0; x < W; x++, i += 4) if (d[i] > 24) n++; rows[y] = n; }
    const runs = []; let cur = null;
    for (let y = 0; y < H; y++) {
      if (rows[y] >= 4) { if (cur) cur.y1 = y; else cur = { y0: y, y1: y }; }
      else if (cur && y - cur.y1 > 2) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return runs.filter(x => x.y1 - x.y0 >= 4).map(x => {
      let x0 = Infinity, x1 = -Infinity, n = 0;
      for (let y = x.y0; y <= x.y1; y++) { const base = y * W * 4;
        for (let xx = 0; xx < W; xx++) if (d[base + xx * 4 + 3] > 24) { n++; if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; } }
      return { y0: x.y0, y1: x.y1, x0, x1, w: x1 - x0 + 1, n };
    });
  })()`);
  await b.waitFor('!!window.__videoEditor', { timeout: 20000 });
  await b.waitFor('document.querySelectorAll("#cue-list .cue-card").length > 0', { timeout: 20000, label: '字幕列表' });
  await sleep(4000);                                    // 等 libass 初始化 + 首帧

  console.log('\n=== 命中判定（ASS 路径） ===');
  const seek = await b.eval(`(() => {
    const v = document.getElementById('video');
    v.currentTime = 2; v.pause();
    return { t: v.currentTime, vw: v.videoWidth, vh: v.videoHeight, cw: v.clientWidth, ch: v.clientHeight };
  })()`);
  await sleep(1200);

  const layout = await b.eval(`(() => {
    const ed = window.__videoEditor;
    const st = document.getElementById('video-stage').getBoundingClientRect();
    const items = ed._layoutItems().map(it => ({
      kind: it.kind, side: it.side, plain: it.plain,
      segs: it.segs.map(s => s.text),
      top: it.top + st.top, bottom: it.bottom + st.top,
      x0: it.x0 + st.left, x1: it.x0 + st.left + it.adv[it.plain.length],
      segX: it.segs.map(s => [it.x0 + st.left + it.adv[s.start], it.x0 + st.left + it.adv[s.end]]),
      fontPx: it.fontPx, lineH: it.lineH
    }));
    return { stage: { left: st.left, top: st.top, width: st.width, height: st.height }, pic: ed.api.pictureRect(), items };
  })()`);
  const inkDiag = await b.eval(`(() => {
    const ed = window.__videoEditor;
    const cv = ed.api.assCanvas ? ed.api.assCanvas() : null;
    const pic = ed.api.pictureRect();
    let bands = null, err = null, allReal = null, before = null, after = null;
    try {
      bands = ed._inkBands(pic);
      const raw = ed.api.itemsAt(ed.video.currentTime);
      const items = raw.map(it => Object.assign({}, it, ed._layoutAss(it, pic)));
      before = items.map(i => [i.side, Math.round(i.top), Math.round(i.bottom), i.kind]);
      allReal = ed._applyInk(items, pic);
      after = items.map(i => [i.side, Math.round(i.top), Math.round(i.bottom)]);
    } catch (e) { err = String(e && e.stack || e); }
    return { hasApi: typeof ed.api.assCanvas, canvas: cv ? [cv.width, cv.height, cv.tagName] : null,
      bands: bands ? bands.map(b => [Math.round(b.top), Math.round(b.bottom), Math.round(b.left), Math.round(b.right)]) : null,
      before, after, allReal, err };
  })()`);
  console.log('  墨迹诊断:', JSON.stringify(inkDiag));
  console.log('  估算行:', JSON.stringify(layout.items.map(i => ({ side: i.side, plain: i.plain, segs: i.segs, band: [Math.round(i.top), Math.round(i.bottom)] }))));
  ok(layout.items.length === 2, '当前时刻估到中英两行', layout.items.length);
  const zh = layout.items.find(i => i.side === 'zh');
  const en = layout.items.find(i => i.side === 'en');
  ok(!!zh && !!en, '中/英两行都在', [!!zh, !!en]);
  ok(zh && JSON.stringify(zh.segs) === JSON.stringify(['一路打到决赛', '才有机会击败Flame']),
    '中文行按空格切成两段（行首 [Wemmbu] 不进片段）', zh && zh.segs);
  ok(en && en.segs.length === 14 && en.segs[1] === 'my', '英文行按词切（14 个词）', en && en.segs.length);

  /* 像素校验：截图 → 扫出真实文字带 → 与估算带做**集合匹配**。
   * 注意这是独立验证，不是自证：估算完全来自 Style(字体/字号/对齐/边距) + 量字宽，
   * 像素来自真实渲染结果。两边对不上就说明估算歪了。 */
  await b.shot(resolve(OUT, 'videoedit-1-before.png'));
  const g = gray(resolve(OUT, 'videoedit-1-before.png'));
  const met = await b.eval(`(() => {
    const v = document.getElementById('video');
    const cv = document.querySelector('#video-stage canvas') || document.querySelector('canvas');
    let ctxKind = 'none', ink = null;
    if (cv) {
      try {
        const x2 = cv.getContext('2d');
        if (x2) {
          ctxKind = '2d';
          const d = x2.getImageData(0, 0, Math.min(cv.width, 1200), Math.min(cv.height, 700)).data;
          let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
          ink = n;
        } else ctxKind = 'not-2d';
      } catch (e) { ctxKind = 'err:' + e.message; }
    }
    return { dpr: window.devicePixelRatio, clientW: document.documentElement.clientWidth, innerW: window.innerWidth,
      scrollH: document.documentElement.scrollHeight,
      video: v.getBoundingClientRect().toJSON(),
      canvas: cv ? { bw: cv.width, bh: cv.height, r: cv.getBoundingClientRect().toJSON(), ctxKind, alphaInk: ink } : null };
  })()`);
  console.log('  几何:', JSON.stringify({ shot: [g.w, g.h], met }));
  const dpr = g.w / met.clientW;                         // 截图设备像素 / CSS 像素（截图按 clientWidth 宽采样）
  console.log('  dpr =', dpr.toFixed(4), '(截图宽', g.w, '/ clientWidth', met.clientW, ')');
  const pic = layout.pic;
  console.log('  pic =', JSON.stringify(pic), ' video =', JSON.stringify(met.video),
    ' 估算 fontPx =', layout.items.map(i => i.fontPx.toFixed(1)).join('/'), ' lineH =', layout.items.map(i => i.lineH.toFixed(1)).join('/'));
  const scan = {
    x0: Math.round((layout.stage.left + pic.left) * dpr), x1: Math.round((layout.stage.left + pic.left + pic.width) * dpr),
    y0: Math.round((layout.stage.top + pic.top + pic.height * 0.6) * dpr),
    y1: Math.round((layout.stage.top + pic.top + pic.height - 60) * dpr)     // 让开底部原生控制条
  };
  const bs = bands(inkProfile(g, scan), scan);
  console.log('  像素文字带(y, 设备像素):', JSON.stringify(bs));
  ok(bs.length === 2, '画面里恰好扫到 2 条文字带（中文 / 英文）', bs.length);
  // 每条真实带量出：y 区间 / x 区间 / 墨迹重心
  const bsInfo = bs.map(b => {
    const s = inkStats(g, scan.x0, scan.x1, b.y0, b.y1 + 1);
    return { b, top: b.y0 / dpr, bottom: b.y1 / dpr,
      left: s.minX / dpr, right: s.maxX / dpr, w: (s.maxX - s.minX) / dpr,
      cx: (s.minX + s.maxX) / 2 / dpr, cy: s.cy / dpr, n: s.n };
  });
  /* 哪条带属于哪一行 —— **不能用估算来判**（那等于自证）。用字宽证据判：
   * 中英两行是同一个字号，所以"真实墨迹宽 ÷ 该行纯文本的理论 em 宽"必须给出同一个字号。
   * 配反的话推导出的两个字号会差一倍（实测 25.5 / 15.5 vs 25.5 / 24.8）。 */
  const emW = (plain) => {
    let w = 0;
    for (const ch of String(plain || '')) {
      const c = ch.codePointAt(0);
      if (c === 32) w += 0.28;
      else if (c > 0x2e80) w += 1.0;                       // CJK / 全角
      else if (/[A-Z]/.test(ch)) w += 0.62;
      else if (/[a-z]/.test(ch)) w += 0.52;
      else if (/[0-9]/.test(ch)) w += 0.50;
      else if ('[]()'.includes(ch)) w += 0.33;
      else w += 0.30;
    }
    return w;
  };
  const rows2 = [zh, en];
  const spread = ([a, b]) => {
    const f1 = bsInfo[0].w / emW(rows2[a].plain), f2 = bsInfo[1].w / emW(rows2[b].plain);
    return Math.abs(f1 - f2) / Math.max(f1, f2);
  };
  const sAB = spread([0, 1]), sBA = spread([1, 0]);
  const asg = sAB <= sBA ? [0, 1] : [1, 0];                  // asg[带序] = 行序
  console.log('  带↔行（按字宽判定）:', `带1→${rows2[asg[0]].side}`, `带2→${rows2[asg[1]].side}`,
    ` 反配歧义度=${(Math.min(sAB, sBA) / Math.max(sAB, sBA)).toFixed(3)}`,
    ` 两行推导字号=${[0, 1].map(i => (bsInfo[i].w / emW(rows2[asg[i]].plain)).toFixed(1)).join(' / ')}`);
  ok(rows2[asg[0]].side === 'zh' && rows2[asg[1]].side === 'en',
    '上/下两条文字带分别归到中文/英文行（按字宽证据判定）', [rows2[asg[0]].side, rows2[asg[1]].side]);
  ok(Math.min(sAB, sBA) < Math.max(sAB, sBA) * 0.5, '字宽证据足以确定归属（不是模棱两可）',
    [+sAB.toFixed(3), +sBA.toFixed(3)]);

  const zhB = bsInfo[asg.indexOf(0)], enB = bsInfo[asg.indexOf(1)];
  const dev = [[zhB, zh], [enB, en]].map(([r, it]) => Math.abs((r.top + r.bottom) / 2 - (it.top + it.bottom) / 2));
  console.log('  真实带:', [zhB, enB].map(r => `[${r.top.toFixed(0)},${r.bottom.toFixed(0)}]`).join(' '),
    ' 程序给的带:', [zh, en].map(i => `[${Math.round(i.top)},${Math.round(i.bottom)}]`).join(' '));
  ok(Math.max(...dev) <= 6, `程序给的带位置就是真实文字带（最大偏差 ${Math.max(...dev).toFixed(1)}px）`,
    dev.map(d => +d.toFixed(1)));
  const wRatio = [[zhB, zh], [enB, en]].map(([r, it]) => r.w / (it.x1 - it.x0));
  console.log('  宽度比（真实/程序）:', wRatio.map(v => v.toFixed(3)).join(' / '));
  ok(wRatio.every(v => Math.abs(v - 1) < 0.06), '中英两行的宽度都与真实墨迹一致（±6%）', wRatio.map(v => +v.toFixed(3)));

  /* 真实字号反推：把一条文字带按"墨迹列簇"切开，连续汉字之间的簇间距就是 1em。
   * 这是独立于 CSS 的第二个真值来源（字号反推 vs 宽度反推，两者互相印证）。 */
  const pitch = (bandY0, bandY1) => {
    const p = inkProfile(g, { x0: scan.x0, x1: scan.x1, y0: bandY0, y1: bandY1 + 1 });
    const cols = p.cols.map((n, i) => (n > 0 ? i + scan.x0 : -1)).filter(i => i >= 0);
    const runs = [];
    for (const x of cols) {
      if (runs.length && x - runs[runs.length - 1].x1 <= 2) runs[runs.length - 1].x1 = x;
      else runs.push({ x0: x, x1: x });
    }
    const gaps = runs.slice(1).map((r, i) => ({ x: (r.x0 + runs[i].x1) / 2 / dpr, w: (r.x0 - runs[i].x1) / dpr }));
    return { n: runs.length, runs, gaps, span: runs.length ? (runs[runs.length - 1].x1 - runs[0].x0) / dpr : 0 };
  };
  const zhPm = pitch(zhB.b.y0, zhB.b.y1), enPm = pitch(enB.b.y0, enB.b.y1);
  console.log('  列簇: 中文', zhPm.n, '簇/span', zhPm.span.toFixed(0), ' 英文', enPm.n, '簇/span', enPm.span.toFixed(0));

  const zhPx = { top: zhB.top, bottom: zhB.bottom };
  const zhInk = { left: zhB.left, right: zhB.right, cx: zhB.cx, cy: zhB.cy, n: zhB.n };
  const realC = zhB.cx, estC = (zh.x0 + zh.x1) / 2;
  console.log(`  中文行: 真实 x=[${zhB.left.toFixed(0)},${zhB.right.toFixed(0)}] 宽${zhB.w.toFixed(0)}`,
    ` 程序给 x=[${zh.x0.toFixed(0)},${zh.x1.toFixed(0)}] 宽${(zh.x1 - zh.x0).toFixed(0)}`);
  ok(Math.abs(realC - estC) <= 8, `中文行中点对齐（偏 ${Math.abs(realC - estC).toFixed(1)}px）`, [realC.toFixed(1), estC.toFixed(1)]);
  ok(enB.n > 200, '英文带的墨迹量与一行字相称', enB.n);

  /** 打开就地编辑框 = **单击**字幕那一段（手势：单击就地编辑 / 双击整行弹窗）。
   *  必须等过 CUE_CLICK_DELAY(240ms) 那个双击窗口，框才会真的出来。 */
  const tap = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await b.mouse(type, x, y, { clickCount: 1 });
    await sleep(1200);   // 盖过被节流的 240ms 双击窗口
  };
  const clickY = zhInk.cy;                                // 点真实文字重心（模拟用户照着画面点）

  /* ── 独立验证命中：用像素找"段间空格"，点第 2 段 ──
   * 这里点的 x **不是**程序算出来的（那是自证），而是从截图墨迹里量出来的：
   * 中文行 = 角色前缀 + 2 个片段 → 墨迹里应有 2 个"空格级"大缝（前缀|段1、段1|段2），
   * 取靠右那个缝的右侧墨迹中点，单击它必须命中第 2 段。 */
  const bigGaps = zhPm.gaps.slice().sort((a, b) => b.w - a.w).slice(0, 2).sort((a, b) => a.x - b.x);
  const seg2x = (bigGaps[1].x + zhB.right) / 2;
  console.log('  两处空格缝:', bigGaps.map(g => `x=${g.x.toFixed(0)}(宽${g.w.toFixed(0)})`).join(' '),
    ' → 点第 2 段 x =', seg2x.toFixed(0));
  await tap(seg2x, clickY);
  const stSeg2 = await b.eval(`(() => ({ open: window.__videoEditor.isOpen,
    value: document.getElementById('cie-input').value,
    side: window.__videoEditor.open ? window.__videoEditor.open.item.side : null }))()`);
  ok(stSeg2.side === 'zh' && stSeg2.value === '才有机会击败Flame',
    '按像素量出的位置点第 2 段 → 命中第 2 段（坐标不是程序自算的）', stSeg2);
  await key('Escape', 27);
  await sleep(300);
  ok(!(await b.eval('window.__videoEditor.isOpen')), 'Esc 取消后就地编辑框关闭', null);

  /* ── 真实鼠标单击中文行第 1 段 ── */
  console.log('\n=== 单击中文行 → 就地编辑框 ===');
  const clickX = (zh.segX[0][0] + zh.segX[0][1]) / 2;
  await tap(clickX, clickY);
  const st1 = await b.eval(`(() => {
    const ed = window.__videoEditor;
    const box = document.getElementById('cue-inline-editor');
    const seg = document.getElementById('cue-seg-box');
    return { open: ed.isOpen, value: document.getElementById('cie-input').value,
      boxShown: !box.hidden, boxRect: box.getBoundingClientRect().toJSON(),
      segRect: seg.getBoundingClientRect().toJSON(), paused: document.getElementById('video').paused };
  })()`);
  ok(st1.open === true, '单击后进入编辑状态', st1.open);
  ok(st1.boxShown === true, '输入框显示出来', st1.boxShown);
  ok(st1.value === '一路打到决赛', '输入框预填"点中的那一段"', st1.value);
  ok(st1.segRect.width > 20 && st1.segRect.height > 10, '片段高亮框有尺寸', { w: Math.round(st1.segRect.width), h: Math.round(st1.segRect.height) });
  // 截图 y 本身就是视口坐标（未滚动），程序给的墨迹 top 也是视口坐标 → 直接比，别再叠 stage 偏移
  const segBoxExp = zhPx.top + 2;                         // _segRect 在墨迹顶上内缩 2px
  ok(Math.abs(st1.segRect.top - segBoxExp) <= 6,
    '高亮框贴在真实文字带上（框顶 = 墨迹顶 + 2px 内缩）', [st1.segRect.top, segBoxExp]);
  ok(st1.paused === true, '进入编辑即暂停（画面定住）', st1.paused);
  const diag = await b.eval(`(() => {
    const ed = window.__videoEditor, st = document.getElementById('video-stage').getBoundingClientRect();
    const hit = ed.hitTestAt(${clickX} - st.left, ${clickY} - st.top);
    return { stageLeft: st.left, stageTop: st.top, clickX: ${clickX}, clickY: ${clickY},
      open: ed.open ? [ed.open.item.side, ed.open.seg.text] : null,
      hit: hit ? [hit.item.side, hit.seg.text] : null,
      bands: ed._layoutItems().map(i => [i.side, Math.round(i.top), Math.round(i.bottom), Math.round(i.x0), Math.round(i.x0 + i.adv[i.plain.length])]) };
  })()`);
  console.log('  诊断:', JSON.stringify(diag));
  await b.shot(resolve(OUT, 'videoedit-2-inline.png'));

  /* ── 打字即预览：画面上立刻看到草稿，但一个字节都不落盘 ──
   * 断言口径仍是像素：直接读 libass 画布 alpha，看中文行的墨迹宽有没有跟着变。 */
  console.log('\n=== 打字即预览（只预览、不落盘） ===');
  const subPvBefore = existsSync(subFile) ? readFileSync(subFile, 'utf8') : '';
  const inkA = await inkBands();
  await b.eval(`(() => { const i = document.getElementById('cie-input');
    i.value = '一路打进决赛长一点'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(450);
  const inkB = await inkBands();
  console.log('  中文行墨迹宽（设备像素）:', inkA[0].w, '→', inkB[0].w);
  ok(inkB[0].w > inkA[0].w + 20, '打字时画面立刻跟着变（中文行墨迹变宽）', [inkA[0].w, inkB[0].w]);
  ok(existsSync(subFile) && readFileSync(subFile, 'utf8') === subPvBefore, '预览没有落盘（磁盘内容一字未变）', null);
  await b.eval(`(() => { const i = document.getElementById('cie-input');
    i.value = '一路打进决赛'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(350);
  const inkC = await inkBands();
  ok(Math.abs(inkC[0].w - inkA[0].w) <= 6, '输入框改回原样 → 画面宽度也回到原样（预览可逆）', [inkA[0].w, inkC[0].w]);

  /* ── Enter 保存，只改这一段 ── */
  console.log('\n=== Enter 保存（仅替换该片段） ===');
  await b.eval(`(() => { const i = document.getElementById('cie-input'); i.value = '一路打进决赛'; return 1; })()`);
  await key('Enter', 13);
  await sleep(2600);                                    // 等自动保存落盘
  console.log('  toast:', await b.eval(`(document.getElementById('toast')||{}).textContent || ''`));
  const st2 = await b.eval(`(() => {
    const ed = window.__videoEditor;
    const list = [...document.querySelectorAll('#cue-list *')].map(e => e.textContent).join('|');
    return { open: ed.isOpen, listHas: list.includes('一路打进决赛'), oldGone: !list.includes('一路打到决赛 才有机会') };
  })()`);
  ok(st2.open === false, '保存后编辑框关闭', st2.open);
  ok(st2.listHas === true, '右侧列表同步显示新文本', st2.listHas);
  const saved = existsSync(subFile) ? readFileSync(subFile, 'utf8') : '';
  ok(saved.includes('一路打进决赛'), 'ASS 已落盘（磁盘读回含新文本）', subFile);
  ok(saved.includes('[Wemmbu] 一路打进决赛 {\\c&H7F00FF&}才有机会击败Flame'),
    '只动了被点中的那一段：角色标签 + 行内色标 + 后续片段一字未动', null);
  ok(saved.includes('battling my way to the finale'), '英文行未被中文编辑波及');
  await sleep(400);
  await b.shot(resolve(OUT, 'videoedit-3-after.png'));

  /* ── 英文逐词行：点中某个词改它（词数不变 → 逐词时间不变） ── */
  console.log('\n=== 改英文行里的一个词 ===');
  const en2 = await b.eval(`(() => {
    const ed = window.__videoEditor, st = document.getElementById('video-stage').getBoundingClientRect();
    const it = ed._layoutItems().find(i => i.side === 'en');
    if (!it) return null;
    const k = it.segs.findIndex(s => s.text === 'finale');
    if (k < 0) return null;
    const s0 = it.segs[k];
    return { x: st.left + (it.x0 + (it.adv[s0.start] + it.adv[s0.end]) / 2), y: st.top + (it.top + it.bottom) / 2, k };
  })()`);
  ok(!!en2, '英文行里能定位到 finale 这个词', en2);
  if (en2) {
    await tap(en2.x, en2.y);
    const st4 = await b.eval(`(() => ({ open: window.__videoEditor.isOpen, value: document.getElementById('cie-input').value }))()`);
    ok(st4.open === true && st4.value === 'finale', '点到哪个词就编辑哪个词', st4);
    await b.eval(`(() => { document.getElementById('cie-input').value = 'grand final'; return 1; })()`);
    await key('Enter', 13);
    await sleep(2600);
    const saved2 = existsSync(subFile) ? readFileSync(subFile, 'utf8') : '';
    ok(saved2.includes('grand final'), '英文行改词已落盘', null);
    const enLine = saved2.split(/\r?\n/).find(l => l.includes('grand final')) || '';
    ok(/\bgrand\b/.test(enLine), '新词写进了 ASS 事件行（逐词切片由流水线重建）', null);
    // 被替换掉的词本身必须消失（只剩它所在的那一段被换，整行其余部分照旧 —— 别拿后半句当"旧文本"）
    ok(!/\bfinale\b/.test(enLine), '被替换掉的旧词 finale 已从事件行消失', enLine.slice(0, 90));
  }

  /* ── 改完词之后：几何必须是**重新量**的，不能还拿着改之前的墨迹带（缓存/闭包） ──
   * finale → grand final 让英文行变长，旧墨迹带宽度会立刻对不上。 */
  await sleep(400);
  const inkPost = await inkBands();
  const layPost = await b.eval(`(() => {
    const ed = window.__videoEditor;
    return { en: (() => { const it = ed._layoutItems().find(i => i.side === 'en');
        return it ? { w: it.adv[it.plain.length], plain: it.plain } : null; })(),
      zh: (() => { const it = ed._layoutItems().find(i => i.side === 'zh');
        return it ? { w: it.adv[it.plain.length] } : null; })() };
  })()`);
  console.log('  改词后：英文行墨迹宽', inkPost[1].w, ' 程序宽', layPost.en && layPost.en.w.toFixed(0));
  ok(layPost.en && Math.abs(layPost.en.w - inkPost[1].w) <= 10,
    '保存后重新读画布：程序几何 = 新墨迹（没有拿改之前的旧缓存）', [inkPost[1].w, layPost.en && +layPost.en.w.toFixed(1)]);
  ok(layPost.en && layPost.en.plain.includes('grand final'), '几何对应的也是新文本', layPost.en && layPost.en.plain.slice(0, 60));

  /* ── 点框外 = 取消 ── */
  console.log('\n=== 点框外即取消 ===');
  await b.eval(`(() => { document.getElementById('video').currentTime = 8; document.getElementById('video').pause(); return 1; })()`);
  await sleep(900);
  const zh2 = await b.eval(`(() => {
    const ed = window.__videoEditor, st = document.getElementById('video-stage').getBoundingClientRect();
    const it = ed._layoutItems().find(i => i.side === 'zh');
    if (!it) return null;
    return { plain: it.plain, segs: it.segs.map(s => s.text),
      x: st.left + it.x0 + (it.adv[it.segs[0].start] + it.adv[it.segs[0].end]) / 2,
      y: st.top + (it.top + it.bottom) / 2 };
  })()`);
  ok(!!zh2 && zh2.segs[0] === '他亲手封禁了我们服务器的几百名玩家', '第 2 句切段正确', zh2 && zh2.segs);
  if (zh2) {
    await tap(zh2.x, zh2.y);
    const before = await b.eval(`window.__videoEditor.isOpen`);
    ok(before === true, '第 2 句也能单击进入编辑', before);
    await b.eval(`(() => { document.getElementById('cie-input').value = '不应保存的内容'; return 1; })()`);
    const stage = layout.stage;
    await b.click(stage.left + stage.width - 6, stage.top + 6);       // 点画面角落 = 框外
    await sleep(500);
    const st3 = await b.eval(`(() => ({ open: window.__videoEditor.isOpen,
      list: [...document.querySelectorAll('#cue-list *')].map(e => e.textContent).join('|') }))()`);
    ok(st3.open === false, '点框外后编辑框关闭', st3.open);
    ok(!st3.list.includes('不应保存的内容'), '点框外 = 取消，未写入', null);
  }

  /* ══════ 阶段 2：两行时间重叠 → 画面上 4 条线（谁在哪一条不能猜错） ══════
   * libass 的摆法是"按事件在文件里的先后从底部往上、后面的往上顶"。
   * 这个夹具里文件顺序是 en1 → en2 → zh1 → zh2（逐词事件按时间排在前面，中文行排在后面），
   * 所以由下到上应当是 en1, en2, zh1, zh2 —— 命中判定必须与之一致。 */
  console.log('\n=== 阶段 2：两行重叠（4 条线） ===');
  const pr2 = await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '【探针】重叠行', video: { path: VIDEO }, subtitle: { name: 'overlap.ass', text: ASS_OVERLAP } })
  });
  const proj2 = await pr2.json();
  ok(pr2.ok && !!proj2.id, '建了第二个项目（重叠行夹具）', pr2.status);
  if (pr2.ok) {
    await b.goto(`${BASE}/editor/index.html#/project/${proj2.id}`);
    await b.waitFor('!!window.__videoEditor', { timeout: 20000 });
    await b.waitFor('document.querySelectorAll("#cue-list .cue-card").length > 0', { timeout: 20000, label: '字幕列表2' });
    await sleep(4500);
    await b.eval(`(() => { const v = document.getElementById('video'); v.currentTime = 5; v.pause(); return 1; })()`);
    await sleep(1400);

    const lay2 = await b.eval(`(() => window.__videoEditor._layoutItems().map(it => ({
      kind: it.kind, side: it.side, plain: it.plain, top: it.top, bottom: it.bottom,
      x0: it.x0, x1: it.x0 + it.adv[it.plain.length],
      seg0: it.segs.length ? [it.x0 + it.adv[it.segs[0].start], it.x0 + it.adv[it.segs[0].end]] : null,
      seg0text: it.segs.length ? it.segs[0].text : null })))()`);
    const ink2 = await inkBands();
    console.log('  程序给的 4 条带:', JSON.stringify(lay2.map(i => [i.plain.slice(0, 14), Math.round(i.top), Math.round(i.bottom), Math.round(i.x1 - i.x0)])));
    console.log('  画布真实 4 条带:', JSON.stringify(ink2.map(b => [b.y0, b.y1, b.x0, b.x1, b.w])));
    ok(lay2.length === 4, 't=5 时刻估到 4 行（两行的中英）', lay2.length);
    ok(ink2 && ink2.length === 4, '画面上确实叠了 4 条文字带', ink2 && ink2.length);

    if (lay2.length === 4 && ink2 && ink2.length === 4) {
      /* 独立证据：每一对 (带, 行) 算出的"真实字号 = 带墨迹宽 ÷ 该行纯文本的 em 宽"必须一致。
       * 配错一行，这四个值就会差一倍以上（emW 与 videoedit.js 无关，是探针自己按字符类别估的）。 */
      const F = lay2.map((it, i) => ink2[i].w / emW(it.plain));
      const spread = (Math.max(...F) - Math.min(...F)) / Math.max(...F);
      console.log('  每行反推字号:', F.map(v => v.toFixed(1)).join(' / '), ' 极差 =', (spread * 100).toFixed(1) + '%');
      ok(spread < 0.22, '4 条带与 4 行的配对经字宽证据验证一致（每行反推字号相同）', F.map(v => +v.toFixed(1)));
      // 竖直位置也必须对得上（±6px）
      const devs = lay2.map((it, i) => Math.max(Math.abs(it.top - ink2[i].y0), Math.abs(it.bottom - ink2[i].y1)));
      ok(Math.max(...devs) <= 6, `4 条带的位置与程序给的一致（最大偏差 ${Math.max(...devs).toFixed(1)}px）`, devs.map(d => +d.toFixed(1)));

      /* 逐条单击：点哪条就编辑哪条（用真实墨迹的 y + 程序给的片段区间中点）。
       * 由上到下的期望 = 由下到上（en1,en2,zh1,zh2）的逆序 —— 这是文件顺序推出的画面顺序。 */
      const expect = [OVER.zh2, OVER.zh1, OVER.en2, OVER.en1];
      const wrong = [];
      for (let i = 0; i < 4; i++) {
        const it = lay2[i], band = ink2[i];
        const cx = (it.seg0[0] + it.seg0[1]) / 2;
        const cy = (band.y0 + band.y1) / 2 + layout.stage.top;
        await tap(cx, cy);
        const got = await b.eval(`(() => { const ed = window.__videoEditor;
          return ed.open ? { plain: ed.open.item.plain, seg: ed.open.seg.text } : null; })()`);
        if (!got || got.plain !== expect[i]) wrong.push([i, expect[i].slice(0, 12), got && got.plain.slice(0, 12)]);
        await key('Escape', 27);
        await sleep(180);
      }
      ok(wrong.length === 0, '4 条线逐条单击都命中自己那一行（不串行）', wrong);
      await b.shot(resolve(OUT, 'videoedit-4-overlap.png'));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('截图 → outputs/videoedit-1-before.png / -2-inline.png / -3-after.png / -4-overlap.png');
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('探针异常:', e && e.stack || e);
} finally {
  await b.close();
  srv.kill();
  process.exitCode = exitCode;
}
