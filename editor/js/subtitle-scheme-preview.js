import { AssDoc, applyAssStylePreset, assStylePresetOf } from './ass.js';
import { AssPlayer } from './assplayer.js';
import { assBgrToHex, hexToAssBgr, applyPostProcess } from './postprocess.js';
import { t } from './i18n.js';

const LANGS = ['zh', 'en'];
const TARGETS = { zh: 'Chinese', en: 'English' };
const MEDIA_URL = new URL('../assets/subtitle-preview.webm', import.meta.url).href;
const STILL_FRAME = 0.75;
const EXAMPLE = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Chinese,Noto Sans CJK SC,70,&H00FFFFFF,&H00FFFFFF,&H00121518,&H80000000,0,0,0,0,100,100,0,0,1,3.2,1,2,48,48,92,1
Style: English,Noto Sans CJK SC,58,&H00FFFFFF,&H00FFFFFF,&H00121518,&H80000000,0,0,0,0,100,100,0,0,1,3.2,1,2,48,48,92,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
const defaults = assStylePresetOf(new AssDoc(EXAMPLE), TARGETS, {
  wordColor: '#8cffaf', kBase: '#d9e2e7', kSweep: false,
});

function sampleAss(style, order, fx) {
  const highlight = `{\\c&H${hexToAssBgr(style.wordColor)}&}`;
  const k = style.kSweep ? '\\kf' : '\\k';
  const cues = [
    ['0:00:00.00', '0:00:01.00', `${highlight}Every{\\c} word matters.`],
    ['0:00:01.00', '0:00:01.65', `Every ${highlight}word{\\c} matters.`],
    ['0:00:01.65', '0:00:02.40', `Every word ${highlight}matters.{\\c}`],
    ['0:00:02.40', '0:00:04.80', `{\\2c&H${hexToAssBgr(style.kBase)}&${k}55}A {${k}70}new {${k}115}scene.`],
  ].map(([start, end, line]) => `Dialogue: 0,${start},${end},English,,0,0,0,,${line}`);
  const zh = [
    'Dialogue: 0,0:00:00.00,0:00:02.40,Chinese,,0,0,0,,每个词都很重要。',
    'Dialogue: 0,0:00:02.40,0:00:04.80,Chinese,,0,0,0,,切换到下一幕。',
  ];
  const events = order === 'en-top' ? zh.concat(cues) : cues.concat(zh);
  const doc = new AssDoc(EXAMPLE + events.join('\n') + '\n');
  applyAssStylePreset(doc, style, TARGETS);
  return applyPostProcess(doc.serialize(), fx, TARGETS);
}

function toHex(value) {
  const ass = /^&H([a-f0-9]{1,8})&?$/i.exec(value || '');
  const decimal = /^-?\d+$/.test(value || '') ? (Number(value) >>> 0).toString(16) : '';
  return assBgrToHex((ass?.[1] || decimal || 'ffffff').padStart(6, '0').slice(-6));
}

function fieldValue(input, value) {
  if (input.type === 'checkbox') return Number(value) !== 0;
  if (input.dataset.styleField.endsWith('colour')) return toHex(value);
  return String(value ?? '');
}

function writeField(track, input, value) {
  const key = input.dataset.styleField;
  let pos = track.format.findIndex(name => name.toLowerCase() === key);
  if (pos < 0) {
    pos = track.format.length;
    track.format.push(key);
  }
  track.values[pos] = input.type === 'checkbox' ? (value ? '-1' : '0')
    : key.endsWith('colour') ? '&H00' + hexToAssBgr(value) : value;
}

export function initSubtitleSchemePreview({ ensureFont, enhanceFontInput, rememberFont, toast }) {
  const el = id => document.getElementById(id);
  const form = el('st-effect-form'), panel = el('st-panel-effects'), settings = el('st-view');
  const container = el('st-subtitle-style'), apply = el('st-subtitle-apply-style');
  const order = el('st-subtitle-order'), scale = el('st-subtitle-scale');
  const highlight = el('st-subtitle-highlight'), kBase = el('st-subtitle-k-base'), kSweep = el('st-subtitle-k-sweep');
  const video = el('st-subtitle-video'), status = el('st-subtitle-preview-status');
  const play = el('st-subtitle-play');
  const sample = video.closest('.sf-subtitle-sample');
  let shouldPlay = false;
  let missingFonts = [];
  const player = new AssPlayer(video, msg => {
    status.textContent = msg === 'ASS 渲染就绪'
      ? (missingFonts.length ? t('预览使用内置字体') + ' · ' + missingFonts.join('、') : '') : t(msg);
    sample.dataset.previewReady = String(player.ready);
  });
  const controls = Object.fromEntries(LANGS.map(lang => {
    const track = container.querySelector(`[data-scheme-track="${lang}"]`);
    track.append(el('st-subtitle-track-fields').content.cloneNode(true));
    const inputs = [...track.querySelectorAll('[data-style-field]')];
    const fontInput = inputs[0];
    enhanceFontInput(fontInput);
    const file = track.querySelector('[data-scheme-font-file]');
    file.addEventListener('change', async () => {
      const font = fontInput.value.trim();
      const picked = file.files?.[0];
      file.value = '';
      if (!picked || !font) return;
      if (!/\.(?:ttf|otf)$/i.test(picked.name)) { toast(t('字体文件仅支持 .ttf 或 .otf')); return; }
      try {
        await player.cacheFont(font, picked);
        await rememberFont(font, picked);
        fontKey = '';
        queue();
      } catch (error) { toast(t('字体载入失败') + '：' + error.message); }
    });
    return [lang, inputs];
  }));
  let base = defaults, fx, timer, generation = 0, fontKey = '';
  const visible = () => !form.hidden && !panel.hidden && !settings.hidden;
  const valueOf = input => input.type === 'checkbox' ? input.checked : input.value.trim();

  function readStyle() {
    const style = structuredClone(base);
    for (const lang of LANGS) {
      const track = style.tracks[lang];
      for (const input of controls[lang]) {
        const value = valueOf(input);
        if (String(value) !== input.dataset.initial) writeField(track, input, value);
      }
    }
    style.wordColor = highlight.value;
    style.kBase = kBase.value;
    style.kSweep = kSweep.checked;
    return style;
  }

  function read() {
    return {
      style: apply.checked ? readStyle() : null, order: order.value,
      overlayFontScale: scale.value ? Number(scale.value) : undefined,
    };
  }

  function queue(newFx = fx) {
    fx = newFx;
    clearTimeout(timer);
    const current = ++generation;
    if (!visible() || !fx) return;
    timer = setTimeout(async () => {
      const style = readStyle();
      const ass = sampleAss(style, order.value, fx);
      const fonts = LANGS.map(lang => controls[lang][0].value.trim());
      const key = JSON.stringify(fonts);
      if (!player.loaded || fontKey !== key) {
        const loaded = await Promise.allSettled(fonts.map(font => ensureFont(font, player)));
        if (current !== generation || !visible()) return;
        missingFonts = [...new Set(fonts.filter((font, index) => font && loaded[index].value === 'missing'))];
        fontKey = key;
        player.load(ass, fonts);
      } else {
        player.updateNow(ass);
      }
      if (!video.getAttribute('src')) video.src = MEDIA_URL;
      if (video.paused && shouldPlay) void video.play().catch(() => {});
    }, 120);
  }

  function configure(preset) {
    shouldPlay = false;
    video.pause();
    if (video.readyState >= 1) video.currentTime = STILL_FRAME;
    base = preset.style || defaults;
    apply.checked = !!preset.style;
    container.disabled = !apply.checked;
    for (const lang of LANGS) {
      const track = base.tracks[lang], fallback = defaults.tracks[lang];
      const lookup = source => source.format.map(field => field.toLowerCase());
      const keys = lookup(track), options = lookup(fallback);
      for (const input of controls[lang]) {
        const key = input.dataset.styleField;
        const value = fieldValue(input, track.values[keys.indexOf(key)] ?? fallback.values[options.indexOf(key)]);
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
        input.dataset.initial = String(valueOf(input));
      }
    }
    highlight.value = base.wordColor || defaults.wordColor;
    kBase.value = base.kBase || defaults.kBase;
    kSweep.checked = base.kSweep === true;
    order.value = preset.order || '';
    scale.value = preset.overlayFontScale ?? '';
    queue(preset.fx);
  }

  apply.addEventListener('change', () => { container.disabled = !apply.checked; });
  form.addEventListener('input', () => queue());
  form.addEventListener('change', () => queue());
  play.addEventListener('click', () => {
    shouldPlay = video.paused;
    if (shouldPlay) void video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener('play', () => { play.textContent = t('暂停预览'); });
  video.addEventListener('pause', () => { play.textContent = t('播放预览'); });
  video.addEventListener('loadedmetadata', () => {
    if (!shouldPlay) video.currentTime = STILL_FRAME;
  });
  video.addEventListener('seeked', () => player.seek(video.currentTime));
  el('st-subtitle-replay').addEventListener('click', () => {
    shouldPlay = true;
    video.currentTime = 0;
    void video.play().catch(() => {});
  });
  video.addEventListener('error', () => { status.textContent = t('示例视频加载失败'); });
  const observers = new MutationObserver(() => {
    if (visible()) queue();
    else {
      clearTimeout(timer);
      generation++;
      video.pause();
      player.dispose();
      sample.dataset.previewReady = 'false';
    }
  });
  for (const item of [form, panel, settings]) observers.observe(item, { attributes: true, attributeFilter: ['hidden'] });
  return { configure, queue, read, defaultStyle: defaults };
}
