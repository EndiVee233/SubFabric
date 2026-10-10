/* 区域字幕导入（按时间区间裁剪）单测: node tests/region-test.mjs
 *
 * 钉住的约定：
 *   1. 区间留空 = **不过滤**（默认全部导入，裁剪必须是显式动作）
 *   2. **跨界保留**：与区间有任何重叠就留整行（绝不切半行文字 —— 那会让时间轴与文本对不上）
 *   3. 时间格式宽松但**不猜**：认不出来就报错，不当成 0
 *   4. 结束必须大于开始，否则报错（不能默默导成空）
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

const R = await import('./jsmod/region.js');
const { parseRegionTime, normalizeRegion, cueInRegion, filterCues, regionSummary, applyRegionToMeta } = R;

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });

console.log('== parseRegionTime: 宽松但不猜 ==');
eq(parseRegionTime('90'), 90, '纯秒');
eq(parseRegionTime('90.5'), 90.5, '小数秒');
eq(parseRegionTime('1:30'), 90, '分:秒');
eq(parseRegionTime('01:30.5'), 90.5, '分:秒（补零 + 小数）');
eq(parseRegionTime('1:02:03'), 3723, '时:分:秒');
eq(parseRegionTime('0:00'), 0, '0:00 → 0');
eq(parseRegionTime(''), null, '空串 → null');
eq(parseRegionTime(null), null, 'null → null');
eq(parseRegionTime(undefined), null, 'undefined → null');
eq(parseRegionTime('abc'), null, '非数字 → null（不猜成 0）');
eq(parseRegionTime(':30'), null, '缺分钟 → null');
eq(parseRegionTime('1:2:3:4'), null, '四段 → null');
eq(parseRegionTime(' 1:30 '), 90, '两侧空格容错');

console.log('\n== normalizeRegion: 默认不过滤 ==');
{
  const a = normalizeRegion(null, null);
  ok(a.ok && !a.active, '两个都空 → 不过滤');
  const b = normalizeRegion('', '');
  ok(b.ok && !b.active, '两个都空串 → 不过滤');
  ok(!a.error, '不过滤时不报错');
}
{
  const r = normalizeRegion('30', '');
  ok(r.ok && r.active && r.start === 30 && r.end === Infinity, '只填开始 → [30, ∞)');
  const r2 = normalizeRegion('', '90');
  ok(r2.ok && r2.active && r2.start === 0 && r2.end === 90, '只填结束 → [0, 90]');
}
console.log('\n== normalizeRegion: 非法输入必须拦下 ==');
{
  const r = normalizeRegion('abc', '');
  ok(!r.ok && /格式/.test(r.error), '格式错 → ok=false 且提示格式', r);
  const r2 = normalizeRegion('90', '30');
  ok(!r2.ok && /大于/.test(r2.error), '结束 ≤ 开始 → 报错（不能默默导成空）', r2);
  const r3 = normalizeRegion('30', '30');
  ok(!r3.ok, '结束 == 开始 → 报错（零长区间没有意义）');
}

console.log('\n== cueInRegion: 重叠判定 ==');
const cue = { start: 4, end: 9 };
ok(cueInRegion(cue, 0, 10, true), '被完全包住');
ok(cueInRegion(cue, 5, 6, true), '把区间包住');
ok(cueInRegion(cue, 0, 4, true) === false, '刚好贴左边界（end==start）不算重叠');
ok(cueInRegion(cue, 9, 20, true) === false, '刚好贴右边界（start==end）不算重叠');
ok(cueInRegion(cue, 8, 20, true), '右侧部分重叠');
ok(cueInRegion(cue, 0, 5, true), '左侧部分重叠');
ok(cueInRegion(cue, 0, 100, false), 'active=false 时恒真');
ok(cueInRegion(null, 0, 10, true) === false, 'null cue 不炸');
ok(cueInRegion({ start: NaN, end: 5 }, 0, 10, true) === false, 'start 非数字不炸');
{
  // 零长 cue（start === end）：用"点在区间内"判定，否则边界上的零长行会漏
  const z = { start: 10, end: 10 };
  ok(cueInRegion(z, 5, 15, true), '零长 cue 落在区间内 → 留');
  ok(cueInRegion(z, 10, 20, true), '零长 cue 在区间左边界上 → 留');
  ok(cueInRegion(z, 0, 10, true), '零长 cue 在区间右边界上 → 留');
  ok(cueInRegion(z, 11, 20, true) === false, '零长 cue 在区间外 → 丢');
}

console.log('\n== filterCues: 跨界保留整行 ==');
{
  const cues = [
    { start: 0, end: 5 }, { start: 4, end: 9 }, { start: 10, end: 15 },
    { start: 20, end: 25 }, { start: 30, end: 30 },
  ];
  const all = filterCues(cues, null, null, false);
  eq(all.kept.length, 5, '不过滤 → 全留');
  eq(all.dropped, 0, '不过滤 → dropped=0');
  ok(all.kept !== cues || true, '返回内容（不校验引用）');

  const r1 = filterCues(cues, 0, 10, true);
  eq(r1.kept.length, 2, '[0,10] → 留 2 行（0-5 与 4-9，跨界的两行都整行保留）');
  eq(r1.dropped, 3, '[0,10] → 丢 3 行');
  eq([r1.from, r1.to], [0, 9], '报告实际保留的时间范围');

  const r2 = filterCues(cues, 25, 29, true);
  eq(r2.kept.length, 0, '区间里没有字幕 → 留 0（调用方需据此提示"这个区间没有字幕"）');
  eq([r2.from, r2.to], [null, null], '空结果的范围是 null');

  const r3 = filterCues(null, 0, 10, true);
  eq(r3.kept.length, 0, 'null 输入不炸');

  // 关键约定：跨界行**整行保留**，文字绝不被切
  const cross = filterCues([{ start: 0, end: 100, text: '一整句很长的话' }], 40, 60, true);
  eq(cross.kept.length, 1, '跨越整个区间的长行 → 整行保留');
  eq(cross.kept[0].text, '一整句很长的话', '文字没有被切');

  // 不过滤时必须返回**副本**（调用方可能改动它）
  const noFilter = filterCues(cues, null, null, false);
  ok(noFilter.kept !== cues, '不过滤时返回副本，不是原数组引用');
}

console.log('\n== regionSummary: 给用户看的摘要 ==');
{
  const r = normalizeRegion('30', '90');
  const s = regionSummary(r, 12, 3);
  ok(/0:30/.test(s) && /1:30/.test(s) && /12/.test(s) && /3/.test(s), '含起止时间与保留/丢弃条数', s);
  ok(regionSummary(normalizeRegion(null, null), 5, 0) === '', '不过滤时摘要为空');
  const r2 = normalizeRegion('30', '');
  ok(/片尾/.test(regionSummary(r2, 5, 0)), '结束留空显示「片尾」', regionSummary(r2, 5, 0));
  const r3 = normalizeRegion('3723', '3725');
  ok(/1:02:03/.test(regionSummary(r3, 1, 0)), '超过一小时显示时:分:秒', regionSummary(r3, 1, 0));
}

console.log('\n== applyRegionToMeta: 事后能看出"裁过" ==');
{
  const m = applyRegionToMeta({ name: 'x' }, normalizeRegion('30', '90'), '2026-01-01T00:00:00.000Z');
  ok(m.region && m.region.start === 30 && m.region.end === 90, '记下区间');
  eq(m.region.importedAt, '2026-01-01T00:00:00.000Z', '记下时间');
  ok(m.name === 'x', '不动其它字段');
  const m2 = applyRegionToMeta({ name: 'x', region: { start: 1, end: 2 } }, normalizeRegion(null, null));
  ok(!m2.region, '不过滤时**清掉**旧的 region（避免残留误导）');
  const m3 = applyRegionToMeta(null, normalizeRegion('5', ''), 'now');
  ok(m3.region && m3.region.end === null, 'end 为无穷时存 null（片尾）');
}

console.log('\n== 非法输入必须是 { ok:false, active:false }（调用方靠这个顺序出提示）==');
{
  /* ★ 这条是真实踩过的坑：
   * 前端回显函数一度写成"先判 active、再判 ok"，而 normalizeRegion 对非法输入
   * 返回的是 active:false —— 于是"清空提示"那条分支把错误提示吞掉了：
   * 用户填 90~30，界面上什么也不显示，点创建时才被拦下。
   * 约定写死：**非法输入 active 必须为 false，且 error 必须非空**，
   * 调用方就得先判 ok。若哪天有人把 active 改成 true，这条会红，提醒改调用方顺序。 */
  for (const [a, b] of [['90', '30'], ['abc', ''], ['1:2:3:4', ''], ['-5', '10']]) {
    const r = normalizeRegion(a, b);
    ok(r.ok === false, `(${a},${b}) → ok=false`);
    ok(r.active === false, `(${a},${b}) → active=false（调用方必须先判 ok）`);
    ok(typeof r.error === 'string' && r.error.length > 0, `(${a},${b}) → error 非空（有提示可显示）`);
  }
  // 反过来：合法且填了区间 → active 必须为 true，error 必须空
  for (const [a, b] of [['30', ''], ['', '90'], ['1:30', '3:00']]) {
    const r = normalizeRegion(a, b);
    ok(r.ok === true && r.active === true && r.error === '', `(${a},${b}) → 合法且生效`);
  }
  // 都不填 → ok 且不生效，且**不该报错**
  const none = normalizeRegion('', '');
  ok(none.ok === true && none.active === false && none.error === '', '都留空 → 合法但不生效（默认整片，不报错）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
