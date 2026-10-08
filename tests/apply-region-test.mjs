/**
 * 重识别写回的范围回归：**段与段之间的内容不能被删掉**。
 *
 * 用户实测报的问题："反思纠错的重新识别选区过大，导致识别后出现大量空缺"。
 *
 * 根因：批量纠错给的是**多个互不相邻**的区间（例如 90~104s、168~181s、191~224s），
 * 而写回用的是 `[首段起点, 末段终点]` 这一个总跨度去"删掉范围内所有行"——
 * 于是段与段之间那些**从未被重识别**的内容也被一起删掉，且永远不会被加回。
 * 实测那次：总跨度 134 秒里只有 67 秒真的重识别过，中间 67 秒全成空缺。
 *
 * 这里不读代码字符串判断"写没写对"，而是**真的跑一遍**：
 * 抽出 applyRecognized / applyRecognizedOnce，桩掉 DOM 相关的四个函数，
 * 然后检查写回后还剩哪些行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

// ── 抽出被测的两个函数 ──
function slice(from, to) {
  const i = SRC.indexOf(from);
  if (i < 0) throw new Error('抽不到: ' + from);
  const j = SRC.indexOf(to, i + from.length);
  if (j < 0) throw new Error('抽不到结束标记: ' + to);
  return SRC.slice(i, j);
}
// 从 applyRecognized 开头，到 applyRecognizedOnce 结束（后面紧跟的是别的函数）
const endMark = SRC.indexOf('\nfunction ', SRC.indexOf('function applyRecognizedOnce'));
const startMark = SRC.indexOf('function snapRegionsToRows(');
if (startMark < 0) throw new Error('抽不到 snapRegionsToRows');
const code = SRC.slice(startMark, endMark);
if (!/function applyRecognizedOnce/.test(code)) throw new Error('抽取范围没覆盖 applyRecognizedOnce');

const modPath = path.join(HERE, '_applyrec.mjs');
fs.writeFileSync(modPath, code + '\nexport { applyRecognized, applyRecognizedOnce, snapRegionsToRows };\n');
const { applyRecognized, snapRegionsToRows } = await import(pathToFileURL(modPath).href);
fs.unlinkSync(modPath);

// ── 桩：把依赖 DOM / 全局 state 的四个函数替换掉 ──
// 用 globalThis 提供，函数体里引用的是同名标识符，所以能生效
let ITEMS = [];
globalThis.state = { selected: null, format: 'srt', assDoc: null };
globalThis.timeline = { clearRangeSel() {}, reRecogRegion: null };
globalThis.reconcileKaraoke = () => {};
globalThis.assPlayer = { updateNow() {} };
globalThis.rebuildItemsAndLanes = () => {};
globalThis.itemsInRange = (a, b) => ITEMS.filter(it => it.start < b && it.end > a);
globalThis.removeItemData = (it) => { ITEMS = ITEMS.filter(x => x !== it); };
globalThis.addRecognizedRow = (seg) => {
  ITEMS.push({ start: seg.start, end: seg.end, text: seg.text });
  return true;
};

/** 造一批行：[start,end) 每行 dur 秒，文本为 L<n> */
function mkRows(n, dur) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ start: i * dur, end: (i + 1) * dur, text: 'L' + (i + 1) });
  return out;
}
const texts = () => ITEMS.slice().sort((a, b) => a.start - b.start).map(x => x.text);
const overlaps = (it, r) => it.start < r.end && it.end > r.start;

console.log('== 1. 单区间（老行为不能坏）==');
{
  ITEMS = mkRows(10, 5);                       // 0~50s，10 行
  const segs = [{ start: 10, end: 20, text: 'NEW-A' }, { start: 20, end: 25, text: 'NEW-B' }];
  const n = applyRecognized(10, 25, segs, null);   // regions 传 null → 等价单区间
  ok(n === 2, '写回 2 行', n);
  const t = texts();
  ok(t.includes('NEW-A') && t.includes('NEW-B'), '新行都在', t);
  ok(!t.includes('L3') && !t.includes('L4') && !t.includes('L5'), '区间内旧行被替换', t);
  ok(t.includes('L1') && t.includes('L2') && t.includes('L6') && t.includes('L10'),
    '区间外旧行保留', t);
}

console.log('\n== 2. 多区间：段与段之间的内容必须原样保留（本次修复的核心）==');
{
  ITEMS = mkRows(20, 5);                       // 0~100s，20 行
  // 三段互不相邻：10~20 / 40~50 / 70~80；中间 20~40、50~70 从未重识别
  const regions = [{ start: 10, end: 20 }, { start: 40, end: 50 }, { start: 70, end: 80 }];
  const segs = [
    { start: 10, end: 15, text: 'R1-a' }, { start: 15, end: 20, text: 'R1-b' },
    { start: 40, end: 45, text: 'R2-a' }, { start: 45, end: 50, text: 'R2-b' },
    { start: 70, end: 75, text: 'R3-a' }, { start: 75, end: 80, text: 'R3-b' },
  ];
  // 老实现会用 [10,80] 这个总跨度 → 中间 20~40、50~70 全被删
  const n = applyRecognized(10, 80, segs, regions);
  ok(n === 6, '写回 6 行', n);
  const t = texts();
  for (const r of regions) {
    for (const x of ['R1', 'R2', 'R3']) { /* 新行检查见下 */ }
  }
  ok(['R1-a', 'R1-b', 'R2-a', 'R2-b', 'R3-a', 'R3-b'].every(x => t.includes(x)),
    '三段的新行都写回了', t);
  // 段内旧行该没
  ok(['L3', 'L4', 'L9', 'L10', 'L15', 'L16'].every(x => !t.includes(x)),
    '三段区间内的旧行被替换掉', t);
  // ★ 段与段之间的行**必须还在**（老实现会全部丢失）
  const gapRows = ['L5', 'L6', 'L7', 'L11', 'L12', 'L13'];
  const missing = gapRows.filter(x => !t.includes(x));
  ok(missing.length === 0, '段与段之间的行全部保留（这就是"空缺"的来源）', missing);
  // 段外远处的行也不能动
  ok(['L1', 'L2', 'L19', 'L20'].every(x => t.includes(x)), '区间之外的行不受影响', t);
}

console.log('\n== 3. 各段只认领自己范围内的识别结果 ==');
{
  ITEMS = mkRows(20, 5);
  const regions = [{ start: 10, end: 20 }, { start: 70, end: 80 }];
  // 故意多给一条落在"缝隙里"的结果（模拟服务端边界抖动），它应归最近的一段而不是被丢掉
  const segs = [
    { start: 10, end: 20, text: 'IN-1' },
    { start: 69, end: 71, text: 'EDGE' },      // 中点 70，正好在第二段边界
    { start: 70, end: 80, text: 'IN-2' },
  ];
  const n = applyRecognized(10, 80, segs, regions);
  ok(n === 3, '三条结果都写回了（边界结果不会被丢）', n);
  const t = texts();
  ok(t.includes('IN-1') && t.includes('IN-2') && t.includes('EDGE'), '内容都在', t);
  // 缝隙里的行不能被删
  ok(t.includes('L5') && t.includes('L10'), '缝隙内的行保留', t);
}

console.log('\n== 4. 降序写回：前面的区间不受后面改动影响 ==');
{
  // 每行时长不同，便于发现"先删前面导致后面下标错位"这类问题
  ITEMS = [];
  let t0 = 0;
  for (let i = 0; i < 20; i++) { const d = 3 + (i % 4); ITEMS.push({ start: t0, end: t0 + d, text: 'L' + (i + 1) }); t0 += d; }
  const regions = [{ start: 0, end: 6 }, { start: t0 - 12, end: t0 }];
  const segs = [
    { start: 0, end: 3, text: 'HEAD-1' }, { start: 3, end: 6, text: 'HEAD-2' },
    { start: t0 - 12, end: t0 - 6, text: 'TAIL-1' }, { start: t0 - 6, end: t0, text: 'TAIL-2' },
  ];
  const n = applyRecognized(0, t0, segs, regions);
  ok(n === 4, '两段各写回 2 行', n);
  const t = texts();
  ok(t[0] === 'HEAD-1' && t[1] === 'HEAD-2', '开头两行在正确位置', t.slice(0, 3));
  ok(t[t.length - 1] === 'TAIL-2' && t[t.length - 2] === 'TAIL-1', '末尾两行在正确位置', t.slice(-3));
}

console.log('\n== 5. 边界情况 ==');
{
  // 没有 regions（老调用点）→ 退化为单区间
  ITEMS = mkRows(10, 5);
  const n = applyRecognized(10, 20, [{ start: 10, end: 20, text: 'X' }], undefined);
  ok(n === 1 && texts().includes('X') && !texts().includes('L3'), 'regions 为 undefined 时退化为单区间');

  // regions 为空数组 → 同样退化
  ITEMS = mkRows(10, 5);
  const n2 = applyRecognized(10, 20, [{ start: 10, end: 20, text: 'Y' }], []);
  ok(n2 === 1 && texts().includes('Y'), 'regions 为空数组时退化为单区间');

  // 识别结果为空 → 只删不加（用户看到的"空缺"就是这种，但至少范围要正确）
  ITEMS = mkRows(20, 5);
  const n3 = applyRecognized(10, 80, [], [{ start: 10, end: 20 }, { start: 70, end: 80 }]);
  ok(n3 === 0, '没有识别结果时写回 0 行');
  const t = texts();
  ok(t.includes('L5') && t.includes('L10'), '此时缝隙内容依然保留（不会因空结果扩大损失）', t);
  ok(!t.includes('L3') && !t.includes('L15'), '只有区间内的行被删', t);

  // 非法的 region（缺字段/时长非正）应被忽略而不是抛错
  ITEMS = mkRows(10, 5);
  const n4 = applyRecognized(10, 20, [{ start: 10, end: 20, text: 'Z' }],
    [{ start: 10 }, { start: 5, end: 5 }, null, { start: 'x', end: 9 }]);
  ok(n4 === 1 && texts().includes('Z'), '非法区间被忽略，不抛错', n4);
}

console.log('\n== 6. 边界吸附：不能"整行被删、只补回一半"（用户报的第二个 bug）==');
{
  /* 删除判定是"只要与区间沾边就删整行"，所以区间边界切在某行中间时，
   * 整行被删而重识别只覆盖了一部分 → 露在外面的那截内容永久丢失。
   * 实测 41 行 / 7 段区间里有 7 行被部分覆盖（最长一行右侧露出 6.51 秒）。 */
  const rows = [
    { start: 0, end: 10, text: 'A' },
    { start: 10, end: 20, text: 'B' },
    { start: 20, end: 30, text: 'C' },
    { start: 30, end: 40, text: 'D' },
  ];
  // 区间 25~40：左边界切在 C 中间 → 必须吸附到 C 的起点 20
  let snapped = snapRegionsToRows([{ start: 25, end: 40 }], rows);
  ok(snapped[0].start === 20, '左边界落在行内 → 吸附到该行起点', snapped[0]);
  ok(snapped[0].end === 40, '右边界正好在行边界 → 不动', snapped[0]);

  // 区间 0~25：右边界切在 C 中间 → 吸附到 C 的终点 30
  snapped = snapRegionsToRows([{ start: 0, end: 25 }], rows);
  ok(snapped[0].end === 30, '右边界落在行内 → 吸附到该行终点', snapped[0]);

  // 边界正好落在行边界上 → 不该乱动
  snapped = snapRegionsToRows([{ start: 10, end: 30 }], rows);
  ok(snapped[0].start === 10 && snapped[0].end === 30, '边界已在行边界上时不改动', snapped[0]);

  // 大部分落在区间内的行 → 一并纳入（不留细碎残行）
  const rows2 = [{ start: 0, end: 10, text: 'A' }, { start: 10, end: 20, text: 'B' }];
  snapped = snapRegionsToRows([{ start: 9, end: 20 }], rows2);   // 只盖住 A 的 1/10
  ok(snapped[0].start === 0, '只沾到一点点的行也吸附（避免留残行）', snapped[0]);

  // 端到端：吸附后不该有行被"部分覆盖"
  ITEMS = mkRows(20, 5);   // 0~100s
  const regions = [{ start: 12, end: 27 }, { start: 61, end: 73 }];   // 故意切在行中间
  const snappedRegs = snapRegionsToRows(regions, ITEMS);
  const partially = ITEMS.filter(r =>
    snappedRegs.some(x => (r.start < x.start && r.end > x.start) || (r.start < x.end && r.end > x.end)));
  ok(partially.length === 0, '吸附后没有任何行被部分覆盖', partially.map(r => r.text));
  // 每个被删的行都完整落在某个区间内
  const segs = [
    { start: 12, end: 27, text: 'S1' }, { start: 61, end: 73, text: 'S2' },
  ];
  applyRecognized(12, 73, segs, regions);
  const t = texts();
  ok(t.includes('S1') && t.includes('S2'), '两段结果都写回', t);
  ok(t.includes('L1') && t.includes('L20'), '首尾不受影响', [t[0], t[t.length - 1]]);
}

console.log('\n== 7. 吸附后必须再求一次并（否则相邻两段会重叠）==');
{
  const rows = mkRows(20, 5);
  // 输入的两段几乎相接；吸附后都会扩到同一个字幕块上 → 必须并起来
  const regions = [{ start: 11, end: 22 }, { start: 23, end: 34 }];
  const snapped = snapRegionsToRows(regions, rows);
  // 吸附本身允许重叠（那是调用方要再求并的原因）
  ok(snapped.length === 2, '吸附本身不负责并区间（职责分离）', snapped);
  // applyRecognized 内部并过之后，实际用于写回的区间必须不重叠
  ITEMS = rows.slice();
  const segs = [{ start: 11, end: 22, text: 'S1' }, { start: 23, end: 34, text: 'S2' }];
  applyRecognized(11, 34, segs, regions);
  const t = texts();
  ok(t.includes('S1') && t.includes('S2'), '两段结果都在（并区间后不会丢）', t);
  // 关键：不能因为重叠而把某一行删两次 / 归错段
  const uniqTexts = new Set(t);
  ok(uniqTexts.size === t.length, '没有重复行（重叠若没并会出现两份）', t);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
