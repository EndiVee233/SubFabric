/* 视频区"点什么改什么"分段工具单测: node tests/cue-segment-test.mjs
 * 规则（用户要求）: 双击字幕 → 只改**点中的那一段**（空格分隔），其余原文一字不动。
 * 所以这里重点验证两件事 —— ① 分段口径正确 ② 最小替换不碰行内其它标签。 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const S = require_('../editor/js/segment.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
};

const segTexts = (plain) => S.splitSegments(plain).segs.map(s => s.text);

/* ── ① 分段：按空白切，行首 [角色] 不当片段 ── */
ok(JSON.stringify(segTexts('[Wemmbu] 一路打到决赛 才有机会击败Flame'))
  === JSON.stringify(['一路打到决赛', '才有机会击败Flame']), '行首角色标签不进片段', segTexts('[Wemmbu] 一路打到决赛 才有机会击败Flame'));
ok(JSON.stringify(segTexts('battling my way to the finale'))
  === JSON.stringify(['battling', 'my', 'way', 'to', 'the', 'finale']), '英文按词切', segTexts('battling my way to the finale'));
ok(JSON.stringify(segTexts('没有空格的整行中文')) === JSON.stringify(['没有空格的整行中文']), '整行无限空格 → 单片段');
ok(JSON.stringify(segTexts('[a]  多余   空格')) === JSON.stringify(['多余', '空格']), '连续空白不产生空片段');
ok(S.splitSegments('[Wemmbu] 一路打到决赛 才有机会击败Flame').prefix === '[Wemmbu] ', '只读前缀含尾随空格');

/* ── ② ASS 纯文本与下标映射（含 \N 折行、\{ 转义、覆盖标签） ── */
{
  const raw = '{\\c&H00FFFF&}[Wemmbu] 一路打到决赛 {\\c&HFF00FF&}才有机会击败Flame';
  const { plain } = S.assPlainAndMap(raw);
  ok(plain === '[Wemmbu] 一路打到决赛 才有机会击败Flame', '纯文本剥掉覆盖标签', JSON.stringify(plain));
  const { segs } = S.splitSegments(plain);
  ok(segs.length === 2 && segs[1].text === '才有机会击败Flame', '带色标的行正文仍可分段', JSON.stringify(segs.map(s => s.text)));
}
{
  const { plain } = S.assPlainAndMap('上句\\N下句');
  ok(plain === '上句 下句', '\\N 折行 → 空格', JSON.stringify(plain));
}
{
  const { plain } = S.assPlainAndMap('文本里的 \\{花括号\\} 要还原');
  ok(plain === '文本里的 {花括号} 要还原', '转义花括号还原成字面字符', JSON.stringify(plain));
}

/* ── ③ 最小替换：只动被点中的片段 ── */
{
  const raw = '{\\c&H00FFFF&}[Wemmbu] 一路打到决赛 {\\c&HFF00FF&}才有机会击败Flame';
  const { plain } = S.assPlainAndMap(raw);
  const seg = S.splitSegments(plain).segs[0];
  const out = S.replaceSegmentInRaw(raw, 'ass', seg, '一路打进决赛');
  ok(out === '{\\c&H00FFFF&}[Wemmbu] 一路打进决赛 {\\c&HFF00FF&}才有机会击败Flame',
    '替换首段：行首色标、角色标签、行内第二个色标全部原样保留', out);
}
{
  const raw = '[Wemmbu] 甲 乙 丙';
  const { plain } = S.assPlainAndMap(raw);
  const seg = S.splitSegments(plain).segs[1];
  const out = S.replaceSegmentInRaw(raw, 'ass', seg, '乙乙');
  ok(out === '[Wemmbu] 甲 乙乙 丙', '替换中段', out);
}
{
  const raw = 'a\\Nb c';
  const { plain } = S.assPlainAndMap(raw);
  const seg = S.splitSegments(plain).segs[0];       // 'a'
  const out = S.replaceSegmentInRaw(raw, 'ass', seg, 'A');
  ok(out === 'A\\Nb c', '替换跨 \\N 的行首片段不吞掉 \\N', JSON.stringify(out));
}
{
  const raw = '[Wemmbu] 原句';
  const { plain } = S.assPlainAndMap(raw);
  const seg = S.splitSegments(plain).segs[0];
  const out = S.replaceSegmentInRaw(raw, 'ass', seg, '含{花括号}\\和换行\n第二行');
  ok(out === '[Wemmbu] 含\\{花括号\\}\\\\和换行\\N第二行', '用户输入的花括号/反斜杠转义、换行转 \\N', JSON.stringify(out));
}
{
  const out = S.replaceSegmentInRaw('[Wemmbu] 原句', 'ass', { text: '对不上的旧片段', start: 8, end: 13 }, 'x');
  ok(out === null, '文档已变（区间对不上）→ 返回 null 而不是乱改', out);
}

/* ── ④ SRT：跳过行内 HTML 标签，替换不破坏标签 ── */
{
  const raw = '<i>Hello</i> brave world';
  const { plain } = S.htmlPlainAndMap(raw);
  ok(plain === 'Hello brave world', 'SRT 纯文本剥掉行内标签', JSON.stringify(plain));
  const seg = S.splitSegments(plain).segs[1];       // 'brave'
  const out = S.replaceSegmentInRaw(raw, 'srt', seg, 'BRAVE');
  ok(out === '<i>Hello</i> BRAVE world', 'SRT 替换中段保留 <i> 标签', out);
}
{
  const raw = '一路打到决赛 才有机会';
  const seg = S.splitSegments(S.htmlPlainAndMap(raw).plain).segs[1];
  const out = S.replaceSegmentInRaw(raw, 'srt', seg, '才有机会赢');
  ok(out === '一路打到决赛 才有机会赢', 'SRT 纯文本替换（区间由 splitSegments 给出）', out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
