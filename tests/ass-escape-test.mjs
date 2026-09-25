/* ASS 转义/明文往返测试: node tests/ass-escape-test.mjs */
'use strict';
import { assPlainText } from '../editor/js/ass.js';

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); } };

const escAss = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');

/* 基础: 标签剥离 */
ok(assPlainText('{\\c&H00ff00&}word{\\c}') === 'word', '剥离高亮标签', assPlainText('{\\c&H00ff00&}word{\\c}'));
ok(assPlainText('{\\c&Hf0b000&}[SPK2] 是的') === '[SPK2] 是的', '剥离行首色标保留可见标签', assPlainText('{\\c&Hf0b000&}[SPK2] 是的'));

/* 新增: 被转义的花括号要还原并保留(不能整段被当标签吞掉) */
ok(assPlainText(escAss('{音效}')) === '{音效}', '转义花括号往返还原', assPlainText(escAss('{音效}')));
ok(assPlainText('\\{音效\\}') === '{音效}', '转义文本明文正确');
ok(assPlainText('a\\\\b') === 'a\\b', '转义反斜杠还原', assPlainText('a\\\\b'));

/* 换行 */
ok(assPlainText('第一行\\N第二行') === '第一行 第二行', '\\N → 空格');
ok(!assPlainText(escAss('换\n行')).includes('\n'), '真实换行被转义成 \\N 而非裸换行');

/* 往返: escAss → assPlainText 应等于原文(对含特殊字符的文本) */
const samples = ['{音效}', 'C:\\path\\to', '他说：{笑}', 'a}b', '普通文本', '{\\c&H...&}'];
for (const s of samples) {
  ok(assPlainText(escAss(s)) === s.replace(/\r?\n/g, ' ').trim(), `往返一致: ${JSON.stringify(s)}`, JSON.stringify(assPlainText(escAss(s))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
