/** ASS 逐词特效双轨处理:
 *  1) 把逐词切片合并为整句(字幕块)
 *  2) 生成词级时间轴映射 (每句每词起止时间)
 *  3) 编辑文本后按原词时长加权重算逐词时间
 *  4) 依据干净文本 + 词级映射重建逐词切片
 */
import { assPlainText } from './ass.js';

/** 逐词高亮切片: {\c&H00FF00&}word{\c} */
const HL_RE = /\{\\c&H[0-9A-Fa-f]{6}&\}([^{}]+?)\{\\c\}/;

/** 行首样式覆盖: {\c&H......&} → ASS 为 &HAABBGGRR, 返回 '#rrggbb' */
const LEAD_COLOR_RE = /^\s*\{[^}]*?\\c&H([0-9A-Fa-f]{6})&/;

/** 逐词高亮色(默认绿), 不是说话人颜色, 提取时需排除 */
export const HIGHLIGHT_COLORS = new Set(['#00ff00']);

/** ASS &HBBGGRR → '#rrggbb'(供说话人颜色解析与全局换色复用) */
export const assColorToHex = (h) => '#' + (h[4] + h[5] + h[2] + h[3] + h[0] + h[1]).toLowerCase();

/**
 * 说话人颜色: 取句子首个事件行首 {\c&H......&} 的颜色(如 [Spoke] → 红 #e50b0b)。
 * 逐词高亮绿(#00ff00)不算说话人颜色, 需排除。整句样式(如"中文字幕")行上才带此色。
 */
export function speakerColorOf(sent) {
  if (!sent) return null;
  for (const ev of (sent.events || [])) {
    const m = LEAD_COLOR_RE.exec(ev.text || '');
    if (!m) continue;
    const hex = assColorToHex(m[1].toUpperCase());
    if (!HIGHLIGHT_COLORS.has(hex)) return hex;
  }
  return null;
}

function stripTags(t) {
  return String(t)
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/gi, ' ')
    .replace(/\\h/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function protoOf(ev, format) {
  const get = (col) => {
    const i = format.indexOf(col);
    return i === -1 ? '' : (ev._rawParts ? String(ev._rawParts[i]) : '');
  };
  return {
    layer: ev.layer,
    name: ev.name,
    effect: get('effect'),
    margins: { marginl: get('marginl') || '0', marginr: get('marginr') || '0', marginv: get('marginv') || '0' }
  };
}

function makeSentence(style, start, end, text, events, words, proto, highlightTag) {
  return {
    style, start, end, text,
    events,              // 该句在原始(逐词)文档中的 Dialogue 事件
    words,               // [{w, s, e}] 词级时间; 无逐词特效时为 []
    proto: proto || { layer: '0', name: '', effect: '', margins: { marginl: '0', marginr: '0', marginv: '0' } },
    highlightTag: highlightTag || '{\\c&H00FF00&}'
  };
}

/**
 * 取逐词高亮色标: 只从「{\c&H......&}词{\c}」逐词高亮 span 里取开头那个 \c 色标。
 * 不能取切片里第一个 {\c&H...&} —— 否则英文行行首的角色色标(如 {\c&H0B0BE5&})
 * 会被误当成逐词高亮色, 导致删角色/改英文行后所有词都染上角色色(用户报的 bug#1)。
 * 正规 karaoke 文件里逐词色恒为绿 {\c&H00FF00&}; 若文件用了别的逐词色, 同样从 span 取。
 */
function firstTag(slices) {
  for (const sl of slices) {
    const m = HL_RE.exec(sl.text);
    if (m) {
      const open = /^\{\\[^}]*\}/.exec(m[0]);   // span 开头的 {\c&H......&}
      if (open) return open[0];
    }
  }
  return '{\\c&H00FF00&}';
}

/**
 * 分析 ASS 文档 → { wordStyle, sentences[] }
 * wordStyle=null 表示文件不含逐词切片(每个事件即一句)。
 */
export function analyzeKaraoke(doc) {
  const byStyle = new Map();
  for (const ev of doc.sorted) {
    if (!byStyle.has(ev.style)) byStyle.set(ev.style, []);
    byStyle.get(ev.style).push(ev);
  }

  // 识别逐词样式: 高亮切片占比高且数量最多的样式
  let wordStyle = null, wordEvents = [], best = 0;
  for (const [style, evs] of byStyle) {
    if (evs.length < 6) continue;
    let hl = 0;
    for (const ev of evs) if (HL_RE.test(ev.text)) hl++;
    if (hl / evs.length > 0.3 && evs.length > best) { wordStyle = style; wordEvents = evs; best = evs.length; }
  }

  const sentences = [];
  if (!wordStyle) {
    for (const ev of doc.sorted) {
      sentences.push(makeSentence(ev.style, ev.start, ev.end, assPlainText(ev.text), [ev], [], protoOf(ev, doc.format)));
    }
    finalizeSentences(sentences);
    return { wordStyle: null, sentences };
  }

  // 其他样式事件作为句子锚点(如中文字幕整句行)
  const anchors = [];
  for (const [style, evs] of byStyle) {
    if (style === wordStyle) continue;
    anchors.push(...evs);
  }
  anchors.sort((a, b) => a.start - b.start);

  function findAnchor(sl) {
    // 二分定位到最后一条 start <= 切片起点的中文行, 再往前找**能包住切片且最贴合**的那条。
    // 以前是"往前最多看 4 条、第一条包含就返回" —— 双行字幕轨允许行重叠,
    // 新建行与现有行起点相同/相近时, 二分命中的是**跨度更大**的那条(排序按 start 再 end),
    // 切片就被它抢走: 重载后新行英文丢失、另一行词数暴涨(实测复现)。
    // 现在与 pairRows.ownerOf 同一策略: 在能包住的候选里取跨度最小(最贴合)的。
    let lo = 0, hi = anchors.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].start <= sl.start + 0.02) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let best = null, bestSpan = Infinity;
    for (let i = ans; i >= 0; i--) {
      const a = anchors[i];
      if (a.start < sl.start - 300) break;          // 5 分钟以上的行属于病态, 不再往前找
      if (sl.start >= a.start - 0.05 && sl.end <= a.end + 0.05) {
        const span = a.end - a.start;
        if (span < bestSpan) { bestSpan = span; best = a; }
      }
    }
    return best;
  }

  const groups = new Map();   // anchor → slices
  const loose = [];
  for (const sl of wordEvents) {
    const a = findAnchor(sl);
    if (a) { if (!groups.has(a)) groups.set(a, []); groups.get(a).push(sl); }
    else loose.push(sl);
  }
  repairKaraokeGroups(groups, loose, anchors);

  function extractWords(slices) {
    const words = [];
    for (const sl of slices) {
      const m = HL_RE.exec(sl.text);
      if (m && m[1].trim()) words.push({ w: m[1], s: sl.start, e: sl.end });
    }
    return words;
  }
  function plainOf(slices, words) {
    let bestT = '';
    for (const sl of slices) {
      const t = stripTags(sl.text);
      if (t.length > bestT.length) bestT = t;
    }
    return bestT || words.map(w => w.w).join(' ');
  }

  // 锚点句(逐词样式)
  for (const [anchor, slices] of groups) {
    slices.sort((a, b) => a.start - b.start);
    const words = extractWords(slices);
    sentences.push(makeSentence(wordStyle, anchor.start, anchor.end,
      plainOf(slices, words), slices, words, protoOf(slices[0], doc.format), firstTag(slices)));
  }
  // 其他样式句子(整句, 原样保留) —— 始终输出, 它们是中文等非逐词语言的字幕内容
  for (const a of anchors) {
    sentences.push(makeSentence(a.style, a.start, a.end, assPlainText(a.text), [a], [], protoOf(a, doc.format)));
  }
  // 未归属切片: 按时间间隔 > 0.5s 分组成句
  loose.sort((a, b) => a.start - b.start);
  let cur = [];
  const flushLoose = () => {
    if (!cur.length) return;
    const words = extractWords(cur);
    sentences.push(makeSentence(wordStyle, cur[0].start, cur[cur.length - 1].end,
      plainOf(cur, words), cur, words, protoOf(cur[0], doc.format), firstTag(cur)));
    cur = [];
  };
  for (const sl of loose) {
    if (cur.length && sl.start - cur[cur.length - 1].end > 0.5) flushLoose();
    cur.push(sl);
  }
  flushLoose();

  sentences.sort((a, b) => a.start - b.start || a.end - b.end);
  finalizeSentences(sentences);
  return { wordStyle, sentences };
}

/**
 * 逐词切片归属修正 —— 「整句穿行」:
 * 一条单行中文字幕(译者注 / 舞台提示, 本身没有英文)完全套在另一条更长中文行里时,
 * 里层那条会因为"开始得更晚"而被 findAnchor 判为切片的主人, 于是中文字幕凭空多出一条
 * 英文行、真正的双语行反而变成"缺英文"(用户报的 bug: 单行中文字幕和双语字幕重叠)。
 *
 * 判据来自真实文件本身的规律: 切片是**整句铺满所属中文行**的 —— 首片起于行首、末片止于
 * 行尾(实测 4105/4106 行误差为 0)。因此「拿到的切片没顶到本行两端」的行很可能是整句的
 * 一截, 但**只有真的存在一条能收下它(且收下后正好铺满自己两端)的中文行**时才改判 ——
 * 否则一律保持原样(说话人停顿会让首片晚于行首 0.1~0.4s, 这是正常的, 不能动)。
 */
function repairKaraokeGroups(groups, loose, anchors) {
  if (!groups.size) return;
  const TOL = 0.12;                       // "顶到行首/行尾"的容差(真实数据里误差为 0)
  const span = (arr) => {
    let s = Infinity, e = -Infinity;
    for (const x of arr) { if (x.start < s) s = x.start; if (x.end > e) e = x.end; }
    return { s, e };
  };
  const holds = (a, arr) => arr.every(x => x.start >= a.start - 0.05 && x.end <= a.end + 0.05);

  for (let round = 0; round < 4; round++) {
    let moved = 0;
    for (const [x, S] of [...groups]) {
      if (!S.length) continue;
      const own = span(S);
      if (own.s - x.start <= TOL && x.end - own.e <= TOL) continue;      // 整句铺满本行 → 确实是它的
      let bestY = null, bestDur = Infinity;
      for (const y of anchors) {
        if (y === x) continue;
        if (!holds(y, S)) continue;                                      // 必须"整批被这条行包住"(=套叠)
        const merged = span((groups.get(y) || []).concat(S));
        if (merged.s - y.start > TOL || y.end - merged.e > TOL) continue; // 收下仍顶不满 → 它也不是主人
        const dur = y.end - y.start;
        if (dur < bestDur) { bestDur = dur; bestY = y; }
      }
      if (!bestY) continue;                                              // 找不到收留者 → 不动
      groups.set(bestY, (groups.get(bestY) || []).concat(S));
      groups.delete(x);
      moved++;
    }
    if (!moved) break;
  }
  for (const [x, S] of [...groups]) if (!S.length) groups.delete(x);
}

/** 标记异常句: 任一切片时间无法解析/格式非法, 或句时长 ≤ 0 */
function markBadSentences(sentences) {
  for (const s of sentences) {
    s.bad = s.end <= s.start || s.events.some(e => e.bad);
  }
}

/** 句子内部切片是否**时间交叠**(同一条字幕的两份事件互相压住 → 重复/重叠的脏数据)。
 *  正常 karaoke 切片首尾相接(prev.end == next.start)不算交叠。 */
function slicesOverlap(s) {
  const evs = (s.events || []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < evs.length; i++) {
    if (evs[i].start < evs[i - 1].end - 1e-3) return true;
  }
  return false;
}

/** 补齐显示元数据: 异常标记 + 说话人 / 说话人颜色(供时间轴按人物着色) */
function finalizeSentences(sentences) {
  markBadSentences(sentences);
  for (const s of sentences) {
    s.color = speakerColorOf(s);
    s.speaker = speakerTagOf(s);
    s.overlap = slicesOverlap(s);
  }
}

/**
 * 说话人标记: 取行首覆盖标签({\...})之后的可见 [人物] —— 如
 * "{\c&H0B0BE5&}[Spoke]在 Unstable SMP…" 的 "[Spoke]"(说话人分离工具写入文本)。
 * 文本没有 [ ] 时回退到 Name 栏(如 "Spoke")。
 */
export function speakerTagOf(sent) {
  const name = speakerTextTagOf(sent);
  if (name) return '[' + name + ']';        // 保持原有格式: 带方括号
  return (sent.proto && sent.proto.name) || '';
}

/**
 * 只取字幕**文本**行首的可见 [人物] 标记, 不回退 Name 栏。
 * 角色身份写在文本里(视频里/列表里看得到的就是它), Name 栏只是裸名兜底;
 * 因此"没被标注角色"的准判据是这一项为空 —— 坏行判定(见 main.js markBadRows)用它
 * 区分「文本里真有 [标记]」和「只有 Name 栏裸名(画面上不显示角色)」。
 * 返回 '人物'(不含方括号) 或 ''。
 */
export function speakerTextTagOf(sent) {
  if (!sent) return '';
  for (const ev of (sent.events || [])) {
    const t = String(ev.text || '');
    const head = /^(?:\s*\{[^}]*\})*/.exec(t)[0];
    const m = /^\s*\[([^\]]+)\]/.exec(t.slice(head.length));
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * 跨语言配对: 把「整句样式句」(如中文字幕) 与「逐词样式句」(如英文) 配成一行(中英双行展示),
 * 未配对的句子各自成行。
 *
 * 配对判据 = **时间上包住**: 英文句的时间范围必须落在中文行范围内(±0.05s); 多条都包住时取
 * 「最贴合」的那条(起止误差最小, 再比跨度最小 —— 也就是与它同起止的那条)。
 * 为什么不用"重叠面积 > 50% 就近认领"(旧实现): 一条单行中文字幕(译者注/舞台提示)只要时间上
 * 压住某条双语行的一半以上, 就会把**整段英文**抢过来, 而真正的双语行反而变成"缺英文"
 * (用户报的 bug: 单行中文字幕和双语字幕重叠 → 中文字幕凭空多出一条英文行)。
 * 包不住它的英文句宁可单独成行(会以"单英文行"出现在坏行里), 也不乱配。
 */
export function pairRows(sentences, wordStyle) {
  const anchors = sentences.filter(s => s.style !== wordStyle).sort((a, b) => a.start - b.start || a.end - b.end);
  const wordSents = sentences.filter(s => s.style === wordStyle).sort((a, b) => a.start - b.start || a.end - b.end);
  const used = new Set();
  const enOf = new Map();

  const EPS = 0.05;
  /** 包住 w 的中文行里最贴合的一条(起止误差最小, 同则跨度最小) */
  function ownerOf(w) {
    let lo = 0, hi = anchors.length - 1, pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].start <= w.start + EPS) { pos = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let best = null;
    for (let i = pos; i >= 0 && anchors[i].start >= w.start - 5; i--) {
      const z = anchors[i];
      if (w.start < z.start - EPS || w.end > z.end + EPS) continue;
      const err = Math.abs(z.start - w.start) + Math.abs(z.end - w.end);
      const dur = z.end - z.start;
      if (!best || err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && dur < best.dur)) best = { z, err, dur };
    }
    return best ? best.z : null;
  }

  for (const w of wordSents) {
    const z = ownerOf(w);
    if (z && !enOf.has(z)) { enOf.set(z, w); used.add(w); }
  }

  const rows = anchors.map(z => makeRow(z, enOf.get(z) || null));
  for (const w of wordSents) if (!used.has(w)) rows.push(makeRow(null, w));
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  rows.forEach((r, i) => r.no = i + 1);
  return rows;
}

function makeRow(zh, en) {
  const start = Math.min(zh ? zh.start : Infinity, en ? en.start : Infinity);
  const end = Math.max(zh ? zh.end : 0, en ? en.end : 0);
  // 说话人颜色优先取整句样式行(如中文字幕), 其行首 \c 才是人物颜色
  return {
    zh, en, start: isFinite(start) ? start : 0, end, no: 0,
    color: (zh && zh.color) || (en && en.color) || null,
    speaker: (zh && zh.speaker) || (en && en.speaker) || ''
  };
}

/** 中英是否同起止(允许 ASS 厘秒级微小误差) */
export function sameTime(a, b, eps = 1e-4) {
  return !!a && !!b && Math.abs(a.start - b.start) < eps && Math.abs(a.end - b.end) < eps;
}

/**
 * 由单个事件构造句子骨架(时间轴上"空白拖动新建字幕块"时用).
 * 与 analyzeKaraoke 产出的句子结构保持一致, 便于后续统一编辑/重算。
 */
export function sentenceFromEvent(style, ev, format, start, end, text) {
  return makeSentence(style, start, end, text, [ev], [], protoOf(ev, format));
}

/**
 * 归一化词级时间: 全部夹在 [start,end] 内、严格单调递增(不重叠)、
 * 每片至少 1 厘秒(ASS 时间精度), 末词结束贴齐句尾(与 main.py 一致)。
 * 少了这一步, 缩放后的小数经厘秒取整会出现 0 时长片 / 顺序颠倒,
 * 表现就是"逐词高亮乱跳 + 画面上多出重复字幕"。
 */
function normalizeWords(words, start, end) {
  const n = words.length;
  if (!n) return [];
  const span = Math.max(0.01, end - start);
  // 句长容不下 n 个厘秒片 → 直接均匀铺满, 不再逐片夹取
  if (span < n * 0.01) {
    return words.map((w, i) => ({
      w: w.w,
      s: start + span * (i / n),
      e: start + span * ((i + 1) / n)
    }));
  }
  const out = [];
  let cursor = start;
  for (let i = 0; i < n; i++) {
    const tailKeep = (n - i - 1) * 0.01;           // 给后面的词预留 1 厘秒
    const sMax = end - tailKeep - 0.01;
    let s = Math.max(cursor, Math.min(words[i].s, sMax));
    let e = Math.max(s + 0.01, Math.min(words[i].e, end - tailKeep));
    if (i === n - 1) e = end;                      // 末词贴齐句尾
    out.push({ w: words[i].w, s, e });
    cursor = e;
  }
  return out;
}

/**
 * 编辑后重算词级时间:
 *  - 词数不变且句时间不变 → 原样保留逐词时间
 *  - 词数不变仅时间变   → 按原相对比例缩放
 *  - 词数变化          → 在 [newStart,newEnd] 内按原词时长加权重新分配
 * 返回值一律经过 normalizeWords, 保证可直接用于重建切片。
 */
export function recalcWords(sentence, newText, newStart, newEnd) {
  const tokens = newText.split(/\s+/).filter(Boolean);
  const n = sentence.words.length, m = tokens.length;
  if (m === 0) return [];
  // 原本不是逐词句(如刚插入的新行): 没有原始时长可加权, 在句内均匀铺满
  if (n === 0) {
    const span0 = Math.max(0.01, newEnd - newStart);
    return normalizeWords(tokens.map((t, i) => ({
      w: t,
      s: newStart + span0 * (i / m),
      e: newStart + span0 * ((i + 1) / m)
    })), newStart, newEnd);
  }
  const oldSpan = Math.max(0.001, sentence.end - sentence.start);
  const span = Math.max(0.05, newEnd - newStart);

  let words;
  if (m === n) {
    const sameTime = Math.abs(newStart - sentence.start) < 1e-6 && Math.abs(newEnd - sentence.end) < 1e-6;
    if (sameTime) {
      words = tokens.map((t, i) => ({ w: t, s: sentence.words[i].s, e: sentence.words[i].e }));
    } else {
      words = tokens.map((t, i) => {
        const r1 = (sentence.words[i].s - sentence.start) / oldSpan;
        const r2 = (sentence.words[i].e - sentence.start) / oldSpan;
        return { w: t, s: newStart + r1 * span, e: newStart + r2 * span };
      });
    }
    return normalizeWords(words, newStart, newEnd);
  }

  // 词数变化: 以原词时长为权重采样再归一化
  const oldDurs = sentence.words.map(w => Math.max(0.02, w.e - w.s));
  const weights = [];
  for (let j = 0; j < m; j++) {
    const p = (j + 0.5) / m;
    const oi = Math.min(n - 1, Math.floor(p * n));
    weights.push(n > 0 ? oldDurs[oi] : 1);
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  words = [];
  let acc = 0;
  for (let j = 0; j < m; j++) {
    const s = newStart + span * (acc / sum);
    acc += weights[j];
    const e = (j === m - 1) ? newEnd : newStart + span * (acc / sum);
    words.push({ w: tokens[j], s, e });
  }
  return normalizeWords(words, newStart, newEnd);
}

/** 依据干净文本 + 词级映射重建逐词 Dialogue spec 列表 */
export function buildWordSpecs(sentence) {
  const p = sentence.proto;
  const base = { layer: p.layer, style: sentence.style, name: p.name, effect: p.effect, margins: p.margins };
  if (!sentence.words.length) {
    return [Object.assign({}, base, { start: sentence.start, end: sentence.end, text: sentence.text })];
  }
  const parts = sentence.text.split(/(\s+)/);   // 保留空白, 便于原位包裹
  const idxs = [];
  parts.forEach((t, i) => { if (t.trim()) idxs.push(i); });

  // 文本与词数不一致(理论上先经过 recalcWords 不会走到这里):
  // 不放弃逐词效果 —— 按实际词数在句时长内均匀铺满, 而不是塌成单条干净行。
  let words = sentence.words;
  if (idxs.length !== words.length) {
    const n2 = idxs.length;
    const s0 = sentence.start, span = Math.max(0.01, sentence.end - s0);
    words = idxs.map((_, k) => ({
      w: parts[idxs[k]],
      s: s0 + span * (k / n2),
      e: s0 + span * ((k + 1) / n2)
    }));
  }

  const tag = sentence.highlightTag;
  const specs = [];
  const push = (s, e, text) => specs.push(Object.assign({}, base, { start: s, end: e, text }));

  // 句首空档(英文晚于中文起播时): 补一条无高亮的整句行, 保持与原文件一致
  if (words[0].s - sentence.start > 0.004) {
    push(sentence.start, words[0].s, sentence.text);
  }
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const marked = parts.map((t, i) => (i === idxs[k] ? tag + t + '{\\c}' : t)).join('');
    push(w.s, w.e, marked);
    const nx = words[k + 1];
    if (nx && w.e < nx.s - 0.004) push(w.e, nx.s, sentence.text);
  }
  const lastW = words[words.length - 1];
  if (lastW.e < sentence.end - 0.004) push(lastW.e, sentence.end, sentence.text);
  return specs;
}

/** 生成无逐词效果的干净 ASS 全文 */
export function buildCleanAss(doc, sentences) {
  const cut = doc.eventsFormatLineIdx != null ? doc.eventsFormatLineIdx + 1 : doc.lines.length;
  const head = doc.lines.slice(0, cut).filter(l => l !== null);
  const body = sentences.map(sent => {
    if (sent.words.length) {
      return doc._buildDialogueLine({
        layer: sent.proto.layer, style: sent.style, name: sent.proto.name,
        effect: sent.proto.effect, margins: sent.proto.margins,
        start: sent.start, end: sent.end, text: sent.text
      });
    }
    const ev = sent.events[0];
    return doc._buildDialogueLine({
      layer: sent.proto.layer, style: sent.style, name: sent.proto.name,
      effect: sent.proto.effect, margins: sent.proto.margins,
      start: sent.start, end: sent.end, text: ev.text
    });
  });
  return head.concat(body).join('\r\n');
}
