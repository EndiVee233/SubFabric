/**
 * 逐词时间重对齐：用「TTS 合成 + 重新识别」得到的**参考节奏**，重算某条字幕里每个词的
 * 起止时间。**只改词级时间，绝不动文本** —— 这是用户明确要求的。
 *
 * 为什么走这条路（而不是直接对原音频做强制对齐）：
 *   原音频里的词边界只能靠识别结果反推，而 ASR 在快语速/连读处给的时间戳本来就糊。
 *   合成语音的**文本是已知的**，识别它得到的逐词时间是一份干净的"节奏参考"；
 *   把这份节奏按比例铺回原字幕的时长，就能把糊掉的词边界重新摊开。
 *
 * 纯逻辑，不碰文件/网络：便于离线单测（这一步最容易出错，见下面 alignSequences 的说明）。
 */

/* ─────────── 1. 分词与 TTS 文本准备 ─────────── */

/** 词 = 一段连续的非空白；保留标点（对齐时要剥掉再比） */
function tokenize(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * 比较用的归一化：去掉首尾标点、转小写、统一弯引号。
 * 'useful.' 与 'useful' 应判为同一个词。
 *
 * 也接受**词对象**（编辑器里词是 `{w,s,e}`，ASR 结果是 `{word,start,end}`）——
 * 早期只处理字符串，于是把对象喂进来会得到 "[object Object]"，
 * 一个词都配不上（实测锚点 0/11，排查了好一阵）。两种形态都收。
 */
function normWord(w) {
  const s = (w && typeof w === 'object')
    ? (w.word != null ? w.word : (w.w != null ? w.w : ''))
    : w;
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")     // 弯引号 → 直引号
    .replace(/^[^a-z0-9']+/, '')
    .replace(/[^a-z0-9']+$/, '');
}

/**
 * 交给 TTS 去念的文本。
 *
 * 目的是让合成结果**尽量与识别结果一致**，减少对齐噪声：
 *   · ASS 的样式/换行标签（`{\...}`、`\N`）要剥掉，否则会被念出来
 *   · `[角色名]` 这类方括号标记不念（它是编辑器自己的约定，不是台词）
 *   · 下划线连缀的词拆成空格（TTS 会把 `ice_ball` 念成怪音）
 */
function ttsText(text) {
  return String(text == null ? '' : text)
    .replace(/\{[^}]*\}/g, ' ')          // ASS 覆盖标签
    .replace(/\\[Nnh]/g, ' ')            // 硬换行
    .replace(/\[[^\]]*\]/g, ' ')          // [角色名]
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ─────────── 2. 序列对齐（编辑距离 + 回溯） ─────────── */

/**
 * 把「识别出的词」对到「原文的词」上，允许两侧都有落单的词。
 *
 * 为什么必须做序列对齐、而不是按下标配对：
 *   TTS 会把 `with velocity` 连读成 `withvelocity`（实测），识别结果因此少一个词；
 *   不同语速下还会出现漏词、重复、粘连。一旦有增删，按下标配对就会**整体错位**
 *   —— 后面每个词的时间都贴到别的词上。
 *   编辑距离对齐能把这种局部错位局部消化掉，只让对不上的词落单。
 *
 * 打分：同词 +2；编辑距离 ≤ 1 / 前缀关系 +1；否则 -1（不允许乱配）。
 * 用 Needleman-Wunsch（含空位罚分）求全局最优。
 *
 * @param orig  原文词数组
 * @param rec   识别出的词数组
 * @param opts  { match, near, gap }
 * @returns [{ oi, ri }]  oi/ri 为 -1 表示该侧落单；按序排列
 */
function alignSequences(orig, rec, opts) {
  const o = (typeof opts === 'object' && opts) ? opts : {};
  const MATCH = Number.isFinite(o.match) ? o.match : 2;
  const NEAR = Number.isFinite(o.near) ? o.near : 1;
  const GAP = Number.isFinite(o.gap) ? o.gap : -1;
  const A = orig.map(normWord);
  const B = rec.map(normWord);
  const n = A.length, m = B.length;
  if (!n || !m) return [];

  const score = (a, b) => {
    if (!a || !b) return GAP;
    if (a === b) return MATCH;
    // 前缀关系：'withvelocity' vs 'with' / 'velocity' —— TTS 连读的典型形态
    if (a.length > 2 && b.length > 2 && (a.startsWith(b) || b.startsWith(a))) return NEAR;
    if (editDistance1(a, b)) return NEAR;
    return GAP;
  };

  /* dp[i][j] = A 前 i 个与 B 前 j 个的最优分；mv[i][j] = 这一步选的方向。
   *
   * ⚠ 必须**记录方向**，不能事后靠"比较分数"回溯：三个候选（对角/上/左）的分数
   *   经常相等（本例实测就栽在这——锚点算出来是 0/11），比较 `dp[i][j] === dp[i-1][j-1] + score`
   *   在平局时会挑错方向，一路错到底。 */
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const mv = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(''));
  for (let i = 1; i <= n; i++) { dp[i][0] = dp[i - 1][0] + GAP; mv[i][0] = 'up'; }
  for (let j = 1; j <= m; j++) { dp[0][j] = dp[0][j - 1] + GAP; mv[0][j] = 'left'; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + score(A[i - 1], B[j - 1]);
      const up = dp[i - 1][j] + GAP;
      const left = dp[i][j - 1] + GAP;
      // 平局优先对角（能配上就别落单）、再上（原文侧落单）、最后左
      if (diag >= up && diag >= left) { dp[i][j] = diag; mv[i][j] = 'diag'; }
      else if (up >= left) { dp[i][j] = up; mv[i][j] = 'up'; }
      else { dp[i][j] = left; mv[i][j] = 'left'; }
    }
  }
  // 按记录的方向回溯（不再比较分数）
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const d = mv[i][j];
    if (d === 'diag') {
      // 只有"真配上"的才算锚点：分数为 GAP 的配对是硬凑的，用它当锚点会把时间带偏。
      // 落单的词由 mapTimes 在相邻锚点之间按比例摊分。
      const good = score(A[i - 1], B[j - 1]) > GAP;
      pairs.push(good ? { oi: i - 1, ri: j - 1 } : { oi: i - 1, ri: -1 });
      i--; j--;
    } else if (d === 'up') {
      pairs.push({ oi: i - 1, ri: -1 });      // 识别里漏了这个词
      i--;
    } else {
      pairs.push({ oi: -1, ri: j - 1 });      // 识别多吐了一个词（TTS 连读、重复）
      j--;
    }
  }
  return pairs.reverse();
}

/** 编辑距离 ≤ 1？（只判是否，不返回具体距离 —— 够用且省一半计算） */
function editDistance1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  if (i < la || j < lb) diff++;
  return diff <= 1;
}

/* ─────────── 3. 参考节奏 → 原字幕时间 ─────────── */

/**
 * 把识别结果映射回原字幕 [start, end] 这条时间线上。
 *
 * 算法（两步，比"直接拿识别词的时间"严谨）：
 *
 *  ① **按识别词的跨度分摊**：每个匹配上的识别词，负责它对应的那个原文词
 *     **以及其后直到下一个匹配词的落单词**。把它自己的时间跨度按**字符数**分给这些词。
 *     这样处理"一个识别词对应多个原文词"的情况 —— 实测 TTS 把 `with velocity`
 *     连读成 `withvelocity`，对齐后是「`with`→该词, `velocity`→落单」。
 *     若直接按识别词时间赋值，`with` 独吞 2.2 秒、`velocity` 只剩 0.02 秒；
 *     按字符数分摊则两词各得一份。
 *
 *  ② **整体缩放**到原块时长：合成语音的绝对时长与被念原文无关（TTS 语速、停顿都不同），
 *     能用的是**词与词之间的相对节奏**。把参考时间轴线性映到 [start, end]。
 *
 * 锚点之外的落单词（识别里完全没配上）在两侧已定时间之间按字符数插值。
 */
function mapTimes(origTokens, recWords, pairs, start, end) {
  const n = origTokens.length;
  if (!n) return [];
  const lo = Number(start), hi = Number(end);
  const dur = Math.max(0, hi - lo);
  if (!(dur > 0)) return evenSplit(origTokens, lo, 0);

  // ① 收集锚点：原文下标 → 该识别词的原始起止
  const anchors = [];
  for (const p of pairs) {
    if (p.oi < 0 || p.ri < 0) continue;
    const rw = recWords[p.ri];
    if (!rw || !Number.isFinite(rw.start) || !Number.isFinite(rw.end)) continue;
    anchors.push({ oi: p.oi, rs: Number(rw.start), re: Number(rw.end) });
  }
  anchors.sort((a, b) => a.oi - b.oi || a.rs - b.rs);
  const mono = [];                      // 去掉参考时间倒序的锚点
  for (const a of anchors) {
    const last = mono[mono.length - 1];
    if (last && a.rs < last.re - 1e-9) continue;
    mono.push(a);
  }
  if (!mono.length) return evenSplit(origTokens, lo, dur);

  /* 每个锚点负责的原文下标区间：[该锚点, 下一个锚点-1]。
   * 第 ① 步在这段区间内按字符数分摊该识别词的参考时间。 */
  const raw = new Array(n).fill(null);
  for (let k = 0; k < mono.length; k++) {
    const from = mono[k].oi;
    const to = (k + 1 < mono.length) ? mono[k + 1].oi - 1 : n - 1;
    const rs = mono[k].rs;
    /* 识别偶发给出零长词（start === end）。若照搬，对应原文词也会塌成零宽
     * （实测：`with velocity,` 两词都变成 0.000s）。给它一个**有意义的**下限：
     * 这一步只是定"词与词之间的相对比例"，最后会整体缩放到原块时长，
     * 所以下限取 80ms 这个语音学上合理的音节量级即可（1e-3 那种量级太小，
     * 缩放后仍然接近零 —— 实测分出来是 0.002s）。 */
    const re = Math.max(mono[k].re, rs + MIN_REF_SEC);
    const parts = splitByChars(origTokens, from, to, rs, re);
    for (let m = from; m <= to; m++) raw[m] = parts[m - from];
  }
  // 落单词（锚点之前，或两个锚点区间之间理论上不会有；保险起见插值补齐）
  for (let k = 0; k < n; k++) {
    if (raw[k]) continue;
    let p = k - 1; while (p >= 0 && !raw[p]) p--;
    let q = k + 1; while (q < n && !raw[q]) q++;
    const t0 = p >= 0 ? raw[p].e : mono[0].rs;
    const t1 = q < n ? raw[q].s : Math.max(mono[mono.length - 1].re, t0 + 1e-6);
    raw[k] = { oi: k, s: t0, e: Math.max(t0, t1) };
  }

  // ② 整体缩放到原块
  let refS = Infinity, refE = -Infinity;
  for (const r of raw) { refS = Math.min(refS, r.s); refE = Math.max(refE, r.e); }
  const span = Math.max(1e-6, refE - refS);
  const scale = dur / span;
  return raw.map((r) => ({
    oi: r.oi,
    s: lo + (r.s - refS) * scale,
    e: lo + (r.e - refS) * scale,
  }));
}

/** 全无锚点时：按字符数把 [start, start+dur] 铺满 */
function evenSplit(tokens, start, dur) {
  const total = tokens.reduce((s, t) => s + Math.max(1, normWord(t).length), 0) || 1;
  let t = Number(start);
  return tokens.map((tok, k) => {
    const w = Math.max(1, normWord(tok).length);
    const d = dur * (w / total);
    const seg = { oi: k, s: t, e: t + d };
    t += d;
    return seg;
  });
}

/** 按各词的字符数把一段时长分摊开 */
function splitByChars(tokens, from, to, tStart, tEnd) {
  const out = new Array(to - from + 1);
  const total = tokens.slice(from, to + 1)
    .reduce((s, t) => s + Math.max(1, normWord(t).length), 0) || 1;
  let t = tStart;
  for (let k = from; k <= to; k++) {
    const w = Math.max(1, normWord(tokens[k]).length);
    const d = (tEnd - tStart) * (w / total);
    out[k - from] = { oi: k, s: t, e: t + d };
    t += d;
  }
  return out;
}

/**
 * 处理**多对一**：原文多个词被 TTS 连读成一个词（识别里只有一个）。
 *
 * 实测：原文 `with velocity` 被念成 `withvelocity`，于是 `with` 拿到整段 2.2 秒、
 * `velocity` 只剩 0.02 秒 —— 明显不对。这类合并词的时间应该按**字符数分摊**给
 * 它实际对应的那几个原文词。
 *
 * @param times mapTimes 的结果（可能缺项，这里补齐）
 */
function shareMergedWords(tokens, pairs, out, start, end) {
  const n = tokens.length;
  // 每个原文词对应的识别词下标（未配上的记 -1）
  const riOf = new Array(n).fill(-1);
  for (const p of pairs) if (p.oi >= 0 && p.ri >= 0) riOf[p.oi] = p.ri;

  let k = 0;
  while (k < n) {
    if (riOf[k] >= 0) { k++; continue; }
    // 一段连续的"未配上"的词
    let j = k;
    while (j + 1 < n && riOf[j + 1] < 0) j++;
    const prevRi = k > 0 ? riOf[k - 1] : -1;
    const nextRi = j + 1 < n ? riOf[j + 1] : -1;
    // 前后是**同一个**识别词 → 这几词是它连读出来的，分摊它的时间
    if (prevRi >= 0 && prevRi === nextRi) {
      const seg = out[k - 1];
      const nxt = out[j + 1];
      const t0 = seg ? seg.e : (nxt ? nxt.s : Number(start));
      const t1 = nxt ? nxt.s : (seg ? seg.e : Number(end));
      const shared = splitByChars(tokens, k, j, t0, Math.max(t0, t1));
      for (let m = k; m <= j; m++) {
        const got = shared[m - k];
        // 前后锚点的边缘也要跟着收紧，避免重叠
        if (m === k && seg) seg.e = got.s;
        if (m === j && nxt) nxt.s = got.e;
        out[m] = got;
      }
    }
    k = j + 1;
  }
  return out;
}

/* ─────────── 4. 对外：一次算完 ─────────── */

/** 锚点命中率低于这个值就认为这次对齐不可信（合成/识别没对上，多半是文本不适合念） */
const MIN_ANCHOR_RATIO = 0.6;
/** 识别给出零长词时，给它的最小参考时长（秒）—— 见 mapTimes 里的说明 */
const MIN_REF_SEC = 0.08;

/**
 * @param text      原字幕文本（不改，只用来分词）
 * @param block     { start, end }
 * @param recWords  识别合成语音得到的词 [{ word, start, end }]，时间是**合成音频**的
 * @returns { words:[{w,s,e}], anchors, ratio, ok, note }
 */
function planBlock(text, block, recWords, opts) {
  const o = (typeof opts === 'object' && opts) ? opts : {};
  const minRatio = Number.isFinite(o.minAnchorRatio) ? o.minAnchorRatio : MIN_ANCHOR_RATIO;
  const toks = tokenize(text);
  const rec = (Array.isArray(recWords) ? recWords : [])
    .filter(w => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
    .map(w => ({ word: String(w.word == null ? '' : w.word), start: Number(w.start), end: Number(w.end) }));
  if (!toks.length) return { words: [], anchors: 0, ratio: 0, ok: false, note: '这条字幕没有可念的文本' };
  if (!rec.length) return { words: [], anchors: 0, ratio: 0, ok: false, note: '合成语音没识别出任何词' };

  const pairs = alignSequences(toks, rec);
  const anchors = pairs.filter(p => p.oi >= 0 && p.ri >= 0).length;
  const ratio = anchors / toks.length;
  const times = mapTimes(toks, rec, pairs, block.start, block.end);
  const words = toks.map((w, k) => ({ w, s: +times[k].s.toFixed(3), e: +times[k].e.toFixed(3) }));

  // 时间必须单调且不超出块范围（识别抖动可能把末词推出块尾）
  const fixed = enforceMonotonic(words, Number(block.start), Number(block.end));
  const ok = ratio >= minRatio;
  return {
    words: fixed, anchors, ratio: +ratio.toFixed(3), ok,
    note: ok ? '' : `只有 ${(ratio * 100).toFixed(0)}% 的词对上了（低于 ${(minRatio * 100).toFixed(0)}%），`
      + '这次对齐不可信 —— 多半是文本里有 TTS 念不对的内容（缩写、符号、专有名词）',
  };
}

/** 夹到 [lo,hi] 内、且保证 s<e、首尾相对有序 */
function enforceMonotonic(words, lo, hi) {
  const out = [];
  const span = Math.max(1e-3, hi - lo);
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    let s = Math.max(lo, Math.min(hi, w.s));
    let e = Math.max(lo, Math.min(hi, w.e));
    const prev = out[out.length - 1];
    if (prev) s = Math.max(s, prev.e);
    // 至少给 20ms，但不越过上界
    if (!(e > s)) e = Math.min(hi, s + Math.min(0.02, span));
    if (!(e > s)) e = s;
    if (e > hi) { e = hi; s = Math.min(s, e); }
    out.push({ w: w.w, s: +s.toFixed(3), e: +e.toFixed(3) });
  }
  return out;
}

export {
  tokenize, normWord, ttsText, alignSequences, editDistance1, mapTimes, evenSplit,
  splitByChars, shareMergedWords, planBlock, enforceMonotonic,
  MIN_ANCHOR_RATIO, MIN_REF_SEC,
};
