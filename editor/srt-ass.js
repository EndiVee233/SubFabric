/**
 * SRT → 逐词 ASS 的纯逻辑（供「全片逐词重校对」在 SRT 稿件上直接转逐词用）。
 *
 * 背景：编辑器里 SRT 没有逐词时间，也没有角色轨。用户在 SRT 稿件上点「全片逐词重校对」时，
 * 用 Qwen3-ForcedAligner 按每行的英文原文重新量出逐词时间，再交给服务端的 writeSubtitle
 * 生成一份逐词 ASS。这里只做两件**不碰文件、不碰模型**的事：
 *   ① 把 SRT 解析出来的行整理成对齐目标；
 *   ② 把对齐结果（勾选项）合成为 writeSubtitle 需要的 segments。
 * 因此可以离线单测，见 tests/srt-ass-test.mjs。
 *
 * 用 CJS 导出：server.js 直接 require；单测也用 require 读同一份实现。
 */
'use strict';

const { splitEnglishWords, allocateWordTimes } = require('./js/karaoke.js');

/** 行文本归一化：合并空白；标点后补一个空格，使「词」的划分与编辑器的 splitEnglishWords 一致。
 *  例：'SMP,I plan.to nuke' → 'SMP, I plan. to nuke'（编辑器本来就是按这些标点切词的）。
 *  不对原文做别的改动 —— 大小写、缩写、数字都原样保留。 */
function normalizeSrtText(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([,\.\?\!])(?=[^\s.,?!])/g, '$1 ');
}

/** 这一行有没有英文原文。纯中文/纯符号的行没有可对齐的英文（对齐器按 English 跑），
 *  转换时只保留它的中文行，不伪造英文逐词。
 *  `[角色名]` 与 `{覆盖标签}` 不算英文 —— 否则「[Spk] 中文」会被误判成可对齐行。 */
function hasEnglish(text) {
  return /[A-Za-z]/.test(String(text == null ? '' : text)
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' '));
}

/** 对齐目标的身份：保持与 ASS realign 的 targetKey 一样"内容 + 位置"都参与，
 *  稿件在预览期间被改动时，apply 端会用同一口径重新算 key，对不上就不写。 */
function srtTargetKey(index, start, end, text) {
  return JSON.stringify(['srt', Number(index), Number(start), Number(end), String(text)]);
}

/**
 * 把 SRT 行整理成可交给对齐器的目标。
 *
 * @param rows 服务端 subtitleSource() 解析出的行：{ start, end, text, zh }
 * @returns [{ index, start, end, text, targetKey }] —— 只含**有英文原文**的行；
 *          纯中文行不参与对齐（对齐器是 English），转换时仍会作为中文行保留。
 */
function planSrtTargets(rows) {
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    if (!row) return;
    const start = Number(row.start), end = Number(row.end);
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0)) return;
    const text = normalizeSrtText(row.text);
    if (!text || !hasEnglish(text)) return;
    out.push({ index, start, end, text, targetKey: srtTargetKey(index, start, end, text) });
  });
  return out;
}

/**
 * 把对齐结果合成为 writeSubtitle 需要的 segments。
 *
 * 规则（与前端预览的说明保持一致）：
 *  · 勾选且对齐成功的行：用 Qwen3 给出的逐词时间；
 *  · 未勾选 / 对齐失败：在该行 [start,end] 内按字母数平均分配（**不能让行没有词**，
 *    否则逐词 ASS 会丢掉这一行）；
 *  · 词数与 splitEnglishWords 对不上（对齐器把标点并进词里）：退回平均分配 ——
 *    半对半错的词时间比均匀分配更糟；
 *  · 纯中文行：不写英文逐词（text=''、words=[]），只把中文写进译文轨，原文不丢。
 *
 * @param rows         SRT 行（与 planSrtTargets 同一份）
 * @param targets      planSrtTargets(rows)
 * @param items        对齐作业产出的 items（含 targetKey / ok / words）
 * @param pickedKeys   用户勾选要应用的目标 key 集合（Set 或数组）
 * @returns { segs, trans, aligned, total } —— segs[].words 已转成 writeSubtitle 需要的
 *          `{word,start,end}`；trans 与 segs 一一对应
 */
function buildSrtSegments(rows, targets, items, pickedKeys) {
  const picked = pickedKeys instanceof Set
    ? pickedKeys : new Set(Array.isArray(pickedKeys) ? pickedKeys : []);
  const byKey = new Map();
  for (const it of (Array.isArray(items) ? items : [])) {
    if (it && typeof it.targetKey === 'string') byKey.set(it.targetKey, it);
  }
  const targetByIndex = new Map();
  for (const t of (Array.isArray(targets) ? targets : [])) targetByIndex.set(t.index, t);

  const segs = [], trans = [];
  let aligned = 0;
  const list = Array.isArray(rows) ? rows : [];
  for (let index = 0; index < list.length; index++) {
    const row = list[index];
    if (!row) continue;
    const start = Number(row.start), end = Number(row.end);
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0)) continue;
    const zh = normalizeSrtText(row.zh);
    const t = targetByIndex.get(index);
    if (!t) {
      /* 纯中文行（或没有英文原文）：只写中文行。text 留空 → writeSubtitle 不会为它生成
       * 英文事件，但中文轨仍会写出来，内容不丢。 */
      const chinese = zh || normalizeSrtText(row.text);
      if (!chinese) continue;
      segs.push({ start, end, text: '', words: [] });
      trans.push(chinese);
      continue;
    }
    const tokenCount = splitEnglishWords(t.text).length;
    /* ⚠ writeSubtitle 吃的是 asr.json 的 `{word,start,end}`（不是编辑器的 `{w,s,e}`）。
     * 这里转一次口径，否则会写出"空词 + NaN 时间"的逐词 ASS。 */
    const toAsrWords = list => list.map(x => ({ word: x.w, start: x.s, end: x.e }));
    let words = null;
    const it = byKey.get(t.targetKey);
    if (it && it.ok && picked.has(t.targetKey) && Array.isArray(it.words) && it.words.length) {
      const got = it.words
        .map(w => ({ w: String((w && w.w) || ''), s: Number(w && w.s), e: Number(w && w.e) }))
        .filter(w => w.w && Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s);
      if (got.length === tokenCount) { words = toAsrWords(got); aligned++; }
    }
    if (!words) words = toAsrWords(allocateWordTimes(splitEnglishWords(t.text), start, end));
    if (!words.length) continue;
    segs.push({ start, end, text: t.text, words });
    trans.push(zh);
  }
  return { segs, trans, aligned, total: segs.length };
}

module.exports = {
  normalizeSrtText, hasEnglish, srtTargetKey,
  planSrtTargets, buildSrtSegments,
};
