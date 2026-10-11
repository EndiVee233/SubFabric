/** ASS 文档模型: 保留原文行, 事件级编辑后整体序列化 */
import { parseTimeAss, fmtTimeAss } from './util.js';

/** 严格合法的 ASS 时间: h:mm:ss.cc (小数固定 2 位) */
const ASS_TIME_RE = /^\d+:\d{1,2}:\d{2}[.,]\d{2}$/;

export function isAssSubtitle(text, name = '') {
  if (/\.(?:ass|ssa)$/i.test(String(name || ''))) return true;
  const source = String(text || '').replace(/^\uFEFF/, '');
  const hasStyles = /^\s*\[V4\+?\s+Styles\]\s*$/im.test(source);
  const hasScriptInfo = /^\s*\[Script Info\]\s*$/im.test(source);
  const hasEvents = /^\s*\[Events\]\s*$/im.test(source);
  const hasDialogue = /^\s*(?:Dialogue|Comment)\s*:/im.test(source);
  return hasEvents && hasDialogue && (hasStyles || hasScriptInfo);
}

export class AssDoc {
  constructor(text) {
    this.text = text.replace(/^﻿/, '');
    this.lines = this.text.split(/\r\n|\n/);
    this.events = [];      // [{lineIdx, layer, start, end, style, name, text, endByNext}]
    this.format = [];      // Events Format 列
    this.styleNames = [];  // V4+ / V4 Styles 名称
    this.styles = new Map(); // 样式名 → 字段值与原文行
    this.styleFormat = [];
    this.playResX = 384; this.playResY = 288;
    this._parse();
  }

  _parse() {
    /* ⚠ 必须先清空再解析 —— 这个函数原来只在构造函数里跑一次，所以是"累加"写法。
     *  现在 orderDialoguesByStyle() 会**再跑一次**（行序/行号变了要重新对齐），
     *  不清就会把样式和事件重复一份（styles 后写覆盖、events 直接翻倍）。 */
    this.events = [];
    this.styleNames = [];
    this.styles = new Map();
    this.format = [];
    this.styleFormat = [];
    let section = '';
    let fmt = null;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) { section = sec[1].toLowerCase(); continue; }

      if (section === 'script info') {
        const pr = /^\s*(PlayResX|PlayResY)\s*:\s*(\d+)/i.exec(line);
        if (pr) {
          if (pr[1].toLowerCase() === 'playresx') this.playResX = +pr[2];
          else this.playResY = +pr[2];
        }
      } else if (section === 'v4+ styles' || section === 'v4 styles') {
        const fm = /^\s*Format\s*:\s*(.+)$/i.exec(line);
        if (fm) {
          this.styleFormat = fm[1].split(',').map(s => s.trim().toLowerCase());
          this.styleFormatLineIdx = i;
          continue;
        }
        const sm = /^\s*Style\s*:\s*(.*)$/i.exec(line);
        if (sm && this.styleFormat.length) {
          const values = sm[1].split(',');
          const nameIdx = this.styleFormat.indexOf('name');
          const name = String(values[nameIdx === -1 ? 0 : nameIdx] || '').trim();
          if (name) {
            this.styleNames.push(name);
            this.styles.set(name.toLowerCase(), {
              name, lineIdx: i, format: this.styleFormat.slice(), values
            });
          }
        }
      } else if (section === 'events') {
        const fm = /^\s*Format\s*:\s*(.+)$/i.exec(line);
        if (fm) {
          fmt = fm[1].split(',').map(s => s.trim().toLowerCase());
          this.format = fmt;
          this.eventsFormatLineIdx = i;
          continue;
        }
        const dm = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
        if (dm && fmt) {
          const ev = this._parseDialogue(dm[1], fmt, i);
          if (ev) this.events.push(ev);
        }
      }
    }
    // 按开始时间排序的索引(原文顺序保留在 lineIdx)
    this.sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  _parseDialogue(rest, fmt, lineIdx) {
    // Text 列可能含逗号 → 只切 fmt.length-1 刀
    const parts = [];
    let s = rest;
    for (let k = 0; k < fmt.length - 1; k++) {
      const idx = s.indexOf(',');
      if (idx === -1) return null;
      parts.push(s.slice(0, idx).trim());
      s = s.slice(idx + 1);
    }
    parts.push(s); // text 原文(含前后空格习惯保留)
    const get = (col) => { const i = fmt.indexOf(col); return i === -1 ? '' : parts[i]; };
    const rawStart = String(get('start') || '').trim();
    const rawEnd = String(get('end') || '').trim();
    let start = parseTimeAss(rawStart);
    let end = parseTimeAss(rawEnd);
    // 时间异常(历史遗留的 .100 厘秒溢出等)不丢弃整条事件: 丢弃会让"模型事件数"少于
    // "文件行数", 后续 replaceEvents 只替换部分行 → 残留孤儿行 → 重复字幕。
    // 异常处打上 bad 标记, 供列表「⚠ 异常行」过滤展示。
    const bad = {};
    if (!ASS_TIME_RE.test(rawStart) || isNaN(start)) { bad.start = rawStart; if (isNaN(start)) start = 0; }
    if (!ASS_TIME_RE.test(rawEnd) || isNaN(end)) { bad.end = rawEnd; if (isNaN(end)) end = 0; }
    if (end < start) { bad.order = `${fmtTimeAss(start)} → ${fmtTimeAss(end)}`; end = start; }
    return {
      lineIdx,
      layer: get('layer') || '0',
      start, end,
      bad: Object.keys(bad).length ? bad : null,
      style: get('style') || 'Default',
      name: get('name') || '',
      text: parts[fmt.indexOf('text') === -1 ? parts.length - 1 : fmt.indexOf('text')],
      _rawParts: parts
    };
  }

  /** 重建某一 Dialogue 行 */
  _rebuildLine(ev) {
    const parts = ev._rawParts.slice();
    const set = (col, val) => { const i = this.format.indexOf(col); if (i !== -1) parts[i] = val; };
    set('start', fmtTimeAss(ev.start));
    set('end', fmtTimeAss(ev.end));
    set('text', ev.text);
    this.lines[ev.lineIdx] = 'Dialogue: ' + parts.join(',');
  }

  setEventTime(ev, start, end) {
    ev.start = Math.max(0, start);
    ev.end = Math.max(ev.start + 0.01, end);
    this._rebuildLine(ev);
    this.sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  setEventText(ev, text) {
    ev.text = text;
    this._rebuildLine(ev);
  }

  /** 修改事件的 Name(说话人)栏, 如 '[Spoke]' → '[___]'; 同步 _rawParts 供重建 */
  setEventName(ev, name) {
    ev.name = name != null ? String(name) : '';
    if (ev._rawParts) {
      const i = this.format.indexOf('name');
      if (i !== -1) ev._rawParts[i] = ev.name;
    }
    this._rebuildLine(ev);
  }

  /** 在指定事件后插入新 Dialogue(复制其样式/说话人) → 返回新事件 */
  insertAfterEvent(ev) {
    const start = ev.end + 0.05;
    const end = start + 2;
    const parts = this.format.map(col => {
      switch (col) {
        case 'layer': return ev.layer || '0';
        case 'start': return fmtTimeAss(start);
        case 'end': return fmtTimeAss(end);
        case 'style': return ev.style;
        case 'name': return ev.name;
        case 'text': return '新字幕';
        case 'effect': return '';
        default: return '0'; // MarginL/R/V
      }
    });
    const line = 'Dialogue: ' + parts.join(',');
    this.lines.splice(ev.lineIdx + 1, 0, line);
    for (const e of this.events) if (e.lineIdx > ev.lineIdx) e.lineIdx++;
    const newEv = this._parseDialogue(parts.join(','), this.format, ev.lineIdx + 1);
    if (!newEv) return null;
    this.events.push(newEv);
    this.sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    return newEv;
  }

  deleteEvent(ev) {
    this.lines[ev.lineIdx] = null; // 序列化时剔除
    const i = this.events.indexOf(ev);
    if (i !== -1) this.events.splice(i, 1);
    this.sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  /** 批量删除事件(不位移其他行) */
  deleteEvents(oldEvents) {
    for (const ev of oldEvents) this.lines[ev.lineIdx] = null;
    const set = new Set(oldEvents);
    this.events = this.events.filter(e => !set.has(e));
    this.sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  /** 按格式构造 Dialogue 行 */
  _buildDialogueLine(spec) {
    const parts = this.format.map(col => {
      switch (col) {
        case 'layer': return spec.layer != null ? String(spec.layer) : '0';
        case 'start': return fmtTimeAss(spec.start);
        case 'end': return fmtTimeAss(spec.end);
        case 'style': return spec.style || 'Default';
        case 'name': return spec.name != null ? String(spec.name) : '';
        case 'effect': return spec.effect != null ? String(spec.effect) : '';
        case 'text': return spec.text;
        default: return (spec.margins && spec.margins[col] != null) ? String(spec.margins[col]) : '0';
      }
    });
    return 'Dialogue: ' + parts.join(',');
  }

  /**
   * 用新切片规格整体替换一组事件(同一句的逐词切片, 要求行号连续):
   * 返回新事件数组。后续事件行号自动校正。
   */
  replaceEvents(oldEvents, newSpecs) {
    if (!oldEvents.length) return [];
    const idxs = oldEvents.map(e => e.lineIdx).sort((a, b) => a - b);
    const first = idxs[0], last = idxs[idxs.length - 1];
    const newLines = newSpecs.map(s => this._buildDialogueLine(s));
    const contiguous = (last - first + 1) === idxs.length;
    if (contiguous) {
      this.lines.splice(first, idxs.length, ...newLines);
    } else {
      for (const ev of oldEvents) this.lines[ev.lineIdx] = null;
      this.lines.splice(first, 0, ...newLines);
    }
    const delta = newLines.length - (contiguous ? idxs.length : 0);
    const oldSet = new Set(oldEvents);
    this.events = this.events.filter(e => !oldSet.has(e));
    // first 之后的**所有**事件都位移(非连续场景下, 夹在首尾之间的其它事件同样被挤开)
    for (const e of this.events) if (e.lineIdx >= first) e.lineIdx += delta;
    const newEvents = [];
    newLines.forEach((line, k) => {
      const ev = this._parseDialogue(line.slice('Dialogue: '.length), this.format, first + k);
      if (ev) newEvents.push(ev);
    });
    this.events.push(...newEvents);
    this.sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    return newEvents;
  }

  getStyle(name) {
    const rec = this.styles.get(String(name || '').toLowerCase());
    if (!rec) return null;
    const out = {};
    rec.format.forEach((key, i) => { out[key] = String(rec.values[i] == null ? '' : rec.values[i]).trim(); });
    return out;
  }

  /** 按 Style Format 字段名更新样式, 保留未知字段和对话内容。 */
  setStyleFields(name, fields) {
    const rec = this.styles.get(String(name || '').toLowerCase());
    if (!rec) return false;
    const values = rec.values.slice();
    let changed = false;
    for (const [key, value] of Object.entries(fields || {})) {
      const idx = rec.format.indexOf(String(key).toLowerCase());
      if (idx === -1 || value == null) continue;
      const next = String(value);
      if (values[idx] !== next) { values[idx] = next; changed = true; }
    }
    if (!changed) return false;
    const line = this.lines[rec.lineIdx];
    const colon = line.indexOf(':');
    this.lines[rec.lineIdx] = line.slice(0, colon + 1) + ' ' + values.join(',');
    rec.values = values;
    return true;
  }



  /** [V4+ Styles] 里的样式声明顺序（名字数组）。
   *  ⚠ **这个顺序不影响画面上下** —— 实测过（最小 ASS × 四种组合）：
   *     样式[ZH,EN] 事件[ZH,EN] → 中文在下、英文在上
   *     样式[EN,ZH] 事件[ZH,EN] → 中文在下、英文在上   ← 换样式顺序，结果不变
   *     样式[*]     事件[EN,ZH] → 中文在上、英文在下
   *  决定上下的是 **Dialogue 事件在文件里的先后**（先写的贴 margin、后写的被上顶），
   *  见 orderDialoguesByStyle()。留着这个只读接口是为了排查与展示。 */
  stylesInOrder() {
    const arr = [];
    for (const idx of this._styleOrder()) {
      for (const rec of this.styles.values()) if (rec.lineIdx === idx) { arr.push(rec.name); break; }
    }
    return arr;
  }

  /**
   * 按"某种样式的事件排在前面"重排 [Events] 里的 Dialogue 行 —— 这才是决定画面上下
   * 的东西：libass 从底部往上摆，**先写的事件贴 margin（在下面）、后写的被上推**。
   *
   * `bottomStyle` = 要显示在**下面**的那条样式，它的事件排前面。
   *
   * 只在"时间上互相重叠"的事件之间调整相对顺序（按开始时间贪心分组），
   * 这样既改对了重叠那几行的上下，又不会把整份稿件的阅读顺序打乱。
   * @returns {boolean} 行序是否真的变了
   */
  orderDialoguesByStyle(bottomStyle) {
    const want = String(bottomStyle || '').toLowerCase();
    if (!want || !this.events.length) return false;
    const rank = (ev) => (String(ev.style || '').toLowerCase() === want ? 0 : 1);

    /* 按开始时间排序后贪心分组：与当前组"时间有交叠"的事件归为一组。
     * 组内重排（下面那条样式排前面），组间保持原顺序。 */
    const sorted = this.events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const groups = [];
    for (const ev of sorted) {
      const g = groups[groups.length - 1];
      if (g && ev.start < g.maxEnd - 1e-6) { g.list.push(ev); g.maxEnd = Math.max(g.maxEnd, ev.end); }
      else groups.push({ list: [ev], maxEnd: ev.end });
    }
    const ordered = [];
    for (const g of groups) {
      // 组内按 rank 稳定排序：rank 0（下面那条）在前，同 rank 保持原先后
      const idx = g.list.map((ev, i) => ({ ev, i }));
      idx.sort((a, b) => (rank(a.ev) - rank(b.ev)) || (a.i - b.i));
      for (const { ev } of idx) ordered.push(ev);
    }
    // 与现有顺序一致就不用动
    let same = ordered.length === this.events.length;
    for (let i = 0; same && i < ordered.length; i++) if (ordered[i] !== this.events[i]) same = false;
    if (same) return false;

    /* 把这些事件的行**按新顺序重新填回它们原本占用的那些行号**（行号集合不变，
     * 所以 [Events] 段的位置、以及其它行都不动 —— 不需要动整个文件的行号）。
     * 直接搬 `_rawParts`（原始的逐列内容），只把 style 列换成新事件的样式：
     * 这样 margin/effect 等列原样保留，也不会碰任何文本。 */
    const slots = this.events.map(ev => ev.lineIdx).sort((a, b) => a - b);
    const styleCol = this.format.indexOf('style');
    ordered.forEach((ev, i) => {
      const parts = (ev._rawParts || []).slice();
      if (styleCol !== -1) parts[styleCol] = ev.style;
      this.lines[slots[i]] = 'Dialogue: ' + parts.join(',');
    });
    this._parse();          // 行号/顺序都变了 → 重新对齐
    return true;
  }

  /** [V4+ Styles] 段里所有样式行的行号（按文件顺序）。
   *  仅供 stylesInOrder() 展示用 —— **不参与"谁在上"的判定**（见下）。 */
  _styleOrder() {
    const out = [];
    let inStyles = false;
    for (let i = 0; i < this.lines.length; i++) {
      const t = this.lines[i].trim();
      const sec = /^\[(.+)\]$/.exec(t);
      if (sec) { inStyles = /^v4\+? styles$/i.test(sec[1].trim()); continue; }
      if (inStyles && /^Style\s*:/i.test(t)) out.push(i);
    }
    return out;
  }

  /**
   * ⚠ 这里原来有个 `moveStyleBefore()`（重排 [V4+ Styles] 的声明顺序），**已删除**。
   *   它基于一个**错误假设**：以为"谁后声明谁被上推"。用最小 ASS 做过四组对照实测
   *   （就是预览用的那个 libass-wasm），样式顺序对上下**毫无影响**：
   *       样式[ZH,EN] 事件[ZH,EN] → 中文在下    样式[EN,ZH] 事件[ZH,EN] → 中文在下
   *       样式[任意]  事件[EN,ZH] → 中文在上
   *   决定上下的是 **Dialogue 事件的行序** —— 见 orderDialoguesByStyle()。
   */

  getScriptInfoComment(key) {
    const safe = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let section = '';
    for (const line of this.lines) {
      const sec = /^\s*\[(.+)\]\s*$/.exec(line);
      if (sec) { section = sec[1].toLowerCase(); continue; }
      if (section !== 'script info') continue;
      const m = new RegExp('^\\s*;\\s*' + safe + '\\s*:\\s*(.*?)\\s*$', 'i').exec(line);
      if (m) return m[1];
    }
    return '';
  }

  /** 在 [Script Info] 写入 SubFabric 私有注释元数据(其它 ASS 播放器会忽略)。 */
  setScriptInfoComment(key, value) {
    const safe = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^\\s*;\\s*' + safe + '\\s*:', 'i');
    let header = -1, end = this.lines.length;
    for (let i = 0; i < this.lines.length; i++) {
      const sec = /^\s*\[(.+)\]\s*$/.exec(this.lines[i]);
      if (!sec) continue;
      if (sec[1].toLowerCase() === 'script info') { header = i; continue; }
      if (header !== -1 && i > header) { end = i; break; }
    }
    const comment = `; ${key}: ${value}`;
    if (header === -1) {
      this.lines.unshift('[Script Info]', comment, '');
      for (const ev of this.events) ev.lineIdx += 3;
      if (this.eventsFormatLineIdx != null) this.eventsFormatLineIdx += 3;
      if (this.styleFormatLineIdx != null) this.styleFormatLineIdx += 3;
      for (const rec of this.styles.values()) rec.lineIdx += 3;
      return true;
    }
    for (let i = header + 1; i < end; i++) {
      if (re.test(this.lines[i])) {
        if (this.lines[i] === comment) return false;
        this.lines[i] = comment;
        return true;
      }
    }
    this.lines.splice(header + 1, 0, comment);
    for (const ev of this.events) if (ev.lineIdx > header) ev.lineIdx++;
    if (this.eventsFormatLineIdx > header) this.eventsFormatLineIdx++;
    if (this.styleFormatLineIdx > header) this.styleFormatLineIdx++;
    for (const rec of this.styles.values()) if (rec.lineIdx > header) rec.lineIdx++;
    return true;
  }

  serialize() {
    return this.lines.filter(l => l !== null).join('\r\n');
  }

  /** 临时预览快照：仅替换该句的输出事件；原始事件、行号及导出内容均不变。 */
  previewEvents(sentence, specs) {
    return this.previewMulti([{ sentence, specs }]);
  }

  /** 一句(整句/单切片) → 一条输出 spec。预览与多句预览共用。 */
  _specOf(sentence, text) {
    const p = sentence.proto || {};
    return {
      layer: p.layer, style: sentence.style, name: p.name,
      effect: p.effect, margins: p.margins,
      start: sentence.start, end: sentence.end, text
    };
  }

  /**
   * 多句同时替换的临时预览快照 —— 中文行与英文行的行内草稿要**一起**看到,
   * 不能编辑哪行就只预览哪行(否则按 Tab 切到另一行时, 前一行的草稿会在画面上消失)。
   * entries: [{ sentence, specs }] 或 [{ sentence, text }]; 原始事件与导出内容一律不动。
   */
  previewMulti(entries) {
    const jobs = [];
    for (const e of entries || []) {
      if (!e || !e.sentence || !e.sentence.events || !e.sentence.events.length) continue;
      const specs = e.specs && e.specs.length ? e.specs
        : (e.text != null ? [this._specOf(e.sentence, e.text)] : null);
      if (!specs || !specs.length) continue;
      const indices = new Set(e.sentence.events.map(ev => ev.lineIdx));
      jobs.push({ first: Math.min(...indices), indices, insert: specs.map(s => this._buildDialogueLine(s)) });
    }
    if (!jobs.length) return this.serialize();
    const out = [];
    for (let idx = 0; idx < this.lines.length; idx++) {
      const job = jobs.find(j => j.first === idx);
      if (job) out.push(...job.insert);
      if (jobs.some(j => j.indices.has(idx))) continue;   // 被替换掉的原事件不输出
      if (this.lines[idx] !== null) out.push(this.lines[idx]);
    }
    return out.join('\r\n');
  }

  previewSentence(sentence, safeText) {
    if (!sentence || !sentence.events || !sentence.events.length) return this.serialize();
    return this.previewMulti([{ sentence, text: safeText }]);
  }

  /** 按样式分车道(时间轴用) */
  lanesByStyle() {
    const map = new Map();
    for (const ev of this.sorted) {
      if (!map.has(ev.style)) map.set(ev.style, []);
      map.get(ev.style).push(ev);
    }
    return map;
  }
}

/** 去除 ASS 覆盖标签 → 预览纯文本。
 *  先还原转义(\N/\n/\h → 空格, \{ → {, \} → }, \\ → \), 再剥掉真正的覆盖标签 {…} ——
 *  顺序不能反: 否则被转义的成对花括号会被当成标签整段吞掉。 */
/** 去除 ASS 覆盖标签 → 预览纯文本。
 *  用扫描器而不是正则: 被转义的 \\{ 必须**先**还原成普通字符, 否则成对花括号会被当成
 *  覆盖标签整段吞掉(译文里出现 {音效} 这种时就会丢字)。\\N/\\n/\\h 视为空格。 */
export function assPlainText(text) {
  const s = String(text);
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'N' || n === 'n' || n === 'h') { out += ' '; i += 2; continue; }
      if (n === '{' || n === '}' || n === '\\') { out += n; i += 2; continue; }
      out += c; i += 1; continue;
    }
    if (c === '{') {
      const end = s.indexOf('}', i);       // 覆盖标签: 整段跳过
      if (end >= 0) { i = end + 1; continue; }
      out += c; i += 1; continue;
    }
    out += c; i += 1;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/* ═══════════ ASS 双语样式预设：导出 / 导入 ═══════════
 *
 * 为什么要它：双语样式（中英两条 Style 轨的字体/字号/粗斜/颜色 + 逐词高亮色、
 * 卡拉OK 未唱色与扫过形态）只能一条稿件一条稿件地手调，换稿件就得重来一遍。
 *
 * 为什么导出的是 **[V4+ Styles] 原始行 + 几个元数据**，而不是"面板上那 14 个控件值"：
 *   · Style 行里还有 Alignment / MarginV / Outline / Shadow / Spacing 等面板没暴露的字段，
 *     只存面板值会在导入时把它们丢掉（那是静默改坏观感）；
 *   · 存 format+values 两份，导入时可以**按字段名**取值再写进目标样式的字段位 ——
 *     两边 Format 声明顺序不同也不会错位（SSA 的 V4 与 ASS 的 V4+ 字段集就不一样）。
 * 代价是预设文件里带 ASS 语法，但这份文件本来就是给 SubFabric 自己读的，可以接受。
 */
export const ASS_STYLE_PRESET_KIND = 'subfabric.ass-style-preset';

/** 语言 → 样式名候选。预设文件里存的样式名可能与目标稿件不同（Default / 中文 / ZH…），
 *  所以导入时先按名字精确匹配，匹配不到再按这些线索找。
 *
 *  ⚠ 这些正则必须用**单词边界**，不能用 `(^|[-_])…([-_]|$)` 那种两侧配对：
 *    后者对 "English" 会把里面的 "zh" 当成中文线索命中（En-gli-**zh**），
 *    于是英文样式被认成中文轨 —— 单测抓到的真 bug（tests/ass-style-preset-test.mjs ③）。
 *    中文轨只认"独立成词的 zh/cn/chi"，别用子串。 */
const _STYLE_HINTS = {
  zh: [/chinese/i, /中文/, /mandarin/i, /\bzh\b/i, /\bcn\b/i, /\bchi\b/i],
  en: [/^default$/i, /english/i, /英文/, /\ben\b/i, /\beng\b/i],
};

/** 在一个 AssDoc 里按语言线索找样式名（targets 没覆盖到的兜底）。 */
export function findStyleForLang(doc, lang) {
  const names = (doc && doc.styleNames) || [];
  const hints = _STYLE_HINTS[lang] || [];
  for (const re of hints) {
    const hit = names.find(n => re.test(n));
    if (hit) return hit;
  }
  return '';
}

/** 把一条样式导成可移植的轨道数据。 */
function _trackOf(doc, name) {
  const rec = doc.styles.get(String(name || '').toLowerCase());
  if (!rec) return null;
  return { track: null, styleName: rec.name, format: rec.format.slice(), values: rec.values.slice() };
}

/**
 * 从稿件导出双语样式预设。
 * @param {AssDoc} doc
 * @param {{zh:string,en:string}} targets  双语目标样式名（见 main.js resolveAssStyleTargets）
 * @param {{wordColor?:string, kBase?:string, kSweep?:boolean}} meta
 * @returns {object|null} 预设对象；两条轨有一条缺失就返回 null（宁可报错也不导出半份）
 */
export function assStylePresetOf(doc, targets, meta = {}) {
  if (!doc || !targets) return null;
  const zh = _trackOf(doc, targets.zh), en = _trackOf(doc, targets.en);
  if (!zh || !en) return null;
  zh.track = 'zh'; en.track = 'en';
  const preset = {
    kind: ASS_STYLE_PRESET_KIND,
    version: 1,
    createdBy: 'SubFabric',
    createdAt: new Date().toISOString(),
    tracks: { zh, en },
  };
  if (/^#[0-9a-f]{6}$/i.test(meta.wordColor || '')) preset.wordColor = String(meta.wordColor).toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(meta.kBase || '')) preset.kBase = String(meta.kBase).toLowerCase();
  if (typeof meta.kSweep === 'boolean') preset.kSweep = meta.kSweep;
  return preset;
}

/**
 * 解析并校验预设 JSON（导入用）。**不抛异常**，一律返回 {ok, preset|error}，
 * 因为导入的文件是用户给的，任何形状都可能出现。
 */
export function parseAssStylePreset(text) {
  let obj = null;
  try { obj = JSON.parse(String(text == null ? '' : text)); }
  catch { return { ok: false, error: '不是合法的 JSON 文件' }; }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '文件内容不是对象' };
  if (obj.kind !== ASS_STYLE_PRESET_KIND) {
    return { ok: false, error: '不是 SubFabric 的样式预设文件（kind 不匹配）' };
  }
  const tr = obj.tracks;
  if (!tr || typeof tr !== 'object') return { ok: false, error: '缺少 tracks' };
  for (const lang of ['zh', 'en']) {
    const t = tr[lang];
    if (!t || !Array.isArray(t.format) || !Array.isArray(t.values)) {
      return { ok: false, error: `tracks.${lang} 缺少 format/values` };
    }
    if (t.format.length !== t.values.length) {
      return { ok: false, error: `tracks.${lang} 的 format 与 values 数量不一致` };
    }
    if (!t.format.some(f => String(f).toLowerCase() === 'fontname')) {
      return { ok: false, error: `tracks.${lang} 里没有 fontname 字段` };
    }
  }
  return { ok: true, preset: obj };
}

/** 目标样式名怎么定：先用传入的 targets，缺了就按语言线索在稿件里找。 */
function _pickStyleName(doc, wanted, lang, used) {
  const taken = (name) => !!(used && used.has(String(name).toLowerCase()));
  if (wanted && doc.styles.has(String(wanted).toLowerCase()) && !taken(wanted)) return String(wanted);
  const names = (doc && doc.styleNames) || [];
  const hints = _STYLE_HINTS[lang] || [];
  for (const re of hints) {
    const hit = names.find(n => re.test(n) && !taken(n));
    if (hit) return hit;
  }
  return '';
}

/**
 * 把预设里的两条轨写进稿件（只改样式行，不动任何事件文本）。
 * @returns {{ok:boolean,changed:number,applied:object,error?:string}}
 *          applied 记录"预设的哪个轨落到了稿件的哪个样式名"，供界面回显。
 */
export function applyAssStylePreset(doc, preset, targets) {
  if (!doc || !preset || !preset.tracks) return { ok: false, changed: 0, applied: {}, error: '预设为空' };
  const plan = [];
  // `used` 记已落轨的样式名：**两条轨绝不能落到同一个样式上**，否则后一条会静默
  // 覆盖前一条还报成功（只有一条样式的稿件就会这样）。单测 ⑤ 钉的正是它。
  const used = new Set();
  for (const lang of ['zh', 'en']) {
    const t = preset.tracks[lang];
    if (!t) continue;
    // 目标样式名：优先当前稿件的双语目标；没有再按预设里记的名字；再没有按语言线索
    let dest = _pickStyleName(doc, targets && targets[lang], lang, used);
    if (!dest) dest = _pickStyleName(doc, t.styleName, lang, used);
    if (!dest) {
      return {
        ok: false, changed: 0, applied: {},
        error: `稿件里找不到可用的${lang === 'zh' ? '中文' : '英文'}样式（两条轨不能落在同一个样式上）`,
      };
    }
    used.add(dest.toLowerCase());
    plan.push({ lang, dest, t });
  }
  if (plan.length < 2) return { ok: false, changed: 0, applied: {}, error: '预设里缺少中文或英文轨' };

  const applied = {};
  let changed = 0;
  for (const { lang, dest, t } of plan) {
    const rec = doc.styles.get(dest.toLowerCase());
    // **按字段名搬运**：预设的 format 决定"哪个值是什么"，目标样式自己的 format 决定写到哪一位。
    // 这样两边 Format 顺序/字段集不同也不会错位（V4 与 V4+ 的差别就在这里）。
    const fields = {};
    t.format.forEach((key, i) => {
      const k = String(key).toLowerCase();
      if (k === 'name') return;                 // 名字绝不覆盖：目标稿件的样式名要保持原样
      const v = t.values[i];
      if (v == null) return;
      if (rec.format.includes(k)) fields[k] = String(v).trim();
    });
    if (Object.keys(fields).length && doc.setStyleFields(dest, fields)) changed++;
    applied[lang] = dest;
  }
  return { ok: true, changed, applied };
}
