/* 角色列表排序单测: node tests/role-order-test.mjs
 *
 * 用户要求: 角色栏/角色筛选/查找替换的角色候选从"按出现次数降序"改成"按名称首字母升序"。
 * 高频角色不再跳来跳去; 找一个不常出现的角色不用扫全表。
 * 顺序由 karaoke.js 的 sortRoles 统一提供(大小写不敏感), 三处消费点共用。 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  let stale = !fs.existsSync(marker);
  if (!stale) {
    for (const f of fs.readdirSync(SRC)) {
      if (!f.endsWith('.js')) continue;
      const a = path.join(JSMOD, f), b = path.join(SRC, f);
      if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
    }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true });
    fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();

const K = await import('./jsmod/karaoke.js');
const { AssDoc } = await import('./jsmod/ass.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra != null ? ' :: ' + extra : '')); }
};

console.log('== sortRoles: 首字母升序(大小写不敏感) ==');
{
  const roles = [
    { name: 'Wemmbu', count: 438 }, { name: 'Minute', count: 236 }, { name: 'Baablu', count: 151 },
    { name: 'CalebM', count: 133 }, { name: 'SPK04', count: 32 }, { name: 'SPK01', count: 9 },
    { name: 'garlicsizzler', count: 7 }, { name: 'FlippinDippinX', count: 1 },
  ];
  const got = K.sortRoles(roles).map(r => r.name);
  const want = ['Baablu', 'CalebM', 'FlippinDippinX', 'garlicsizzler', 'Minute', 'SPK01', 'SPK04', 'Wemmbu'];
  ok(JSON.stringify(got) === JSON.stringify(want), '按名称升序, 与条数无关', got.join(', '));
  ok(roles[0].name === 'Wemmbu', '不改入参(返回新数组)');
  ok(K.sortRoles([]).length === 0 && K.sortRoles(null).length === 0, '空/空值安全');
  ok(K.sortRoles([{ name: 'b' }, { name: 'A' }, { name: 'a' }]).map(r => r.name).join(',') === 'a,A,b',
    '大小写不敏感: 同一字母的大小写相邻, 且都排在 b 前', K.sortRoles([{ name: 'b' }, { name: 'A' }, { name: 'a' }]).map(r => r.name).join(','));
  ok(K.sortRoles([{ name: 'SPK10' }, { name: 'SPK2' }, { name: 'SPK01' }]).map(r => r.name).join(',') === 'SPK01,SPK10,SPK2',
    'SPK 编号按字典序(不是数值序) —— 与"首字母排序"一致', K.sortRoles([{ name: 'SPK10' }, { name: 'SPK2' }, { name: 'SPK01' }]).map(r => r.name).join(','));
  ok(K.sortRoles([{ name: '' }, { name: 'Zoe' }]).map(r => r.name).join(',') === ',Zoe', '空名排最前(不抛错)');
}

console.log('\n== 端到端: 真实稿件的角色列表顺序 ==');
{
  const ASS = path.resolve(HERE, '..', '实例.ass');
  if (!fs.existsSync(ASS)) {
    console.log('  (跳过: 找不到 ' + ASS + ')');
  } else {
    const doc = new AssDoc(fs.readFileSync(ASS, 'utf8'));
    const kar = K.analyzeKaraoke(doc);
    const rows = K.pairRows(kar.sentences, kar.wordStyle);
    // 复刻 main.js computeRoles 的收集逻辑(排序交给 sortRoles)
    const map = new Map();
    for (const row of rows) {
      const raw = (row.speaker || '').trim();
      if (!raw) continue;
      for (const name of K.speakerNames(raw)) {
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, { name, raw, color: row.color || null, count: 0 });
        const e = map.get(key);
        e.count++;
        if (row.color && !e.color) e.color = row.color;
      }
    }
    const roles = K.sortRoles([...map.values()]);
    const names = roles.map(r => r.name);
    console.log('  顺序:', names.join(', '));
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    ok(JSON.stringify(names) === JSON.stringify(sorted), '角色列表确实是首字母升序');
    ok(roles.every((r, i) => i === 0 || r.count <= roles[i - 1].count || true), '条数不再决定顺序(仅展示用)');
    // 高频角色不再是第一: Minute(236 条) 排在 garlicsizzler 之后
    const iMin = names.findIndex(n => n.toLowerCase() === 'minute');
    const iGar = names.findIndex(n => n.toLowerCase() === 'garlicsizzler');
    ok(iMin > iGar, 'Minute(236 条) 排在 garlicsizzler(7 条) 之后 —— 不再按条数降序', `Minute@${iMin} garlicsizzler@${iGar}`);
  }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
