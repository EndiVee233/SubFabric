/**
 * 长稿反思：让 LLM 通读全片，找出"语句不通顺"的地方，给出可执行的修正操作。
 *
 * 三条来自用户决定的要点：
 *   1. **结合全片反思** —— 送进模型的是切好批的**全片**行表，行号用全片编号；
 *      相邻批之间留重叠，让模型看到跨批衔接；跨批结论由 mergeFindings() 统一消解，
 *      不让模型在批边界上各说各话。
 *   2. **预览优先** —— 这里只**产出建议**（findings），不碰字幕。用户在预览里
 *      逐条勾选或「全部接受」，由调用方决定执行哪些。
 *   3. **同稿只重识别一遍** —— 建议之间的时间区间由 planRegions() **求并**：
 *      重叠或相邻的区间合成一段，每段只跑一次重识别。
 *
 * 产出的操作只有两类（够用且可校验），外加一类补充识别：
 *   · merge       把 [from..to] 这几行**当成一段**去重识别 —— 覆盖"没说完"、
 *                 "被硬切"、"拼接痕迹"：本质都是"这段音频该一起听"。
 *   · reidentify  只把 [from..to] 重识别 —— 覆盖"疑似听错/漏词"。
 *   两者在音频上是同一个动作（重识别某区间），区别只在解释与默认勾选。
 *   · gap         两行之间**有一段音频没被识别出内容**。
 *                 ⚠ 这一类由 findTimeGaps() **确定性检出**（扫逐行时间轴的空档），
 *                 不依赖模型"感觉" —— 早期只让模型报 gap，结果它把 4.75 秒的静音
 *                 当成了"两行衔接"、报成 merge，那段漏掉的内容永远不会被补回来（实测踩过）。
 *                 现在 gap 也**可执行**：补识别那一段，把漏掉的话找回来。
 */

// 每批送进去的行数。实测一行英文约 60~90 字符，60 行约 4~5K 字符，
// 配合精简的系统提示，8K 上下文的模型也放得下。
const BATCH_LINES = 60;
// 相邻批之间**重叠**的行数：让模型看到跨批上下文，
// 否则批边界上的"尾巴悬空"会被漏判（那恰恰是最常见的一类）。
const BATCH_OVERLAP = 4;
// 生成重识别区间时，目标左右各带多少行（含目标行本身）
// 生成重识别区间时，目标行前后各留多少**秒**（不是行数 —— 行的时长差异极大，
// 按行取会让密集稿子的上下文窗口首尾相接、整片并成一段，粒度尽失。实测踩过）
const PAD_SEC = 2;
// 单段重识别区间的时长上限：避免一条超长建议（或前后被撑得过大）吞掉全片
const MAX_REGION_SEC = 30;
// 兼容旧名字（服务端配置里的 ctxLines 仍可读，但不再按行取上下文）
const CTX_LINES = 3;
// 一行里超长的文本截断（模型不需要读完整句就能判断语法完整性）
const MAX_CHARS_PER_LINE = 200;
// 两行之间空档 ≥ 这个秒数就当成"有内容没被识别出来"
const GAP_MIN_SEC = 3;
// 单段空档超过这个秒数就不再当成"漏识别"（多半是音乐/音效/停播，不是漏词）
const GAP_MAX_SEC = 30;

/**
 * 两行之间的空档（秒）。有逐词数据就用词的**真实**边界，否则退回行的边界。
 *
 * 为什么优先用词：行的 start/end 被 reseg 的 groupsToSegments 规整过
 * （后一行起点被推到前一行终点，杜绝重叠），看上去永远严丝合缝 ——
 * 按行时间算出来的空档恒为 0，真实静音被完全掩盖。
 * 实测：全片唯一 4.75 秒的空档，按行看是 0，按词时间是 4.75。
 *
 * @returns {start,end,dur} 或 null（数据不足 / 没有空档）
 */
function gapBetween(prev, cur) {
  if (!prev || !cur) return null;
  const pw = Array.isArray(prev.words) ? prev.words : [];
  const cw = Array.isArray(cur.words) ? cur.words : [];
  const tailArr = pw.length ? pw.map(w => Number(w.end)).filter(Number.isFinite) : [];
  const headArr = cw.length ? cw.map(w => Number(w.start)).filter(Number.isFinite) : [];
  const tail = tailArr.length ? Math.max(...tailArr) : Number(prev.end);
  const head = headArr.length ? Math.min(...headArr) : Number(cur.start);
  if (!Number.isFinite(tail) || !Number.isFinite(head)) return null;
  const dur = head - tail;
  if (!(dur > 0)) return null;
  return { start: +tail.toFixed(3), end: +head.toFixed(3), dur: +dur.toFixed(3) };
}

/**
 * 确定性检出"两行之间有一段音频没被识别出内容"。
 *
 * 为什么不交给模型判断：模型的输入是**文本**，它看不到时间轴上的静音，
 * 只能靠语义"感觉"哪里不连贯。实测（41 行 / 235.6 秒的稿子）：
 * 全片唯一一处 ≥3 秒的空档是 `78.23~82.98`（4.75 秒，第 13、14 行之间），
 * 模型没有把它报成 gap，而是报成了 `merge 12~14` —— 于是那段漏掉的内容
 * **永远不会被当成"要补回来"的东西**（gap 当时只是提示、不参与执行）。
 *
 * 这里直接扫时间轴，和模型无关，所以不会漏。
 *
 * @param rows  [{start,end,words?}] 全片行
 * @param opts  { minSec, maxSec }
 * @returns [{ kind:'gap', from, to, start, end, dur, reason, confidence }]
 *          from/to 是**夹着这段空档的两行行号**（1-based）
 */
function findTimeGaps(rows, opts) {
  const o = (typeof opts === 'object' && opts) ? opts : {};
  const minSec = Number.isFinite(o.minSec) ? o.minSec : GAP_MIN_SEC;
  const maxSec = Number.isFinite(o.maxSec) ? o.maxSec : GAP_MAX_SEC;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return [];
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const gap = gapBetween(list[i - 1], list[i]);
    if (!gap) continue;
    if (!(gap.dur >= minSec)) continue;
    if (gap.dur > maxSec) continue;         // 太长：多半是音乐/停播，不是漏词，别去重识别
    out.push({
      kind: 'gap',
      from: i, to: i + 1,                   // 夹在第 i 行与第 i+1 行之间
      start: gap.start, end: gap.end, dur: gap.dur,
      // 带上明确秒数，用户好判断这段值不值得补识别
      reason: `第 ${i} 行结尾与第 ${i + 1} 行之间空了 ${gap.dur.toFixed(1)} 秒，疑似有内容没被识别出来`,
      confidence: 0.9,
    });
  }
  return out;
}

const SYS_PROMPT = [
  '你在校对一份**自动语音识别（ASR）产生的英文字幕稿**。',
  '你的任务：通读全片字幕，找出**语句不通顺**的地方，并给出可执行的修正操作。',
  '',
  '你会拿到：',
  '  · 全片总行数，以及你正在看的是第几批（批与批之间有几行重叠，便于你判断跨批衔接）',
  '  · 每一行：行号 + 时间 + 英文原文',
  '',
  '要判断的问题（按重要性）：',
  '  1. **没说完**：一行以 that / the / and / to / was / which 这类虚词结尾，',
  '     明显要接下一行。→ 操作 merge',
  '  2. **被硬切**：一行以 and / but / so / then / which / that 开头，',
  '     而上一行也没收尾；或一行的内容与上一行本是同一句。→ 操作 merge',
  '  3. **拼接痕迹**：文本里有 "......"、".." 或词内重复（如 series.ies、players.....ed.），',
  '     说明两段被粘在一起。→ 操作 reidentify（这段音频需要重听）',
  '  4. **疑似听错/漏词**：时间很短却塞了很多词、或词与词之间语义不接。→ 操作 reidentify',
  '  5. **疑似漏内容**：两行之间时间间隔很大（例如 > 3 秒），中间可能有没被识别出来的话。',
  '     → 操作 gap。注意：系统会**另行确定性扫描**时间轴上的空档，所以这里只在',
  '      "时间上挨得很近、但语义明显不连贯"时才报 gap；纯静音空档不需要你报。',
  '',
  '**不要**报以下情况（它们是正常的）：',
  '  · 正常的短句、口语省略、感叹',
  '  · 专有名词、游戏术语、人名拼写怪（ASR 对这类本来就无能为力）',
  '  · 你自己觉得"翻译得不好"——这里只管**英文原文**是否通顺',
  '',
  '输出：**只输出一个 JSON 对象**，不要代码块、不要解释。形如：',
  '{"findings":[{"kind":"merge","from":12,"to":13,"reason":"第12行以 that 结尾，明显接第13行","confidence":0.9}]}',
  '',
  '字段：',
  '  kind        merge | reidentify | gap',
  '  from / to   行号（用你看到的行号；gap 表示"在 from 与 to 之间"）',
  '  reason      一句话中文说明（给用户看，必须具体）',
  '  confidence  0~1，小于 0.5 的会被丢弃',
  '',
  '没有发现问题就输出 {"findings":[]}。宁可少报，也不要为凑数乱报。',
].join('\n');

const KINDS = ['merge', 'reidentify', 'gap'];

function clip(s, n = MAX_CHARS_PER_LINE) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/**
 * 把行切成若干批；相邻批之间有 overlap 行重叠。
 * 返回 [[batchIndex, loRowNo, hiRowNo], ...]，闭区间且行号是 **1-based 全片行号**。
 */
function planBatches(rows, size = BATCH_LINES, overlap = BATCH_OVERLAP) {
  const n = Array.isArray(rows) ? rows.length : 0;
  if (n <= 0) return [];
  if (n <= size) return [[0, 1, n]];
  const step = Math.max(1, size - overlap);
  const out = [];
  let start = 0, idx = 0;
  while (start < n) {
    const end = Math.min(n, start + size);
    out.push([idx, start + 1, end]);
    if (end >= n) break;
    start += step;
    idx += 1;
  }
  return out;
}

/**
 * 一批的 user 消息：全片规模 + 批次位置 + 行表（行号按全片编号，模型直接回全片行号）。
 *
 * @param gluedByRow 可选：`Map<行号, [{word,head,tail}]>` —— 由 glued-words.js 确定性扫出来的
 *   "单词被粘住"候选。有的话**贴在对应行的后面**当提示。
 *   为什么要把确定性结果告诉模型：实测 qwen3:8b 靠提示词抓不住 `weescape`
 *   （判据写宽了它乱报、写严了它一个都不报）—— 但把"这一行的 X 像是 A+B"直接摆到眼前，
 *   它就能确认并给出 reidentify。**提示只帮它定位，判断仍由它做。**
 */
function buildBatchPrompt(rows, lo, hi, total, batchIdx, nBatches, gluedByRow) {
  const head = `全片共 ${total} 行。这是第 ${batchIdx + 1}/${nBatches} 批，`
    + `本批包含第 ${lo}~${hi} 行。行号是**全片行号**，请直接用它回答。\n\n`;
  const lines = [];
  let hinted = 0;
  for (let i = lo; i <= hi; i++) {
    const r = rows[i - 1] || {};
    const t0 = Number(r.start) || 0;
    const t1 = Number(r.end) || 0;
    const g = gluedByRow && gluedByRow.get ? gluedByRow.get(i) : null;
    // 命中就贴一行提示（不动原文本，模型看到的仍是原文）
    const tip = (g && g.length)
      ? `\t← 疑似粘连：${g.map(x => `${x.word} 应为「${x.head} ${x.tail}」`).join('；')}`
      : '';
    if (tip) hinted++;
    lines.push(`${i}\t[${t0.toFixed(2)}-${t1.toFixed(2)} ${Math.max(0, t1 - t0).toFixed(2)}s]\t${clip(r.text)}${tip}`);
  }
  const tail = hinted
    ? `\n\n注：上面 ${hinted} 行标了「疑似粘连」——那是**机器扫出来的候选**，`
      + `请你自己判断是否确实粘错了（是就报 reidentify；不是就别报，比如它本来就是完整单词）。`
    : '';
  return head + lines.join('\n') + tail;
}

/**
 * 解析模型输出为规范化 findings。宽容处理常见包装（代码块、前后废话）。
 * 返回 [findings, note]；note 说明丢弃了什么，便于日志与排查。
 *
 * @param rows  全片行（可选）。给了才能给模型报的 gap 补上**精确时间** ——
 *              模型只给行号，而 planRegions 对 gap 是直接用那对时间取区间的。
 */
function parseFindings(raw, total, rows) {
  let txt = String(raw == null ? '' : raw).trim();
  const dropped = [];
  if (!txt) return [[], '模型返回空'];
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(txt);
  if (m) txt = m[1].trim();
  let obj = null;
  try {
    obj = JSON.parse(txt);
  } catch {
    // 退一步：截取第一个 { 到最后一个 }
    const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { obj = JSON.parse(txt.slice(i, j + 1)); } catch { /* 仍失败 */ }
    }
  }
  if (!obj) return [[], 'JSON 解析失败'];
  const arr = obj && Array.isArray(obj.findings) ? obj.findings : null;
  if (!arr) return [[], '没有 findings 数组'];

  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') { dropped.push('非对象条目'); continue; }
    const kind = String(it.kind || '').trim().toLowerCase();
    if (!KINDS.includes(kind)) { dropped.push(`未知 kind=${kind}`); continue; }
    let a = parseInt(it.from, 10), b = parseInt(it.to === undefined ? it.from : it.to, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { dropped.push('行号不是整数'); continue; }
    if (a > b) { const t = a; a = b; b = t; }
    if (a < 1 || b > total) { dropped.push(`行号越界 ${a}~${b}`); continue; }
    let conf = Number(it.confidence);
    if (!Number.isFinite(conf)) conf = 0.8;
    if (conf < 0.5) { dropped.push(`置信度过低 ${conf.toFixed(2)}`); continue; }
    const f = {
      kind, from: a, to: b,
      reason: clip(it.reason, 160) || '(模型未给原因)',
      confidence: Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100,
    };
    /* 模型报的 gap 只有行号，没有精确时间。这里补上「两行之间的空档」时间：
     * 一方面预览里能显示"空了多久"，另一方面 planRegions 对 gap 是**直接用这对时间**
     * 取区间的（不额外扩上下文），缺了它就只能退回按行取，范围会偏大。 */
    if (kind === 'gap' && Array.isArray(rows)) {
      // 模型只给行号；补上两行之间的真实时间（按词算，见 gapBetween 的说明）
      const gap = gapBetween(rows[a - 1], rows[b - 1]);
      if (gap) { f.start = gap.start; f.end = gap.end; f.dur = gap.dur; }
    }
    out.push(f);
  }
  const note = dropped.length ? `丢弃 ${dropped.length} 条：${dropped.slice(0, 5).join('; ')}` : '';
  return [out, note];
}

/**
 * 合并各批的结论：去重、跨批消解、按行号排序。
 *
 * 为什么要跨批消解：相邻批有重叠区，同一个问题会被两批各报一次；
 * 另外"第 60 行接第 61 行"这种跨批结论可能只被其中一批看到。
 * 做法：同 kind 且区间**重叠或相邻**的条目合并为该 kind 下最大的区间
 * （只合并 merge / reidentify；gap 是提示，保持原样以免夸大）。
 * 同一区间同时被判 merge 与 reidentify 时只留 merge（语义更强，音频动作相同）。
 *
 * 返回 [findings, droppedCount]。
 */
function mergeFindings(allFindings, total) {
  const list = Array.isArray(allFindings) ? allFindings : [];
  // 1) 完全相同的 (kind, from, to) 只留置信度最高的一条，原因合并保留
  const best = new Map();
  for (const f of list) {
    const key = `${f.kind}\u0001${f.from}\u0001${f.to}`;
    const cur = best.get(key);
    if (!cur) { best.set(key, Object.assign({}, f)); continue; }
    if (f.confidence > cur.confidence) cur.confidence = f.confidence;
    if (!cur.reason.includes(f.reason)) cur.reason = (cur.reason + '；' + f.reason).slice(0, 200);
  }
  const items = [...best.values()];

  // 2) merge / reidentify 的重叠或相邻区间合并
  const merged = [];
  for (const kind of ['merge', 'reidentify']) {
    const lst = items.filter(f => f.kind === kind).sort((a, b) => a.from - b.from || a.to - b.to);
    let cur = null;
    for (const f of lst) {
      if (!cur) { cur = Object.assign({}, f); continue; }
      if (f.from <= cur.to + 1) {                 // 重叠或相邻
        cur.to = Math.max(cur.to, f.to);
        cur.confidence = Math.max(cur.confidence, f.confidence);
        if (!cur.reason.includes(f.reason)) cur.reason = (cur.reason + '；' + f.reason).slice(0, 200);
      } else {
        merged.push(cur);
        cur = Object.assign({}, f);
      }
    }
    if (cur) merged.push(cur);
  }

  // 3) 被 merge 区间完全覆盖的 reidentify 丢掉（避免同一段报两次）
  const mergeSpans = merged.filter(f => f.kind === 'merge').map(f => [f.from, f.to]);
  let dropped = 0;
  const final = [];
  for (const f of merged) {
    if (f.kind === 'reidentify'
        && mergeSpans.some(([a, b]) => f.from >= a && f.to <= b)) { dropped++; continue; }
    final.push(f);
  }
  /* gap 按**时间**去重合并，而不是按 (kind,from,to)。
   * 为什么：gap 的真实身份是那段时间，行号只是近似 ——
   * 波形检出与"字幕行间空档"两条通路经常指向同一段音频，
   * 而行号可能差一行，于是同样的内容被拼进 reason 两次
   *（实测输出里出现"…疑似漏识别；…疑似漏识别"）。 */
  const gapItems = items.filter(f => f.kind === 'gap' && Number.isFinite(f.start) && Number.isFinite(f.end))
    .sort((a, b) => a.start - b.start);
  const mergedGaps = [];
  for (const f of gapItems) {
    const last = mergedGaps[mergedGaps.length - 1];
    // 时间上重叠或相接（留 0.5 秒容差）→ 并成一处
    if (last && f.start <= last.end + 0.5) {
      last.end = Math.max(last.end, f.end);
      last.dur = +(last.end - last.start).toFixed(3);
      last.confidence = Math.max(last.confidence, f.confidence);
      if (f.reason && !last.reason.includes(f.reason)) last.reason = `${last.reason}；${f.reason}`;
      if (f.fromWave) last.fromWave = true;
    } else {
      mergedGaps.push(Object.assign({}, f));
    }
  }
  // 波形是更强的证据（它直接看音频），合并后统一用波形口径解释
  for (const g of mergedGaps) {
    if (g.fromWave) g.reason = `波形显示这里有人在说话（${(+g.dur).toFixed(1)} 秒），但字幕轨没盖住，疑似漏识别`;
    final.push(g);
  }
  // 没有精确时间的 gap（模型报的、且补不上）原样保留，免得丢信息
  for (const f of items) {
    if (f.kind === 'gap' && !(Number.isFinite(f.start) && Number.isFinite(f.end))) {
      final.push(Object.assign({}, f));
    }
  }

  final.sort((a, b) => a.from - b.from || a.to - b.to || a.kind.localeCompare(b.kind));
  return [final, dropped];
}

/**
 * 把 findings 变成**去重后的重识别区间**（同稿每段只跑一次）。
 *
 * 每个需要动手的 finding → 换算成时间区间 → 求并（重叠或相接的合并）。返回
 *   [{ start, end, lo, hi, kinds:[...], reasons:[...], confidence, dur }]
 *
 * 三类 finding 的取区间方式不同：
 *   · merge / reidentify —— 覆盖目标行，前后各留 padSec 秒上下文（行时长差异极大，
 *     所以按**秒**取而不是按行取；早期按行取时，一份 45 行/236 秒的稿子
 *     "前后各 3 行"就是 ±15 秒，14 条建议的窗口首尾相接 → **全片并成一整段**，
 *     "只跑一遍"退化成"重跑全片"，粒度尽失。实测踩过）
 *   · gap —— 要补的**就是那段空档本身**，不该再往外扩：空档两边是已经识别好的行，
 *     扩进去只会白白重识别并替换掉本来正确的行。所以 gap 直接用 [start, end]，
 *     并夹到 maxSec 以内。
 */
function planRegions(rows, findings, opts) {
  const o = (typeof opts === 'object' && opts) ? opts : {};
  const padSec = Number.isFinite(o.padSec) ? o.padSec : PAD_SEC;
  const maxSec = Number.isFinite(o.maxSec) ? o.maxSec : MAX_REGION_SEC;
  const n = Array.isArray(rows) ? rows.length : 0;
  const action = (Array.isArray(findings) ? findings : [])
    .filter(f => f && (f.kind === 'merge' || f.kind === 'reidentify' || f.kind === 'gap'));
  if (!n || !action.length) return [];

  const spans = [];
  for (const f of action) {
    let t0, t1, lo, hi;
    if (f.kind === 'gap') {
      // 空档本身：findTimeGaps 已给出精确的词边界时间
      if (!Number.isFinite(f.start) || !Number.isFinite(f.end) || f.end <= f.start) continue;
      t0 = f.start; t1 = f.end;
      if (t1 - t0 > maxSec) t1 = t0 + maxSec;
      lo = Math.max(1, f.from); hi = Math.min(n, f.to);
    } else {
      lo = Math.max(1, f.from);
      hi = Math.min(n, f.to);
      t0 = Math.max(0, (Number(rows[lo - 1].start) || 0) - padSec);
      t1 = (Number(rows[hi - 1].end) || 0) + padSec;
      // 单段上限：超长的建议（或前后被撑得过大）截到目标行本身 + 上限的一半，
      // 保证"这段音频至少包含目标行"，同时不无限膨胀。
      if (t1 - t0 > maxSec) {
        const mid = ((Number(rows[lo - 1].start) || 0) + (Number(rows[hi - 1].end) || 0)) / 2;
        t0 = Math.max(0, mid - maxSec / 2);
        t1 = t0 + maxSec;
      }
    }
    if (!(t1 > t0)) continue;
    spans.push({ lo, hi, start: t0, end: t1, kinds: [f.kind], reasons: [f.reason],
                 confidence: f.confidence });
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    // 只有**真的重叠或相接**才并（时间上挨着）——不再因为"上下文窗口重叠"就无限连成一片
    if (prev && s.start <= prev.end + 0.001) {
      prev.end = Math.max(prev.end, s.end);
      prev.lo = Math.min(prev.lo, s.lo);
      prev.hi = Math.max(prev.hi, s.hi);
      for (const k of s.kinds) if (!prev.kinds.includes(k)) prev.kinds.push(k);
      prev.reasons.push(...s.reasons);
      prev.confidence = Math.max(prev.confidence, s.confidence);
    } else {
      out.push(Object.assign({}, s, { kinds: s.kinds.slice(), reasons: s.reasons.slice() }));
    }
  }
  for (const r of out) {
    r.reasons = [...new Set(r.reasons)].slice(0, 3);
    r.dur = Math.round((r.end - r.start) * 100) / 100;
  }
  return out;
}

/** 给前端/日志的一份概览（预览页头部用它，也用于"给用户报成本"）。 */
function summarize(rows, findings, regions) {
  const byKind = {};
  for (const f of (findings || [])) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const audioSec = (regions || []).reduce((s, r) => s + (Number(r.dur) || 0), 0);
  return {
    rows: (rows || []).length,
    findings: (findings || []).length,
    byKind,
    regions: (regions || []).length,
    audioSec: Math.round(audioSec * 10) / 10,
  };
}

export {
  planBatches, buildBatchPrompt, parseFindings, mergeFindings, planRegions, summarize,
  findTimeGaps,
  SYS_PROMPT, BATCH_LINES, BATCH_OVERLAP, CTX_LINES, PAD_SEC, MAX_REGION_SEC, KINDS,
  GAP_MIN_SEC, GAP_MAX_SEC,
};
