/* 角色换色单测: node tests/role-recolor-test.mjs
 *
 * 回归的 bug: 「改 garlicsizzler 的颜色, 结果 Minute 被染色、garlicsizzler 自己不变」。
 * 根因: 旧实现按**旧颜色值**匹配要改的行, 两个角色撞色(实测 Minute 与 garlicsizzler 都是
 * #ffffff)时就把别人的行一起改了; 而 garlicsizzler 那些**没有行首色标**的行匹配不上, 纹丝不动。
 * 现在 recolorRoleInRows 按**角色名**定位, 且只动中文整句行的行首色标(不碰英文逐词 span)。
 *
 * 另外覆盖: 逐词高亮色不再是写死的绿 —— setWordHighlightColor 之后 wordHighlightTag 跟着变,
 * 这样新增字幕/重新识别生成的 span 才会用用户选的色。 */
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

/* ── 假的 AssDoc: 只提供 setEventText ── */
const fakeDoc = () => ({ setEventText(ev, t) { ev.text = t; } });
const mkRow = (speaker, zhText, enText) => {
  const zh = zhText == null ? null : { color: null, speaker: '', events: [{ text: zhText }] };
  const en = enText == null ? null : { color: null, speaker: '', events: [{ text: enText }] };
  return { speaker, zh, en, color: null };
};
const zhTextOf = (row) => row.zh.events[0].text;

console.log('== 按角色名换色: 两个角色撞同一个颜色 ==');
{
  // Minute 与 garlicsizzler 的中文行行首都是同一个白色; garlicsizzler 还有一条没色标的行
  const rows = [
    mkRow('Minute', '{\\c&HFFFFFF&}[Minute] 太危险了'),
    mkRow('garlicsizzler', '{\\c&HFFFFFF&}[garlicsizzler] 你怎么是紫色的'),
    mkRow('garlicsizzler', '[garlicsizzler] 兄弟 求你了'),          // 没有行首色标
    mkRow('Minute', '{\\c&HFFFFFF&}[Minute] 我还是把你带回主世界吧'),
  ];
  const doc = fakeDoc();
  const n = K.recolorRoleInRows(doc, rows, ['garlicsizzler'], '#ff0000');

  ok(n === 2, '只改了 garlicsizzler 的 2 条中文行(含那条没色标的)', 'n=' + n);
  ok(zhTextOf(rows[0]) === '{\\c&HFFFFFF&}[Minute] 太危险了', 'Minute 第 1 行未被改', zhTextOf(rows[0]));
  ok(zhTextOf(rows[3]) === '{\\c&HFFFFFF&}[Minute] 我还是把你带回主世界吧', 'Minute 第 2 行未被改', zhTextOf(rows[3]));
  ok(zhTextOf(rows[1]) === '{\\c&H0000FF&}[garlicsizzler] 你怎么是紫色的', 'garlicsizzler 有色标的行改成新色(BGR=0000FF)', zhTextOf(rows[1]));
  ok(zhTextOf(rows[2]) === '{\\c&H0000FF&}[garlicsizzler] 兄弟 求你了', 'garlicsizzler 没色标的行**补上**了新色', zhTextOf(rows[2]));
  ok(rows[0].color === null && rows[3].color === null, 'Minute 的 row.color 未被改');
  ok(rows[1].color === '#ff0000' && rows[2].color === '#ff0000', 'garlicsizzler 的 row.color 同步成新色');
}

console.log('\n== 只动中文整句行: 英文逐词 span 不能被污染 ==');
{
  const rows = [
    mkRow('garlicsizzler', '{\\c&HFFFFFF&}[garlicsizzler] 兄弟 求你了', '{\\c&HFFFFFF&}Bro,{\\c} please'),
    mkRow('Minute', '{\\c&HFFFFFF&}[Minute] 什么？', '{\\c&HFFFFFF&}What{\\c} ?'),
  ];
  const doc = fakeDoc();
  K.recolorRoleInRows(doc, rows, ['garlicsizzler'], '#00ff00');
  ok(rows[0].en.events[0].text === '{\\c&HFFFFFF&}Bro,{\\c} please', '英文逐词 span 保持白色(没被改成绿)', rows[0].en.events[0].text);
  ok(zhTextOf(rows[0]) === '{\\c&H00FF00&}[garlicsizzler] 兄弟 求你了', '中文行首色标改成新色', zhTextOf(rows[0]));
  ok(rows[1].en.events[0].text === '{\\c&HFFFFFF&}What{\\c} ?', '别人家的英文 span 也没动');
}

console.log('\n== 名字大小写 / 别名 ==');
{
  const rows = [mkRow('GarlicSizzler', '{\\c&HFFFFFF&}[GarlicSizzler] 甲'), mkRow('Minute', '{\\c&HFFFFFF&}[Minute] 乙')];
  const doc = fakeDoc();
  const n = K.recolorRoleInRows(doc, rows, ['garlicsizzler'], '#123456');
  ok(n === 1, '大小写不敏感命中 1 行', 'n=' + n);
  ok(zhTextOf(rows[1]) === '{\\c&HFFFFFF&}[Minute] 乙', 'Minute 不受影响');
}

console.log('\n== 逐词高亮色不再是写死的绿 ==');
{
  ok(K.getWordHighlightColor() === '#00ff00', '默认是绿', K.getWordHighlightColor());
  ok(K.wordHighlightTag() === '{\\c&H00FF00&}', '默认 tag 是绿', K.wordHighlightTag());
  ok(K.setWordHighlightColor('#ffffff') === true, '设为白色成功');
  ok(K.getWordHighlightColor() === '#ffffff', '记住白色', K.getWordHighlightColor());
  ok(K.wordHighlightTag() === '{\\c&HFFFFFF&}', 'tag 跟着变白', K.wordHighlightTag());
  ok(K.setWordHighlightColor('#ff8800') === true, '设为橙红成功');
  ok(K.wordHighlightTag() === '{\\c&H0088FF&}', '#ff8800 → BGR 0088FF', K.wordHighlightTag());
  ok(K.setWordHighlightColor('not-a-color') === false, '非法值被拒');
  ok(K.getWordHighlightColor() === '#ff8800', '非法值不改动上一次的色', K.getWordHighlightColor());

  // 默认高亮色要落到新句子的 highlightTag 上(makeSentence 的默认值)
  K.setWordHighlightColor('#ffffff');
  const doc = new AssDoc([
    '[Script Info]', 'ScriptType: v4.00+', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,40,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,120,1', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hello world',
  ].join('\n'));
  const ev = doc.sorted[0];
  const sent = K.sentenceFromEvent('Default', ev, doc.format, 1, 2, 'hello world');
  ok(sent.highlightTag === '{\\c&HFFFFFF&}', '新句子默认用当前高亮色(白), 不再是写死的绿', sent.highlightTag);
  K.setWordHighlightColor('#00ff00');   // 复位, 免得影响其它测试
}

console.log('\n== 真实稿件: 改 garlicsizzler 不会碰到 Minute ==');
{
  const ASS = path.resolve(HERE, '..', '实例.ass');
  if (!fs.existsSync(ASS)) {
    console.log('  (跳过: 找不到 ' + ASS + ')');
  } else {
    const doc = new AssDoc(fs.readFileSync(ASS, 'utf8'));
    const kar = K.analyzeKaraoke(doc);
    const rows = K.pairRows(kar.sentences, kar.wordStyle);
    const lead = /^\s*\{[^}]*?\\c&H([0-9A-Fa-f]{6})&/;
    const before = new Map();
    for (const ev of doc.events) { const m = lead.exec(ev.text || ''); before.set(ev, m ? m[1].toUpperCase() : null); }

    const minuteZhBefore = rows.filter(r => (r.speaker || '').includes('Minute') && r.zh)
      .map(r => r.zh.events.map(e => e.text));
    const gsZhRows = rows.filter(r => (r.speaker || '').includes('garlicsizzler') && r.zh);

    const n = K.recolorRoleInRows(doc, rows, ['garlicsizzler'], '#ff0000');

    ok(gsZhRows.length >= 6, 'garlicsizzler 有若干中文行', 'n=' + gsZhRows.length);
    ok(gsZhRows.every(r => /^\s*\{\\c&H0000FF&\}/.test(r.zh.events[0].text)), 'garlicsizzler 每条中文行都换成了新色(含原本没色标的)');
    ok(gsZhRows.every(r => r.zh.color === '#ff0000'), 'garlicsizzler 的 row.color 全部同步');

    // Minute 的行必须逐字不变
    const minuteRows = rows.filter(r => (r.speaker || '').includes('Minute') && r.zh);
    const minuteZhAfter = minuteRows.map(r => r.zh.events.map(e => e.text));
    ok(JSON.stringify(minuteZhAfter) === JSON.stringify(minuteZhBefore), 'Minute 的中文行一字未改');

    // 逐词 span(英文行行首)一律不变
    let spanChanged = 0;
    for (const ev of doc.events) {
      const was = before.get(ev);
      if (was == null) continue;
      if (ev.style === 'Default') {   // 英文行: 行首色标是逐词高亮 span, 必须原样
        const now = (lead.exec(ev.text || '') || [])[1];
        if (now && now.toUpperCase() !== was) spanChanged++;
      }
    }
    ok(spanChanged === 0, '英文逐词 span 一个都没被改', 'changed=' + spanChanged);
    ok(n < 60, '改动规模是"一个角色"级别(不是全片上千条)', 'n=' + n);
  }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
