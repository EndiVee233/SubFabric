// 逐词处理穷举测试：复现 main.js 对「行/句子/事件」的全部操作序列，
// 每步后校验不变量。跑在真实的 ass.js + karaoke.js 上（无 DOM 依赖）。
//
// 不变量:
//   I1 无孤儿事件   —— doc 里每个事件都被且仅被一个句子引用
//   I2 无悬空句子   —— 每个句子的 events 非空且都真实存在
//   I3 行/句一致    —— rows 的 zh/en 句子都在 kar.sentences 里
//   I4 无空文本事件 —— 序列化结果里没有空文本的 Dialogue
//   I5 往返一致     —— serialize→重新分析→pairRows 的行数/文本与内存中一致
//   I6 切片不重叠   —— 同一句的逐词切片时间互不重叠且单调
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

/* ── 自举: 把 editor/js 拷到 jsmod/ 并加 {"type":"module"} —— 项目无 package.json,
 *    直接 import .js 会被当成 CJS。jsmod 比 editor/js 旧时自动重建, 保证测的是最新代码。 ── */
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

const { AssDoc, assPlainText } = await import('./jsmod/ass.js');
const { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs } = await import('./jsmod/karaoke.js');

let failures = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { failures++; console.log(`  ✗ ${label}${detail ? ' —— ' + detail : ''}`); }
}

// ───── 复刻 main.js 的操作 ─────
function analyze(doc) {
  const kar = analyzeKaraoke(doc);
  kar.rows = pairRows(kar.sentences, kar.wordStyle);
  return kar;
}
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
function createRowAt(T, start, end) {
  const zhStyle = (T.kar.sentences.find(s => s.style !== T.kar.wordStyle) || {}).style || '';
  const enStyle = T.kar.wordStyle || '';
  const zh = zhStyle ? appendSentence(T, zhStyle, start, end, '') : null;
  const en = enStyle ? appendSentence(T, enStyle, start, end, '') : null;
  const row = { zh, en, start, end, no: 0, color: null, speaker: '' };
  T.state.newRows.add(row);
  T.kar.rows.push(row);
  T.kar.rows.sort((a, b) => a.start - b.start || a.end - b.end);
  T.kar.sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  deKaraokeOverlaps(T, row);
  return row;
}
function applyAnchorSentence(T, sent, s, e, text) {
  const ev = sent.events[0];
  let newText = text;
  if (!/^\s*\{/.test(newText)) {
    const m = /^\s*(\{\\[^}]*\})/.exec(ev.text);
    if (m) newText = m[1] + newText;
  }
  newText = newText.replace(/\r\n?|\n/g, '\\N');
  T.doc.setEventTime(ev, s, e);
  T.doc.setEventText(ev, newText);
  sent.start = s; sent.end = e; sent.text = assPlainText(newText);
}
function applyWordSentence(T, sent, s, e, text, realWords) {
  if (realWords) sent.words = realWords.map(w => ({ w: w.w, s: w.s, e: w.e }));
  else sent.words = recalcWords(sent, text, s, e);
  sent.text = text; sent.start = s; sent.end = e;
  sent.events = T.doc.replaceEvents(sent.events, buildWordSpecs(sent));
}
function applyAssRow(T, row, s, e, text, realWords) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const zhText = (lines[0] || '').trim();
  const enText = lines.length > 1 ? lines.slice(1).join(' ').trim() : '';
  if (row.zh) applyAnchorSentence(T, row.zh, s, e, zhText || row.zh.text);
  if (row.en) applyWordSentence(T, row.en, s, e, enText || row.en.text, realWords);
  row.start = s; row.end = e;
  deKaraokeOverlaps(T, row);
}
function removeItemData(T, row) {
  for (const sent of [row.zh, row.en]) {
    if (!sent) continue;
    T.doc.deleteEvents(sent.events);
    const i = T.kar.sentences.indexOf(sent);
    if (i !== -1) T.kar.sentences.splice(i, 1);
  }
  const ri = T.kar.rows.indexOf(row);
  if (ri !== -1) T.kar.rows.splice(ri, 1);
  T.state.newRows.delete(row);
}
function deKaraokeRow(T, row) {
  const en = row.en;
  if (!en || !en.words || !en.words.length) return false;
  const zh = row.zh, s = zh ? zh.start : en.start, e = zh ? zh.end : en.end;
  const text = en.text;
  row._karaokeBackup = { words: en.words.map(w => ({ w: w.w, s: w.s, e: w.e })), text };
  en.words = []; en.start = s; en.end = e;
  en.events = T.doc.replaceEvents(en.events, [{
    layer: en.proto.layer, style: en.style, name: en.proto.name,
    effect: en.proto.effect, margins: en.proto.margins, start: s, end: e, text
  }]);
  row.start = Math.min(zh ? zh.start : Infinity, en.start);
  row.end = Math.max(zh ? zh.end : 0, en.end);
  return true;
}
function deKaraokeOverlaps(T, row) {
  let cleared = 0;
  for (const r of T.kar.rows) {
    if (r.end <= row.start + 1e-3 || row.end <= r.start + 1e-3) continue;
    if (deKaraokeRow(T, r)) cleared++;
  }
  return cleared;
}
function recalc(w0, w1, text, s, e) { return recalcWords({ words: w0, start: s, end: e }, text, s, e); }
function computeOverlapRows(T) {
  const rows = T.kar.rows, set = new Set();
  const order = rows.map((r, i) => i).sort((a, b) => rows[a].start - rows[b].start || rows[a].end - rows[b].end);
  let curI = -1, curEnd = -Infinity;
  for (const i of order) {
    const r = rows[i];
    if (curI !== -1 && r.start < curEnd - 1e-3) { set.add(r); set.add(rows[curI]); }
    if (curI === -1 || r.end > curEnd) { curI = i; curEnd = r.end; }
  }
  return set;
}
function reconcileKaraoke(T) {
  let changed = true;
  while (changed) {
    changed = false;
    const overlap = computeOverlapRows(T);
    for (const row of T.kar.rows) {
      if (!row._karaokeBackup) continue;
      if (overlap.has(row)) continue;
      const en = row.en, bk = row._karaokeBackup;
      if (!en || !bk || !bk.words.length) continue;
      en.words = bk.words.map(w => ({ w: w.w, s: w.s, e: w.e }));
      en.words = recalcWords(en, en.text, en.start, en.end);
      en.events = T.doc.replaceEvents(en.events, buildWordSpecs(en));
      if (row.zh) { row.start = Math.min(row.zh.start, en.start); row.end = Math.max(row.zh.end, en.end); }
      delete row._karaokeBackup;
      changed = true;
    }
  }
}

// ───── 不变量校验 ─────
function check(T, label) {
  const doc = T.doc, kar = T.kar;
  // I2/I1
  const seen = new Map();
  for (const sent of kar.sentences) {
    ok(sent.events && sent.events.length > 0, `[${label}] I2 句子 events 为空`, JSON.stringify(sent.text).slice(0, 40));
    for (const ev of (sent.events || [])) {
      ok(doc.events.includes(ev), `[${label}] I2 句子引用了不存在的事件`, JSON.stringify(sent.text).slice(0, 40));
      seen.set(ev, (seen.get(ev) || 0) + 1);
    }
  }
  for (const ev of doc.events) {
    ok(seen.has(ev), `[${label}] I1 孤儿事件(没有任何句子引用)`, JSON.stringify(ev.text).slice(0, 50));
    ok(seen.get(ev) === 1, `[${label}] I1 事件被多个句子引用(${seen.get(ev)})`, JSON.stringify(ev.text).slice(0, 50));
    // 空文本事件只允许出现在"新建未输入"的行上(newRows 非空时是设计行为)
    ok((ev.text || '').trim() !== '' || T.state.newRows.size > 0, `[${label}] I4 空文本事件`, JSON.stringify(ev.text).slice(0, 50));
  }
  // I3
  for (const row of kar.rows) {
    for (const s of [row.zh, row.en]) {
      if (s) ok(kar.sentences.includes(s), `[${label}] I3 行引用了不在 sentences 里的句子`);
    }
  }
  // I6 同句切片不重叠 + I5 往返
  const doc2 = new AssDoc(doc.serialize());
  const kar2 = analyze(doc2);
  ok(kar2.rows.length === kar.rows.length, `[${label}] I5 往返行数不一致`, `${kar2.rows.length} != ${kar.rows.length}`);
  if (kar2.rows.length !== kar.rows.length && !global.__dumped) {
    global.__dumped = true;
    const byStyle = new Map();
    for (const ev of doc.sorted) {
      if (!byStyle.has(ev.style)) byStyle.set(ev.style, { n: 0, hl: 0 });
      const o = byStyle.get(ev.style);
      o.n++; if (/\{\\c&H[0-9A-Fa-f]{6}&\}[^{}]+\{\\c\}/.test(ev.text)) o.hl++;
    }
    console.log(`  [诊断@${label}] 内存行=${kar.rows.length} 往返行=${kar2.rows.length} kar.wordStyle=${kar.wordStyle}`);
    for (const [st, o] of byStyle) console.log(`    样式 ${JSON.stringify(st)}: 事件 ${o.n}, 含高亮 ${o.hl} (${(o.hl / o.n * 100).toFixed(0)}%)`);
    console.log(`    newRows=${T.state.newRows.size} 带备份行=${T.kar.rows.filter(r => r._karaokeBackup).length}`);
  }
  const texts1 = kar.rows.map(r => `${assPlainText(r.zh ? r.zh.events[0].text : '')}|${r.en ? r.en.text : ''}`).sort();
  const texts2 = kar2.rows.map(r => `${assPlainText(r.zh ? r.zh.events[0].text : '')}|${r.en ? r.en.text : ''}`).sort();
  ok(JSON.stringify(texts1) === JSON.stringify(texts2), `[${label}] I5 往返文本不一致`);
  for (const s of kar.sentences) {
    if (!s.words || s.words.length < 2) continue;
    for (let i = 1; i < s.words.length; i++) {
      ok(s.words[i].s >= s.words[i - 1].e - 1e-6, `[${label}] I6 切片重叠/乱序`, `词${i - 1}→${i}`);
    }
  }
}

// ───── 用例 ─────
const ASS = fs.readFileSync(path.join(HERE, 'fixture.ass'), 'utf8');
function freshState() {
  const doc = new AssDoc(ASS);
  const kar = analyze(doc);
  return { doc, kar, state: { newRows: new Set(), format: 'ass' } };
}

function scenario(name, fn) {
  console.log(`\n■ ${name}`);
  const before = failures;
  fn();
  if (failures === before) console.log('  ✓ 全部不变量成立');
}

// S1 新建→输入→删除（最常见路径）
scenario('S1 新建→输入文本→删除', () => {
  const T = freshState();
  const row = createRowAt(T, 20, 23);
  check(T, 'S1a 新建空行');
  applyAssRow(T, row, 20, 23, '测试一下\nthis is a test');
  check(T, 'S1b 输入中英文本');
  applyAssRow(T, row, 20, 23, '改一下文本\nchanged words here too');
  check(T, 'S1c 改文本(词数不同)');
  removeItemData(T, row);
  check(T, 'S1d 删除该行');
});

// S2 新建→不输入→撤销
scenario('S2 新建→不输入→撤销', () => {
  const T = freshState();
  const row = createRowAt(T, 30, 33);
  check(T, 'S2a 新建空行');
  removeItemData(T, row);
  check(T, 'S2b 撤销');
});

// S3 新建→输入→撤销(空着离开前已有内容 → 走正常删除)
scenario('S3 新建→输入→再清空文本→删除', () => {
  const T = freshState();
  const row = createRowAt(T, 40, 43);
  applyAssRow(T, row, 40, 43, '有内容\nhas content');
  applyAssRow(T, row, 40, 43, '\n');       // 用户把文本清空
  check(T, 'S3a 清空文本后');
  removeItemData(T, row);
  check(T, 'S3b 删除');
});

// S4 与现有行重叠(双行字幕轨的合法状态)
scenario('S4 新建与现有行时间重叠(双行轨)', () => {
  const T = freshState();
  const row = createRowAt(T, 0.5, 3.5);    // 与第一行(0~3)重叠
  check(T, 'S4a 重叠新建');
  applyAssRow(T, row, 0.5, 3.5, '重叠文本\noverlapping words');
  check(T, 'S4b 输入');
  removeItemData(T, row);
  check(T, 'S4c 删除');
});

// S5 Shift 重叠去逐词 → 拉开自动还原
scenario('S5 重叠去逐词→拉开还原', () => {
  const T = freshState();
  const rows = T.kar.rows;
  const r0 = rows[0], r1 = rows[1];
  const origStart = r1.start;
  deKaraokeRow(T, r0);                      // 与 r1 重叠 → 去逐词
  check(T, 'S5a 去逐词');
  r1.start = origStart + 10; r1.end += 10;  // 拉开
  if (r1.en) { r1.en.start = r1.start; r1.en.end = r1.end; }
  reconcileKaraoke(T);                      // r0 不再重叠 → 自动还原
  check(T, 'S5b 还原逐词');
  // 还原后删除 r0（还原路径上再删除, 覆盖"备份存在时删除"）
  removeItemData(T, r0);
  check(T, 'S5c 删除已还原的行');
});

// S6 重叠去逐词后直接删除（备份还在时删除）
scenario('S6 去逐词(有备份)→直接删除', () => {
  const T = freshState();
  const rows = T.kar.rows;
  deKaraokeRow(T, rows[0]);
  check(T, 'S6a 去逐词');
  removeItemData(T, rows[0]);
  check(T, 'S6b 删除');
});

// S7 逐词重计时（拖词起点, 共享边界）
scenario('S7 逐词重计时(共享边界)', () => {
  const T = freshState();
  const r0 = T.kar.rows[0];
  const words = r0.en.words;
  if (words && words.length >= 2) {
    // 拖第 2 词的起点到第 1 词中点之后
    const idx = 1, mid = (words[0].s + words[0].e) / 2 + 0.01;
    words[idx - 1].e = Math.max(words[idx - 1].s + 0.02, mid);
    words[idx].s = mid;
    r0.en.events = T.doc.replaceEvents(r0.en.events, buildWordSpecs(r0.en));
    check(T, 'S7a 重计时');
  }
  removeItemData(T, r0);
  check(T, 'S7b 删除');
});

// S8 连续新建多行再批量删除（含交错输入）
scenario('S8 连续新建3行→交错输入→批量删除', () => {
  const T = freshState();
  const rs = [createRowAt(T, 50, 53), createRowAt(T, 54, 57), createRowAt(T, 58, 61)];
  check(T, 'S8a 新建3行');
  applyAssRow(T, rs[1], 54, 57, '第二行\nsecond row words');
  check(T, 'S8b 输入中间行');
  applyAssRow(T, rs[0], 50, 53, '第一行\nfirst row words');
  applyAssRow(T, rs[2], 58, 61, '第三行\nthird row words');
  check(T, 'S8c 输入其余行');
  for (const r of rs) removeItemData(T, r);
  check(T, 'S8d 全部删除');
});

// S9 新建行时间与现有行完全相同
scenario('S9 新建行与现有行起止完全相同', () => {
  const T = freshState();
  const r0 = T.kar.rows[0];
  const row = createRowAt(T, r0.start, r0.end);
  applyAssRow(T, row, r0.start, r0.end, '同时间\nsame time words');
  check(T, 'S9a 完全重叠');
  removeItemData(T, row);
  check(T, 'S9b 删除');
});

// S10 超短行(0.05s)与超长行
scenario('S10 极短行(0.05s)与超长行(60s)', () => {
  const T = freshState();
  const a = createRowAt(T, 100, 100.05);
  applyAssRow(T, a, 100, 100.05, '短\nshort');
  check(T, 'S10a 极短行');
  const b = createRowAt(T, 101, 161);
  applyAssRow(T, b, 101, 161, '长\nlong text with many words spread over a minute of time');
  check(T, 'S10b 超长行');
  removeItemData(T, a); removeItemData(T, b);
  check(T, 'S10c 删除');
});

// S11 只有英文行（无中文锚点）时新建
scenario('S11 删除中文行后新建(单英文)', () => {
  const T = freshState();
  const rows = T.kar.rows;
  removeItemData(T, rows[0]);            // 删掉第一行(含中文锚点)
  check(T, 'S11a 删除含锚点的行');
  const row = createRowAt(T, 70, 73);
  check(T, 'S11b 新建');
  applyAssRow(T, row, 70, 73, '\nonly english words here');
  check(T, 'S11c 输入纯英文');
  removeItemData(T, row);
  check(T, 'S11d 删除');
});

// S12 文本含 ASS 特殊字符
scenario('S12 文本含大括号/反斜杠/逗号', () => {
  const T = freshState();
  const row = createRowAt(T, 200, 203);
  applyAssRow(T, row, 200, 203, '带{括号}和\\反斜杠,逗号\nwith {brace} \\slash, comma and words');
  check(T, 'S12a 特殊字符');
  removeItemData(T, row);
  check(T, 'S12b 删除');
});

// S13 随机压力: 200 次随机操作(新建/输入/删除/重计时/去逐词/还原/改时间), 每步校验
scenario('S13 随机压力 200 步', () => {
  const T = freshState();
  let seed = 20260925;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const words0 = () => {
    const r = T.kar.rows.filter(r => r.en && r.en.words && r.en.words.length);
    return r.length ? r[(rnd() * r.length) | 0] : null;
  };
  for (let step = 0; step < 200; step++) {
    const op = rnd();
    const label = `S13#${step}`;
    if (op < 0.14) {                                   // 新建(贴近真实: 建完多半立刻输入)
      const a = +(rnd() * 120).toFixed(2), b = +(a + 0.5 + rnd() * 4).toFixed(2);
      const row = createRowAt(T, a, b);
      if (rnd() < 0.8) {
        const enPool = ['some words here', 'another line of text', 'one', 'a b c d e f'];
        applyAssRow(T, row, a, b, `文本${step}\n${enPool[(rnd() * enPool.length) | 0]}`);
      }
    } else if (op < 0.45) {                            // 输入/改文本
      const row = T.kar.rows[(rnd() * T.kar.rows.length) | 0];
      if (row && row.start != null) {
        const s = row.start, e = row.end;
        const enPool = ['some words here', 'another line of text', 'one', 'a b c d e f'];
        const en = enPool[(rnd() * enPool.length) | 0];
        applyAssRow(T, row, s, e, `文本${step}\n${en}`);
      }
    } else if (op < 0.60) {                            // 改时间(可能造成重叠)
      const row = T.kar.rows[(rnd() * T.kar.rows.length) | 0];
      if (row && row.start != null) {
        const s = +(rnd() * 110).toFixed(2), e = +(s + 0.5 + rnd() * 6).toFixed(2);
        applyAssRow(T, row, s, e, (row.zh ? '时间变了' : '') + '\n' + (row.en ? row.en.text : 'retimed words'));
      }
    } else if (op < 0.72) {                            // 删除
      const row = T.kar.rows[(rnd() * T.kar.rows.length) | 0];
      if (row) removeItemData(T, row);
    } else if (op < 0.84) {                            // 去逐词
      const row = words0();
      if (row) deKaraokeRow(T, row);
    } else if (op < 0.92) {                            // 逐词重计时
      const row = words0();
      if (row && row.en.words.length >= 2) {
        const idx = 1 + ((rnd() * (row.en.words.length - 1)) | 0);
        const ws = row.en.words;
        const mid = (ws[idx - 1].s + ws[idx - 1].e) / 2 + 0.01;
        ws[idx - 1].e = Math.max(ws[idx - 1].s + 0.02, mid);
        ws[idx].s = mid;
        row.en.events = T.doc.replaceEvents(row.en.events, buildWordSpecs(row.en));
      }
    } else {                                           // reconcile
      reconcileKaraoke(T);
    }
    check(T, label);
  }
});

console.log(`\n${'='.repeat(50)}\n共 ${checks} 项断言, 失败 ${failures}`);
process.exit(failures ? 1 : 0);
