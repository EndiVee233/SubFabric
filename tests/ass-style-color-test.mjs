/**
 * ASS 双语样式「默认颜色 / 备用颜色」设置项。
 *
 * 背景: 中英两条样式轨的颜色此前写死在 main.py generate_ass_header 与
 * editor/server.js assHeader 里(英文白 &H00FFFFFF / 中文黄 &H0000FFFF),
 * 设置面板只能改字体字号。这里验证颜色也能配, 且:
 *   ① hex(#rrggbb) ↔ ASS(&HAABBGGRR, BGR 顺序) 往返不丢位
 *   ② 只改样式轨默认值, 行内 \c/\1c 覆盖标签不动
 *   ③ 非法输入回落到各自默认值(英文白 / 中文黄), 不写坏稿件
 */
import { AssDoc } from './jsmod/ass.js';

/** 与 editor/js/main.js 的 assHexToBgr 同款: '#RRGGBB' → '&HAABBGGRR' */
function assHexToBgr(hex) {
  const rgb = String(hex == null ? '' : hex).replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(rgb)) return null;
  return `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

/** 与 editor/js/main.js 的 assBgrToHex 同款。取末尾 6 位, 别被 8 位格式的 alpha 带偏。 */
function assBgrToHex(raw, fallback) {
  const m = /&H([0-9A-Fa-f]{6,8})/i.exec(String(raw || ''));
  if (!m) return fallback;
  const h = m[1].slice(-6).toUpperCase();
  return '#' + (h[4] + h[5] + h[2] + h[3] + h[0] + h[1]).toLowerCase();
}

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '→ ' + extra); }
}

const SAMPLE = `[Script Info]
; SubFabric 私有元数据: wordColor: #00ff00
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic
Style: Default,Comic Sans MS,65,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0
Style: 中文字幕,Comic Sans MS,65,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,-1,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,中文字幕,SPK1,0,0,0,,{\\c&H0B0BE5&}中文台词
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\c&H00ff00&}Hello{\\c} world
`;

console.log('ass-style-color: 颜色往返与样式写回');

/* ── ① hex ↔ ASS 往返(BGR 顺序最容易写反, 逐个颜色验) ── */
console.log('\n[1] hex ↔ &HAABBGGRR 往返');
for (const hex of ['#ffffff', '#ffff00', '#00ff00', '#ff0000', '#0000ff', '#123456', '#abcdef', '#000000']) {
  const bgr = assHexToBgr(hex);
  const back = assBgrToHex(bgr, null);
  check(`${hex} → ${bgr} → ${back}`, back === hex, back);
}
// 8 位带 alpha 的写法不能被截错位(&H00FFFFFF 的 alpha 是 00, RGB 才是 FFFFFF)
check('8 位 alpha 前缀不丢位', assBgrToHex('&H00FFFFFF', null) === '#ffffff', assBgrToHex('&H00FFFFFF', null));
check('6 位无 alpha 也能解析', assBgrToHex('&H00FF00', null) === '#00ff00', assBgrToHex('&H00FF00', null));

/* ── ② 非法输入回落 ── */
console.log('\n[2] 非法输入不产生坏值');
check('#zzz 判为无效', assHexToBgr('#zzz') === null);
check('空串判为无效', assHexToBgr('') === null);
check('null 判为无效', assHexToBgr(null) === null);
check('5 位短值判为无效', assHexToBgr('#12345') === null);
check('认不出的颜色回落 fallback', assBgrToHex('&H00ZZZZZZ', '#ffffff') === '#ffffff');

/* ── ③ 写入样式轨, 行内标签不受影响 ── */
console.log('\n[3] 只改样式默认值, 行内 \\c 标签不动');
const doc = new AssDoc(SAMPLE);
check('读到英文样式', !!doc.getStyle('Default'));
check('读到中文样式', !!doc.getStyle('中文字幕'));

const zhLineBefore = doc.lines.find(l => l.startsWith('Dialogue') && l.includes('中文字幕'));
const enLineBefore = doc.lines.find(l => l.startsWith('Dialogue') && l.includes('Default'));

check('初始英文主色=白', assBgrToHex(doc.getStyle('Default').primarycolour, null) === '#ffffff',
  doc.getStyle('Default').primarycolour);
check('初始中文主色=黄', assBgrToHex(doc.getStyle('中文字幕').primarycolour, null) === '#ffff00',
  doc.getStyle('中文字幕').primarycolour);

// 模拟用户在面板里把中文设成粉红、英文设成青色
check('写入中文主色', doc.setStyleFields('中文字幕', { primarycolour: assHexToBgr('#f472b6') }) === true);
check('写入中文备用色', doc.setStyleFields('中文字幕', { secondarycolour: assHexToBgr('#00ff88') }) === true);
check('写入英文主色', doc.setStyleFields('Default', { primarycolour: assHexToBgr('#38bdf8') }) === true);
check('写入英文备用色', doc.setStyleFields('Default', { secondarycolour: assHexToBgr('#ffffff') }) === true);

check('中文主色已变粉红', assBgrToHex(doc.getStyle('中文字幕').primarycolour, null) === '#f472b6',
  doc.getStyle('中文字幕').primarycolour);
check('中文备用色已变', assBgrToHex(doc.getStyle('中文字幕').secondarycolour, null) === '#00ff88');
check('英文主色已变青', assBgrToHex(doc.getStyle('Default').primarycolour, null) === '#38bdf8',
  doc.getStyle('Default').primarycolour);

// 关键: 说话人色 &H0B0BE5 与逐词高亮 &H00ff00 是行内标签, 必须原样保留
const zhLineAfter = doc.lines.find(l => l.startsWith('Dialogue') && l.includes('中文字幕'));
const enLineAfter = doc.lines.find(l => l.startsWith('Dialogue') && l.includes('Default'));
check('中文行内说话人色未被改', zhLineAfter === zhLineBefore, zhLineAfter);
check('英文行内逐词高亮未被改', enLineAfter === enLineBefore, enLineAfter);
check('说话人色仍是 &H0B0BE5', zhLineAfter.includes('&H0B0BE5&'));
check('逐词色仍是 &H00ff00&', enLineAfter.includes('&H00ff00&'));

// 其它样式字段不受牵连
check('字号没被颜色改动带偏', doc.getStyle('中文字幕').fontsize === '65', doc.getStyle('中文字幕').fontsize);
check('字体名没变', doc.getStyle('中文字幕').fontname === 'Comic Sans MS', doc.getStyle('中文字幕').fontname);

// 值没变时返回 false, 不产生无谓写入(project 自动保存靠这个判断)
check('重复写同值返回 false', doc.setStyleFields('中文字幕', { primarycolour: assHexToBgr('#f472b6') }) === false);

/* ── ④ 导出后的完整 ASS 文本 ── */
console.log('\n[4] 导出文本里的 Style 行');
const out = doc.serialize();
check('中文 Style 行带粉红主色', /Style: 中文字幕,[^,]*,[^,]*,&H00B672F4,/i.test(out),
  (out.match(/Style: 中文字母?.*/) || [''])[0]);
check('英文 Style 行带青色主色', /Style: Default,[^,]*,[^,]*,&H00F8BD38,/i.test(out),
  (out.match(/Style: Default.*/) || [''])[0]);

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
