/*
 * 新建稿件：从已有字幕 / SubFabric 项目包取材。
 *
 * 支持：
 *   · .srt / .vtt   —— 与「导入字幕」共用 common 的 readAsCues；
 *   · .ass          —— 只取 Dialogue 文本，保留时间；Main/Sub 双样式时
 *                      把 Sub 当原文、Main 当译文（与桌面端 writeAss 约定一致）；
 *   · .json         —— 兼容 { meta, cues:[...] } 与纯 cue 数组；
 *   · .zip 项目包   —— 读取 subtitle.srt / subtitle.ass，附带 translation.json
 *                      的译文行与 project.json 的项目名；视频仍需另外选择。
 *
 * 所有解析都在本地完成，不上传文件。解析失败抛 Error，由页面提示。
 */

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { Cue, parseTimestamp, readAsCues, WordTiming } from 'common';

import { fileSize, readTextFile, deleteTree } from './FileUtil';
import { Logger } from '../engine/Logger';

const TAG = 'SubtitleImport';
const MAX_SUBTITLE_BYTES: number = 16 * 1024 * 1024;
/** 项目包只应包含字幕/译文/项目 JSON；限制压缩包与解压后体积，避免手机 OOM。 */
const MAX_PACK_BYTES: number = 32 * 1024 * 1024;
const MAX_PACK_EXPANDED_BYTES: number = 64 * 1024 * 1024;
/** ASS 中英文事件配对的时间窗口；超过这个范围的不再强行配对。 */
const ASS_MATCH_WINDOW_SEC: number = 3.0;

/** 一次字幕导入的结果：原始文本保留下来，勾选「删除换行符」时可重新解析。 */
export class ImportedSubtitle {
  cues: Cue[] = [];
  /** 字幕原文（SRT / VTT / ASS / JSON）。 */
  text: string = '';
  /** 'srt' | 'vtt' | 'ass' | 'json' */
  format: string = 'srt';
  /** 项目包 translation.json 的 lines；没有则为空。 */
  translationLines: string[] = [];
  /** 项目包 project.json 里的 name。 */
  projectName: string = '';
  /** 用于「名称留空」时的回退名（不含扩展名）。 */
  fileBase: string = '';
  /** 用户看到的文件名 / 包名。 */
  label: string = '';
  /** 解析过程中的非致命提示。 */
  warning: string = '';

  count(): number {
    return this.cues.length;
  }
}

/** 从字幕文件读取。支持 picker URI。 */
export function readSubtitleSource(uri: string, label: string,
                                   removeLineBreaks: boolean): ImportedSubtitle {
  const size = fileSize(uri);
  if (size > MAX_SUBTITLE_BYTES) {
    throw new Error('字幕文件超过 16 MB');
  }
  const info = new ImportedSubtitle();
  info.text = readTextFile(uri);
  info.label = label;
  info.fileBase = baseName(label);
  info.format = detectFormat(info.text, label);
  info.cues = parseSubtitleText(info.text, info.format, removeLineBreaks);
  return info;
}

/** 从 SubFabric 项目包读取字幕与译文。 */
export async function readProjectPackage(context: common.UIAbilityContext, uri: string,
                                         label: string,
                                         removeLineBreaks: boolean): Promise<ImportedSubtitle> {
  const size = fileSize(uri);
  if (size > MAX_PACK_BYTES) {
    throw new Error(`项目包超过 ${Math.round(MAX_PACK_BYTES / 1048576)} MB`);
  }
  const tmp = `${context.cacheDir}/subtitle_pack_${Date.now()}`;
  const started = Date.now();
  try {
    fs.mkdirSync(tmp, true);
    const zipPath = `${tmp}/package.zip`;
    await copyUriAsync(uri, zipPath);
    // 先看解压后的总大小：只含字幕的项目包通常几 MB，超过上限就不解压，
    // 避免手机在 zlib 解压阶段被大文件/高压缩比包拖死或 OOM。
    const expanded = await zlib.getOriginalSize(zipPath);
    if (expanded > MAX_PACK_EXPANDED_BYTES) {
      throw new Error(`项目包解压后超过 ${Math.round(MAX_PACK_EXPANDED_BYTES / 1048576)} MB，`
        + '请确认只打包字幕、译文和 project.json');
    }
    await zlib.decompressFile(zipPath, tmp, {
      parallel: zlib.ParallelStrategy.PARALLEL_STRATEGY_PARALLEL_DECOMPRESSION
    });

    const srtPath = findFile(tmp, 'subtitle.srt', 0);
    const assPath = findFile(tmp, 'subtitle.ass', 0);
    if (srtPath.length === 0 && assPath.length === 0) {
      throw new Error('项目包里没有 subtitle.srt / subtitle.ass');
    }
    const info = new ImportedSubtitle();
    info.label = label;
    info.fileBase = baseName(label);
    if (srtPath.length > 0) {
      info.format = 'srt';
      info.text = readTextFile(srtPath);
    } else {
      info.format = 'ass';
      info.text = readTextFile(assPath);
    }
    info.cues = parseSubtitleText(info.text, info.format, removeLineBreaks);

    const transPath = findFile(tmp, 'translation.json', 0);
    if (transPath.length > 0) {
      info.translationLines = readTranslationLines(transPath);
      if (info.translationLines.length > 0) {
        if (info.translationLines.length === info.cues.length) {
          applyTranslationLines(info.cues, info.translationLines);
        } else {
          info.warning = 'translation.json 行数与字幕不一致，未写入译文';
        }
      }
    }
    const projectPath = findFile(tmp, 'project.json', 0);
    if (projectPath.length > 0) {
      info.projectName = readProjectName(projectPath);
    }
    Logger.info(TAG, `项目包读取完成：${info.cues.length} 条，`
      + `${Date.now() - started} ms（解压后 ${(expanded / 1048576).toFixed(1)} MB）`);
    return info;
  } catch (err) {
    const e = err as Error;
    throw new Error(e.message.length > 0 ? e.message : '项目包读取失败');
  } finally {
    try {
      deleteTree(tmp);
    } catch (err) {
      Logger.warn(TAG, `清理项目包临时目录失败：${tmp}`);
    }
  }
}

/** 按当前「删除换行符」选项重新解析，返回新的 cue 数组。 */
export function rebuildCues(info: ImportedSubtitle, removeLineBreaks: boolean): Cue[] {
  const cues = parseSubtitleText(info.text, info.format, removeLineBreaks);
  if (info.translationLines.length > 0 && info.translationLines.length === cues.length) {
    applyTranslationLines(cues, info.translationLines);
  }
  return cues;
}

/** 解析字幕文本；导出成 SRT/ASS/JSON 时都以 cue 为单位。 */
export function parseSubtitleText(text: string, format: string,
                                  removeLineBreaks: boolean): Cue[] {
  let cues: Cue[] = [];
  if (format === 'json') {
    cues = parseJsonCues(text);
  } else if (format === 'ass') {
    cues = parseAssCues(text, removeLineBreaks);
  } else {
    cues = readAsCues(text);
  }
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    c.index = i + 1;
    if (c.end <= c.start) {
      c.end = c.start + 1;
    }
  }
  return cues;
}

function detectFormat(text: string, label: string): string {
  const name = label.toLowerCase();
  if (name.endsWith('.json')) {
    return 'json';
  }
  if (name.endsWith('.ass')) {
    return 'ass';
  }
  const head = text.trim();
  if (head.startsWith('{') || head.startsWith('[')) {
    return 'json';
  }
  if (head.indexOf('[Events]') >= 0 && /Dialogue\s*:/i.test(head)) {
    return 'ass';
  }
  return 'srt';
}

// ------------------------------------------------------------------ JSON

function parseJsonCues(text: string): Cue[] {
  let parsed: Object;
  try {
    parsed = JSON.parse(text) as Object;
  } catch (err) {
    throw new Error('JSON 字幕无法解析');
  }
  let list: Object[] = [];
  if (Array.isArray(parsed)) {
    list = parsed as Object[];
  } else {
    const rec = parsed as Record<string, Object>;
    const cues = rec['cues'];
    if (Array.isArray(cues)) {
      list = cues as Object[];
    }
  }
  const out: Cue[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, Object>;
    const start = numberField(rec, ['start', 'start_time', 'startTime'], 0);
    const end = numberField(rec, ['end', 'end_time', 'endTime'], start + 1);
    const source = stringField(rec, ['source_text', 'sourceText', 'text', 'content'], '');
    const target = stringField(rec, ['target_text', 'targetText', 'translation'], '');
    if (source.trim().length === 0 && target.trim().length === 0) {
      continue;
    }
    const cue = new Cue(out.length + 1, start, end, source.trim(), target.trim());
    const confidence = numberField(rec, ['confidence'], -1);
    if (confidence >= 0) {
      cue.confidence = confidence;
    }
    out.push(cue);
  }
  return out;
}

// ------------------------------------------------------------------ ASS

class AssEvent {
  start: number = 0;
  end: number = 0;
  style: string = '';
  clean: string = '';
  highlight: string = '';
  cjk: boolean = false;
  color: string = '';
  wordColor: string = '';
}

class AssHighlight {
  text: string = '';
  color: string = '';
}

class AssWordCand {
  text: string = '';
  start: number = 0;
  end: number = 0;
  lineText: string = '';
}

class AssLineGroup {
  start: number = 0;
  end: number = 0;
  chinese: string = '';
  english: string = '';
  color: string = '';
  sourceColor: string = '';
  wordColor: string = '';
  wordCands: AssWordCand[] = [];
}

function hasCjk(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4E00 && c <= 0x9FFF) {
      return true;
    }
  }
  return false;
}

/**
 * 从 ASS 覆盖标签里取逐词高亮词。
 * 这个字幕文件的英文行形如：
 *   {\c&H00FF00&\3c&HFF00FF&...\blur7.5}word{\c\3c...} rest of line
 * 中文行用 {\c&HFF00FF&} 做整行染色，不是逐词高亮，必须排除。
 */
function extractAssHighlight(raw: string): AssHighlight {
  const out = new AssHighlight();
  const re = /\{\\c&H([0-9A-Fa-f]{6,8})&[^}]*\}([^{}]*)\{\\c[^}]*\}/g;
  let match = re.exec(raw);
  while (match !== null) {
    const color = match[1].toUpperCase();
    const text = match[2].trim();
    if (text.length > 0) {
      out.text = text;
      out.color = assColorToHex(color);
      return out;
    }
    match = re.exec(raw);
  }
  return out;
}

/** ASS &HAABBGGRR / &HBBGGRR → #RRGGBB。 */
function assColorToHex(raw: string): string {
  const s = raw.replace(/^&H/i, '').replace(/&$/, '').padStart(8, '0');
  const bgr = s.substring(s.length - 6);
  return `#${bgr.substring(4, 6)}${bgr.substring(2, 4)}${bgr.substring(0, 2)}`.toUpperCase();
}

/** 取第一条内联 \c 颜色；没有则用样式色。 */
function inlineAssColor(raw: string, fallback: string): string {
  const m = /\{\\c&H([0-9A-Fa-f]{6,8})&/.exec(raw);
  return m !== null ? assColorToHex(m[1]) : fallback;
}

/** 二分找到第一个 start >= time 的锚点；再回退一格以容纳长行。 */
function lowerBoundAnchor(anchors: AssLineGroup[], time: number): number {
  let lo: number = 0;
  let hi: number = anchors.length;
  while (lo < hi) {
    const mid: number = (lo + hi) >> 1;
    if (anchors[mid].start < time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo > 0 ? lo - 1 : 0;
}

function parseAssCues(text: string, removeLineBreaks: boolean): Cue[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let inEvents = false;
  let inStyles = false;
  let styleFormat: string[] = [];
  const styleColors = new Map<string, string>();
  let fields: string[] = ['Layer', 'Start', 'End', 'Style', 'Name',
    'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  let startIdx: number = 1;
  let endIdx: number = 2;
  let styleIdx: number = 3;
  let textIdx: number = 9;
  const events: AssEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('[')) {
      const section = line.toLowerCase();
      inEvents = section === '[events]';
      inStyles = section === '[v4+ styles]' || section === '[v4 styles]';
      continue;
    }
    if (inStyles) {
      if (line.startsWith('Format:') || line.startsWith('format:')) {
        const colon = line.indexOf(':');
        styleFormat = line.substring(colon + 1).split(',').map((s: string): string => s.trim());
      } else if (line.startsWith('Style:') || line.startsWith('style:')) {
        if (styleFormat.length > 0) {
          const colon = line.indexOf(':');
          const parts = splitLimited(line.substring(colon + 1).trim(), styleFormat.length);
          const nameIdx = fieldIndex(styleFormat, 'name');
          const colorIdx = fieldIndex(styleFormat, 'primarycolour');
          if (nameIdx >= 0 && colorIdx >= 0 && nameIdx < parts.length && colorIdx < parts.length) {
            const name = parts[nameIdx].trim().toLowerCase();
            const color = parts[colorIdx].trim();
            if (name.length > 0 && color.length > 0) {
              styleColors.set(name, assColorToHex(color));
            }
          }
        }
      }
      continue;
    }
    if (!inEvents) {
      continue;
    }
    if (line.startsWith('Format:') || line.startsWith('format:')) {
      const colon = line.indexOf(':');
      const raw = line.substring(colon + 1).split(',');
      const next: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        next.push(raw[k].trim());
      }
      if (next.length >= 3) {
        fields = next;
        startIdx = fieldIndex(fields, 'start');
        endIdx = fieldIndex(fields, 'end');
        styleIdx = fieldIndex(fields, 'style');
        textIdx = fieldIndex(fields, 'text');
      }
      continue;
    }
    if (!line.startsWith('Dialogue:') && !line.startsWith('dialogue:')) {
      continue;
    }
    const colon = line.indexOf(':');
    const parts = splitLimited(line.substring(colon + 1).trim(), fields.length);
    if (startIdx < 0 || endIdx < 0 || textIdx < 0 || textIdx >= parts.length) {
      continue;
    }
    const start = parseTimestamp(parts[startIdx]);
    const end = parseTimestamp(parts[endIdx]);
    const style = styleIdx >= 0 && styleIdx < parts.length ? parts[styleIdx].trim().toLowerCase() : '';
    const clean = cleanAssText(parts[textIdx], removeLineBreaks);
    if (clean.length === 0) {
      continue;
    }
    const event = new AssEvent();
    event.start = start;
    event.end = end;
    event.style = style;
    event.clean = clean;
    event.cjk = hasCjk(clean);
    const styleColor = styleColors.get(style) ?? '#FFFFFF';
    if (event.cjk) {
      event.color = inlineAssColor(parts[textIdx], styleColor);
      event.highlight = '';
    } else {
      const highlight = extractAssHighlight(parts[textIdx]);
      event.color = styleColor;
      event.highlight = highlight.text;
      event.wordColor = highlight.color;
    }
    events.push(event);
  }

  events.sort((a: AssEvent, b: AssEvent): number => a.start - b.start || a.end - b.end);

  const out: Cue[] = [];
  const anchors: AssLineGroup[] = [];
  for (let i = 0; i < events.length; i++) {
    if (!events[i].cjk) {
      continue;
    }
    const group = new AssLineGroup();
    group.start = events[i].start;
    group.end = events[i].end;
    group.chinese = events[i].clean;
    group.color = events[i].color;
    anchors.push(group);
  }

  if (anchors.length > 0) {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.cjk) {
        continue;
      }
      let best: AssLineGroup | null = null;
      let bestScore: number = -1000000;
      // 原来对每个英文事件都扫描全部中文锚点，57k 行时是 O(n²)，手机会卡死/闪退。
      // 字幕配对只可能发生在相邻几秒内，按时间窗口取候选即可。
      const from = lowerBoundAnchor(anchors, event.start - ASS_MATCH_WINDOW_SEC);
      const limit = event.start + ASS_MATCH_WINDOW_SEC;
      for (let k = from; k < anchors.length; k++) {
        const anchor = anchors[k];
        if (anchor.start > limit) {
          break;
        }
        const overlap = Math.min(event.end, anchor.end) - Math.max(event.start, anchor.start);
        const startDist = Math.abs(event.start - anchor.start);
        const score = overlap * 1000 - startDist;
        if (score > bestScore) {
          bestScore = score;
          best = anchor;
        }
      }
      if (best === null) {
        continue;
      }
      best.start = Math.min(best.start, event.start);
      best.end = Math.max(best.end, event.end);
      if (event.clean.length > best.english.length) {
        best.english = event.clean;
      }
      if (best.sourceColor.length === 0 && event.color.length > 0) {
        best.sourceColor = event.color;
      }
      if (event.wordColor.length > 0) {
        best.wordColor = event.wordColor;
      }
      if (event.highlight.length > 0) {
        const cand = new AssWordCand();
        cand.text = event.highlight;
        cand.start = event.start;
        cand.end = event.end;
        cand.lineText = event.clean;
        best.wordCands.push(cand);
      }
    }
    for (let i = 0; i < anchors.length; i++) {
      appendAssCue(out, anchors[i], true);
    }
  } else {
    let group: AssLineGroup | null = null;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.cjk) {
        continue;
      }
      if (group === null || event.start > group.end + 0.12) {
        group = new AssLineGroup();
        group.start = event.start;
        group.end = event.end;
        group.english = event.clean;
        group.sourceColor = event.color;
        group.wordColor = event.wordColor;
        anchors.push(group);
      } else {
        group.start = Math.min(group.start, event.start);
        group.end = Math.max(group.end, event.end);
        if (event.clean.length > group.english.length) {
          group.english = event.clean;
        }
        if (group.sourceColor.length === 0 && event.color.length > 0) {
          group.sourceColor = event.color;
        }
        if (event.wordColor.length > 0) {
          group.wordColor = event.wordColor;
        }
      }
      if (event.highlight.length > 0) {
        const cand = new AssWordCand();
        cand.text = event.highlight;
        cand.start = event.start;
        cand.end = event.end;
        cand.lineText = event.clean;
        group.wordCands.push(cand);
      }
    }
    for (let i = 0; i < anchors.length; i++) {
      appendAssCue(out, anchors[i], false);
    }
  }
  return out;
}

/** 把一组中文锚点 + 英文事件落成一条 cue；逐词时间只取文件里真实的高亮事件。 */
function appendAssCue(out: Cue[], group: AssLineGroup, bilingual: boolean): void {
  const targetText = group.english.trim();
  const words: WordTiming[] = [];
  if (targetText.length > 0) {
    const seen = new Set<string>();
    for (let i = 0; i < group.wordCands.length; i++) {
      const cand = group.wordCands[i];
      if (cand.lineText.trim() !== targetText) {
        continue;
      }
      const key = `${cand.start.toFixed(3)}|${cand.end.toFixed(3)}|${cand.text}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      words.push(new WordTiming(cand.text, cand.start, cand.end));
    }
  }
  const source = targetText.length > 0 ? targetText : group.chinese;
  const target = bilingual && targetText.length > 0 ? group.chinese : '';
  if (source.length === 0 && target.length === 0) {
    return;
  }
  const cue = new Cue(out.length + 1, group.start, group.end, source, target);
  cue.words = words;
  cue.targetColor = group.color;
  cue.sourceColor = group.sourceColor;
  cue.wordColor = group.wordColor;
  out.push(cue);
}
function cleanAssText(raw: string, removeLineBreaks: boolean): string {
  let out = raw;
  if (out.indexOf('{') >= 0) {
    out = out.replace(/\{[^}]*\}/g, '');
  }
  if (out.indexOf('\\N') >= 0) {
    out = out.replace(/\\N/g, removeLineBreaks ? ' ' : '\n');
  }
  if (out.indexOf('\\n') >= 0) {
    out = out.replace(/\\n/g, removeLineBreaks ? ' ' : '\n');
  }
  if (out.indexOf('\\h') >= 0) {
    out = out.replace(/\\h/g, ' ');
  }
  return out.trim();
}

function fieldIndex(fields: string[], name: string): number {
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].toLowerCase() === name) {
      return i;
    }
  }
  return -1;
}

/** 按逗号切分，只切前 n-1 个，最后一个字段（Text）可以包含逗号。 */
function splitLimited(text: string, count: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < count - 1; i++) {
    const comma = text.indexOf(',', start);
    if (comma < 0) {
      out.push(text.substring(start));
      return out;
    }
    out.push(text.substring(start, comma));
    start = comma + 1;
  }
  out.push(text.substring(start));
  return out;
}

// ------------------------------------------------------------------ 项目包

function readTranslationLines(path: string): string[] {
  const out: string[] = [];
  try {
    const parsed = JSON.parse(readTextFile(path)) as Record<string, Object>;
    const lines = parsed['lines'];
    if (Array.isArray(lines)) {
      const arr = lines as Object[];
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string') {
          out.push((arr[i] as string).trim());
        } else {
          out.push('');
        }
      }
    }
  } catch (err) {
    Logger.warn(TAG, 'translation.json 无法解析');
  }
  return out;
}

function readProjectName(path: string): string {
  try {
    const parsed = JSON.parse(readTextFile(path)) as Record<string, Object>;
    const name = parsed['name'];
    return typeof name === 'string' ? name.trim() : '';
  } catch (err) {
    return '';
  }
}

function applyTranslationLines(cues: Cue[], lines: string[]): void {
  for (let i = 0; i < cues.length && i < lines.length; i++) {
    if (lines[i].length > 0) {
      cues[i].targetText = lines[i];
    }
  }
}

// ------------------------------------------------------------------ 文件

async function copyUriAsync(uri: string, dest: string): Promise<void> {
  let src: fs.File | null = null;
  try {
    src = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    // 异步复制，避免 32 MB 级项目包在 UI 线程同步拷贝造成明显卡顿。
    await fs.copyFile(src.fd, dest);
  } catch (err) {
    const e = err as Error;
    throw new Error(`无法读取文件：${e.message}`);
  } finally {
    if (src !== null) {
      try {
        fs.closeSync(src);
      } catch (err) {
        Logger.warn(TAG, '关闭源文件失败（忽略）');
      }
    }
  }
}

/** 在解压目录里按文件名查找（项目包可能带一层外层目录）。 */
function findFile(dir: string, name: string, depth: number): string {
  if (depth > 3) {
    return '';
  }
  let names: string[] = [];
  try {
    names = fs.listFileSync(dir);
  } catch (err) {
    return '';
  }
  for (let i = 0; i < names.length; i++) {
    const entry = names[i];
    const p = `${dir}/${entry}`;
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch (err) {
      isDir = false;
    }
    if (isDir) {
      const found = findFile(p, name, depth + 1);
      if (found.length > 0) {
        return found;
      }
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return '';
}

function baseName(name: string): string {
  const slash = name.lastIndexOf('/');
  const file = slash >= 0 ? name.substring(slash + 1) : name;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.substring(0, dot) : file;
  return base.trim();
}

// ------------------------------------------------------------------ 字段

function stringField(rec: Record<string, Object>, keys: string[], fallback: string): string {
  for (let i = 0; i < keys.length; i++) {
    const v = rec[keys[i]];
    if (typeof v === 'string' && (v as string).trim().length > 0) {
      return v as string;
    }
  }
  return fallback;
}

function numberField(rec: Record<string, Object>, keys: string[], fallback: number): number {
  for (let i = 0; i < keys.length; i++) {
    const v = rec[keys[i]];
    if (typeof v === 'number' && Number.isFinite(v as number)) {
      return v as number;
    }
    if (typeof v === 'string' && (v as string).trim().length > 0) {
      return parseTimestamp(v as string);
    }
  }
  return fallback;
}
