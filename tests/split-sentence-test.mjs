/* 分句切点单测: node tests/split-sentence-test.mjs
 * 用户报的 bug: 光标在 "all of wood,need to build my house|oh my god" 按 Ctrl+回车,
 * 期望切成 "…my house" / "oh my god", 实际切成 "…my house oh" / "my god"。
 * 根因: 词数按空格数(10), 而切点 k 来自规范分词(11) → 错位一个词。 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const { EditorPanel } = require_('../editor/js/editor.js');
const K = require_('../editor/js/karaoke.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };
/* _splitPoint 不依赖 this，直接借类原型调 */
const splitPoint = (text, caret) => EditorPanel.prototype._splitPoint.call({}, text, caret);
/* 复刻修好后的 splitRowAt 取文本的方式 */
const halves = (text, caret) => {
  const sp = splitPoint(text, caret);
  if (!sp) return null;
  return { k: sp.k, sp: sp.sp, a: text.slice(0, sp.sp).trim(), b: text.slice(sp.sp).trim() };
};

const TEXT = 'all of wood,need to build my house oh my god';   // 光标在 house 后 = 偏移 34
const CARET = 34;

/* ── 用户那个例子 ── */
{
  const h = halves(TEXT, CARET);
  ok(h !== null, '能算出切点');
  ok(h.a === 'all of wood,need to build my house', '前半 = "…my house"（不再多吃一个 oh）', JSON.stringify(h.a));
  ok(h.b === 'oh my god', '后半 = "oh my god"', JSON.stringify(h.b));
  ok(h.k === 8, '词数 k = 8（规范分词口径）', h.k);
  // sp 的语义是"第 k 个词结束、并跳过其后的空白"，所以是 35；按语义断言更稳
  ok(TEXT.slice(0, h.sp).trimEnd().endsWith('house') && TEXT.slice(h.sp).startsWith('oh'),
    '字符切点落在 house 之后、oh 之前', h.sp + ' → ' + JSON.stringify(TEXT.slice(h.sp - 3, h.sp + 3)));
  // 关键不变量：两半的词数必须等于 k / 总数-k —— 词级时间就是按这个分配的
  ok(K.splitEnglishWords(h.a).length === h.k, '前半词数 == k', K.splitEnglishWords(h.a).length + ' vs ' + h.k);
  ok(K.splitEnglishWords(h.b).length === K.splitEnglishWords(TEXT).length - h.k, '后半词数 == 总数 - k');
  ok(K.splitEnglishWords(TEXT).length === 11, '规范分词把 "wood,need" 算两个词（共 11）', K.splitEnglishWords(TEXT).length);
  ok(TEXT.split(' ').length === 10, '按空格数只有 10 个 —— 正是错位的来源');
}

/* ── 逗号黏连处切 ── */
{
  const h = halves(TEXT, 12);                       // 光标紧跟 "wood," 之后
  ok(h.a === 'all of wood,' && h.k === 3, '逗号黏连处切: 前半 = "all of wood,"', JSON.stringify([h.a, h.k]));
  ok(h.b === 'need to build my house oh my god', '后半从 need 开始', JSON.stringify(h.b));
  ok(K.splitEnglishWords(h.a).length === 3, '前半词数 3');
}

/* ── 光标在词中间 → 该词归前半 ── */
{
  const h = halves(TEXT, 22);                       // 落在 "build" 中间
  ok(h.k === 6, '光标在词中间时该词归前半（k=6）', h.k);
  ok(h.a === 'all of wood,need to build', '前半到 build 结束', JSON.stringify(h.a));
}

/* ── 边界: 行首 / 行尾 ── */
{
  const h0 = halves(TEXT, 0);
  ok(h0.k === 1 && h0.a === 'all', '光标在行首 → 只切出第一个词', JSON.stringify([h0.k, h0.a]));
  const hEnd = halves(TEXT, TEXT.length);
  ok(hEnd.k === 10, '光标在行尾 → k = 总数-1（后半非空）', hEnd.k);
  ok(hEnd.b === 'god', '行尾切: 后半只剩最后一个词', JSON.stringify(hEnd.b));
}

/* ── 无空格逗号对: "a,b c" ── */
{
  const h = halves('a,b c', 2);
  ok(h.k === 1 && h.a === 'a,' && h.b === 'b c', 'a,|b c 切得对', JSON.stringify([h.a, h.b]));
}

/* ── 只有一两个词时不该切 ── */
{
  ok(splitPoint('word', 2) === null, '只有一个词 → 不切（返回 null）');
  const two = splitPoint('aa bb', 2);
  ok(two && two.k === 1, '两个词 → k=1', JSON.stringify(two));
}

/* ── 切完两半拼回去要等于原文（只差空白） ── */
{
  const h = halves(TEXT, CARET);
  ok((h.a + ' ' + h.b).replace(/\s+/g, ' ') === TEXT.replace(/\s+/g, ' '), '两半拼回 = 原文', JSON.stringify(h.a + ' | ' + h.b));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
