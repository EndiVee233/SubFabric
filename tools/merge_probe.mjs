/* 「与上一条合并」真机验证: 造两条带颜色标签的 karaoke 行 → 在**第二条**的英文行首按 Ctrl+退格 →
 * 解析落盘的 ASS, 断言: 中文行只保留上一句自己的颜色标签(无绿高亮/无后句颜色),
 * 英文切片里"上句末词的结束"被接到本句开始, 其余词级时间原样不动。 */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync, readdirSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8321';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';   // 验装机版时指到它的 projects/
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: 中文字幕,Microsoft YaHei,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1',
  'Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:00:02.00,中文字幕,SPK1,0,0,0,,{\\c&Hd000ff&}[Spk] 第一句',
  'Dialogue: 0,0:00:00.00,0:00:00.80,Default,SPK1,0,0,0,,{\\c&H00ff00&}first{\\c} sentence here',
  'Dialogue: 0,0:00:00.80,0:00:01.60,Default,SPK1,0,0,0,,first {\\c&H00ff00&}sentence{\\c} here',
  'Dialogue: 0,0:00:01.60,0:00:02.00,Default,SPK1,0,0,0,,first sentence {\\c&H00ff00&}here{\\c}',
  'Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,SPK1,0,0,0,,{\\c&Hff0000&}[Bob] 第二句',
  'Dialogue: 0,0:00:03.00,0:00:03.80,Default,SPK1,0,0,0,,{\\c&H00ff00&}second{\\c} line comes',
  'Dialogue: 0,0:00:03.80,0:00:04.40,Default,SPK1,0,0,0,,second {\\c&H00ff00&}line{\\c} comes',
  'Dialogue: 0,0:00:04.40,0:00:05.00,Default,SPK1,0,0,0,,second line {\\c&H00ff00&}comes{\\c}',
].join('\n');

const body = JSON.stringify({ name: '合并验证', video: { path: 'D:/Vibe Coding/_t/demo.mp4' }, subtitle: { name: 'm.ass', text: ass } });
const proj = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
console.log('临时项目:', proj.id);

const b = await launch({ port: 9405, width: 1440, height: 900 });
try {
  await b.goto(BASE + '/#/project/' + proj.id);
  await sleep(4000);
  const cards = await b.eval("document.querySelectorAll('.cue-card').length");
  ok(cards >= 2, '载入两条字幕卡', cards);

  // 合并前的基线：等自动保存落盘后, 记下每条英文切片的时间(后面自比, 不假设绝对值)
  await sleep(1800);
  const basePath = `${PROJ}/${proj.id}/subtitle.ass`;
  const baseText = readFileSync(basePath, 'utf8');
  const baselineTimes = baseText.split('\n').filter(l => l.startsWith('Dialogue:') && l.includes(',Default,'))
    .map(l => [l.split(',')[1], l.split(',')[2]]);
  console.log('  合并前英文切片:', baselineTimes.map(t => t[0] + '→' + t[1]).join('  '));

  const pos = await b.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('.cue-card'));
    const c = cards.find(x => /second/.test((x.querySelector('.cc-l2') || {}).textContent || ''));
    if (!c) return 'null';
    const el = c.querySelector('.cc-l2') || c;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + Math.min(12, r.height / 2)) });
  })()`);
  ok(pos !== 'null', '找到第二条卡片（英文含 second）');
  const p = JSON.parse(pos);
  await b.mouse('mousePressed', p.x, p.y, { clickCount: 1 });
  await b.mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
  await sleep(150);
  await b.mouse('mousePressed', p.x, p.y, { clickCount: 2 });
  await b.mouse('mouseReleased', p.x, p.y, { clickCount: 2 });
  await sleep(800);
  const edText = await b.eval("(document.querySelectorAll('[contenteditable=\"true\"]')[1]||document.querySelector('[contenteditable=\"true\"]')||{}).textContent || ''");
  console.log('  正在编辑的英文行:', JSON.stringify(String(edText).slice(0, 40)));
  ok(/second/.test(String(edText)), '编辑的是第二条的英文行', edText);

  await b.eval(`(() => {
    const boxes = document.querySelectorAll('[contenteditable="true"]');
    const ed = boxes[boxes.length - 1];
    ed.focus();
    const r = document.createRange();
    r.setStart(ed.firstChild || ed, 0); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  })()`);
  await sleep(250);

  // 只发一次 keyDown + keyUp: rawKeyDown 与 keyDown 都会让页面收到 keydown，发两次会合并两回（踩过）
  for (const type of ['keyDown', 'keyUp']) {
    await b.send('Input.dispatchKeyEvent', {
      type, modifiers: 2, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
  }
  await sleep(1600);
  const toast = await b.eval("(document.getElementById('toast')||{}).textContent");
  console.log('  提示:', toast);
  ok(/已与上一条合并/.test(String(toast)), '提示显示已合并', toast);

  await sleep(2200);                                  // 等自动保存
  const file = ['subtitle.ass', 'sub.ass'].find(f => { try { readFileSync(`${PROJ}/${proj.id}/${f}`); return true; } catch { return false; } }) || 'subtitle.ass';
  const fileText = readFileSync(`${PROJ}/${proj.id}/${file}`, 'utf8');
  console.log('  读到:', file, ' 字节:', Buffer.byteLength(fileText), ' 行数:', fileText.split('\n').length);
  if (!/Dialogue:/.test(fileText)) {
    console.log('  --- 内容前 6 行 ---');
    fileText.split('\n').slice(0, 6).forEach(l => console.log('    ' + JSON.stringify(l.slice(0, 80))));
    console.log('  目录内容:', readdirSync(`${PROJ}/${proj.id}`).join(', '));
  }

  const dialogues = fileText.split('\n').filter(l => l.startsWith('Dialogue:'));
  const zhLines = dialogues.filter(l => l.includes('中文字幕'));
  const enLines = dialogues.filter(l => l.includes(',Default,'));
  console.log('  中文行数:', zhLines.length, ' 英文切片数:', enLines.length);
  ok(zhLines.length === 1, '中文只剩一条（两条合一）', zhLines.length);
  const zhBody = zhLines[0] ? zhLines[0].slice(zhLines[0].indexOf(',,') + 2) : '';
  console.log('  中文行文本:', zhBody);
  ok(/第一句\s*第二句/.test(zhBody), '中文按纯文本并入上一句', zhBody);
  ok(!/00ff00/i.test(zhBody), '中文行没有绿高亮标签');
  ok(!/ff0000/i.test(zhBody), '中文行没有带过后句的红色标签');
  ok((zhBody.match(/\{\\c&H/gi) || []).length === 1, '中文行只剩上一句自己的颜色标签', zhBody);
  ok(/\[Spk\]/.test(zhBody) && !/\[Bob\]/.test(zhBody), '角色标签保持上一句的', zhBody);

  ok(enLines.length === 6, '英文切片数 = 两条之和（6）', enLines.length);
  const times = enLines.map(l => l.split(',')[1] + '→' + l.split(',')[2]);
  console.log('  英文切片时间:', times.join('  '));
  enLines.forEach((l, k) => {
    const m = /\{\\c&H00ff00&\}([^{]*)\{\\c\}/i.exec(l);
    console.log('    #' + k, l.split(',')[1] + '~' + l.split(',')[2], ' 高亮词=' + (m ? m[1] : '(无)'));
  });
  // 自比断言：与合并前的基线逐个比较 —— 每个词起点不变、只有"上句末词"的结束被拉到本句开始
  let sameStart = true, changedEndAt = [];
  for (let k = 0; k < Math.min(baselineTimes.length, enLines.length); k++) {
    const [bS, bE] = baselineTimes[k];
    if (enLines[k].split(',')[1] !== bS) sameStart = false;
    if (enLines[k].split(',')[2] !== bE) changedEndAt.push(k);
  }
  ok(sameStart, '所有词的起点都没动', enLines.map(l => l.split(',')[1]).join(' '));
  ok(changedEndAt.length === 1 && changedEndAt[0] === 2, '只有一个词的结束被改动（上句末词，第 3 片）', JSON.stringify(changedEndAt));
  const prevLast = enLines[2].split(',')[2];
  const curFirst = enLines[3].split(',')[1];
  ok(prevLast === curFirst, '上句末词的结束 == 本句首词的开始（用户要求的接缝）', prevLast + ' vs ' + curFirst);

} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  try { await fetch(BASE + '/api/projects/' + proj.id, { method: 'DELETE' }); console.log('已删除临时项目'); } catch {}
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
