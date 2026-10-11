/* 中文译文标点归一化单测: node tests/zh-punct-test.mjs
 *
 * 回归的 bug: 右键「重新翻译」的中文译文里还留着 ，、。(用户报的「重新识别/重新翻译的中文部分
 * 并没有去掉标点」)。根因是这条规则散在两处(server.js 写初稿 / main.js 选区重新识别),
 * 「重新翻译」那条路径漏了。现在统一成 normalizeZhPunctuation, 浏览器侧(karaoke.js)与服务端
 * (llm-text.js)各一份 —— 本测试断言两份对同一语料输出完全一致, 防止再次分叉。
 *
 * 另覆盖载入自愈: 存量稿件(外部工具导入)的中文整句行在打开时被清一遍, 且不碰逐词样式行。 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  /* 镜像同步: 只补齐/更新本族自己的文件, **绝不清空目录** —— jsmod 是两族共用镜像
   * (上游族源 editor/js, fork 族源 editor/), 旧实现 rmSync 清空会顺手删掉另一族的文件,
   * 于是"哪个测试先跑"决定别的测试能不能过(2026-10-10 修复)。内容比对保证镜像恒等于源。 */
  fs.mkdirSync(JSMOD, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
  }
  fs.writeFileSync(marker, '{"type":"module"}\n');
}
ensureJsmod();

const K = await import('./jsmod/karaoke.js');
const { AssDoc } = await import('./jsmod/ass.js');
const require_ = createRequire(import.meta.url);
const LT = require_(path.resolve(HERE, '..', 'editor', 'llm-text.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + extra : '')); }
};

const N_JS = K.normalizeZhPunctuation;         // 浏览器侧
const N_PY = LT.normalizeZhPunctuation;        // 服务端侧

console.log('== 基本行为(两侧各自) ==');
for (const [label, fn] of [['浏览器', N_JS], ['服务端', N_PY]]) {
  ok(fn('我来挡。') === '我来挡', label + ': 句号 → 去掉', JSON.stringify(fn('我来挡。')));
  ok(fn('好 好。') === '好 好', label + ': 句尾句号去掉、词间空格保留', JSON.stringify(fn('好 好。')));
  ok(fn('太危险了，太危险了') === '太危险了 太危险了', label + ': 逗号 → 一个空格', JSON.stringify(fn('太危险了，太危险了')));
  ok(fn('甲、乙、丙。') === '甲 乙 丙', label + ': 顿号/句号 → 空格', JSON.stringify(fn('甲、乙、丙。')));
  ok(fn('好，。 好') === '好 好', label + ': 连续标点 + 多余空格 → 收成一个', JSON.stringify(fn('好，。 好')));
  ok(fn('什么？真的！') === '什么？真的！', label + ': ! ? 保留不动', JSON.stringify(fn('什么？真的！')));
  ok(fn('Wait, what?') === 'Wait, what?', label + ': 英文半角标点不动', JSON.stringify(fn('Wait, what?')));
  ok(fn('  前导与尾随  ') === '前导与尾随', label + ': 去首尾空白', JSON.stringify(fn('  前导与尾随  ')));
  ok(fn('换行\n接回') === '换行 接回', label + ': 真换行 → 空格', JSON.stringify(fn('换行\n接回')));
  ok(fn('A。\\NB') === 'A\\NB', label + ': \\N 旁不留空格', JSON.stringify(fn('A。\\NB')));
  ok(fn('') === '' && fn(null) === '' && fn(undefined) === '', label + ': 空值安全');
}

console.log('\n== 两侧对同一语料输出一致(防分叉) ==');
{
  const corpus = [
    '我来挡。', '好 好。', '太危险了，太危险了', '甲、乙、丙。', '好，。 好',
    '什么？真的！', 'Wait, what?', '  前后  ', '换行\n接回', 'A。\\NB',
    '。', '，，，', '。。。', '', '   ', null, undefined,
    '这，是。一，个。混合，测试。', '哦..... 这', '做点什么。',
  ];
  let diff = 0;
  for (const c of corpus) {
    if (N_JS(c) !== N_PY(c)) { diff++; console.log(`    ✗ ${JSON.stringify(c)} js=${JSON.stringify(N_JS(c))} py=${JSON.stringify(N_PY(c))}`); }
  }
  ok(diff === 0, `${corpus.length} 条语料两侧输出完全一致`, 'diff=' + diff);
}

console.log('\n== 载入自愈: 只清中文整句行, 不碰逐词样式行 ==');
{
  const mkDoc = () => new AssDoc([
    '[Script Info]', 'ScriptType: v4.00+', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1',
    'Style: 中文字幕,Arial,50,&H0000FFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,125,1', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    // 中文整句行: 带行首色标 + [角色] 标签 + 中文标点
    'Dialogue: 0,0:00:00.00,0:00:02.00,中文字幕,Minute,0,0,0,,{\\c&HFFFFFF&}[Minute] 我来挡。',
    // 英文逐词行: 行首 {\c..&}..{\c} 高亮 span 里**有**句号, 绝不能被当标点清掉
    "Dialogue: 0,0:00:00.00,0:00:00.70,Default,Minute,0,0,0,,{\\c&HFFFFFF&}Ill{\\c} block.",
    "Dialogue: 0,0:00:00.70,0:00:01.40,Default,Minute,0,0,0,,Ill {\\c&HFFFFFF&}block.{\\c}",
    "Dialogue: 0,0:00:01.40,0:00:02.00,Default,Minute,0,0,0,,Ill block{\\c&HFFFFFF&}.{\\c}",
  ].join('\n'));

  const doc = mkDoc();
  const kar = K.analyzeKaraoke(doc);
  const zhEv = doc.sorted.find(e => e.style === '中文字幕');
  const enBefore = doc.sorted.filter(e => e.style === 'Default').map(e => e.text);
  const n = K.normalizeZhPunctuationInSentences(doc, kar.sentences, kar.wordStyle);

  ok(kar.wordStyle === 'Default', '逐词样式识别为 Default', kar.wordStyle);
  ok(n === 1, '只改了 1 行(中文整句行)', 'n=' + n);
  ok(zhEv.text === '{\\c&HFFFFFF&}[Minute] 我来挡', '中文行: 色标与 [角色] 保留、句号去掉', zhEv.text);
  const enAfter = doc.sorted.filter(e => e.style === 'Default').map(e => e.text);
  ok(JSON.stringify(enAfter) === JSON.stringify(enBefore), '英文逐词行的 span 与句号原样不动');
  const zhSent = kar.sentences.find(s => s.style === '中文字幕');
  ok(zhSent.text === '[Minute] 我来挡', 'sent.text(纯文本)同步刷新', zhSent.text);
}

console.log('\n== 真实稿件: 载入自愈后中文行不再有 ，、。 ==');
{
  const ASS = path.resolve(HERE, '..', '实例.ass');
  if (!fs.existsSync(ASS)) {
    console.log('  (跳过: 找不到 ' + ASS + ')');
  } else {
    const doc = new AssDoc(fs.readFileSync(ASS, 'utf8'));
    const kar = K.analyzeKaraoke(doc);
    const bad = (re) => doc.sorted.filter(e => e.style !== kar.wordStyle && re.test(e.text)).length;
    const before = bad(/[，、。]/);
    const n = K.normalizeZhPunctuationInSentences(doc, kar.sentences, kar.wordStyle);
    const after = bad(/[，、。]/);
    console.log(`  中文整句行含 ，、。 : ${before} → ${after} (改动 ${n} 行)`);
    ok(before > 0, '这份存量稿件确实带着中文标点(复现用户看到的现象)', 'before=' + before);
    ok(after === 0, '归一后中文整句行不再有 ，、。', 'after=' + after);
    ok(n === before, '改动行数 == 原本带标点的行数', `n=${n} before=${before}`);
    // 英文逐词 span 的句号必须完好(英文行的 '.' 是词的一部分)
    const enDots = doc.sorted.filter(e => e.style === kar.wordStyle && e.text.includes('.'))
      .length;
    ok(enDots > 0, '英文逐词行的半角句号仍在(没被误清)', 'enDots=' + enDots);
  }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
