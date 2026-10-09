/* 分段导入后的**逐词格式**回归测试: node tests/region-import-format-test.mjs
 *
 * 钉住用户报过的 bug：「导入后逐词字幕格式损坏」。
 *
 * 根因：`addRecognizedRow` 只在 ASR 给了 `seg.words`（真实词级时间）时才铺逐词 span。
 * 分段导入进来的行**没有词级时间**（字幕文件里只有整句起止），于是：
 *   · 原来的行为 = 不铺 → 英文行成了**纯整句**，在逐词稿里那一行格式就是坏的
 *   · 现在的行为 = 调 recalcWords 在**句内均匀铺满**（karaoke.js 里对
 *     "原本不是逐词句（如刚插入的新行）"就是这么处理的）
 *
 * 这里直接在 karaoke.js 的纯函数上验证"没有词级时间也能得到合法的逐词切片"，
 * 不依赖浏览器（DOM 那部分由 CDP 用例覆盖）。
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
  let stale = !fs.existsSync(marker);
  if (!stale) {
    for (const f of fs.readdirSync(SRC)) {
      if (!f.endsWith('.js')) continue;
      const a = path.join(JSMOD, f), b = path.join(SRC, f);
      if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
    }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true });
    fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();

const K = await import('./jsmod/karaoke.js');
const { recalcWords, buildWordSpecs, splitEnglishWords, wordHighlightTag, setWordHighlightColor } = K;

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

/** 造一个"刚插入的新行"（与 addRecognizedRow 里 appendSentence 的产物同构） */
function newSentence(style, start, end, text) {
  return {
    style, start, end, text,
    words: [],                                  // ★ 没有 ASR 词级时间
    events: [{ text, style, start, end, lineIdx: 0 }],
    proto: { layer: '0', name: '', effect: '', margins: { l: 0, r: 0, v: 0 }, style },
    highlightTag: wordHighlightTag(),
  };
}

console.log('== 没有词级时间也能铺出逐词（这是修的那个 bug）==');
{
  const s = newSentence('英文逐词', 120, 123, 'first imported line');
  const words = recalcWords(s, s.text, s.start, s.end);
  eq(words.length, 3, '3 个词都拿到了时间片');
  eq(words.map(w => w.w), ['first', 'imported', 'line'], '词序与文本一致');
  ok(words[0].s >= 120 - 1e-6, '首词不早于句首', words[0]);
  ok(Math.abs(words[words.length - 1].e - 123) < 1e-6, '末词结束贴齐句尾', words[words.length - 1]);
  // 严格递增、不重叠（normalizeWords 的约定）
  let mono = true;
  for (let i = 1; i < words.length; i++) if (words[i].s < words[i - 1].e - 1e-9) mono = false;
  ok(mono, '词片严格不重叠', words);
  let cover = true;
  for (let i = 1; i < words.length; i++) if (Math.abs(words[i].s - words[i - 1].e) > 1e-6) cover = false;
  ok(cover, '词片首尾相接（中间没有空档 → 高亮不会闪断）', words);
  // 句内均分：每片时长应当相等（这就是"均匀铺满"）
  const durs = words.map(w => w.e - w.s);
  const spread = Math.max(...durs) - Math.min(...durs);
  ok(spread < 0.02, '时长基本均分（均匀铺满）', durs);
}

console.log('\n== 铺出来的切片能生成合法的逐词事件 ==');
{
  const s = newSentence('英文逐词', 120, 123, 'first imported line');
  s.words = recalcWords(s, s.text, s.start, s.end);
  const specs = buildWordSpecs(s);
  eq(specs.length, 3, '生成 3 条 Dialogue spec（每词一条）');
  for (const sp of specs) ok(!!sp.start && !!sp.end && sp.end > sp.start, `事件时间合法: ${sp.text}`, sp);
  ok(specs.every(sp => sp.style === '英文逐词'), '样式沿用英文逐词样式');
  // 每条都该带高亮标签（否则等于没有逐词效果）
  const withTag = specs.filter(sp => /\{\\c&H/.test(sp.text));
  eq(withTag.length, 3, '★ 每条都带逐词高亮标签（这就是"格式没坏"的判据）');
  // 高亮标签应当落在**当前**高亮色上
  setWordHighlightColor('#ffffff');
  const s2 = newSentence('英文逐词', 0, 3, 'a b c');
  s2.highlightTag = wordHighlightTag();
  s2.words = recalcWords(s2, s2.text, s2.start, s2.end);
  const specs2 = buildWordSpecs(s2);
  ok(specs2.every(sp => /\{\\c&HFFFFFF&\}/.test(sp.text)),
    '高亮色跟着 setWordHighlightColor（白色时用 FFFFFF，不是写死绿）', specs2[0].text);
  setWordHighlightColor('#00ff00');   // 还原，免得影响后面的用例
}

console.log('\n== 词数统计（前端据此判断"逐词是否完整"）==');
{
  const s = newSentence('英文逐词', 0, 5, 'one two three four five');
  s.words = recalcWords(s, s.text, s.start, s.end);
  eq(s.words.length, splitEnglishWords(s.text).length, '词数 == splitEnglishWords 的口径（同一标准）');
}

console.log('\n== 边界：不能把整句弄丢 ==');
{
  // 单词句
  const s1 = newSentence('英文逐词', 10, 11, 'hello');
  s1.words = recalcWords(s1, s1.text, s1.start, s1.end);
  eq(s1.words.length, 1, '单词句 → 1 片');
  eq(buildWordSpecs(s1).length, 1, '单词句 → 1 条 spec');
  // 带标点的句子（splitEnglishWords 的切分口径）
  const s2 = newSentence('英文逐词', 0, 4, "don't stop, please!");
  s2.words = recalcWords(s2, s2.text, s2.start, s2.end);
  ok(s2.words.length >= 3, '带撇号与标点也能切出词', s2.words.map(w => w.w));
  // 极短句（时长 0.05s）不该塌掉
  const s3 = newSentence('英文逐词', 0, 0.05, 'a b c');
  s3.words = recalcWords(s3, s3.text, s3.start, s3.end);
  eq(s3.words.length, 3, '极短句仍给出 3 片（normalizeWords 会均匀铺满）');
  const specs3 = buildWordSpecs(s3);
  ok(specs3.every(sp => sp.end > sp.start), '极短句的 spec 时间仍然合法', specs3.map(sp => [sp.start, sp.end]));
}

console.log('\n== 空文本不该崩 ==');
{
  const s = newSentence('英文逐词', 0, 2, '   ');
  const w = recalcWords(s, s.text, s.start, s.end);
  eq(w.length, 0, '空白文本 → 0 片（调用方会跳过，不会写坏格式）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
