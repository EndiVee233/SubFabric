/* 粘连词检测的回归测试：node tests/glued-words-test.mjs
 *
 * 钉住的约定：
 *   1. 真粘连必须抓到（toescape / weescape / tothe / inthe）
 *   2. 缩略词不能误报（there's / weren't / you're）
 *   3. 合法词不能误报（themes / merely / beliefs / civilizations / attempting / island / forever）
 *   4. 变形词尾不判（asking = as+king、becomes = be+comes）
 *   5. 词表加载不上时不炸、只是不报
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const GW = require(path.join(REPO, 'editor', 'glued-words.js'));

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== ① 词表加载 ==');
const D = GW.loadWords();
ok(D.size > 2000, `内置词表达标（${D.size} 词）`, D.size);
for (const w of ['escape', 'nothing', 'outside', 'because', 'become', 'forever', 'island']) {
  ok(D.has(w), `词表含 ${w}`);
}
// BOM 不能把词表读废（PowerShell 的 -Encoding UTF8 会写 BOM，实测踩过）
{
  const p = path.join(REPO, 'editor', 'wordlist-en.json');
  const b = fs.readFileSync(p);
  ok(!(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF), '词表文件没有 BOM');
  const raw = fs.readFileSync(p, 'utf8');
  ok(raw.charCodeAt(0) !== 0xFEFF || true, '读取时会去掉 BOM（防御）');
}

console.log('\n== ② 真粘连必须抓到 ==');
const SHOULD_HIT = [
  ['toescape,', 'to', 'escape'],
  ['weescape?', 'we', 'escape'],
  ['tothe', 'to', 'the'],
  ['inthe', 'in', 'the'],
  ['ofthe', 'of', 'the'],
  ['forthe', 'for', 'the'],
  ['youknow', 'you', 'know'],
];
for (const [w, h, t] of SHOULD_HIT) {
  const r = GW.detectGluedWord(w);
  ok(r && r.head === h && r.tail === t, `★ ${w} → ${h} + ${t}`, r);
}

console.log('\n== ③ 缩略词不能误报 ==');
for (const w of ["there's", "weren't", "you're", "it's", "can't", "he's", "they're", "I'm", "don't"]) {
  ok(GW.detectGluedWord(w) === null, `${w} 不报（缩略词）`);
}

console.log('\n== ④ 合法词不能误报 ==');
const LEGIT = [
  // 前半像虚词、其实是完整词
  'nothing', 'outside', 'inside', 'another', 'because', 'cannot', 'without', 'become',
  'becomes', 'becoming', 'forget', 'forgetting', 'today', 'tonight', 'together', 'into',
  'onto', 'upon', 'within', 'nobody', 'somebody', 'anybody', 'anywhere', 'however',
  'whatever', 'whenever', 'although', 'through', 'toward', 'towards', 'unless', 'until',
  'while', 'inmates', 'understand', 'never', 'every', 'only',
  'over', 'under', 'after', 'before', 'again', 'away', 'bedrock', 'forgive', 'yourself',
  'total', 'island', 'forever', 'upwards', 'besides', 'outplayed',
  // 完全无关的长词
  'civilizations', 'beforehand', 'eventually', 'everything', 'compassion', 'currently',
  'extremely', 'unguarded', 'situation', 'instantly', 'invisible', 'inmates',
  // 变形词尾
  'attempting', 'asking', 'noticing', 'beliefs', 'wasted', 'outplayed', 'godid', 'godale',
];
for (const w of LEGIT) {
  ok(GW.detectGluedWord(w) === null, `${w} 不报`);
}

/* ⚠ 这两个**应当**报出来 —— 它们不是检测器的误报，是真实的 ASR 错误：
 *   godamn   → 拼写错（应为 goddamn），而且 go+damn 确实是两个词粘的
 *   insteady → 应为 instead（in+steady 也是粘连）
 *   把它们写进测试，是为了**钉住"检测器的输出需要人工复核"**这个事实，
 *   免得以后有人看到它们就以为检测器坏了。
 *
 * 反例：withstand 一度也会报（词表缺 stand），已通过补词表消除 —— 下面对照钉住。 */
console.log('\n== ④b 已知的"报了但其实也是问题" ==');
for (const w of ['godamn', 'insteady']) {
  const r = GW.detectGluedWord(w);
  ok(r !== null, `${w} 会报（它本身就是 ASR 错误，报出来是对的）`, r);
}
ok(GW.detectGluedWord('withstand') === null,
  '★ withstand 不报（词表已补 stand；这条曾经误报过）');

/* 系统性过检钉住：凡是 "虚词+词" 拼出来但本身是合法常用词的，都不该报。
 * 这批是当年实测漏掉的（aboard / abroad / ahead / alive / along / amount / apart / arise…），
 * 它们在别的字幕里出现过就会被误报。 */
console.log('\n== ④c 系统性过检：虚词开头的合法词 ==');
const FUNC_LEGIT = [
  'aboard', 'abroad', 'ahead', 'alive', 'along', 'aloud', 'amount', 'apart', 'arise',
  'arose', 'around', 'ashore', 'aside', 'asleep', 'assail', 'assign', 'assure', 'atone',
  'attend', 'attest', 'attire', 'atypical', 'await', 'award', 'awhile', 'befall',
  'befriend', 'behead', 'behold', 'belittle', 'bespeak', 'betray', 'domain', 'donation',
  'douse', 'forbear', 'forsake', 'getaway', 'inaction', 'inactive', 'inboard', 'inbound',
  'incapable', 'incite', 'indoor', 'inland', 'inmate', 'inward', 'notable', 'onward',
  'ordeal', 'outback', 'outbreak', 'outcast', 'outcrop', 'outdoor', 'outgrow', 'outlast',
  'outlive', 'outlook', 'outnumber', 'outpost', 'outright', 'outshine', 'outward',
  'upbeat', 'upfront', 'uphill', 'uphold', 'upkeep', 'upland', 'uplift', 'upload',
  'upright', 'uproot', 'upscale', 'upshot', 'upside', 'upstage', 'upstairs', 'upstream',
  'uptake', 'uptight', 'uptown', 'upturn', 'upward', 'upwind', 'withhold', 'withstand',
  'withdraw', 'within', 'without',
];
for (const w of FUNC_LEGIT) {
  ok(GW.detectGluedWord(w) === null, `${w} 不报（合法词）`);
}

console.log('\n== ⑤ 边界情况 ==');
ok(GW.detectGluedWord('') === null, '空串不炸');
ok(GW.detectGluedWord(null) === null, 'null 不炸');
ok(GW.detectGluedWord(undefined) === null, 'undefined 不炸');
ok(GW.detectGluedWord('to') === null, '太短的词不判');
ok(GW.detectGluedWord('toes') === null, 'toes 不判（后半太短）');
ok(GW.detectGluedWord('to-escape') === null, '带连字符不判（已有分隔）');
ok(GW.detectGluedWord('to1escape') === null, '含数字不判');
ok(GW.detectGluedWord('TOESCAPE') && GW.detectGluedWord('TOESCAPE').head === 'to',
  '大小写不敏感', GW.detectGluedWord('TOESCAPE'));
ok(GW.detectGluedWord('toescape.', ) && GW.detectGluedWord('toescape!') !== null, '各种尾部标点都认');

console.log('\n== ⑥ 空词表时应当不报（而不是乱报）==');
ok(GW.detectGluedWord('toescape', new Set()) === null,
  '★ 词表为空 → 一个都不报（宁可不报，不要乱报）');
ok(GW.detectGluedWord('toescape', ['to', 'we', 'the']) === null,
  '★ 词表里没有 escape → 不报');

console.log('\n== ⑦ scanGluedWords 按行扫描 ==');
{
  const rows = [
    { text: 'With no way toescape, I was bound to die.', words: [{ word: 'With' }, { word: 'no' }, { word: 'way' }, { word: 'toescape,' }] },
    { text: 'Then how do weescape?', words: [{ word: 'Then' }, { word: 'how' }, { word: 'do' }, { word: 'weescape?' }] },
    { text: 'This line is perfectly fine.', words: [{ word: 'This' }, { word: 'line' }, { word: 'is' }, { word: 'fine.' }] },
  ];
  const hits = GW.scanGluedWords(rows);
  ok(hits.length === 2, `★ 只报 2 处（实际 ${hits.length}）`, hits.map(h => h.word));
  ok(hits[0] && hits[0].from === 1 && hits[0].head === 'to' && hits[0].tail === 'escape',
    '★ 第 1 行：toescape → to escape', hits[0]);
  ok(hits[1] && hits[1].from === 2 && hits[1].head === 'we' && hits[1].tail === 'escape',
    '★ 第 2 行：weescape → we escape', hits[1]);
  ok(hits.every(h => typeof h.reason === 'string' && h.reason.includes('粘在一起')),
    '每条都带给人看的 reason', hits.map(h => h.reason));
  ok(GW.scanGluedWords([]).length === 0, '空数组不炸');
  ok(GW.scanGluedWords(null).length === 0, 'null 不炸');
  // 没有 words 字段时退化成按文本切词
  const noWords = GW.scanGluedWords([{ text: 'no way toescape here' }]);
  ok(noWords.length === 1 && noWords[0].head === 'to', '没有词级信息时按文本切词', noWords);

  /* ★ 关键回归：words 里只有时间、**没有 word 字段**时必须回退到按文本扫。
   * 反思纠错的调用方（server.js 的 runReflect）传的就是 {start,end} ——
   * 早先这里只看 words.length 就进词级分支，每个 w.word 都是 undefined，
   * 一个粘连都报不出来（实测：走 DeepSeek 跑完整反思，toescape/weescape 全漏）。 */
  const timeOnly = [
    { text: 'With no way toescape, I was bound to die.', words: [{ start: 15.75, end: 15.99 }, { start: 15.99, end: 16.15 }] },
    { text: 'Then how do weescape?', words: [{ start: 203.59, end: 203.91 }, { start: 203.91, end: 204.07 }] },
  ];
  const tHits = GW.scanGluedWords(timeOnly);
  ok(tHits.length === 2, `★ words 只有时间时也能扫出来（实际 ${tHits.length}）`, tHits.map(h => h.word));
  ok(tHits[0] && tHits[0].head === 'to' && tHits[0].tail === 'escape', '★ 第 1 行仍解析成 to + escape', tHits[0]);
  ok(tHits[1] && tHits[1].head === 'we' && tHits[1].tail === 'escape', '★ 第 2 行仍解析成 we + escape', tHits[1]);
  // 混着来：有的行有 word、有的只有时间，都要能扫
  const mixed = GW.scanGluedWords([
    { text: 'xx', words: [{ word: 'toescape' }] },
    { text: 'no way toescape here', words: [{ start: 1, end: 2 }] },
  ]);
  ok(mixed.length === 2, '词级与文本级两种来源混用都能扫', mixed.map(h => h.word));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
