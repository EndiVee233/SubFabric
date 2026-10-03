/* 「未分配角色」真机探针:
 *  ① 批量替换的角色页签下拉里排在第一条, 计数 = 没有 [角色] 标签的行数
 *  ② 当源角色: 只命中那些行; 批量替换成新角色 → 只有它们被标上, 已有标签的行不动
 *  ③ 当目标角色: 把那些标签去掉（而不是写一个叫"未分配角色"的标签）
 *  ④ 角色列表(角色页签)里**不显示** 未分配角色
 *  ⑤ 关掉「启用角色标注」后, 批量替换的角色页签**不可进入**（按钮禁用、点不动、页签仍停在正文） */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8356';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const fmt = (t) => {
  const cs = Math.round(t * 100);
  const m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return '0:' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0');
};
const words = ['one', 'two', 'three'];
const rows = [
  { zh: '{\\c&Hffffff&}[A] 甲', en: 'alpha one' },
  { zh: '{\\c&Hffffff&}[A] 乙', en: 'beta two' },
  { zh: '{\\c&Hffffff&}丙', en: 'gamma three' },      // 无标签
  { zh: '{\\c&Hffffff&}丁', en: 'delta four' },       // 无标签
];
const dialogues = [];
rows.forEach((r, i) => {
  const t0 = i * 3, t1 = t0 + 3;
  dialogues.push(`Dialogue: 0,${fmt(t0)},${fmt(t1)},中文字幕,SPK1,0,0,0,,${r.zh}`);
  const ws = r.en.split(' ');
  ws.forEach((w, k) => {
    const text = ws.map((x, j) => (j === k ? '{\\c&H00ff00&}' + x + '{\\c}' : x)).join(' ');
    dialogues.push(`Dialogue: 0,${fmt(t0 + k)},${fmt(t0 + k + 1)},Default,SPK1,0,0,0,,${text}`);
  });
});
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: 中文字幕,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1',
  'Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...dialogues,
].join('\n');

const created = await (await fetch(BASE + '/api/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '未分配角色探针', video: { path: process.env.DEMO_VIDEO || 'D:/Vibe Coding/_t/demo.mp4' }, subtitle: { name: 'subtitle.ass', text: ass } }),
})).json();
if (!created || !created.id) { console.log('建项目失败:', JSON.stringify(created).slice(0, 200)); process.exit(1); }
console.log('临时项目:', created.id);

const zhRows = (txt) => txt.split('\n').filter(l => l.startsWith('Dialogue:') && l.includes(',中文字幕,'))
  .map(l => ((l.split(',', 10)[9] || '').replace(/\r$/, '')));

const b = await launch({ port: 9420, width: 1440, height: 900 });
try {
  await b.goto(BASE + '/#/project/' + created.id);
  await sleep(4500);
  ok(zhRows(readFileSync(`${PROJ}/${created.id}/subtitle.ass`, 'utf8')).length === 4, '夹具 4 行中文');

  // 打开批量替换 → 角色页签
  await b.eval("document.getElementById('btn-search').click()");
  await sleep(600);
  ok(await b.eval("!document.getElementById('fr-overlay').hidden"), '批量替换已打开');
  await b.eval("document.getElementById('fr-tab-role').click()");
  await sleep(400);
  ok(await b.eval("!document.getElementById('fr-pane-role').hidden"), '角色页签已进入');
  ok(await b.eval("document.getElementById('fr-tab-role').disabled === false"), '角色标注开着时页签可用');

  // ① 源角色下拉: 第一条 = 未分配角色, 计数 2
  await b.eval("document.getElementById('fr-src-dd').click()");
  await sleep(400);
  const menu = await b.eval(`JSON.stringify(Array.from(document.querySelectorAll('#fr-src-menu .fr-menu-item')).map(e => ({
    name: (e.querySelector('span:nth-child(2)')||{}).textContent || '', n: (e.querySelector('.fr-menu-n')||{}).textContent || ''
  })))`);
  console.log('  源角色候选:', menu);
  const items = JSON.parse(menu);
  ok(items.length > 0 && items[0].name === '未分配角色', '第一条是 未分配角色', JSON.stringify(items[0]));
  ok(items[0] && items[0].n === '2', '计数 = 没有标签的行数（2）', items[0] && items[0].n);
  ok(items.some(x => x.name === 'A' && x.n === '2'), '真角色 A 也在（2 行）', JSON.stringify(items));

  // ② 选中它 → 只命中无标签的两行
  await b.eval("document.querySelector('#fr-src-menu .fr-menu-item').click()");
  await sleep(500);
  const status = await b.eval("document.getElementById('fr-status').textContent");
  console.log('  状态:', status);
  ok(/未分配角色/.test(status) && /2 行/.test(status), '源=未分配角色 命中 2 行', status);

  // ② 全部替换为新角色 B → 只有那两行被标上
  await b.eval("(() => { const el = document.getElementById('fr-dst'); el.value = 'B'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(300);
  await b.eval("document.getElementById('fr-replace-all').click()");
  await sleep(2500);
  let zh = zhRows(readFileSync(`${PROJ}/${created.id}/subtitle.ass`, 'utf8'));
  console.log('  替换后:', JSON.stringify(zh));
  ok(zh.filter(x => /^\{[^}]*\}\[A\] /.test(x)).length === 2, '原来 A 的两行没被动', JSON.stringify(zh));
  ok(zh.filter(x => /^\{[^}]*\}\[B\] /.test(x)).length === 2, '无标签的两行被标成 [B]（带空格）', JSON.stringify(zh));
  ok(!zh.some(x => /\]\S/.test(x)), '没有 "]正文" 紧贴', JSON.stringify(zh));

  // ③ 把 B 设为未分配角色（当目标）→ 标签被去掉
  await b.eval("(() => { const el = document.getElementById('fr-src'); el.value = 'B'; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await sleep(600);
  const st2 = await b.eval("document.getElementById('fr-status').textContent");
  ok(/2 行/.test(st2), '源=B 命中 2 行', st2);
  await b.eval("(() => { const el = document.getElementById('fr-dst'); el.value = '未分配角色'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await sleep(300);
  await b.eval("document.getElementById('fr-replace-all').click()");
  await sleep(2500);
  zh = zhRows(readFileSync(`${PROJ}/${created.id}/subtitle.ass`, 'utf8'));
  console.log('  设为未分配后:', JSON.stringify(zh));
  ok(zh.filter(x => /\[B\]/.test(x)).length === 0, 'B 的标签被去掉了', JSON.stringify(zh));
  ok(zh.filter(x => /^\{[^}]*\}丙$/.test(x)).length === 1 && zh.filter(x => /^\{[^}]*\}丁$/.test(x)).length === 1,
    '正文完好、色标保留', JSON.stringify(zh));

  // ④ 角色页签列表里不显示 未分配角色
  await b.eval("document.getElementById('fr-close').click()");
  await sleep(300);
  await b.eval("document.querySelector('.ptab[data-tab=\"roles\"]').click()");
  await sleep(600);
  const roleList = await b.eval("document.getElementById('role-list').textContent");
  console.log('  角色列表:', roleList.replace(/\s+/g, ' ').trim().slice(0, 80));
  ok(!/未分配角色/.test(roleList), '角色列表里没有 未分配角色', roleList.slice(0, 60));
  const filterOpts = await b.eval("Array.from(document.querySelectorAll('#sel-role-filter option')).map(o => o.textContent).join('|')");
  ok(!/未分配角色/.test(filterOpts), '角色筛选里也没有 未分配角色', filterOpts);

  // ⑤ 关掉「启用角色标注」→ 角色页签不可进入
  await b.eval("document.querySelector('.ptab[data-tab=\"settings\"]').click()");
  await sleep(500);
  await b.eval("(() => { const c = document.getElementById('set-role'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await sleep(700);
  // 字幕里已有 [A] 标签 → 关开关会先弹二次确认, 要点"禁用"
  const confirmShown = await b.eval("!document.getElementById('confirm-overlay').hidden");
  if (confirmShown === true || confirmShown === 'true') {
    console.log('  出现了二次确认弹窗 → 点确认');
    await b.eval("document.getElementById('confirm-yes').click()");
    await sleep(700);
  } else {
    console.log('  （没有二次确认弹窗）');
  }
  const roleOn = await b.eval("document.getElementById('set-role').checked");
  ok(roleOn === false || roleOn === 'false', '开关确实关掉了', roleOn);
  await b.eval("document.querySelector('.ptab[data-tab=\"subs\"]').click()");
  await sleep(400);
  await b.eval("document.getElementById('btn-search').click()");
  await sleep(600);
  const dis = await b.eval("document.getElementById('fr-tab-role').disabled");
  ok(dis === true || dis === 'true', '关掉角色标注后, 角色页签被禁用', dis);
  await b.eval("document.getElementById('fr-tab-role').click()");
  await sleep(400);
  const paneHidden = await b.eval("document.getElementById('fr-pane-role').hidden");
  ok(paneHidden === true || paneHidden === 'true', '点它也进不去（角色面板仍隐藏）', paneHidden);
  const textActive = await b.eval("document.getElementById('fr-pane-text').hidden");
  ok(textActive === false || textActive === 'false', '仍停在正文页签', textActive);
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  try { await fetch(BASE + '/api/projects/' + created.id, { method: 'DELETE' }); console.log('已删除临时项目'); } catch {}
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
