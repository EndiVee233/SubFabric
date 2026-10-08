/**
 * 「带特效字幕再导入会破碎」回归测试: node tests/effect-reimport-test.mjs
 *
 * 用户报的 bug：带特效（微光/生长/淡入）导出的 ASS 重新导入后，时间轴"字幕块破碎" ——
 * 特效命令混进逐词高亮 span 后, karaoke.js 的切片识别（HL_RE 要求 span 恰好是
 * `{\c&H......&}词{\c}` 的形状）失败, 一句话的每个词切片都被当成独立句子。
 *
 * 本套件:
 *   ① 复现旧行为（记录块数暴涨, 诊断输出；不设硬断言, 将来分析器变宽容也不该判失败）
 *   ② stripEffectTags(applyPostProcess(x)) == x —— 导出→再导入 逐字节回到原样(换行归一)
 *      覆盖 全特效 / 微光 / 生长 / 淡入 四种配置
 *   ③ 清理后的分析结果(行数/词映射)与干净文件完全一致
 *   ④ stripEffectTagsSafe 的"硬塞"兜底（异常输入 → 原样返回）
 *   ⑤ 零改动直通：普通文本、字面大括号、无特效 ASS 一律逐字节不变
 */
import { AssDoc } from '../editor/js/ass.js';
import { analyzeKaraoke, pairRows } from '../editor/js/karaoke.js';
import {
  DEFAULT_POSTPROCESS_CONFIG, cloneConfig, applyPostProcess,
  stripEffectTags, stripEffectTagsSafe
} from '../editor/js/postprocess.js';

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};
const norm = (s) => String(s).replace(/\r\n/g, '\n');

/* ── 干净的双语逐词 ASS（结构同真实产物: 中文整句 + 英文逐词切片 + 行首角色色）── */
const CLEAN = [
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
  'Dialogue: 0,0:00:01.00,0:00:02.25,Default,,0,0,0,,{\\c&H00FF00&}hello{\\c} world foo',
  'Dialogue: 0,0:00:02.25,0:00:03.50,Default,,0,0,0,,hello {\\c&H00FF00&}world{\\c} foo',
  'Dialogue: 0,0:00:03.50,0:00:04.75,Default,,0,0,0,,hello world {\\c&H00FF00&}foo{\\c}',
  'Dialogue: 0,0:00:01.00,0:00:04.75,中文字幕,,0,0,0,,{\\c&H0000FFFF&}你好 世界',
  'Dialogue: 0,0:00:06.00,0:00:07.25,Default,,0,0,0,,{\\c&H00FF00&}second{\\c} row here',
  'Dialogue: 0,0:00:07.25,0:00:08.50,Default,,0,0,0,,second {\\c&H00FF00&}row{\\c} here',
  'Dialogue: 0,0:00:08.50,0:00:09.75,Default,,0,0,0,,second row {\\c&H00FF00&}here{\\c}',
  'Dialogue: 0,0:00:06.00,0:00:09.75,中文字幕,,0,0,0,,第二句',
].join('\n');

function analyze(text) {
  const doc = new AssDoc(text);
  const kar = analyzeKaraoke(doc);
  const rows = pairRows(kar.sentences, kar.wordStyle);
  return {
    sentences: kar.sentences.length,
    rows: rows.length,
    words: kar.sentences.reduce((n, s) => n + ((s.words && s.words.length) || 0), 0),
  };
}

console.log('========================================');
console.log('特效字幕再导入：去特效回归');
console.log('========================================\n');

const base = analyze(CLEAN);
ok(base.rows === 2 && base.words === 6, '干净文件基线: 2 个双语块 / 6 个词', base);

/* ── ②③ 四种特效配置: 导出 → 再导入(清理) → 与原样完全一致 ── */
const mk = (mut) => {
  const c = cloneConfig(DEFAULT_POSTPROCESS_CONFIG);
  c.enabled = true; c.glow.enabled = false; c.grow.enabled = false; c.fadein.enabled = false;
  mut(c);
  return c;
};
const CASES = [
  ['全特效', mk(c => { c.glow.enabled = true; c.glow.target = 'active_word'; c.grow.enabled = true; c.grow.scale = 130; c.fadein.enabled = true; c.fadein.target = 'all'; })],
  ['仅微光(活动词)', mk(c => { c.glow.enabled = true; c.glow.target = 'active_word'; })],
  ['仅词生长', mk(c => { c.grow.enabled = true; c.grow.scale = 130; })],
  ['仅柔和淡入', mk(c => { c.fadein.enabled = true; c.fadein.target = 'all'; })],
];

let brokenSeen = false;
for (const [name, cfg] of CASES) {
  const processed = applyPostProcess(CLEAN, cfg);
  ok(processed !== CLEAN, name + ': 特效确实注入（与原文不同）');
  const broken = analyze(processed);
  if (broken.rows > base.rows) brokenSeen = true;
  const { text: back, cleaned } = stripEffectTagsSafe(processed);
  ok(cleaned === true, name + ': 被识别为"清理过"');
  ok(norm(back) === norm(CLEAN), name + ': 清理后逐字节回到原文件（换行归一）');
  const fixed = analyze(back);
  ok(fixed.rows === base.rows && fixed.words === base.words && fixed.sentences === base.sentences,
    name + ': 清理后分析结果与干净文件一致', { fixed, base });
  console.log(`     [诊断] 直接导入(旧行为) ${broken.rows} 块 / 清理后 ${fixed.rows} 块 / 干净 ${base.rows} 块`);
}
ok(brokenSeen, '复现确认: 带特效文件直接分析会破碎（块数 > 干净基线）');

/* ── ⑤ 微观用例 ── */
ok(stripEffectTags('{\\c&H00FF00&\\4c&H88FF00&\\4a&H00&\\blur4.0}word{\\c\\4c\\4a\\blur}') === '{\\c&H00FF00&}word{\\c}',
  'span 开/闭标签恢复标准形状 {\c&H..&}词{\c}');
ok(stripEffectTags('{\\fscx130\\fscy130}word{\\fscx\\fscy}') === 'word', '生长标签（带参 + 复位）全部剥除');
ok(stripEffectTags('前{\\3c&H112233&\\3a&HFF&\\blur4.0}后') === '前后', '整行特效块剥空后删除');
ok(stripEffectTags('{\\fade(115,0,0,0,300,300,300)}文字') === '文字', '淡入标签剥除');
ok(stripEffectTags('字面大括号 {hello} 与 {\\c&HFF0000&}标签混合') === '字面大括号 {hello} 与 {\\c&HFF0000&}标签混合',
  '字面大括号 / 无关标签一律不动');
ok(stripEffectTags(CLEAN) === CLEAN, '无特效文本零改动直通（逐字节）');
const once = stripEffectTags('{\\blur4.0\\fscx130}x{\\blur\\fscx}');
ok(stripEffectTags(once) === once, '幂等: 再剥一次结果不变');

/* ── ④ 硬塞兜底 ── */
ok(stripEffectTagsSafe(null).text === '' && stripEffectTagsSafe(null).cleaned === false, 'null 输入 → 空串且未清理');
ok(stripEffectTagsSafe('没有 Dialogue 的胡乱文本').cleaned === false, '非 ASS 文本 → 未清理（硬塞语义）');
ok(stripEffectTagsSafe(CLEAN).text === CLEAN && stripEffectTagsSafe(CLEAN).cleaned === false, '干净 ASS → 原样返回且 cleaned=false');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
