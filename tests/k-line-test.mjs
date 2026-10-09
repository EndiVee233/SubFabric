/**
 * \k 初稿生成端 ↔ 编辑器 一致性测试: node tests/k-line-test.mjs
 *
 * server.js 生成初稿用 editor/k-line.js（CJS）; 编辑器内任何重建用 editor/js/karaoke.js 的
 * buildWordSpecsK（ESM）。两条实现必须产出**同一格式** —— 否则用户打开初稿就会判成漂移。
 *
 * 同时覆盖 k-line.js 自身的边界: 时间夹取/单调防御/行尾兜底/段总和 = 行时长/转义。
 */
import { createRequire } from 'node:module';
import { buildWordSpecs, parseKLine } from '../editor/js/karaoke.js';

const require_ = createRequire(import.meta.url);
const { wordKText } = require_('../editor/k-line.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (got, want, n) => ok(JSON.stringify(got) === JSON.stringify(want), n, { got, want });
/** 从事件文本里把全部 \k 段时长加起来（应严格等于行时长） */
const kSum = (t) => {
  let sum = 0;
  const re = /\\[kK](?:[fo]|t)?\s*(\d+)/g;
  let m; while ((m = re.exec(t))) sum += parseInt(m[1], 10);
  return sum;
};

console.log('========================================');
console.log('\\k 初稿生成端（k-line.js）一致性');
console.log('========================================');

/* ── 1. 基本形状 ── */
{
  const words = [{ word: 'hello', start: 1.0, end: 1.4 }, { word: 'world', start: 1.4, end: 1.8 }];
  const txt = wordKText(words, 1.0, 2.0, '00FF00', 'FFFFFF');
  eq(txt, '{\\1c&H00FF00&\\2c&HFFFFFF&}{\\k40}hello {\\k60}world',
    'golden: 颜色头 + 每词一段（末词已收在句尾, 无需行尾兜底）', txt);
  ok(kSum(txt) === 100, '段时长总和 = 行时长（100cs）');
  // 生成行能被编辑器的解析器无损读回
  const r = parseKLine(txt, 1.0, 2.0);
  eq(r.words.map(w => w.w), ['hello', 'world'], '生成行可被编辑器解析出同样的词');
  eq(r.words.map(w => [Math.round(w.s * 100), Math.round(w.e * 100)]), [[100, 140], [140, 200]],
    '生成行解析出的词时间 = 生成时的夹取结果');
  ok(r.baseHex === '#ffffff' && r.highlightTag === '{\\c&H00FF00&}', '颜色位读回一致');
}
{
  // 无 \2c（该行没有未唱色）→ 不写, 由样式 SecondaryColour 接管
  const txt = wordKText([{ word: 'hi', start: 0, end: 0.5 }], 0, 1.0, '00FF00', '');
  eq(txt, '{\\1c&H00FF00&}{\\k100}hi', 'baseBgr 为空 → 不写 \\2c', txt);
}

/* ── 2. 与编辑器 buildWordSpecsK 的交叉一致性 ──
 * 同一输入（词表 + 句起止 + 两色）分别走两条实现, 明文与词时间必须一致。 */
{
  const mk = (words, start, end, base) => {
    // 编辑器侧模型: 词时间按生成端同一条夹取规则准备（首词贴句首、每词收在下一词起点）
    const ws = words.map((w, i) => ({
      w: w.word,
      s: i === 0 ? start : Math.max(start, Math.min(end, words[i].start)),
      e: i + 1 < words.length ? Math.max(words[i + 1].start, start) : end
    }));
    return {
      style: 'Default', start, end, text: words.map(w => w.word).join(' '), events: [], words: ws,
      proto: { layer: '0', name: '', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } },
      highlightTag: '{\\c&H00FF00&}', karStyle: 'k', kTag: '\\k', kHead: '', kBaseHex: base
    };
  };
  const CASES = [
    [['hello', 1.0, 1.4], ['world', 1.4, 1.8]],
    [['one', 0.0, 0.5], ['two', 0.5, 1.0], ['three', 1.0, 1.5]],
    [['SMP,', 2.0, 2.4], ['plan.to', 2.4, 3.0]],          // 黏连标点
  ];
  for (const toks of CASES) {
    const words = toks.map(([w, s, e]) => ({ word: w, start: s, end: e }));
    const start = toks[0][1], end = toks[toks.length - 1][2] + 0.2;
    const serverText = wordKText(words, start, end, '00FF00', '0B0BE5');
    const editorText = buildWordSpecs(mk(words, start, end, '#e50b0b'))[0].text;
    eq(assPlainTextOf(serverText), assPlainTextOf(editorText),
      '交叉: 两条实现的**明文**一致（' + words.map(w => w.word).join(' ') + '）');
    const a = parseKLine(serverText, start, end).words.map(w => [w.w, Math.round(w.s * 100), Math.round(w.e * 100)]);
    const b = parseKLine(editorText, start, end).words.map(w => [w.w, Math.round(w.s * 100), Math.round(w.e * 100)]);
    eq(b, a, '交叉: 两条实现的词时间一致');
    ok(kSum(serverText) === Math.round((end - start) * 100) && kSum(editorText) === Math.round((end - start) * 100),
      '交叉: 段时长总和都 = 行时长');
  }
  function assPlainTextOf(t) { return t.replace(/\{[^{}]*\}/g, ''); }
}
/* ── 3. 边界 ── */
{
  // 乱序/重叠词时间: 不得产生负时长段, 段总和仍 = 行时长
  const words = [{ word: 'a', start: 1.0, end: 2.0 }, { word: 'b', start: 0.5, end: 1.4 }, { word: 'c', start: 1.2, end: 1.6 }];
  const txt = wordKText(words, 1.0, 2.0, '00FF00', '');
  ok(!/\\k-\d/.test(txt), '乱序词: 不出现负时长段', txt);
  ok(kSum(txt) === 100, '乱序词: 段总和仍 = 行时长', kSum(txt));
  // 词越过句尾 → 夹进句尾
  const txt2 = wordKText([{ word: 'x', start: 0.9, end: 5.0 }], 1.0, 1.5, '00FF00', '');
  ok(kSum(txt2) === 50, '越界词: 夹进行尾（总和 = 50cs）', txt2);
  // 转义: 与颜色切片同一套 escAss —— 花括号/反斜杠变成字面量, \k 标签结构不被破坏
  const txt3 = wordKText([{ word: 'a{b\\c}d', start: 0, end: 0.5 }], 0, 1.0, '00FF00', '');
  ok(txt3.includes('a\\{b\\\\c\\}d') && kSum(txt3) === 100 && (txt3.match(/\\1c&H/g) || []).length === 1,
    '转义: 花括号/反斜杠不破坏标签结构', txt3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
