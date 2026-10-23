/* 全片逐词重校对「批量对齐」纯逻辑单测: node tests/realign-batch-test.mjs
 *
 * 覆盖：
 *   · planBatches：相邻行合并、长空档/超 60s/超过 24 行时断开；
 *   · tokenCount 与 align.js 的 tokenize 同口径；
 *   · assignChunkWords：整段词时间按行 token 数切回，逐行 clamp；空结果如实失败。
 * 不加载模型、不需要音频。
 */
'use strict';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../editor/realign-batch.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

const mk = (id, from, to, text) => ({ id, start: from, end: to, from, to, text });

/* ── 1. 分段 ── */
const items = [
  mk(0, 0, 4, 'Hello world'),
  mk(1, 4, 8, 'Second line'),
  mk(2, 20, 24, 'After a long gap'),
  mk(3, 24, 28, 'Still here'),
];
const batches = B.planBatches(items);
ok(batches.length === 2, '空档 > 4s 时断开成两段', batches.map(b => b.members.length));
ok(batches[0].members.length === 2 && batches[1].members.length === 2, '相邻行各合并成一段');
ok(B.tokenCount('Hello world') === 2 && B.tokenCount('  a  b c ') === 3, 'tokenCount 与空白分词一致');

const long = [];
for (let i = 0; i < 70; i++) long.push(mk(i, i * 2, i * 2 + 2, 'w' + i));
const lb = B.planBatches(long);
ok(lb.length === 3 && lb[0].members.length === 24 && lb[2].members.length === 22,
  '每段最多 24 行', lb.map(b => b.members.length));
ok(lb.every(b => b.end - b.start <= B.MAX_CHUNK_SEC + 0.001), '单段跨度不超过 60s');

/* 单行超过 60s：仍保留为独立一段，不丢行 */
const huge = B.planBatches([mk(0, 0, 200, 'long line'), mk(1, 201, 203, 'next')]);
ok(huge.length === 2 && huge[0].members.length === 1, '超长单行独立成段');

/* 非法区间跳过 */
ok(B.planBatches([{ id: 0, from: 5, to: 1, text: 'x' }, null]).length === 0, '非法行不产生段');

/* ── 2. 把整段词切回各行 ── */
const b = B.planBatches([
  mk(0, 0, 2, 'Hello world'),
  mk(1, 2, 4, 'Second line'),
]);
ok(b.length === 1, '两行相邻可合并');
const chunkWords = new Map([[b[0].id, [
  { word: 'Hello', start: 0.1, end: 0.6 },
  { word: 'world', start: 0.7, end: 1.2 },
  { word: 'Second', start: 2.1, end: 2.7 },
  { word: 'line', start: 2.8, end: 3.6 },
]]]);
const assigned = B.assignChunkWords(b, chunkWords);
ok(assigned.get(0).ok && assigned.get(1).ok, '两行都得到有效词');
ok(assigned.get(0).words.map(w => w.w).join(' ') === 'Hello world', '第一行词序正确');
ok(assigned.get(0).words[0].s === 0.1 && assigned.get(0).words[1].e === 1.2, '第一行时间原样保留');
ok(assigned.get(1).words.map(w => w.w).join(' ') === 'Second line', '第二行词序正确');
ok(assigned.get(1).words[0].s >= 2 && assigned.get(1).words[1].e <= 4, '第二行时间落在句内');

/* 空结果 → 每行失败但不抛 */
const empty = B.assignChunkWords(b, new Map([[b[0].id, []]]));
ok(!empty.get(0).ok && !empty.get(1).ok && /没有返回/.test(empty.get(0).note), '空结果标记失败');

/* 单行段：整段词映射回该行 */
const one = B.planBatches([mk(0, 10, 12, 'Only line')]);
const oneAssigned = B.assignChunkWords(one, new Map([[one[0].id, [
  { word: 'Only', start: 10.1, end: 10.6 }, { word: 'line', start: 10.7, end: 11.5 },
]]]));
ok(oneAssigned.get(0).ok && oneAssigned.get(0).words.length === 2, '单行段正常映射');

if (fail) {
  console.error(`\nrealign-batch: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\nrealign-batch: ${pass} passed, 0 failed`);
