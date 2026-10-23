/* 中文分句切点：按英文词数比例就近吸附到标点 / 英文词边界。
 * node tests/zh-split-point-test.mjs
 *
 * 用户实测：手动 Ctrl+Enter 分句时 "ABCDE FGHIJ" 被切成 "ABCD" / "E FGHIJ" ——
 * 旧实现直接按字数比例切中文，切点落在英文词/名字中间。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const context = vm.createContext({ stripLeadSpeakerTag: (s) => String(s == null ? '' : s).trim() });
vm.runInContext(fn('splitZhText'), context);
const split = (text, k, n) => vm.runInContext(`splitZhText(${JSON.stringify(text)}, ${k}, ${n})`, context);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};

/* ① 切点落在英文词中间 → 吸附到词边界（用户的例子：2/5 比例落在 ABCDE 中间） */
{
  const [a, b] = split('ABCDE FGHIJ', 2, 5);
  ok(a === 'ABCDE' && b === 'FGHIJ', '英文词中间的比例切点吸附到词边界', JSON.stringify([a, b]));
}
{
  const [a, b] = split('ABCDE FGHIJ', 1, 2);
  ok(a === 'ABCDE' && b === 'FGHIJ', '正好在空格处时不改刀', JSON.stringify([a, b]));
}
{
  const [a, b] = split('Wemmbu and Spoke', 1, 3);
  ok(a === 'Wemmbu' && b === 'and Spoke', '名字按空格断开', JSON.stringify([a, b]));
}

/* ② 有标点时优先切在标点后（标点留在前半句） */
{
  const [a, b] = split('甲乙，丙丁戊己', 1, 2);
  ok(a === '甲乙，' && b === '丙丁戊己', '优先切在逗号后', JSON.stringify([a, b]));
}
{
  const [a, b] = split('他说完了。下一句在这儿', 1, 2);
  ok(a === '他说完了。' && b === '下一句在这儿', '优先切在句号后', JSON.stringify([a, b]));
}

/* ③ 纯中文无标点 → 仍按比例切，不丢字 */
{
  const [a, b] = split('甲乙丙丁戊己', 1, 2);
  ok(a === '甲乙丙' && b === '丁戊己', '无标点时按比例切', JSON.stringify([a, b]));
  ok(split('甲乙丙丁戊己', 3, 6).join('') === '甲乙丙丁戊己', '两半拼回原文');
}

/* ④ 不拆代理对（emoji），且边界输入安全 */
{
  const [a, b] = split('甲😀乙丙', 2, 5);
  ok(a + b === '甲😀乙丙', '不拆 emoji 代理对', JSON.stringify([a, b]));
}
{
  ok(split('甲乙', 0, 3)[1] === '', 'k=0 → 整句留在前半');
  ok(split('甲乙', 3, 3)[1] === '', 'k>=nEn → 整句留在前半');
  ok(split('', 1, 2)[0] === '', '空文本 → 空');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
