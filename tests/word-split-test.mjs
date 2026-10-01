/* 英文字幕分词单测: node tests/word-split-test.mjs
 * 规则（用户要求）: 空白 **与 `,` `.` `?` `!`** 都当分隔符 —— 遇到这类标点就"逐词一次";
 * 标点留在前一个词的尾部, 不产生只含标点的孤立切片。 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const K = require_('../editor/js/karaoke.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};
const j = (a) => JSON.stringify(a);
const S = K.splitEnglishWords;

/* 基本: 空白分隔仍然管用 */
ok(j(S('hello world')) === j(['hello', 'world']), '空白分词', j(S('hello world')));
ok(j(S('  hello   world  ')) === j(['hello', 'world']), '多余空白', j(S('  hello   world  ')));
ok(j(S('')) === j([]) && j(S(null)) === j([]), '空值');

/* 标点: 逗号/句号/问号/叹号都切, 标点留在前一个词尾 */
ok(j(S('hello, world')) === j(['hello,', 'world']), '逗号切', j(S('hello, world')));
ok(j(S('plan.to')) === j(['plan.', 'to']), '黏连的句号切(plan.to)', j(S('plan.to')));
ok(j(S('SMP,I')) === j(['SMP,', 'I']), '黏连的逗号切(SMP,I)', j(S('SMP,I')));
ok(j(S('what?really!')) === j(['what?', 'really!']), '问号/叹号切', j(S('what?really!')));
ok(j(S('I just got24 iron bro')) === j(['I', 'just', 'got', '24', 'iron', 'bro']),
  '小写英文词与两位数字间自动补分词边界', j(S('I just got24 iron bro')));
ok(j(S('h264 covid19 iPhone15 gpt35 rtx4090 win64')) ===
  j(['h264', 'covid19', 'iPhone15', 'gpt35', 'rtx4090', 'win64']),
  '常见型号/专名保持不拆', j(S('h264 covid19 iPhone15 gpt35 rtx4090 win64')));
ok(j(S('Dear player of the Unstable SMP,I plan.to nuke Capital City,')) ===
   j(['Dear', 'player', 'of', 'the', 'Unstable', 'SMP,', 'I', 'plan.', 'to', 'nuke', 'Capital', 'City,']),
   '用户报的原句', j(S('Dear player of the Unstable SMP,I plan.to nuke Capital City,')));

/* 连着的标点/省略号: 留在同一个词里, 不产生孤立标点切片 */
ok(j(S('wait... really?')) === j(['wait...', 'really?']), '省略号留在词尾', j(S('wait... really?')));
ok(j(S('what?!')) === j(['what?!']), '?! 连着不切', j(S('what?!')));
ok(j(S('.hidden')) === j(['.hidden']), '行首孤立标点并到后一个词', j(S('.hidden')));
ok(j(S(',hello world')) === j([',hello', 'world']), '行首逗号并到后一个词', j(S(',hello world')));

/* 撇号不切 */
ok(j(S("don't stop")) === j(["don't", 'stop']), '撇号不切', j(S("don't stop")));
ok(j(S("it's a test.")) === j(["it's", 'a', 'test.']), '撇号+句号', j(S("it's a test.")));

/* 分词口径统一: recalcWords 用同一套(词数 = 分词数) */
const sent = { words: [], start: 0, end: 3, text: '' };
const w = K.recalcWords(sent, 'SMP,I plan.to', 0, 3);
ok(w.length === 4 && j(w.map(x => x.w)) === j(['SMP,', 'I', 'plan.', 'to']), 'recalcWords 同口径', j(w.map(x => x.w)));

/* 边界: 纯标点 */
ok(j(S('...')) === j(['...']), '纯标点文本(单块)', j(S('...')));
ok(j(S('a . b')) === j(['a.', 'b']), '空格+标点混合', j(S('a . b')));

/* 带位置的分词: buildWordSpecs 靠它在原文里原位包裹高亮 —— 位置必须与词严格对应 */
{
  const t = 'Dear player of the Unstable SMP,I plan.to nuke Capital City,';
  const sp = K.splitEnglishWordsWithSpans(t);
  ok(sp.length === 12, 'spans 词数 12', String(sp.length));
  ok(sp.every(x => t.slice(x.start, x.end) === x.w), 'spans 的 start/end 与原文一致');
  ok(j(sp.map(x => x.w)) === j(K.splitEnglishWords(t)), 'spans 与 splitEnglishWords 同口径');
}
{
  const t = 'I just got24 iron bro';
  const sp = K.splitEnglishWordsWithSpans(t);
  ok(j(sp.map(x => x.w)) === j(['I', 'just', 'got', '24', 'iron', 'bro']), 'got24 spans 也拆成 got / 24');
  ok(sp.every(x => t.slice(x.start, x.end) === x.w), 'got24 拆分后的字符位置精确');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
