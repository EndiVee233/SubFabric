/* 术语表解析测试: 直接抽取 server.js 里的 parseGlossary 真实实现来测(不是副本) */
'use strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require_ = createRequire(import.meta.url);

const src = readFileSync(new URL('../editor/server.js', import.meta.url), 'utf8');
const start = src.indexOf('function parseGlossary');
const end = src.indexOf('\n}', src.indexOf('return nonEmpty.length === 1', start));
const fnSrc = src.slice(start, end + 2);
const parseGlossary = new Function(fnSrc + '\nreturn parseGlossary;')();

let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); } };

/* 旧格式(无分组): 全部生效 */
const legacy = 'Creeper=苦力怕\nEnder Dragon 末影龙\n# 注释\n\nredstone 红石';
ok(eq(parseGlossary(legacy, '简体'), [['Creeper', '苦力怕'], ['Ender Dragon', '末影龙'], ['redstone', '红石']]), '旧格式全部生效', JSON.stringify(parseGlossary(legacy, '简体')));

/* 分组格式: 只取当前目标语言 */
const grouped = [
  '##简体', 'Creeper=苦力怕', 'Spike=斯派克',
  '##繁體', 'Creeper=苦力怕(繁)', 'Spike=斯派克(繁)',
  '##English', 'Creeper=Creeper',
].join('\n');
ok(eq(parseGlossary(grouped, '简体'), [['Creeper', '苦力怕'], ['Spike', '斯派克']]), '简体组', JSON.stringify(parseGlossary(grouped, '简体')));
ok(eq(parseGlossary(grouped, '繁體'), [['Creeper', '苦力怕(繁)'], ['Spike', '斯派克(繁)']]), '繁體组');
ok(eq(parseGlossary(grouped, 'English'), [['Creeper', 'Creeper']]), 'English 组');

/* 目标语言组为空 + 只有一组非空 → 兜底用那一组 */
const onlyFanti = '##繁體\nCreeper=苦力怕(繁)';
ok(eq(parseGlossary(onlyFanti, '简体'), [['Creeper', '苦力怕(繁)']]), '单组非空时兜底');

/* 多组非空但目标语言组为空 → 不注入(避免串语言) */
const twoGroups = '##简体\nA=甲\n##繁體\nB=乙';
ok(eq(parseGlossary(twoGroups, 'English'), []), '目标语言组为空且多组非空 → 空');

/* 空/异常输入 */
ok(eq(parseGlossary('', '简体'), []), '空文本');
ok(eq(parseGlossary(null, '简体'), []), 'null 文本');
ok(eq(parseGlossary('  \n#\n', '简体'), []), '只有注释/空行');

/* 值与键含空格 */
ok(eq(parseGlossary('Ender   Dragon = 末影 龙', '简体'), [['Ender   Dragon', '末影 龙']]), '等号两侧空白容错');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
