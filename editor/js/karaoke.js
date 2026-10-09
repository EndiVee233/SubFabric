/** ASS 逐词特效双轨处理:
 *  1) 把逐词切片合并为整句(字幕块)
 *  2) 生成词级时间轴映射 (每句每词起止时间)
 *  3) 编辑文本后按原词时长加权重算逐词时间
 *  4) 依据干净文本 + 词级映射重建逐词切片
 */
import { assPlainText } from './ass.js';

/** 逐词高亮切片: {\c&H00FF00&}word{\c} */
const HL_RE = /\{\\c&H[0-9A-Fa-f]{6}&\}([^{}]+?)\{\\c\}/;

/** \k 家族标签（卡拉OK时长，单位厘秒）: \k / \kf / \ko / \K / \kt。
 *  识别"这篇/这行是不是 k 形态"用它; 具体解析在 parseKLine 里逐覆盖块做。 */
const K_ANY_RE = /\\[kK](?:[fot])?\s*\d+/;

/** 这行是不是 \k 卡拉OK形态（供 main.js 的行内改写 / 坏行检测复用同一判据） */
export const isKaraokeLine = (text) => K_ANY_RE.test(String(text || ''));

/** 行首样式覆盖: {\c&H......&} → ASS 为 &HAABBGGRR, 返回 '#rrggbb' */
const LEAD_COLOR_RE = /^\s*\{[^}]*?\\c&H([0-9A-Fa-f]{6})&/;

/** 逐词高亮色(默认绿), 不是说话人颜色, 提取时需排除 */
export const HIGHLIGHT_COLORS = new Set(['#00ff00']);

/** ASS &HBBGGRR → '#rrggbb'(供说话人颜色解析与全局换色复用) */
export const assColorToHex = (h) => '#' + (h[4] + h[5] + h[2] + h[3] + h[0] + h[1]).toLowerCase();

/** 把所选逐词颜色写入英文逐词事件, 只改标准高亮 span、不碰角色颜色及其它覆盖标签。
 *  \k 卡拉OK行的高亮色在头部 `\1c`（形态不同、语义相同）→ 就地改写头部颜色位, 不重建整行。 */
export function replaceWordHighlightColor(doc, style, hex, eventScope = null) {
  const rgb = normHex6(hex);
  if (!rgb) return 0;
  const tag = `{\\c&H${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&}`;
  const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
  let changed = 0;
  for (const ev of eventScope || (doc && doc.events) || []) {
    if (String(ev.style || '').toLowerCase() !== String(style || '').toLowerCase()) continue;
    const text = String(ev.text || '');
    const next = isKaraokeLine(text)
      ? patchKHeadColor(text, '1c', bgr)
      : text.replace(HL_RE, (span, word) => tag + word + '{\\c}');
    if (next !== ev.text) { doc.setEventText(ev, next); changed++; }
  }
  return changed;
}

/** 把「未唱默认色」写入 \k 行的头部 `\2c`。调用方需自己排除"有角色色"的行
 *  （有角色的行未唱位显示该行角色色, 见设计稿 §5/§11）。 */
export function replaceKaraokeBaseColor(doc, style, hex, eventScope = null) {
  const rgb = normHex6(hex);
  if (!rgb) return 0;
  const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
  let changed = 0;
  for (const ev of eventScope || (doc && doc.events) || []) {
    if (String(ev.style || '').toLowerCase() !== String(style || '').toLowerCase()) continue;
    const text = String(ev.text || '');
    if (!isKaraokeLine(text)) continue;
    const next = patchKHeadColor(text, '2c', bgr);
    if (next !== ev.text) { doc.setEventText(ev, next); changed++; }
  }
  return changed;
}

/** 切换 \k 行段标签形态（\k 瞬切 / \kf 扫过 / \ko 仅描边）。\K 按 Aegisub 语义等同 \kf,
 *  `\kt` 是"设定下一段起点"不是段时长 → 绝不能被改写。时长原样保留, 切换是无损的。 */
export function replaceKaraokeTag(doc, style, tag, eventScope = null) {
  if (!K_TAGS.has(tag)) return 0;
  let changed = 0;
  for (const ev of eventScope || (doc && doc.events) || []) {
    if (String(ev.style || '').toLowerCase() !== String(style || '').toLowerCase()) continue;
    const text = String(ev.text || '');
    if (!isKaraokeLine(text)) continue;
    const next = text.replace(/\\[kK][fo]?\s*(\d+)/g, (all, d) => tag + d);
    if (next !== ev.text) { doc.setEventText(ev, next); changed++; }
  }
  return changed;
}

/**
 * 说话人颜色: 取句子首个事件行首 {\c&H......&} 的颜色(如 [Spoke] → 红 #e50b0b)。
 * 默认绿按颜色排除；自定义逐词色按逐词 span 结构排除。整句样式(如"中文字幕")行上才带说话人色。
 */
export function speakerColorOf(sent) {
  if (!sent) return null;
  for (const ev of (sent.events || [])) {
    const text = String(ev.text || '');
    const m = LEAD_COLOR_RE.exec(text);
    if (!m) {
      // k 卡拉OK行: 说话人色在颜色头的 \2c(未唱位)。只有"该行确有角色"时才认它,
      // 否则无角色行的"未唱默认色"会被误当成角色色(行卡片会整片染色)。
      if (sent.karStyle === 'k' && speakerTagOf(sent)) {
        const k2 = /\\2c&H([0-9A-Fa-f]{6})&/.exec(text);
        if (k2) {
          const khex = assColorToHex(k2[1].toUpperCase());
          if (!HIGHLIGHT_COLORS.has(khex)) return khex;
        }
      }
      continue;
    }
    const hex = assColorToHex(m[1].toUpperCase());
    const trimmed = text.trimStart();
    const leadingSpan = HL_RE.exec(trimmed);
    const isWordHighlight = !!(sent.words && sent.words.length && leadingSpan && leadingSpan.index === 0
      && leadingSpan[0].startsWith(m[1] ? `{\\c&H${m[1]}&}` : ''));
    if (!HIGHLIGHT_COLORS.has(hex) && !isWordHighlight) return hex;
  }
  return null;
}

function stripTags(t) {
  return String(t)
    // 只剥"覆盖标签"（{\...}）—— 真标签一定以反斜杠开头。文本里的字面大括号（如 {brace}）是用户原文,
    // 必须原样保留: 否则"序列化 → 重新分析"会把它们吃掉, 编辑后重载文本就变了(实测英文含 {brace} 时丢失)。
    .replace(/\{\\[^}]*\}/g, '')
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
 * 逐词样式推断(退化态兜底): 文件里一条高亮切片都没有时(整轨「去逐词」后重新打开),
 * 按与配对同源的规律把它认出来 —— 该样式的句子在时间上被**另一条样式**的句子包住(±0.05s),
 * 这正是"中文整句行包住英文逐词行"的结构(与 pairRows.ownerOf 同一判据)。
 * 两条样式互相包含(同起止)时取 CJK 占比更低的那条: 整句样式是中文行, 逐词样式是英文/拉丁行。
 * 推断不出来就原样返回 —— 文件本就没有双语配对结构时不硬凑。
 */
function inferWordStyle(sentences, wordStyle) {
  if (wordStyle && sentences.some(s => s.style === wordStyle)) return wordStyle;
  const byStyle = new Map();
  for (const s of sentences) {
    if (!byStyle.has(s.style)) byStyle.set(s.style, []);
    byStyle.get(s.style).push(s);
  }
  if (byStyle.size < 2) return wordStyle;          // 单一样式: 谈不上"跨样式配对"
  const EPS = 0.05;
  const styles = [...byStyle.keys()];
  let best = null;
  for (const w of styles) {
    const ws = byStyle.get(w);
    let contained = 0;
    for (const s of ws) {
      for (const a of styles) {
        if (a === w) continue;
        if (byStyle.get(a).some(z => s.start >= z.start - EPS && s.end <= z.end + EPS)) { contained++; break; }
      }
    }
    const ratio = contained / ws.length;
    if (ratio < 0.6) continue;                     // 过半被包住才算"内层"样式
    let cjk = 0, len = 0;
    for (const s of ws) { cjk += cjkRatio(s.text) * s.text.length; len += s.text.length; }
    const cand = { style: w, ratio, cjk: len ? cjk / len : 0, n: ws.length };
    if (!best
      || cand.ratio > best.ratio + 1e-9
      || (Math.abs(cand.ratio - best.ratio) <= 1e-9 && cand.cjk < best.cjk - 1e-9)
      || (Math.abs(cand.ratio - best.ratio) <= 1e-9 && Math.abs(cand.cjk - best.cjk) <= 1e-9 && cand.n > best.n)) {
      best = cand;
    }
  }
  return best ? best.style : wordStyle;
}

/** CJK 字符占比(逐词样式通常是按空格分词的拉丁文本, 整句样式是中文行) */
function cjkRatio(text) {
  const s = String(text || '');
  if (!s) return 0;
  const m = s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return (m ? m.length : 0) / s.length;
}

/** k 段标签白名单（只允许这三个字面，防止外部输入拼出奇怪的覆盖标签） */
const K_TAGS = new Set(['\\k', '\\kf', '\\ko']);

/** '#rrggbb' → ASS 的 'BBGGRR'（大写 6 位，与 assColorToHex 互逆）。无效返回 null。 */
const normHex6 = (hex) => {
  const s = String(hex || '').replace('#', '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(s) ? s : null;
};
const hexToBgr6 = (hex) => {
  const s = normHex6(hex);
  return s ? s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2) : '00FF00';
};

/** k 行头部 = 首个 `\k` 之前的**真正的覆盖标签块**（块首必须是反斜杠 —— 文本里的字面
 *  `{大括号}` 不能当头部，往里塞标签会把用户原文改成覆盖标签）。缺颜色位时追加到它末尾；
 *  连标签块都没有就在行首新建一个（永远安全）。 */
function insertIntoKHead(text, tag) {
  const firstK = text.search(/\\[kK]/);
  const zone = firstK === -1 ? text : text.slice(0, firstK);
  const m = /\{\\[^}]*\}/.exec(zone);
  if (m) {
    const at = m.index + m[0].length - 1;          // 闭合花括号的位置
    return text.slice(0, at) + tag + text.slice(at);
  }
  return '{' + tag + '}' + text;
}

/** 就地改写 k 行头部的一个颜色位（tag = '1c' 已唱 / '2c' 未唱）。
 *  已有该标签 → 换值；没有 → 插入头部块（`\c` 与 `\1c` 等价，已唱位优先改已有的 `\c`，
 *  免得同一行留下两个互相打架的"已唱色"）。 */
function patchKHeadColor(text, tag, bgr) {
  const re = new RegExp('\\\\' + tag + '&H[0-9A-Fa-f]{6}&');
  if (re.test(text)) return text.replace(re, '\\' + tag + '&H' + bgr + '&');
  if (tag === '1c') {
    const c = /\\c&H[0-9A-Fa-f]{6}&/.exec(text);
    if (c) return text.slice(0, c.index) + '\\c&H' + bgr + '&' + text.slice(c.index + c[0].length);
  }
  return insertIntoKHead(text, '\\' + tag + '&H' + bgr + '&');
}

/**
 * 解析一条 \k 卡拉OK行（单事件整行）→ 词级时间 + 头部信息。
 *
 * 与"颜色高亮切片"形态的关系：两种形态都还原成同一份 words[{w,s,e}]（见文件头与设计稿）。
 * 解析规则（全部按**厘秒整数**累计，避免浮点误差）：
 *   · 段序列：每个 `\k/\kf/\ko/\K<dur>` 开启一个段，跟在其后的文本属于该段；
 *     无文本的段 = 空档 filler（只推进进度，不产生词）；
 *   · `\kt<cs>`：把下一段起点设为相对行首的该绝对时间（Aegisub 文档语义）；
 *   · 第一个 `\k` 之前的覆盖块 = 颜色头（解析 \1c/\2c；原文存进 head 供序列化保留其它 tag）；
 *   · 首个 k 段之前的散文本（罕见布局）并入第一段文本。
 *
 * @returns {{head:string, highlightTag:string|null, baseHex:string|null, kTag:string,
 *            words:Array<{w:string,s:number,e:number}>, text:string}}
 *   head = 头部覆盖块的**内部 tag 串**（不含花括号）；highlightTag/baseHex 解析失败为 null；
 *   kTag = 该行段标签的形态（`\kf`/`\ko`/`\k`，`\K` 按 Aegisub 语义等同 `\kf`），重建时沿用 → 形态不丢失。
 */
export function parseKLine(text, evStart, evEnd) {
  const src = String(text || '');
  let cursor = 0;              // 相对行首，厘秒
  let plainLen = 0;            // 明文游标（裸文本按序拼接的长度 = 明文里的偏移）
  let leadStart = -1;          // 首个 k 之前散文本在明文里的起点
  let open = null;             // 当前段 { startCs, durCs, text, pStart, pEnd }
  const segments = [];
  const headParts = [];
  let sawK = false;
  let kTag = '';               // 段标签形态（取第一个 k 段的写法）
  let lead = '';               // 首个 k 之前的散文本（并入第一段）
  const plainChunks = [];      // 按出现顺序收集的裸文本 = 该行渲染出的明文

  const flush = () => { if (open) { segments.push(open); open = null; } };
  const openSeg = (durCs) => { flush(); open = { startCs: cursor, durCs, text: '', pStart: plainLen, pEnd: plainLen }; cursor += durCs; };

  const re = /\{([^{}]*)\}|([^{}]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] != null) {
      const inner = m[1];
      const tagRe = /\\([kK])([fo]?|t)\s*(\d+)/g;
      let t, any = false;
      while ((t = tagRe.exec(inner))) {
        any = true;
        if (t[2] === 't') {                       // \kt<cs>: 下一段起点 = 相对行首的绝对时间
          flush();
          cursor = parseInt(t[3], 10) || 0;
        } else {
          if (!kTag) {
            const mod = (t[2] || '').toLowerCase();
            kTag = (mod === 'f' || (mod === '' && t[1] === 'K')) ? '\\kf' : (mod === 'o' ? '\\ko' : '\\k');
          }
          openSeg(parseInt(t[3], 10) || 0);
        }
      }
      if (any) {
        sawK = true;
        if (open && lead) { open.text = lead + open.text; open.pStart = leadStart; open.pEnd = plainLen; lead = ''; }
      } else if (!sawK) {
        headParts.push(inner);                    // 颜色头等（第一个 k 之前的块）
      }
      // 第一个 k 之后的非 k 覆盖块：忽略（罕见布局，重生成时不保留——设计稿已注明）
    } else {
      // 裸文本 = 该行渲染出的**明文**。按出现顺序原样收集（parseKLine 的 text 用它拼,
      // 保住原文里的空格 —— "plan.to" 不能被重排成 "plan. to"）；\N/\h 视为空格。
      const chunk = m[2].replace(/\\[Nn]/g, ' ').replace(/\\h/g, ' ');
      const cStart = plainLen;
      plainLen += chunk.length;
      plainChunks.push(chunk);
      if (open) { open.text += chunk; open.pEnd = plainLen; }
      else if (!sawK) { lead += chunk; if (leadStart < 0) leadStart = cStart; }
      // k 段之后的裸文本（极端布局）：并入当前段
    }
  }
  flush();

  // 明文 = 该行渲染出的文字（原样保留词间空格；只去首尾空白）。它既进列表编辑,
  // 也是重建时"按原文位置交错"的基准 —— 用 words.join(' ') 会把 "plan.to" 重排成 "plan. to"。
  const rawPlain = plainChunks.join('');
  const trimmedOff = rawPlain.length - rawPlain.replace(/^\s+/, '').length;
  const plain = rawPlain.trim();

  const words = [];
  const lo = evStart, hi = Math.max(evStart, evEnd);   // 防御: 夹进事件范围(脏文件里 \k 总长可能超出事件)
  for (const seg of segments) {
    const raw = String(seg.text);
    const w = raw.trim();
    if (!w) continue;
    // 该词在明文里的位置（trim 掉的首尾空白不计入）—— 重建时按它逐字回填, 任何空格布局都零损失
    const leadWs = raw.length - raw.trimStart().length;
    const trailWs = raw.length - raw.trimEnd().length;
    const pStart = Math.max(0, (seg.pStart || 0) + leadWs - trimmedOff);
    const pEnd = Math.max(pStart, (seg.pEnd || 0) - trailWs - trimmedOff);
    words.push({
      w,
      s: Math.max(lo, Math.min(hi, evStart + seg.startCs / 100)),
      e: Math.max(lo, Math.min(hi, evStart + (seg.startCs + seg.durCs) / 100)),
      pStart, pEnd
    });
  }
  const head = headParts.join('');
  const m1 = /\\1?c&H([0-9A-Fa-f]{6})&/.exec(head);      // \c 与 \1c 等价（已唱/高亮位）
  const m2 = /\\2c&H([0-9A-Fa-f]{6})&/.exec(head);       // \2c 未唱位
  const highlightTag = m1 ? `{\\c&H${m1[1].toUpperCase()}&}` : null;
  const baseHex = m2 ? assColorToHex(m2[1].toUpperCase()) : null;
  return { head, highlightTag, baseHex, kTag, words, text: plain };
}

/**
 * k 卡拉OK行在**文件侧**的词数 = 该行事件里 `\k` 段中带文本的段数。
 *
 * 用途: 坏行检测判"内存模型 ↔ 落盘段序列"是否漂移。k 行的分词由**文件自己**决定（一段一音节,
 * 是作者的原始切分）, 与 `splitEnglishWords`（本应用按 `, . ? !` 再切一刀的规则）本就不同 ——
 * 拿后者去比会一打开外来 k 文件就整轨误报"英文缺词"。k 行只在该段数与内存里的 words 不一致时
 * 才算真脏（那才是文本/序列化漂移）。
 * 事件不是单条（脏数据）→ 返回 0（调用方按"无从判定"处理）。
 */
export function kLineTokens(sent) {
  const evs = (sent && sent.events) || [];
  if (evs.length !== 1) return 0;
  return parseKLine(evs[0].text, sent.start, sent.end).words.length;
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
    for (const ev of evs) if (HL_RE.test(ev.text) || K_ANY_RE.test(ev.text)) hl++;
    if (hl / evs.length > 0.3 && evs.length > best) { wordStyle = style; wordEvents = evs; best = evs.length; }
  }

  // 手动转换短字幕（不到 6 条切片）会被上面的保守阈值漏掉；只信任本应用写入的
  // 明确样式元数据，且再次确认该样式确有逐词颜色 span，不从语言内容猜测。
  if (!wordStyle) {
    const chosen = doc.getScriptInfoComment('SubFabricWordStyle');
    const events = byStyle.get(chosen) || [];
    if (chosen && events.some(ev => HL_RE.test(ev.text) || K_ANY_RE.test(ev.text))) { wordStyle = chosen; wordEvents = events; }
  }

  // 检测失败时的兜底: 整轨「去逐词」后文件里一条高亮切片都没有, 检测必然落空。
  // 若此时直接按"每个事件各自成句"输出, 中英配对会整体失效、重载后行数翻倍(实测 6 行 → 12 行),
  // 所以改用时间包含规律把逐词样式推断出来, 后面的切片/配对流程照常走。
  if (!wordStyle) {
    const plain = [];
    for (const ev of doc.sorted) plain.push({ style: ev.style, start: ev.start, end: ev.end, text: assPlainText(ev.text) });
    const inferred = inferWordStyle(plain, null);
    if (inferred) { wordStyle = inferred; wordEvents = byStyle.get(inferred) || []; }
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
  const wholeSents = [];      // 逐词样式里的"整句事件"(已去逐词的行): 不能并进别行的切片组
  const kSentences = [];      // \k 卡拉OK行(单事件整行): 解析成同一份 words[], 不参与切片分组
  for (const sl of wordEvents) {
    if (K_ANY_RE.test(sl.text)) {
      const parsed = parseKLine(sl.text, sl.start, sl.end);
      if (parsed.words.length) {
        const sent = makeSentence(wordStyle, sl.start, sl.end, parsed.text, [sl], parsed.words,
          protoOf(sl, doc.format), parsed.highlightTag);
        sent.karStyle = 'k';
        sent.kHead = parsed.head;
        sent.kBaseHex = parsed.baseHex;
        sent.kTag = parsed.kTag || '\\k';
        kSentences.push(sent);
      } else {
        wholeSents.push(sl);   // 空词条的 k 行(极端脏数据): 退回整句, 重建时按普通行输出
      }
      continue;
    }
    const a = findAnchor(sl);
    if (a) { if (!groups.has(a)) groups.set(a, []); groups.get(a).push(sl); }
    else loose.push(sl);
  }
  // 组内"无高亮"的事件要分辨两种东西:
  //   ① 词间空档(buildWordSpecs 补的整句行) —— 纯文本与本组高亮切片一致, 属于这一句, 保留;
  //   ② 整句事件(该行已"去逐词", 只剩一条无高亮事件) —— 纯文本与本组切片不同, 不是这一句的切片。
  // 不拆②的后果(实测): 与现有行同起止的新建行, 上一行去逐词后的整句会被并进来,
  // 文本取最长者导致串味、另一条锚点的英文变空, 重载后与内存模型不一致。
  // 组内一个高亮切片都没有时(整组都是整句事件), 全部判为②。
  for (const [a, S] of [...groups]) {
    const hlTexts = new Set();
    for (const e of S) if (HL_RE.test(e.text)) hlTexts.add(stripTags(e.text));
    const keep = [], out = [];
    for (const e of S) (HL_RE.test(e.text) || hlTexts.has(stripTags(e.text)) ? keep : out).push(e);
    if (!out.length) continue;
    if (keep.length) groups.set(a, keep); else groups.delete(a);
    wholeSents.push(...out);
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
  // 整句事件(逐词样式的"去逐词"行)各自成句 —— 交给 pairRows 按时间与中文行配对, 保持"一行一句"
  for (const ev of wholeSents) {
    sentences.push(makeSentence(wordStyle, ev.start, ev.end, stripTags(ev.text), [ev], [], protoOf(ev, doc.format)));
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

  sentences.push(...kSentences);
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
 * 角色名标签与正文之间的间距：规范成**恰好一个空格**（用户要求："[wato] 我"，
 * 不许两个空格、也不许没有空格）。
 *   '[wato]我' / '[wato]   我' / '[wato]\t我' → '[wato] 我'
 *   只有标签没有正文 → '[wato]'（不留尾随空格）
 *   正文内部的空格一律不动（'[wato] 你好  世界' 保持原样），只规范**标签与正文之间**这一处。
 * 只认行首的 [..]（角色名的位置）；正文里出现的方括号、以及空的 '[]' 都原样返回。
 * 允许文本以 ASS 覆盖标签开头（'{\c&H..&}[wato]我'），前缀原样保留。
 */
export function normalizeRoleGap(text) {
  const s = String(text == null ? '' : text);
  const m = /^((?:\s*\{[^}]*\})*)(\s*)\[([^\]\n]{1,64})\]([ \t\u3000]*)([\s\S]*)$/.exec(s);
  if (!m) return s;
  const name = m[3].trim();
  if (!name) return s;                                    // '[]' 不是角色名
  const body = m[5].replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, '');
  if (!body) return m[1] + m[2] + '[' + name + ']';
  return m[1] + m[2] + '[' + name + '] ' + body;
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
  wordStyle = inferWordStyle(sentences, wordStyle);   // 退化态兜底(见 inferWordStyle)
  const anchors = sentences.filter(s => s.style !== wordStyle).sort((a, b) => a.start - b.start || a.end - b.end);
  const wordSents = sentences.filter(s => s.style === wordStyle).sort((a, b) => a.start - b.start || a.end - b.end);
  const used = new Set();
  const enOf = new Map();

  const EPS = 0.05;
  /** 包住 w 的中文行里最贴合的一条(起止误差最小, 同则跨度最小); taken 里的行已被别的词句认领, 跳过不选 ——
   *  否则同起止的两行(新建行与现有行完全重叠)会让第二条词句找不到主人, 落单成"单英文行"、另一行英文变空。 */
  function ownerOf(w, taken) {
    let lo = 0, hi = anchors.length - 1, pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].start <= w.start + EPS) { pos = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let best = null;
    for (let i = pos; i >= 0 && anchors[i].start >= w.start - 5; i--) {
      const z = anchors[i];
      if (taken && taken.has(z)) continue;
      if (w.start < z.start - EPS || w.end > z.end + EPS) continue;
      const err = Math.abs(z.start - w.start) + Math.abs(z.end - w.end);
      const dur = z.end - z.start;
      // 并列时(同起止的两条行, 误差/跨度全等)取**靠前**那条 —— 文件里的天然顺序:
      // 先出现的词句配先出现的整句行, 与编辑时的内存模型一致(否则重载后两行内容互换)。
      if (!best || err < best.err - 1e-9
        || (Math.abs(err - best.err) <= 1e-9 && dur <= best.dur + 1e-9)) best = { z, err, dur };
    }
    return best ? best.z : null;
  }

  for (const w of wordSents) {
    const z = ownerOf(w, enOf);
    if (z) { enOf.set(z, w); used.add(w); }
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
 * 找出「中文整句样式里残留的逐词切片」行(载入自愈用, 纯函数便于单测)。
 * 病灶(实测文件): 中文字幕句被切成逐词切片后, 一次中文整句编辑把 1 号切片原地改写回整句
 * (applyAnchorSentence 只动 events[0], 还会继承切片的绿色标签) —— 词 2..n 的切片成了无主
 * 事件留在文档里继续渲染, 画面上**同一句中文出现两遍**; 重载后这些切片各自成行(zh-only),
 * 挤在主行后面。修复见 main.js 的 applyAnchorSentence(写入端折叠) + setAss(载入清理)。
 * 判定(全部满足才判残留, 宁可漏判不可误删):
 *   ① zh-only 行(没配到英文逐词句) 且只有一条事件
 *   ② 事件文本含逐词高亮标签 {\c&H..&}..{\c} —— 正常中文整句行绝不会有
 *   ③ 时间被另一条**有英文配对**的中文行严格整段包住(±0.05s)
 *   ④ 剥标签后文本与宿主行一致或互为包含(切片含整句文本)
 */
export function ghostZhRows(rows) {
  const EPS = 0.05;
  const hosts = rows.filter(r => r.zh && r.en);
  const out = [];
  for (const g of rows) {
    if (!g.zh || g.en) continue;                       // ①
    const evs = g.zh.events || [];
    if (evs.length !== 1 || !HL_RE.test(evs[0].text || '')) continue;   // ①②
    const gText = assPlainText(evs[0].text);
    if (!gText) continue;
    for (const h of hosts) {
      if (g.zh.start < h.zh.start - EPS || g.zh.end > h.zh.end + EPS) continue;   // ③ 被包住
      if (h.zh.start >= g.zh.start - EPS && h.zh.end <= g.zh.end + EPS) continue; // ③ 且真包含(排除同跨度的)
      const hText = assPlainText(h.zh.events[0].text);
      if (hText && (hText === gText || hText.includes(gText) || gText.includes(hText))) { out.push(g); break; }   // ④
    }
  }
  return out;
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
/**
 * 英文字幕分词：空白 **与 `,` `.` `?` `!`** 都算分隔符（用户要求：遇到这类标点就"逐词一次"）。
 *   'SMP,I plan.to nuke Capital City,' → ['SMP,','I','plan.','to','nuke','Capital','City,']
 * 规则说明：
 *  · 标点**留在前一个词的尾部** —— 于是不会切出"只含标点"的孤立切片（那种片子在画面上闪一下很难看）；
 *  · 行首若是孤立标点，并到它后面那个词上；
 *  · 连着的标点（'wait...' / 'what?!'）留在同一个词里；
 *  · 撇号不切（don't / it's 仍是一个词）。
 * 这里也是**词数一致性检查**的唯一口径：坏行判定的"逐词数与文本词数不符"必须用它数，
 * 否则带黏连标点的行会被误判成缺词。
 */
/**
 * 分词 + **在原文本里的位置**（同一套规则）。给 `buildWordSpecs` 用：它必须按同一口径
 * 把高亮标签包裹到原文的词上，否则"12 个词 / 10 个空白段"对不上，就会退回按空白重建
 * （结果就是 `SMP,I`、`plan.to` 又黏成一片 —— 踩过）。
 * 返回 [{ w, start, end }]，start/end 是原文里的字符下标。
 */
export function splitEnglishWordsWithSpans(text) {
  const s = String(text == null ? '' : text);
  const isPunct = (ch) => ch === ',' || ch === '.' || ch === '?' || ch === '!';
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (isPunct(s[i]) && out.length) {           // 标点 → 挂到前一个词尾
      let j = i;
      while (j < n && isPunct(s[j])) j++;
      out[out.length - 1].w += s.slice(i, j);
      out[out.length - 1].end = j;
      i = j;
      continue;
    }
    const start = i;
    const fusedNumber = /^([a-z]{2,})(\d{2,})(?=[\s.,?!]|$)/.exec(s.slice(i));
    const fusedToken = fusedNumber && fusedNumber[0].toLowerCase();
    if (fusedNumber && !['covid19', 'h264', 'h265', 'x264', 'x265', 'win32', 'win64'].includes(fusedToken)
        && !/^(?:iphone|gpt|rtx|gtx)\d+$/.test(fusedToken)) {
      const splitAt = i + fusedNumber[1].length;
      out.push({ w: s.slice(start, splitAt), start, end: splitAt });
      i = splitAt;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(s[j]) && !(isPunct(s[j]) && j > i)) j++;
    while (j < n && isPunct(s[j])) j++;          // 词尾紧跟的标点算这个词的
    out.push({ w: s.slice(start, j), start, end: j });
    i = j;
  }
  return out;
}

export function splitEnglishWords(text) {
  return splitEnglishWordsWithSpans(text).map(x => x.w);
}

/** 显式选定英文样式后仍逐句从严检查：中文、已有切片和不明覆盖特效均跳过。 */
export function eligibleForWordConversion(sent, style) {
  if (!sent || !style || sent.style !== style || !sent.events || sent.events.length !== 1 || sent.words.length) return false;
  if (sent.bad || !(sent.end > sent.start)) return false;
  const text = String(sent.text || '');
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)) return false;
  // 普通 ASS 若自带内联特效，不能为了转词而抹掉其原始标签；交给用户单独处理。
  if (/\{\\[^}]*\}/.test(sent.events[0].text || '')) return false;
  return splitEnglishWords(text).length > 0;
}

export function recalcWords(sentence, newText, newStart, newEnd) {
  const tokens = splitEnglishWords(newText);
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

/** 依据干净文本 + 词级映射重建逐词 Dialogue spec 列表 —— 按句子形态分派:
 *  karStyle='k' → 单事件 \k 卡拉OK形态(buildWordSpecsK); 其余 → 逐词颜色切片形态(原实现)。
 *  所有调用点(拖词重计时/改文本/去逐词还原/导出…)无需关心形态差异。 */
export function buildWordSpecs(sentence) {
  return sentence.karStyle === 'k' ? buildWordSpecsK(sentence) : buildWordSpecsColor(sentence);
}

/** 颜色切片形态(原实现, 行为零改动) */
function buildWordSpecsColor(sentence) {
  const p = sentence.proto;
  const base = { layer: p.layer, style: sentence.style, name: p.name, effect: p.effect, margins: p.margins };
  if (!sentence.words.length) {
    return [Object.assign({}, base, { start: sentence.start, end: sentence.end, text: sentence.text })];
  }
  const spans = splitEnglishWordsWithSpans(sentence.text);   // 与 recalcWords / 词数检查同一口径

  // 文本与词数不一致(理论上先经过 recalcWords 不会走到这里):
  // 不放弃逐词效果 —— 按实际词数在句时长内均匀铺满, 而不是塌成单条干净行。
  let words = sentence.words;
  if (spans.length !== words.length) {
    const n2 = spans.length || 1;
    const s0 = sentence.start, span = Math.max(0.01, sentence.end - s0);
    words = spans.map((sp, k) => ({
      w: sp.w,
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
    const sp = spans[k];
    // 原位包裹: 把 tag 插到该词的开头、{\c} 插到词尾 —— 词以外的一个字符都不动
    const marked = sp
      ? sentence.text.slice(0, sp.start) + tag + sp.w + '{\\c}' + sentence.text.slice(sp.end)
      : sentence.text;
    push(w.s, w.e, marked);
    const nx = words[k + 1];
    if (nx && w.e < nx.s - 0.004) push(w.e, nx.s, sentence.text);
  }
  const lastW = words[words.length - 1];
  if (lastW.e < sentence.end - 0.004) push(lastW.e, sentence.end, sentence.text);
  return specs;
}

/** \k 卡拉OK形态: 单事件整行。全部按**厘秒整数**推进段序列, 严格保证总和 = 行时长。
 *  · 已唱/高亮色 ← sentence.highlightTag(沿用现有"逐词高亮色"链路); 未唱色 ← sentence.kBaseHex(可空)
 *  · 空档(句首/词间/行尾)写空段 filler: 渲染上与连排等效, 但能把词的真实 e 保真还原(往返=0 误差)
 *  · 头部保留 kHead 里的其它 tag(如 \an8), 只重写两个颜色位 */
function buildWordSpecsK(sentence) {
  const p = sentence.proto;
  const base = { layer: p.layer, style: sentence.style, name: p.name, effect: p.effect, margins: p.margins };
  if (!sentence.words.length) {
    return [Object.assign({}, base, { start: sentence.start, end: sentence.end, text: sentence.text })];
  }
  const startCs = Math.round(sentence.start * 100);
  const endCs = Math.max(startCs + 1, Math.round(sentence.end * 100));

  // 词边界 → 厘秒(夹进行范围), 单调防御(与 normalizeWords 同口径)
  const ws = sentence.words.map((x) => ({
    w: x.w,
    sCs: Math.max(startCs, Math.min(endCs - 1, Math.round(x.s * 100))),
    eCs: Math.max(startCs + 1, Math.min(endCs, Math.round(x.e * 100)))
  }));
  for (let i = 0; i < ws.length; i++) {
    if (i > 0 && ws[i].sCs < ws[i - 1].eCs) ws[i].sCs = ws[i - 1].eCs;
    if (ws[i].eCs <= ws[i].sCs) ws[i].eCs = Math.min(endCs, ws[i].sCs + 1);
  }
  // 末词**不**强贴行尾: 行尾留空时写一条 filler 空段兜底(与颜色形态同构)。
  // 应用自身的编辑路径(拖末词结束边界 / normalizeWords)恒有 words[last].e == 句尾, 所以正常情况下
  // 与"末词吸收全部舍入误差"等价; 但也因此外来文件尾部留空时能原样往返, 不会被静默改写。

  let txt = kHeadFor(sentence);
  let cursor = startCs;
  const kt = K_TAGS.has(sentence.kTag) ? sentence.kTag : '\\k';   // 形态沿用原文件（\kf/\ko 不丢）
  const pushK = (durCs) => { txt += '{' + kt + Math.max(0, durCs) + '}'; };
  // 词间/首尾的**原文**按位置回填 —— "plan.to" 不能被重排成 "plan. to"（颜色形态是原位包标签,
  // 明文从来不动; k 形态也必须做到, 外来文件的无空格分段/CJK 歌词才不会被塞进空格）。
  // 位置来源按可靠性递减:
  //   ① parseKLine 记下的原文位置（words[].pStart/pEnd, 文件自己的分段布局, 逐字节零损失）
  //   ② 应用分词口径在 sentence.text 里对齐（编辑/重算过的模型, 词就是从这段文本切出来的）
  //   ③ 兜底"词 + 空格"连排（连明文都对不上时的最后手段, 仅脏数据会发生）
  const src = String(sentence.text || '');
  let spans = null;
  if (sentence.words.every(w => typeof w.pStart === 'number' && typeof w.pEnd === 'number')) {
    const cand = sentence.words.map(w => ({ start: w.pStart, end: w.pEnd }));
    if (cand.every((sp, i) => src.slice(sp.start, sp.end) === sentence.words[i].w)) spans = cand;
  }
  if (!spans) {
    const toks = splitEnglishWordsWithSpans(src);
    if (toks.length === ws.length) spans = toks.map(t => ({ start: t.start, end: t.end }));
  }
  const literal = !!spans;
  let prev = 0;
  for (let i = 0; i < ws.length; i++) {
    if (literal) txt += src.slice(prev, spans[i].start);                          // 词间原文（归属上一段）
    if (ws[i].sCs > cursor) { pushK(ws[i].sCs - cursor); cursor = ws[i].sCs; }   // 空档 filler
    pushK(ws[i].eCs - cursor);                                                  // 词段
    cursor = ws[i].eCs;
    txt += literal ? src.slice(spans[i].start, spans[i].end)
      : (ws[i].w + (i < ws.length - 1 ? ' ' : ''));
    if (literal) prev = spans[i].end;
  }
  if (literal) txt += src.slice(prev);                                          // 尾部原文
  if (cursor < endCs) pushK(endCs - cursor);                                    // 行尾兜底
  return [Object.assign({}, base, { start: sentence.start, end: sentence.end, text: txt })];
}

/** k 行的颜色头: {\1c已唱&\2c未唱&…}。已唱 ← highlightTag 解析(默认绿); 未唱 ← kBaseHex(没有则不写)。
 *  kHead 里的其它 tag 保留; 颜色位统一重写一份, 避免重复与顺序问题。 */
function kHeadFor(sentence) {
  let sung = '#00ff00';
  const m = /\\1?c&H([0-9A-Fa-f]{6})&/.exec(sentence.highlightTag || '');
  if (m) sung = assColorToHex(m[1].toUpperCase());
  const rest = String(sentence.kHead || '')
    .replace(/\\(?:1c|2c)&H[0-9A-Fa-f]{6}&/g, '')
    .replace(/\\c&H[0-9A-Fa-f]{6}&/g, '');
  const baseBgr = sentence.kBaseHex ? hexToBgr6(sentence.kBaseHex) : '';
  return '{\\1c&H' + hexToBgr6(sung) + '&' + (baseBgr ? '\\2c&H' + baseBgr + '&' : '') + rest + '}';
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

/** 去掉一行的内联标签，只留**纯文本**：颜色覆盖标签(`{\c&H..&}`/`{\c}`/`{\1c..}`)、行首说话人名字
 *  标签(`[..]`)、逐词高亮标签都剥掉，换行(`\N`)转空格。合并字幕时"后段以纯文本并入上一句"用它。 */
export function stripInlineTags(text) {
  return String(text == null ? '' : text)
    .replace(/\{\\[1234]?c(?:&H[0-9A-Fa-f]{6}&)?\}/g, '')   // 颜色覆盖 / 高亮标签
    .replace(/\\[Nn]/g, ' ')                                // 换行 → 空格
    .replace(/^\s*\[[^\]]+\]\s*/, '')                       // 行首说话人名字标签
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 合并两条相邻字幕的文本与词级时间（纯函数；main.js 的「与上一条合并」用它）。
 *
 * 规则（用户定的）：
 *   · **中文**：后段以**纯文本**并入上一句（剥掉颜色/角色/高亮标签）。中文行**绝不能**造逐词切片 ——
 *     以前这里跑 recalcWords + buildWordSpecs，中文行会被切成一条条 `{\c&H00FF00&}词{\c}`（用户报的
 *     「合句会把颜色标签一起合上去」就是它），行首的角色色标也会被高亮标签顶掉。
 *   · **英文**：**不重排**已有的词级时间 —— 只把「上一句末词的结束」接到「本句开始」（补掉中间的停顿），
 *     本句的词按原时间接在后面；两段的真实词级时间都不动。
 *     本句没有词级时间时，把上一句末词延伸到整块结束；上一句没有词级时间时，把本句首词起点拉回整块开始。
 *
 * @returns {{ start:number, end:number, zhText:string, enText:string, enWords:Array }}
 */
export function mergeRowParts(prev, row) {
  const P = prev || {}, R = row || {};
  const normN = (t) => String(t == null ? '' : t).replace(/\\[Nn]/g, ' ');
  const start = Math.min(Number(P.start) || 0, Number(R.start) || 0);
  const end = Math.max(Number(P.end) || 0, Number(R.end) || 0);

  // 中文：上一句保留自己的行首角色色标（那是这条字幕的颜色），后段纯文本并入
  const zhA = normN(P.zh && P.zh.text).trim();
  const zhB = stripInlineTags(R.zh && R.zh.text);
  const zhText = [zhA, zhB].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  // 英文：后段同样以纯文本并入（顺手收拾标点前的空格）
  const enA = normN(P.en && P.en.text).trim();
  const enB = stripInlineTags(R.en && R.en.text);
  const enText = [enA, enB].filter(Boolean).join(' ')
    .replace(/\s+([,.!?;:、。])/g, '$1').replace(/\s+/g, ' ').trim();

  const pw = (P.en && Array.isArray(P.en.words)) ? P.en.words : [];
  const cw = (R.en && Array.isArray(R.en.words)) ? R.en.words : [];
  const enWords = [];
  for (const w of pw) enWords.push({ w: w.w, s: w.s, e: w.e });
  for (const w of cw) enWords.push({ w: w.w, s: w.s, e: w.e });
  const MIN = 0.01;                                        // ASS 时间精度：每片至少 1 厘秒
  if (enWords.length) {
    if (pw.length && cw.length) {
      const bi = pw.length - 1;
      enWords[bi].e = Math.max(enWords[bi].e, Number(R.start) || enWords[bi].e);   // 上句末词接到本句开始
    } else if (pw.length) {
      const bi = pw.length - 1;
      enWords[bi].e = Math.max(enWords[bi].e, end);                                // 本句没有词级时间
    } else {
      enWords[0].s = Math.min(enWords[0].s, start);                                // 上句没有词级时间
    }
    // 兜底：全部夹进 [start,end]、每片 ≥1 厘秒、相邻不重叠（normalizeWords 同口径的轻量版）
    for (const w of enWords) {
      w.s = Math.min(Math.max(w.s, start), Math.max(start, end - MIN));
      w.e = Math.min(Math.max(w.e, w.s + MIN), Math.max(start + MIN, end));
    }
    for (let i = 1; i < enWords.length; i++) {
      if (enWords[i].s < enWords[i - 1].e) enWords[i].s = enWords[i - 1].e;
      if (enWords[i].e < enWords[i].s + MIN) enWords[i].e = Math.min(end, enWords[i].s + MIN);
    }
  }
  return { start, end, zhText, enText, enWords };
}

/** 在事件文本里**替换或插入**行首的 `[角色名]` 标签，并保证**标签与正文之间恒为一个空格**
 *  （与 normalizeRoleGap 同一条规则；行首的 `{...}` 色标块原样保留在标签之前）。
 *
 *  用户报过的 bug：初稿（没做说话人分离 → 没有角色名标签）之后在编辑器里指定角色，
 *  标签与正文会紧贴成 `[Spoke]正文` —— 因为只有"替换"分支保留了原文里已有的空格，
 *  "插入"分支直接把标签拼在正文前面。这里两条分支都走 normalizeRoleGap。 */
export function setSpeakerTagInText(text, tag) {
  const t = String(text == null ? '' : text);
  const head = /^(?:\s*\{[^}]*\})*/.exec(t)[0];
  const rest = t.slice(head.length);
  const m = /^\s*\[[^\]]*\]/.exec(rest);
  const body = m ? rest.slice(m[0].length) : rest;
  return head + normalizeRoleGap(String(tag) + (/^\s/.test(body) ? '' : ' ') + body);
}

/** 「未分配角色」—— “查找与批量替换”角色页签里的**虚拟角色**：指代所有**中文行没有 [角色] 标签**的行。
 *  它不是真角色: 不出现在角色列表/角色筛选里, 只在该页签的两个候选框里可选。 */
export const UNASSIGNED_ROLE = '未分配角色';

/** 这一行是否"没有角色标签"（= 未分配角色）。以中文行行首**可见**的 [..] 为准, 与角色列表同口径。 */
export function isUnassignedRole(row) {
  if (!row) return true;
  if (!row.zh) return true;
  return !speakerTextTagOf(row.zh);
}

/** 去掉事件文本行首的 [角色名] 标签（"设为未分配角色"用）。
 *  行首的 {..} 覆盖标签原样保留; 标签带的前后空白一起收掉, 免得留下 "{\c..&} 正文" 这种前导空格。
 *  @returns {{ text: string, removed: boolean }} */
export function stripSpeakerTag(text) {
  const t = String(text == null ? '' : text);
  const head = /^(?:\s*\{[^}]*\})*/.exec(t)[0];
  const rest = t.slice(head.length);
  const m = /^\s*\[[^\]]*\]/.exec(rest);
  if (!m) return { text: t, removed: false };
  return { text: head + rest.slice(m[0].length).replace(/^\s+/, ''), removed: true };
}
