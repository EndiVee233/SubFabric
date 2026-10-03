/* 字幕块可见性回归验证: 扫遍各种面板高度 × 轨数 × 有无波形,
 * 断言"轨道底不超过面板高"且"轨道高不低于 _laneMinH"。
 * 这正是本次回归的根因: 固定 64px 波形带把轨道顶出面板 → 字幕块整条消失。
 * 跑法: node tools/lane_visible.mjs
 */
const FILM_H = 46, RULER_H = 20, WAVE_H = 64, WAVE_MIN = 22, WAVE_GAP = 4;
const LANE_H = 34, LANE_GAP = 6, LANE_MIN = 24;

/* ── 逐字复现 editor/js/timeline.js 的布局函数(改一处这里也要改) ── */
function mk(cssH, { showFilm, hasPeaks, n }) {
  const laneMinH = () => LANE_MIN;
  const filmHint = () => (!showFilm ? 0
    : (cssH >= FILM_H + RULER_H + 6 + WAVE_H + WAVE_GAP + LANE_H * 2 ? FILM_H : 0));
  const waveH = () => {
    if (!hasPeaks) return 0;
    const nn = Math.max(1, n);
    const fixed = filmHint() + RULER_H + 6 + WAVE_GAP;
    const need = fixed + nn * laneMinH() + (nn - 1) * LANE_GAP;
    const spare = cssH - need;
    const hh = Math.max(0, Math.min(WAVE_H, spare));
    return hh >= WAVE_MIN ? hh : 0;
  };
  const filmH = () => (!showFilm ? 0
    : (cssH >= FILM_H + RULER_H + 6 + waveH() + WAVE_GAP + LANE_H * 2 ? FILM_H : 0));
  const lanesTop = () => filmH() + RULER_H + 6 + waveH() + WAVE_GAP;
  const laneH = (i) => {
    const lanes = [{ merged: true }];
    const nn = Math.max(1, n);
    const avail = Math.max(10, cssH - lanesTop() - (nn - 1) * LANE_GAP);
    const ideal = LANE_H * 2 + LANE_GAP;
    if (nn === 1) {
      if (avail < ideal) return Math.max(10, Math.floor(avail));
      return Math.max(ideal, Math.floor(avail));
    }
    return Math.max(10, Math.floor(avail / nn));
  };
  const laneTop = (i) => { let y = lanesTop(); for (let k = 0; k < i; k++) y += laneH(k) + LANE_GAP; return y; };
  const lanesBottom = () => (n ? laneTop(n - 1) + laneH(n - 1) : lanesTop());
  return { waveH: waveH(), filmH: filmH(), lanesTop: lanesTop(), laneH: laneH(0), laneTop: laneTop(0), bottom: lanesBottom() };
}

/* ── 关键: 修复前(固定 64px)的行为, 用来对照 ── */
function before(cssH, hasPeaks) {
  const waveH = hasPeaks ? WAVE_H : 0;
  const filmH = 0;                       // 胶片关(最常见)
  const top = filmH + RULER_H + 6 + waveH + WAVE_GAP;
  const avail = Math.max(10, cssH - top);
  const ideal = LANE_H * 2 + LANE_GAP;
  const lh = avail < ideal ? Math.max(10, Math.floor(avail)) : Math.max(ideal, Math.floor(avail));
  return { top, lh, bottom: top + lh };
}

const HEIGHTS = [60, 80, 100, 104, 120, 140, 160, 180, 200, 240, 280, 320, 360, 420, 500, 600];
const fails = [];
console.log('面板高 | 修复前: 轨道顶/轨高/底  | 修复后: 波高/轨道顶/轨高/底 | 结果');
console.log('-'.repeat(92));
for (const h of HEIGHTS) {
  const b = before(h, true);
  const a = mk(h, { showFilm: false, hasPeaks: true, n: 1 });
  const bFits = b.bottom <= h + 0.5 && b.lh >= LANE_MIN;
  const aFits = a.bottom <= h + 0.5 && a.laneH >= LANE_MIN;
  if (!aFits) fails.push({ h, a, reason: !a.bottom ? '轨道超出面板' : '轨高过小' });
  console.log(
    String(h).padStart(6) + '  | ' +
    `${String(b.top).padStart(3)}/${String(b.lh).padStart(3)}/${String(b.bottom).padStart(3)} ${bFits ? '✓' : '✗字幕块消失'} | ` +
    `${String(a.waveH).padStart(3)}/${String(a.laneTop).padStart(3)}/${String(a.laneH).padStart(3)}/${String(a.bottom).padStart(3)} ${aFits ? '✓' : '✗'} | ` +
    (bFits ? '' : '←修复前坏 '));
}

console.log('\n=== 其它组合 ===');
for (const n of [1, 2, 3]) {
  for (const hasPeaks of [true, false]) {
    for (const h of [100, 160, 240, 420]) {
      const a = mk(h, { showFilm: false, hasPeaks, n });
      const bad = a.bottom > h + 0.5;
      if (bad) fails.push({ h, n, hasPeaks, reason: '多轨时轨道超出面板' });
      console.log(`  轨数=${n} 有波形=${hasPeaks ? 'Y' : 'N'} 面板=${String(h).padStart(3)} → ` +
        `波高=${String(a.waveH).padStart(3)} 轨顶=${String(a.laneTop).padStart(3)} 轨高=${String(a.laneH).padStart(3)} 底=${String(a.bottom).padStart(3)} ${bad ? '✗' : '✓'}`);
    }
  }
}

/* 胶片开启的情况 */
console.log('\n=== 胶片开启 ===');
for (const h of [200, 320, 420, 600]) {
  const a = mk(h, { showFilm: true, hasPeaks: true, n: 1 });
  const bad = a.bottom > h + 0.5;
  if (bad) fails.push({ h, reason: '开胶片时轨道超出面板' });
  console.log(`  面板=${String(h).padStart(3)} → 胶片=${a.filmH} 波高=${String(a.waveH).padStart(3)} 轨顶=${String(a.laneTop).padStart(3)} 轨高=${String(a.laneH).padStart(3)} 底=${String(a.bottom).padStart(3)} ${bad ? '✗' : '✓'}`);
}

console.log('\n' + (fails.length
  ? '== 失败 ' + fails.length + ' 项 ==\n' + fails.map(f => '  ' + JSON.stringify(f)).join('\n')
  : '== 全部通过: 任何面板高度下字幕块都可见 =='));
process.exitCode = fails.length ? 1 : 0;
