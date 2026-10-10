// 回归测试: 「同一句中文字幕渲染两遍」bug(2026-09-30 用户实测文件 subtitle_edited.ass)。
// 病灶链: 中文字幕句被切成逐词切片(旧脏数据) → 一次中文整句编辑 applyAnchorSentence 只改
// events[0], 把 1 号切片原地改写回整句(还继承切片的绿色标签) → 词 2..n 切片成无主事件
// 继续上屏(同一句中文两遍), 重载后各自成行挤在主行后面。
// 修复(main.js): applyAnchorSentence 写入端折叠(且不继承逐词绿标) / applyWordSentence
// 样式守卫 / refreshDynamicSubtitles 样式守卫 / setAss 载入自愈(ghostZhRows + 剥绿标)。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');
// 自举: jsmod 过期则从 editor/js 重建(与 karaoke-exhaustive.mjs 同一套)
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  /* 镜像同步: 只补齐/更新本族自己的文件, **绝不清空目录** —— jsmod 是两族共用镜像
   * (上游族源 editor/js, fork 族源 editor/), 旧实现 rmSync 清空会顺手删掉另一族的文件,
   * 于是"哪个测试先跑"决定别的测试能不能过(2026-10-10 修复)。内容比对保证镜像恒等于源。 */
  fs.mkdirSync(JSMOD, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
  }
  fs.writeFileSync(marker, '{"type":"module"}\n');
}
ensureJsmod();
const imp = (name) => import(new URL('file:///' + path.join(JSMOD, name).replace(/\\/g, '/')));
const { AssDoc, assPlainText } = await imp('ass.js');
const { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs, ghostZhRows, HIGHLIGHT_COLORS, assColorToHex } = await imp('karaoke.js');

let failures = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { failures++; console.log(`  ✗ ${label}${detail ? ' —— ' + detail : ''}`); }
}

/* ── main.js 操作复刻(与 tests/karaoke-exhaustive.mjs 同约定, 使用**修补后**的逻辑) ── */
function analyze(doc) {
  const kar = analyzeKaraoke(doc);
  kar.rows = pairRows(kar.sentences, kar.wordStyle);
  return kar;
}
function makeT(text) { const doc = new AssDoc(text); return { doc, kar: analyze(doc), state: { newRows: new Set(), format: 'ass' } }; }
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
// 修补后的 applyAnchorSentence(与 main.js 同步): 整句折叠守卫 + 不继承逐词绿标
function applyAnchorSentence(T, sent, s, e, text) {
  if ((sent.words && sent.words.length) || sent.events.length > 1) {
    const keep = sent.events[0];
    let keepText = keep.text || '';
    const mLead = /^\s*(\{\\c&H([0-9A-Fa-f]{6})&\})/.exec(keepText);
    if (mLead && HIGHLIGHT_COLORS.has(assColorToHex(mLead[2].toUpperCase()))) keepText = keepText.slice(mLead[1].length);
    const p = sent.proto || { layer: keep.layer, name: keep.name, effect: keep.effect, margins: keep.margins };
    sent.events = T.doc.replaceEvents(sent.events, [{
      layer: p.layer, style: sent.style, name: p.name,
      effect: p.effect, margins: p.margins, start: s, end: e, text: keepText
    }]);
    sent.words = [];
  }
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
// 修补后的 applyWordSentence(与 main.js 同步): 非逐词样式一律折叠为整句
function applyWordSentence(T, sent, s, e, text) {
  if (!T.kar || !T.kar.wordStyle || sent.style !== T.kar.wordStyle) {
    applyAnchorSentence(T, sent, s, e, text);
    return;
  }
  sent.words = recalcWords(sent, text, s, e);
  sent.text = text; sent.start = s; sent.end = e;
  sent.events = T.doc.replaceEvents(sent.events, buildWordSpecs(sent));
}
const escAss = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
const zhEvents = (doc, style) => doc.sorted.filter(e => e.style === style);
const HL = /\{\\c&H[0-9A-Fa-f]{6}&\}[^{}]+\{\\c\}/;
// 载入自愈复刻(与 main.js setAss 同步): 删幽灵行 + 剥双语行中文行首绿标
function heal(T) {
  const ghosts = ghostZhRows(T.kar.rows);
  for (const g of ghosts) {
    T.doc.deleteEvents(g.zh.events);
    const si = T.kar.sentences.indexOf(g.zh);
    if (si !== -1) T.kar.sentences.splice(si, 1);
    const ri = T.kar.rows.indexOf(g);
    if (ri !== -1) T.kar.rows.splice(ri, 1);
  }
  T.kar.rows.forEach((r, i) => r.no = i + 1);
  let leadFixed = 0;
  for (const r of T.kar.rows) {
    if (!r.zh || !r.en || !r.zh.events || !r.zh.events.length) continue;
    const ev = r.zh.events[0];
    const m = /^\s*(\{\\c&H([0-9A-Fa-f]{6})&\})/.exec(ev.text || '');
    if (m && HIGHLIGHT_COLORS.has(assColorToHex(m[2].toUpperCase()))) {
      T.doc.setEventText(ev, (ev.text || '').slice(m[1].length));
      leadFixed++;
    }
  }
  return { ghosts: ghosts.length, leadFixed };
}

/* ── 最小双语底稿: 中文字幕(整句) + Default(逐词, ≥6 高亮事件才触发 wordStyle 判定) ── */
const ZH = '中文字幕';
function baseAss() {
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Outline, Shadow, Bold, MarginL, MarginR, MarginV, Alignment',
    'Style: 中文字幕,Arial,60,&H00FFFFFF,3,0,0,80,80,60,2',
    'Style: Default,Arial,60,&H00FFFFFF,3,0,0,80,80,20,2', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  // 两行干净双语(每行英文 3 词 → 共 6 条高亮切片, 过 wordStyle 门槛)
  const rows = [
    ['0:00:01.00', '0:00:04.00', '你好世界', 'hello big world'],
    ['0:00:05.00', '0:00:08.00', '再见世界', 'good bye now']
  ];
  for (const [s, e, zh, en] of rows) {
    lines.push(`Dialogue: 0,${s},${e},${ZH},,0,0,0,,${zh}`);
    const toks = en.split(' ');
    for (let i = 0; i < toks.length; i++) {
      const marked = toks.map((w, j) => j === i ? `{\\c&H00FF00&}${w}{\\c}` : w).join(' ');
      lines.push(`Dialogue: 0,${s},${e},${'Default'},,0,0,0,,${marked}`);
    }
  }
  return lines.join('\n') + '\n';
}

const zhText = '[SPK1] 但在我们开始之前 你需要明白Unstable SMP是一个有剧本的minecraft系列 有四个主要角色';
const S = 24.77, E = 31.93;

console.log('■ T1 写入端: applyWordSentence(中文)→applyAnchorSentence(中文) 不再留孤儿切片/绿标');
{
  const T = makeT(baseAss());
  const zh = appendSentence(T, ZH, S, E, escAss(zhText));
  // 模拟历史脏数据: 中文句被切片(旧路径)
  zh.words = recalcWords(zh, zhText, S, E);
  zh.events = T.doc.replaceEvents(zh.events, buildWordSpecs(zh));
  ok(zh.events.length === 5, '前置: 中文句被切成 5 条切片', `实际 ${zh.events.length}`);
  applyAnchorSentence(T, zh, S, E, zhText);            // ← 修补后的折叠守卫生效
  const doc2 = new AssDoc(T.doc.serialize());
  const evs = zhEvents(doc2, ZH).filter(e => e.start >= S - 0.05 && e.start <= S + 0.05);
  ok(zh.events.length === 1, '折叠后句 events 回到 1', `实际 ${zh.events.length}`);
  ok(!zh.words || zh.words.length === 0, '折叠后 words 清空');
  ok(evs.length === 1, '序列化后该区间中文事件只有 1 条(不再两遍)', `实际 ${evs.length}`);
  ok(evs.length === 1 && !HL.test(evs[0].text), '中文事件不带高亮切片');
  ok(evs.length === 1 && evs[0].text === zhText, '正文为整句、不继承逐词绿标(不发绿)', JSON.stringify((evs[0] || {}).text || '').slice(0, 60));
}

console.log('■ T2 样式守卫: applyWordSentence 对中文句直接折叠, 不产生切片');
{
  const T = makeT(baseAss());
  const zh = appendSentence(T, ZH, S, E, escAss('旧文本'));
  applyWordSentence(T, zh, S, E, zhText);              // 守卫: 按 applyAnchorSentence 处理
  ok(zh.events.length === 1 && (!zh.words || !zh.words.length), '句保持单事件无词级时间');
  const evs = zhEvents(new AssDoc(T.doc.serialize()), ZH).filter(e => e.start >= S - 0.05 && e.start <= S + 0.05);
  ok(evs.length === 1 && !HL.test(evs[0].text || ''), '文档里只有 1 条干净的中文事件');
  ok(assPlainText(zh.events[0].text) === zhText, '文本正确落盘');
  const en = T.kar.sentences.find(s => s.style === 'Default' && s.text.includes('hello'));
  applyWordSentence(T, en, 1, 4, 'hello big world again');   // 英文(逐词样式)不受守卫影响
  ok(en.words.length === 4 && en.events.length === 4, '逐词样式正常切片(4 词 4 切片)', `实际 words=${en.words.length} events=${en.events.length}`);
}

console.log('■ T3 ghostZhRows: 合成正例 + 误删防护反例');
{
  // 构造损坏态: 主行(zh+en) + 3 条中文切片幽灵行(带高亮、时间被主行包住、文本相同)
  const T = makeT(baseAss());
  const zh = appendSentence(T, ZH, S, E, escAss(zhText));
  const en = appendSentence(T, 'Default', S, E, escAss('but before we begin now'));
  en.words = recalcWords(en, en.text, S, E);
  en.events = T.doc.replaceEvents(en.events, buildWordSpecs(en));
  for (let i = 0; i < 3; i++) {
    const g0 = S + (E - S) * ((i + 1) / 4), g1 = S + (E - S) * ((i + 2) / 4);
    const ev = T.doc.insertAfterEvent(zh.events[zh.events.length - 1]);
    T.doc.setEventTime(ev, g0, g1);
    const plain = zhText.split(' ');
    const marked = plain.map((w, j) => j === i + 1 ? `{\\c&H00FF00&}${w}{\\c}` : w).join(' ');
    T.doc.setEventText(ev, marked);
  }
  T.kar = analyze(T.doc);                              // 重新分析配对(模拟重载)
  const found = ghostZhRows(T.kar.rows);
  ok(found.length === 3, '识别出 3 条幽灵行', `实际 ${found.length}`);
  ok(found.every(g => g.zh && !g.en && g.zh.events.length === 1 && HL.test(g.zh.events[0].text)), '幽灵行均为 zh-only 单事件带高亮');
  // 反例①: 干净的 zh-only 行(无高亮) —— 双语轨合法形态, 绝不能误删
  const T2 = makeT(baseAss());
  appendSentence(T2, ZH, 10, 12, escAss('纯中文独立行'));
  T2.kar = analyze(T2.doc);
  ok(ghostZhRows(T2.kar.rows).length === 0, '干净 zh-only 行不误报');
  // 反例②: 带高亮但时间不被任何双语主行包含(独立区间) → 不误报
  const T3 = makeT(baseAss());
  appendSentence(T3, ZH, 50, 52, '{\\c&H00FF00&}孤立高亮文本');   // 原始标签(不转义)才是真高亮行
  T3.kar = analyze(T3.doc);
  ok(ghostZhRows(T3.kar.rows).length === 0, '时间不落在双语主行内的带高亮行不误报');
  // 反例③: 文本与主行无关的带高亮 zh-only 行 → 不误报(从严判定④)
  const T4 = makeT(baseAss());
  const zh4 = T4.kar.sentences.find(s => s.style === ZH && s.text.includes('你好'));
  const ev4 = T4.doc.insertAfterEvent(zh4.events[0]);
  T4.doc.setEventTime(ev4, 1.5, 3.5);
  T4.doc.setEventText(ev4, '{\\c&H00FF00&}完全不同的另一些文字内容{\c}');
  T4.kar = analyze(T4.doc);
  ok(ghostZhRows(T4.kar.rows).length === 0, '文本与宿主行无关的带高亮行不误报');
}

console.log('■ T4 端到端: 真实损坏文件(subtitle_edited.ass)重载 → 自愈后干净且往返稳定');
{
  const BAD = 'C:/Users/Account/Downloads/subtitle_edited.ass';
  if (!fs.existsSync(BAD)) { console.log('  (跳过: 找不到实测文件)'); }
  else {
    const T = makeT(fs.readFileSync(BAD, 'utf8'));
    ok(T.kar.wordStyle === 'Default', 'wordStyle 判定为 Default');
    const pre = ghostZhRows(T.kar.rows);
    ok(pre.length === 4, '识别出 4 条中文切片幽灵行(词 2..5)', `实际 ${pre.length}`);
    ok(pre.every(g => g.zh.start >= S - 0.1 && g.zh.end <= E + 0.1), '幽灵行都落在 24.77–31.93 主行区间内');
    const { ghosts, leadFixed } = heal(T);
    ok(ghosts === 4 && leadFixed === 1, '自愈: 清走 4 条幽灵行 + 剥掉 1 处行首绿标(10478 锚点)', `实际 ghosts=${ghosts} leadFixed=${leadFixed}`);
    const kar2 = analyze(new AssDoc(T.doc.serialize()));
    ok(kar2.rows.length === T.kar.rows.length, '清走后重载行数一致(往返稳定)', `${kar2.rows.length} vs ${T.kar.rows.length}`);
    ok(ghostZhRows(kar2.rows).length === 0, '再无幽灵行');
    // 问题区间: 中文字幕样式只剩 1 条事件、无高亮无绿标; 英文 18 词切片完整保留
    const doc2 = new AssDoc(T.doc.serialize());
    const zhEvs = zhEvents(doc2, ZH).filter(e => e.start >= S - 0.05 && e.start <= S + 0.05);
    ok(zhEvs.length === 1 && !HL.test(zhEvs[0].text) && !/^\s*\{\\c&H00FF00&\}/.test(zhEvs[0].text), '问题区间中文只剩 1 条干净整句', `实际 ${zhEvs.length}`);
    const row7 = kar2.rows.find(r => r.zh && r.zh.start >= S - 0.05 && r.zh.start <= S + 0.05 && r.en);
    ok(row7 && row7.en.words.length === 18, '主行英文 18 词切片完好', row7 ? `实际 ${row7.en.words.length}` : '行丢失');
    ok(!zhEvents(doc2, ZH).some(e => HL.test(e.text || '')), '全文件中文字幕样式不再含高亮切片');
  }
}

console.log(failures ? `\n✗ ${failures}/${checks} 项失败` : `\n✓ 全部 ${checks} 项通过`);
process.exit(failures ? 1 : 0);
