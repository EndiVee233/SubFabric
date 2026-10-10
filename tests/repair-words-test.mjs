/* 逐词字幕修复单测: node tests/repair-words-test.mjs
 *
 * 钉住的约定：
 *   1. 正常稿件（没有空行）→ **什么都不做**（0 误报，这是它能自动跑的前提）
 *   2. 损坏形态（逐词行被清空 + 文本跑到同时间戳的另一行）→ 搬回来
 *   3. 任何不确定的情况一律**跳过**，不猜：
 *      · 同时间戳有多条非空行 → 跳过
 *      · 同时间戳的非空行是中文原文 → 跳过（不能把中文搬走）
 *      · 找不到同时间戳的文本 → 跳过
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  /* 镜像同步: 只补齐/更新本族自己的文件, **绝不清空目录** —— jsmod 是两族共用镜像
   * (上游族源 editor/js, fork 族源 editor/), 旧实现 rmSync 清空会顺手删掉另一族的文件,
   * 于是"哪个测试先跑"决定别的测试能不能过(2026-10-10 修复)。内容比对保证镜像恒等于源。 */
  fs.mkdirSync(JSMOD, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
  }
  fs.writeFileSync(marker, '{"type":"module"}\n');
}
ensureJsmod();

const R = await import('./jsmod/repair-words.js');
const { analyzeDamage, planRepair, repairSummary } = R;

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

/** 造一行 */
const row = (start, end, text) => ({ start, end, text });

console.log('== ① 正常稿件：什么都不做（能自动跑的前提）==');
{
  // 中文整句 + 逐词行，全都无空行
  const rows = [
    row(0, 2.32, '\\fn{\\c&HFFFFFF&}Unstable SMP陷入混乱'),
    row(0, 0.19, '{\\c&H00FF00&}The{\\c} unstable SMP is in chaos.'),
    row(0.19, 0.85, 'The {\\c&H00FF00&}unstable{\\c} SMP is in chaos.'),
    row(0.85, 1.52, 'The unstable {\\c&H00FF00&}SMP{\\c} is in chaos.'),
  ];
  const a = analyzeDamage(rows);
  ok(a.damaged === false, '★ 判定为"没有损坏"', a);
  eq(a.stats.husks, 0, '空壳行 0 条');
  const p = planRepair(a);
  eq(p.edits.length, 0, '★ 修改 0 行');
  eq(p.deletes.length, 0, '★ 删除 0 行');
  ok(repairSummary(a, p) === '', '不给用户弹提示');
}

console.log('\n== ② 实测的损坏形态：逐词行被清空、文本跑到同时间戳的另一行 ==');
{
  // 复刻用户文件里那一句的坏法
  const rows = [
    row(0, 2.32, 'Unstable SMP陷入混乱'),          // 中文原文，正常
    row(0, 2.32, ''),                              // 空壳（原本是"句级锚点"）
    row(0, 0.19, 'The unstable SMP is in chaos.'), // 文本被搬到同时间戳的别的行（丢了高亮标签）
    row(0, 0.19, ''),                              // 空壳（原本是第一个词）
    row(0.19, 0.85, 'The unstable SMP is in chaos.'),
    row(0.19, 0.85, ''),
  ];
  const a = analyzeDamage(rows);
  ok(a.damaged === true, '★ 判定为"有损坏"');
  eq(a.stats.matched, 2, '★ 正确配对 2 对（0→0.19 与 0.19→0.85）', a.stats);
  eq(a.stats.unmatched, 1, '句级锚点那条被跳过（同时间戳是中文原文）', a.stats);
  const p = planRepair(a);
  eq(p.edits.length, 2, '修改 2 行');
  eq(p.deletes.length, 2, '删除 2 条副本');
  ok(/已修复 2 行/.test(repairSummary(a, p)), '摘要说清了修了几行', repairSummary(a, p));

  // 应用后的效果
  const after = rows.map(r => r.text);
  for (const e of p.edits) e.row.text = e.text;
  eq(rows.filter(r => r.start === 0 && r.end === 0.19)[0].text, 'The unstable SMP is in chaos.',
    '★ 第一个词那行拿回了文本');
  eq(rows.filter(r => r.start === 0.19)[0].text, 'The unstable SMP is in chaos.',
    '★ 第二个词那行也拿回了文本');
  ok(after.length === rows.length, '没有凭空增删');
}

console.log('\n== ③ 不确定就跳过（三条守卫）==');
{
  console.log('  --- 守卫 A：同时间戳有多条非空行 → 跳过 ---');
  const rowsA = [row(0, 1, ''), row(0, 1, 'aaa'), row(0, 1, 'bbb')];
  const aA = analyzeDamage(rowsA);
  eq(aA.stats.matched, 0, '不配（不唯一）', aA.stats);
  eq(aA.stats.unmatched, 1, '记入跳过', aA.stats);
  ok(/不唯一/.test(aA.skipped[0].why), '说明了原因', aA.skipped[0]);
}
{
  console.log('  --- 守卫 B：同时间戳的非空行是中文原文 → 跳过 ---');
  const rowsB = [row(0, 2, ''), row(0, 2, '这是中文原文')];
  const aB = analyzeDamage(rowsB);
  eq(aB.stats.matched, 0, '不配（会把中文搬走）', aB.stats);
  ok(/中文原文/.test(aB.skipped[0].why), '说明了原因', aB.skipped[0]);
}
{
  console.log('  --- 守卫 C：找不到同时间戳的文本 → 跳过 ---');
  const rowsC = [row(0, 1, ''), row(5, 6, 'elsewhere')];
  const aC = analyzeDamage(rowsC);
  eq(aC.stats.matched, 0, '不配', aC.stats);
  ok(/找不到/.test(aC.skipped[0].why), '说明了原因', aC.skipped[0]);
}

console.log('\n== ④ 一行的文本不会被搬两次（同一来源只用一次）==');
{
  const rows = [row(0, 1, 'only source'), row(0, 1, ''), row(0, 1, '')];
  const a = analyzeDamage(rows);
  // 两条空壳 + 一条非空 → 非空那条"候补唯一"所以第一条拿走；第二条空壳再也找不到 → 跳过
  eq(a.stats.matched, 1, '只有一条空壳能拿到', a.stats);
  eq(a.stats.unmatched, 1, '另一条跳过', a.stats);
}

console.log('\n== ⑤ 健壮性 ==');
{
  eq(analyzeDamage(null).damaged, false, 'null 输入不炸');
  eq(analyzeDamage([]).damaged, false, '空数组不炸');
  const a = analyzeDamage([{ start: NaN, end: 1, text: '' }, row(0, 1, 'x')]);
  ok(a.stats.husks === 0, '时间非法的行被忽略', a.stats);
  // 全是空行（没有来源）
  const a2 = analyzeDamage([row(0, 1, ''), row(2, 3, '')]);
  eq(a2.damaged, false, '全空且无来源 → 不判定为可修复', a2.stats);
}

console.log('\n== ⑥ 摘要文案 ==');
{
  const a = analyzeDamage([row(0, 1, ''), row(0, 1, 'text')]);
  const p = planRepair(a);
  const s = repairSummary(a, p);
  ok(/已修复 1 行/.test(s), '含修复行数', s);
  ok(repairSummary({ damaged: false }, null) === '', '无损坏时不产出文案');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
