/**
 * 异常行**类别分类**的单测。
 *
 * 为什么值得单测：`classifyBadReason` 靠正则匹配「原因文案」，而文案是在
 * markBadRows() 里手写的字符串。**改了文案却忘了改分类** → 那一类会静默混进
 * 「其它」，筛选看起来"少了行"却不报错。所以这里把 markBadRows 里真实存在的
 * 11 种文案逐条钉死，另外反向验证"不应该误判"的情况。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

// ── 从 main.js 里抽出三个函数/常量（它依赖大量 DOM，没法整体 import）──
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
function slice(from, to) {
  const i = SRC.indexOf(from);
  if (i < 0) throw new Error('抽不到: ' + from);
  const j = SRC.indexOf(to, i + from.length);
  if (j < 0) throw new Error('抽不到结束标记: ' + to);
  return SRC.slice(i, j);
}
const code = slice('const BAD_CATS = [', 'function markBadRows(')
  + '\nexport { BAD_CATS, classifyBadReason, badCatsOf };\n';
const mod = path.join(HERE, '_badcats.mjs');
fs.writeFileSync(mod, code);
const { BAD_CATS, classifyBadReason, badCatsOf } =
  await import(pathToFileURL(mod).href);
fs.unlinkSync(mod);

// ── 用例：与 markBadRows() 里 push 的文案逐条对应 ──
console.log('== 11 种真实原因 → 类别 ==');
const cases = [
  ['句时长≤0', 'time'],
  ['开始时间 "abc" 无法解析', 'time'],
  ['结束时间 "12:xx" 无法解析', 'time'],
  ['结束早于开始(2)', 'time'],
  ['中英时间不一致(起+0.04s 止-2.56s)', 'time'],
  ['字幕重叠', 'overlap'],
  ['英文行重叠(重复字幕)', 'overlap'],
  ['单中文行(缺英文)', 'lang'],
  ['单英文行(缺中文)', 'lang'],
  ['英文行含方括号', 'role'],
  ['未标注角色', 'role'],
  ['英文行缺词（逐词 8 个 / 文本 9 词）', 'words'],
];
for (const [reason, want] of cases) {
  const got = classifyBadReason(reason);
  ok(got === want, `${reason} → ${want}`, got);
}

console.log('\n== 多条原因合并（badReason 用 "; " 连接）==');
const multi = badCatsOf('结束早于开始(1); 字幕重叠; 英文行缺词（逐词 2 个 / 文本 3 词）');
ok(multi.size === 3, '拆出 3 类', [...multi].join(','));
ok(multi.has('time') && multi.has('overlap') && multi.has('words'), '三类都对', [...multi].join(','));

console.log('\n== 中英两轨各自的原因用 " / " 连接 ==');
const two = badCatsOf('句时长≤0 / 未标注角色');
ok(two.has('time') && two.has('role'), '两条轨的原因都能识别', [...two].join(','));

console.log('\n== 不应误判 ==');
ok(classifyBadReason('') === null, '空串 → null');
ok(classifyBadReason('随便一句正常文本') === null, '正常文本 → null');
ok(badCatsOf('').size === 0, '空串 → 空集合');
// 关键：'字幕重叠' 的 ^...$ 锚定，别把 "英文行重叠" 也算成同一个
ok(classifyBadReason('英文行重叠(重复字幕)') === 'overlap', '英文行重叠 → overlap');
ok(badCatsOf('英文行含方括号; 单英文行(缺中文)').size === 2, '方括号与缺行是两类');

console.log('\n== BAD_CATS 表自洽 ==');
ok(BAD_CATS.length === 5, '5 个类别', BAD_CATS.length);
ok(BAD_CATS.every(c => c.k && c.t && c.hint), '每类都有键/名称/说明');
ok(new Set(BAD_CATS.map(c => c.k)).size === BAD_CATS.length, '键不重复');
// 每个类别的键都必须真的能被识别出来（否则界面上是个永远 0 的死选项）
const usedKeys = new Set(cases.map(([, k]) => k));
for (const c of BAD_CATS) ok(usedKeys.has(c.k), `类别 ${c.k}(${c.t}) 至少有一个真实原因指向它`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
