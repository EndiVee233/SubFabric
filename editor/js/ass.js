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
    if (!sentence || !sentence.events || !sentence.events.length) return this.serialize();
    const indices = new Set(sentence.events.map(ev => ev.lineIdx));
    const first = Math.min(...indices);
    const insert = specs.map(spec => this._buildDialogueLine(spec));
    const lines = [];
    this.lines.forEach((value, idx) => {
      if (idx === first) lines.push(...insert);
      if (value !== null && !indices.has(idx)) lines.push(value);
    });
    return lines.join('\r\n');
  }

  previewSentence(sentence, safeText) {
    if (!sentence || !sentence.events || !sentence.events.length) return this.serialize();
    const p = sentence.proto;
    return this.previewEvents(sentence, [{
      layer: p.layer, style: sentence.style, name: p.name,
      effect: p.effect, margins: p.margins,
      start: sentence.start, end: sentence.end, text: safeText
    }]);
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
