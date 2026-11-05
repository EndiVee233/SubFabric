/**
 * 相邻短句的逐词切片不能被上一句的容差抢走。
 * 复现：中文 "哦." 50.07-50.63 / 英文 "Ooh." 同起止；
 * 下一句中文 50.65-52.13 / 英文从 50.65 开始，首片 I 不能被 "哦." 吞掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
fs.mkdirSync(JSMOD, { recursive: true });
for (const f of ['ass.js', 'karaoke.js']) {
  const source = path.join(SRC, f), target = path.join(JSMOD, f);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(fs.readFileSync(source))) fs.copyFileSync(source, target);
}
fs.writeFileSync(path.join(JSMOD, 'package.json'), '{"type":"module"}\n');
const { AssDoc } = await import(pathToFileURL(path.join(JSMOD, 'ass.js')).href);
const { analyzeKaraoke, pairRows } = await import(pathToFileURL(path.join(JSMOD, 'karaoke.js')).href);

const HL = '{\\c&HFFFFFF&}', RESET = '{\\c}';
const longWords = ['I', "don't", 'know', "who'd", 'be', 'roaming', 'around', 'out', 'here.'];
const longText = longWords.join(' ');
const longEvent = (i, start) => {
  const text = longWords.map((w, j) => j === i ? `${HL}${w}${RESET}` : w).join(' ');
  return `Dialogue: 0,0:00:${start.toFixed(2)},0:00:${(start + 0.18).toFixed(2)},Default,Zam,0,0,0,,${text}`;
};
const ass = `[Script Info]
ScriptType: v4.00+
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 中文字幕,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:50.07,0:00:50.63,中文字幕,Spoke,0,0,0,,{\\c&H0C0CF3&}[Spoke] 哦.
Dialogue: 0,0:00:50.07,0:00:50.63,Default,Spoke,0,0,0,,${HL}Ooh.${RESET}
Dialogue: 0,0:00:50.65,0:00:52.13,中文字幕,Zam,0,0,0,,{\\c&H17BFFF&}[PrinceZam] 我不知道谁会在这外面闲逛.
${longWords.map((_, i) => longEvent(i, 50.65 + i * 0.16)).join('\n')}
Dialogue: 0,0:00:52.23,0:00:53.27,中文字幕,Spoke,0,0,0,,{\\c&H0C0CF3&}[Spoke] 哦 你看到了吗 兄弟?
Dialogue: 0,0:00:52.23,0:00:52.47,Default,Spoke,0,0,0,,${HL}Ooh,${RESET} you see that, dude?
`;

const doc = new AssDoc(ass);
const kar = analyzeKaraoke(doc);
const rows = pairRows(kar.sentences, kar.wordStyle);
const short = rows.find(r => r.zh && r.zh.text.includes('哦.'));
const long = rows.find(r => r.zh && r.zh.text.includes('我不知道'));
assert.ok(short && long, 'both Chinese anchors pair');
assert.equal(short.en.text, 'Ooh.', 'short anchor keeps only its own Ooh.');
assert.match(long.en.text, /^I don't know/, 'next sentence keeps its own first word');
assert.equal(short.en.words.length, 1, 'short sentence has one word slice');
assert.equal(long.en.words.length, longWords.length, 'long sentence keeps all word slices');

/* 00:03:05 案例：上一句英文的**尾部空档行**（0.02s，文本还是上一句）起点更贴近
 * 下一句中文行首，旧实现把它判给下一句，pairRows 又拿它配下一句中文 →
 * 「中文行 + 20ms 英文」与「整句英文」各一条。现在应并回上一句，只剩两行且都对齐。 */
const ts = (s) => '0:00:' + s.toFixed(2).padStart(5, '0');
const wordRow = (style, name, t0, t1, text) =>
  `Dialogue: 0,${ts(t0)},${ts(t1)},${style},${name},0,0,0,,${text}`;
const A = 'I headed off to spawn';
const B = 'to prepare for the biggest war';
const wA = ['I', 'headed', 'off', 'to', 'spawn'];
const wB = ['to', 'prepare', 'for', 'the', 'biggest', 'war'];
const kara = (words) => (i) => words.map((w, j) => j === i ? `${HL}${w}${RESET}` : w).join(' ');
const gapAss = `[Script Info]
ScriptType: v4.00+
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 中文字幕,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${wordRow('中文字幕', 'Parrot', 0, 2.1, '我出发前往出生点')}
${wA.map((_, i) => wordRow('Default', 'Parrot', [0, 0.4, 0.8, 1.2, 1.6][i], [0.4, 0.8, 1.2, 1.6, 2.08][i], kara(wA)(i))).join('\n')}
${wordRow('Default', 'Parrot', 2.08, 2.1, A)}
${wordRow('中文字幕', 'Parrot', 2.1, 5, '为服务器历史上最大的战争做准备')}
${wordRow('Default', 'Parrot', 2.1, 2.14, B)}
${wB.map((_, i) => wordRow('Default', 'Parrot', 2.14 + i * 0.4, 2.14 + (i + 1) * 0.4, kara(wB)(i))).join('\n')}
`;
const gapRows = pairRows(analyzeKaraoke(new AssDoc(gapAss)).sentences, 'Default');
assert.equal(gapRows.length, 2, '尾空档行不会另起一句（旧实现是 3 行）');
const rowA = gapRows.find(r => r.zh && r.zh.text.includes('我出发'));
const rowB = gapRows.find(r => r.zh && r.zh.text.includes('为服务器'));
assert.ok(rowA && rowB, '两行都配上了中文');
assert.equal(rowA.en.words.length, 5, '上一句保留自己的 5 个词');
assert.equal(rowB.en.words.length, wB.length, '下一句保留自己的全部词');
assert.equal(rowA.en.text, A, '上一句英文没有被下一句的空档行污染');
assert.equal(rowB.en.text, B, '下一句英文完整');
assert.equal(rowB.start, 2.1, '下一句从自己的中文行首开始（不再被 20ms 空档行拉早）');
console.log('pair-anchor: adjacent short sentence does not steal the next word slice');
