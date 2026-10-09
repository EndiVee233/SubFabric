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
const HAS_WORDTAG = (s) => /\{\\c&H[0-9A-Fa-f]{6}&/.test(String(s || ''));
const plain = (s) => String(s || '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
const EMPTY = (s) => !plain(s);

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
    const hasSentence = list.some(r => r.style === st && CJK.test(plain(r.text)));
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
      const cont = curIsKaraoke && tag
        && Math.abs(r.start - cur.end) < 1e-3 && t === cur.text;
      const sameLine = !tag && !curIsKaraoke
        && Math.abs(r.start - cur.start) < 1e-3 && Math.abs(r.end - cur.end) < 1e-3;
      if (cont) { cur.end = r.end; cur.n++; continue; }
      if (sameLine) { cur.text = cur.text + ' ' + t; cur.n++; continue; }
      sentences.push(cur);
    }
    cur = { start: r.start, end: r.end, text: t, n: 1 };
    curIsKaraoke = tag;
  }
  if (cur) sentences.push(cur);

  // ③ 给每句找它包住的整句行（中文原文）
  const usedSent = new Set();
  const out = [];
  for (const s of sentences) {
    const zh = sentRows.find(r => !usedSent.has(r)
      && Number(r.start) <= s.start + 1e-3 && Number(r.end) >= s.end - 1e-3 && CJK.test(plain(r.text)));
    if (zh) usedSent.add(zh);
    const lines = [];
    if (zh) lines.push(plain(zh.text));
    lines.push(s.text);
    out.push({ start: s.start, end: s.end, lines, _wordCount: s.n });
  }
  // ④ 没被逐词句认领的整句行（单语行）也要带上，否则会漏内容
  for (const r of sentRows) {
    if (usedSent.has(r)) continue;
    out.push({ start: Number(r.start), end: Number(r.end), lines: [plain(r.text)], _wordCount: 0 });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);

  return {
    ok: true, error: '', lines: out,
    stats: {
      raw: list.length, wordRows: wordRows.length, sentRows: sentRows.length,
      sentences: sentences.length, groups: out.length,
      wordStyles: [...wordStyles],
    },
  };
}

export { groupAssRows, plain };
