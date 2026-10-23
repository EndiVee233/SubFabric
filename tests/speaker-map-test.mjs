/* 说话人分离落标注的纯逻辑单测: node tests/speaker-map-test.mjs
 *
 * 覆盖 karaoke.js 的 speakerSpansForRows：
 *   · 每行取重叠最大的分离片段；
 *   · 说话人按**首次出现**重新编号（diarize.py 的组号不按时间顺序）；
 *   · 没有足够重叠的行留空，不硬标；
 *   · 非法片段/行被忽略。
 * 不加载模型、不需要音频。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
/* 与其它前端纯逻辑测试同一套镜像同步：只补齐/更新本族文件，绝不清空目录。 */
fs.mkdirSync(JSMOD, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith('.js')) continue;
  const a = path.join(JSMOD, f), b = path.join(SRC, f);
  if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
}
fs.writeFileSync(path.join(JSMOD, 'package.json'), '{"type":"module"}\n');

const { speakerSpansForRows } = await import('./jsmod/karaoke.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

const rows = [
  { start: 0, end: 2, text: 'A' },
  { start: 2, end: 4, text: 'B' },
  { start: 4, end: 6, text: 'C' },
  { start: 6, end: 8, text: 'D' },
];
/* 组号故意乱序：C 行是 2，A 行是 7 —— 落标注时必须按时间重排成 SPK1/SPK2。 */
const regions = [
  { start: 0.1, end: 1.9, speaker: 7 },
  { start: 2.1, end: 3.9, speaker: 0 },
  { start: 4.1, end: 5.9, speaker: 2 },
  { start: 8.5, end: 9.5, speaker: 1 },       // 不与任何行重叠
];
const r = speakerSpansForRows(rows, regions);
ok(r.picks.length === 3, '只给有重叠的行指派说话人', r.picks.map(p => p.row.text));
ok(r.picks[0].row.text === 'A' && r.picks[0].speaker === 7, '第一行取重叠片段 7');
ok(r.picks[1].row.text === 'B' && r.picks[1].speaker === 0, '第二行取重叠片段 0');
ok(r.picks[2].row.text === 'C' && r.picks[2].speaker === 2, '第三行取重叠片段 2');
ok(r.order.length === 3 && r.order[0] === 7 && r.order[1] === 0 && r.order[2] === 2,
  '说话人按首次出现排序', r.order);

/* 重叠不够（< 50ms）的片段不指派：宁可留空，也不要把别人标到这一行。 */
const short = speakerSpansForRows([{ start: 0, end: 1 }], [{ start: 0.98, end: 1.5, speaker: 4 }]);
ok(short.picks.length === 0 && short.order.length === 0, '重叠不足 50ms 时不指派');

/* 行落在静音里 / 行数据非法 → 跳过。 */
const gaps = speakerSpansForRows(
  [{ start: 1, end: 2 }, null, { start: 3, end: 3 }, { start: 'x', end: 4 }],
  [{ start: 0, end: 0.5, speaker: 1 }]);
ok(gaps.picks.length === 0, '无重叠/非法行不指派', gaps);

/* 一行同时压到两个片段 → 取重叠更大的那个。 */
const best = speakerSpansForRows([{ start: 0, end: 2 }], [
  { start: 0, end: 0.8, speaker: 5 },
  { start: 0.5, end: 2, speaker: 6 },
]);
ok(best.picks.length === 1 && best.picks[0].speaker === 6, '取重叠时长最大的说话人', best.picks);

/* 空输入不抛。 */
const empty = speakerSpansForRows([], []);
ok(empty.picks.length === 0 && empty.order.length === 0, '空输入返回空结果');

if (fail) {
  console.error(`\nspeaker-map: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\nspeaker-map: ${pass} passed, 0 failed`);
