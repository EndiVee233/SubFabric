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
const A = K.allocateWordTimes;

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

/* 新增/重算逐词时间按字母数加权："i can do it" = 1:3:2:2。 */
{
  const weighted = A(['i', 'can', 'do', 'it'], 0, 8);
  ok(weighted.map(x => x.s) .every((v, i) => Math.abs(v - [0, 1, 4, 6][i]) < 1e-6),
    '新增逐词按字母数计算起点', j(weighted));
  ok(weighted.map(x => x.e).every((v, i) => Math.abs(v - [1, 4, 6, 8][i]) < 1e-6),
    '新增逐词按字母数计算终点', j(weighted));
  const changedText = K.recalcWords({ words: weighted, start: 0, end: 8 }, 'i can do it', 0, 8);
  ok(j(changedText) === j(weighted), '同文本重算保持已确认词级时间');
  const changedWord = K.recalcWords({ words: weighted, start: 0, end: 8 }, 'i longer do it', 0, 8);
  ok(changedWord.length === 4
    && Math.abs(changedWord[0].e - 8 / 11) < 1e-6
    && Math.abs(changedWord[1].e - 56 / 11) < 1e-6
    && Math.abs(changedWord[2].e - 72 / 11) < 1e-6
    && changedWord[3].e === 8,
    '改字幕即使词数不变也按新字母数重分配', j(changedWord));
}

/* 拖动字幕块（只改时间、不改文本）→ 按原相对位置缩放，保住每词真实时长。
   曾经这里与"改文本"共用同一分支、按字母数重铺，拖动后词时长全乱（用户反馈）。 */
{
  const sent = { start: 10, end: 14, text: 'alpha beta gamma delta', words: [
    { w: 'alpha', s: 10.0, e: 10.4 }, { w: 'beta', s: 10.4, e: 11.6 },
    { w: 'gamma', s: 11.6, e: 12.0 }, { w: 'delta', s: 12.0, e: 14.0 },
  ] };
  const moved = K.recalcWords(sent, sent.text, 10.3, 14.3);
  ok(moved.every((w, i) => Math.abs((w.e - w.s) - (sent.words[i].e - sent.words[i].s)) < 1e-6),
    '整块平移：每词时长不变', j(moved));
  ok(Math.abs(moved[0].s - 10.3) < 1e-6 && Math.abs(moved[3].e - 14.3) < 1e-6,
    '整块平移：首词/末词贴到新边界', j(moved));
  const resized = K.recalcWords(sent, sent.text, 9.5, 14.5);
  ok(Math.abs((resized[1].e - resized[1].s) - 1.2 * 1.25) < 1e-6,
    '整块拉长：每词时长按比例缩放', j(resized));
}

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

/* 普通 ASS 显式转换的边界：只有用户选定样式的英文整句才能进入重建。 */
{
  const base = { style: 'Default', text: 'I just got24 iron', start: 1, end: 3,
    events: [{ text: 'I just got24 iron' }], words: [] };
  ok(K.eligibleForWordConversion(base, 'Default'), '明确选择样式后英文整句可转换');
  ok(!K.eligibleForWordConversion(base, ''), '未明确选择英文样式时跳过');
  ok(!K.eligibleForWordConversion(base, '中文字幕'), '不同样式不被转换');
  ok(!K.eligibleForWordConversion({ ...base, text: '你好 world' }, 'Default'), '即使误选同样式也跳过中文');
  ok(!K.eligibleForWordConversion({ ...base, words: [{ w: 'I', s: 1, e: 2 }] }, 'Default'), '已转换句不重复转换');
  ok(!K.eligibleForWordConversion({ ...base, events: [{ text: '{\\k20}I just got24 iron' }] }, 'Default'), '传统 k 特效行不覆盖');
  ok(!K.eligibleForWordConversion({ ...base, events: [{ text: '{\\c&H00FF00&}I just got24 iron' }] }, 'Default'),
    '保留带内联色标的普通 ASS 行，不覆盖既有特效');
  const words = K.recalcWords(base, base.text, base.start, base.end);
  ok(j(words.map(x => x.w)) === j(['I', 'just', 'got', '24', 'iron'])
    && words[0].s === 1 && words.at(-1).e === 3, '普通 ASS 转换复用英数保护和整句时长');
  const same = K.recalcWords({ ...base, words, text: base.text }, base.text, 1, 3);
  ok(same.every((w, i) => Math.abs(w.s - words[i].s) < 1e-6 && Math.abs(w.e - words[i].e) < 1e-6),
    '文本不变时保持原词时间');
  const renamed = K.recalcWords({ ...base, words, text: base.text }, 'We just got24 iron', 1, 3);
  ok(renamed.length === words.length && renamed.some((w, i) => Math.abs(w.e - words[i].e) > 1e-6),
    '词数不变但文本改变时按新字母数重分配');
  const changed = K.recalcWords({ ...base, words, text: base.text }, 'We got 24 iron today now', 1, 3);
  ok(changed.length === 6 && changed[0].s === 1 && changed.at(-1).e === 3,
    '词数变化后仍按现有分配策略铺满句时长');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
