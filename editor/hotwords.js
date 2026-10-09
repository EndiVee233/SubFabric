/**
 * 从「操作日志」里挖掘适合 ASR 的热词候选（纯逻辑，可离线单测）。
 *
 * ## 为什么这能work
 *
 * 用户手动改字幕，绝大多数时候是在**纠正 ASR 听错的专有名词**：
 *
 *     ASR 听成            用户改成
 *     "Spoke"        →   "Spock"
 *     "Bdubs"        →   "B-Dubs"
 *     "Unstaple"     →   "Unstable"
 *     生僻人名/地名/组织名
 *
 * 所以「用户把 A 改成了 B」这条记录，本身就是"B 才是对的词"的**弱标注**。
 * 把 B 喂回 ASR 当热词，下一份稿子就不会再听错 —— 这是**越用越准**的闭环。
 *
 * ## 挖法
 *
 * 对每条 `action='edit'` 的记录，解析 detail 里的 `「旧」→「新」`：
 *
 *   1. 分词（CJK 按字、西文按词），对 old→new 做 LCS 对齐
 *   2. **只取"被替换掉的那一段"**：old 里有、new 里没有的 token 丢弃（那是错词），
 *      new 里有、old 里没有的 token 才可能是要补的词
 *   3. 只保留**看起来是专有名词/术语**的：
 *      · 首字母大写的西文词（Spock / Bdubs）—— 普通小写词（the / and）几乎不是热词
 *      · 含 CJK 且长度 ≥ 2 的片段（人名/地名/组织名）
 *      · 形态上有专名特征的：`B-Dubs`、`O'Brien`、`3D`、`S3`
 *   4. 统计出现次数、涉及的编辑条数、最近一次时间
 *
 * 只做"替换"这一种形态：如果整句被重写（改动跨度过大），对齐结果没有意义，跳过。
 *
 * ## 输出
 *
 * 每个候选带**依据**（出现在哪几条编辑、原词是什么），让用户能自己判断要不要加。
 * 绝不自动写入热词表 —— 用户勾选后才加。
 */

/** 分词：CJK 逐字成 token，西文按"字母数字连字符撇号"成词，其余当分隔符 */
function tokenize(s) {
  const out = [];
  const src = String(s || '');
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const ch of src) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) {
      flush();
      out.push(ch);
    } else if (/[A-Za-z0-9'\-.]/.test(ch)) {
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** 最长公共子序列的对齐（返回 old/new 里各自匹配上的下标） */
function lcsAlign(a, b) {
  const n = a.length, m = b.length;
  // 词量不大（单句级别），O(n*m) 的 DP 完全够；但给个上限防止异常输入
  if (n * m > 40000) return { ai: [], bi: [] };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].toLowerCase() === b[j].toLowerCase()
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ai = [], bi = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) { ai.push(i); bi.push(j); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { ai, bi };
}

/** 解析 detail 里的 `...「旧」→「新」...`，可能有多段（中英各一段） */
function parseEditPairs(detail) {
  const out = [];
  const re = /「([^」]*)」\s*→\s*「([^」]*)」/g;
  let m;
  while ((m = re.exec(String(detail || '')))) out.push({ old: m[1], new: m[2] });
  return out;
}

/** 这个词像热词吗（专有名词 / 术语 / 人名地名） */
function looksLikeTerm(tok) {
  const t = String(tok || '');
  if (!t) return false;
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(t);
  if (hasCJK) return t.length >= 2;                   // CJK 单字太泛，至少两字
  if (t.length < 2) return false;
  if (!/[A-Za-z]/.test(t)) return false;               // 纯数字/符号不算
  // 首字母大写，或全大写（缩写），或含数字/连字符/撇号/点的形态（B-Dubs / O'Brien / S3 / 3D）
  const capitalized = /^[A-Z]/.test(t);
  const acronym = /^[A-Z0-9]{2,}$/.test(t);
  const shaped = /[0-9'\-.]/.test(t);
  return capitalized || acronym || shaped;
}

/** 从一条 edit 的 detail 里抽"新出现的专名" */
function mineFromDetail(detail) {
  const found = [];
  for (const pair of parseEditPairs(detail)) {
    const a = tokenize(pair.old), b = tokenize(pair.new);
    if (!a.length || !b.length) continue;
    // 改动跨度太大（几乎整句重写）→ 对齐没有意义，跳过
    if (Math.max(a.length, b.length) > 40) continue;
    const { ai } = lcsAlign(a, b);
    if (!ai.length) continue;
    // 改动比例过高说明不是"改一个词"，而是重写整句
    const changedRatio = 1 - (ai.length / Math.max(a.length, b.length));
    if (changedRatio > 0.8) continue;

    /* 关键：要的是**旧文本里根本没有**的词。
     * ⚠ 不能用"对齐上的 token"当去重集合 —— 对齐上的恰恰是两边都有的（不变的部分），
     *   第一版就是这里写错，导致连 the/is 这种都算成"新词"。
     *   正确判据：old 全集的 lowercase 集合。 */
    const oldAll = new Set(a.map(t => t.toLowerCase()));
    const newAll = new Set(b.map(t => t.toLowerCase()));
    // 被替换掉的那些（old 有、new 没有）—— 作为"原来听成了什么"的依据
    const droppedAll = a.filter(t => !newAll.has(t.toLowerCase()));
    const seen = new Set();
    for (const tok of b) {
      if (oldAll.has(tok.toLowerCase())) continue;        // 旧文本里就有 → 不是新词
      if (!looksLikeTerm(tok)) continue;
      const k = tok.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      found.push({ term: tok, replaced: droppedAll.slice(0, 4).join(' ') });
    }
  }
  return found;
}

/**
 * 主入口：从操作日志里挖热词候选。
 *
 * @param {Array} entries oplog 条目 [{ t, action, target, detail, why }]
 * @param {Object} opts { exclude: string[] 已有的热词（不重复推荐）, now: number 用于算"最近" }
 * @returns {{ candidates: Array, stats: Object }}
 *   candidate: { term, count, edits, samples:[{target,replaced,at}], lastAt, score }
 */
function mineHotwords(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const exclude = new Set((opts.exclude || []).map(x => String(x).toLowerCase()));
  const byTerm = new Map();
  let editEntries = 0;
  /* 原始编辑对也留一份：给 LLM 分析用（它要看到"改前→改后"的原文，
   * 才能判断"这是专有名词"还是"只是改了个语气词"）。 */
  const rawEdits = [];

  for (const e of list) {
    if (!e || e.action !== 'edit') continue;
    const pairs = parseEditPairs(e.detail);
    if (!pairs.length) continue;
    editEntries++;
    for (const p of pairs) {
      rawEdits.push({ target: e.target || '', old: p.old, new: p.new, at: e.t || '' });
    }
    for (const f of mineFromDetail(e.detail)) {
      const k = f.term.toLowerCase();
      if (exclude.has(k)) continue;
      if (!byTerm.has(k)) byTerm.set(k, { term: f.term, count: 0, edits: 0, samples: [], lastAt: 0 });
      const c = byTerm.get(k);
      c.count++;
      if (c.samples.length < 3) {
        c.samples.push({ target: e.target || '', replaced: f.replaced, at: e.t || 0 });
      }
      const ts = Date.parse(e.t) || 0;
      if (ts > c.lastAt) c.lastAt = ts;
    }
  }
  // 同一条 edit 里重复出现只算一次 edits
  for (const c of byTerm.values()) c.edits = new Set(c.samples.map(s => s.target)).size || 1;

  const now = opts.now || Date.now();
  const candidates = [...byTerm.values()].map(c => {
    const ageDays = c.lastAt ? (now - c.lastAt) / 86400000 : 999;
    // 打分：改得越多越可信；最近改过的更相关；有替换前词形的更可信
    let score = c.count * 2 + Math.max(0, 3 - ageDays / 7);
    if (c.samples.some(s => s.replaced)) score += 1;
    return Object.assign(c, { score: Math.round(score * 100) / 100 });
  }).sort((a, b) => b.score - a.score || a.term.localeCompare(b.term, 'zh'));

  return {
    candidates,
    edits: rawEdits,
    stats: {
      editEntries,
      terms: candidates.length,
      from: list.length,
    },
  };
}

export { mineHotwords, mineFromDetail, parseEditPairs, tokenize, looksLikeTerm, lcsAlign };
