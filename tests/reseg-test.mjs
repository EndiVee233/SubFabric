/* 语义分句模块单测: node tests/reseg-test.mjs
 * 覆盖用户报的问题: ①批边界切在半句上 ②逗号也切句导致断句很碎 ③小模型"每词加逗号" ④输出被截断 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const R = require_('../editor/reseg.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};
const w = (word, start, end) => ({ word, start, end });

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

/* ── flattenWords: 整段没有 words 时用整句补一个"词", 文本绝不能丢 ──
 * 真实场景: multitalker.py 拿不到词级时间的兜底段 {text, words: []}；
 * 语义分句现在对所有引擎都跑, 这种段若被吃掉就是整句消失。 */
const noWordSegs = [
  { start: 0, end: 2, text: 'hello world.', words: [] },
  { start: 2, end: 4, text: 'second line', words: null },
  { start: 4, end: 5, text: '...', words: [] },                 // 只有标点 → 不算内容
];
const fw2 = R.flattenWords(noWordSegs);
ok(fw2.length === 2, 'flattenWords 无词级时间的段补成整句, 纯标点段丢弃', JSON.stringify(fw2));
ok(fw2[0].word === 'hello world' && fw2[0].start === 0 && fw2[0].end === 2,
  'flattenWords 补出的词用整句文本与 [start,end]', JSON.stringify(fw2[0]));
ok(fw2[1].word === 'second line', 'flattenWords words=null 也当无词级时间处理', JSON.stringify(fw2[1]));
const fwMix = R.flattenWords([
  { start: 0, end: 1, text: 'a b', words: [w('a', 0, 0.5), w('b', 0.5, 1)] },
  { start: 1, end: 2, text: 'c d', words: [] },
]);
ok(fwMix.length === 3 && fwMix[2].word === 'c d', 'flattenWords 有词级时间的段照旧, 不影响后续无词段', JSON.stringify(fwMix));

/* ── parsePunctReply ── */
const n = 10;
let r = R.parsePunctReply('[[3, ","],[7, "."]]', n);
ok(r && r.length === 2 && r[0][0] === 3 && r[1][1] === '.', 'parsePunctReply 基本解析');
r = R.parsePunctReply('前置废话 [["4", "!"]] 后缀', n);
ok(r && r.length === 1 && r[0][0] === 4, 'parsePunctReply 容忍前后缀文本');
r = R.parsePunctReply('[[3, ","],[3, "."],[3, "?"]]', n);
ok(r && r.length === 1 && r[0][1] === ',', 'parsePunctReply 同位置去重取首个');
r = R.parsePunctReply('[[99, "."],[-1, ","],[2, "x"],[5, "…"]]', n);
ok(r && r.length === 1 && r[0][0] === 5 && r[0][1] === '.', 'parsePunctReply 越界/非法标点剔除, 省略号→句号', JSON.stringify(r));
ok(R.parsePunctReply('not json', n) === null, 'parsePunctReply 非JSON→null');
ok(R.parsePunctReply('[]', n) === null, 'parsePunctReply 空数组→null');
ok(R.parsePunctReply('思考里的示例 [["0", "."]] 结束', n) === null || true, 'parsePunctReply 不因思考崩');

/* ── groupResegWords: 新规则 —— 只按句末标点切, 逗号不切 ── */
const g1 = R.groupResegWords([
  w('okay', 0, 0.3), w('ken,', 0.3, 0.5), w('take', 0.5, 0.8), w('us.', 0.8, 1.0), w('go', 1.0, 1.3),
]);
ok(g1.length === 2, 'groupResegWords 只按句末标点切（逗号不切成新句）', JSON.stringify(g1.map(g => g.map(x => x.word))));
ok(g1[0].length === 4 && g1[1].length === 1, 'groupResegWords 分组大小正确');
const g1b = R.groupResegWords([
  w('okay', 0, 0.3), w('ken,', 0.3, 0.5), w('take', 0.5, 0.8), w('us.', 0.8, 1.0), w('go', 1.0, 1.3),
], { splitOnComma: true });
ok(g1b.length === 3, 'splitOnComma:true 可恢复"逗号也切"的旧行为', JSON.stringify(g1b.map(g => g.map(x => x.word))));

/* 兜底: 无标点但停顿>0.8s */
const g2 = R.groupResegWords([w('a', 0, 0.3), w('b', 0.3, 0.6), w('c', 1.6, 1.9)]);
ok(g2.length === 2, 'groupResegWords 停顿>0.8s兜底');

/* 兜底: 无标点持续语流超10s（现在走"软折"而不是硬切） */
const cont = Array.from({ length: 24 }, (_, i) => w('w' + i, i * 0.5, i * 0.5 + 0.4));
const g3 = R.groupResegWords(cont);
ok(g3.length === 2, 'groupResegWords 超10s软折', JSON.stringify(g3.map(g => g.length)));

/* ── softFold: 长行优先在逗号处折 ── */
const longRun = Array.from({ length: 32 }, (_, i) => w(i === 20 ? 'okay,' : 'w' + i, i * 0.3, i * 0.3 + 0.25));
const gf = R.softFold(longRun);
ok(gf.length === 2, 'softFold 32 词折成 2 段', JSON.stringify(gf.map(g => g.length)));
ok(gf[0].length === 21 && gf[1].length === 11, 'softFold 折在逗号处（第 21 词后）', JSON.stringify(gf.map(g => g.length)));
const noComma = Array.from({ length: 32 }, (_, i) => w('w' + i, i * 0.3, i * 0.3 + 0.25));
const gf2 = R.softFold(noComma);
ok(gf2.length === 2 && gf2[0].length === 30, 'softFold 没有逗号时按词数硬折', JSON.stringify(gf2.map(g => g.length)));

/* ── planBatches: 批边界优先落在停顿处（旧实现每 400 词盲切, 必然切在半句上） ── */
const mixed = Array.from({ length: 300 }, (_, i) => w('w' + i, i * 0.3, i * 0.3 + 0.25));
mixed[250].end = mixed[250].start + 0.25;
mixed[251] = w('w251', mixed[250].end + 1.0, mixed[250].end + 1.25);        // 第 250 词后有 1s 停顿
for (let i = 252; i < 300; i++) mixed[i] = w('w' + i, mixed[251].end + (i - 251) * 0.3, mixed[251].end + (i - 251) * 0.3 + 0.25);
const pb = R.planBatches(mixed);
ok(pb.length === 2 && pb[0][1] === 251, 'planBatches 在停顿处收批（不切在半句上）', JSON.stringify(pb));
const pbLong = R.planBatches(Array.from({ length: 2600 }, (_, i) => w('w' + i, i * 0.2, i * 0.2 + 0.15)));
ok(pbLong.length === 3 && pbLong[0][1] - pbLong[0][0] === 1200 && pbLong[2][1] - pbLong[2][0] === 200,
  'planBatches 无停顿时按 1200 词上限切', JSON.stringify(pbLong.map(x => x[1] - x[0])));

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
const text = "okay ken take us to the uh the pearl whatever i don't care anymore just take us there " +
  "oh yeah so there's also two diamond strips looking for me right now how do you get the attention " +
  "of literally everyone bad so we should probably leave okay wait wait okay we're going to the pearl thing";
const words = text.split(' ').map((t, i) => w(t, i * 0.3, i * 0.3 + 0.25));
const mockSegs = [{ start: 0, end: words.length * 0.3, text, words }];
const N = words.length;
const mockChat = async () => '[[5, ","],[16, "."],[22, ","],[34, "."],[44, ","]]';
(async () => {
  const out = await R.resegWithLLM(mockChat, mockSegs, () => {});
  ok(out.length === 3, 'resegWithLLM 句末标点切出 3 句（逗号不再切）', JSON.stringify(out.map(s => s.text.length)));
  ok(out[0].text === "okay ken take us to the, uh the pearl whatever i don't care anymore just take us.", '第1句文本', out[0].text);
  ok(out[1].text === "there oh yeah so there's also, two diamond strips looking for me right now how do you get.", '第2句文本', out[1].text);
  ok(out[2].text === "the attention of literally everyone bad so we should probably, leave okay wait wait okay we're going to the pearl thing", '第3句文本', out[2].text);
  ok(out.reduce((n, s) => n + s.words.length, 0) === N, '词数守恒（一个不少）', String(out.reduce((n, s) => n + s.words.length, 0)));
  ok(out[0].start === 0 && Math.abs(out[out.length - 1].end - ((N - 1) * 0.3 + 0.25)) < 0.01, '时间戳首尾不变');

  /* LLM 坏回复 → 重试后成功（逗号不再切句, 但长行会软折） */
  let bad = 0;
  const flakyChat = async () => { bad++; return bad < 3 ? 'i think the punctuation should be nice' : '[[5, "."]]'; };
  const out2 = await R.resegWithLLM(flakyChat, mockSegs, () => {});
  ok(out2.length === 3 && bad === 3, 'resegWithLLM 坏回复自动重试', 'calls=' + bad + ' len=' + out2.length);
  ok(out2.reduce((n, s) => n + s.words.length, 0) === N, '重试后词数仍守恒');

  /* LLM 永远坏 → 抛错（含拆批重试） */
  const badChat = async () => 'sorry here is the text: ' + text;
  let threw = false;
  try { await R.resegWithLLM(badChat, mockSegs, () => {}); } catch (e) { threw = true; }
  ok(threw, 'resegWithLLM 持续失败抛错');

  /* 小模型"每个词都加逗号" → 密度校验必须拒掉, 不能把垃圾落盘 */
  const dirtyWords = Array.from({ length: 20 }, (_, i) => w('w' + i, i * 0.3, i * 0.3 + 0.25));
  const dirtySegs = [{ start: 0, end: 6, text: dirtyWords.map(x => x.word).join(' '), words: dirtyWords }];
  const dirtyChat = async (messages) => {
    const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
    return JSON.stringify(nums.map(k => [k, ',']));       // 每词一个逗号
  };
  let dirtyErr = '';
  try { await R.resegWithLLM(dirtyChat, dirtySegs, () => {}); } catch (e) { dirtyErr = String(e.message || e); }
  ok(/密度/.test(dirtyErr), '每词加逗号 → 密度校验拒绝并报明确原因', dirtyErr.slice(0, 80));

  /* 输出被截断（finish_reason=length）→ 自动拆批, 而不是原地重试 */
  const bigWords = Array.from({ length: 120 }, (_, i) => w('w' + i, i * 0.3, i * 0.3 + 0.25));
  bigWords[60] = w('w60', 60 * 0.3, 60 * 0.3 + 0.25);
  bigWords[61] = w('w61', bigWords[60].end + 1.2, bigWords[60].end + 1.45);            // 中间一个 1.2s 停顿
  for (let i = 62; i < 120; i++) bigWords[i] = w('w' + i, bigWords[61].end + (i - 61) * 0.3, bigWords[61].end + (i - 61) * 0.3 + 0.25);
  const bigSegs = [{ start: 0, end: 60, text: '', words: bigWords }];
  const sizes = [];
  const truncChat = async (messages) => {
    const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
    sizes.push(nums.length);
    if (nums.length > 90) { const e = new Error('输出被 max_tokens 截断'); e.kind = 'truncated'; throw e; }
    return '[[' + nums[nums.length - 1] + ', "."]]';
  };
  const out4 = await R.resegWithLLM(truncChat, bigSegs, () => {});
  ok(sizes[0] === 120, '大批先整批试', JSON.stringify(sizes));
  ok(sizes.length >= 3, '截断后自动拆批重试', JSON.stringify(sizes));
  ok(out4.reduce((n, s) => n + s.words.length, 0) === 120, '拆批后词数守恒', String(out4.reduce((n, s) => n + s.words.length, 0)));

  /* 长流分批: 2600 词 → 3 批（1200/1200/200） */
  const longWords = Array.from({ length: 2600 }, (_, i) => w('w' + i, i * 0.2, i * 0.2 + 0.15));
  const longSegs = [{ start: 0, end: 600, text: '', words: longWords }];
  const idxs = [];
  const batchChat = async (messages) => {
    const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
    idxs.push(nums.length);
    return '[[' + nums[nums.length - 1] + ', "."]]';
  };
  const out5 = await R.resegWithLLM(batchChat, longSegs, () => {});
  ok(idxs.length === 3 && idxs.join(',') === '1200,1200,200', 'resegWithLLM 2600词分3批', idxs.join(','));
  ok(out5.reduce((n, s) => n + s.words.length, 0) === 2600, '分批词数守恒', String(out5.reduce((n, s) => n + s.words.length, 0)));
  const t5 = out5.map(s => s.text);
  ok(t5.some(t => t.endsWith('w1199.')) && t5.some(t => t.endsWith('w2399.')) && t5.some(t => t.endsWith('w2599.')),
    '分批标点全部生效（批尾那个句号也被接受）', JSON.stringify(t5.filter(t => /w(1199|2399|2599)\.$/.test(t))));

  /* 英文词+数字粘连：所有模型共用语义分句入口，修复带词级时间的 got24 */
  {
    const fused = [{ start: 0, end: 2.5, text: 'I just got24 iron bro', words: [
      w('I', 0, 0.2), w('just', 0.2, 0.6), w('got24', 0.6, 1.4), w('iron', 1.4, 2.0), w('bro', 2.0, 2.5),
    ] }];
    let called = 0;
    const fixed = await R.resegWithLLM(async () => { called++; return '[]'; }, fused, () => {});
    ok(called === 0 && fixed[0].text === 'I just got 24 iron bro', 'resegWithLLM 短稿也修复 got24', fixed[0].text);
    ok(fixed[0].words.length === 6 && fixed[0].words[2].word === 'got' && fixed[0].words[3].word === '24',
      '融合词拆成两个词并保留逐词时间', JSON.stringify(fixed[0].words));
    ok(fixed[0].words[2].end === fixed[0].words[3].start, '拆分后的相邻时间边界连续');
  }
  {
    const raw = 'I just got24 iron bro and ran away fast';
    const sourceWords = raw.split(' ').map((word, i) => w(word, i * 0.3, i * 0.3 + 0.25));
    let prompt = '';
    const fixed = await R.resegWithLLM(async (messages) => {
      prompt = messages[1].content;
      return '[[9, "."]]';
    }, [{ start: 0, end: 3, text: raw, words: sourceWords }], () => {});
    ok(/\n2 got\n3 24\n/.test('\n' + prompt + '\n'), '长稿送入共享语义分句前已拆开数字词', prompt.slice(0, 100));
    ok(fixed[0].text === 'I just got 24 iron bro and ran away fast.', '长稿分句结果保留拆分词', fixed[0].text);
  }
  {
    const textOnly = [{ start: 0, end: 2, text: 'I just got24 iron bro', words: [] }];
    const fixed = await R.resegWithLLM(async () => { throw new Error('不应调用 LLM'); }, textOnly, () => {});
    ok(fixed[0].text === 'I just got 24 iron bro' && fixed[0].words.length === 0,
      '无词级时间的模型仅修正文案，不伪造词级时间', JSON.stringify(fixed[0]));
  }
  ok(!R.fusedEnglishNumberParts('mp3') && !R.fusedEnglishNumberParts('gpt4')
    && !R.fusedEnglishNumberParts('covid19') && !R.fusedEnglishNumberParts('H264')
    && !R.fusedEnglishNumberParts('iphone15') && !R.fusedEnglishNumberParts('gpt35')
    && !R.fusedEnglishNumberParts('rtx4090') && !R.fusedEnglishNumberParts('win64'),
    '单数字缩写/常见型号不拆');
  ok(R.fusedEnglishNumberParts('got24,').word === 'got'
    && R.fusedEnglishNumberParts('got24,').number === '24,', '末尾标点留在数字 token 上');

  /* 词太少 → 不调 LLM 原样返回 */
  let called = 0;
  const tiny = [{ start: 0, end: 1, text: 'hi there', words: [w('hi', 0, 0.5), w('there', 0.5, 1)] }];
  const out6 = await R.resegWithLLM(async () => { called++; return '[]'; }, tiny, () => {});
  ok(called === 0 && out6 === tiny, 'resegWithLLM 词太少跳过');

  /* 云端 / multitalker 形状的输入（含 words: [] 的段）走完整条流程, 文本一个字都不能少 */
  const mixedSegs = [
    { start: 0, end: 3, text: 'okay ken take us to the second floor please', words: [
      w('okay', 0, 0.3), w('ken', 0.3, 0.6), w('take', 0.6, 0.9), w('us', 0.9, 1.2), w('to', 1.2, 1.5),
      w('the', 1.5, 1.8), w('second', 1.8, 2.1), w('floor', 2.1, 2.4), w('please', 2.4, 2.7)] },
    { start: 3.0, end: 4.0, text: 'no word timing here', words: [] },
  ];
  const echoChat = async (messages) => {
    const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
    return '[[' + nums[nums.length - 1] + ', "."]]';
  };
  const out7 = await R.resegWithLLM(echoChat, mixedSegs, () => {});
  const txt7 = out7.map(s => s.text).join(' ');
  ok(/okay ken/.test(txt7) && /no word timing here/.test(txt7),
    '无词级时间段的文本在整条语义分句流水线里活下来', txt7);
  ok(out7.reduce((n, s) => n + s.words.length, 0) === 10,
    '补出来的"整句词"也进词表（9 词 + 1 句）', String(out7.reduce((n, s) => n + s.words.length, 0)));

  /* ── 用户报"重试点的没用"的两条根因：①单批失败拖垮整步 ②重试从头再来 ──
   * 201 词 + 3 词：攒够 200 词后遇到停顿就收批 → 正好 2 批；让**第二小批**失败
   * （3 词 ≤ MIN_SPLIT_WORDS，不会再拆，直接走"放弃这批"，测试也跑得快）。 */
  const ckWords = [];
  for (let i = 0; i < 201; i++) ckWords.push(w('a' + i, i * 0.2, i * 0.2 + 0.15));
  for (let i = 0; i < 3; i++) { const s = 201 * 0.2 + 1.0 + i * 0.2; ckWords.push(w('b' + i, s, s + 0.15)); }
  const ckSegs = [{ start: 0, end: 50, text: '', words: ckWords }];
  ok(R.planBatches(R.flattenWords(ckSegs)).length === 2, '构造出 2 批（201 + 3）');

  /* 单批失败 → 只放弃这批，整步照常完成，词一个不丢 */
  {
    const st = {};
    const flakyChat = async (messages) => {
      const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
      if (nums[0] >= 201) throw Object.assign(new Error('模拟接口抽风'), { kind: 'http' });
      return '[[' + nums[nums.length - 1] + ', "."]]';
    };
    const out = await R.resegWithLLM(flakyChat, ckSegs, () => {}, { stats: st });
    ok(st.skipped.length === 1, '单批做不出来 → 只放弃那一批（不再整步抛错）', JSON.stringify(st.skipped.map(x => x.label)));
    ok(out.reduce((n, s) => n + s.words.length, 0) === 204, '放弃的批次词也没丢（按停顿兜底）',
      String(out.reduce((n, s) => n + s.words.length, 0)));
  }

  /* 密度异常 → 抢救：只保留句末标点（逗号全丢）往往就合格了 */
  {
    const st = {};
    const denseSegs = [{ start: 0, end: 12, text: '', words: Array.from({ length: 40 }, (_, i) => w('d' + i, i * 0.3, i * 0.3 + 0.25)) }];
    const denseChat = async (messages) => {
      const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
      return JSON.stringify(nums.map((k, i) => [k, i % 5 === 0 ? '.' : ',']));    // 每词都带标点 → 密度 1.0
    };
    const out = await R.resegWithLLM(denseChat, denseSegs, () => {}, { stats: st });
    ok(st.salvaged.length === 1 && st.skipped.length === 0, '密度异常 → 抢救成功，不算放弃',
      JSON.stringify([st.salvaged, st.skipped]));
    ok(out.reduce((n, s) => n + s.words.length, 0) === 40, '抢救后词数守恒');
    ok(out.every(s => !/,$/.test(s.text)), '抢救后只剩句末标点（没有逗号结尾的行）', JSON.stringify(out.map(s => s.text).slice(0, 3)));
  }

  /* 所有批次都没成 → 抛错（模型不可用，别静默退回引擎断句） */
  {
    let msg = '';
    const bad = [{ start: 0, end: 12, text: '', words: Array.from({ length: 20 }, (_, i) => w('x' + i, i * 0.3, i * 0.3 + 0.25)) }];
    try {
      await R.resegWithLLM(async () => { throw Object.assign(new Error('模型不可用'), { kind: 'http' }); }, bad, () => {}, { stats: {} });
    } catch (e) { msg = String(e.message || e); }
    ok(/全部没做出标点/.test(msg), '所有批次都没成 → 抛错并说清原因', msg.slice(0, 90));
  }

  /* 断点续跑：第一批跑完把每批落盘 → 再跑一次不再调模型，直接用落盘的批次 */
  {
    const store = { data: null };
    const withCk = (stats) => ({
      stats,
      loadCheckpoint: () => store.data,
      saveCheckpoint: (idx, pairs, meta) => {
        if (!store.data || store.data.sig !== meta.sig) store.data = { model: meta.model, words: meta.words, sig: meta.sig, batches: {} };
        store.data.batches[idx] = pairs;
      },
    });
    const goodChat = async (messages) => {
      const nums = messages[1].content.split('\n').map(l => parseInt(l, 10));
      return '[[' + nums[nums.length - 1] + ', "."]]';
    };
    await R.resegWithLLM(goodChat, ckSegs, () => {}, withCk({}));
    ok(Object.keys(store.data.batches).length === 2, '每批成功就落盘（2 批）', JSON.stringify(Object.keys(store.data.batches)));

    let calls = 0;
    const st2 = {};
    const out = await R.resegWithLLM(async () => { calls++; return '[]'; }, ckSegs, () => {}, withCk(st2));
    ok(calls === 0 && st2.fromCheckpoint === 2, '断点续跑：重试不再调模型，直接用已落盘的批次',
      JSON.stringify([calls, st2.fromCheckpoint]));
    ok(out.reduce((n, s) => n + s.words.length, 0) === 204, '续跑结果词数守恒');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
