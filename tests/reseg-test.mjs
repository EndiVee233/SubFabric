/* 语义分句模块单测: node tests/reseg-test.mjs */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const R = require_('../editor/reseg.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};

/* ── cleanWordText ── */
ok(R.cleanWordText('pearl,') === 'pearl', 'cleanWordText 去尾逗号');
ok(R.cleanWordText('"hello') === 'hello', 'cleanWordText 去首引号');
ok(R.cleanWordText("don't") === "don't", 'cleanWordText 保留撇号');
ok(R.cleanWordText("don't.") === "don't", 'cleanWordText 去标点留撇号');
ok(R.cleanWordText('...') === '', 'cleanWordText 独立标点→空');
ok(R.cleanWordText('(yeah)') === 'yeah', 'cleanWordText 去括号');

/* ── flattenWords: 独立标点 token 丢弃、时间并入前词 ── */
const segs1 = [{
  start: 0, end: 3, text: 'x',
  words: [
    { word: 'okay', start: 0.0, end: 0.5 },
    { word: '.', start: 0.5, end: 0.6 },        // 独立标点 token
    { word: 'ken', start: 0.6, end: 1.0 },
    { word: 'take', start: 1.2, end: 1.6 },
  ],
}];
const fw = R.flattenWords(segs1);
ok(fw.length === 3, 'flattenWords 丢独立标点', JSON.stringify(fw));
ok(fw[0].end === 0.6, 'flattenWords 前词 end 并入标点时间', String(fw[0].end));
ok(R.flattenWords([]).length === 0, 'flattenWords 空输入');
ok(R.flattenWords(null).length === 0, 'flattenWords null');

/* ── parsePunctReply ── */
const n = 10;
let r = R.parsePunctReply('[[3, ","],[7, "."]]', n);
ok(r && r.length === 2 && r[0][0] === 3 && r[1][1] === '.', 'parsePunctReply 基本解析');
r = R.parsePunctReply('前置废话 [["'+4+'", "!"]] 后缀', n);
ok(r && r.length === 1 && r[0][0] === 4, 'parsePunctReply 容忍前后缀文本');
r = R.parsePunctReply('[[3, ","],[3, "."],[3, "?"]]', n);
ok(r && r.length === 1 && r[0][1] === ',', 'parsePunctReply 同位置去重取首个');
r = R.parsePunctReply('[[99, "."],[-1, ","],[2, "x"],[5, "…"]]', n);
ok(r && r.length === 1 && r[0][0] === 5 && r[0][1] === '.', 'parsePunctReply 越界/非法标点剔除, 省略号→句号', JSON.stringify(r));
ok(R.parsePunctReply('not json', n) === null, 'parsePunctReply 非JSON→null');
ok(R.parsePunctReply('[]', n) === null, 'parsePunctReply 空数组→null');

/* ── groupResegWords: 用户规则 —— 逗号/句号后必切 ── */
const w = (word, start, end) => ({ word, start, end });
const g1 = R.groupResegWords([
  w('okay', 0, 0.3), w('ken,', 0.3, 0.5), w('take', 0.5, 0.8), w('us.', 0.8, 1.0), w('go', 1.0, 1.3),
]);
ok(g1.length === 3, 'groupResegWords 逗号/句号后切', JSON.stringify(g1.map(g => g.map(x => x.word))));
ok(g1[0].length === 2 && g1[1].length === 2 && g1[2].length === 1, 'groupResegWords 分组大小正确');

/* 兜底: 无标点但停顿>0.8s */
const g2 = R.groupResegWords([
  w('a', 0, 0.3), w('b', 0.3, 0.6), w('c', 1.6, 1.9),
]);
ok(g2.length === 2, 'groupResegWords 停顿>0.8s兜底');

/* 兜底: 无标点持续语流超10s（词间停顿≤0.8s, 纯靠 10s 上限切） */
const cont = Array.from({ length: 24 }, (_, i) => w('w' + i, i * 0.5, i * 0.5 + 0.4));
const g3 = R.groupResegWords(cont);
ok(g3.length === 2, 'groupResegWords 超10s兜底', JSON.stringify(g3.map(g => g.length)));

/* ── mergeTinyFrags ── */
const mf = R.mergeTinyFrags([
  [w('uh,', 0, 0.3)],                                  // tiny → 并入下一组
  [w('okay', 0.4, 0.7), w('ken.', 0.7, 1.0)],
  [w('go', 1.1, 1.4), w('on', 1.4, 1.7)],
]);
ok(mf.length === 2, 'mergeTinyFrags 短碎片并入下一句', JSON.stringify(mf.map(g => g.map(x => x.word))));
ok(mf[0].length === 3, 'mergeTinyFrags 并入后词数正确', String(mf[0].length));

const mf2 = R.mergeTinyFrags([[w('a', 0, 0.2), w('b', 0.2, 0.4)], [w('c,', 0.5, 0.7)]]);
ok(mf2.length === 1 && mf2[0].length === 3, 'mergeTinyFrags 末尾碎片并回上一句', JSON.stringify(mf2.map(g => g.map(x => x.word))));

const mf3 = R.mergeTinyFrags([[w('uh,', 0, 0.3)]]);
ok(mf3.length === 1, 'mergeTinyFrags 只有碎片时不合并成空');

/* ── groupsToSegments ── */
const gs = R.groupsToSegments([[w('a,', 0, 0.5), w('b', 0.5, 1)]]);
ok(gs.length === 1 && gs[0].text === 'a, b' && gs[0].start === 0 && gs[0].end === 1, 'groupsToSegments 形状正确', JSON.stringify(gs));

/* ── resegWithLLM 全流程（mock chat）── */
// 模拟截图场景: 一大段无标点词流
const text = "okay ken take us to the uh the pearl whatever i don't care anymore just take us there " +
  "oh yeah so there's also two diamond strips looking for me right now how do you get the attention " +
  "of literally everyone bad so we should probably leave okay wait wait okay we're going to the pearl thing";
const words = text.split(' ').map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
const mockSegs = [{ start: 0, end: words.length * 0.3, text, words }];
const N = words.length;   // 53 词
// 期望: LLM 在这些全局序号后插标点 → 6 句
let chatCalls = 0;
const mockChat = async (messages) => {
  chatCalls++;
  return '[[5, ","],[16, "."],[22, ","],[34, "."],[44, ","]]';
};
(async () => {
  const out = await R.resegWithLLM(mockChat, mockSegs, () => {});
  ok(out.length === 6, 'resegWithLLM mock 全流程切成 6 句', JSON.stringify(out.map(s => s.text)));
  ok(out[0].text === 'okay ken take us to the,', '第1句文本', out[0].text);
  ok(out[1].text === "uh the pearl whatever i don't care anymore just take us.", '第2句文本', out[1].text);
  ok(out.reduce((n, s) => n + s.words.length, 0) === N, '词数守恒（53 词一个不少）', String(out.reduce((n, s) => n + s.words.length, 0)));
  ok(out[0].start === 0 && Math.abs(out[out.length - 1].end - ((N - 1) * 0.3 + 0.25)) < 0.01, '时间戳首尾不变');

  /* LLM 坏回复 → 重试后成功（标点在词5后 → [0..5],[6..35](30词兜底),[36..52]） */
  let bad = 0;
  const flakyChat = async () => { bad++; return bad < 3 ? 'i think the punctuation should be nice' : '[[5, "."]]'; };
  const out2 = await R.resegWithLLM(flakyChat, mockSegs, () => {});
  ok(out2.length === 3 && bad === 3, 'resegWithLLM 坏回复自动重试', 'calls=' + bad + ' len=' + out2.length);

  /* LLM 永远坏 → 抛错 */
  const badChat = async () => 'sorry here is the text: ' + text;
  let threw = false;
  try { await R.resegWithLLM(badChat, mockSegs, () => {}); } catch (e) { threw = true; }
  ok(threw, 'resegWithLLM 持续失败抛错');

  /* 词太少 → 不调 LLM 原样返回 */
  let called = 0;
  const tiny = [{ start: 0, end: 1, text: 'hi there', words: [w('hi', 0, 0.5), w('there', 0.5, 1)] }];
  const out3 = await R.resegWithLLM(async () => { called++; return '[]'; }, tiny, () => {});
  ok(called === 0 && out3 === tiny, 'resegWithLLM 词太少跳过');

  /* 长流分批: 900 词 → 3 批 */
  const longWords = Array.from({ length: 900 }, (_, i) => w('w' + i, i * 0.2, i * 0.2 + 0.15));
  const longSegs = [{ start: 0, end: 200, text: '', words: longWords }];
  const idxs = [];
  const batchChat = async (messages) => {
    const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
    idxs.push(nums.length);
    return '[[' + (nums[nums.length - 1]) + ', "."]]';
  };
  const out4 = await R.resegWithLLM(batchChat, longSegs, () => {});
  ok(idxs.length === 3 && idxs.join(',') === '400,400,100', 'resegWithLLM 900词分3批', idxs.join(','));
  ok(out4.reduce((n, s) => n + s.words.length, 0) === 900, '分批词数守恒', String(out4.reduce((n, s) => n + s.words.length, 0)));
  const texts4 = out4.map(s => s.text);
  ok(texts4.some(t => t.endsWith('w399.')) && texts4.some(t => t.endsWith('w799.')) && texts4.some(t => t.endsWith('w899.')),
    '分批标点全部生效', JSON.stringify(texts4.filter(t => /[w]\d+\.$/.test(t)).slice(-4)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
