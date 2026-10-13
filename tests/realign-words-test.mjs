/* 全片逐词重校对的纯逻辑单测: node tests/realign-words-test.mjs
 *
 * 钉住的约定（每一条都对应一个已经踩过的坑）：
 *   1. 逐词字段名两条来源不同 —— 识别结果是 {word,start,end}、ASS 还原的是 {w,s,e}，
 *      两种都必须认（早先只认 {w,s,e}，"有 asr.json 的稿件"候选全成 undefined，
 *      LLM 收到的是 "[object Object]"）
 *   2. 候选要去首尾标点、按小写去重、丢掉长度 < 2 的
 *   3. 只采纳**确实在候选里**的词 —— 模型自己造的词比没有还糟
 *   4. 切片两侧留 padding，且夹在 [0, duration] 内
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
  /* 镜像同步: 只补齐/更新本族自己的文件, **绝不清空目录** —— jsmod 是两族共用镜像
   * (上游族源 editor/js, fork 族源 editor/), 清空会顺手删掉另一族的文件。 */
  fs.mkdirSync(JSMOD, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
  }
  fs.writeFileSync(marker, '{"type":"module"}\n');
}
ensureJsmod();
const { hotwordCandidates, matchPickedWords, sliceRange } =
  await import('./jsmod/realign-words.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

console.log('\n== 1. 候选整理：两条来源的字段名都要认 ==');
// 识别结果原生字段（asr.json）
eq(hotwordCandidates([{ word: 'Wemmbu', start: 1, end: 2 }]), ['Wemmbu'],
  '认 {word} 形态（asr.json 的字段）');
// ASS 还原出来的字段
eq(hotwordCandidates([{ w: 'Wemmbu', s: 1, e: 2 }]), ['Wemmbu'],
  '认 {w,s,e} 形态（sentencesFromFile 的产出）');
eq(hotwordCandidates(['Flowtives']), ['Flowtives'], '也接受裸字符串');
ok(!hotwordCandidates([{ word: 'x', start: 0, end: 1 }]).some(s => s.includes('object')),
  '绝不产出 "[object Object]"（旧 bug 的指纹）');

console.log('\n== 2. 候选整理：去标点 / 去重 / 丢太短 ==');
eq(hotwordCandidates(['G\'day', 'gents,', '"quoted"', 'a', 'I', 'ok']),
  ['G\'day', 'gents', 'quoted', 'ok'],
  '去首尾标点、丢掉 <2 字符的（a/I）');
eq(hotwordCandidates(['Meter', 'meter', 'METER']), ['Meter'],
  '按小写去重且保留首次出现的写法');
eq(hotwordCandidates(['26.4']), ['26.4'], '带数字的保留内部标点');
eq(hotwordCandidates([]), [], '空输入 → 空');
eq(hotwordCandidates(null), [], 'null 输入 → 空');

console.log('\n== 3. LLM 回复抠词 ==');
const CAND = ['Cubic', 'Meter', 'Merging', 'the', 'ice'];
eq(matchPickedWords('["Cubic","Meter"]', CAND), ['Cubic', 'Meter'], '标准 JSON 数组');
eq(matchPickedWords('```json\n["Cubic"]\n```', CAND), ['Cubic'], '带代码围栏也能抠出来');
eq(matchPickedWords('我挑这几个：["Cubic", "Merging"] 就这些', CAND), ['Cubic', 'Merging'],
  '前后有散文也能抠出来');
eq(matchPickedWords('["cubic","METER"]', CAND), ['Cubic', 'Meter'],
  '大小写不敏感，但返回候选里的原样拼写');
eq(matchPickedWords('["Wynncraft","Cubic"]', CAND), ['Cubic'],
  '★ 模型自己造的词必须丢掉（不在候选里）');
eq(matchPickedWords('[]', CAND), [], '空数组 → 空');
eq(matchPickedWords('没有值得给的', CAND), [], '不是 JSON → 空（调用方据此放弃第二级）');
eq(matchPickedWords('["Cubic"', CAND), [], '截断的 JSON → 空，不抛异常');
eq(matchPickedWords(null, CAND), [], 'null 回复 → 空');
eq(matchPickedWords('["Cubic"]', null), [], 'null 候选 → 空');
eq(matchPickedWords(JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).length, 6, '最多 6 个');

console.log('\n== 4. 切片区间 ==');
eq(sliceRange(10, 12, 0.2), { from: 9.8, to: 12.2 }, '两侧各留 padding');
eq(sliceRange(0.1, 2, 0.2), { from: 0, to: 2.2 }, '左边界夹在 0（不能切到负数）');
eq(sliceRange(0.1, 2, 0.2, 2.05), { from: 0, to: 2.05 }, '右边界夹在片长内');
eq(sliceRange(5, 5.1, 0.2), { from: 4.8, to: 5.3 }, '极短句也照切（交给 ASR 判）');
eq(sliceRange(3, 4, 0), { from: 3, to: 4 }, 'padding=0 时就是原区间');
eq(sliceRange(3, 4, undefined), { from: 3, to: 4 }, 'padding 未给 → 按 0');
ok(sliceRange(9, 1, 0.2).to >= sliceRange(9, 1, 0.2).from,
  'end < start 时不会切出负长度区间');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
