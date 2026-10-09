/* 「把一段字幕并进已有稿件」（多人协作）单测: node tests/region-merge-test.mjs
 *
 * 钉住的约定：
 *   1. 默认**只填空档**：碰到已有字幕不动它，列进 conflicts 让用户决定
 *   2. 平移量是**显式输入**，程序绝不猜
 *   3. 零长行撑到最小宽度（不是丢弃 —— 丢内容比撑宽严重得多），并在总结里说明
 *   4. 源文件时间倒挂要**报出来**，不能默默修好让人以为文件没问题
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
  let stale = !fs.existsSync(marker);
  if (!stale) {
    for (const f of fs.readdirSync(SRC)) {
      if (!f.endsWith('.js')) continue;
      const a = path.join(JSMOD, f), b = path.join(SRC, f);
      if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
    }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true });
    fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();

const M = await import('./jsmod/region-merge.js');
const { planRegionMerge, pickInRange, overlaps, mergeSummary, resolveFillOnly, resolveReplace, rowLabel, MIN_ROW_SEC } = M;

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

console.log('== pickInRange: 只挑区间内的行，**时间不动** ==');
{
  /* 关键前提：协作者交上来的都是**完整时间轴**的字幕，不是从 0 开始的片段。
   * 所以要的只是"把这几十行挑出来"，时间戳原样保留。 */
  const cues = [
    { start: 0, end: 5, lines: ['片头'] },
    { start: 100, end: 105, lines: ['目标段 1'] },
    { start: 105, end: 110, lines: ['目标段 2'] },
    { start: 300, end: 305, lines: ['片尾'] },
  ];
  const picked = pickInRange(cues, 100, 110, true);
  eq(picked.length, 2, '只挑出区间内的 2 行');
  eq(picked.map(c => c.start), [100, 105], '**时间戳原样保留**（不做任何平移）');
  eq(picked.map(c => c.lines[0]), ['目标段 1', '目标段 2'], '内容对');
  const all = pickInRange(cues, null, null, false);
  eq(all.length, 4, '不过滤时全要');
  ok(all[0] !== cues[0], '返回的是副本（调用方可能改动它）');
  eq(pickInRange(null, 0, 10, true).length, 0, 'null 输入不炸');
  // 大小写/乱序输入要按时间排好
  const messy = pickInRange([{ start: 200, end: 201, lines: ['b'] }, { start: 100, end: 101, lines: ['a'] }], 0, 300, true);
  eq(messy.map(c => c.start), [100, 200], '乱序输入按时间排好');
}

console.log('\n== 跨界行整行保留（与创建页的区域导入同一约定）==');
{
  const cues = [{ start: 90, end: 120, lines: ['跨越整个区间的长行'] }];
  const p = planRegionMerge(cues, [], 100, 110);
  eq(p.items.length, 1, '与区间有重叠 → 整行保留');
  eq(p.items[0].start, 90, '起点没被切');
  eq(p.items[0].end, 120, '终点没被切');
  eq(p.items[0].zh, '跨越整个区间的长行', '文字没被切');
}

console.log('\n== 零长行：撑到最小宽度（不是丢弃）==');
{
  const p = planRegionMerge([{ start: 7, end: 7, lines: ['零长行'] }], [], 0, 10);
  eq(p.items.length, 1, '零长行**保留**（丢内容比撑宽严重）');
  ok(Math.abs((p.items[0].end - p.items[0].start) - MIN_ROW_SEC) < 1e-9,
    `撑到 ${MIN_ROW_SEC}s`, { start: p.items[0].start, end: p.items[0].end });
  eq(p.stretched, 1, '计数：1 行被撑宽');
  ok(/零长/.test(mergeSummary(p)), '总结里说明了这件事', mergeSummary(p));
}

console.log('\n== 源文件时间倒挂要报出来 ==');
{
  const p = planRegionMerge([{ start: 20, end: 10, lines: ['倒挂'] }], [], 0, 30);
  eq(p.outOfOrder, 1, '统计出 1 行倒挂');
  ok(/倒挂/.test(mergeSummary(p)), '总结里提醒源文件可能有问题', mergeSummary(p));
}

console.log('\n== overlaps: 边界不算重叠（与 itemsInRange 同容差）==');
ok(overlaps(0, 10, 5, 15), '正常重叠');
ok(overlaps(5, 15, 0, 10), '反向也重叠');
ok(overlaps(0, 10, 10, 20) === false, '贴边不算重叠（前）');
ok(overlaps(10, 20, 0, 10) === false, '贴边不算重叠（后）');
ok(overlaps(2, 3, 0, 10), '被包住');
ok(overlaps(0, 100, 40, 60), '包住别人');

console.log('\n== planRegionMerge: 默认只填空档 ==');
{
  const cues = [
    { start: 0, end: 10, lines: ['别人的', 'x'] },
    { start: 20, end: 25, lines: ['空档行 A', 'gap A'] },
    { start: 25, end: 30, lines: ['空档行 B', 'gap B'] },
    { start: 100, end: 110, lines: ['别人的2', 'y'] },
  ];
  const existing = [{ start: 0, end: 10, text: '别人的' }, { start: 100, end: 110, text: '别人的2' }];
  const p = planRegionMerge(cues, existing, 0, 200);
  ok(p.ok, '计划生成成功');
  eq(p.items.length, 2, '两行空档进 items');
  eq(p.conflicts.length, 2, '两行撞上已有字幕');
  eq(p.items[0].zh, '空档行 A', '主语言（第一行）→ zh');
  eq(p.items[0].en, 'gap A', '副语言 → en');
  // range 覆盖**这一批要处理的所有行**（含冲突行）—— 预览时要让用户看到"会动到多大一块"
  eq(p.range, { start: 0, end: 110 }, '报告覆盖范围（含冲突行）');
  eq(p.stretched, 0, '没有撑宽');
  // ★ 关键：冲突行的内容**没有**被塞进 items —— 静默覆盖是不可接受的
  ok(!p.items.some(r => r.zh === '别人的'), '冲突行没有混进可导入列表');
  eq(p.conflicts[0].with.text, '别人的', '冲突行记录"撞到了谁"（含文字）');
}

console.log('\n== 区间只取一段（协作核心：只并我负责的那段）==');
{
  const cues = [
    { start: 0, end: 5, lines: ['没人负责的片头'] },
    { start: 300, end: 305, lines: ['我负责的第一句'] },
    { start: 305, end: 310, lines: ['我负责的第二句'] },
    { start: 600, end: 605, lines: ['别人负责的片尾'] },
  ];
  // 项目里已经有片头与片尾（别的协作者做的）
  const existing = [{ start: 0, end: 5, text: '片头' }, { start: 600, end: 605, text: '片尾' }];
  const p = planRegionMerge(cues, existing, 290, 320);
  eq(p.picked, 2, '区间内只挑到 2 行');
  eq(p.items.length, 2, '两行都能进（空档）');
  eq(p.conflicts.length, 0, '没撞到别人的');
  eq(p.items.map(r => r.zh), ['我负责的第一句', '我负责的第二句'], '进来的正是我负责的那段');
  ok(!p.items.some(r => /片头|片尾/.test(r.zh)), '区间外的行没有被带进来');
}

console.log('\n== 区间内没有字幕 ==');
{
  const p = planRegionMerge([{ start: 0, end: 5, lines: ['a'] }], [], 100, 200);
  eq(p.picked, 0, 'picked = 0');
  eq(p.items.length, 0, '没有可导入的行');
  eq(p.range, null, '范围为 null');
  ok(/没有字幕/.test(mergeSummary(p)), '总结明确说"这个区间里没有字幕"', mergeSummary(p));
}

console.log('\n== 非法区间要拦下 ==');
{
  eq(planRegionMerge([{ start: 0, end: 1, lines: ['a'] }], [], 50, 10).ok, false, 'end < start → ok=false');
  ok(/必须大于/.test(planRegionMerge([{ start: 0, end: 1, lines: ['a'] }], [], 50, 10).error), '给出原因');
  eq(planRegionMerge([{ start: 0, end: 1, lines: ['a'] }], [], 10, 10).ok, false, 'end == start → ok=false');
}

console.log('\n== 空行 / 空输入 ==');
{
  eq(planRegionMerge([], [], 0, 10).ok, false, '空字幕 → ok=false');
  ok(/没解析出/.test(planRegionMerge([], [], 0, 10).error), '给出原因');
  const p = planRegionMerge([{ start: 1, end: 2, lines: ['   ', ''] }], [], 0, 10);
  eq(p.items.length, 0, '全空白行被丢弃（没有内容可放）');
  eq(p.ok, true, '但计划本身仍是成功的（不是错误）');
  eq(p.range, null, '没有内容时范围为 null');
}

console.log('\n== resolveFillOnly: 只填空档时冲突行整行不做 ==');
{
  const p = planRegionMerge([
    { start: 2, end: 6, lines: ['撞', 'c'] },
    { start: 50, end: 55, lines: ['空', 'f'] },
  ], [{ start: 0, end: 10 }], 0, 100);
  const r = resolveFillOnly(p);
  eq(r.add.length, 1, '只加 1 行');
  eq(r.add[0].zh, '空', '加的是空档那行');
  eq(r.skipped.length, 1, '跳过 1 行');
  eq(r.skipped[0].zh, '撞', '跳过的是冲突行');
}

console.log('\n== resolveReplace: 用户确认覆盖时，给出的删除范围要合并去重 ==');
{
  const p = planRegionMerge([
    { start: 2, end: 6, lines: ['a'] },
    { start: 4, end: 8, lines: ['b'] },
  ], [{ start: 0, end: 10, text: 'x' }], 0, 20);
  const r = resolveReplace(p);
  eq(r.add.length, 2, '两行都加（用户已确认覆盖）');
  eq(r.replace.length, 1, '删除范围合并成 1 段（两行撞的是同一块，不能删两次）');
  eq(r.replace[0], { start: 0, end: 10 }, '删除范围就是被撞的那块');
  // 撞不同块时应是两段
  const p2 = planRegionMerge([
    { start: 2, end: 4, lines: ['a'] },
    { start: 20, end: 24, lines: ['b'] },
  ], [{ start: 0, end: 10 }, { start: 18, end: 30 }], 0, 40);
  const r2 = resolveReplace(p2);
  eq(r2.replace.length, 2, '撞两块 → 两段删除范围');
}

console.log('\n== rowLabel: 预览用的短标签 ==');
{
  eq(rowLabel({ zh: '短' }), '短', '短文本原样');
  ok(rowLabel({ zh: '很长'.repeat(30) }).length <= 34, '长文本被截断到 34 以内');
  ok(rowLabel({ zh: '很长'.repeat(30) }).endsWith('…'), '截断处有省略号');
  eq(rowLabel({ en: 'only en' }), 'only en', '没有 zh 时用 en');
  eq(rowLabel(null), '', 'null 不炸');
  eq(rowLabel({ zh: 'a  b\n c' }), 'a b c', '空白折行压成单空格');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
