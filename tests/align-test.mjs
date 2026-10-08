/**
 * 逐词时间重对齐（editor/align.js）的单测。
 *
 * 这个模块的输入是"TTS 合成语音 → 重新识别"得到的**参考节奏**，输出是原字幕里
 * 每个词的新时间。只改时间、不动文本。
 *
 * 这里重点钉住三个**实测踩过**的坑：
 *   ① `normWord` 必须能收词对象。起初只处理字符串，于是把 `{word:'This'}` 喂进去
 *      得到 "[object Object]"，一个词都配不上 —— 锚点 0/11，排查了好一阵。
 *   ② DP 回溯不能靠"比较分数"。三个候选方向平局时比分会挑错方向，一路错到底。
 *      必须在表里记录选了哪个方向。
 *   ③ 一个识别词可能对应原文多个词（TTS 把 `with velocity` 连读成 `withvelocity`）。
 *      若直接按识别词时间赋值，`with` 独吞 2.2 秒、`velocity` 只剩 0.02 秒；
 *      要按字符数在那个识别词的跨度内分摊。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const A = await import(pathToFileURL(path.join(REPO, 'editor', 'align.js')).href);

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== 1. 分词与 TTS 文本准备 ==');
{
  ok(A.tokenize('a  b\nc').join(',') === 'a,b,c', '多空白/换行按空格切分');
  ok(A.tokenize('  ').length === 0, '空白 → 无词');
  ok(A.tokenize('').length === 0, '空串 → 无词');

  // 归一化：标点、大小写、弯引号
  ok(A.normWord('useful.') === 'useful', '去尾标点');
  ok(A.normWord('"Hello') === 'hello', '去首标点 + 转小写');
  ok(A.normWord("don\u2019t") === "don't", '弯引号归一成直引号');
  // ★ 坑①：必须能收对象
  ok(A.normWord({ word: 'This' }) === 'this', '收 {word} 形式（ASR 结果）');
  ok(A.normWord({ w: 'velocity,' }) === 'velocity', '收 {w} 形式（编辑器词）');
  ok(A.normWord(null) === '', 'null → 空');

  // TTS 文本：剥掉标签，否则会被念出来
  ok(!/\{/.test(A.ttsText('{\\c&HFFFFFF&}Hello{\\c} world')), '剥掉 ASS 覆盖标签');
  ok(A.ttsText('Hello\\Nworld').trim() === 'Hello world', '硬换行变空格');
  ok(A.ttsText('[Alice] Hello').trim() === 'Hello', '剥掉 [角色名]（不是台词）');
  ok(A.ttsText('ice_ball').trim() === 'ice ball', '下划线拆成空格（否则念成怪音）');
}

console.log('\n== 2. 序列对齐 ==');
{
  const orig = ['The', 'ice', 'ball', 'is', 'useful'];
  let p = A.alignSequences(orig, orig.slice());
  ok(p.length === 5 && p.every(x => x.oi >= 0 && x.ri >= 0), '完全相同 → 全配上', p);

  // 识别里多一个词（TTS 连读）→ 只那一个落单，其余不受影响
  p = A.alignSequences(orig, ['The', 'iceball', 'is', 'useful']);
  const matched = p.filter(x => x.oi >= 0 && x.ri >= 0);
  ok(matched.length >= 3, '少一个词时其余仍能配上（局部消化，不整体错位）', matched.length);

  // 识别里少一个词
  p = A.alignSequences(orig, ['The', 'ice', 'is', 'useful']);
  ok(p.filter(x => x.oi >= 0 && x.ri >= 0).length >= 3, '识别漏词时其余仍配上', p);

  // ★ 坑②：平局时也要挑对方向 —— 这是回归断言
  p = A.alignSequences(['a', 'b', 'c'], ['a', 'b', 'c']);
  ok(p.every(x => x.oi >= 0 && x.ri >= 0), '无歧义时全部配上（前向回溯不会走偏）', p);

  // 编辑距离
  ok(A.editDistance1('hello', 'hello'), '相同 → true');
  ok(A.editDistance1('hello', 'hallo'), '替换一个字符 → true');
  ok(A.editDistance1('hello', 'helloo'), '插入一个字符 → true');
  ok(A.editDistance1('hello', 'hell'), '删除一个字符 → true');
  ok(!A.editDistance1('hello', 'world'), '完全不同 → false');
  ok(!A.editDistance1('a', 'abcd'), '长度差太多 → false');

  ok(A.alignSequences([], ['a']).length === 0, '原文为空 → 无配对');
  ok(A.alignSequences(['a'], []).length === 0, '识别为空 → 无配对');
}

console.log('\n== 3. 时间映射：块范围与单调性 ==');
{
  const toks = A.tokenize('one two three four');
  const rec = [
    { word: 'one', start: 0, end: 1 },
    { word: 'two', start: 1, end: 2 },
    { word: 'three', start: 2, end: 3 },
    { word: 'four', start: 3, end: 4 },
  ];
  const pairs = A.alignSequences(toks, rec);
  const t = A.mapTimes(toks, rec, pairs, 100, 120);
  ok(t.length === 4, '每词都有时间', t.length);
  ok(Math.abs(t[0].s - 100) < 1e-6, '首词起点贴块首', t[0].s);
  ok(Math.abs(t[3].e - 120) < 1e-6, '末词终点贴块尾', t[3].e);
  for (let i = 1; i < t.length; i++) {
    ok(t[i].s >= t[i - 1].e - 1e-6, `第 ${i + 1} 词不与前词重叠`, [t[i - 1].e, t[i].s]);
  }
  ok(Math.abs(t[0].e - 105) < 1e-6, '参考节奏被等比放大（4s → 20s，每词 5s）', t[0].e);

  // 完全没有识别结果 → 按字符数摊分（退路，不该崩）
  const ev = A.mapTimes(toks, [], [], 0, 8);
  ok(ev.length === 4 && ev.every(x => x.e > x.s), '无锚点时按字符数摊分', ev);
  ok(Math.abs(ev[3].e - 8) < 1e-6, '无锚点时仍铺满块', ev[3].e);
}

console.log('\n== 4. ★ 坑③：一个识别词对应原文多个词时要分摊 ==');
{
  /* 实测形态：原文 `with velocity` 被 TTS 念成 `withvelocity`，
   * 识别里只有一个词。若不按字符数分摊，`with` 会独吞整段。 */
  const orig = 'This damage scaling with velocity, should make the ice ball useful.';
  const toks = A.tokenize(orig);
  const rec = ['This', 'damage', 'scaling', 'withvelocity', 'should', 'make', 'the', 'ice', 'ball', 'useful.']
    .map((w, i) => ({ word: w, start: i * 0.4, end: (i + 1) * 0.4 }));
  rec[3].end = 2.0;                       // withvelocity 占 1.2~2.0，是相邻词的两倍长
  for (let i = 4; i < rec.length; i++) {  // 后面的词跟着后移，保持时间单调
    rec[i].start += 0.4;
    rec[i].end += 0.4;
  }
  const plan = A.planBlock(orig, { start: 0, end: 10 }, rec);
  ok(plan.ok, '锚点率达标', { anchors: plan.anchors, ratio: plan.ratio });
  const withW = plan.words.find(w => w.w === 'with');
  const velW = plan.words.find(w => w.w === 'velocity,');
  ok(withW && velW, '两个词都在', plan.words.map(w => w.w));
  const dw = withW.e - withW.s, dv = velW.e - velW.s;
  ok(dv > 0.05, `velocity 不再被挤成零宽（实得 ${dv.toFixed(3)}s）`, dv);
  ok(dw > 0.05, `with 也有合理时长（实得 ${dw.toFixed(3)}s）`, dw);
  // 字符数 4 : 8 → 后者约为前者两倍（允许参考节奏带来的浮动）
  ok(dv / dw > 1.2 && dv / dw < 5, '两词时长比例接近字符数之比', { dw, dv, ratio: dv / dw });
  // 块范围与单调性
  ok(Math.abs(plan.words[0].s) < 1e-6, '首词贴块首', plan.words[0].s);
  ok(Math.abs(plan.words[plan.words.length - 1].e - 10) < 1e-6, '末词贴块尾', plan.words[plan.words.length - 1].e);
  let bad = 0;
  for (let i = 1; i < plan.words.length; i++) if (plan.words[i].s < plan.words[i - 1].e - 1e-6) bad++;
  ok(bad === 0, '单调不重叠', bad);
}

console.log('\n== 5. 不可信时明确说不（而不是给个错的时间）==');
{
  const orig = 'alpha beta gamma delta epsilon';
  // 识别结果与原文毫不相干 → 锚点率极低
  const rec = ['zzz', 'yyy', 'xxx', 'www', 'vvv'].map((w, i) => ({ word: w, start: i, end: i + 1 }));
  const plan = A.planBlock(orig, { start: 5, end: 10 }, rec);
  ok(!plan.ok, '锚点率过低 → ok=false', { ratio: plan.ratio });
  ok(/不可信/.test(plan.note), '给出可读的原因', plan.note);
  // 即使不可信，时间仍需合法（前端可能仍想看看）
  ok(plan.words.length === 5, '仍返回逐词时间（供预览）', plan.words.length);
  ok(plan.words.every(w => w.s >= 5 - 1e-6 && w.e <= 10 + 1e-6), '不越出块范围', plan.words);

  ok(A.planBlock('', { start: 0, end: 1 }, rec).ok === false, '无文本 → 不可用');
  ok(A.planBlock(orig, { start: 0, end: 1 }, []).ok === false, '无识别结果 → 不可用');
  // 时间区间无效
  ok(A.planBlock(orig, { start: 5, end: 5 }, rec).ok === false, '零长块 → 不可用');

  /* 识别偶发给零长词（start === end）不能让对应原文词塌成零宽。
   * 实测踩过：`with velocity,` 两词都变成 0.000s。 */
  const zeroRec = ['a', 'b', 'c'].map((w, i) => ({ word: w, start: i, end: i + 1 }));
  zeroRec[1].end = zeroRec[1].start;      // 故意造一个零长词
  const zp = A.planBlock('a b c', { start: 0, end: 6 }, zeroRec);
  const widths = zp.words.map(w => w.e - w.s);
  ok(widths.every(w => w > 0.01), '零长识别词不会让原文词塌成零宽', widths);
}

console.log('\n== 6. 真实样本回归（有就核对，没有就跳过）==');
{
  const p = path.join(REPO, 'tests', 'align-sample.json');
  if (!fs.existsSync(p)) {
    console.log('  SKIP 没有 tests/align-sample.json');
  } else {
    const s = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    const plan = A.planBlock(s.text, { start: s.start, end: s.end }, s.words);
    ok(plan.ok, `真实样本可用（锚点 ${plan.anchors}/${A.tokenize(s.text).length}）`, plan.ratio);
    ok(Math.abs(plan.words[0].s - s.start) < 1e-6, '首词贴块首', plan.words[0].s);
    ok(Math.abs(plan.words[plan.words.length - 1].e - s.end) < 1e-6, '末词贴块尾',
      plan.words[plan.words.length - 1].e);
  }
}

console.log('\n== 7. 前端取值路径（★ 实测踩过：读错字段导致每条都误报"没有逐词时间"）==');
{
  const MJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');

  /* 真实结构（见 rebuildItemsAndLanes）：
   *   item.l1 / item.l2 是**文本字符串**（`l1: zhText, l2: enText`）
   *   句子对象在 item.ref 上：item.ref.zh / item.ref.en，词在 .words
   * 早期写成 `item.l1.words` → 永远 undefined → 每条都提示"还没有逐词时间"。
   *
   * 这里不去跑 DOM，而是**按真实结构构造一个 item**，再把 main.js 里那段取值逻辑
   * 用同样的表达式算一遍，确认两种结构只有正确的那个能取到词。 */
  const makeItem = (withWords) => {
    const en = {
      style: 'Default', start: 1, end: 3, text: 'hello world',
      words: withWords ? [{ w: 'hello', s: 1, e: 2 }, { w: 'world', s: 2, e: 3 }] : [],
      events: [{}],
    };
    const zh = { style: '中文字幕', start: 1, end: 3, text: '你好世界', words: [], events: [{}] };
    const row = { zh, en, start: 1, end: 3 };
    return { kind: 'ass-row', ref: row, l1: zh.text, l2: en.text };  // ← l1/l2 是字符串
  };

  const item = makeItem(true);
  ok(typeof item.l1 === 'string', '前提：item.l1 是字符串（不是句子对象）');
  ok(item.l1.words === undefined, '前提：item.l1.words 取不到词（旧写法必错）');
  // 正确路径
  const en = item.ref && item.ref.en;
  ok(!!en, '正确路径 item.ref.en 能取到英文句');
  ok(Array.isArray(en.words) && en.words.length === 2, '词在 en.words 上', en.words.length);
  ok(Number.isFinite(en.start) && Number.isFinite(en.end), '句子自带 start/end（逐词时间要用它，不是整行的）');

  // 没有逐词时也要能识别出来（不该误报成"有"）
  const bare = makeItem(false);
  ok(!(bare.ref.en.words || []).length, '无逐词时正确判为无');

  // 源码接线（反向断言：不许退回错误路径）
  ok(/const row = item && item\.ref;/.test(MJ), 'realignRow 从 item.ref 取行');
  ok(/const en = \(row && row\.en\) \|\| null;/.test(MJ), '英文句取自 row.en');
  // 反向断言：不许退回错误路径。
  // ⚠ 必须排除注释行 —— 我在 realignRow 的注释里写了 `item.l1.words` 来解释这个坑，
  //   用裸的 /item\.l1\.words/ 会把注释也算上（实测误报）。
  const codeLines = MJ.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  ok(!codeLines.some(l => /item\.l1\.words/.test(l)),
    '代码里不再用 item.l1.words（那永远是 undefined）');
  ok(/const start = Number\(en\.start\), end = Number\(en\.end\);/.test(MJ),
    '用句子自己的时间，而不是整行的时间');
  // 提示要给出真实路径，别说"先用转逐词"却不说在哪
  ok(/设置.*逐词转换.*转逐词/.test(MJ), '提示里给出「转逐词」的实际位置');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
