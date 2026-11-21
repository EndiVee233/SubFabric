import { Cue, WordTiming, assEscape, formatAssTime, karaokeEvents } from 'common';

export class EditorField {
  key: string;
  label: string;
  type: string;
  initial: string;
  choices: string[];
  min: number;
  max: number;
  step: number;
  constructor(key: string, label: string, type: string, initial: string,
              choices: string[] = [], min: number = 0, max: number = 200, step: number = 1) {
    this.key = key; this.label = label; this.type = type; this.initial = initial;
    this.choices = choices; this.min = min; this.max = max; this.step = step;
  }
}

export const STYLE_FORMAT: string[] = ['Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour',
  'OutlineColour', 'BackColour', 'Bold', 'Italic', 'Underline', 'StrikeOut', 'ScaleX', 'ScaleY',
  'Spacing', 'Angle', 'BorderStyle', 'Outline', 'Shadow', 'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding'];
const STYLE_DEFAULT: string[] = ['Main', 'HarmonyOS Sans SC', '54', '&H00FFFFFF', '&H0000FFFF',
  '&H00101010', '&H80000000', '0', '0', '0', '0', '100', '100', '0', '0', '1', '3', '1', '2', '60', '60', '54', '1'];

export function trackFields(lang: string): EditorField[] {
  return [
    new EditorField(`${lang}.Fontname`, '字体名称', 'text', 'HarmonyOS Sans SC'),
    new EditorField(`${lang}.Fontsize`, '字号', 'range', lang === 'zh' ? '54' : '34', [], 1, 200),
    new EditorField(`${lang}.Bold`, '粗体', 'toggle', '0'),
    new EditorField(`${lang}.Italic`, '斜体', 'toggle', '0'),
    new EditorField(`${lang}.PrimaryColour`, '默认颜色', 'color', '#FFFFFF'),
    new EditorField(`${lang}.SecondaryColour`, '备用颜色', 'color', lang === 'zh' ? '#FFFFFF' : '#FFFF00')
  ];
}

export function bilingualFields(): EditorField[] {
  return [new EditorField('wordColor', '逐词高亮色', 'color', '#00FF00'),
    new EditorField('order', '中英上下顺序', 'select', 'zh-top', ['zh-top', 'en-top']),
    new EditorField('kBase', '未唱默认色', 'color', '#FFFFFF'),
    new EditorField('kSweep', '逐词扫过（\\kf）', 'toggle', '0'),
    new EditorField('karaokeMode', '逐词形态', 'select', 'slice', ['slice', 'karaoke'])];
}
export function effectFields(): EditorField[] {
  return [new EditorField('fx.enabled', '启用特效', 'toggle', '0'),
    new EditorField('fx.glow.enabled', '微光（Glow）', 'toggle', '1'),
    new EditorField('fx.glow.target', '微光生效范围', 'select', 'active_word', ['active_word', 'zh', 'en', 'all']),
    new EditorField('fx.glow.followRole', '微光跟随角色颜色', 'toggle', '0'),
    new EditorField('fx.fadein.enabled', '柔和淡入（Fade In）', 'toggle', '0'),
    new EditorField('fx.fadein.target', '淡入生效范围', 'select', 'zh', ['zh', 'en', 'all']),
    new EditorField('fx.fadein.from', '起始不透明度（%）', 'range', '55', [], 0, 99),
    new EditorField('fx.fadein.duration', '淡入时长（ms）', 'range', '300', [], 40, 1200, 10),
    new EditorField('fx.fadein.ratio', '时长占比上限（%）', 'range', '70', [], 10, 100, 5)];
}
export function glowFields(lang: string): EditorField[] {
  const p = `fx.glow.${lang}`;
  return [new EditorField(`${p}.enabled`, '启用', 'toggle', '1'),
    new EditorField(`${p}.channel`, '发光通道', 'select', 'shadow', ['shadow', 'outline', 'both']),
    new EditorField(`${p}.color`, '微光颜色', 'color', '#00FF88'),
    new EditorField(`${p}.radius`, '光晕半径', 'range', '4', [], 0.5, 20, 0.5),
    new EditorField(`${p}.intensity`, '发光强度（%）', 'range', '100', [], 0, 100, 5)];
}

export function defaultEditorOptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const lang of ['zh', 'en']) {
    for (let i = 0; i < STYLE_FORMAT.length; i++) { out[`${lang}.${STYLE_FORMAT[i]}`] = STYLE_DEFAULT[i]; }
    for (const field of trackFields(lang).concat(glowFields(lang))) { out[field.key] = field.initial; }
  }
  out['en.Name'] = 'Sub'; out['en.MarginV'] = '16';
  for (const field of bilingualFields().concat(effectFields())) { out[field.key] = field.initial; }
  out['fontScale'] = '1'; out['audioMode'] = 'raw'; out['removeLineBreaks'] = '1';
  out['zh.FontFile'] = ''; out['en.FontFile'] = ''; out['generatedAudioMode'] = '';
  out['zh.MarginV'] = '80';
  return out;
}
export function normalizeEditorOptions(raw: Record<string, string>): Record<string, string> {
  const out = defaultEditorOptions();
  for (const key of Object.keys(out)) { if (typeof raw[key] === 'string') { out[key] = raw[key]; } }
  const fields = trackFields('zh').concat(trackFields('en'), bilingualFields(), effectFields(), glowFields('zh'), glowFields('en'));
  for (const f of fields) {
    if (f.type === 'range') {
      const n = Number(out[f.key]);
      out[f.key] = String(Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : Number(f.initial));
    } else if (f.type === 'color') {
      out[f.key] = /^#[0-9a-f]{6}$/i.test(out[f.key]) ? out[f.key].toUpperCase() : f.initial;
    } else if (f.type === 'select' && !f.choices.includes(out[f.key])) { out[f.key] = f.initial; }
    else if (f.type === 'toggle') { out[f.key] = out[f.key] === '0' ? '0' : '1'; }
  }
  out['fontScale'] = String(Math.max(0.6, Math.min(1.8, Number(out['fontScale']) || 1)));
  return out;
}
export function colorBgr(hex: string): string {
  const c = /^#[0-9a-f]{6}$/i.test(hex) ? hex.substring(1) : 'FFFFFF';
  return `${c.substring(4, 6)}${c.substring(2, 4)}${c.substring(0, 2)}`.toUpperCase();
}
export function colorRgb(ass: string): string {
  const c = ass.replace(/^&H/i, '').replace(/&$/, '').padStart(6, '0').slice(-6);
  return `#${c.substring(4, 6)}${c.substring(2, 4)}${c.substring(0, 2)}`.toUpperCase();
}
function selected(o: Record<string, string>, key: string): boolean { return o[key] === '1'; }
export function effectApplies(o: Record<string, string>, effect: string, lang: string, active: boolean = false): boolean {
  const target = o[`fx.${effect}.target`];
  return selected(o, 'fx.enabled') && selected(o, `fx.${effect}.enabled`) &&
    (target === lang || target === 'all' || (effect === 'glow' && target === 'active_word' && lang === 'en' && active));
}
function glowCommands(o: Record<string, string>, lang: string, role: string): string {
  const p = `fx.glow.${lang}`;
  if (!selected(o, `${p}.enabled`)) { return ''; }
  const color = selected(o, 'fx.glow.followRole') && /^#[0-9a-f]{6}$/i.test(role) ? role : o[`${p}.color`];
  const bgr = colorBgr(color);
  const alpha = Math.round(255 * (1 - Number(o[`${p}.intensity`]) / 100)).toString(16).padStart(2, '0');
  const channel = o[`${p}.channel`];
  let tags = '';
  if (channel !== 'shadow') { tags += `\\3c&H${bgr}&\\3a&H${alpha}&`; }
  if (channel !== 'outline') { tags += `\\4c&H${bgr}&\\4a&H${alpha}&\\xshad0.1\\yshad0.1`; }
  return `${tags}\\blur${o[`${p}.radius`]}`;
}
function decorate(text: string, o: Record<string, string>, lang: string, cue: Cue, duration: number): string {
  let tags = '';
  if (/^#[0-9a-f]{6}$/i.test(cue.speakerColor)) { tags += `\\c&H${colorBgr(cue.speakerColor)}&`; }
  if (effectApplies(o, 'glow', lang)) { tags += glowCommands(o, lang, cue.speakerColor); }
  if (effectApplies(o, 'fadein', lang)) {
    const alpha = Math.round(255 * (1 - Number(o['fx.fadein.from']) / 100));
    const ms = Math.max(1, Math.min(Number(o['fx.fadein.duration']), duration * 1000 * Number(o['fx.fadein.ratio']) / 100));
    tags += `\\fade(${alpha},0,0,0,${Math.round(ms)},${Math.round(duration * 1000)},${Math.round(duration * 1000)})`;
  }
  if (lang === 'en' && effectApplies(o, 'glow', lang, true) && o['fx.glow.target'] === 'active_word') {
    text = text.replace(/(\{\\c&H[0-9a-f]+&\})([^{}]+)(\{\\c\})/gi,
      `$1{${glowCommands(o, lang, cue.speakerColor)}}$2{\\3c\\3a\\4c\\4a\\blur}$3`);
  }
  return (tags.length > 0 ? `{${tags}}` : '') + text;
}
function styleValues(o: Record<string, string>, lang: string): string[] {
  return STYLE_FORMAT.map((field: string): string => {
    let value = o[`${lang}.${field}`] ?? '';
    if (field === 'Name') { return lang === 'zh' ? 'Main' : 'Sub'; }
    if (field === 'Bold' || field === 'Italic') { return value === '0' ? '0' : '-1'; }
    if (field === 'PrimaryColour' || field === 'SecondaryColour') { value = `&H00${colorBgr(value)}`; }
    return value.replace(/[,\r\n{}]/g, '');
  });
}
export function buildEditorAss(cues: Cue[], raw: Record<string, string>, kind: string = 'full'): string {
  const o = normalizeEditorOptions(raw);
  const header = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 0',
    'ScaledBorderAndShadow: yes', '', '[V4+ Styles]', `Format: ${STYLE_FORMAT.join(', ')}`,
    `Style: ${styleValues(o, 'zh').join(',')}`, `Style: ${styleValues(o, 'en').join(',')}`, '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const events: string[] = [];
  for (const cue of cues) {
    const zh = cue.targetText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const en = cue.sourceText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const enEvents: string[] = [];
    const zhEvents: string[] = [];
    const emit = (list: string[], lang: string, start: number, end: number, text: string): void => {
      const actor = cue.speaker.replace(/[,\r\n]/g, '');
      list.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${lang === 'zh' ? 'Main' : 'Sub'},${actor},0,0,0,,${decorate(text, o, lang, cue, end - start)}`);
    };
    if (zh && kind !== 'en') { emit(zhEvents, 'zh', cue.start, cue.end, assEscape(zh)); }
    if (en && kind !== 'zh') {
      if (kind !== 'clean' && cue.words.length > 0 && o['karaokeMode'] === 'karaoke') {
        let text = `{\\c&H${colorBgr(o['wordColor'])}&\\2c&H${colorBgr(o['kBase'])}&}`;
        let cursor = cue.start;
        for (const word of cue.words) {
          if (word.start > cursor) { text += `{\\k${Math.round((word.start - cursor) * 100)}}`; }
          text += `{\\${selected(o, 'kSweep') ? 'kf' : 'k'}${Math.max(1, Math.round((word.end - word.start) * 100))}}${assEscape(word.text)} `;
          cursor = word.end;
        }
        emit(enEvents, 'en', cue.start, cue.end, text);
      } else if (kind !== 'clean' && cue.words.length > 0) {
        const timed = karaokeEvents(cue.words, cue.start, cue.end, `&H${colorBgr(o['wordColor'])}&`);
        for (const ev of timed) { emit(enEvents, 'en', ev.start, ev.end, ev.text); }
      } else { emit(enEvents, 'en', cue.start, cue.end, assEscape(en)); }
    }
    // Explicit margins guarantee bilingual ordering across players; no animated transforms.
    events.push(...(o['order'] === 'en-top' ? zhEvents.concat(enEvents) : enEvents.concat(zhEvents)));
  }
  return header.concat(events).join('\n') + '\n';
}

export interface PresetTrack { format: string[]; values: string[]; styleName?: string; track?: string; }
export interface PresetTracks { zh: PresetTrack; en: PresetTrack; }
export interface PresetStyle { kind: string; version: number; tracks: PresetTracks; wordColor?: string; kBase?: string; kSweep?: boolean; }
export interface PresetGlowBlock { enabled: boolean; channel: string; color: string; radius: number; intensity: number; }
export interface PresetGlow { enabled: boolean; target: string; followRole: boolean; zh: PresetGlowBlock; en: PresetGlowBlock; }
export interface PresetFade { enabled: boolean; target: string; from: number; duration: number; ratio: number; }
export interface PresetFx { enabled: boolean; glow: PresetGlow; fadein: PresetFade; }
export interface EditorPreset {
  kind: string; version: number; id?: string; name?: string; style?: PresetStyle; tracks?: PresetTracks;
  wordColor?: string; kBase?: string; kSweep?: boolean; order?: string; overlayFontScale?: number;
  fx?: PresetFx; presets?: EditorPreset[];
}
export function makeEditorPreset(o: Record<string, string>, name: string, onlyStyle: boolean = false): EditorPreset {
  const tracks: PresetTracks = {
    zh: { format: STYLE_FORMAT.slice(), values: styleValues(o, 'zh'), track: 'zh', styleName: 'Main' },
    en: { format: STYLE_FORMAT.slice(), values: styleValues(o, 'en'), track: 'en', styleName: 'Sub' }
  };
  const style: PresetStyle = { kind: 'subfabric.ass-style-preset', version: 1, tracks: tracks,
    wordColor: o['wordColor'], kBase: o['kBase'], kSweep: selected(o, 'kSweep') };
  if (onlyStyle) { return style; }
  const block = (lang: string): PresetGlowBlock => ({ enabled: selected(o, `fx.glow.${lang}.enabled`),
    channel: o[`fx.glow.${lang}.channel`], color: o[`fx.glow.${lang}.color`],
    radius: Number(o[`fx.glow.${lang}.radius`]), intensity: Number(o[`fx.glow.${lang}.intensity`]) });
  return { kind: 'subfabric.subtitle-style-preset', version: 1, id: `${Date.now()}`, name: name,
    style: style, order: o['order'], overlayFontScale: Number(o['fontScale']),
    fx: { enabled: selected(o, 'fx.enabled'), glow: { enabled: selected(o, 'fx.glow.enabled'),
      target: o['fx.glow.target'], followRole: selected(o, 'fx.glow.followRole'), zh: block('zh'), en: block('en') },
      fadein: { enabled: selected(o, 'fx.fadein.enabled'), target: o['fx.fadein.target'],
        from: Number(o['fx.fadein.from']), duration: Number(o['fx.fadein.duration']), ratio: Number(o['fx.fadein.ratio']) } } };
}
export function applyEditorPreset(base: Record<string, string>, p: EditorPreset): Record<string, string> {
  if (p.kind !== 'subfabric.subtitle-style-preset' && p.kind !== 'subfabric.ass-style-preset') { throw new Error('不是 SubFabric 样式预设'); }
  const o = normalizeEditorOptions(base);
  const style: PresetStyle | undefined = p.kind === 'subfabric.ass-style-preset' ? p as PresetStyle : p.style;
  if (style !== undefined) {
    for (const lang of ['zh', 'en']) {
      const track = lang === 'zh' ? style.tracks.zh : style.tracks.en;
      if (!Array.isArray(track.format) || track.format.length !== track.values.length ||
          !track.format.some((f: string): boolean => f.toLowerCase() === 'fontname')) { throw new Error('预设轨道字段无效'); }
      for (let i = 0; i < track.format.length; i++) {
        const field = STYLE_FORMAT.find((f: string): boolean => f.toLowerCase() === track.format[i].toLowerCase());
        if (field !== undefined) {
          if (field === 'Fontname' && track.values[i] !== o[`${lang}.Fontname`]) { o[`${lang}.FontFile`] = ''; }
          o[`${lang}.${field}`] = field === 'PrimaryColour' || field === 'SecondaryColour'
            ? colorRgb(track.values[i]) : track.values[i];
        }
      }
    }
    if (style.wordColor) { o['wordColor'] = style.wordColor; }
    if (style.kBase) { o['kBase'] = style.kBase; }
    if (style.kSweep !== undefined) { o['kSweep'] = style.kSweep ? '1' : '0'; }
  }
  if (p.order) { o['order'] = p.order; }
  if (p.overlayFontScale) { o['fontScale'] = String(p.overlayFontScale); }
  if (p.fx) {
    const fx = p.fx;
    o['fx.enabled'] = fx.enabled ? '1' : '0';
    if (fx.glow) {
      o['fx.glow.enabled'] = fx.glow.enabled ? '1' : '0'; o['fx.glow.target'] = fx.glow.target;
      o['fx.glow.followRole'] = fx.glow.followRole ? '1' : '0';
      for (const lang of ['zh', 'en']) {
        const b = lang === 'zh' ? fx.glow.zh : fx.glow.en;
        if (!b) { continue; }
        o[`fx.glow.${lang}.enabled`] = b.enabled ? '1' : '0'; o[`fx.glow.${lang}.channel`] = b.channel;
        o[`fx.glow.${lang}.color`] = b.color; o[`fx.glow.${lang}.radius`] = String(b.radius);
        o[`fx.glow.${lang}.intensity`] = String(b.intensity);
      }
    }
    if (fx.fadein) {
      o['fx.fadein.enabled'] = fx.fadein.enabled ? '1' : '0'; o['fx.fadein.target'] = fx.fadein.target;
      o['fx.fadein.from'] = String(fx.fadein.from);
      o['fx.fadein.duration'] = String(fx.fadein.duration);
      o['fx.fadein.ratio'] = String(fx.fadein.ratio);
    }
  }
  return normalizeEditorOptions(o);
}
