/* SRT → 逐词 ASS 的纯逻辑单测: node tests/srt-ass-test.mjs
 *
 * 覆盖「在 SRT 稿件上点全片逐词重校对」的两段纯逻辑：
 *   ① planSrtTargets：哪些行能对齐、文本怎么归一、key 是否稳定；
 *   ② buildSrtSegments：勾选行用对齐时间、未勾选/失败行按句内时长分配、纯中文行保留。
 * 不加载模型、不需要 GPU / 音频 / 网络。
 */
'use strict';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeSrtText, hasEnglish, srtTargetKey, planSrtTargets, buildSrtSegments,
} = require('../editor/srt-ass.js');
const { splitEnglishWords } = require('../editor/js/karaoke.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

/* ── 1. 文本归一 ── */
assert.equal(normalizeSrtText('  SMP,I   plan.to\t nuke '), 'SMP, I plan. to nuke');
assert.equal(normalizeSrtText('wait...'), 'wait...');
assert.equal(normalizeSrtText('3.5 million'), '3. 5 million');
assert.equal(hasEnglish('纯中文行'), false);
assert.equal(hasEnglish('[Spk] 中文'), false);
assert.equal(hasEnglish('Hello 中文'), true);
ok(true, '文本归一与英文判定');

/* ── 2. 对齐目标 ── */
const rows = [
  { start: 0, end: 2, text: 'Hello,world.', zh: '你好 世界' },
  { start: 2, end: 4, text: 'Second line', zh: '' },
  { start: 4, end: 6, text: '纯中文行', zh: '纯中文行' },
  { start: 6, end: 5, text: 'bad time', zh: '' },      // 时间倒置 → 跳过
  { start: 8, end: 9, text: '   ', zh: '空白英文' },     // 无正文 → 只保留中文
];
const targets = planSrtTargets(rows);
ok(targets.length === 2, '只把有英文原文且时间有效的行作为对齐目标', targets.map(t => t.text));
ok(targets[0].index === 0 && targets[0].text === 'Hello, world.', '保留原行号并归一标点空格');
ok(targets[1].index === 1 && targets[1].start === 2 && targets[1].end === 4, '目标带原始时间');
ok(targets[0].targetKey === srtTargetKey(0, 0, 2, 'Hello, world.'), 'targetKey 与公开口径一致');
ok(targets[0].targetKey !== srtTargetKey(0, 0, 2, 'Hello,world.'), 'key 含归一后的文本，稿件改动会失配');

/* ── 3. 合成 segments：勾选行用对齐时间，未勾选用平均分配 ── */
const helloWords = [
  { w: 'Hello,', s: 0.10, e: 0.60 },
  { w: 'world.', s: 0.65, e: 1.40 },
];
const secondWords = [
  { w: 'Second', s: 2.10, e: 2.70 },
  { w: 'line', s: 2.80, e: 3.60 },
];
const items = [
  { targetKey: targets[0].targetKey, ok: true, words: helloWords },
  { targetKey: targets[1].targetKey, ok: true, words: secondWords },
];
const onlyFirst = buildSrtSegments(rows, targets, items, new Set([targets[0].targetKey]));
ok(onlyFirst.total === 4, '有效行 + 纯中文行都写进结果', { total: onlyFirst.total });
ok(onlyFirst.aligned === 1, '只统计勾选且词数对上的行', { aligned: onlyFirst.aligned });
ok(onlyFirst.segs[0].words[0].start === 0.10 && onlyFirst.segs[0].words[1].end === 1.40, '勾选行原样采用对齐时间');
ok(onlyFirst.trans[0] === '你好 世界', '中文译文跟着行号走');
ok(onlyFirst.segs[1].text === 'Second line' && onlyFirst.segs[1].words.length === 2, '未勾选行仍生成词');
const w = onlyFirst.segs[1].words;
ok(w[0].start >= 2 && w[w.length - 1].end <= 4, '未勾选行的词时间夹在句内');
ok(w.every((x, i) => x.end > x.start && (i === 0 || x.start >= w[i - 1].start)), '词时间单调且不倒挂');
ok(onlyFirst.segs[2].text === '' && onlyFirst.segs[2].words.length === 0 && onlyFirst.trans[2] === '纯中文行',
  '纯中文行只写中文轨，不伪造英文逐词');
ok(onlyFirst.trans.length === onlyFirst.segs.length, 'trans 与 segs 一一对应');

/* ── 4. 全部勾选 / 词数对不上 → 退回平均分配 ── */
const allPicked = buildSrtSegments(rows, targets, items, targets.map(t => t.targetKey));
ok(allPicked.aligned === 2, '全部勾选且词数对得上时两行都算对齐', { aligned: allPicked.aligned });
ok(allPicked.segs[1].words[0].start === 2.10, '第二行勾选后也用对齐时间');

const broken = [{ targetKey: targets[0].targetKey, ok: true, words: [{ w: 'Hello, world.', s: 0.2, e: 1.0 }] }];
const fallback = buildSrtSegments([rows[0]], planSrtTargets([rows[0]]), broken, [targets[0].targetKey]);
ok(fallback.aligned === 0, '词数与 splitEnglishWords 对不上 → 不算对齐');
ok(fallback.segs[0].words.length === splitEnglishWords('Hello, world.').length, '退回平均分配后词数正确');
ok(fallback.segs[0].words.every(x => x.start >= 0 && x.end <= 2), '退回的词时间不越界');

/* ── 5. 失败项 / 不存在的 key 不写入 ── */
const failed = [{ targetKey: targets[0].targetKey, ok: false, words: helloWords }];
const failedSeg = buildSrtSegments([rows[0]], planSrtTargets([rows[0]]), failed, [targets[0].targetKey]);
ok(failedSeg.aligned === 0 && failedSeg.segs.length === 1, 'ok:false 的对齐结果不被采用');
ok(failedSeg.segs[0].words.every(x => x.start >= 0 && x.end <= 2), '失败行改用句内平均时间');

if (fail) {
  console.error(`\nsrt-ass: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\nsrt-ass: ${pass} passed, 0 failed`);
