// 生成规范夹具: 8 行双语(中文整句 + 英文逐词切片), 用 buildWordSpecs 保证格式正确
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 自举: 同步 editor/js → jsmod (见 karaoke-exhaustive.mjs)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSMOD = path.join(HERE, 'jsmod'), SRC = path.resolve(HERE, '..', 'editor', 'js');
fs.rmSync(JSMOD, { recursive: true, force: true });
fs.mkdirSync(JSMOD, { recursive: true });
for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
fs.writeFileSync(path.join(JSMOD, 'package.json'), '{"type":"module"}\n');

const { AssDoc, assPlainText } = await import('./jsmod/ass.js');
const { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs } = await import('./jsmod/karaoke.js');

const doc = new AssDoc(`[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Comic Sans MS,65,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,3,2,20,20,120,1
Style: 中文字幕,Comic Sans MS,65,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3.0,2,2,10,10,125,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.10,0:00:00.20,Default,,0,0,0,,seed
Dialogue: 0,0:00:00.10,0:00:00.20,中文字幕,,0,0,0,,种子
`);

function fmt(t) {
  let cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000); cs -= h * 360000;
  const m = Math.floor(cs / 6000); cs -= m * 6000;
  const s = Math.floor(cs / 100); cs -= s * 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function appendRow(zhText, enText, start, end) {
  for (const [style, text] of [['中文字幕', zhText], ['Default', enText]]) {
    const evs = doc.sorted.filter(e => e.style === style);
    const ev = doc.insertAfterEvent(evs[evs.length - 1]);
    doc.setEventTime(ev, start, end);
    doc.setEventText(ev, text);
    if (style === 'Default') {
      const tokens = enText.split(/\s+/);
      const span = (end - start) / tokens.length;
      const words = tokens.map((w, i) => ({ w, s: start + span * i, e: start + span * (i + 1) }));
      const sent = { style, start, end, text: enText, events: [ev], words, proto: { layer: '0', name: '', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } }, highlightTag: '{\\c&H00FF00&}' };
      doc.replaceEvents([ev], buildWordSpecs(sent));
    }
  }
}
for (let i = 0; i < 8; i++) {
  const s = 10 + i * 12;
  appendRow(`第${i + 1}句中文内容测试`, `row${i + 1} alpha beta gamma`, s, s + 5);
}
fs.writeFileSync('fixture.ass', doc.serialize());
console.log('夹具已生成');
