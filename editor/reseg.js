/**
 * 语义分句（LLM 补标点 → 按标点切句）—— **所有识别引擎共用**（whisper.cpp / Parakeet /
 * 必剪 / 剪映 / NeMo 多说话人）：断句不再取决于引擎自带的那一套。
 *
 * 背景: 各引擎的断句差异很大 —— whisper(英语)经常整段不给标点，启发式分组(句末标点/
 * 停顿>0.8s/行长兜底)会切出糊成一片的超长行；云端则按自己的 words_per_line 切；
 * Parakeet 给的是基础标点。统一在这里过一遍：LLM 只补标点，切句规则固定。
 *
 * 设计要点（防止 LLM 破坏时间轴对齐）:
 *  - **不让 LLM 改写/重排单词** —— 它会丢词、换词，词一时间戳立刻错位。
 *    只把「编号 词」的清单发给它，让它返回 [[词序号, 标点], …]，
 *    单词由程序原样拼回，词一个不丢，时间戳天然对齐。
 *  - 【用户报"切在半句上"的根治】**按静音边界切批**（见 planBatches）：
 *    旧实现每 400 词盲切一刀，模型拿到的是**从半句开始、到半句结束**的词表 ——
 *    它看不到后文，必然给最后一个词收个句读，于是每个批次边界附近都多出一个断点。
 *    现在批边界优先落在「词间停顿 > 0.6s」处（那本来就是天然句界），
 *    找不到才放宽到 1200 词上限硬切；提示词也明确告诉它"这是连续语音的中段，首尾可能是半句，别强行断句"。
 *  - 【用户报"逗号也切句导致断句很碎"】**切句只认句末标点**（. ? ! …），
 *    逗号降级为"行内停顿"；只有当一整行超过 30 词 / 10 秒时才用逗号**软折**。
 *    想恢复旧行为（遇到逗号就切）：settings.json 里设 `resegSplitOnComma: true`。
 *  - **整段没有词级时间的不能丢**：有些引擎的某几段只有 text、`words` 是空的（典型是
 *    multitalker.py 拿不到词级时间时的兜底段）。这种段用整句当「一个词」补进词表（时间取
 *    [start, end]），否则 flattenWords 会把它整段吃掉 —— 分句这一步绝不能减少文本。
 *  - 极短碎片(<2词且<1s)并入下一句，免得「uh,」这种独行闪一下就没了。
 *  - **单批失败不拖垮整步**：某批（大喊大叫、标点给得过密的段落）几轮都做不出来时，不抛错结束整条流水线 ——
 *    只放弃这批（这些词不加标点、按停顿兜底），其余批次照常做完；只有**所有**批次都没成（模型配错/不可用）
 *    才抛错。另有一道抢救：密度异常时先"只保留句末标点"重判一次（逗号全丢往往就正常了）。
 *  - **断点续跑**：每批成功就通过 opts.saveCheckpoint 落盘，重试/服务重启后按词表指纹跳过做过的批次 ——
 *    1.2 万词 = 52 批，重跑一遍要几分钟、几十次模型调用，不能每次重试都从头来。
 *  - 防小模型抽风: 标点密度合理性校验（每词都加逗号 → 判失败重试/拆批），见 llm-text.js 的 punctPairsSane。
 *  - 输出被 max_tokens 截断（finish_reason=length）→ **直接拆批**（换同样提示词重试必然再失败）。
 *
 * 本模块保持纯净（不碰 fs / 子进程 / 网络），chat 函数由调用方注入 —— 可单测。
 */
'use strict';

const { punctPairsSane, LlmError } = require('./llm-text.js');

/** LLM 允许返回的标点 */
const SENT_PUNCT = new Set([',', '.', '?', '!', '…']);

/** 句末标点：一定切句 */
const SENT_END_RE = /[.?!…]$/;
/** 句内停顿：只在整行过长时用来软折（逗号/分号/破折号） */
const SOFT_END_RE = /[,;:—–]$/;

const RESeg_BATCH_MAX = 1200;    // 单批词数上限（旧实现是 400 盲切）
const RESeg_BATCH_MIN = 200;     // 攒够这么多词后，遇到停顿就可以收批
const PAUSE_SPLIT = 0.6;         // 视为"天然句界"的词间停顿（秒）
const MAX_WORDS_PER_CUE = 30;    // 单句词数上限（超了软折/硬切）
const MAX_SEC_PER_CUE = 10;      // 单句时长上限
const MIN_SPLIT_WORDS = 40;      // 拆批下限：少于这么多词就别再拆了

/** 首尾剥离用的标点（不含撇号 —— don't / it's 不能拆） */
const STRIP_RE = /^[.,!?;:…—–\-"(){}[\]«»“”«»]+|[.,!?;:…—–\-"(){}[\]«»“”]+$/g;

/** 剥掉一个词 token 首尾的标点；全剥光返回 ''（独立标点 token） */
function cleanWordText(t) {
  return String(t || '').trim().replace(STRIP_RE, '');
}

/** 把 asr.json 的 segments 摊平成词序列。
 *  独立标点 token（whisper 有时把 "." 单独切一段）直接丢掉，
 *  其时间并入前一个词（前词 end 延到标点 end）。
 *  **整段没有 words 但有 text**（multitalker 的兜底段 / 云端某句没给词级时间）时，
 *  用整句当「一个词」补进来 —— 宁可切不细，也不能把这段文本丢掉。 */
function flattenWords(segs) {
  const words = [];
  for (const s of (segs || [])) {
    const before = words.length;
    for (const w of (s && s.words) || []) {
      if (!w) continue;
      const c = cleanWordText(w.word);
      if (!c) {
        if (words.length) words[words.length - 1].end = Math.max(words[words.length - 1].end, w.end);
        continue;
      }
      words.push({ word: c, start: w.start, end: w.end });
    }
    if (words.length !== before) continue;                 // 这段有词级时间, 正常走
    const text = cleanWordText((s && s.text) || '');       // 只有标点的段不算内容, 丢掉无妨
    const start = Number(s && s.start), end = Number(s && s.end);
    if (text && end > start) words.push({ word: text, start, end });
  }
  return words;
}

/** 解析 LLM 回复 → 合法的 [[idx, punct], …]（升序、去重、范围校验）。
 *  解不出 JSON 数组 / 一个合法对都没有 → 返回 null（调用方重试）。
 *  注意: 思维链已在 llm-text.js 里剥掉, 这里只做 JSON 提取与字段校验。 */
function parsePunctReply(content, n) {
  const { parseJsonArray } = require('./llm-text.js');
  const arr = parseJsonArray(content);
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

/**
 * 按「静音边界」切批 —— 这是"切在半句上"的根治点。
 *  ① 攒够 RESeg_BATCH_MIN 个词后，遇到 > PAUSE_SPLIT 的停顿就收批（天然句界）；
 *  ② 一直没停顿（连续口播）就到 RESeg_BATCH_MAX 硬切；
 *  ③ 尽量把硬切点回退到本批内**最后一个停顿**处（回退不超过 1/4 批），
 *     实在没有停顿才切在词中间。
 * 返回 [[lo, hi), …] 全局词序号区间。
 */
function planBatches(words) {
  const n = (words || []).length;
  const out = [];
  if (!n) return out;
  const gapAt = (i) => (i + 1 < n) ? (words[i + 1].start - words[i].end) : Infinity;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const len = i + 1 - lo;
    const atEnd = i === n - 1;
    const pause = gapAt(i) > PAUSE_SPLIT;
    if (atEnd) { out.push([lo, i + 1]); break; }
    if (len >= RESeg_BATCH_MAX) {
      // 硬切前回退到本批内最后一个停顿（最多回退 1/4 批），避免切在句子中间
      let cut = i;
      const floor = Math.max(lo + Math.floor(len * 0.75), lo + 1);
      for (let k = i; k >= floor; k--) { if (gapAt(k) > PAUSE_SPLIT) { cut = k; break; } }
      out.push([lo, cut + 1]);
      i = cut;
      lo = cut + 1;
      continue;
    }
    if (pause && len >= RESeg_BATCH_MIN) { out.push([lo, i + 1]); lo = i + 1; }
  }
  return out;
}

/**
 * 切句规则（新）: 句末标点(./?/!)一律切；停顿>0.8s 切。
 * 逗号**不再**产生新句 —— 只在一整行过长时用于软折（见 softFold）。
 * opts.splitOnComma === true 恢复旧行为（遇到逗号也切），供 settings 回退。
 */
function groupResegWords(words, opts) {
  const splitOnComma = !!(opts && opts.splitOnComma);
  const raw = [];
  let cur = [];
  for (const w of (words || [])) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const split = SENT_END_RE.test(prev.word)
        || (w.start - prev.end) > 0.8
        || (splitOnComma && /,$/.test(prev.word));
      if (split) { raw.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) raw.push(cur);
  // 长行软折：优先在逗号处折，折不动才按词数/时长硬折
  const out = [];
  for (const g of raw) for (const part of softFold(g)) out.push(part);
  return out;
}

/** 把过长的组折成多段：30 词 / 10 秒以内为一段；折点优先取段内最后一个逗号 */
function softFold(group) {
  const g = group || [];
  if (!g.length) return [];
  const dur = g[g.length - 1].end - g[0].start;
  if (g.length <= MAX_WORDS_PER_CUE && dur <= MAX_SEC_PER_CUE) return [g];
  // 找第一个"越界点"（超过词数或时长的位置）—— cut 是**新段的起点**，所以 head 最多 MAX_WORDS_PER_CUE 个词
  let cut = g.length;
  for (let i = 0; i < g.length; i++) {
    if (i + 1 > MAX_WORDS_PER_CUE || (g[i].end - g[0].start) > MAX_SEC_PER_CUE) { cut = i; break; }
  }
  if (cut >= g.length) return [g];
  // 从越界点往前找最后一个逗号（至少保留 50% 的段长），把折点放在那里
  let at = -1;
  for (let k = cut - 1; k >= Math.floor(cut / 2); k--) {
    if (SOFT_END_RE.test(g[k].word)) { at = k; break; }
  }
  const head = at >= 0 ? g.slice(0, at + 1) : g.slice(0, cut);
  const tail = at >= 0 ? g.slice(at + 1) : g.slice(cut);
  if (!head.length || !tail.length) return [g];
  return [head].concat(softFold(tail));
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

/** 系统提示词：明确"这是连续语音的中段"，并要求别在首尾强行断句 */
const SYS_PROMPT = [
  'You receive a numbered list of English words from a speech-to-text transcript, in order.',
  'Insert punctuation (commas at short pauses, and . ? ! at real sentence ends) so the text reads naturally.',
  'IMPORTANT: this list is a MIDDLE SLICE of a continuous transcript — its first and last words may be in the middle of a sentence.',
  'Do NOT force a sentence boundary at the very first or very last word unless the speech clearly ends there.',
  'Reply ONLY a JSON array of pairs [wordIndex, punctuation], where wordIndex is the index of the word AFTER WHICH the punctuation goes, and punctuation is one of , . ? !',
  'Do NOT put a comma after every word. Do NOT rewrite, add, drop, or reorder any word. Do not output the words back. No explanations.',
].join(' ');

const STRICT_PROMPT = '【极其重要】上一次的回复不是合法的 JSON 标点对数组。这一次必须只输出 JSON 数组，'
  + '每个元素是 [词序号, 标点]，标点仅限 , . ? ! ，不要输出任何别的内容。'
  + '也不要给每个词都加逗号 —— 只在真正需要停顿或断句的地方加。';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 请一批词的标点。返回：
 *   { pairs }              —— 正常拿到标点对（索引是**全局**词序号）
 *   { pairs, salvaged }    —— 密度异常但抢救成功（只保留句末标点，逗号全丢）
 *   { failed: true, err }  —— 这批没做出标点（由调用方决定：拆半 / 放弃这批）
 *   null                   —— 输出被截断（直接交给调用方拆半，不浪费重试）
 *  重试策略按错误类型分流:
 *   · truncated（输出被截断）→ 直接返回 null 交给调用方拆批，不浪费重试
 *   · net/rate/timeout      → 指数退避（尊重 Retry-After）
 *   · format（解析不出来/密度异常）→ 换 strict 提示词再来
 */
async function askBatch(chat, words, lo, hi, onProgress, label) {
  const n = words.length;
  const list = words.slice(lo, hi).map((w, k) => (lo + k) + ' ' + w.word).join('\n');
  // 输出长度按"每个词都可能被标点"估：模型在大喊大叫的段落会给出很密的标点对，
  // 低估就会被 max_tokens 截断，整批白白重来一次（实测 261 词的批 825 tokens 不够用）。
  const maxTokens = Math.min(4096, Math.max(768, Math.round((hi - lo) * 2) + 768));
  let lastErr = '';
  let dense = null;                                  // 解析出来但密度异常的最后一版, 留着抢救
  for (const s of ['', STRICT_PROMPT]) {
    for (let a = 0; a < 2; a++) {
      try {
        const content = await chat([{ role: 'system', content: s || SYS_PROMPT }, { role: 'user', content: list }],
          { maxTokens, kind: 'reseg' });
        const pairs = parsePunctReply(content, n);
        if (!pairs) { lastErr = '未返回合法标点对: ' + String(content || '').slice(0, 160); }
        else if (!punctPairsSane(pairs, hi - lo)) {
          lastErr = `标点密度异常（${pairs.length} 个标点 / ${hi - lo} 词）—— 疑似"每词都加逗号"，已丢弃`;
          dense = pairs;
          console.error('[reseg] ' + lastErr);
        } else return { pairs };
      } catch (e) {
        lastErr = String((e && e.message) || e);
        const kind = e && e.kind;
        if (kind === 'truncated') { lastErr = '输出被截断'; return null; }     // 交给调用方拆批
        if (kind === 'net' || kind === 'rate' || kind === 'timeout') {
          const wait = Math.min(8000, (e.retryAfter ? e.retryAfter * 1000 : 900 * Math.pow(3, a)));
          await sleep(wait);
        } else await sleep(600);
      }
    }
  }
  // 抢救: 密度异常通常是"逗号给太密"（喊叫、感叹的段落）—— 把逗号全丢掉、只留句末标点再判一次。
  // 有标点总比整批退回"按停顿兜底"好，而且句末标点的密度天然低。
  if (dense) {
    const only = dense.filter(p => p[1] !== ',');
    if (only.length && punctPairsSane(only, hi - lo)) {
      console.error(`[reseg] 批次 ${label} 密度异常, 已抢救: 只保留句末标点（${only.length} 个 / ${hi - lo} 词）`);
      return { pairs: only, salvaged: true };
    }
  }
  console.error(`[reseg] 批次 ${label} 失败：${lastErr}`);
  return { failed: true, err: lastErr };
}

/** 词表指纹：断点续跑的凭据（词数 + 首尾几个词），asr.json 换了就作废 */
function wordsSig(words) {
  const w = words || [];
  return w.length + '|' + w.slice(0, 4).map(x => x.word).join(' ') + '|' + w.slice(-4).map(x => x.word).join(' ');
}

/** 在 [lo,hi) 里找一个"最像句界"的拆点（优先本区间内最大的停顿，靠中间更好） */
function findSplit(words, lo, hi) {
  const mid = (lo + hi) / 2;
  let best = -1, bestScore = -Infinity;
  for (let i = lo; i < hi - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap <= PAUSE_SPLIT) continue;
    const score = gap - Math.abs(i - mid) * 0.01;      // 停顿越大越好，越靠中间越好
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best < 0 ? -1 : best + 1;                     // 拆点 = 下一批的 lo
}

/** 递归处理一个批次：失败就拆半（优先在停顿处拆），拆到 MIN_SPLIT_WORDS 为止。
 *  返回 { pairs[, salvaged][, partial] }（partial = 有一半没做出来，那半的词按停顿兜底）；
 *  两半都做不出来 → 返回 { failed: true }，由**调用方**决定这批怎么办（不再一路抛到顶）。 */
async function resegRange(chat, words, lo, hi, depth, onProgress, label) {
  const r = await askBatch(chat, words, lo, hi, onProgress, label);
  if (r && !r.failed) return r;                        // { pairs } / { pairs, salvaged }
  const len = hi - lo;
  if (len > MIN_SPLIT_WORDS && depth < 4) {
    let cut = findSplit(words, lo, hi);
    if (cut < 0) cut = lo + Math.ceil(len / 2);
    console.error(`[reseg] 批次 ${label} 拆半重试：${lo}-${cut - 1} / ${cut}-${hi - 1}`);
    const head = await resegRange(chat, words, lo, cut, depth + 1, onProgress, `${label}a`);
    const tail = await resegRange(chat, words, cut, hi, depth + 1, onProgress, `${label}b`);
    const bad = (x) => !x || x.failed;
    if (bad(head) && bad(tail)) return head || tail;   // 两半都不行 → 报失败（由调用方放弃这批）
    return {
      pairs: (bad(head) ? [] : head.pairs).concat(bad(tail) ? [] : tail.pairs),
      salvaged: !!((head && head.salvaged) || (tail && tail.salvaged)),
      partial: bad(head) || bad(tail),
    };
  }
  return { failed: true, err: (r && r.err) || '未知原因' };
}

/** 语义分句主入口。chat(messages, opts) → Promise<string>（llmChat 的包装）。
 *  opts.splitOnComma 恢复"逗号也切句"的旧行为；opts.onLog 写进度日志。
 *  opts.stats        收集统计（skipped / salvaged / partial / fromCheckpoint），调用方负责展示。
 *  opts.loadCheckpoint() / opts.saveCheckpoint(i, pairs, meta)  断点续跑（存储由调用方负责，
 *                    本模块保持纯净）：每批成功就落盘，重试 / 服务重启后跳过做过的批次。
 *  单个批次做不出来**不再拖垮整步**：这些词不加标点、按停顿兜底，其余批次照常；
 *  只有**所有批次**都没做出标点（模型根本不能用）才抛错。
 *  词太少(<8)直接原样返回 —— 没有切的必要。 */
async function resegWithLLM(chat, segs, onProgress, opts) {
  const words = flattenWords(segs);
  if (words.length < 8) return segs;
  const o = opts || {};
  const onLog = o.onLog || (() => {});
  const stats = o.stats || {};
  stats.skipped = stats.skipped || [];
  stats.salvaged = stats.salvaged || [];
  stats.fromCheckpoint = stats.fromCheckpoint || 0;

  const batches = planBatches(words);
  onLog(`切批方案：${words.length} 词 → ${batches.length} 批（批边界优先落在停顿处）`);

  // 断点续跑：上一轮已经做好的批次直接用（词表指纹对得上才算数）
  const sig = wordsSig(words);
  const ck = (typeof o.loadCheckpoint === 'function') ? o.loadCheckpoint() : null;
  const done = (ck && ck.words === words.length && ck.sig === sig && ck.batches) ? ck.batches : {};
  const doneIdx = Object.keys(done).filter(k => Array.isArray(done[k]));
  if (doneIdx.length) {
    stats.fromCheckpoint = doneIdx.length;
    onLog(`断点续跑：${doneIdx.length}/${batches.length} 批上一轮已经做过，跳过`);
  }

  const allPairs = [];
  for (let b = 0; b < batches.length; b++) {
    const [lo, hi] = batches[b];
    const label = `${b + 1}/${batches.length}`;
    let pairs = null;
    if (Array.isArray(done[b])) {
      pairs = done[b];
    } else {
      try {
        const r = await resegRange(chat, words, lo, hi, 0, onProgress, label);
        if (r && r.failed) {
          stats.skipped.push({ label, err: r.err || '未知原因' });
          onLog(`批次 ${label} 没做出标点（${String(r.err || '').slice(0, 80)}），这些词按停顿兜底`);
        } else {
          pairs = ((r && r.pairs) || []).filter(p => p[0] >= lo && p[0] < hi);   // 保险: 只接受本批范围内的标点
          if (r.salvaged) stats.salvaged.push(label);
          if (r.partial) stats.partial = (stats.partial || 0) + 1;
        }
      } catch (e) {
        stats.skipped.push({ label, err: String((e && e.message) || e) });
        onLog(`批次 ${label} 没做出标点（${String((e && e.message) || e).slice(0, 80)}），这些词按停顿兜底`);
        pairs = null;
      }
    }
    if (pairs) {
      allPairs.push(...pairs);
      if (typeof o.saveCheckpoint === 'function') {
        try { o.saveCheckpoint(b, pairs, { words: words.length, sig, total: batches.length, model: o.model || '' }); } catch {}
      }
      // 每批完成写一行日志：52 批要跑几分钟，没有这行用户只能看到进度条"不动"（实测被当成卡死）
      if (!Array.isArray(done[b])) onLog(`批次 ${label} 完成（累计 ${hi}/${words.length} 词）`);
    }
    if (onProgress) {
      const frac = (b + 1) / batches.length;
      onProgress(frac, `语义分句中 … 批次 ${b + 1}/${batches.length}（${Math.round(frac * 100)}%）`);
    }
  }

  // 整批全军覆没 = 模型根本不能用（配错模型/额度/接口），这时抛错让用户去修，别静默退回引擎断句
  if (batches.length && stats.skipped.length === batches.length) {
    throw new LlmError(`语义分句失败（${batches.length} 批全部没做出标点）：${stats.skipped[0].err}`, 'format');
  }
  applyPunct(words, allPairs);
  const groups = mergeTinyFrags(groupResegWords(words, o));
  return groupsToSegments(groups);
}

module.exports = {
  SENT_PUNCT, cleanWordText, flattenWords, parsePunctReply, applyPunct,
  groupResegWords, mergeTinyFrags, groupsToSegments, resegWithLLM,
  planBatches, softFold, wordsSig,
};
