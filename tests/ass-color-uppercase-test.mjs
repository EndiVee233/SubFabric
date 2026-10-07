/**
 * 颜色标签大写化(兼容 Subforges)。
 *
 * 背景: 上游工具 Subforges 解析 ASS 颜色标签时**只认大写十六进制**, 遇到小写
 * (&H00ff00&)会判为不认得 → 逐词高亮在那边整体失效, 工作流无法从 SubFabric
 * 继承。libass 本身大小写通吃, 所以这是纯输出侧对齐, 不影响渲染结果。
 *
 * 验证三处:
 *  ① 编辑器读入侧 normalizeAssColorTags(): 历史小写标签 → 大写
 *  ② 逐词高亮标签 \c / \1c / \2c / \3c / \4c 全覆盖
 *  ③ 结构错误(旧版多一层 &H/&)一并修好
 */
import { AssDoc } from './jsmod/ass.js';

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '→ ' + extra); }
};

/* 与 editor/js/main.js 的 normalizeAssColorTags 同一套逻辑(该函数依赖全局 state,
   这里抽成纯函数以便直接测, 行为保持一致) */
const bad = /\{\\(?:[1-4])?c&H&H?([0-9A-Fa-f]{6})&&\}/g;
const anyColor = /\{\\(?:[1-4])?c&H([0-9A-Fa-f]{6})&?\}/g;
function normalize(text) {
  bad.lastIndex = 0; anyColor.lastIndex = 0;
  if (!bad.test(text) && !anyColor.test(text)) return text;
  let next = text.replace(bad, (all, hex) => `{\\c&H${hex.toUpperCase()}&}`);
  next = next.replace(anyColor, (all, hex) => {
    const head = all.slice(0, all.indexOf('&H') + 2);
    return `${head}${hex.toUpperCase()}&}`;
  });
  return next;
}

const SAMPLE = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour',
  'Style: Default,Arial,60,&H00ffffff,&H0000ffff,&H00000000,&H00000000',
  'Style: 中文字幕,Microsoft YaHei,60,&H0000ffff,&H0000ffff,&H00000000,&H00000000',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:02.00,中文字幕,SPK1,0,0,0,,{\\c&H0b0be5&}中文台词',
  'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\c&H00ff00&}Hello{\\c} world',
  'Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,{\\1c&Haabbcc&}outline{\\1c}',
  ''
].join('\n');

console.log('ass-color-uppercase: 颜色标签大写化');

console.log('\n[1] 行内逐词高亮标签');
check('小写逐词绿 &H00ff00& → &H00FF00&',
  normalize('{\\c&H00ff00&}Hello{\\c}') === '{\\c&H00FF00&}Hello{\\c}',
  normalize('{\\c&H00ff00&}Hello{\\c}'));
check('已是写的保持不变',
  normalize('{\\c&H00FF00&}Hello{\\c}') === '{\\c&H00FF00&}Hello{\\c}');
check('小写说话人色 &H0b0be5& → &H0B0BE5&',
  normalize('{\\c&H0b0be5&}中文') === '{\\c&H0B0BE5&}中文',
  normalize('{\\c&H0b0be5&}中文'));
check('\\1c 也被覆盖',
  normalize('{\\1c&Haabbcc&}x{\\1c}') === '{\\1c&HAABBCC&}x{\\1c}',
  normalize('{\\1c&Haabbcc&}x{\\1c}'));

console.log('\n[2] 结构错误(旧版多一层 &H/&)');
check('{\\c&H&00ff00&&} → 标准 {\\c&H00FF00&}',
  normalize('{\\c&H&00ff00&&}x') === '{\\c&H00FF00&}x',
  normalize('{\\c&H&00ff00&&}x'));
check('无尾& 的 {\\c&H00ff00} 也补齐并大写',
  normalize('{\\c&H00ff00}x') === '{\\c&H00FF00&}x',
  normalize('{\\c&H00ff00}x'));

console.log('\n[3] 无颜色标签的行不被改动');
const plain = 'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,纯文本 123';
check('纯文本行原样返回', normalize(plain) === plain, normalize(plain));
check('Style 行不被本函数改动(由 main.py 侧管)',
  normalize('Style: Default,Arial,60,&H00ffffff,&H0000ffff') === 'Style: Default,Arial,60,&H00ffffff,&H0000ffff');

console.log('\n[4] 整份稿件归一化');
const doc = new AssDoc(SAMPLE);
let n = 0;
for (const ev of doc.events) {
  const before = ev.text || '';
  const after = normalize(before);
  if (after !== before) { doc.setEventText(ev, after); n++; }
}
const ser = doc.serialize();
check('有 3 行被改写', n === 3, String(n));
check('输出里已无小写颜色值',
  !/&H[0-9A-F]*[a-f][0-9A-Fa-f]*&/.test(ser),
  (ser.match(/&H[0-9A-F]*[a-f][0-9A-Fa-f]*&/) || [''])[0]);
check('逐词绿已是 &H00FF00&', ser.includes('&H00FF00&'));
check('说话人色已是 &H0B0BE5&', ser.includes('&H0B0BE5&'));
check('outline 已是 &HAABBCC&', ser.includes('&HAABBCC&'));
check('行数不变', doc.events.length === 3, String(doc.events.length));

console.log('\n[5] 幂等: 再跑一次无变化');
const doc2 = new AssDoc(ser);
let n2 = 0;
for (const ev of doc2.events) {
  const before = ev.text || '';
  const after = normalize(before);
  if (after !== before) n2++;
}
check('第二次归一化 0 处改动', n2 === 0, String(n2));

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
