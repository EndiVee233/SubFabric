/* 热词挖掘单测: node tests/hotwords-test.mjs
 *
 * 钉住的约定：
 *   1. 只挖**旧文本里根本没有**的新词（对齐上的、两边都有的绝不能算）
 *   2. 小写普通词（the/and/home）不算热词；专名/术语/缩写/带数字的算
 *   3. 整句重写的跳过（对齐没意义）
 *   4. 已有的热词不重复推荐（exclude）
 *   5. 越常被改、越近被改的排越前
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  let stale = !fs.existsSync(marker);
  if (!stale) for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true }); fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();
const { mineHotwords, mineFromDetail, parseEditPairs, looksLikeTerm } = await import('./jsmod/hotwords.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

console.log('== ① detail 解析 ==');
eq(parseEditPairs('中文「A」→「B」'), [{ old: 'A', new: 'B' }], '单段中文');
eq(parseEditPairs('英文「a b」→「a c」'), [{ old: 'a b', new: 'a c' }], '单段英文');
eq(parseEditPairs('中文「A」→「B」；英文「x」→「y」'),
  [{ old: 'A', new: 'B' }, { old: 'x', new: 'y' }], '两段（中英各一）');
eq(parseEditPairs('只改了时间'), [], '没有「」→「」就返回空');
eq(parseEditPairs(''), [], '空串安全');

console.log('\n== ② 什么算热词 ==');
for (const t of ['Spock', 'B-Dubs', "O'Brien", 'S3', '3D', 'Docm77', '你好', 'Unstable'])
  ok(looksLikeTerm(t) === true, `${JSON.stringify(t)} 算热词`);
for (const t of ['the', 'and', 'home', 'x', '好', '123', '', 'a'])
  ok(looksLikeTerm(t) === false, `${JSON.stringify(t)} 不算热词`);

console.log('\n== ③ 单条 detail 挖掘 ==');
{
  const d = '中文「Spoke从中只得出一个结论」→「Spock从中只得出一个结论」';
  const r = mineFromDetail(d);
  eq(r.map(x => x.term), ['Spock'], '★ 抽出 Spock');
  ok(/Spoke/.test(r[0].replaced), '记下了"原来被听成 Spoke"', r[0]);
}
{
  // 英文本：对齐上的词（takes away from it）绝不能算新词
  const d = '英文「Spoke takes away from it」→「Spock takes away from it」';
  const r = mineFromDetail(d);
  eq(r.map(x => x.term), ['Spock'], '★ 只抽出 Spock，takes/away/from/it 不算', r.map(x => x.term));
}
{
  const d = '英文「and then they went」→「and then they went home」';
  const r = mineFromDetail(d);
  eq(r.map(x => x.term), [], '★ 新增的小写普通词 home 不算热词', r);
}
{
  const d = '英文「Bdubs is here」→「B-Dubs is here」';
  eq(mineFromDetail(d).map(x => x.term), ['B-Dubs'], '带连字符的专名能抽出来');
}
{
  const d = '中文「这是Docm的故事」→「这是Docm77的故事」';
  eq(mineFromDetail(d).map(x => x.term), ['Docm77'], '带数字的专名能抽出来');
}
{
  // 整句重写 → 跳过
  const big = 'a b c d e f g h i j k l m n o p q r s t u v w x y z';
  const d = `英文「${big}」→「完全换了一整句别的英文内容 nothing in common」`;
  eq(mineFromDetail(d).map(x => x.term), [], '★ 整句重写跳过（对齐没意义）');
}

console.log('\n== ④ 汇总与排序 ==');
{
  const fake = [
    { t: '2026-10-01T00:00:00Z', action: 'edit', target: '第 3 条', detail: '英文「Bdubs is here」→「B-Dubs is here」' },
    { t: '2026-10-02T00:00:00Z', action: 'edit', target: '第 7 条', detail: '英文「I saw Bdubs」→「I saw B-Dubs」' },
    { t: '2026-10-03T00:00:00Z', action: 'edit', target: '第 9 条', detail: '英文「the Etho farm」→「the Itho farm」' },
    { t: '2026-10-04T00:00:00Z', action: 'edit', target: '第 11 条', detail: '中文「这是Docm的故事」→「这是Docm77的故事」' },
    { t: '2026-10-05T00:00:00Z', action: 'edit', target: '第 12 条', detail: '英文「and then they went」→「and then they went home」' },
    { t: '2026-10-06T00:00:00Z', action: 'realign', target: '第 2 条', detail: '重排 5 个词' },
  ];
  const r = mineHotwords(fake);
  // 排序规则：改得多的在前（B-Dubs ×2 稳居第一），其余按"最近改的更相关"
  // → Docm77（10-04）比 Itho（10-03）新，所以排在前面
  eq(r.candidates.map(c => c.term), ['B-Dubs', 'Docm77', 'Itho'], '★ 只留 3 个专名，home 被排除，B-Dubs 排最前');
  eq(r.candidates[0].count, 2, 'B-Dubs 出现 2 次');
  // fake 里有 5 条 edit（realign 那条不算）
  eq(r.stats.editEntries, 5, '统计到 5 条 edit（realign 不算）');
  ok(r.candidates[0].samples.length >= 2, '带样本（让用户能判断）', r.candidates[0].samples.length);
}

console.log('\n== ⑤ exclude（已在热词表里的不重复推荐）==');
{
  const fake = [
    { t: '2026-10-01T00:00:00Z', action: 'edit', target: 'a', detail: '英文「Bdubs is here」→「B-Dubs is here」' },
    { t: '2026-10-02T00:00:00Z', action: 'edit', target: 'b', detail: '英文「the Etho farm」→「the Itho farm」' },
  ];
  eq(mineHotwords(fake, { exclude: ['B-Dubs'] }).candidates.map(c => c.term), ['Itho'],
    '★ 排除已有的 B-Dubs（大小写不敏感）');
  eq(mineHotwords(fake, { exclude: ['b-dubs', 'ITHO'] }).candidates.map(c => c.term), [],
    '★ 忽略大小写');
}

console.log('\n== ⑥ 健壮性 ==');
for (const [name, input] of [['null', null], ['空数组', []], ['无 edit', [{ action: 'note' }]],
  ['缺 detail', [{ action: 'edit' }]], ['空「」→「」', [{ action: 'edit', detail: '「」→「」' }]],
  ['非数组', 'x'], ['条目是 null', [null, { action: 'edit', detail: '「a」→「B」' }]]]) {
  let r = null, err = null;
  try { r = mineHotwords(input); } catch (e) { err = String(e && e.message); }
  ok(!err && r && Array.isArray(r.candidates), `${name} 不炸且返回候选数组`, err);
}

console.log('\n== ⑦ 界面接线：挖掘按钮与候选区的 id 都在 ==');
{
  const REPO = path.resolve(HERE, '..');
  const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
  const PJS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
  const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');
  for (const id of ['ah-mine', 'ah-mine-hint', 'ah-mine-list', 'ah-mine-foot',
                    'ah-mine-all', 'ah-mine-none', 'ah-mine-apply', 'ah-mine-count']) {
    ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
  }
  ok(/\/api\/projects\/\$\{pid\}\/hotword-candidates/.test(PJS), 'project.js 调用了挖掘接口');
  ok(/hotword-candidates/.test(SRV), 'server.js 有 hotword-candidates 路由');
  ok(/require\('\.\/hotwords\.js'\)/.test(SRV), 'server.js 引入了 hotwords.js');
  ok(/\.hw-mine-list\s*\{/.test(CSS), '候选区有样式（否则会挤成一坨）');
  // **只能用户勾选后才加** —— 界面上不能出现"自动应用"的路径
  ok(/cb\.checked = true/.test(PJS) && /dataset\.term/.test(PJS),
    '候选带复选框、默认全勾（用户可取消）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
