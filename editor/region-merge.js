/**
 * 把「完整字幕里的某一段」并进**已有稿件**（多人协作：各人分一段做，再合起来）。
 *
 * 场景：一份稿子分给几个人做，每人拿到的都是**完整时间轴的字幕文件**
 * （不是从 0 开始的片段）—— 所以**不需要任何偏移**：直接在统一的绝对时间轴上，
 * 把落在目标区间里的行挑出来，放到目标视频的对应位置即可。
 *
 * 三条硬约定：
 *
 * 1. **默认只填空档**。碰到已有字幕就**不动**、并把它列进 conflicts 让用户决定。
 *    静默覆盖别人的成果是这类工具最不可原谅的行为。
 * 2. **按区间取行，不按内容猜**。区间由用户显式给出；本模块不推断"这几行大概是一段"。
 * 3. **零长行给一个最小宽度**（MIN_ROW_SEC）。字幕文件里偶尔有 start == end 的行，
 *    直接放进项目会变成"看不见也选不中"的幽灵行。不是丢弃（那是丢内容），
 *    而是撑到最小宽度 —— 内容保住，且能被看见、被编辑。
 *
 * 本模块**只做判定，不改任何东西**：返回一个计划（plan），由调用方去执行。
 * 这样它可以离线单测，也让"先预览再应用"成为天然结构。
 */

/** 零长行撑到这个宽度（秒）——太窄的字幕块在时间轴上点不中 */
const MIN_ROW_SEC = 0.2;

/** 把区间外的行剔掉，区间内的原样留下（时间**不动**） */
function pickInRange(cues, start, end, active) {
  const list = (Array.isArray(cues) ? cues : []).slice()
    .filter(c => c && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)))
    .sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end));
  if (!active) return list.map(c => Object.assign({}, c));
  return list.filter(c => overlaps(Number(c.start), Number(c.end), start, end)).map(c => Object.assign({}, c));
}

/** 这两个区间有重叠吗（用与 itemsInRange 一致的容差，避免边界抖动误判） */
function overlaps(a1, a2, b1, b2, eps = 1e-3) {
  return a2 > b1 + eps && a1 < b2 - eps;
}

/**
 * 生成合并计划。
 *
 * @param {Array} cues     导入文件里的**完整**行 [{start, end, lines:[主语言, 副语言...]}]
 * @param {Array} existing 项目现有行 [{start, end, text?}]（只要起止时间）
 * @param {number} start   目标区间起点（秒，目标视频的绝对时间）
 * @param {number} end     目标区间终点（秒）
 * @returns {{
 *   ok:boolean, error:string,
 *   range:{start:number,end:number}|null,
 *   items:Array,      可放进去的行（已切好主/副语言）
 *   conflicts:Array,  与已有行撞上的行
 *   stretched:number, 被撑到最小宽度的行数
 *   outOfOrder:number,源文件里时间倒挂的行数
 *   picked:number     落在区间内的行数（含冲突的）
 * }}
 */
function planRegionMerge(cues, existing, start, end) {
  const src = Array.isArray(cues) ? cues : [];
  if (!src.length) {
    return { ok: false, error: '这个文件里没解析出字幕行', range: null, items: [], conflicts: [], stretched: 0, outOfOrder: 0, picked: 0 };
  }
  const s = Number(start) || 0;
  const e = Number(end);
  if (!Number.isFinite(e) || e <= s) {
    return { ok: false, error: '结束时间必须大于开始时间', range: null, items: [], conflicts: [], stretched: 0, outOfOrder: 0, picked: 0 };
  }
  const ex = (Array.isArray(existing) ? existing : [])
    .filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map(r => ({ start: r.start, end: r.end, text: r.text || '' }))
    .sort((a, b) => a.start - b.start);

  // 源文件里时间倒挂（end < start）的行数 —— 记下来是为了告诉用户"你的文件有问题"，
  // 而不是默默把它撑成最小宽度让人以为一切正常
  const outOfOrder = src.filter(c => Number(c.end) < Number(c.start)).length;

  const picked = pickInRange(src, s, e, true);
  const items = [];
  const conflicts = [];
  let stretched = 0;
  for (const c of picked) {
    let cs = Number(c.start), ce = Number(c.end);
    const fix = ce <= cs;                            // 零长或倒挂
    if (fix) { ce = cs + MIN_ROW_SEC; stretched++; }
    const main = (c.lines && c.lines.length) ? String(c.lines[0] || '') : '';
    const sub = (c.lines && c.lines.length > 1) ? c.lines.slice(1).join(' ').trim() : '';
    const row = { start: cs, end: ce, zh: main.trim(), en: sub, stretched: fix };
    if (!row.zh && !row.en) continue;                // 空行丢弃（没有内容可放）
    // 与项目里**任何**已有行重叠 → 冲突（不静默覆盖）
    const hit = ex.find(r => overlaps(cs, ce, r.start, r.end));
    if (hit) conflicts.push(Object.assign({}, row, { with: { start: hit.start, end: hit.end, text: hit.text } }));
    else items.push(row);
  }
  items.sort((a, b) => a.start - b.start);
  conflicts.sort((a, b) => a.start - b.start);
  const all = items.concat(conflicts);
  const range = all.length
    ? { start: Math.min(...all.map(r => r.start)), end: Math.max(...all.map(r => r.end)) }
    : null;
  return { ok: true, error: '', range, items, conflicts, stretched, outOfOrder, picked: picked.length };
}

/** 一行的可读摘要（预览列表用） */
function rowLabel(r, max = 34) {
  const s = (r && (r.zh || r.en)) || '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** 给用户看的一句话总结 */
function mergeSummary(plan) {
  if (!plan || !plan.ok) return '';
  const f = (n) => {
    n = Math.max(0, Number(n) || 0);
    const ss = String(Math.floor(n % 60)).padStart(2, '0');
    const mm = Math.floor(n / 60) % 60, hh = Math.floor(n / 3600);
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  if (!plan.picked) return '这个区间里没有字幕（换个范围试试）';
  const parts = [`区间内 ${plan.picked} 行：可导入 ${plan.items.length} 行`];
  if (plan.conflicts.length) parts.push(`与已有字幕重叠 ${plan.conflicts.length} 行`);
  if (plan.range) parts.push(`占 ${f(plan.range.start)} ~ ${f(plan.range.end)}`);
  if (plan.stretched) parts.push(`${plan.stretched} 行是零长、已撑到 ${MIN_ROW_SEC}s`);
  if (plan.outOfOrder) parts.push(`${plan.outOfOrder} 行起止时间倒挂（源文件可能有问题）`);
  return parts.join('；');
}

/**
 * 渲染计划里某一行的做法：只填空档 → 冲突行整行不做。
 * @returns {{ add:Array, skipped:Array }}
 */
function resolveFillOnly(plan) {
  const p = plan || {};
  return { add: (p.items || []).slice(), skipped: (p.conflicts || []).slice() };
}

/**
 * 渲染计划里某一行的做法：用户确认后，冲突处**用导入的替换**（覆盖）。
 * 调用方负责先把被覆盖的已有行删掉。
 * @returns {{ add:Array, replace:Array }}
 *   replace = 需要先删掉的已有行的范围（去重合并后）
 */
function resolveReplace(plan) {
  const p = plan || {};
  const replace = [];
  for (const c of (p.conflicts || [])) {
    const w = c.with;
    const last = replace[replace.length - 1];
    if (last && w.start <= last.end + 1e-6) last.end = Math.max(last.end, w.end);
    else replace.push({ start: w.start, end: w.end });
  }
  return { add: (p.items || []).concat(p.conflicts || []), replace };
}

export {
  MIN_ROW_SEC, pickInRange, overlaps, planRegionMerge, rowLabel, mergeSummary,
  resolveFillOnly, resolveReplace,
};
