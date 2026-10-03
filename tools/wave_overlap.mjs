/* 验证「字幕块叠在波形上」的重叠布局(而不是上下分离)。
 * 跑法: node tools/wave_overlap.mjs
 */
const FILM_H = 46, RULER_H = 20;
const WAVE_H = 72, WAVE_MIN = 16, WAVE_BOTTOM_PAD = 4;
const LANE_H = 34, LANE_GAP = 6, LANE_MIN = 24;

function mk(cssH, { showFilm, hasPeaks, n }) {
  const filmH = () => (!showFilm ? 0
    : (cssH >= FILM_H + RULER_H + 6 + WAVE_H + LANE_H * 2 ? FILM_H : 0));
  const lanesTop = () => filmH() + RULER_H + 6;
  const waveH = () => {
    if (!hasPeaks) return 0;
    const avail = cssH - lanesTop();
    const h = Math.max(0, Math.min(WAVE_H, avail - WAVE_BOTTOM_PAD));
    return h >= WAVE_MIN ? h : 0;
  };
  const laneH = (i) => {
    const nn = Math.max(1, n);
    const avail = Math.max(10, cssH - lanesTop() - (nn - 1) * LANE_GAP);
    const ideal = LANE_H * 2 + LANE_GAP;
    if (nn === 1) return avail < ideal ? Math.max(10, Math.floor(avail)) : Math.max(ideal, Math.floor(avail));
    return Math.max(10, Math.floor(avail / nn));
  };
  const laneTop = (i) => { let y = lanesTop(); for (let k = 0; k < i; k++) y += laneH(k) + LANE_GAP; return y; };
  const lanesBottom = () => (n ? laneTop(n - 1) + laneH(n - 1) : lanesTop());
  return { filmH: filmH(), lanesTop: lanesTop(), waveH: waveH(), laneTop: laneTop(0), laneH: laneH(0), bottom: lanesBottom() };
}

console.log('面板 | 波高 | 轨道顶 | 轨高 | 轨道底 | 波形区间 | 重叠? | 结果');
console.log('-'.repeat(96));
const fails = [];
for (const h of [80, 100, 120, 160, 200, 240, 300, 360, 420, 500, 600]) {
  const a = mk(h, { showFilm: false, hasPeaks: true, n: 1 });
  const waveTop = a.lanesTop, waveBot = a.lanesTop + a.waveH;
  const laneBot = a.laneTop + a.laneH;
  // 重叠判据: 轨道顶 == 波形顶(同一 y 起画), 且轨道底 > 波形底(轨道覆盖住波形下缘)
  const sameTop = a.laneTop === waveTop;
  const laneCovers = laneBot >= waveBot;
  const fits = a.bottom <= h + 0.5;
  const laneVisible = a.laneH >= LANE_MIN;
  const ok = sameTop && laneCovers && fits && laneVisible;
  if (!ok) fails.push({ h, sameTop, laneCovers, fits, laneVisible });
  console.log(
    String(h).padStart(4) + ' |' +
    String(a.waveH).padStart(5) + ' |' +
    String(a.laneTop).padStart(7) + ' |' +
    String(a.laneH).padStart(5) + ' |' +
    String(a.bottom).padStart(7) + ' |' +
    `${waveTop}~${waveBot}`.padEnd(9) + ' |' +
    (sameTop && laneCovers ? '是' : '否').padEnd(5) + ' |' +
    (ok ? '✓' : '✗'));
}

console.log('\n=== 无波形时(应退回纯轨道布局) ===');
for (const h of [120, 240, 420]) {
  const a = mk(h, { showFilm: false, hasPeaks: false, n: 1 });
  const ok = a.waveH === 0 && a.bottom <= h + 0.5 && a.laneH >= LANE_MIN;
  if (!ok) fails.push({ h, reason: '无波形时布局异常' });
  console.log(`  面板=${String(h).padStart(3)} → 波高=${a.waveH} 轨道顶=${a.laneTop} 轨高=${a.laneH} 底=${a.bottom} ${ok ? '✓' : '✗'}`);
}

console.log('\n=== 多轨 ===');
for (const n of [1, 2, 3]) {
  for (const h of [120, 240, 420]) {
    const a = mk(h, { showFilm: false, hasPeaks: true, n });
    const ok = a.bottom <= h + 0.5 && a.laneH >= 10 && a.laneTop === a.lanesTop;
    if (!ok) fails.push({ n, h, reason: '多轨布局异常' });
    console.log(`  轨数=${n} 面板=${String(h).padStart(3)} → 波高=${String(a.waveH).padStart(2)} 轨道顶=${a.laneTop} 轨高=${String(a.laneH).padStart(3)} 底=${String(a.bottom).padStart(3)} ${ok ? '✓' : '✗'}`);
  }
}

console.log('\n' + (fails.length
  ? '== 失败 ' + fails.length + ' ==\n' + fails.map(f => '  ' + JSON.stringify(f)).join('\n')
  : '== 全部通过: 字幕块与波形带同起点、轨道覆盖波形、无溢出 =='));
process.exitCode = fails.length ? 1 : 0;
