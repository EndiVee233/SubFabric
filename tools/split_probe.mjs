/* 分句真机探针: 照用户截图那个场景 —— 一行 "all of wood,need to build my house oh my god",
 * 光标放在 "house" 之后(偏移 34) 按 Ctrl+回车, 断言切成 "…my house" / "oh my god"（不多吃一个 oh）。
 * 同时核对词级切片数: 两半分别 8 / 3 片。 */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync } from 'fs';
import { splitEnglishWordsWithSpans } from '../editor/js/karaoke.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8354';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const EN = 'all of wood,need to build my house oh my god';     // 规范分词 11 个词, 但按空格只有 10 块（正是这个 bug 的来源）
const CARET = 34;                                              // 光标在 "house" 之后（与用户截图一致）
const ZH = '全都是木头，得盖我的房子 哦我的天';
const fmt = (t) => {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0');
};
/* 逐词切片: 用**规范分词的原位 span**在原文里包高亮 —— 这样切片文本保留原始空格("wood,need" 不加空格),
 * 与用户文件里的情形一致(文本黏连, 但词是两个)。 */
const spans = splitEnglishWordsWithSpans(EN);
const words = spans.map(s => s.word != null ? s.word : s.w != null ? s.w : s.text);
const slices = spans.map((sp, i) => {
  const s = i * 0.5, e = (i + 1) * 0.5;
  const text = EN.slice(0, sp.start) + '{\\c&H00FF00&}' + EN.slice(sp.start, sp.end) + '{\\c}' + EN.slice(sp.end);
  return `Dialogue: 0,${fmt(s)},${fmt(e)},Default,SPK1,0,0,0,,${text}`;
});
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: 中文字幕,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1',
  'Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  // 中文行带**角色色标签**(行首内联 {\c&Hd000ff&} + 角色名) —— 分句后两半都必须保留它,
  // 否则会退回默认高亮色(用户截图里的"变黄")
  `Dialogue: 0,0:00:00.00,0:00:05.50,中文字幕,SPK1,0,0,0,,{\\c&Hd000ff&}[Spoke] ${ZH}`,
  ...slices,
].join('\n');

const body = JSON.stringify({ name: '分句探针', video: { path: process.env.DEMO_VIDEO || 'D:/Vibe Coding/_t/demo.mp4' }, subtitle: { name: 'fixture.ass', text: ass } });
const created = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
if (!created || !created.id) { console.log('建项目失败:', JSON.stringify(created).slice(0, 200)); process.exit(1); }
console.log('临时项目:', created.id);

const b = await launch({ port: 9416, width: 1440, height: 900 });
try {
  await b.goto(BASE + '/#/project/' + created.id);
  await sleep(4500);
  const cardOk = await b.eval(`(() => {
    const c = Array.from(document.querySelectorAll('.cue-card')).find(x => /house/.test((x.querySelector('.cc-l2')||{}).textContent||''));
    if (!c) return 'no-card';
    const el = c.querySelector('.cc-l2') || c;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + 60), y: Math.round(r.top + Math.min(12, r.height/2)) });
  })()`);
  ok(cardOk !== 'no-card', '找到那条卡片', cardOk);
  const p = JSON.parse(cardOk);
  await b.mouse('mousePressed', p.x, p.y, { clickCount: 1 });
  await b.mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
  await sleep(150);
  await b.mouse('mousePressed', p.x, p.y, { clickCount: 2 });
  await b.mouse('mouseReleased', p.x, p.y, { clickCount: 2 });
  await sleep(800);
  // 光标精确放到 "house" 之后 = 偏移 34（与用户截图一致）
  const caretAt = await b.eval(`(() => {
    const boxes = document.querySelectorAll('[contenteditable="true"]');
    const ed = boxes[boxes.length - 1];
    ed.focus();
    const node = ed.firstChild;
    const off = ${CARET};
    const r = document.createRange();
    r.setStart(node, Math.min(off, (node.textContent||'').length)); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return JSON.stringify({ text: node.textContent, off });
  })()`);
  console.log('  编辑行与光标:', caretAt);
  ok(/^all of wood,need to build my house/.test(JSON.parse(caretAt).text), '编辑的是那一行且文本一致');

  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(1800);
  const toast = await b.eval("(document.getElementById('toast')||{}).textContent");
  console.log('  提示:', toast);
  ok(/分为两条/.test(String(toast)), '提示已分句', toast);

  await sleep(2000);
  const file = ['fixture.ass', 'subtitle.ass'].find(f => { try { readFileSync(`${PROJ}/${created.id}/${f}`); return true; } catch { return false; } }) || 'subtitle.ass';
  const txt = readFileSync(`${PROJ}/${created.id}/${file}`, 'utf8');
  const dlg = txt.split('\n').filter(l => l.startsWith('Dialogue:'));
  const zh = dlg.filter(l => l.includes('中文字幕'));
  const en = dlg.filter(l => l.includes(',Default,'));
  console.log('  中文行数:', zh.length, ' 英文切片数:', en.length);
  ok(zh.length === 2, '中文也切成两条', zh.length);
  ok(en.length === 11, '英文切片仍是 11 片（词级时间没丢）', en.length);
  const enTexts = en.map(l => (l.match(/\{\\c&H00FF00&\}([^{]*)\{\\c\}/i) || [])[1] || '?');
  console.log('  切片高亮词顺序:', enTexts.join(' '));
  ok(enTexts.slice(0, 8).join('|') === 'all|of|wood,|need|to|build|my|house', '前半 = all of wood,need to build my house', enTexts.slice(0, 8).join('|'));
  ok(enTexts.slice(8).join('|') === 'oh|my|god', '后半 = oh my god', enTexts.slice(8).join('|'));
  ok(enTexts[7] === 'house' && enTexts[8] === 'oh', '切点在 house | oh 之间（不再多吃一个 oh）', enTexts[7] + ' | ' + enTexts[8]);
  const firstEnd = en[7].split(',')[2], secondStart = en[8].split(',')[1];
  ok(firstEnd <= secondStart, '两半时间不重叠', firstEnd + ' vs ' + secondStart);
  // 中文文本是否按词数比例切（前半 8/11）
  const zhBodies = zh.map(l => (l.slice(l.indexOf(',,') + 2) || '').trim());
  console.log('  前半中文:', JSON.stringify(zhBodies[0]));
  console.log('  后半中文:', JSON.stringify(zhBodies[1]));
  ok(zhBodies[0] && zhBodies[0].length > 0, '前半中文非空');
  // ── 角色色/角色名标签必须带到两半（用户报的"分句后变黄"）──
  ok(zhBodies.every(x => /\{\\c&Hd000ff&\}/i.test(x)), '两半都保留了行首角色色标签', JSON.stringify(zhBodies));
  ok(zhBodies.every(x => /\[Spoke\]/.test(x)), '两半都保留了角色名标签', JSON.stringify(zhBodies));
  ok(zhBodies[0].indexOf('{\\c') < zhBodies[0].indexOf('[Spoke]'), '标签顺序仍是 色标 在 角色名 之前');
  ok((zhBodies[0].match(/\{\\c&H/gi) || []).length === 1 && (zhBodies[1].match(/\{\\c&H/gi) || []).length === 1,
    '每半只有一个色标（没有重复叠加）', JSON.stringify(zhBodies.map(x => (x.match(/\{\\c&H/gi) || []).length)));
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  try { await fetch(BASE + '/api/projects/' + created.id, { method: 'DELETE' }); console.log('已删除临时项目'); } catch {}
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
