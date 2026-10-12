/**
 * 定位两个真 bug（用户报：改中英上下顺序 → 改逐词高亮色 → 画面两行重叠；再改顺序就"恢复"）。
 *
 * 真页面复现实测到的两个现象：
 *   ③ 改色后文档里**同时有两个色标**（&H00FF00& 与 &HFFFFFF&）→ 只改了一部分行
 *   ④ 再改顺序后色标**整体变回 &H00FF00&** → 颜色改动被重排回退
 *
 * 本文件用纯逻辑把两条坐实：
 *   B1  setEventText 改了行，但没同步 ev._rawParts → 之后 orderDialoguesByStyle 会拿旧内容重写
 *   B2  重排后的行里，被改过的颜色丢失（回到旧色）
 */
import { AssDoc } from './jsmod/ass.js';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '   ' + extra); }
}

const ZH = '中文字幕', EN = 'Default';
const mk = () => new AssDoc(`[Script Info]
; SubFabricWordHighlightColor: #00ff00
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,65,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,3,2,20,20,120,1
Style: 中文字幕,Arial,65,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,2,2,10,10,125,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.08,0:00:06.00,中文字幕,,0,0,0,,这是中文整句。
Dialogue: 0,0:00:00.08,0:00:00.24,Default,,0,0,0,,{\\c&H00FF00&}This{\\c} is the sentence.
Dialogue: 0,0:00:00.24,0:00:00.40,Default,,0,0,0,,This {\\c&H00FF00&}is{\\c} the sentence.
Dialogue: 0,0:00:00.40,0:00:06.00,Default,,0,0,0,,This is {\\c&H00FF00&}the{\\c} sentence.
`);

console.log('\n── B1：setEventText 之后 _rawParts 是否同步 ──');
{
  const doc = mk();
  const ev = doc.events.find(e => String(e.style).toLowerCase() === EN.toLowerCase());
  const before = String(ev.text);
  const partsBefore = JSON.stringify(ev._rawParts || null);
  doc.setEventText(ev, before.replace('00FF00', 'FFFFFF'));
  const partsAfter = JSON.stringify(ev._rawParts || null);
  const textAfter = String(ev.text);
  const lineText = doc.lines[ev.lineIdx];
  console.log('    ev.text     改后: ' + textAfter.slice(0, 60));
  console.log('    文件行      改后: ' + String(lineText).slice(0, 80));
  console.log('    _rawParts 有变化: ' + (partsBefore !== partsAfter));
  check('文件行确实被改成新色（setEventText 生效）', lineText.includes('&HFFFFFF&'));
  check('文件行与 ev.text 一致（写对了位置）', String(lineText).includes(textAfter.replace(/^Dialogue: /, '')) || lineText.includes(textAfter));
  check('_rawParts 与 ev.text 同步', partsAfter === JSON.stringify((textAfter || '').split(',')) || partsAfter.includes('FFFFFF'),
    '_rawParts=' + String(partsAfter).slice(0, 80));
}

console.log('\n── B2：改色后再重排顺序，颜色会不会被回退 ──');
{
  const doc = mk();
  for (const ev of doc.events.filter(e => String(e.style).toLowerCase() === EN.toLowerCase())) {
    doc.setEventText(ev, String(ev.text).replace(/\\c&H00FF00&/g, '\\c&HFFFFFF&'));
  }
  const afterColor = doc.serialize();
  check('改色后文档里只有新色', !afterColor.includes('&H00FF00&') && afterColor.includes('&HFFFFFF&'),
    'colors=' + JSON.stringify([...new Set(afterColor.match(/\\c&H[0-9A-Fa-f]{6}&/g) || [])]));

  const changed = doc.orderDialoguesByStyle(EN);
  check('重排确实发生了', changed === true);
  const afterOrder = doc.serialize();
  console.log('    重排后色标: ' + JSON.stringify([...new Set(afterOrder.match(/\\c&H[0-9A-Fa-f]{6}&/g) || [])]));
  check('重排后颜色仍然是新色（没有被回退）',
    afterOrder.includes('&HFFFFFF&') && !afterOrder.includes('&H00FF00&'),
    'colors=' + JSON.stringify([...new Set(afterOrder.match(/\\c&H[0-9A-Fa-f]{6}&/g) || [])]));
}

console.log('\n── B3：反过来（先重排、再改色）是否也会丢 ──');
{
  const doc = mk();
  doc.orderDialoguesByStyle(EN);
  for (const ev of doc.events.filter(e => String(e.style).toLowerCase() === EN.toLowerCase())) {
    doc.setEventText(ev, String(ev.text).replace(/\\c&H00FF00&/g, '\\c&HFFFFFF&'));
  }
  const t = doc.serialize();
  check('先重排再改色 → 新色保留', t.includes('&HFFFFFF&') && !t.includes('&H00FF00&'),
    'colors=' + JSON.stringify([...new Set(t.match(/\\c&H[0-9A-Fa-f]{6}&/g) || [])]));
}

console.log('\n── A：换色的覆盖范围（切片形态下必须整轨换净）──');
{
  /* 最小复现件的真实形状：一个句子 = N 条切片事件，每条带**同一个词**的高亮 span，
   * 而 kar.sentences 只挂住其中一部分。main.js 现在按"整条英文样式轨"取 scope，
   * 所以换色之后，**同一句的所有切片都必须是新色**。这里按同一口径自己遍历一遍验证。 */
  const doc = mk();
  const enAll = doc.events.filter(e => String(e.style).toLowerCase() === EN.toLowerCase());
  for (const ev of enAll) doc.setEventText(ev, String(ev.text).replace(/\\c&H00FF00&/g, '\\c&HFFFFFF&'));
  const text = doc.serialize();
  const colors = [...new Set(text.match(/\\c&H[0-9A-Fa-f]{6}&/g) || [])];
  check('整轨换净：文档里只剩新色（不残留旧色）',
    colors.length === 1 && colors[0] === '\\c&HFFFFFF&', 'colors=' + JSON.stringify(colors));
  const enLines = (text.match(/^Dialogue:[^\n]*Default[^\n]*$/gm) || []);
  check('每条英文切片都换成新色（' + enLines.length + ' 条）',
    enLines.length > 0 && enLines.every(l => l.includes('&HFFFFFF&')), '');
  const zhLines = (text.match(/^Dialogue:[^\n]*中文字幕[^\n]*$/gm) || []);
  check('中文轨没被写入任何色标', zhLines.every(l => !/\\c&H[0-9A-Fa-f]{6}&/.test(l)));
}

console.log('');
if (failed) { console.log(`✗ ${failed} 项失败`); process.exit(1); }
console.log('全部通过');
