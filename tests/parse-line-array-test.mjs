/* 针对「角色栏里出现台词」那个 bug 的回归测试。
 * 根因：模型对"一条含 2~4 句的输入"返回了对应条数的 JSON 数组，
 *       而 parseLineArrayReply 的"逐行兜底"把整行 JSON 原文当成一句译文返回。
 * 运行：node tests/parse-line-array-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseLineArrayReply, unwrapJsonArrayString, numberLines, nextBatchSize, parseNumberedReply } = require('../editor/llm-text.js');

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

console.log('\n【5】回归：空原文行必须占位（提示词第 5 条「原文为空的行输出空行」）');
/* 旧实现无条件丢弃空行 → 行数少 1 → 整批判「格式错误」→ 严格重试与拆半都救不回来，
   现象是「含空行的批次必挂、不含的必过」（用户两篇稿件都复现过）。 */
eq('中间空行占位 n=5', parseLineArrayReply('译文一\n译文二\n\n译文四\n译文五', 5),
  ['译文一', '译文二', '', '译文四', '译文五']);
eq('两个连续空行占位 n=4', parseLineArrayReply('甲\n\n\n丁', 4), ['甲', '', '', '丁']);
eq('首尾多余空行被裁掉 n=2', parseLineArrayReply('\n甲\n乙\n\n', 2), ['甲', '乙']);
/* 已知边界：整段都是空白的回包拿不到行数（stripReasoning 会 trim 掉整段）。
 * 现实里不会出现「一批全是空原文行」——待翻译行本来就是筛过非空的，
 * 所以这里不做特判，避免把「模型只吐了空白」误判成成功。 */
eq('空行 + 不足行数仍判失败', parseLineArrayReply('甲\n\n', 3), null);
eq('空行不影响编号剥离 n=3', parseLineArrayReply('1. 甲\n\n3. 丙', 3), ['甲', '', '丙']);

console.log('\n【6】编号输入 / 按序号归位 / 降批阶梯');
/* 只靠换行时模型容易把两行合成一句；给每行加序号后可以按序号归位，
   即使顺序有偏移也能对上（Cerlancism 的 prefixNumber 同思路）。 */
eq('输入加序号', numberLines(['甲', '乙', '丙']), ['1. 甲', '2. 乙', '3. 丙']);
eq('空行也带序号', numberLines(['甲', '', '丙']), ['1. 甲', '2. ', '3. 丙']);
eq('按序号归位（顺序被打乱）', parseNumberedReply('2. 乙\n1. 甲', 2), ['甲', '乙']);
eq('按序号归位（缺号返回 null）', parseNumberedReply('1. 甲', 2), null);
eq('序号超出范围不算', parseNumberedReply('1. 甲\n9. 乙', 2), null);
eq('重复序号只认第一个', parseNumberedReply('1. 甲\n1. 乙\n2. 丙', 2), ['甲', '丙']);
eq('整体解析走编号路径', parseLineArrayReply('1. 甲\n2. 乙', 2), ['甲', '乙']);
eq('编号之间夹空行仍按编号取回', parseLineArrayReply('1. 甲\n\n2. 乙', 2), ['甲', '乙']);
ok('编号缺失时回退到逐行兜底', JSON.stringify(parseLineArrayReply('甲\n乙', 2)) === '["甲","乙"]');
/* 降批阶梯：一次砍到 1/3 左右，减少失败档位上的无效请求 */
eq('阶梯 100', nextBatchSize(100), 25);
eq('阶梯 50', nextBatchSize(50), 12);
eq('阶梯 25', nextBatchSize(25), 6);
eq('阶梯 6', nextBatchSize(6), 1);
eq('阶梯 2', nextBatchSize(2), 1);
eq('阶梯 1 不会再分', nextBatchSize(1), 1);

console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
