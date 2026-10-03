/* 波形退化诊断页生成器: 同一段合成语音, 分别跑「现有管线」「只修数据」「完整修复」, 输出对比 HTML。
 * 跑法: node tools/wave_compare.mjs
 * 产出: outputs/waveform-compare.html
 */
import fs from 'node:fs';
import path from 'node:path';

const SR = 16000;        // 与 server.js AUDIO_SR 一致
const RATE = 100;       // 与 server.js 一致(每秒包络个数)
const DUR = 20;         // 20s 足够看清音节结构
const PEAK_GAIN = 7.943;

/* ── 合成一段"像影视语音"的音频: 短语段 + 音节包络 + 基频谐波 + 爆破音 + 底噪 ── */
function synth() {
  const n = Math.round(DUR * SR);
  const pcm = Buffer.alloc(n * 2);
  // 短语分段(留空隙, 模拟说话人换气)
  const phrases = [[0.6, 3.1], [3.9, 6.2], [7.0, 8.4], [9.6, 12.8], [13.4, 15.1], [16.0, 19.2]];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = 0;
    for (const [a, b] of phrases) {
      if (t < a || t > b) continue;
      const u = (t - a) / (b - a);                       // 段内进度
      const gate = Math.min(1, u * 14) * Math.min(1, (1 - u) * 10);   // 起落
      const syl = 0.45 + 0.55 * Math.abs(Math.sin(u * Math.PI * (b - a) * 4.6));  // 音节
      const word = 0.7 + 0.3 * Math.sin(u * Math.PI * (b - a) * 1.7 + 1.1);     // 词组重音
      env = Math.max(env, gate * syl * word);
    }
    // 爆破音: 音节起始处偶发瞬态(最响的地方 —— 正是被削平的那部分)
    const burst = Math.sin(t * 2 * Math.PI * 7.3) > 0.985 ? 2.2 : 1;
    const f0 = 128 + 34 * Math.sin(t * 1.7) - 18 * Math.sin(t * 0.6);
    phase += 2 * Math.PI * f0 / SR;
    const src = 0.62 * Math.sin(phase) + 0.26 * Math.sin(phase * 2)
      + 0.13 * Math.sin(phase * 3) + 0.06 * Math.sin(phase * 4.7)
      + 0.035 * (Math.random() * 2 - 1);                 // 底噪 ≈ -58dBFS
    const s = Math.round(src * env * burst * 0.22 * 32767);   // 峰值约 −13dBFS(影视对白常见量级)
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return pcm;
}

/* ── 管线 A: 逐字复制 server.js 的分桶(PEAK_GAIN + clamp + sqrt, 只存 abs max) ── */
function bucketCurrent(pcm) {
  const total = Math.max(20000, Math.min(2000000, Math.round(DUR * RATE)));
  const spb = DUR * SR / total;
  const out = Buffer.allocUnsafe(total);
  let filled = 0, peak = 0, inBucket = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    if (++inBucket >= spb) {
      const norm = Math.min(1, (peak / 32768) * PEAK_GAIN);
      if (filled < total) out[filled++] = Math.min(255, Math.round(255 * Math.sqrt(norm)));
      peak = 0; inBucket = 0;
    }
  }
  if ((inBucket > 0 || peak > 0) && filled < total) {
    const norm = Math.min(1, (peak / 32768) * PEAK_GAIN);
    out[filled++] = Math.min(255, Math.round(255 * Math.sqrt(norm)));
  }
  return out.subarray(0, filled);
}

/* ── 管线 B: min/max 包络(带符号, 128=零位), 不做增益/压缩 ── */
function bucketMinMax(pcm) {
  const total = Math.max(20000, Math.min(2000000, Math.round(DUR * RATE)));
  const spb = DUR * SR / total;
  const mn = Buffer.alloc(total, 128), mx = Buffer.alloc(total, 128);
  let idx = 0, lo = 0, hi = 0, inBucket = 0, touched = false;
  const enc = (v) => Math.max(0, Math.min(255, Math.round(128 + v * 127)));
  const flush = () => {
    if (idx < total) { mn[idx] = enc(lo); mx[idx] = enc(hi); idx++; }
    lo = 0; hi = 0; inBucket = 0; touched = false;
  };
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    touched = true;
    if (++inBucket >= spb) flush();
  }
  if (touched && inBucket > 0) flush();
  return { min: mn.subarray(0, idx), max: mx.subarray(0, idx) };
}

/* ── 自适应归一化: 用 p99.5 分位数当参考电平 → 0.95, 不硬削, 不 sqrt ── */
function autoNormalize(minA, maxA) {
  const abs = [];
  for (let i = 0; i < minA.length; i++) {
    const a = Math.abs(maxA[i] - 128) / 127, b = Math.abs(minA[i] - 128) / 127;
    abs.push(Math.max(a, b));
  }
  const sorted = abs.slice().sort((x, y) => x - y);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))] || 1;
  const k = 0.95 / ref;
  const mn = new Uint8Array(minA.length), mx = new Uint8Array(maxA.length);
  for (let i = 0; i < minA.length; i++) {
    const lo = (minA[i] - 128) / 127, hi = (maxA[i] - 128) / 127;
    mn[i] = Math.max(0, Math.min(255, Math.round(128 + lo * k * 127)));
    mx[i] = Math.max(0, Math.min(255, Math.round(128 + hi * k * 127)));
  }
  return { min: mn, max: mx, ref, k };
}

function stats(getAbs) {
  const arr = [];
  for (let i = 0; i < getAbs.n; i++) arr.push(getAbs.at(i));
  arr.sort((a, b) => a - b);
  const q = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  let sat = 0;
  for (const v of arr) if (v > 0.985) sat++;
  const toDb = (v) => (v > 1e-5 ? 20 * Math.log10(v) : -100);
  /* 动态范围只在**有声段**内统计: 语音静音底噪约 −58dBFS, 把底噪算进去
   * 会让任何管线的 range 都飙到 100dB+, 反而看不出差异。
   * 取"高于 p50 有声桶"的部分, 量 p99−p10。 */
  const floorDb = toDb(q(0.5)) - 3;
  const act = arr.filter((v) => toDb(v) >= floorDb);
  const aq = (p) => act.length ? act[Math.min(act.length - 1, Math.floor(act.length * p))] : 0;
  return {
    p50: +toDb(q(0.5)).toFixed(1), p90: +toDb(q(0.9)).toFixed(1),
    p99: +toDb(q(0.99)).toFixed(1),
    sat: +(100 * sat / arr.length).toFixed(1),
    range: +(toDb(aq(0.99)) - toDb(aq(0.1))).toFixed(1),
  };
}

const pcm = synth();
const cur = bucketCurrent(pcm);
const mm = bucketMinMax(pcm);
const norm = autoNormalize(mm.min, mm.max);

const sA = stats({ n: cur.length, at: (i) => cur[i] / 255 });
const sB = stats({ n: norm.min.length, at: (i) => Math.abs(norm.max[i] - 128) / 127 });

/* 供页面画字幕块用(语音段 → 覆盖在轨道上的块) */
const phrases = [[0.6, 3.1, '你听我说清楚'], [3.9, 6.2, '这件事没那么简单'], [7.0, 8.4, '对吧'],
  [9.6, 12.8, '我们得重新算一遍'], [13.4, 15.1, '才看得出来'], [16.0, 19.2, '现在明白了吗']];

const payload = {
  rate: RATE, dur: DUR,
  cur: Array.from(cur),
  min: Array.from(norm.min), max: Array.from(norm.max),
  stats: { cur: sA, fixed: sB, ref: +norm.ref.toFixed(4), k: +norm.k.toFixed(2) },
  phrases,
};

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SubFabric 波形退化诊断</title>
<style>
  :root{
    --bg:#0b0b0e; --panel:#141419; --panel2:#1a1a21; --line:#26262f;
    --tx:#e8e8f0; --tx2:#9a9aab; --tx3:#6a6a7c;
    --red:#ff5f6b; --grn:#4fd1a5; --org:#ff7a45; --blu:#61b8ff; --pur:#a78bfa;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font:14px/1.65 "Microsoft YaHei",-apple-system,"Segoe UI",sans-serif;padding:28px 20px 60px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:21px;margin:0 0 6px}
  .sub{color:var(--tx2);font-size:13px;margin:0 0 26px}
  .sub b{color:var(--tx)}
  h2{font-size:15px;margin:0 0 4px;display:flex;align-items:center;gap:9px}
  .tag{font:600 11px/1 Consolas,monospace;padding:4px 8px;border-radius:4px;letter-spacing:.3px}
  .t-bad{background:rgba(255,95,107,.14);color:var(--red);border:1px solid rgba(255,95,107,.3)}
  .t-mid{background:rgba(255,180,64,.14);color:#ffb340;border:1px solid rgba(255,180,64,.3)}
  .t-good{background:rgba(79,209,165,.14);color:var(--grn);border:1px solid rgba(79,209,165,.3)}
  .note{color:var(--tx2);font-size:12.5px;margin:0 0 12px}
  .note code{background:var(--panel2);padding:1px 6px;border-radius:3px;font-size:12px;color:var(--org)}
  .pane{background:var(--panel);border:1px solid var(--line);border-radius:10px;
    padding:16px 18px 18px;margin-bottom:18px}
  canvas{width:100%;height:150px;display:block;border-radius:6px;background:#000}
  .stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:13px}
  .st{flex:1 1 118px;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:9px 11px}
  .st .k{color:var(--tx3);font-size:11px;margin-bottom:3px}
  .st .v{font:600 16px/1.2 Consolas,monospace}
  .st .u{color:var(--tx3);font-size:10.5px;margin-left:3px;font-weight:400}
  .v-bad{color:var(--red)} .v-good{color:var(--grn)} .v-mid{color:#ffb340}
  table{width:100%;border-collapse:collapse;margin-top:4px;font-size:13px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--tx3);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px}
  td code{background:var(--panel2);padding:1.5px 6px;border-radius:3px;font:12px Consolas,monospace;color:var(--org)}
  .fix{color:var(--grn)} .brk{color:var(--red)}
  .kv{color:var(--tx2)} .kv b{color:var(--tx)}
  .legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--tx3);font-size:11.5px;margin-top:9px}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
</style></head><body><div class="wrap">

<h1>SubFabric 波形退化诊断</h1>
<p class="sub">同一段 20s 合成语音（峰值 −4dBFS，与真实影视语音同量级）· 三张图唯一的变量是<b>处理管线</b> ·
采样率 ${RATE}/s · 桶数 ${cur.length}</p>

<section class="pane">
  <h2><span class="tag t-bad">现状</span> server.js 分桶 + timeline.js 现有画法</h2>
  <p class="note">数据侧：<code>min(1, peak/32768 × 7.943)</code> → <code>255×sqrt()</code>。+18dB 固定增益把 96% 的桶顶到 255，
  再经 sqrt 把中低幅度整体抬高 → 动态范围被压成一条实心带。绘制侧：每列只取 <code>max</code> 并上下对称填充，
  于是画出来是"条形图"而不是波形；且 30% 透明度 + 34px 轨道 + 字幕块覆盖，几乎看不见。</p>
  <canvas id="c1" height="150"></canvas>
  <div class="legend"><span><i style="background:#4fd1a5"></i>字幕块（12% 底 + 描边）</span>
    <span><i style="background:#8a8a95"></i>波形</span><span>轨道高 34px 的等比缩放示意见下方第 1 图底部</span></div>
  <div class="stats" id="s1"></div>
</section>

<section class="pane">
  <h2><span class="tag t-mid">只修数据</span> min/max 包络 + p99.5 自适应归一化，画法暂不动</h2>
  <p class="note">去掉固定增益与 sqrt，参考电平改用 p99.5 分位数（本次 <code>ref=${payload.stats.ref}</code>，
  实际增益 <code>k=${payload.stats.k}</code>，<b>按素材自动定</b>）。削顶率从 ${sA.sat}% 降到 ${sB.sat}%。
  注意这里仍用旧的"每列取 max + 对称填充"画法 —— 数据活了，但画法仍像条形图。</p>
  <canvas id="c2" height="150"></canvas>
  <div class="stats" id="s2"></div>
</section>

<section class="pane">
  <h2><span class="tag t-good">完整修复</span> 包络画法 + 独立波形带（对齐参考图）</h2>
  <p class="note">绘制改成 <b>min/max 不对称包络</b>（一次 path 填充整条带，保留真实上下不对称），
  不透明实心灰，出图即目标形态。布局上给波形<b>独立一条带</b>、下方贴时间刻度，不再被字幕块压住。</p>
  <canvas id="c3" height="150"></canvas>
  <div class="stats" id="s3"></div>
</section>

<section class="pane">
  <h2>根因清单</h2>
  <table>
    <thead><tr><th style="width:20%">位置</th><th style="width:34%">现状</th><th>后果</th></tr></thead>
    <tbody>
      <tr><td><code>server.js</code> 分桶</td><td class="brk"><code>PEAK_GAIN=7.943</code> 固定 +18dB<br>
        <code>Math.min(1, …)</code> 硬钳位<br><code>255×sqrt(norm)</code></td>
        <td class="kv">顶部大面积削平（本次 <b>${sA.sat}%</b> 的桶被钉在 255），
        动态范围只剩 <b>${sA.range}dB</b>；sqrt 进一步把弱音抬起来，弱强差异被抹平</td></tr>
      <tr><td><code>timeline.js:1222</code></td><td class="brk">每列只取 <code>mx</code>，<br>
        <code>cy − bh/2</code> 上下对称填充</td>
        <td class="kv">丢弃 min/max 的不对称信息 → 出来是"条形图"而非波形包络；<b>看不出真实起伏</b></td></tr>
      <tr><td><code>timeline.js:1218</code></td><td class="brk"><code>globalAlpha = 0.3</code></td>
        <td class="kv">白 30% 叠在 <code>#111116</code> 轨底上，对比度不足，弱音几乎不可见</td></tr>
      <tr><td><code>timeline.js:1255</code></td><td class="brk">波形画在 34px 轨道里，<br>字幕块叠在其上</td>
        <td class="kv">字幕块 12% 底 + 100% 描边 + 文字把波形盖掉，只在缝隙里露出一点</td></tr>
      <tr><td><code>LANE_H = 34</code></td><td class="brk">可用波形高度仅 26px</td>
        <td class="kv">纵向分辨率不足，音节结构挤成一条粗带</td></tr>
      <tr><td>PNG 兜底<br><code>showwavespic</code></td><td class="brk"><code>volume=18dB</code> 同样过载</td>
        <td class="kv">没有 peaks 时的兜底路径有一模一样的削顶问题</td></tr>
    </tbody>
  </table>
</section>

</div>
<script>
const D = ${JSON.stringify(payload)};
const RATE = D.rate;

/* ── 每像素列取该列时间窗内的 min/max(可见区自动步进采样) ── */
function colRange(arr, b0, b1) {
  let lo = Infinity, hi = -Infinity;
  for (let b = b0; b < b1; b++) { const v = arr[b]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}
function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1100, h = canvas.clientHeight || 150;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}
/* 视图: 全段 20s 铺满 */
const VIEW = { t0: 0, span: D.dur };

/* ── 1) 现状: 每列取 max, 对称填充, 30% 白, 字幕块压上来 ── */
(function () {
  const [ctx, W, H] = fit(document.getElementById('c1'));
  const laneTop = 8, laneH = H - 16;                 // 等比放大到画布便于观察
  ctx.fillStyle = '#111116'; ctx.fillRect(0, laneTop, W, laneH);
  const cy = laneTop + laneH / 2;
  ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#ffffff';
  for (let px = 0; px < W; px++) {
    const b0 = Math.floor((VIEW.t0 + px / W * VIEW.span) * RATE);
    const b1 = Math.ceil((VIEW.t0 + (px + 1) / W * VIEW.span) * RATE);
    let mx = 0;
    for (let b = Math.max(0, b0); b < Math.min(D.cur.length, Math.max(b1, b0 + 1)); b++) mx = Math.max(mx, D.cur[b]);
    const bh = (mx / 255) * (laneH - 8);
    if (bh >= 1) ctx.fillRect(px, cy - bh / 2, 1, bh);
  }
  ctx.restore();
  // 字幕块(模拟 _drawLanes: 12% 底 + 100% 描边 + 文字)
  ctx.font = '700 12px "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  for (const [a, b, text] of D.phrases) {
    const x1 = a / VIEW.span * W, x2 = b / VIEW.span * W;
    ctx.fillStyle = 'rgba(79,209,165,.12)';
    ctx.fillRect(x1, laneTop + 4, x2 - x1, laneH - 8);
    ctx.strokeStyle = '#4fd1a5'; ctx.lineWidth = 1;
    ctx.strokeRect(x1 + .5, laneTop + 4.5, x2 - x1 - 1, laneH - 9);
    ctx.fillStyle = '#4fd1a5';
    ctx.fillText(text.length > 8 ? text.slice(0, 8) : text, x1 + 6, laneTop + laneH / 2);
  }
})();

/* ── 2) 只修数据: 旧画法(每列取 abs max, 对称) ── */
(function () {
  const [ctx, W, H] = fit(document.getElementById('c2'));
  const laneTop = 8, laneH = H - 16;
  ctx.fillStyle = '#111116'; ctx.fillRect(0, laneTop, W, laneH);
  const cy = laneTop + laneH / 2, half = (laneH - 8) / 2;
  ctx.fillStyle = '#8a8a95';
  for (let px = 0; px < W; px++) {
    const b0 = Math.max(0, Math.floor((VIEW.t0 + px / W * VIEW.span) * RATE));
    const b1 = Math.min(D.min.length, Math.max(Math.ceil((VIEW.t0 + (px + 1) / W * VIEW.span) * RATE), b0 + 1));
    let [lo, hi] = colRange(D.min, b0, b1), [lo2, hi2] = colRange(D.max, b0, b1);
    const amp = Math.max(Math.abs(hi - 128), Math.abs(lo - 128), Math.abs(hi2 - 128), Math.abs(lo2 - 128)) / 127;
    const bh = Math.max(1, amp * half);
    ctx.fillRect(px, cy - bh / 2, 1, bh);
  }
})();

/* ── 3) 完整修复: min/max 不对称包络, 独立波形带 + 下方刻度 ── */
(function () {
  const c = document.getElementById('c3');
  const [ctx, W, H] = fit(c);
  const RULER = 22, waveTop = 4, waveH = H - RULER - 8;
  ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, waveTop, W, waveH);
  const cy = waveTop + waveH / 2, half = (waveH / 2) - 3;

  // 中轴
  ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Math.round(cy) + .5); ctx.lineTo(W, Math.round(cy) + .5); ctx.stroke();

  // 包络: 上沿 min→max 一次性 path 填充(保留上下不对称)
  const cols = new Array(W);
  for (let px = 0; px < W; px++) {
    const b0 = Math.max(0, Math.floor((VIEW.t0 + px / W * VIEW.span) * RATE));
    const b1 = Math.min(D.min.length, Math.max(Math.ceil((VIEW.t0 + (px + 1) / W * VIEW.span) * RATE), b0 + 1));
    const [lo, hi] = colRange(D.min, b0, b1), [lo2, hi2] = colRange(D.max, b0, b1);
    cols[px] = [Math.min(lo, lo2) - 128, Math.max(hi, hi2) - 128];
  }
  ctx.beginPath();
  let started = false, firstX = 0, lastX = 0;
  for (let px = 0; px < W; px++) {
    const y = cy - (cols[px][1] / 127) * half;
    if (!started) { ctx.moveTo(px, cy); ctx.lineTo(px, y); started = true; firstX = px; }
    else ctx.lineTo(px, y);
    lastX = px;
  }
  ctx.lineTo(lastX, cy);
  for (let px = lastX; px >= 0; px--) {
    const y = cy - (cols[px][0] / 127) * half;
    ctx.lineTo(px, y);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, waveTop, 0, waveTop + waveH);
  g.addColorStop(0, '#9a9aa4'); g.addColorStop(.5, '#c8c8d2'); g.addColorStop(1, '#9a9aa4');
  ctx.fillStyle = g; ctx.fill();

  // 下方时间刻度(对齐参考图)
  const rTop = waveTop + waveH + 2;
  ctx.strokeStyle = '#2c2c38'; ctx.fillStyle = '#8a8a99';
  ctx.font = '11px Consolas, monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  const step = 2;
  for (let t = 0; t <= D.dur; t += step) {
    const x = Math.round(t / VIEW.span * W) + .5;
    ctx.beginPath(); ctx.moveTo(x, rTop); ctx.lineTo(x, rTop + 6); ctx.stroke();
    ctx.fillText('00:' + String(t).padStart(2, '0'), x + 4, rTop + 7);
  }
})();

/* 统计卡 */
function renderStats(id, list) {
  document.getElementById(id).innerHTML = list.map(s =>
    '<div class="st"><div class="k">' + s.k + '</div><div class="v ' + (s.c || '') + '">' +
    s.v + '<span class="u">' + (s.u || '') + '</span></div></div>').join('');
}
const f = (v, c) => ({ k: '有声段动态范围', v: v, u: 'dB', c });
renderStats('s1', [
  f(D.stats.cur.range, 'v-bad'),
  { k: '削顶桶占比 (>0.985)', v: D.stats.cur.sat, u: '%', c: 'v-bad' },
  { k: 'p99 电平', v: D.stats.cur.p99, u: 'dBFS', c: 'v-bad' },
  { k: '结论', v: '实心带', c: 'v-bad' },
]);
renderStats('s2', [
  f(D.stats.fixed.range, 'v-good'),
  { k: '削顶桶占比 (>0.985)', v: D.stats.fixed.sat, u: '%', c: 'v-good' },
  { k: 'p99 电平', v: D.stats.fixed.p99, u: 'dBFS', c: 'v-good' },
  { k: '结论', v: '数据已活', c: 'v-mid' },
]);
renderStats('s3', [
  f(D.stats.fixed.range, 'v-good'),
  { k: '削顶桶占比', v: D.stats.fixed.sat, u: '%', c: 'v-good' },
  { k: '归一化增益', v: D.stats.k, u: '×', c: 'v-good' },
  { k: '结论', v: '目标形态', c: 'v-good' },
]);
</script></body></html>`;

const outDir = path.resolve(process.cwd(), 'outputs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'waveform-compare.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log('写出:', outFile);
console.log('现状统计:', JSON.stringify(sA));
console.log('修复统计:', JSON.stringify(sB), 'ref=', norm.ref.toFixed(4), 'k=', norm.k.toFixed(2));