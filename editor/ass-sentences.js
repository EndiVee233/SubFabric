/**
 * 从「karaoke 式 ASS」里还原出「句子 + 逐词时间」—— 服务端用，纯函数、无 DOM 依赖。
 *
 * 为什么需要它：导入 ASS 建的稿件**没有 asr.json**，而全片逐词重校对
 * （realignTargets）只认 asr.json 的 segments。于是「导入的稿件用不了重校对」。
 * 前端的 karaoke.js 能解析这种结构，但那是 ESM + 依赖浏览器环境，服务端用不了；
 * 所以这里单独写一个**只读、不做推断**的轻量解析器，专供重校对取句子。
 *
 * ── 这类 ASS 的结构（实测 p-mv26t5hg-gw2ff，58722 条 Dialogue）──
 * 同一句英文被重复成很多条，交替出现：
 *   t1~t2  {\c&HFFFFFF&}This{\c} is the Unstable SMP, ...   ← 高亮第 1 个词，但**显示整句**
 *   t2~t3  This is the Unstable SMP, ...                    ← 无色标（占位，显示整句）
 *   t3~t4  This {\c&HFFFFFF&}is{\c} the Unstable SMP, ...    ← 高亮第 2 个词
 *   ...
 * 所以：
 *   · **句子**的区间 = 所有同文本行的并集（第一行的 start → 最后一行的 end）
 *   · **词时间** = 每条的「带色标那一段在这条里的位置」映射到这条的 [start,end]
 *     （因为每条显示的都是整句，色标只是把当前词那一小段换色；
 *       若按"整行时长 ÷ 词数"硬分，遇到 0.02 秒的词事件会算出垃圾）
 *
 * ⚠ 刻意**不做**的事（那些留给前端的 karaoke.js）：
 *   · 不推断哪个样式是"逐词样式"（由调用方传 wordStyle）
 *   · 不修 karaoke 分组、不管标签嵌套、不处理 \k 标签
 *   · 不改任何文件 —— 只读、只返回
 */
'use strict';

/** 样式名前后的花括号块（{\...}）—— 用来剥离 ASS 覆盖标签 */
const TAG_RE = /\{[^}]*\}/g;
/** 找「着色片段」：{\c&Hxxxxxx&}文字{\c} —— 这就是"当前高亮的词" */
const HL_RE = /\{\\c&H[0-9A-Fa-f]{6}&\}([^{}]*)\{\\c\}/;

/** '0:00:04.94' → 4.94；认不出来返回 NaN */
function toSec(t) {
  const m = /^\s*(\d+):(\d+):(\d+(?:\.\d+)?)\s*$/.exec(String(t || ''));
  if (!m) return NaN;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

/** 去掉所有 ASS 覆盖标签，并把 \N \n 折成空格 */
function plainText(raw) {
  return String(raw || '').replace(TAG_RE, '').replace(/\\[Nn]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 取「着色片段」的文本；没有则返回 '' */
function highlightWord(raw) {
  const m = HL_RE.exec(String(raw || ''));
  return m ? m[1].trim() : '';
}

/**
 * 解析 events 段的行。
 * @param {string} assText 整个 ASS 文件内容
 * @returns {Array<{start:number,end:number,style:string,text:string,hl:string,hlAt:number}>}
 *   hl = 这条里被高亮的词（无则 ''）；hlAt = 该词在这条区间里的**相对**位置 [0,1]
 */
function parseEvents(assText) {
  const lines = String(assText || '').split(/\r?\n/);
  let inEvents = false, fmt = null;
  const out = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) { inEvents = /^\[Events\]$/i.test(t); fmt = null; continue; }
    if (!inEvents) continue;
    const mf = /^Format:\s*(.*)$/i.exec(t);
    if (mf) { fmt = mf[1].split(',').map(s => s.trim().toLowerCase()); continue; }
    if (!t.startsWith('Dialogue:')) continue;
    /* 没有 Format 行时按 ASS 标准字段序兜底（Layer,Start,End,Style,Name,ML,MR,MV,Effect,Text） */
    const f = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = t.slice('Dialogue:'.length).split(',');
    if (parts.length < f.length) continue;
    const get = (k) => { const i = f.indexOf(k); return i < 0 ? '' : parts[i]; };
    const start = toSec(get('start'));
    const end = toSec(get('end'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const textIdx = f.indexOf('text');
    const raw = parts.slice(textIdx).join(',');
    out.push({
      lineNo: ln,                 // 原文件行号（写回时按行改，不重建整个文件）
      start, end, style: get('style'),
      startRaw: get('start'), endRaw: get('end'),
      raw,
      text: plainText(raw), hl: highlightWord(raw),
    });
  }
  return out;
}

/**
 * 把事件聚合成「句子 + 逐词」。
 *
 * @param {string} assText ASS 全文
 * @param {object} [opt]
 *   wordStyle  逐词轨的样式名（如 'Default'）；不传则用"出现次数最多且非中文"的样式
 *   minWords   少于这么多词的句子丢弃（默认 2 —— 单词句对齐无意义）
 *   gapSec     同文本相邻行间隔超过这么多秒就认为是**另一句**（默认 0.35）
 * @returns {Array<{start:number,end:number,text:string,words:Array<{w:string,s:number,e:number}>}>}
 */
function extractSentences(assText, opt) {
  const o = opt || {};
  const ev = parseEvents(assText).filter(e => e.text);

  // 1) 定逐词轨样式：优先用调用方给的；否则挑"条数最多"的样式
  let wordStyle = String(o.wordStyle || '').trim();
  if (!wordStyle) {
    const cnt = {};
    for (const e of ev) cnt[e.style] = (cnt[e.style] || 0) + 1;
    wordStyle = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
  const rowStyle = ev.filter(e => e.style === wordStyle);

  // 2) 按「同文本 + 时间相邻」聚合成句子。事件在文件里本就是按时间排的，
  //    这里只做「相邻且文本相同」的合并 —— 不跨句子合并（不同文本立刻断开）。
  const gap = Number.isFinite(Number(o.gapSec)) ? Number(o.gapSec) : 0.35;
  const groups = [];
  for (const e of rowStyle) {
    const last = groups[groups.length - 1];
    if (last && last.text === e.text && e.start - last.end <= gap) {
      last.end = Math.max(last.end, e.end);
      last.rows.push(e);
    } else {
      groups.push({ text: e.text, start: e.start, end: e.end, rows: [e] });
    }
  }

  // 3) 从每组的行里取词时间。
  //    ⚠ 这类 ASS 的约定（实测 52489 条 Default 事件逐条核过）：
  //      **高亮那一行的 Start/End 就是那个词的时间**，不是"整句时长按字符比例分"。
  //      例：This(0.03~0.53) is(0.53~0.55) the(0.55~1.05) …，
  //      每行显示的都是整句，但行区间 = 该词的说话区间。
  //    早先误按"色标片段占整句的字符比例 × 行时长"算，词长被压扁
  //    （This 0.03~0.06 而不是 0.03~0.53）—— 那样算出来的锚点全错，
  //    重排的置信度也就没意义了。
  const minWords = Number.isFinite(Number(o.minWords)) ? Math.max(1, Math.floor(Number(o.minWords))) : 2;
  const out = [];
  for (const g of groups) {
    const words = [];
    for (const r of g.rows) {
      if (!r.hl) continue;                       // 无色标 = 占位行，跳过
      if (!(r.end > r.start)) continue;
      words.push({ w: r.hl, s: +r.start.toFixed(3), e: +r.end.toFixed(3) });
    }
    // 词按时间排序（行序偶尔会乱），并压掉完全重复的
    words.sort((a, b) => a.s - b.s || a.e - b.e);
    const dedup = [];
    for (const w of words) {
      const p = dedup[dedup.length - 1];
      if (p && p.w === w.w && Math.abs(p.s - w.s) < 0.02) { p.e = Math.max(p.e, w.e); continue; }
      dedup.push(w);
    }
    if (dedup.length < minWords) continue;
    out.push({
      start: +g.start.toFixed(3), end: +g.end.toFixed(3), text: g.text, words: dedup,
      /* 这一句是由哪些行构成的（写回时按行改；顺序即文件顺序） */
      rows: g.rows.map(r => ({
        lineNo: r.lineNo, start: r.start, end: r.end, hl: r.hl, text: r.text,
      })),
    });
  }
  return out;
}

/**
 * 把「每句的新逐词时间」写回 karaoke 式 ASS —— **按行原位改时间戳**，不重建文件。
 *
 * 为什么原位改而不是重新生成整份 ASS：这份文件是用户导入的成果，
 * 里面有角色色标、说话人名、字体样式等他自己的东西；重新生成必然丢细节。
 * 这里只做一件事：把这一句覆盖到的那些行的 Start/End 换成新算出来的时间。
 *
 * 映射规则（与 extractSentences 的读法对称）：
 *   · 带高亮词的行 → 该词的 [s,e]；同时把色标移到**新词表里对应的那个词**上
 *     （重排后词序一般不变，但识别可能给出不同大小写/标点，所以按序号对齐、文本不动）
 *   · 不带色标的占位行 → 沿用上一行结束到下一行开始的那段（保持"整句在显示"）
 *
 * @param {string} assPath
 * @param {Array<{text:string,start:number,words:Array<{w,s,e}>}>} applied
 * @returns {{changed:number, lines:number}}
 */
function applyWordsToFile(assPath, applied) {
  const fs = require('fs');
  let txt;
  try { txt = fs.readFileSync(assPath, 'utf8'); } catch { return { changed: 0, lines: 0 }; }
  const eol = /\r\n/.test(txt) ? '\r\n' : '\n';
  const lines = txt.split(/\r?\n/);

  /* 先解析一遍拿到每一句对应的行；用「文本 + start 接近」把 applied 匹配回句子。
   * 不能用下标 —— 前端勾选的是子集，下标会错位。 */
  const sents = extractSentences(txt, {});
  const fmtOf = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };

  let changed = 0, touched = 0;
  for (const ap of applied) {
    if (!ap || !Array.isArray(ap.words) || !ap.words.length) continue;
    const key = String(ap.text || '').trim();
    let g = sents.find(s => s.text === key && Math.abs(s.start - Number(ap.start)) <= 0.6);
    if (!g) g = sents.find(s => s.text === key);
    if (!g || !Array.isArray(g.rows) || !g.rows.length) continue;

    /* 句子的行分两类：有高亮词的、没有的。按"有高亮词的行"的顺序依次对应新词表。
     * 若新词数与高亮行数不一致（识别切词不同），按能对上的部分改，多出来的行留给占位逻辑。 */
    const hlRows = g.rows.filter(r => r.hl);
    if (!hlRows.length) continue;
    const n = Math.min(hlRows.length, ap.words.length);
    for (let i = 0; i < n; i++) {
      const r = hlRows[i], w = ap.words[i];
      const ln = r.lineNo;
      if (ln == null || !lines[ln]) continue;
      lines[ln] = lines[ln]
        .replace(/(Dialogue:[^,]*),(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),/, `$1,${fmtOf(w.s)},${fmtOf(w.e)},`);
      changed++;
      touched++;
    }
    /* 占位行（无色标）：让它落在相邻两个高亮行之间，保证整句始终有东西在显示 */
    const all = g.rows.slice().sort((a, b) => a.lineNo - b.lineNo);
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      if (r.hl) continue;
      const prev = all[i - 1], next = all[i + 1];
      const s = prev ? prev.end : g.start;
      const e = next ? next.start : g.end;
      if (!(e > s)) continue;
      const ln = r.lineNo;
      if (ln == null || !lines[ln]) continue;
      lines[ln] = lines[ln]
        .replace(/(Dialogue:[^,]*),(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),/, `$1,${fmtOf(s)},${fmtOf(e)},`);
    }
  }
  if (!changed) return { changed: 0, lines: 0 };
  fs.writeFileSync(assPath + '.tmp', lines.join(eol));
  fs.renameSync(assPath + '.tmp', assPath);
  return { changed, lines: touched };
}

/**
 * 从一个**项目目录**里读字幕并还原句子 —— realignTargets 在缺少 asr.json 时的备用来源。
 *
 * 返回格式与 realignTargets 从 asr.json 得到的一致：
 *   [{ index, start, end, text, words:[{w,s,e}] }]
 * 读取/解析失败一律返回 null（调用方据此回退到原来的报错），不抛。
 *
 * @param {string} assPath 字幕文件的绝对路径
 * @param {object} [opt] { wordStyle, minWords, gapSec }
 */
function sentencesFromFile(assPath, opt) {
  const fs = require('fs');
  let txt;
  try { txt = fs.readFileSync(assPath, 'utf8'); } catch { return null; }
  let sents;
  try { sents = extractSentences(txt, opt); } catch { return null; }
  if (!sents.length) return null;
  return sents.map((s, i) => ({
    index: i, start: s.start, end: s.end, text: s.text, words: s.words,
  }));
}

module.exports = {
  parseEvents, extractSentences, sentencesFromFile, applyWordsToFile,
  plainText, highlightWord, toSec,
};
