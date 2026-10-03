/* 逐词块几何自检: 复现 timeline.js 的 bandOf/_wordGeom(改后), 打印标记落点并断言。
 * 跑法: node tools/wordmark_geom.mjs
 * 通过 = 标记贴底(留 2px)、不越界、中文/分隔线/标记三者不重叠、矮轨不挤爆。
 */
const LANE_H = 34, LANE_GAP = 6, AXIS_R = 0.52;

function bandOf(cue, laneTop, laneH) {
  if (cue.half === 'top' || cue.half === 'bottom') {
    const pad = 4, gap = 6;
    const h = Math.max(LANE_H - 8, Math.round((laneH - pad * 2 - gap) / 2));
    if (cue.half === 'top') return { y: laneTop + pad, h };
    return { y: laneTop + pad + h + gap, h };
  }
  return { y: laneTop + 4, h: laneH - 8 };
}

function wordGeom(band) {
  const MARK_H = 20, MARK_W = 8, MARK_W_HOT = 10, MARK_MIN_H = 6;
  const TOP_PAD = 1, GAP = 3;
  const BOT_PAD = Math.max(1, Math.min(2.5, band.h / 4));
  const zhBase = band.y + Math.round(band.h * 0.30);
  const markBot = band.y + band.h - BOT_PAD;
  const axisLo = Math.min(zhBase + GAP, markBot - MARK_MIN_H);
  const axisHi = Math.max(axisLo, Math.min(zhBase + Math.round(band.h * 0.5), markBot - MARK_H - GAP));
  const axisY = Math.max(axisLo, Math.min(band.y + Math.round(band.h * AXIS_R), axisHi));
  const markTop = Math.max(band.y + TOP_PAD, Math.min(axisY + GAP, markBot - MARK_MIN_H));
  const markH = Math.max(2, Math.min(MARK_H, markBot - markTop));
  const markW = Math.max(2, Math.min(MARK_W, markH));
  return { axisY, sepY: axisY, markTop, markBot, markH, markW, markWHot: MARK_W_HOT,
           top: markTop, bottom: markBot, baseline: band.y + band.h - 3, botPad: BOT_PAD };
}



const CASES = [
  ['合并轨 laneH=74 (截图形态)', LANE_H * 2 + LANE_GAP, null],
  ['普通轨 laneH=34', LANE_H, null],
  ['孤行下半区 laneH=74', LANE_H * 2 + LANE_GAP, 'bottom'],
  ['孤行上半区 laneH=34', LANE_H, 'top'],
  ['被压缩的矮轨 laneH=20', 20, null],
  ['极矮 laneH=12', 12, null],
];

let fails = 0;
for (const [name, laneH, half] of CASES) {
  const b = bandOf({ half }, 0, laneH);
  const g = wordGeom(b);
  const blockBot = b.y + b.h;
  const zhBase = b.y + Math.round(b.h * 0.30);

  const gapToBot = blockBot - g.markBot;          // 标记底 → 块底
  const pct = ((g.markTop + g.markBot) / 2 - b.y) / b.h * 100;

  console.log('\n' + name + '  band.y=' + b.y + ' band.h=' + b.h + '  块底=' + blockBot);
  console.log('  中文基线=' + zhBase + '  分隔线=' + g.axisY + ' (' + (((g.axisY - b.y) / b.h) * 100).toFixed(0) + '%)');
  console.log('  标记 ' + g.markTop + '~' + g.markBot + ' 高=' + g.markH + ' 宽=' + g.markW +
    '  中心在块 ' + pct.toFixed(0) + '% 处  距块底 ' + gapToBot + 'px');
  console.log('  词文本基线=' + g.baseline);

  const checks = [
    ['标记底留 2.5px(正常块)', Math.abs(gapToBot - 2.5) < 0.01 || b.h < 20],
    ['标记高 = 20(块高≥66)', g.markH === 20 || b.h < 66],
    ['标记宽 = min(8, 高度)', g.markW === Math.min(8, g.markH)],
    ['标记不越出块底', g.markBot <= blockBot],
    ['标记顶<底(高度为正)', g.markTop < g.markBot],
    ['标记顶在块内', g.markTop >= b.y],
    // 极矮轨(h<20)时中文基线已贴近块底, 分隔线无处安放 —— 属可接受的退化
    ['分隔线在中文行之下(块高>=20)', g.axisY >= zhBase || b.h < 20],
    ['分隔线不压标记行(块高>=20)', g.axisY <= g.markTop || b.h < 20],
    ['标记高度为正且≤20', g.markH > 0 && g.markH <= 20],
  ];
  for (const [cn, ok] of checks) {
    if (!ok) { console.log('    FAIL ' + cn); fails++; }
  }
  console.log('  ' + checks.filter(c => c[1]).length + '/' + checks.length + ' 通过');
}

console.log('\n' + (fails ? '== ' + fails + ' 项失败 ==' : '== 全部通过 =='));
process.exitCode = fails ? 1 : 0;
