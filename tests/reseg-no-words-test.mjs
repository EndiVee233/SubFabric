/* 无逐词时间戳的字幕也能重分句：ASS 的 \N 行内换行/角色标签不能参与切点比对。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(root, 'editor/js/main.js'), 'utf8');
assert.match(main, /const resegNorm = \(s\) => String\(s \|\| ''\)\.replace\(\/\\\\\[Nn\]\/g, ' '\)/,
  '重分句归一化把 ASS \\N 换行当空格');
assert.match(main, /const resegNorm = [^\n]+replace\(\/\\u00a0\/g, ' '\)/, '继续折叠不换行空格');
assert.match(main, /resegRows = items\.map/, '重分句行快照存在');
assert.match(main, /enRest\.startsWith\(enFirst\)/, '按模型给的英文前缀校验');
assert.match(main, /zhRest\.startsWith\(zhFirst\)/, '按模型给的中文前缀校验');
console.log('reseg-no-words: 无逐词字幕的 \\N/空白归一化与切点校验已接线');
