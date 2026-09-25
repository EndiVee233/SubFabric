/**
 * 语义分句（LLM 补标点 → 按标点切句）—— 专为 whisper.cpp 引擎做。
 *
 * 背景: whisper(英语)经常整段不给标点，启发式分组(句末标点/停顿>0.8s/行长兜底)
 * 会切出糊成一片的超长行。Parakeet 标点质量好，没这个问题。
 *
 * 设计要点（防止 LLM 破坏时间轴对齐）:
 *  - **不让 LLM 改写/重排单词** —— 它会丢词、换词，词一时间戳立刻错位。
 *    只把「编号 词」的清单发给它，让它返回 [[词序号, 标点], …]，
 *    单词由程序原样拼回，词一个不丢，时间戳天然对齐。
 *  - 切句规则（用户定）: 每遇到一个逗号或句号，下一个词开始就是新一句。
 *    问号/叹号同类。另保留兜底: 词间停顿>0.8s / 单句>10s / >30词 硬切，
 *    防止 LLM 抽风整段不给标点时又回到老问题。
 *  - 极短碎片(<2词且<1s)并入下一句，免得「uh,」这种独行闪一下就没了。
 *
 * 本模块保持纯净（不碰 fs / 子进程），chat 函数由调用方注入 —— 可单测。
 */
'use strict';

/** 切句用的标点集合（LLM 只允许返回这些） */
const SENT_PUNCT = new Set([',', '.', '?', '!', '…']);

/** 首尾剥离用的标点（不含撇号 —— don't / it's 不能拆） */
const STRIP_RE = /^[.,!?;:…—–\-"(){}[\]«»“”«»]+|[.,!?;:…—–\-"(){}[\]«»“”]+$/g;

/** 剥掉一个词 token 首尾的标点；全剥光返回 ''（独立标点 token） */
function cleanWordText(t) {
  return String(t || '').trim().replace(STRIP_RE, '');
}

/** 把 asr.json 的 segments 摊平成词序列。
 *  独立标点 token（whisper 有时把 "." 单独切一段）直接丢掉，
 *  其时间并入前一个词（前词 end 延到标点 end）。 */
function flattenWords(segs) {
  const words = [];
  for (const s of (segs || [])) {
    for (const w of (s && s.words) || []) {
      if (!w) continue;
      const c = cleanWordText(w.word);
      if (!c) {
        if (words.length) words[words.length - 1].end = Math.max(words[words.length - 1].end, w.end);
        continue;
      }
      words.push({ word: c, start: w.start, end: w.end });
    }
  }
  return words;
}

/** 解析 LLM 回复 → 合法的 [[idx, punct], …]（升序、去重、范围校验）。
 *  解不出 JSON 数组 / 一个合法对都没有 → 返回 null（调用方重试）。 */
function parsePunctReply(content, n) {
  const m = /\[[\s\S]*\]/.exec(String(content || ''));
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const seen = new Map();
  for (const it of arr) {
    if (!Array.isArray(it) || it.length < 2) continue;
    const i = Number(it[0]);
    const p = String(it[1] || '').trim();
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    if (!SENT_PUNCT.has(p)) continue;
    if (!seen.has(i)) seen.set(i, p === '…' ? '.' : p);   // 省略号按句号切
  }
  if (!seen.size) return null;
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}

/** 把标点贴回词上（词尾直接拼，"pearl" → "pearl,"） */
function applyPunct(words, pairs) {
  for (const [i, p] of (pairs || [])) {
    if (words[i]) words[i].word += p;
  }
  return words;
}

/** 按切句规则分组：句读标点(,.?!)后必切；停顿>0.8s / 单句>10s / >30词兜底硬切 */
function groupResegWords(words) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const split = /[,.?!…]$/.test(prev.word)
        || (w.start - prev.end) > 0.8
        || (w.start - cur[0].start) > 10
        || cur.length >= 30;
      if (split) { groups.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** 极短碎片（<2词 且 <1s）并入下一句；末尾碎片并回上一句 */
function mergeTinyFrags(groups) {
  if (groups.length <= 1) return groups.slice();
  const isTiny = (g) => g.length < 2 && (g[g.length - 1].end - g[0].start) < 1.0;
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (isTiny(g)) {
      if (i < groups.length - 1) groups[i + 1] = g.concat(groups[i + 1]);   // 并入下一组
      else if (out.length) out[out.length - 1] = out[out.length - 1].concat(g); // 末尾并回上一组
      else out.push(g);
    } else out.push(g);
  }
  return out.filter(g => g.length);
}

/** 词组 → asr.json 的 segment 结构（与 runWhisperCpp 产出的形状一致） */
function groupsToSegments(groups) {
  const segs = (groups || []).filter(g => g && g.length).map(ws => ({
    start: +ws[0].start.toFixed(3),
    end: +ws[ws.length - 1].end.toFixed(3),
    text: ws.map(w => w.word).join(' ').trim(),
    words: ws.map(w => ({ word: w.word, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })),
  }));
  for (let i = 1; i < segs.length; i++) if (segs[i].start < segs[i - 1].end) segs[i].start = segs[i - 1].end;
  return segs;
}

const RESeg_BATCH = 400;   // 每批发给 LLM 的词数（约 3KB，输出是对少得多的标点对）

/** 语义分句主入口。chat(messages) → Promise<string>（llmChat 的包装）。
 *  返回新的 segments；LLM 不可用/失败由调用方决定（这里只抛错）。
 *  词太少(<8)直接原样返回 —— 没有切的必要。 */
async function resegWithLLM(chat, segs, onProgress) {
  const words = flattenWords(segs);
  if (words.length < 8) return segs;

  // 分批请求标点位置（全局词序号，批内直接用全局编号，免得做偏移换算）
  const batches = [];
  for (let i = 0; i < words.length; i += RESeg_BATCH) batches.push([i, Math.min(i + RESeg_BATCH, words.length)]);
  const allPairs = [];
  for (let b = 0; b < batches.length; b++) {
    const [lo, hi] = batches[b];
    const list = words.slice(lo, hi).map((w, k) => (lo + k) + ' ' + w.word).join('\n');
    const sys = 'You receive a numbered list of English words from speech-to-text, in order. '
      + 'Insert punctuation so the text reads naturally. '
      + 'Reply ONLY a JSON array of pairs [wordIndex, punctuation], where wordIndex is the number of the word AFTER which the punctuation goes, and punctuation is one of , . ? ! '
      + 'Do NOT rewrite, add, drop, or reorder any word. Do not output the words back. No explanations.';
    const strict = '【极其重要】上一次的回复不是合法的 JSON 标点对数组。这一次必须只输出 JSON 数组，'
      + '每个元素是 [词序号, 标点]，标点仅限 , . ? ! ，不要输出任何别的内容。';
    let pairs = null, lastErr = '';
    for (const s of ['', strict]) {
      for (let a = 0; a < 2 && !pairs; a++) {
        try {
          const content = await chat([{ role: 'system', content: s || sys }, { role: 'user', content: list }]);
          pairs = parsePunctReply(content, words.length);
          if (!pairs) lastErr = String(content || '').slice(0, 120);
        } catch (e) { lastErr = String((e && e.message) || e); }
        if (!pairs) await new Promise(r => setTimeout(r, 800));
      }
      if (pairs) break;
    }
    if (!pairs) throw new Error('语义分句失败（LLM 未返回合法标点对）: ' + lastErr);
    allPairs.push(...pairs);
    if (onProgress) onProgress((b + 1) / batches.length,
      `语义分句中 … 批次 ${b + 1}/${batches.length}`);
  }
  applyPunct(words, allPairs);
  const groups = mergeTinyFrags(groupResegWords(words));
  return groupsToSegments(groups);
}

module.exports = {
  SENT_PUNCT, cleanWordText, flattenWords, parsePunctReply, applyPunct,
  groupResegWords, mergeTinyFrags, groupsToSegments, resegWithLLM,
};
