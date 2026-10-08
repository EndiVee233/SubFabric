/**
 * 用**真实**的反思区间，量化两个写回 bug 各会丢多少内容。
 *
 * 交付物（都在"应用选中项"这一步）：
 *   ① 用总跨度 [首段起点, 末段终点] 删行 → 段与段之间从未重识别的内容被删掉
 *   ② 删除判定"沾边就删整行" → 边界上被覆盖一半的行整行删除，露在外面的一截丢失
 *
 * 本脚本对同一份区间，模拟三种写回策略，列出各自会**永久丢失**的行：
 *   A. 修复前（总跨度 + 沾边就删）
 *   B. 只修 ①（逐段 + 沾边就删）
 *   C. 现在（逐段 + 吸附到字幕块边界 + 再求并）
 *
 * 用法: node tools/sim-region-loss.cjs [项目id] [regions.json]
 *   regions.json 为 [{start,end}, …]；省略则用下面的内置样例行。
 */

const fs = require('fs');
const path = require('path');

const PROJ_ID = process.argv[2] || 'p-muzdzirj-gbe6t';
const PROJ = path.join(__dirname, '..', 'projects', PROJ_ID);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const asr = readJson(path.join(PROJ, 'asr.json'));
const rows = (asr.segments || asr).map(s => ({
  start: +s.start, end: +s.end, text: String(s.text || ''),
}));

// 区间：优先读文件，否则用实测那次反思产出的 7 段
const regFile = process.argv[3];
const REGS = regFile
  ? readJson(regFile).map(r => ({ start: +r.start, end: +r.end }))
  : [[0, 29.16], [64.36, 70.11], [73.39, 112.23], [128.23, 141.58],
     [143.98, 163.4], [166.04, 182.29], [184.11, 224.56]].map(([a, b]) => ({ start: a, end: b }));

/** 与 main.js 的 snapRegionsToRows 同一套规则（含 ≥50% 纳入） */
function snap(regions, list) {
  return regions.map(rg => {
    let a = rg.start, b = rg.end;
    for (const r of list) {
      if (r.start < a && a < r.end) a = r.start;
      if (r.start < b && b < r.end) b = r.end;
      const ov = Math.min(b, r.end) - Math.max(a, r.start);
      if (ov > 0 && ov >= (r.end - r.start) * 0.5 && (r.start < a || r.end > b)) {
        a = Math.min(a, r.start); b = Math.max(b, r.end);
      }
    }
    return { start: a, end: b };
  }).sort((x, y) => x.start - y.start);
}
/** 与 applyRecognized 内部一致：吸附后再求并 */
function merge(regs) {
  const out = [];
  for (const r of regs) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** 一组区间覆盖的总时长（先求并再求和，避免重叠重复计数） */
function coverage(list) {
  const s = list.map(x => [x.start, x.end]).sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [a, b] of s) {
    if (!cur) { cur = [a, b]; continue; }
    if (a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else { total += cur[1] - cur[0]; cur = [a, b]; }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * 模拟一次写回。
 *
 * 「永久丢失」按**时间覆盖净减少**来算，而不是"某一行是否被完整覆盖" ——
 * 后者会把**重新分句**（一行被拆成两行、或两行被并成一行）误判成丢内容（实测踩过）。
 * 用户真正关心的也是"有没有一段时间没有字幕了"，那是覆盖问题，不是行数问题。
 */
function simulate(mode, segsPerRegion) {
  const span = [{ start: REGS[0].start, end: REGS[REGS.length - 1].end }];
  let regs = mode === 'A' ? span : REGS;
  if (mode === 'C') regs = merge(snap(regs, rows));
  const del = rows.filter(r => regs.some(x => r.end > x.start + 1e-3 && r.start < x.end - 1e-3));
  // 新结果只可能落在**真实重识别过的音频**里（REGS），不会落在总跨度的缝隙里
  const newSegs = [];
  for (const rg of REGS) {
    const n = segsPerRegion(rg) || 1;
    for (let k = 0; k < n; k++) {
      newSegs.push({
        start: rg.start + (rg.end - rg.start) * (k / n),
        end: rg.start + (rg.end - rg.start) * ((k + 1) / n),
      });
    }
  }
  // 只有"该行所在时间段没有任何新结果"才算真丢
  const lost = del.filter(r => !newSegs.some(g => g.end > r.start + 1e-3 && g.start < r.end - 1e-3));
  const covDel = coverage(del);
  const covNew = coverage(newSegs.filter(g => del.some(r => g.end > r.start && g.start < r.end)));
  return { regs, del, lost, newSegs, covDel, covNew, covLost: Math.max(0, covDel - covNew) };
}

// 每段区间重识别后大约产出多少行：按"平均 5.5 秒一句"估（该稿件实测中位 5.93s）
const segsPerRegion = (rg) => Math.max(1, Math.round((rg.end - rg.start) / 5.5));

const A = simulate('A', segsPerRegion);
const B = simulate('B', segsPerRegion);
const C = simulate('C', segsPerRegion);

console.log(`  稿件 ${PROJ_ID}：${rows.length} 行，全片 ${rows[rows.length - 1].end.toFixed(1)}s`);
console.log(`  区间 ${REGS.length} 段，真实重识别 ${REGS.reduce((s, x) => s + (x.end - x.start), 0).toFixed(1)}s`);
console.log(`  首尾总跨度 ${(REGS[REGS.length - 1].end - REGS[0].start).toFixed(1)}s\n`);

const line = (name, r) =>
  console.log(`  ${name.padEnd(26)} 删除 ${String(r.del.length).padStart(3)} 行   ` +
    `补回约 ${r.covNew.toFixed(0).padStart(3)}s   净丢约 ${r.covLost.toFixed(1).padStart(5)}s   ` +
    `完全没字幕的行 ${String(r.lost.length).padStart(2)} 行`);

console.log('  写回策略对比：');
line('A 修复前（总跨度）', A);
line('B 只修段间（逐段）', B);
line('C 现在（逐段+吸附+并）', C);
console.log('');
console.log(`  A → C：净丢内容 ${A.covLost.toFixed(1)}s → ${C.covLost.toFixed(1)}s，少了 ${(A.covLost - C.covLost).toFixed(1)}s`);
console.log('  （C 剩下的净丢来自"吸附把区间边界向外挪"：挪出去的那点音频没被重识别，');
console.log('    但对应行被整行替换成了新结果 —— 这是为了不出现"半截行"付的代价，量很小）');

const show = (title, list) => {
  if (!list.length) { console.log(`\n  ${title}: （无）`); return; }
  console.log(`\n  ${title}:`);
  for (const r of list) {
    const i = rows.indexOf(r) + 1;
    console.log(`    行 ${String(i).padStart(3)}  ${r.start.toFixed(1).padStart(7)}~${r.end.toFixed(1).padStart(7)}s  ${r.text.slice(0, 50)}`);
  }
};
show('A 会丢内容的行（修复前）', A.lost);
show('C 仍会丢内容的行（现在）', C.lost);
