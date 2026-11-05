/**
 * ASS 的**分段导入解析器**（纯逻辑，可离线单测）。
 *
 * ## 为什么需要它
 *
 * 逐词 ASS 里，**一句英文是由多条 Dialogue 表示的**：每个词一条，文本是"整句 + 该词高亮"，
 * 起止时间是**那个词**的时间。而中文整句是**一条** Dialogue，跨度是整句。
 *
 *     中文整句 : [0 → 2.32]   Unstable SMP陷入混乱
 *     逐词(T)  : [0    → 0.19] {\c&H00FF00&}The{\c} unstable SMP is in chaos.
 *     逐词(uns): [0.19 → 0.85] The {\c&H00FF00&}unstable{\c} SMP is in chaos.
 *     …
 *
 * 如果**一条 Dialogue 当成一行字幕**（第一版就是这么写的），一份 226 句的稿件会被读成
 * 3400+ 个"行"：整句被拆散、中英配对错乱、逐词高亮全丢。
 * 用户实测：「区间内 43 行：可导入 43 行；占 0:00 ~ 0:14」就是这个问题。
 *
 * ## 正确做法
 *
 *   1. 认出**逐词样式**：同一段起止时间里出现多条、且文本带 `{\c&H..&}` 的那个样式
 *   2. 把逐词行**按"句"聚合**：连续、时间首尾相接、共享同一份"去掉标签后的整句文本"
 *      的一组词行 = 一句
 *   3. 配对它包住的那条整句行（中文样式、跨度覆盖这一句）
 *   4. 输出**一句一行**：主语言（中文整句）+ 副语言（英文整句）
 *
 * 判据只看文本与时间，**不依赖样式名语义**（用户的逐词样式叫 `Default`）。
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
/* 逐词行的形态是「开标签 + 词 + {\c} 复位」（buildWordSpecsColor 的原位包裹）。
 * 只认开标签会把**整行角色色**（如 `{\c&H00FFFF&}[路人] They're immortal!`，
 * 没有复位）也当成词行，结果整句被当成"一个词"，还会拆散相邻的词序列。
 * 因此必须同时看到 `{\c}` 复位才算词行。 */
const HAS_WORDTAG = (s) => /\{\\1?c&H[0-9A-Fa-f]{6}&[^}]*\}[^{}]*\{\\1?c[^}]*\}/.test(String(s || ''));
/**
 * 从一条逐词行里取出**这一行高亮的那个词**。
 *
 * 逐词行的文本形态（`buildWordSpecs` 是"原位包裹"：把高亮标签插在词前、`{\c}` 插在词尾，
 * 原作者的特效标签留在外面）：
 *
 *     {\c&H00FF00&  \3c&HC2C2C2&\3a&H00&\blur4.0\fscx105\fscy105}  The  {\c\3c\3a\blur\fscx\fscy} unstable …
 *        ↑高亮色（在前）        ↑原特效标签（在后）                     ↑词     ↑收尾
 *
 * 所以规则是：找到高亮标签，**跳过它所在的整个 `{…}` 块**，紧跟其后的、由非 `{` `\` 组成的
 * 那一段就是这个词。
 */
const WORD_AT_RE = /\{\\1?c&H[0-9A-Fa-f]{6}&[^}]*\}([^{}\\]+)\{\\1?c[^}]*\}/;
function highlightedWord(text) {
  const m = WORD_AT_RE.exec(String(text || ''));
  const w = m ? m[1] : '';
  return w && w.trim() ? w : '';
}
const plain = (s) => String(s || '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
const EMPTY = (s) => !plain(s);
/**
 * 去掉行首的角色标记 `[Spoke]` 后再判断语言。
 *
 * ⚠ 逐词英文行也会带 `[角色]` 标记，而角色名里可能有中文（用户实测 `[小丑]`、
 *   `[Clown?]` 这类混写）。旧实现对**整个 plain 文本**跑 CJK 测试，
 *   于是两条英文词行就因为角色名里的一个汉字被当成"该样式也承载整句"，
 *   `Default` 被排除出逐词样式 → 整份文件按"一条 Dialogue 一行"导入
 *   （用户实测：02:34~02:53 进了 3848 行、整排 ⚠、中英被拆成上下两半）。
 */
const ROLE_PREFIX = /^\[[^\]]*\]\s*/;
const sentenceText = (s) => plain(s).replace(ROLE_PREFIX, '');


/**
 * @param {Array} rows [{start,end,style,text}] —— 从 ASS 的 Dialogue 行解析而来
 * @returns {{ok:boolean, error:string, lines:Array<{start,end,lines:string[],_wordCount:number}>,
 *            stats:Object}}
 *   lines[i].lines 与 SRT cue 同构：[主语言, 副语言]（可能只有一项）
 */
function groupAssRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r
    && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)) && !EMPTY(r.text));
  if (!list.length) return { ok: false, error: '这个 ASS 里没有可用的字幕行', lines: [], stats: {} };

  // ① 哪些样式是"逐词样式"：同一 (style, start, end) 出现多条 → 那是词行
  const spanCount = new Map();
  for (const r of list) {
    const k = r.style + '|' + Number(r.start).toFixed(3) + '|' + Number(r.end).toFixed(3);
    spanCount.set(k, (spanCount.get(k) || 0) + 1);
  }
  const wordStyles = new Set();
  const tagStyles = new Set();
  for (const r of list) {
    const k = r.style + '|' + Number(r.start).toFixed(3) + '|' + Number(r.end).toFixed(3);
    if ((spanCount.get(k) || 0) > 1) wordStyles.add(r.style);
    if (HAS_WORDTAG(r.text)) tagStyles.add(r.style);
  }
  // 逐词样式的判定：同跨度多条 **或** 带逐词高亮标签。
  // ⚠ 这里必须**真的 add 进 wordStyles** —— 第一版只写了 delete，忘了 add，
  //   于是"样式名不含 word"（用户的叫 Default）的稿件永远认不出逐词样式。
  //   真实文件能过是因为它同时命中了"同跨度多条"（那句代码里 add 了）。
  for (const st of tagStyles) {
    const hasSentence = list.some(r => r.style === st && CJK.test(sentenceText(r.text)));
    if (hasSentence) { tagStyles.delete(st); continue; }   // 该样式也承载整句 → 不是纯逐词样式
    wordStyles.add(st);
  }

  const wordRows = list.filter(r => wordStyles.has(r.style));
  const sentRows = list.filter(r => !wordStyles.has(r.style));

  // ② 把逐词行按"句"聚合
  //    · 逐词（带高亮标签）：把时间首尾相接、且整句文本相同的一串合成一句
  //    · 非逐词但**起止时间完全相同**的多条 = "一屏多行"（换行排版），要合并成一行
  const sortedW = wordRows.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const sentences = [];
  let cur = null;
  let curIsKaraoke = false;
  for (const r of sortedW) {
    const t = plain(r.text);
    const tag = HAS_WORDTAG(r.text);
    if (cur) {
      /* 一句英文可能被 buildWordSpecsColor 拆成「词行 + 空档整句行」交替的序列：
       *  词行(带 \c 标签) → 空档整句行(无标签，补词间空隙) → 词行 …
       * 旧实现只把"带标签且紧接"的词行算作同一句，空档行会把一句切成几十段：
       * 每段单独导入 → 中英配不上、时间轴上下两半各一块（用户截图里的整排 ⚠）。
       * 判据仍只看「明文相同 + 时间首尾相接」，其中至少一侧是词行（带标签），
       * 所以连续两行无标签的独立整句不会被误粘。 */
      const contiguous = Math.abs(r.start - cur.end) < 1e-3 && t === cur.text;
      const cont = contiguous && (curIsKaraoke || tag);
      const sameLine = !tag && !curIsKaraoke
        && Math.abs(r.start - cur.start) < 1e-3 && Math.abs(r.end - cur.end) < 1e-3;
      if (cont) {
        cur.end = Math.max(cur.end, r.end);
        cur.n++;
        cur.rows.push(r);
        curIsKaraoke = curIsKaraoke || tag;
        continue;
      }
      if (sameLine) { cur.text = cur.text + ' ' + t; cur.n++; cur.rows.push(r); continue; }
      sentences.push(cur);
    }
    cur = { start: r.start, end: r.end, text: t, n: 1, rows: [r] };
    curIsKaraoke = tag;
  }
  if (cur) sentences.push(cur);

  // ②b 每句收集**真实的词级时间**：逐词行自己的 start/end 就是那个词的时间。
  //     用真实时间，别在导入时用 recalcWords 自动铺开 —— 那样词序看着对、节奏是假的。
  for (const s of sentences) {
    const words = [];
    for (const r of (s.rows || [])) {
      const w = highlightedWord(r.text);
      if (!w) continue;
      words.push({ word: w, start: Number(r.start), end: Number(r.end) });
    }
    s.words = words;
  }

  // ③ 给每句找它包住的整句行（中文原文）
  //   先配**逐词句**：同文本的"整行角色色"副本没有词级时间，不能让它先抢走中文行。
  const usedSent = new Set();
  const out = [];
  const ordered = sentences.filter(s => (s.words || []).length)
    .concat(sentences.filter(s => !(s.words || []).length));
  for (const s of ordered) {
    const covering = sentRows.filter(r => !usedSent.has(r)
      && Number(r.start) <= s.start + 1e-3 && Number(r.end) >= s.end - 1e-3);
    /* 优先带中文的覆盖行；像 `[Parrot] Saps！` 这种中文轨里只有名字/感叹号、
     * 没有一个汉字的行，也不能丢——退回第一条覆盖行（sentRows 不会是逐词样式）。
     * 但如果覆盖行的明文与这句完全相同（例如同文本的英文整句副本），不要配对，
     * 否则会把英文当"中文主语言"写进中文轨。 */
    const zh = covering.find(r => CJK.test(sentenceText(r.text)))
      || covering.find(r => sentenceText(r.text) !== sentenceText(s.text));
    if (zh) usedSent.add(zh);
    const lines = [];
    if (zh) lines.push(plain(zh.text));
    lines.push(s.text);
    out.push({ start: s.start, end: s.end, lines, words: s.words || [], _wordCount: s.n });
  }
  // ④ 没被逐词句认领的整句行（单语行）也要带上，否则会漏内容
  for (const r of sentRows) {
    if (usedSent.has(r)) continue;
    out.push({ start: Number(r.start), end: Number(r.end), lines: [plain(r.text)], _wordCount: 0 });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);

  /* ③b 合并被"小空档"切开的同一句（2026-11-05）：
   * 逐词行之间常有 10~200ms 的换气空档。导出文件若没给这段补无标签的整句空档行，
   * 分组就会把一句切成「中文 + 首个词」和「其余英文」两行 —— 用户实测
   * 3:26:26.43~3:26:28.75：第一行 0.05s 中英齐全、第二行 2.26s 只有英文。
   * 这里把**同文本、紧邻**的英文残句合回有中文的那一行，跨度取并集，
   * 等于用户手动的「删掉英文残句，把中文行结尾延长到它原本的结尾」。
   * 只合并"一边有中文、一边没有"的组合；两条都有中文的重复句不会被并掉。 */
  const MERGE_GAP = 0.25;
  const isEnglishOnly = (line) => line.lines.length === 1 && !CJK.test(sentenceText(line.lines[0] || ''));
  const mergeWords = (a, b) => {
    const map = new Map();
    for (const w of [...(a || []), ...(b || [])]) {
      const key = `${Number(w.start).toFixed(3)}|${Number(w.end).toFixed(3)}|${w.word}`;
      if (!map.has(key)) map.set(key, w);
    }
    return [...map.values()].sort((x, y) => x.start - y.start || x.end - y.end);
  };
  const merged = [];
  for (const line of out) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = line.start - prev.end;
      const adjacent = gap >= -0.02 && gap <= MERGE_GAP;
      if (adjacent && isEnglishOnly(line) && prev.lines.length > 1
        && sentenceText(line.lines[0]) === sentenceText(prev.lines[1])) {
        prev.end = Math.max(prev.end, line.end);
        prev.words = mergeWords(prev.words, line.words);
        prev._wordCount = (prev._wordCount || 0) + (line._wordCount || 0);
        continue;
      }
      if (adjacent && isEnglishOnly(prev) && line.lines.length > 1
        && sentenceText(prev.lines[0]) === sentenceText(line.lines[1])) {
        line.start = Math.min(line.start, prev.start);
        line.words = mergeWords(prev.words, line.words);
        line._wordCount = (prev._wordCount || 0) + (line._wordCount || 0);
        merged[merged.length - 1] = line;
        continue;
      }
    }
    merged.push(line);
  }
  out.length = 0;
  out.push(...merged);

  return {
    ok: true, error: '', lines: out,
    stats: {
      raw: list.length, wordRows: wordRows.length, sentRows: sentRows.length,
      sentences: sentences.length, groups: out.length,
      wordStyles: [...wordStyles],
    },
  };
}

export { groupAssRows, highlightedWord, plain };
