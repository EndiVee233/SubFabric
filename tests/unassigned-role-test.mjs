/* 「未分配角色」纯逻辑单测: node tests/unassigned-role-test.mjs
 * 功能: 批量替换的角色页签里多一个虚拟角色「未分配角色」= 所有**中文行没有 [角色] 标签**的行。
 * 它不进角色列表/筛选; 当目标角色用时=去掉标签。关闭「角色标注」时该页签不可进入(界面层, 由真机探针覆盖)。 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const K = require_('../editor/js/karaoke.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };
/* 造一个"行": isUnassignedRole 看中文行**事件文本**里的可见 [..] */
const row = (text) => ({ zh: text == null ? null : { events: [{ text }], text: String(text || '').replace(/\{[^}]*\}/g, '') } });
const U = K.isUnassignedRole, S = K.stripSpeakerTag;

console.log('== 未分配角色: 判定 ==');
ok(K.UNASSIGNED_ROLE === '未分配角色', '虚拟角色名 = 未分配角色', K.UNASSIGNED_ROLE);
ok(U(row('正文')) === true, '没有标签的行 → 未分配', U(row('正文')));
ok(U(row('{\\c&Hffffff&}正文')) === true, '只有色标、没有标签 → 未分配', U(row('{\\c&Hffffff&}正文')));
ok(U(row('[Spoke] 正文')) === false, '有标签的行 → 不是未分配', U(row('[Spoke] 正文')));
ok(U(row('{\\c&Hd000ff&}[Spoke] 正文')) === false, '色标+标签 → 不是未分配', U(row('{\\c&Hd000ff&}[Spoke] 正文')));
ok(U(row('{\\c&Hd000ff&}[Spoke]正文')) === false, '标签紧贴正文也算已分配（空格是另一条规则）', U(row('{\\c&Hd000ff&}[Spoke]正文')));
ok(U(row('正文里有 [方括号] 但不是行首标签')) === true, '行中间的方括号不算角色标签', U(row('正文里有 [方括号] 但不是行首标签')));
ok(U(row('[] 正文')) === true, '空标签 [] 不算角色（与角色列表同口径）', U(row('[] 正文')));
ok(U(row(null)) === true && U({}) === true && U(null) === true, '没有中文行/空行 → 未分配');

console.log('\n== 未分配角色: 设为目标时去掉标签 ==');
{
  const r = S('{\\c&Hffffff&}[Spoke] 正文');
  ok(r.removed === true && r.text === '{\\c&Hffffff&}正文', '去掉标签、保留行首色标、不留前导空格', JSON.stringify(r));
}
{
  const r = S('[Spoke]  正文');
  ok(r.removed === true && r.text === '正文', '标签后多余空格一起收掉', JSON.stringify(r));
}
{
  const r = S('[Spoke]正文');
  ok(r.removed === true && r.text === '正文', '紧贴的标签也能去掉', JSON.stringify(r));
}
{
  const r = S('正文');
  ok(r.removed === false && r.text === '正文', '本来就没有标签 → 原样返回 removed=false', JSON.stringify(r));
}
{
  const r = S('{\\c&Hffffff&}正文');
  ok(r.removed === false && r.text === '{\\c&Hffffff&}正文', '只有色标 → 原样', JSON.stringify(r));
}
{
  const r = S('{\\c&Hffffff&}[A] 甲 [B] 乙');
  ok(r.text === '{\\c&Hffffff&}甲 [B] 乙', '只去掉行首那一个标签, 正文里的方括号不动', JSON.stringify(r));
}
ok(S('') .text === '' && S(null).text === '', '空值安全');
/* 去掉标签后该行应变成"未分配" */
{
  const r = S('{\\c&Hd000ff&}[Spoke] 正文');
  ok(U(row(r.text)) === true, '去掉标签后这一行就算未分配了（自洽）', r.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
