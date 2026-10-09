/**
 * 修复「逐词行被清空」的字幕（纯逻辑，可离线单测）。
 *
 * ## 实测的损坏形态
 *
 * 逐行对比正常稿件与坏文件，**时间戳一模一样**，只有文本丢了：
 *
 *     正常:                                     坏掉:
 *     [中文字幕] 0    →2.32  中文整句           [中文字幕] 0    →0.19  and in the end storm…
 *     [Default]  0    →0.19  英文（含该词高亮）  [Default]  0    →0.19  (空)
 *     [Default]  0.19 →0.85  英文（含该词高亮）  [中文字幕] 0.19 →0.85  and in the end storm…
 *     …                                        [Default]  0.19 →0.85  (空)
 *     [Default]  1.89 →2.32  英文（含该词高亮）  …
 *                                              [Default]  0    →2.32  (空)
 *
 * 两件事同时发生：
 *   ① 逐词行（`Default` 样式）的**文本被清空**
 *   ② 那份文本（**连 `{\c&H..&}` 高亮标签一起丢了**）被写到**时间戳完全相同**的另一行上
 *   ③ 中文整句本身没丢
 *
 * 结果就是：画面上英文永远整句亮着（逐词行没内容 → 没有逐词推进），
 * 中文位置显示英文，列表里英文列是空的。
 *
 * ## 修复规则（判据唯一，不猜）
 *
 *   对每个**空壳行**（文本为空）：
 *     找**起止时间完全相同**、文本非空、且**不是中文原文**的行作为"文本来源"
 *     —— 必须**唯一**，否则跳过
 *   把来源行的文本搬进空壳行；来源行随后删除（内容已归位，留着会重复显示）。
 *   含 CJK 的行一律不动。
 *
 * 关键：**不要求来源行带高亮标签**。实测损坏时标签一起丢了，
 * 所以"有没有标签"不能当判据；判据只能是"同一时间戳 + 文本非空 + 唯一 + 非中文"。
 *
 * 配对不唯一或找不到来源 → **跳过**并记入 `skipped`。宁可少修，不可修错。
 *
 * ## 为什么可以放心自动跑
 *
 *   · 正常稿件里**没有空行**，所以本模块在正常稿件上**什么都不做**（已测 0 误报）
 *   · 所有判定都基于"时间戳完全相同"这一硬事实，不依赖样式名语义
 *     （用户的逐词样式叫 `Default`、整句样式叫 `中文字幕`，名字说明不了什么）
 *   · 任何不确定的情况一律跳过，且返回 `skipped` 说明原因
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const EMPTY = (s) => !String(s || '').replace(/\{[^}]*\}/g, '').trim();
const plain = (s) => String(s || '').replace(/\{[^}]*\}/g, '');
const key = (r) => Number(r.start).toFixed(3) + '|' + Number(r.end).toFixed(3);

/**
 * 分析损坏。输入是"每行 {start, end, text}"（样式可选，判定不依赖它）。
 * @returns {{damaged:boolean, reason:string, stats:Object,
 *            pairs:Array<{husk:Object, source:Object}>, skipped:Array}}
 */
function analyzeDamage(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r
    && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)));
  const husks = list.filter(r => EMPTY(r.text));
  if (!husks.length) {
    return { damaged: false, reason: '没有文本为空的行', pairs: [], skipped: [],
      stats: { husks: 0, matched: 0, unmatched: 0 } };
  }
  const nonEmpty = new Map();
  for (const r of list) {
    if (EMPTY(r.text)) continue;
    const k = key(r);
    if (!nonEmpty.has(k)) nonEmpty.set(k, []);
    nonEmpty.get(k).push(r);
  }

  const pairs = [];
  const skipped = [];
  const used = new Set();
  for (const h of husks) {
    const cand = (nonEmpty.get(key(h)) || []).filter(r => !used.has(r));
    if (!cand.length) { skipped.push({ husk: h, why: '找不到同时间戳的文本' }); continue; }
    if (cand.length > 1) { skipped.push({ husk: h, why: '同时间戳有多条非空行（不唯一）' }); continue; }
    const src = cand[0];
    if (CJK.test(plain(src.text))) {
      skipped.push({ husk: h, why: '同时间戳的非空行是中文原文，不能搬走' });
      continue;
    }
    pairs.push({ husk: h, source: src });
    used.add(src);
  }
  const damaged = pairs.length > 0;
  return {
    damaged,
    reason: damaged ? '' : '没有可安全配对的行（不做任何修改更安全）',
    pairs, skipped,
    stats: { husks: husks.length, matched: pairs.length, unmatched: skipped.length },
  };
}

/** 生成修复方案。只搬文本，时间戳不动。 */
function planRepair(analysis) {
  const edits = [];
  const deletes = [];
  for (const p of analysis.pairs || []) {
    edits.push({ row: p.husk, text: p.source.text, why: '把缺失的文本搬回空壳行' });
    deletes.push({ row: p.source, why: '同时间戳的副本，文本已归位' });
  }
  if (deletes.length !== edits.length) {
    return { edits: [], deletes: [], summary: '内部校验失败（增删数不一致），不做任何修改' };
  }
  const n = edits.length;
  return {
    edits, deletes,
    summary: n ? `修复 ${n} 行：把同一时间戳上错放的文本搬回空白的逐词行` : '没有需要修复的行',
  };
}

/** 仅用于报告 */
function isWordStyle(style) { return /word|逐词/i.test(String(style || '')); }

/** 给用户看的一句话 */
function repairSummary(analysis, plan) {
  if (!analysis || !analysis.damaged) return '';
  const n = plan ? plan.edits.length : 0;
  const sk = (analysis.skipped || []).length;
  return `已修复 ${n} 行错位的逐词字幕` + (sk ? `（另有 ${sk} 行形态不确定，已跳过）` : '');
}

export { analyzeDamage, planRepair, isWordStyle, repairSummary };
