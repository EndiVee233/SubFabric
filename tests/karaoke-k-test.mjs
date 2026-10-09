/**
 * \k 卡拉OK形态 单测: node tests/karaoke-k-test.mjs
 *
 * 覆盖设计稿 §12 的 P1 验证计划:
 *   ① parseKLine 黄金用例 —— 段序列/厘秒累计/filler 空档/\kf\K\ko\kt 读入/边界夹取/黏连标点
 *   ② buildWordSpecsK 黄金用例 —— 颜色头、词间空档 filler、末词贴齐、单调防御、段时长总和 = 行时长
 *   ③ 往返 ≡ 原样: 整文档 analyze → buildWordSpecs → 序列化 → 重新 analyze,
 *      words 序列与**厘秒时间严格相等**（karStyle / 高亮色 / 未唱色一并保真）
 *   ④ 说话人色: k 行从 \2c 读角色色; 无角色行不得整片染色（回归防线）
 *   ⑤ 混合文件（颜色切片行 + k 行）配对不受影响
 *   ⑥ 颜色路径零回归: 无 karStyle 的句子仍走原实现
 *
 * 直接 import ../editor/js/*.js（与 effect-reimport-test.mjs 同款, 测的永远是源文件）。
 */
import { AssDoc } from '../editor/js/ass.js';
import {
  DEFAULT_POSTPROCESS_CONFIG, cloneConfig, applyPostProcess, stripEffectTagsSafe
} from '../editor/js/postprocess.js';
import {
  analyzeKaraoke, pairRows, parseKLine, buildWordSpecs, recalcWords,
  speakerColorOf, speakerTagOf, splitEnglishWords, kLineTokens,
  replaceWordHighlightColor, replaceKaraokeBaseColor, replaceKaraokeTag
} from '../editor/js/karaoke.js';

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (got, want, n) => ok(JSON.stringify(got) === JSON.stringify(want), n, { got, want });
/** 词序列 → 可比较形式: [词, 起始厘秒, 结束厘秒] */
const csWords = (ws) => ws.map(w => [w.w, Math.round(w.s * 100), Math.round(w.e * 100)]);
/** 从事件文本里把全部 \k 段时长加起来（应严格等于行时长） */
const kSum = (t) => {
  let sum = 0;
  const re = /\\[kK](?:[fo]|t)?\s*(\d+)/g;
  let m; while ((m = re.exec(t))) sum += parseInt(m[1], 10);
  return sum;
};
const kDurs = (t) => {
  const out = []; const re = /\\[kK](?:[fo]|t)?\s*(\d+)/g;
  let m; while ((m = re.exec(t))) out.push(parseInt(m[1], 10));
  return out;
};

console.log('========================================');
console.log('\\k 卡拉OK形态：解析 / 生成 / 往返');
console.log('========================================');

/* ══════════════ 1. parseKLine 黄金用例 ══════════════ */
console.log('\n── 1. parseKLine 黄金用例 ──');
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k50}hello {\\k70}world', 1.0, 2.2);
  eq(csWords(r.words), [['hello', 100, 150], ['world', 150, 220]], '基本: 词时间按厘秒累计');
  ok(r.text === 'hello world', '基本: text = 词序列（空格拼接）');
  ok(r.head === '\\1c&H00FF00&', '基本: head = 首个 \\k 之前的覆盖块内部');
  ok(r.highlightTag === '{\\c&H00FF00&}', '基本: highlightTag 由 \\1c 解析');
  ok(r.baseHex === null, '基本: 无 \\2c → baseHex = null');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k20}{\\k50}hello{\\k30}{\\k70}world', 1.0, 3.0);
  eq(csWords(r.words), [['hello', 120, 170], ['world', 200, 270]],
    'filler 空档: 空段只推进进度、不产词 → 词的真实 e 保真');
  ok(kSum('{\\1c&H00FF00&}{\\k20}{\\k50}hello{\\k30}{\\k70}world') === 170, 'filler 空档: 段时长总和 = 170cs');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\kf50}a{\\K60}b{\\ko70}c', 1.0, 4.0);
  eq(csWords(r.words), [['a', 100, 150], ['b', 150, 210], ['c', 210, 280]],
    '\\kf / \\K / \\ko 一律按"段时长"等价读入');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\kt100}{\\k50}hello', 1.0, 3.0);
  eq(csWords(r.words), [['hello', 200, 250]], '\\kt<cs>: 下一段起点 = 相对行首的绝对时间');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k 50}hi', 1.0, 2.0);
  eq(csWords(r.words), [['hi', 100, 150]], '标签内空格（{\\k 50}）容错');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k50}{\\k50}', 1.0, 2.0);
  ok(r.words.length === 0 && r.text === '', '空词条 k 行 → words=[]（分析侧退回整句, 不崩）');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k50}a{\\k50}b{\\k50}c', 1.0, 1.5);
  eq(csWords(r.words), [['a', 100, 150], ['b', 150, 150], ['c', 150, 150]],
    '\\k 总长超出事件范围 → 词时间夹进 [start,end] 且仍单调不越界');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k50}world,{\\k50}don\'t {\\k50}go.', 1.0, 2.5);
  eq(r.words.map(w => w.w), ['world,', "don't", 'go.'], '黏连标点原样留在词里');
  eq(splitEnglishWords(r.text), ['world,', "don't", 'go.'], '与 splitEnglishWords 同口径（标点挂词尾）');
}
{
  const r = parseKLine('前言{\\k50}hello', 1.0, 2.0);
  ok(r.words.length === 1 && r.words[0].w === '前言hello', '首个 \\k 之前的散文本并入第一段（罕见布局）');
}
{
  const r = parseKLine('{\\an8\\1c&H0000FF&\\2c&H0B0BE5&}{\\k50}hi', 1.0, 2.0);
  ok(r.head === '\\an8\\1c&H0000FF&\\2c&H0B0BE5&', 'head 完整保留（含 \\an8 等其它 tag）');
  ok(r.highlightTag === '{\\c&H0000FF&}', '\\1c 解析为已唱色');
  ok(r.baseHex === '#e50b0b', '\\2c → #rrggbb（&HBBGGRR 互换, 小写）');
}
{
  const r = parseKLine('{\\1c&H00FF00&}{\\k0}a{\\k30}b', 1.0, 2.0);
  eq(csWords(r.words), [['a', 100, 100], ['b', 100, 130]], '零时长段不吞掉后续词（脏数据容忍）');
}

/* ══════════════ 2. buildWordSpecsK 黄金用例 ══════════════ */
console.log('\n── 2. buildWordSpecsK 黄金用例 ──');
const mkSent = (o) => Object.assign({
  style: 'Default', start: 1.0, end: 3.0, text: 'hello world',
  events: [], words: [{ w: 'hello', s: 1.0, e: 1.4 }, { w: 'world', s: 1.8, e: 3.0 }],
  proto: { layer: '0', name: '', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } },
  highlightTag: '{\\c&H00FF00&}', karStyle: 'k', kHead: '\\1c&H00FF00&', kBaseHex: null
}, o);
{
  const specs = buildWordSpecs(mkSent());
  ok(specs.length === 1, 'k 形态 = 单事件整行');
  eq(specs[0].text, '{\\1c&H00FF00&}{\\k40}hello {\\k40}{\\k120}world',
    'golden: 颜色头 + 词段 + 词间空档 filler（末段吸收到行尾）');
  ok(specs[0].start === 1.0 && specs[0].end === 3.0, 'k 形态: 事件起止 = 句起止');
  ok(kSum(specs[0].text) === 200, '段时长总和 = 行时长（200cs）');
}
{
  const specs = buildWordSpecs(mkSent({ highlightTag: '{\\c&H0000FF&}', kBaseHex: '#e50b0b' }));
  eq(specs[0].text, '{\\1c&H0000FF&\\2c&H0B0BE5&}{\\k40}hello {\\k40}{\\k120}world',
    'golden: 已唱色 ← highlightTag、未唱色 ← kBaseHex（BGR 互换）');
  const back = parseKLine(specs[0].text, 1.0, 3.0);
  ok(back.highlightTag === '{\\c&H0000FF&}' && back.baseHex === '#e50b0b', '两色存取互逆');
}
{
  const specs = buildWordSpecs(mkSent({ kHead: '\\an8\\1c&HFF00FF&\\2c&H00FF00&', kBaseHex: '#00ff00' }));
  ok(specs[0].text.startsWith('{\\1c&H00FF00&\\2c&H00FF00&\\an8}{\\k40}'),
    'kHead 里的其它 tag（\\an8）保留, 颜色位统一重写一份（无重复）', specs[0].text);
  ok((specs[0].text.match(/\\1c&H/g) || []).length === 1 && (specs[0].text.match(/\\2c&H/g) || []).length === 1,
    '颜色位各出现且仅出现一次');
}
{
  const specs = buildWordSpecs(mkSent({ start: 1.0, end: 2.5, text: 'a b', words: [{ w: 'a', s: 1.0, e: 2.0 }, { w: 'b', s: 1.5, e: 2.2 }] }));
  eq(specs[0].text, '{\\1c&H00FF00&}{\\k100}a {\\k20}b{\\k30}',
    '单调防御: 重叠词边界推平 → 无负时长, 行尾兜底');
  ok(kSum(specs[0].text) === 150, '单调防御: 总和仍 = 行时长（150cs）');
}
{
  const specs = buildWordSpecs(mkSent({ start: 1.0, end: 2.0, words: [{ w: 'solo', s: 1.2, e: 1.6 }] }));
  eq(specs[0].text, '{\\1c&H00FF00&}{\\k20}{\\k40}solo{\\k40}',
    'golden: 句首空档 filler + 词段 + 行尾兜底');
}
{
  const specs = buildWordSpecs(mkSent({ words: [], text: 'plain line' }));
  ok(specs.length === 1 && specs[0].text === 'plain line' && !/\\k/.test(specs[0].text),
    '无词句子 → 单条纯文本事件（与颜色形态同语义）');
}
{
  const once = buildWordSpecs(mkSent())[0].text;
  const again = buildWordSpecs(mkSent({ words: parseKLine(once, 1.0, 3.0).words }))[0].text;
  eq(again, once, '幂等: 重建 → 解析 → 再重建 逐字节一致');
}
{
  const specs = buildWordSpecs(mkSent({ words: [{ w: 'a', s: 1.0, e: 1.1 }, { w: 'b', s: 1.1, e: 1.2 }, { w: 'c', s: 1.2, e: 1.3 }] }));
  eq(kDurs(specs[0].text), [10, 10, 10, 170],
    '连排词 + 行尾长兜底：不造零时长段, 尾部一次补齐');
}

/* ══════════════ 3. 整文档往返 ≡ 原样 ══════════════ */
console.log('\n── 3. 整文档往返（analyze → build → serialize → analyze）──');
const K_DOC = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
  'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  // 1: 普通 + 词间空档（filler）
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k40}hello {\\k40}{\\k120}world',
  'Dialogue: 0,0:00:01.00,0:00:03.00,中文字幕,,0,0,0,,{\\c&H0000FFFF&}你好世界',
  // 2: 已唱色 + 未唱色（角色色）
  'Dialogue: 0,0:00:03.50,0:00:05.50,Default,,0,0,0,,{\\1c&H0000FF&\\2c&H0B0BE5&}[Spoke]{\\k50}second {\\k150}row',
  'Dialogue: 0,0:00:03.50,0:00:05.50,中文字幕,,0,0,0,,{\\c&H0B0BE5&}[Spoke]第二行',
  // 3: \kf 读入（重新生成时统一成 \k）
  'Dialogue: 0,0:00:06.00,0:00:08.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\kf60}kay {\\kf140}eff',
  'Dialogue: 0,0:00:06.00,0:00:08.00,中文字幕,,0,0,0,,第三行',
  // 4: 头部带其它 tag
  'Dialogue: 0,0:00:08.50,0:00:10.00,Default,,0,0,0,,{\\an8\\1c&H00FF00&\\2c&HFFFFFF&}{\\k50}a {\\k100}b',
  'Dialogue: 0,0:00:08.50,0:00:10.00,中文字幕,,0,0,0,,第四行',
  // 5: 句首空档
  'Dialogue: 0,0:00:10.50,0:00:12.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k30}{\\k70}late {\\k50}start',
  'Dialogue: 0,0:00:10.50,0:00:12.00,中文字幕,,0,0,0,,第五行',
  // 6: 黏连标点
  'Dialogue: 0,0:00:12.50,0:00:14.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k50}SMP, {\\k100}plan.to',
  'Dialogue: 0,0:00:12.50,0:00:14.00,中文字幕,,0,0,0,,第六行',
].join('\n');

function analyzeDoc(text) {
  const doc = new AssDoc(text);
  const kar = analyzeKaraoke(doc);
  return { doc, kar, rows: pairRows(kar.sentences, kar.wordStyle) };
}

const A = analyzeDoc(K_DOC);
const kSent0 = A.kar.sentences.filter(s => s.karStyle === 'k');
ok(kSent0.length === 6, '识别: 6 条 k 行（单事件整行）都进了句子模型', kSent0.length);
ok(A.kar.sentences.filter(s => s.karStyle !== 'k').length === 6, '识别: 6 条中文锚点行不受影响');
ok(A.rows.length === 6, '配对: 6 行（每行中文 + 英文）', A.rows.length);
ok(kSent0.every(s => s.words.length >= 2), '识别: 每句都解析出词');
ok(kSent0.some(s => s.kBaseHex === '#e50b0b'), '识别: 第 2 行 \\2c&H0B0BE5& → 未唱色 #e50b0b');
ok(kSent0.find(s => /SMP/.test(s.text)).words.map(w => w.w).join('|') === 'SMP,|plan.to',
  '识别: 黏连标点行分词正确');

// 模拟"任何一次编辑之后的保存": 全部 k 行按各自形态重建 → 序列化 → 重新分析
const out = (() => {
  for (const s of A.kar.sentences) if (s.karStyle === 'k') s.events = A.doc.replaceEvents(s.events, buildWordSpecs(s));
  return A.doc.serialize();
})();
const B = analyzeDoc(out);
const kSent1 = B.kar.sentences.filter(s => s.karStyle === 'k');
ok(kSent1.length === 6, '往返: 重新识别仍是 6 条 k 行', kSent1.length);
ok(kSent1.every(s => s.events.length === 1), '往返: 每条 k 行都还是单事件（没有碎成切片）');
ok(B.rows.length === 6, '往返: 行数不变', B.rows.length);
{
  // 词序列 + 厘秒时间严格相等
  const a = kSent0.map(s => csWords(s.words));
  const b = kSent1.map(s => csWords(s.words));
  eq(b, a, '往返: words 序列与厘秒时间**严格相等**（误差 0）');
}
{
  const pair = (arr) => arr.map(s => s.highlightTag + '|' + s.kBaseHex);
  eq(pair(kSent1), pair(kSent0), '往返: 已唱色 / 未唱色保真');
}
{
  const heads = kSent1.map(s => s.kHead);
  ok(heads.some(h => /\\an8/.test(h)), '往返: 头部其它 tag（\\an8）继续保留');
  ok(kSent1.every(s => (s.kHead.match(/\\1c&H/g) || []).length === 1), '往返: 颜色位不重复累积');
}
{
  // 二次往返（保存两次）也必须稳定
  for (const s of B.kar.sentences) if (s.karStyle === 'k') s.events = B.doc.replaceEvents(s.events, buildWordSpecs(s));
  const out2 = B.doc.serialize();
  eq(out2, out, '往返: 第二次保存逐字节等于第一次（不动即不变）');
}
{
  // 编辑（拖词边界）→ 保存 → 重载, 新边界精准落盘
  const C = analyzeDoc(K_DOC);
  const s0 = C.kar.sentences.filter(s => s.karStyle === 'k')[0];
  s0.words[0].e = s0.words[0].e + 0.3;             // 把首词拉长 0.3s
  s0.events = C.doc.replaceEvents(s0.events, buildWordSpecs(s0));
  const D = analyzeDoc(C.doc.serialize());
  const s1 = D.kar.sentences.filter(s => s.karStyle === 'k')[0];
  eq(csWords(s1.words), csWords(s0.words), '编辑: 拖动词边界后重载, 词时间与内存模型一致');
}
{
  // 改文本（词数变化）→ recalcWords → k 形态重建
  const C = analyzeDoc(K_DOC);
  const s0 = C.kar.sentences.filter(s => s.karStyle === 'k')[0];
  const newText = 'hello brave new world';
  s0.words = recalcWords(s0, newText, s0.start, s0.end);
  const specs = buildWordSpecs(s0);
  ok(specs.length === 1 && (specs[0].text.match(/\\k/g) || []).length === 4 + 0,
    '编辑: 词数变化后重建仍是单事件、段数 = 词数', specs[0].text);
  eq(kSum(specs[0].text), Math.round((s0.end - s0.start) * 100), '编辑: 段时长总和 = 行时长');
  const back = parseKLine(specs[0].text, s0.start, s0.end);
  eq(back.words.map(w => w.w).join(' '), newText, '编辑: 新文本完整落进 k 行');
}
{
  // 导出（干净 ASS）里 k 行不会被"去逐词"逻辑抹成纯文本
  const C = analyzeDoc(K_DOC);
  const s0 = C.kar.sentences.filter(s => s.karStyle === 'k')[0];
  const specs = buildWordSpecs(s0);
  ok(/\\k\d+/.test(specs[0].text) && !/\\c&H/.test(specs[0].text.replace(/\\[12]c&H/g, '')),
    '导出: 输出只带 \\k（没有逐词颜色 span 混入）');
}

/* ══════════════ 4. 说话人色（k 行 \2c） ══════════════ */
console.log('\n── 4. 说话人色：k 行读 \\2c ──');
const fake = (text, name) => ({
  style: 'Default', start: 1, end: 2, text, words: [],
  events: [{ text }], karStyle: 'k',
  proto: { layer: '0', name: name || '', effect: '', margins: {} }
});
ok(speakerColorOf(fake('{\\1c&H00FF00&\\2c&H0B0BE5&}[Spoke]{\\k50}hi')) === '#e50b0b',
  'k 行 + 角色标签 → 角色色取自 \\2c（&HBBGGRR → #rrggbb）');
ok(speakerColorOf(fake('{\\1c&H00FF00&\\2c&H0B0BE5&}{\\k50}hi')) === null,
  'k 行但**无角色** → 不把未唱默认色当成角色色（防整行染色）');
ok(speakerColorOf(fake('{\\1c&H00FF00&\\2c&H00FF00&}[Spoke]{\\k50}hi')) === null,
  '\\2c 恰为高亮色 → 不算角色色');
ok(speakerTagOf(fake('{\\1c&H00FF00&}{\\k50}[Spoke]hi')) === '[Spoke]',
  'k 行角色标签识别（\\k 段包住 [Spoke] 也能认）');
ok(speakerColorOf({ style: 'Default', start: 1, end: 2, text: 'x', words: [], karStyle: 'color',
  events: [{ text: '{\\c&H0B0BE5&}[Spoke]hello' }], proto: { name: '' } }) === '#e50b0b',
  '颜色行原行为不变（行首 \\c）');

/* ══════════════ 5. 混合文件（颜色切片 + k 行） ══════════════ */
console.log('\n── 5. 混合文件配对 ──');
const MIX = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
  'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  // 第 1~3 行: 颜色切片形态（每句 3 片）
  'Dialogue: 0,0:00:01.00,0:00:01.75,Default,,0,0,0,,{\\c&H00FF00&}alpha{\\c} beta gamma',
  'Dialogue: 0,0:00:01.75,0:00:02.50,Default,,0,0,0,,alpha {\\c&H00FF00&}beta{\\c} gamma',
  'Dialogue: 0,0:00:02.50,0:00:03.25,Default,,0,0,0,,alpha beta {\\c&H00FF00&}gamma{\\c}',
  'Dialogue: 0,0:00:01.00,0:00:03.25,中文字幕,,0,0,0,,第一行',
  'Dialogue: 0,0:00:04.00,0:00:04.75,Default,,0,0,0,,{\\c&H00FF00&}delta{\\c} eps zeta',
  'Dialogue: 0,0:00:04.75,0:00:05.50,Default,,0,0,0,,delta {\\c&H00FF00&}eps{\\c} zeta',
  'Dialogue: 0,0:00:05.50,0:00:06.25,Default,,0,0,0,,delta eps {\\c&H00FF00&}zeta{\\c}',
  'Dialogue: 0,0:00:04.00,0:00:06.25,中文字幕,,0,0,0,,第二行',
  // 第 3 行: k 形态
  'Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k50}kilo {\\k1 50}mike',
  'Dialogue: 0,0:00:07.00,0:00:09.00,中文字幕,,0,0,0,,第三行',
].join('\n');
{
  const M = analyzeDoc(MIX);
  const ks = M.kar.sentences.filter(s => s.karStyle === 'k');
  const cs = M.kar.sentences.filter(s => s.karStyle !== 'k' && s.words.length);
  ok(ks.length === 1, '混合: 1 条 k 句', ks.length);
  ok(cs.length === 2, '混合: 2 条颜色切片句', cs.length);
  ok(M.kar.wordStyle === 'Default', '混合: 逐词样式识别为 Default');
  ok(M.rows.length === 3, '混合: 3 行', M.rows.length);
  const kRow = M.rows.find(r => r.en && r.en.karStyle === 'k');
  ok(!!kRow && kRow.zh && kRow.zh.style === '中文字幕', '混合: k 句照常与中文行配对');
  const specs = buildWordSpecs(kRow.en);
  ok(specs.length === 1 && /\\k\d+/.test(specs[0].text), '混合: 重建时 k 句仍走 k 形态');
  const back = analyzeDoc(M.doc.serialize());
  const ks2 = back.kar.sentences.filter(s => s.karStyle === 'k');
  eq(csWords(ks2[0].words), csWords(ks[0].words), '混合: k 句往返保真');
  ok(back.kar.sentences.filter(s => s.karStyle !== 'k' && s.words.length).length === 2,
    '混合: 颜色句仍是颜色句（形态互不污染）');
}

/* ══════════════ 6. 颜色路径零回归 ══════════════ */
console.log('\n── 6. 颜色路径零回归 ──');
{
  const colorSent = {
    style: 'Default', start: 1.0, end: 2.0, text: 'alpha beta',
    events: [], words: [{ w: 'alpha', s: 1.0, e: 1.5 }, { w: 'beta', s: 1.5, e: 2.0 }],
    proto: { layer: '0', name: '', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } },
    highlightTag: '{\\c&H00FF00&}'
  };
  const specs = buildWordSpecs(colorSent);
  ok(specs.length === 2, '无 karStyle → 仍走颜色切片形态（逐词一条）', specs.length);
  eq(specs.map(s => s.text),
    ['{\\c&H00FF00&}alpha{\\c} beta', 'alpha {\\c&H00FF00&}beta{\\c}'],
    '无 karStyle → 输出逐字节仍是原颜色切片（原位包标签）');
  ok(!specs.some(s => /\\k\d/.test(s.text)), '无 karStyle → 绝不产出 \\k 标签');
  const sentColor = Object.assign({}, colorSent, { karStyle: 'color' });
  eq(buildWordSpecs(sentColor).map(s => s.text), specs.map(s => s.text), 'karStyle="color" 与无 karStyle 完全一致');
}

/* ══════════════ 7. 边界与护栏 ══════════════ */
console.log('\n── 7. 边界与护栏 ──');
{
  // 中文行零改动（用户硬要求："中文仍然无特效"）：重建只碰 k 行, 中文 Dialogue 行必须逐字节不变
  const zhIn = K_DOC.split('\n').filter(l => /中文字幕/.test(l) && /^Dialogue:/.test(l));
  const zhOut = out.split(/\r?\n/).filter(l => /中文字幕/.test(l) && /^Dialogue:/.test(l));
  eq(zhOut, zhIn, '护栏: 中文行逐字节不变（绝不注入 \\k / 颜色头）');
  const kCount = (s) => (s.match(/\\[kK][fo]?\s*\d+/g) || []).length;
  eq(kCount(out), kCount(K_DOC), '护栏: 重建不改段序列长度（段数守恒, 只重算时长）');
  ok(!zhOut.some(l => /\\[kK]\d/.test(l)), '护栏: 中文行里一个 \\k 都没有');
}
{
  // 外来文件尾部留空（\\k 总长 < 行时长）: 原样往返, 不静默改写词时间
  const TAIL = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
    'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:20.00,0:00:22.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k50}tail {\\k50}short',
    'Dialogue: 0,0:00:20.00,0:00:22.00,中文字幕,,0,0,0,,尾部留空',
    'Dialogue: 0,0:00:23.00,0:00:25.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k100}over {\\k150}long',
    'Dialogue: 0,0:00:23.00,0:00:25.00,中文字幕,,0,0,0,,超长',
  ].join('\n');
  const T = analyzeDoc(TAIL);
  const ts = T.kar.sentences.filter(s => s.karStyle === 'k');
  ok(ts.length === 2, '尾部留空: 2 条 k 行都识别', ts.length);
  const before = ts.map(s => csWords(s.words));
  ok(before[0][1][2] === 2100, '尾部留空: 读取时词 e 保持文件里的真值（21.00s, 不拉伸到行尾）', before[0]);
  ok(before[1][1][2] === 2500, '超长: 词时间被夹进行尾（25.00s）', before[1]);
  for (const s of T.kar.sentences) if (s.karStyle === 'k') s.events = T.doc.replaceEvents(s.events, buildWordSpecs(s));
  const tout = T.doc.serialize();
  const T2 = analyzeDoc(tout);
  const ts2 = T2.kar.sentences.filter(s => s.karStyle === 'k');
  eq(ts2.map(s => csWords(s.words)), before, '尾部留空 / 超长: 一次保存后重新载入, 词时间一字不差');
  for (const s of ts) eq(kSum(buildWordSpecs(s)[0].text), Math.round((s.end - s.start) * 100),
    `段时长总和恒 = 行时长（${s.text.slice(0, 12)}…）`);
  eq(T2.doc.serialize(), tout, '尾部留空: 二次保存逐字节稳定');
}
{
  // 小文件（同一样式不足 6 条）→ 逐词样式靠时间包含规律推断, k 行照样进模型
  const SMALL = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
    'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k50}hi {\\k50}ya',
    'Dialogue: 0,0:00:01.00,0:00:02.00,中文字幕,,0,0,0,,嗨呀',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k50}go {\\k50}on',
    'Dialogue: 0,0:00:03.00,0:00:04.00,中文字幕,,0,0,0,,继续',
  ].join('\n');
  const S = analyzeDoc(SMALL);
  ok(S.kar.wordStyle === 'Default', '小文件: 逐词样式由"时间包含"规律推断出来（< 6 条也能用）', S.kar.wordStyle);
  ok(S.kar.sentences.filter(s => s.karStyle === 'k').length === 2, '小文件: 2 条 k 行进模型');
  ok(S.rows.length === 2 && S.rows.every(r => r.zh && r.en && r.en.karStyle === 'k'),
    '小文件: 中英照常配对, 英文句仍是 k 形态', S.rows.map(r => [!!r.zh, !!r.en, r.en && r.en.karStyle]));
}

{
  // kLineTokens: 坏行检测判"文件侧 \k 段数 ⟷ 内存 words"是否漂移的锚点。
  // 不能用 splitEnglishWords 判 k 行（它按标点再切一刀, 与作者的音节切分本就不同 → 一打开外来
  // k 文件就整轨误报"英文缺词"）。
  const C = analyzeDoc(K_DOC);
  const ks = C.kar.sentences.filter(s => s.karStyle === 'k');
  ok(typeof kLineTokens === 'function', 'kLineTokens 已导出（main.js 坏行检测依赖）');
  ok(ks.every(s => kLineTokens(s) === s.words.length), 'kLineTokens = 文件侧段数, 与内存一致 → 不误报');
  const s0 = ks[0];
  const drift = s0.words.pop();                     // 人为制造漂移（内存少一个词）
  ok(kLineTokens(s0) === s0.words.length + 1, 'kLineTokens: 内存丢词时能检出漂移', { got: kLineTokens(s0), words: s0.words.length });
  s0.words.push(drift);
  const zh = C.kar.sentences.find(s => s.karStyle !== 'k');
  ok(kLineTokens(zh) === 0, '非 k 行 → 0（调用方按"无从判定"跳过, 不误判）');
  ok(kLineTokens({ events: [{ text: 'x' }, { text: 'y' }], start: 0, end: 1 }) === 0, '多事件脏数据 → 0');
  ok(kLineTokens(null) === 0, 'null 入参 → 0（不抛）');
}
{
  // 混切分（'plan.to' 一段 / 'SMP,' 一段）: 本应用口径是 3 个词, 文件只有 2 段 —— 这正是
  // 必须用 kLineTokens 而非 splitEnglishWords 的场景。
  const C = analyzeDoc(K_DOC);
  const s0 = C.kar.sentences.filter(s => s.karStyle === 'k').find(s => /SMP/.test(s.text));
  ok(splitEnglishWords(s0.text).length === 3 && s0.words.length === 2,
    '混切分场景确实存在（splitEnglishWords 3 ≠ 文件段 2）', { split: splitEnglishWords(s0.text), words: s0.words.map(w => w.w) });
  ok(kLineTokens(s0) === 2, 'k 行改用文件侧段数后不再误报缺词');
}

/* ══════════════ 8. 特效面板 × k 行 ══════════════ */
console.log('\n── 8. 特效面板 × k 行（postprocess 零改动）──');
{
  const PP_DOC = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
    'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\1c&H00FF00&\\2c&H0000FF&}{\\k40}hello {\\k40}{\\k120}world',
    'Dialogue: 0,0:00:01.00,0:00:03.00,中文字幕,,0,0,0,,{\\c&H0000FFFF&}你好世界',
    'Dialogue: 0,0:00:03.50,0:00:04.75,Default,,0,0,0,,{\\c&H00FF00&}plain{\\c} color row',
    'Dialogue: 0,0:00:03.50,0:00:04.75,中文字幕,,0,0,0,,颜色行',
  ].join('\n');
  const mkCfg = (mut) => {
    const c = cloneConfig(DEFAULT_POSTPROCESS_CONFIG);
    c.enabled = true; c.glow.enabled = false; c.grow.enabled = false; c.fadein.enabled = false;
    mut(c); return c;
  };
  const dlg = (t) => t.split(/\r?\n/).filter(l => /^Dialogue:/.test(l));
  const cfgLine = (k, v) => { const c = mkCfg(x => { x[k].enabled = true; if (v) Object.assign(x[k], v); }); return c; };
  const PP_CASES = [
    ['整行淡入', cfgLine('fadein', { target: 'all' }), true],
    ['整行微光(en)', cfgLine('glow', { target: 'en' }), true],
    ['活动词微光', cfgLine('glow', { target: 'active_word' }), false],
    ['词生长', cfgLine('grow', { scale: 130 }), false],
    ['全特效', mkCfg(c => {
      c.glow.enabled = true; c.glow.target = 'active_word';
      c.grow.enabled = true; c.grow.scale = 130;
      c.fadein.enabled = true; c.fadein.target = 'all';
    }), true],
  ];
  const src = dlg(PP_DOC);
  for (const [name, cfg, kTouched] of PP_CASES) {
    const out = applyPostProcess(PP_DOC, cfg);
    const after = dlg(out);
    const kSame = after[0] === src[0];
    const colorChanged = after[2] !== src[2];
    ok(colorChanged, name + ': 特效确实生效（同文档的颜色行被改）');
    ok(kSame === !kTouched, name + ': k 行' + (kTouched ? '接受整行特效' : '**零改动**（词级特效自动跳过）'),
      { k: after[0].slice(after[0].indexOf(',,') + 2) });
    if (kTouched) {
      ok(/\\k\d/.test(after[0]) && /\\1c&H00FF00&/.test(after[0]) && /\\2c&H0000FF&/.test(after[0]),
        name + ': k 行加上特效后 \\k 与颜色头都还在');
    }
    const { text: back, cleaned } = stripEffectTagsSafe(out);
    ok(cleaned === true && back.replace(/\r\n/g, '\n') === PP_DOC.replace(/\r\n/g, '\n'),
      name + ': 「转普通字幕」逐字节还原（k 行也走通再导入清理）');
    // 重建（编辑后保存）不会把特效块带进 k 行 —— 与颜色形态同构：特效只在导出时注入
    const C = analyzeDoc(PP_DOC);
    const s0 = C.kar.sentences.filter(s => s.karStyle === 'k')[0];
    const rebuilt = buildWordSpecs(s0)[0].text;
    ok(!/\\fade\(|\\blur|\\fscx/.test(rebuilt) && /\\k\d/.test(rebuilt),
      name + ': 编辑后重建的 k 行干净（特效不落进项目文件）');
  }
}

/* ══════════════ 9. P2：形态/颜色自定义 ══════════════ */
console.log('\n── 9. P2：\\kf 形态保留 + 颜色/标签就地改写 ──');
/** 单条 Dialogue 的最小 ASS 文档（AssDoc 要见到 [Events] + Format 才会解析事件行） */
const MINI_HEAD = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 640', 'PlayResY: 360', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,42,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1',
  '', '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
].join('\n');
const miniDoc = (dlg) => new AssDoc(MINI_HEAD + '\n' + dlg);
{
  // \kf 读入后原样保留（重建不再规范化成 \k）—— 形态无损
  const S = analyzeDoc(K_DOC);
  const kf = S.kar.sentences.filter(s => s.karStyle === 'k').find(s => /kay/.test(s.text));
  ok(kf && kf.kTag === '\\kf', '识别: \\kf 行的 kTag 记为 \\kf', kf && kf.kTag);
  const base = S.kar.sentences.filter(s => s.karStyle === 'k').find(s => /hello/.test(s.text));
  ok(base && base.kTag === '\\k', '识别: \\k 行的 kTag 记为 \\k', base && base.kTag);
  ok(buildWordSpecs(kf)[0].text.includes('{\\kf'), '生成: 重建后仍是 \\kf（形态不丢）', buildWordSpecs(kf)[0].text);
  ok(buildWordSpecs(base)[0].text.includes('{\\k40}') && !/\\kf/.test(buildWordSpecs(base)[0].text),
    '生成: \\k 行不受影响', buildWordSpecs(base)[0].text);
  eq(parseKLine('{\\1c&H00FF00&}{\\K70}a{\\K80}b', 1, 3).kTag, '\\kf', '识别: \\K 按 Aegisub 语义等同 \\kf');
  eq(parseKLine('{\\1c&H00FF00&}{\\ko70}a{\\k80}b', 1, 3).kTag, '\\ko', '识别: \\ko 保留（仅描边）');
  eq(parseKLine('{\\1c&H00FF00&}{\\k70}a', 1, 3).kTag, '\\k', '识别: \\k 默认形态');
  eq(parseKLine('没有 k 标签的行', 1, 3).kTag, '', '识别: 非 k 行 kTag 为空');
}
{
  // 段标签切换：\k ↔ \kf（无损：时长原样保留, \kt 绝不能被改）
  const S = analyzeDoc(K_DOC);
  const n1 = replaceKaraokeTag(S.doc, 'Default', '\\kf');
  ok(n1 > 0, '切换: \\k → \\kf 命中英文行', n1);
  const outs = S.doc.serialize();
  ok(!/\\k\d/.test(outs) && /\\kf\d/.test(outs), '切换: 全文段标签都变成 \\kf');
  const S2 = analyzeDoc(S.doc.serialize());
  const w1 = S.kar.sentences.filter(s => s.karStyle === 'k').map(s => csWords(s.words));
  const w2 = S2.kar.sentences.filter(s => s.karStyle === 'k').map(s => csWords(s.words));
  eq(w2, w1, '切换: 词级时间完全不变（无损）');
  const n2 = replaceKaraokeTag(S2.doc, 'Default', '\\k');
  ok(n2 > 0 && !/\\kf/.test(S2.doc.serialize()), '切换: 可以切回 \\k');
  replaceKaraokeTag(S.doc, 'Default', '\\k; evil');            // 白名单外的输入
  ok(!/evil/.test(S.doc.serialize()), '切换: 白名单外的标签一律拒绝（不注入）');
  const kt = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\kt100}{\\k50}hi');
  replaceKaraokeTag(kt, 'Default', '\\kf');
  ok(/\\kt100/.test(kt.events[0].text), '切换: \\kt（设定下一段起点）绝不被改写', kt.events[0].text);
}
{
  // 已唱色就地改写（设置面板拖动取色时的路径, 不重建整行）
  const doc = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\1c&H00FF00&\\2c&H0B0BE5&}{\\k40}hello {\\k40}{\\k120}world');
  const n = replaceWordHighlightColor(doc, 'Default', '#ff00ff');
  ok(n === 1, '已唱色: 命中 1 条 k 行', n);
  ok(/\\1c&HFF00FF&/.test(doc.events[0].text) && /\\2c&H0B0BE5&/.test(doc.events[0].text),
    '已唱色: 只改 \\1c, 未唱位 \\2c 不动', doc.events[0].text);
  const doc2 = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\k40}hello');
  replaceWordHighlightColor(doc2, 'Default', '#123456');
  ok(/^\{\\1c&H563412&\}/.test(doc2.events[0].text), '已唱色: 头部没有颜色位时就地插入（不重建）', doc2.events[0].text);
  const doc3 = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FF00&}{\\k40}hello');
  replaceWordHighlightColor(doc3, 'Default', '#abcdef');
  ok(doc3.events[0].text === '{\\c&HEFCDAB&}{\\k40}hello', '已唱色: 只写 \\c 的旧文件就地改 \\c（不重复加 \\1c）', doc3.events[0].text);
  const doc4 = miniDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\c&H00FF00&}word{\\c} plain');
  replaceWordHighlightColor(doc4, 'Default', '#00ffff');
  ok(doc4.events[0].text === '{\\c&HFFFF00&}word{\\c} plain', '已唱色: 颜色切片形态行为不变（回归）', doc4.events[0].text);
  ok(replaceWordHighlightColor(doc, 'Default', 'not-a-color') === 0, '已唱色: 非法输入不改动');
}
{
  // 未唱默认色
  const doc = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\1c&H00FF00&\\2c&H0B0BE5&}{\\k40}hello');
  ok(replaceKaraokeBaseColor(doc, 'Default', '#ffffff') === 1 && /\\2c&HFFFFFF&/.test(doc.events[0].text),
    '未唱色: 改写 \\2c', doc.events[0].text);
  ok(/\\1c&H00FF00&/.test(doc.events[0].text), '未唱色: 已唱位不动');
  const doc2 = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\1c&H00FF00&}{\\k40}hello');
  replaceKaraokeBaseColor(doc2, 'Default', '#808080');
  ok(doc2.events[0].text.startsWith('{\\1c&H00FF00&\\2c&H808080&}'), '未唱色: 缺失时插入头部块', doc2.events[0].text);
  const doc3 = miniDoc('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FF00&}word{\\c} plain');
  ok(replaceKaraokeBaseColor(doc3, 'Default', '#ffffff') === 0 && doc3.events[0].text.indexOf('2c') === -1,
    '未唱色: 颜色切片行绝不碰（形态隔离）');
  ok(replaceKaraokeBaseColor(doc, 'Default', 'zzz') === 0, '未唱色: 非法输入不改动');
}
{
  // 改写后的行仍然可解析、可往返
  const S = analyzeDoc(K_DOC);
  replaceWordHighlightColor(S.doc, 'Default', '#ff00ff');
  replaceKaraokeBaseColor(S.doc, 'Default', '#00ffff');
  replaceKaraokeTag(S.doc, 'Default', '\\kf');
  const R = analyzeDoc(S.doc.serialize());
  const ks = R.kar.sentences.filter(s => s.karStyle === 'k');
  ok(ks.every(s => s.highlightTag === '{\\c&HFF00FF&}' && s.kBaseHex === '#00ffff' && s.kTag === '\\kf'),
    '改写后: 三个属性都能被重新读出来', JSON.stringify([ks[0].highlightTag, ks[0].kBaseHex, ks[0].kTag]));
  eq(ks.map(s => csWords(s.words)), S.kar.sentences.filter(s => s.karStyle === 'k').map(s => csWords(s.words)),
    '改写后: 词级时间不受影响');
}

{
  // 整轨切换的模型层语义（右键「整轨切换」走的正是这条路）: k → color → k 双向往返
  const S = analyzeDoc(K_DOC);
  const k0 = S.kar.sentences.filter(s => s.karStyle === 'k');
  const w0 = k0.map(s => csWords(s.words));
  for (const s of k0) { s.karStyle = 'color'; s.events = S.doc.replaceEvents(s.events, buildWordSpecs(s)); }
  const mid = S.doc.serialize();
  ok(!/\\[kK]\d/.test(mid), 'k→color: 文件里没有 \\k 残留');
  const M = analyzeDoc(mid);
  ok(M.kar.sentences.filter(s => s.words.length).every(s => s.karStyle !== 'k'), 'k→color: 全部回到颜色形态');
  // 分段差异是预期的: k 行的 "plan.to" 一段, 颜色形态按应用分词口径(标点再切一刀)拆成两词 ——
  // 与编辑颜色行文本时同一套规则; 画面上的**明文**不变(颜色形态是原位包标签)。所以比
  // 「句子明文 + 首末词时间」, 不逐词比。
  const rowSig = (s) => [s.text, Math.round(s.words[0].s * 100), Math.round(s.words[s.words.length - 1].e * 100)];
  eq(M.kar.sentences.filter(s => s.words.length).map(rowSig), k0.map(rowSig),
    'k→color: 明文与首末词时间不变（分段按应用口径归一）');
  for (const s of M.kar.sentences.filter(s => s.words.length)) {
    s.karStyle = 'k'; s.kTag = '\\k'; s.kHead = ''; s.kBaseHex = '#e50b0b';
    s.events = M.doc.replaceEvents(s.events, buildWordSpecs(s));
  }
  const R = analyzeDoc(M.doc.serialize());
  const k1 = R.kar.sentences.filter(s => s.karStyle === 'k');
  ok(k1.length === k0.length, 'color→k: 行数不变', k1.length);
  eq(k1.map(rowSig), k0.map(rowSig), 'color→k: 双向往返后明文与首末词时间仍一致');
  ok(k1.every(s => s.kBaseHex === '#e50b0b' && s.kTag === '\\k'), 'color→k: 未唱色/形态落盘');
}

{
  // 明文保真: 解析保留原文空格, 重建按原文位置交错 → 逐字节往返（含无空格黏连）
  const src = '{\\1c&H00FF00&}{\\k50}SMP, {\\k100}plan.{\\k50}to';
  const r = parseKLine(src, 1.0, 3.0);
  eq(r.words.map(w => w.w), ['SMP,', 'plan.', 'to'], '明文保真: 一段一音节照旧');
  eq(r.text, 'SMP, plan.to', '明文保真: text 保留原文空格（不插空格）', r.text);
  const sent = mkSent({ start: 1.0, end: 3.0, text: r.text, words: r.words, kHead: r.head });
  eq(buildWordSpecs(sent)[0].text, src, '明文保真: 重建逐字节等于原文');
  // 原文里 "plan.to" 黏连 → 应用分词口径是 3 个词, 文件只有 2 段 → 词数对不上,
  // 走"词+空格"回退也不该插空格（回退用的是**文件自己的**分词）
  const r2 = parseKLine('{\\1c&H00FF00&}{\\k50}SMP, {\\k100}plan.to', 1.0, 3.0);
  eq(r2.words.map(w => w.w), ['SMP,', 'plan.to'], '明文保真: 文件侧仍是 2 段');
  const sent2 = mkSent({ start: 1.0, end: 3.0, text: r2.text, words: r2.words, kHead: r2.head });
  eq(buildWordSpecs(sent2)[0].text, '{\\1c&H00FF00&}{\\k50}SMP, {\\k100}plan.to{\\k50}',
    '明文保真: 分段不一致时回退也不改明文（行尾补 filler 保持行时长）', buildWordSpecs(sent2)[0].text);
}

{
  // 无空格分段（外来文件 / CJK 歌词的常态）: 靠解析器记下的原文位置逐字回填, 重建零改动
  const src = '{\\1c&H00FF00&}{\\k50}hello{\\k50}world';
  const r = parseKLine(src, 1.0, 3.0);
  eq(r.words.map(w => w.w), ['hello', 'world'], '无空格: 一段一词');
  eq(r.text, 'helloworld', '无空格: 明文里本来就没有空格', r.text);
  const sent = mkSent({ start: 1.0, end: 3.0, text: r.text, words: r.words, kHead: r.head });
  // 重建 = 原文 + 行尾兜底 filler（文件里 \k 总长 100cs < 行长 200cs → 补 {\k100} 保持行时长;
  // 渲染上无差别 —— 最后一个音节之后本来就没有字）。再解析后词与时间完全一致。
  const back = buildWordSpecs(sent)[0].text;
  eq(back, src + '{\\k100}', '无空格: 明文逐字节还原（行尾补兜底 filler）', back);
  eq(parseKLine(back, 1.0, 3.0).words.map(w => [w.w, Math.round(w.s * 100), Math.round(w.e * 100)]),
    r.words.map(w => [w.w, Math.round(w.s * 100), Math.round(w.e * 100)]), '无空格: 再解析后词与时间一致');
  const cjk = '{\\kf30}こ{\\kf30}ん{\\kf40}に{\\kf50}ちは';
  const r2 = parseKLine(cjk, 0.0, 2.0);
  eq(r2.words.map(w => w.w), ['こ', 'ん', 'に', 'ちは'], 'CJK: 逐音节一段');
  const sent2 = mkSent({ start: 0.0, end: 2.0, text: r2.text, words: r2.words, kHead: r2.head, kTag: '\\kf' });
  // 原文没有颜色头 → 重建按设计补上标准头（{\1c 已唱绿}）; 明文与 \kf 形态逐字节保留
  eq(buildWordSpecs(sent2)[0].text, '{\\1c&H00FF00&}' + cjk + '{\\kf50}', 'CJK + \\kf: 明文逐字节还原（补标准颜色头 + 行尾兜底）');
  // 编辑过后（words 失去原文位置, 文本被改写）→ 退回应用分词口径, 仍然不产生怪空格
  const sent3 = mkSent({ start: 1.0, end: 3.0, text: 'hello world', words: [{ w: 'hello', s: 1.0, e: 1.4 }, { w: 'world', s: 1.4, e: 3.0 }], kHead: '\\1c&H00FF00&' });
  eq(buildWordSpecs(sent3)[0].text, '{\\1c&H00FF00&}{\\k40}hello {\\k160}world', '编辑后: 按应用口径对齐原文');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);