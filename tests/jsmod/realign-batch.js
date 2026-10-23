/**
 * 全片逐词重校对的**批量对齐**纯逻辑。
 *
 * 为什么需要：Qwen3-ForcedAligner 每调用一次就有一份固定开销（CUDA 预热、预处理、
 * 输出解码）。4 小时稿件有 4254 行，逐行调用实测约 0.4s/行 → 近半小时；按 ≤60s
 * 把相邻行合并成一段再对齐，调用数降到约 321 段（本机 8GB 显存实测约 7~8 分钟）。
 * 逐词时间仍按行切回。
 *
 * 设计约束（与 docs/PROJECT.md §3「逐词时间重排」一致）：
 *  · 只在**相邻行**之间合并；行间空档 > 4s 就断开（跨场景的长静音不硬连）；
 *  · 单段音频跨度 ≤ 60s（8GB 显存上 120s 段会逼近 CUDA 内存上限、偶发卡顿）；
 *  · 每段最多 24 行，避免文本过长；
 *  · 每个成员仍走 align.js 的 planBlock 做 token 映射/单调性修正，失败则如实标记。
 *
 * 纯逻辑、不碰文件/模型：见 tests/realign-batch-test.mjs。
 */
'use strict';

const align = require('./align.js');

const MAX_CHUNK_SEC = 60;
const MAX_CHUNK_GAP = 4;
const MAX_CHUNK_ITEMS = 24;

/** 与 align.js 的 tokenize 同口径：一段连续的非空白算一个词。 */
function tokenCount(text) {
  const s = String(text == null ? '' : text).trim();
  return s ? s.split(/\s+/).length : 0;
}

/**
 * 把逐行任务合并成对齐段。
 * @param items [{ id, start, end, from, to, text }] —— from/to 是带 padding 的音频区间
 * @returns [{ id, start, end, text, members, tokenCount }]
 */
function planBatches(items) {
  const batches = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it) continue;
    const from = Number(it.from), to = Number(it.to);
    if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) continue;
    const text = String(it.text == null ? '' : it.text).trim();
    const last = batches[batches.length - 1];
    const gap = last ? from - last.end : Infinity;
    const span = last ? Math.max(last.end, to) - last.start : Infinity;
    if (last && gap <= MAX_CHUNK_GAP && span <= MAX_CHUNK_SEC && last.members.length < MAX_CHUNK_ITEMS) {
      last.members.push(it);
      last.end = Math.max(last.end, to);
      last.text = last.text ? last.text + ' ' + text : text;
      last.tokenCount += tokenCount(text);
    } else {
      batches.push({
        id: batches.length, start: from, end: to, text,
        members: [it], tokenCount: tokenCount(text),
      });
    }
  }
  return batches;
}

function itemResult(plan, item) {
  const words = (plan && plan.words) || [];
  const valid = words.length > 0 && words.every(w => Number.isFinite(w.s) && Number.isFinite(w.e)
    && w.e > w.s && w.s >= Number(item.start) - 0.011 && w.e <= Number(item.end) + 0.011);
  return {
    ok: valid,
    words,
    note: valid ? '' : '对齐器没有给出有效的逐词时间，保留原时间',
  };
}

/**
 * 把每个对齐段的词时间切回成员行。
 *
 * @param batches planBatches 的结果
 * @param chunkWords Map<batchId, [{word,start,end}]>（绝对时间）
 * @returns Map<itemId, { ok, words, note }>
 */
function assignChunkWords(batches, chunkWords) {
  const got = chunkWords instanceof Map ? chunkWords : new Map(Object.entries(chunkWords || {}));
  const out = new Map();
  for (const b of (Array.isArray(batches) ? batches : [])) {
    const rec = (got.get(b.id) || [])
      .map(w => ({ word: String((w && w.word) || ''), start: Number(w && w.start), end: Number(w && w.end) }))
      .filter(w => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
    if (!rec.length) {
      for (const m of b.members) out.set(m.id, { ok: false, words: [], note: '对齐器没有返回结果' });
      continue;
    }
    const whole = align.planBlock(b.text, { start: b.start, end: b.end }, rec,
      { minAnchorRatio: 0, rawTimes: true });
    /* 正常情况下 planBlock 对整段文本输出的词数 = 段内所有行的 token 数之和。
     * 对不上时不用"按比例切"这种会错位的办法，退回让每行自己对整段词做序列映射；
     * 结果仍不可信的行由 itemResult 标 ok:false，保留原时间。 */
    if (!whole.words || whole.words.length !== b.tokenCount) {
      for (const m of b.members) {
        out.set(m.id, itemResult(align.planBlock(m.text, { start: m.start, end: m.end }, rec,
          { minAnchorRatio: 0, rawTimes: true }), m));
      }
      continue;
    }
    let off = 0;
    for (const m of b.members) {
      const n = tokenCount(m.text);
      const slice = whole.words.slice(off, off + n);
      off += n;
      const plan = align.planBlock(m.text, { start: m.start, end: m.end },
        slice.map(w => ({ word: w.w, start: w.s, end: w.e })),
        { minAnchorRatio: 0, rawTimes: true });
      out.set(m.id, itemResult(plan, m));
    }
  }
  return out;
}

module.exports = {
  MAX_CHUNK_SEC, MAX_CHUNK_GAP, MAX_CHUNK_ITEMS,
  tokenCount, planBatches, assignChunkWords,
};
