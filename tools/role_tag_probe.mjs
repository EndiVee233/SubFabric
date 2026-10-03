/* 真机探针: 「初稿没有角色名 → 在编辑器里指定角色」这条路径必须写成 "[Spoke] 正文"（标签与正文一个空格）。
 * 用户报过: 这条路径会得到 "[Spoke]正文" —— setEventSpeakerTag 的"插入"分支直接拼 tag + 正文, 没走 normalizeRoleGap。
 * 流程: 造一行**没有角色名标签**的中文行 → 播放头压到该行 → 角色页签「＋ 添加角色」→ 点该角色 → 解析落盘 ASS。 */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8356';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const EN = 'today we build a house';
const fmt = (t) => {
  const cs = Math.round(t * 100);
  const m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return '0:' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0');
};
const words = EN.split(' ');
const slices = words.map((w, i) => {
  const text = words.map((x, j) => (j === i ? '{\\c&H00ff00&}' + x + '{\\c}' : x)).join(' ');
  return `Dialogue: 0,${fmt(i * 0.5)},${fmt((i + 1) * 0.5)},Default,SPK1,0,0,0,,${text}`;
});
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: 中文字幕,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1',
  'Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:02.50,中文字幕,SPK1,0,0,0,,{\\c&Hffffff&}今天我们来盖房子',   // ← 故意不带角色名标签
  ...slices,
].join('\n');

const created = await (await fetch(BASE + '/api/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '角色标签空格探针', video: { path: process.env.DEMO_VIDEO || 'D:/Vibe Coding/_t/demo.mp4' }, subtitle: { name: 'subtitle.ass', text: ass } }),
})).json();
if (!created || !created.id) { console.log('建项目失败:', JSON.stringify(created).slice(0, 200)); process.exit(1); }
console.log('临时项目:', created.id);

const b = await launch({ port: 9419, width: 1440, height: 900 });
try {
  await b.goto(BASE + '/#/project/' + created.id);
  await sleep(4500);

  const before = readFileSync(`${PROJ}/${created.id}/subtitle.ass`, 'utf8');
  const beforeZh = ((before.split('\n').find(l => l.includes(',中文字幕,')) || '').split(',', 10)[9] || '').replace(/\r$/, '');
  console.log('  改前中文行:', JSON.stringify(beforeZh));
  ok(!/\[/.test(beforeZh), '改前这一行确实没有角色名标签', beforeZh);

  // 播放头压到这一行上（assignSpeakerAtPlayhead 用它判断"当前块"）
  await b.eval("(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 1.0; })()");
  await sleep(900);
  // 角色页签 → 添加角色（自定义弹窗 #role-new，不是 prompt）
  await b.eval("document.querySelector('.ptab[data-tab=\"roles\"]').click()");
  await sleep(500);
  await b.eval("document.querySelector('#role-list .role-add').click()");
  await sleep(700);
  const dlgOpen = await b.eval("!document.getElementById('role-new').hidden");
  ok(dlgOpen === true || dlgOpen === 'true', '添加角色弹窗已打开');
  await b.eval(`(() => {
    const el = document.getElementById('role-new-name');
    el.value = 'Spoke';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(900);
  const roleCards = await b.eval("JSON.stringify(Array.from(document.querySelectorAll('#role-list .role-card')).map(e => (e.textContent||'').trim().slice(0,14)))");
  console.log('  角色列表:', roleCards);
  ok(/Spoke/.test(roleCards), '角色已添加进列表', roleCards);

  // 点该角色 = 设为播放头所在块的角色（走 applyRoleToRow → setEventSpeakerTag 的插入分支）
  const clicked = await b.eval(`(() => {
    const c = Array.from(document.querySelectorAll('#role-list .role-card')).find(e => /Spoke/.test(e.textContent||''));
    if (!c) return 'no-card';
    c.click();
    return 'ok';
  })()`);
  ok(clicked === 'ok', '点中了角色卡片', clicked);
  await sleep(2500);   // 等自动保存

  const after = readFileSync(`${PROJ}/${created.id}/subtitle.ass`, 'utf8');
  const afterZh = ((after.split('\n').find(l => l.includes(',中文字幕,')) || '').split(',', 10)[9] || '').replace(/\r$/, '');
  console.log('  改后中文行:', JSON.stringify(afterZh));
  ok(/\[Spoke\]/.test(afterZh), '标签写进去了', afterZh);
  ok(/\[Spoke\] /.test(afterZh), '标签与正文之间**有一个空格**', afterZh);
  ok(!/\]\S/.test(afterZh), '没有 "]正文" 这种紧贴', afterZh);
  ok(/\[Spoke\] 今天我们来盖房子$/.test(afterZh), '正文本身完好', afterZh);
  ok(afterZh.indexOf('{\\c') === 0 || /^\{\\c/.test(afterZh), '行首色标仍在最前', afterZh);
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  try { await fetch(BASE + '/api/projects/' + created.id, { method: 'DELETE' }); console.log('已删除临时项目'); } catch {}
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
