/* 角色名标签间距规范单测: node tests/role-gap-test.mjs
 * 规则（用户要求）: '[wato] 我' —— 标签与正文之间**恰好一个空格**, 不许连着也不许两个。 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const K = require_('../editor/js/karaoke.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};
const N = K.normalizeRoleGap;

/* 该补空格 */
ok(N('[wato]我') === '[wato] 我', '连着 → 补一个空格', N('[wato]我'));
ok(N('[wato]  我') === '[wato] 我', '两个空格 → 收成一个', N('[wato]  我'));
ok(N('[wato]   我 是') === '[wato] 我 是', '多空格 → 一个', N('[wato]   我 是'));
ok(N('[wato]\t我') === '[wato] 我', '制表符 → 空格', JSON.stringify(N('[wato]\t我')));
ok(N('[wato]\u3000我') === '[wato] 我', '全角空格 → 半角空格', JSON.stringify(N('[wato]\u3000我')));
ok(N('  [wato]我') === '  [wato] 我', '保留标签前的前导空白', JSON.stringify(N('  [wato]我')));

/* 已经规范的不动 */
ok(N('[wato] 我') === '[wato] 我', '已是一个空格 → 原样');
ok(N('[SPK1] 我在这个频道创建过很多密室逃脱 一年前') === '[SPK1] 我在这个频道创建过很多密室逃脱 一年前', '长句原样');

/* 只有标签 / 空标签 */
ok(N('[wato]') === '[wato]', '只有标签 → 不留尾随空格', JSON.stringify(N('[wato]')));
ok(N('[wato]   ') === '[wato]', '标签+空白 → 不留尾随空格', JSON.stringify(N('[wato]   ')));
ok(N('[] 我') === '[] 我', '空标签不当角色名 → 原样');
ok(N('[]我') === '[]我', '空标签不补空格 → 原样');

/* 正文内部的空白不动 */
ok(N('[wato] 你好  世界') === '[wato] 你好  世界', '正文内部的连续空格保持原样');
ok(N('[wato]  你好  世界  ') === '[wato] 你好  世界', '正文首尾空白收掉、内部保留');

/* 非行首的方括号不动 */
ok(N('我 [wato] 你') === '我 [wato] 你', '非行首方括号 → 原样');
ok(N('他说[wato]好') === '他说[wato]好', '非行首方括号(相邻) → 原样');

/* ASS 覆盖标签前缀原样保留 */
ok(N('{\\c&Hd000ff&}[wato]我') === '{\\c&Hd000ff&}[wato] 我', '前缀覆盖标签保留', N('{\\c&Hd000ff&}[wato]我'));

/* 边界: 空/非字符串 */
ok(N('') === '' && N(null) === '' && N(undefined) === '', '空值安全');
ok(N('没有标签的正文') === '没有标签的正文', '无标签原样');

/* ── setSpeakerTagInText: 编辑器"指定角色"时写标签用的纯函数 ──
 * 用户报过: 初稿(没做说话人分离 → 没有角色名标签)之后在编辑器里指定角色,
 * 标签与正文紧贴成 "[Spoke]正文" —— 旧的插入分支直接拼 tag + 正文, 没走 normalizeRoleGap。 */
const S = K.setSpeakerTagInText;
ok(S('正文', '[Spoke]') === '[Spoke] 正文', '插入: 无标签的正文 → 补一个空格', S('正文', '[Spoke]'));
ok(S('{\\c&Hffffff&}正文', '[Spoke]') === '{\\c&Hffffff&}[Spoke] 正文', '插入: 保留行首色标', S('{\\c&Hffffff&}正文', '[Spoke]'));
ok(S('[旧] 正文', '[Spoke]') === '[Spoke] 正文', '替换: 已有标签（带空格）→ 换名后仍一个空格', S('[旧] 正文', '[Spoke]'));
ok(S('[旧]正文', '[Spoke]') === '[Spoke] 正文', '替换: 旧标签本来就紧贴 → 顺手补上空格', S('[旧]正文', '[Spoke]'));
ok(S('[Spoke] 正文', '[Spoke]') === '[Spoke] 正文', '已经是目标标签 → 原样', S('[Spoke] 正文', '[Spoke]'));
ok(S('{\\c&Hd000ff&}[旧]  正文', '[Spoke]') === '{\\c&Hd000ff&}[Spoke] 正文', '替换: 多余空格收成一个', S('{\\c&Hd000ff&}[旧]  正文', '[Spoke]'));
ok(S('正文 [旧] 尾巴', '[Spoke]') === '[Spoke] 正文 [旧] 尾巴', '正文中间的方括号不动', S('正文 [旧] 尾巴', '[Spoke]'));
ok(S('', '[Spoke]') === '[Spoke]', '空正文 → 只有标签、不留尾随空格', JSON.stringify(S('', '[Spoke]')));
ok(S('正文', '[wato1876]') === '[wato1876] 正文', '真实角色名同样补空格', S('正文', '[wato1876]'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
