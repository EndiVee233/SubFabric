/* 无逐词时间戳的字幕也能重分句：ASS 的 \N 行内换行/角色标签不能参与切点比对。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(root, 'editor/js/main.js'), 'utf8');
assert.match(main, /const resegNorm = \(s\) => String\(s \|\| ''\)\.replace\(\/\\\\\[Nn\]\/g, ' '\)/,
  '重分句归一化把 ASS \\N 换行当空格');
assert.match(main, /const resegNorm = [^\n]+replace\(\/\\u00a0\/g, ' '\)/, '继续折叠不换行空格');
assert.match(main, /resegRows = items\.map/, '重分句行快照存在');
assert.match(main, /enRest\.startsWith\(enFirst\)/, '按模型给的英文前缀校验');
assert.match(main, /zhRest\.startsWith\(zhFirst\)/, '按模型给的中文前缀校验');
const require = createRequire(import.meta.url);
const { resegTextOnly } = require('../editor/reseg.js');
const english = "The price is 1,234.50 dollars. Don't change that number! "
  + 'The spoken text can still be split into useful subtitles without a word timing model. '.repeat(4).trim();
const chinese = '这个句子包括英文和专有词 OpenAI。没有空格的中文也需要正常切分！';
const unpunctuated = 'timing must be estimated within the original chunk without fabricating word timestamps '.repeat(8).trim();
const blocks = [
  { start: 0, end: 36, text: english, words: [] },
  { start: 42, end: 52, text: chinese, words: [] },
  { start: 52, end: 92, text: unpunctuated, words: [] },
];
const cues = resegTextOnly(blocks);
const stripSpace = text => text.replace(/\s+/g, '');
assert.equal(cues[0].start, 0);
assert.equal(cues.at(-1).end, 92);
assert.ok(cues.every(({ start, end, words }, i) => end > start && end - start <= 10 + 1e-8
  && (i === 0 || start >= cues[i - 1].end) && words.length === 0));
for (const block of blocks) {
  const own = cues.filter(cue => cue.start >= block.start && cue.end <= block.end);
  assert.ok(own.length > 1);
  assert.equal(stripSpace(own.map(cue => cue.text).join('')), stripSpace(block.text));
}
assert.ok(cues.some(cue => cue.end === 36));
assert.ok(cues.some(cue => cue.start === 42));
assert.equal(resegTextOnly([{ start: 1, end: 4, text: '先说这一句，接着说下一句。' }], { splitOnComma: true }).length, 2);
console.log('reseg-no-words: 无逐词字幕的 \\N/空白归一化与切点校验已接线');
