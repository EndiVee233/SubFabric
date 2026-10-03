// 复现「同一条中文字幕渲染两遍」bug 的探针。
// 磁盘证据(subtitle_edited.ass 24.77–31.93):
//   · 1 条中文锚点行, 文本带绿色高亮标签前缀 {\c&H00FF00&} —— 说明它曾是 1 号词切片
//   · 4 条中文逐词切片(词 2..5, 均匀铺满), 词 1 切片缺失
//   · 18 条英文切片(均匀铺满), 无英文整句
// 步骤:
//   P1 加载问题文件 → analyze + pairRows → 打印该区域内存模型(重载后 UI 会看到什么)
//   P2 回放候选操作序列: 对中文句 applyWordSentence(切片) → 再 applyAnchorSentence(改回整句)
//      序列化后与磁盘原始事件逐字段对照
//   P3 复刻 refreshDynamicSubtitles 核心循环, 验证「中文句子带 words」时它会不会重建中文切片
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.resolve(HERE, '..', 'tests', 'jsmod');

/* 与 tests/karaoke-exhaustive.mjs 相同的自举: jsmod 过期则重建 */
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

const { AssDoc, assPlainText } = await import(pathToFileURL(path.join(JSMOD, 'ass.js')));
const K = await import(pathToFileURL(path.join(JSMOD, 'karaoke.js')));
const { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs, splitEnglishWords } = K;

const BAD = 'C:/Users/Account/Downloads/subtitle_edited.ass';
const A = 24.77, B = 31.93;
const inWin = (t) => t >= A - 0.05 && t <= B + 0.05;

function analyze(doc) {
  const kar = analyzeKaraoke(doc);
  kar.rows = pairRows(kar.sentences, kar.wordStyle);
  return kar;
}
const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };

/* ───────── P1: 磁盘 → 内存模型 ───────── */
console.log('════════ P1 加载问题文件后的内存模型 ════════');
{
  const doc = new AssDoc(fs.readFileSync(BAD, 'utf8'));
  const kar = analyze(doc);
  console.log(`wordStyle=${JSON.stringify(kar.wordStyle)} sentences=${kar.sentences.length} rows=${kar.rows.length}`);
  const rows = kar.rows.filter(r => r.end > A - 0.1 && r.start < B + 0.1);
  for (const r of rows) {
    const zh = r.zh, en = r.en;
    console.log(`\n行#${r.no} ${fmt(r.start)}–${fmt(r.end)}`);
    if (zh) console.log(`  zh[${zh.style}] ${fmt(zh.start)}–${fmt(zh.end)} events=${zh.events.length} words=${(zh.words || []).length} text=${JSON.stringify(assPlainText(zh.events[0].text).slice(0, 42))}`);
    else console.log('  zh=null');
    if (en) {
      const ws = en.words || [];
      const durs = ws.map(w => +(w.e - w.s).toFixed(3));
      console.log(`  en[${en.style}] ${fmt(en.start)}–${fmt(en.end)} events=${en.events.length} words=${ws.length} 词时长=${JSON.stringify([...new Set(durs)])} text=${JSON.stringify(en.text.slice(0, 42))}`);
    } else console.log('  en=null');
  }
  // 原始事件窗口(与内存对照)
  console.log('\n── 磁盘原始事件(该窗口) ──');
  for (const ev of doc.sorted) {
    if (inWin(ev.start) && ev.style !== 'Default')
      console.log(`  [${ev.style}] ${fmt(ev.start)}–${fmt(ev.end)} ${JSON.stringify(ev.text.slice(0, 60))}`);
  }
  const defN = doc.sorted.filter(ev => ev.style === 'Default' && inWin(ev.start)).length;
  console.log(`  [Default] 窗口内 ${defN} 条(略)`);
}

/* ───────── main.js 操作复刻(与 harness 相同) ───────── */
function makeT(doc) { const kar = analyze(doc); return { doc, kar, state: { newRows: new Set(), format: 'ass' } }; }
function appendSentence(T, style, start, end, text) {
  const evs = T.doc.sorted.filter(e => e.style === style);
  if (!evs.length) return null;
  const ev = T.doc.insertAfterEvent(evs[evs.length - 1]);
  T.doc.setEventTime(ev, start, end);
  T.doc.setEventText(ev, text);
  const sent = { style, start, end, text, events: [ev], words: [], proto: { layer: '0', name: ev.name, effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } }, highlightTag: '{\\c&H00FF00&}' };
  T.kar.sentences.push(sent);
  return sent;
}
function applyAnchorSentence(T, sent, s, e, text) {
  const ev = sent.events[0];
  let newText = text;
  if (!/^\s*\{/.test(newText)) {
    const m = /^\s*(\{\\[^}]*\})/.exec(ev.text);
    if (m) newText = m[1] + newText;
  }
  T.doc.setEventTime(ev, s, e);
  T.doc.setEventText(ev, newText);
  sent.start = s; sent.end = e; sent.text = assPlainText(newText);
}
function applyWordSentence(T, sent, s, e, text, realWords) {
  if (realWords) sent.words = realWords;
  else sent.words = recalcWords(sent, text, s, e);
  sent.text = text; sent.start = s; sent.end = e;
  sent.events = T.doc.replaceEvents(sent.events, buildWordSpecs(sent));
}
const escAss = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
function dumpEvents(T, label) {
  console.log(`\n── ${label}: 窗口内序列化事件 ──`);
  const text = T.doc.serialize();
  const doc2 = new AssDoc(text);
  for (const ev of doc2.sorted) {
    if (inWin(ev.start) && ev.style !== 'Default')
      console.log(`  [${ev.style}] ${fmt(ev.start)}–${fmt(ev.end)} ${JSON.stringify(ev.text.slice(0, 60))}`);
  }
  const defN = doc2.sorted.filter(ev => ev.style === 'Default' && inWin(ev.start)).length;
  console.log(`  [Default] 窗口内 ${defN} 条(略)`);
}

/* ───────── P2: 回放候选序列 ───────── */
console.log('\n════════ P2 回放: applyWordSentence(中文) → applyAnchorSentence(中文) ════════');
{
  const doc = new AssDoc(fs.readFileSync(BAD, 'utf8'));
  const T = makeT(doc);
  const zhStyle = (T.kar.sentences.find(s => s.style !== T.kar.wordStyle) || {}).style;
  const enStyle = T.kar.wordStyle;
  const zhText = '[SPK1] 但在我们开始之前 你需要明白Unstable SMP是一个有剧本的minecraft系列 有四个主要角色';
  const enText = "But before we get started you need to understand that Unstable SMP is a scripted minecraft series there are four main characters";
  const zh = appendSentence(T, zhStyle, A, B, escAss(zhText));
  const en = appendSentence(T, enStyle, A, B, escAss(enText));
  // 操作①: 某条路径对中文句跑了逐词切片(当前嫌疑: 带旧 words 的句被 refresh 重建)
  applyWordSentence(T, zh, A, B, zhText);
  console.log(`切片后: zh.events=${zh.events.length} words=${zh.words.length}`);
  // 操作②: 用户随后又编辑了中文文本 → applyAnchorSentence
  applyAnchorSentence(T, zh, A, B, zhText);
  console.log(`改回整句后: zh.events=${zh.events.length} words=${zh.words.length} events[0].text=${JSON.stringify(zh.events[0].text.slice(0, 50))}`);
  // 英文正常路径: 无真实词时间 → 均匀铺满
  applyWordSentence(T, en, A, B, enText);
  console.log(`英文切片: events=${en.events.length} 词时长=${JSON.stringify([...new Set(en.words.map(w => +(w.e - w.s).toFixed(3)))])}`);
  dumpEvents(T, '回放结果');
}

/* ───────── P3: refreshDynamicSubtitles 对「中文句带 words」的行为 ───────── */
console.log('\n════════ P3 refreshDynamicSubtitles 复刻: 中文句带 words 会怎样 ════════');
{
  const doc = new AssDoc(fs.readFileSync(BAD, 'utf8'));
  const T = makeT(doc);
  const zhStyle = (T.kar.sentences.find(s => s.style !== T.kar.wordStyle) || {}).style;
  const zhText = '[SPK1] 测试句子';
  const zh = appendSentence(T, zhStyle, 100, 103, escAss(zhText));
  // 模拟旧数据/旧版本留下的 zh.words(5 个 token, 均匀铺满)
  zh.words = recalcWords(zh, zhText, 100, 103);
  console.log(`构造: zh.style=${zh.style} words=${zh.words.length} tokens=${splitEnglishWords(zh.text).length}`);
  // 复刻 refreshDynamicSubtitles 核心循环(仅条件部分)
  const near = (a, b) => Math.abs(a - b) < 5e-4;
  const live = (arr) => arr.filter(x => x.end - x.start > 0.004);
  let words = 0, anchors = 0;
  for (const sent of T.kar.sentences) {
    if (!sent.events || !sent.events.length) continue;
    if (sent.words && sent.words.length) {
      const txtWords = splitEnglishWords(sent.text || '').length;
      if (sent.words.length !== txtWords) continue;
      const specs = live(buildWordSpecs(sent));
      const evs = live(sent.events);
      const drifted = specs.length !== evs.length || specs.some((sp, i) => {
        const ev = evs[i];
        return !ev || !near(sp.start, ev.start) || !near(sp.end, ev.end)
          || assPlainText(sp.text) !== assPlainText(ev.text);
      });
      if (!drifted) continue;
      sent.events = T.doc.replaceEvents(sent.events, buildWordSpecs(sent));
      words++;
    } else {
      const ev = sent.events[0];
      if (assPlainText(ev.text) === (sent.text || '') && near(ev.start, sent.start) && near(ev.end, sent.end)) continue;
      applyAnchorSentence(T, sent, sent.start, sent.end, sent.text || '');
      anchors++;
    }
  }
  console.log(`刷新结果: words=${words} anchors=${anchors}`);
  const doc2 = new AssDoc(T.doc.serialize());
  const zhSlices = doc2.sorted.filter(ev => ev.style === zhStyle && /\{\\c&H00FF00&\}/i.test(ev.text) && ev.start >= 99.9 && ev.start <= 100.1);
  console.log(`中文样式在 100s 处的高亮切片数: ${zhSlices.length}`);
  for (const ev of zhSlices) console.log(`  ${fmt(ev.start)}–${fmt(ev.end)} ${JSON.stringify(ev.text.slice(0, 60))}`);
}
