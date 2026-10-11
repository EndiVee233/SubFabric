/* 针对「角色栏里出现台词」那个 bug 的回归测试。
 * 根因：模型对"一条含 2~4 句的输入"返回了对应条数的 JSON 数组，
 *       而 parseLineArrayReply 的"逐行兜底"把整行 JSON 原文当成一句译文返回。
 * 运行：node tests/parse-line-array-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseLineArrayReply, unwrapJsonArrayString } = require('../editor/llm-text.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ★ ' + name + '\n      得到 ' + g + '\n      期望 ' + w); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ★ ' + name); }
}

console.log('\n【1】复现原 bug：n=1，模型给了 4 个元素的 JSON 数组');
// 这条输入是 "I should be winning so hard Like, this shouldn\'t even be a close fight He\'sp, wech Oh, bro"
const raw4 = '["我应该赢得毫无悬念","这根本不该是场势均力敌的较量","他呃，我们","哦，兄弟"]';
/* ⚠ 这两条断言的**期望值**当初写错了（写成了修复前的行为），已按修复后的正确行为改写：
 *   修复后，元素数(4) ≠ 预期行数(1) 时**返回 null** —— 也就是明确报"格式不合规"，
 *   交给上层换严格提示词重试。**绝不能**把 JSON 原文当成一句译文返回（那正是本 bug）。 */
const r1 = parseLineArrayReply(raw4, 1);
eq('元素数与输入行数对不齐时返回 null（明确报格式错，而不是把 JSON 原文当译文）', r1, null);
ok('返回的不是"整串 JSON 当一句译文"', !(Array.isArray(r1) && r1.some(x => String(x).includes('["'))));
console.log('      实际 = ' + JSON.stringify(r1));

console.log('\n【2】n 与元素数一致时直接采用');
eq('4 元素 / n=4', parseLineArrayReply(raw4, 4), ['我应该赢得毫无悬念', '这根本不该是场势均力敌的较量', '他呃，我们', '哦，兄弟']);

console.log('\n【3】原样的数组字符串落进单行分支时也必须剥壳');
eq('unwrap 基本用例', unwrapJsonArrayString('["甲","乙"]'), '甲 乙');
eq('unwrap 非数组不动', unwrapJsonArrayString('这是普通译文'), '这是普通译文');
eq('unwrap 合法含方括号的译文不动', unwrapJsonArrayString('[译者注] 这里说的是铁砧'), '[译者注] 这里说的是铁砧');
eq('unwrap 非法 JSON 不动', unwrapJsonArrayString('["没闭合"'), '["没闭合"');
eq('unwrap 元素非字符串不动', unwrapJsonArrayString('[1,2,3]'), '[1,2,3]');

console.log('\n【4】回归：不要改坏原本正常的形态');
eq('标准数组 n=2', parseLineArrayReply('["甲","乙"]', 2), ['甲', '乙']);
eq('json 围栏 n=2', parseLineArrayReply('```json\n["甲","乙"]\n```', 2), ['甲', '乙']);
eq('逐行纯文本 n=2', parseLineArrayReply('甲\n乙', 2), ['甲', '乙']);
eq('带编号的逐行 n=2', parseLineArrayReply('1. 甲\n2. 乙', 2), ['甲', '乙']);
eq('多行数组 n=3', parseLineArrayReply('[\n  "甲",\n  "乙",\n  "丙"\n]', 3), ['甲', '乙', '丙']);
eq('思考块被剥掉 n=2', parseLineArrayReply('<think>想一下</think>\n甲\n乙', 2), ['甲', '乙']);
eq('行数不符时返回 null', parseLineArrayReply('甲\n乙\n丙', 2), null);
eq('译文含方括号不被误当角色标签', parseLineArrayReply('["[译者注] 甲"]', 1), ['[译者注] 甲']);

console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
