/*
 * 字幕文件读写：SRT / VTT / ASS / 双语 SRT / JSON。
 *
 * 移植自 SubFabric 的 editor/js/srt.js、editor/js/ass.js 与
 * Parakeet Studio 的 app/subtitles.py，并保留两者共有的行为约定：
 *   - 读入时按 UTF-8(BOM 容错) 解析，输出统一 LF 换行；
 *   - 导出的 cue 序号重新连续编号，空文本行跳过；
 *   - ASS 用 Has 颜色覆盖标签做逐词卡拉OK（`{\c&H..&}词{\c}`），
 *     而不是把整句染成一个颜色动画。
 */

import { Cue, WordTiming } from '../model/Cue';
import { formatAssTime, formatTimestamp, parseTimestamp } from '../util/TimeUtil';

/** SRT/VTT 时间行：允许逗号或点作为小数分隔符，也允许 1~3 位毫秒。 */
const TIME_LINE: RegExp =
  /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

/** 去掉 UTF-8 BOM。 */
export function stripBom(text: string): string {
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    return text.substring(1);
  }
  return text;
}

/** 统一换行符为 \n。 */
export function normalizeNewlines(text: string): string {
  return stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ------------------------------------------------------------------ 导出

/** 导出 SRT。`bilingual` 为 true 时原文行放在译文行下方。 */
export function writeSrt(cues: Cue[], bilingual: boolean = false,
                         preferSource: boolean = false): string {
  const out: string[] = [];
  let idx = 0;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const src = cue.sourceText.trim();
    const tgt = cue.targetText.trim();
    if (src.length === 0 && tgt.length === 0) {
      continue;
    }
    idx++;
    out.push(`${idx}`);
    out.push(`${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}`);
    if (bilingual) {
      if (tgt.length > 0) {
        out.push(tgt);
      }
      if (src.length > 0) {
        out.push(src);
      }
    } else {
      const body = preferSource ? (src.length > 0 ? src : tgt) : cue.bestText();
      out.push(body);
    }
    out.push('');
  }
  return out.join('\n');
}

/** 只导出原文（识别稿）。 */
export function writeSourceSrt(cues: Cue[]): string {
  return writeSrt(cues, false, true);
}

/** 导出 WebVTT（时间戳用点号，带 WEBVTT 头）。 */
export function writeVtt(cues: Cue[]): string {
  const out: string[] = ['WEBVTT', ''];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const body = cue.bestText();
    if (body.length === 0) {
      continue;
    }
    out.push(`${formatTimestamp(cue.start, false)} --> ${formatTimestamp(cue.end, false)}`);
    out.push(body);
    out.push('');
  }
  return out.join('\n');
}

/** 导出逐词 JSON（供其它工具消费，含词级时间戳）。 */
export function writeJson(cues: Cue[], meta: Map<string, string> = new Map()): string {
  const metaObj: Record<string, string> = {};
  meta.forEach((v: string, k: string): void => {
    metaObj[k] = v;
  });
  const cueList: CueJson[] = cues.map((c: Cue): CueJson => {
    const words: WordJson[] = c.words.map((w: WordTiming): WordJson => {
      const wj: WordJson = { text: w.text, start: round4(w.start), end: round4(w.end) };
      return wj;
    });
    const cj: CueJson = {
      index: c.index,
      start: round4(c.start),
      end: round4(c.end),
      source_text: c.sourceText,
      target_text: c.targetText,
      confidence: round4(c.confidence),
      words: words
    };
    return cj;
  });
  const payload: ProjectJson = { meta: metaObj, cues: cueList };
  return JSON.stringify(payload, null, 2);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

interface WordJson {
  text: string;
  start: number;
  end: number;
}

interface CueJson {
  index: number;
  start: number;
  end: number;
  source_text: string;
  target_text: string;
  confidence: number;
  words: WordJson[];
}

interface ProjectJson {
  meta: Record<string, string>;
  cues: CueJson[];
}

// ------------------------------------------------------------------ 读入

/** 解析 SRT / VTT 文本。两者共用一套按空行分块的解析。 */
export function readSubtitles(text: string): Cue[] {
  const body = normalizeNewlines(text);
  const cues: Cue[] = [];
  const blocks = body.split(/\n{2,}/);

  for (let b = 0; b < blocks.length; b++) {
    const rawLines = blocks[b].split('\n');
    const lines: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].trim().length > 0) {
        lines.push(rawLines[i]);
      }
    }
    if (lines.length === 0) {
      continue;
    }
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE') ||
        lines[0].startsWith('STYLE')) {
      if (lines.length === 1) {
        continue;
      }
    }

    let timeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('-->') >= 0) {
        timeIdx = i;
        break;
      }
    }
    if (timeIdx < 0) {
      continue;
    }
    const m = TIME_LINE.exec(lines[timeIdx]);
    if (m === null) {
      continue;
    }

    const parts: string[] = [];
    for (let i = timeIdx + 1; i < lines.length; i++) {
      parts.push(lines[i].trim());
    }
    const bodyText = parts.join(' ').trim();
    if (bodyText.length === 0) {
      continue;
    }

    const cue = new Cue(cues.length + 1, parseTimestamp(m[1]), parseTimestamp(m[2]), bodyText, '');
    cues.push(cue);
  }
  return cues;
}

/**
 * 读入时判定语言：包含 CJK 认为原文是中文，否则英文。
 * 用于「导入已有字幕只做翻译」时决定 source/target 放在哪一栏。
 */
export function looksChinese(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4E00 && c <= 0x9FFF) {
      return true;
    }
  }
  return false;
}

/** 导入 SRT/VTT 时把内容放进合适的栏位。 */
export function readAsCues(text: string, asTranslated: boolean = false): Cue[] {
  const cues = readSubtitles(text);
  if (!asTranslated) {
    return cues;
  }
  for (let i = 0; i < cues.length; i++) {
    cues[i].targetText = cues[i].sourceText;
    cues[i].sourceText = '';
  }
  return cues;
}

// ------------------------------------------------------------------ ASS 导出

/** ASS 转义：反斜杠、花括号需要转义，换行变成 \N。 */
export function assEscape(text: string): string {
  let out = text.replace(/\\/g, '\\\\');
  out = out.replace(/\{/g, '\\{');
  out = out.replace(/\}/g, '\\}');
  return out.replace(/\n/g, '\\N');
}

/** 智能引号/破折号换成 ASCII，避免部分播放器字体缺字。 */
export function assSafQuote(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u2026/g, '...');
}

/** ASS 样式表定义。 */
export class AssStyle {
  name: string = 'Main';
  font: string = 'HarmonyOS Sans SC';
  fontSize: number = 54;
  primaryColour: string = '&H00FFFFFF';
  outlineColour: string = '&H00101010';
  backColour: string = '&H80000000';
  /** 边框样式 1=描边+阴影。 */
  borderStyle: number = 1;
  outline: number = 3;
  shadow: number = 1;
  alignment: number = 2;
  marginL: number = 60;
  marginR: number = 60;
  marginV: number = 54;

  constructor(name: string, font: string, fontSize: number) {
    this.name = name;
    this.font = font;
    this.fontSize = fontSize;
  }
}

/** ASS 导出选项。 */
export class AssExportOptions {
  /** 主样式用的栏位：true 用译文，false 用原文。 */
  useTranslation: boolean = true;
  /** 是否同时输出第二行（Sub 样式，字号 62%）。 */
  secondLine: boolean = true;
  width: number = 1920;
  height: number = 1080;
  font: string = 'HarmonyOS Sans SC';
  fontSize: number = 54;
  /** 逐词卡拉OK：用 \c 颜色覆盖标签标注当前词。 */
  karaoke: boolean = false;
  /** 卡拉OK 高亮色（ASS BGR 顺序）。 */
  karaokeColour: string = '&H0062F6FF';
  /** 每个颜色覆盖最多覆盖多少个词；0 表示整行逐词。 */
  karaokeMaxWords: number = 14;
}

/**
 * 生成 ASS 文件。
 *
 * 逐词卡拉OK 的做法与 SubFabric 一致：把整句拆成多个 Dialogue 事件，
 * 每个事件只给**当前词**加 `{\c&Hxxxxxx&}` 覆盖、词尾用 `{\c}` 复位，
 * 其余词保持默认色。这样不依赖播放器的 `\k` 卡拉OK 标签实现，
 * 在 libass 之外的渲染器上也稳。
 */
export function writeAss(cues: Cue[], opts: AssExportOptions = new AssExportOptions()): string {
  const styles: AssStyle[] = [
    new AssStyle('Main', opts.font, opts.fontSize),
    new AssStyle('Sub', opts.font, Math.max(20, Math.round(opts.fontSize * 0.62)))
  ];
  styles[1].outline = 2;
  styles[1].marginV = 16;

  const header: string[] = [];
  header.push('[Script Info]');
  header.push('ScriptType: v4.00+');
  header.push(`PlayResX: ${opts.width}`);
  header.push(`PlayResY: ${opts.height}`);
  header.push('WrapStyle: 0');
  header.push('ScaledBorderAndShadow: yes');
  header.push('');
  header.push('[V4+ Styles]');
  header.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, '
    + 'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, '
    + 'Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, '
    + 'MarginV, Encoding');
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i];
    header.push(`Style: ${s.name},${s.font},${s.fontSize},${s.primaryColour},&H000000FF,`
      + `${s.outlineColour},${s.backColour},0,0,0,0,100,100,0,0,${s.borderStyle},`
      + `${s.outline},${s.shadow},${s.alignment},${s.marginL},${s.marginR},${s.marginV},134`);
  }
  header.push('');
  header.push('[Events]');
  header.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  const events: string[] = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const primary = opts.useTranslation
      ? (cue.targetText.trim().length > 0 ? cue.targetText.trim() : cue.sourceText.trim())
      : (cue.sourceText.trim().length > 0 ? cue.sourceText.trim() : cue.targetText.trim());
    if (primary.length === 0) {
      continue;
    }
    const start = formatAssTime(cue.start);
    const end = formatAssTime(Math.max(cue.end, cue.start + 0.2));

    if (opts.karaoke && cue.words.length > 0 && cue.words.length <= opts.karaokeMaxWords) {
      const timed = karaokeEvents(cue.words, cue.start, cue.end, opts.karaokeColour);
      for (let k = 0; k < timed.length; k++) {
        const ev = timed[k];
        events.push(`Dialogue: 0,${formatAssTime(ev.start)},${formatAssTime(ev.end)},`
          + `Main,,0,0,0,,${ev.text}`);
      }
    } else {
      events.push(`Dialogue: 0,${start},${end},Main,,0,0,0,,${assEscape(assSafQuote(primary))}`);
    }

    if (opts.secondLine) {
      const secondary = opts.useTranslation ? cue.sourceText.trim() : cue.targetText.trim();
      if (secondary.length > 0 && secondary !== primary) {
        events.push(`Dialogue: 0,${start},${end},Sub,,0,0,0,,${assEscape(assSafQuote(secondary))}`);
      }
    }
  }
  return header.join('\n') + '\n' + events.join('\n') + '\n';
}

/** 一条逐词卡拉OK事件。 */
class KaraokeEvent {
  start: number = 0;
  end: number = 0;
  text: string = '';
}

/**
 * 把一行词的逐词时间戳展开成多个 ASS 事件。
 *
 * 相邻词之间用「上下界取中点」切分，这样空心间隙也被覆盖，
 * 不会出现两帧都没有高亮词的闪烁。
 */
export function karaokeEvents(words: WordTiming[], cueStart: number, cueEnd: number,
                             colour: string): KaraokeEvent[] {
  const events: KaraokeEvent[] = [];
  if (words.length === 0) {
    return events;
  }
  const n = words.length;
  const bounds: number[] = [];
  bounds.push(Math.max(0, Math.min(cueStart, words[0].start)));
  for (let i = 0; i < n - 1; i++) {
    const mid = (words[i].end + words[i + 1].start) / 2;
    bounds.push(Math.max(words[i].start, Math.min(mid, words[i + 1].end)));
  }
  bounds.push(Math.max(words[n - 1].end, cueEnd));

  for (let i = 0; i < n; i++) {
    const start = bounds[i];
    const end = Math.max(bounds[i + 1], start + 0.04);
    const parts: string[] = [];
    for (let k = 0; k < n; k++) {
      const piece = assEscape(words[k].text);
      if (k === i) {
        parts.push(`{\\c${colour}}${piece}{\\c}`);
      } else {
        parts.push(piece);
      }
    }
    const ev = new KaraokeEvent();
    ev.start = start;
    ev.end = end;
    ev.text = parts.join(' ');
    events.push(ev);
  }
  return events;
}

/**
 * 生成逐词卡拉OK 的 ASS（整句高亮跟随）。
 * 与 writeAss({karaoke:true}) 等价，保留独立入口便于 UI 直接调用。
 */
export function writeKaraokeAss(cues: Cue[], opts: AssExportOptions = new AssExportOptions()): string {
  const o = opts;
  o.karaoke = true;
  return writeAss(cues, o);
}

// ------------------------------------------------------------------ 纯文本

/** 分词结果转纯文本（用于「复制原文」）。 */
export function cuesToPlainText(cues: Cue[], useTranslation: boolean = false): string {
  const out: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const t = useTranslation ? cues[i].targetText : cues[i].sourceText;
    if (t.trim().length > 0) {
      out.push(t.trim());
    }
  }
  return out.join('\n');
}
