import { STUDIO_KEY, defaults, normalizeStudio, projectPhase, matchesProject, imageData } from './studio-state.js';
import { configure as configureRim, updateParams as updateRimParams } from './rim-curve.js';
import { escapeHtml as esc, fmtTime, popOrigin } from './util.js';
import { t } from './i18n.js';
import { ico } from './icons.js';
import { shortcuts, comboFromEvent } from './shortcuts.js';
import { parseCssColor, compositeColor, shouldUseLightText } from './glass-contrast.js';

// 所有编辑、导出、识别与保存仍由 main/project.js 负责。此层只接导航和外观。
const $ = id => document.getElementById(id);
const themes = window.SF_THEMES;
// 移动唯一版本节点，保留 main 的服务端更新；各列表标题不再重复版本号。
document.querySelector('.sf-brand-title').appendChild($('app-version'));
let saved;
try { saved = JSON.parse(localStorage.getItem(STUDIO_KEY) || '{}'); } catch { saved = {}; }
let prefs = normalizeStudio(saved, themes);
let projects = [], filter = 'all', folder = '', route = location.hash || '#/dashboard';
let routeBooted = false;   // 本页第一次收到路由（含刷新）—— 编辑器入场动画要靠它区分"刷新"与"重复 applyHash"
let folderSnapshotSig = '';
let applying = false, pendingSetting = '';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const auroraPalettes = { sage: ['#90b99c', '#bacb91', '#9ac2b8'], ocean: ['#74adc8', '#9eaccf', '#95c5be'], sunset: ['#d69caa', '#cfb693', '#aca3cf'] };
let noticeTimer, noticeHideTimer;
function notice(message) {
  const el = $('sf-notice');
  el.textContent = t(message); el.hidden = false; el.classList.remove('is-uwp-out');
  clearTimeout(noticeTimer); clearTimeout(noticeHideTimer);
  noticeTimer = setTimeout(() => {
    /* UWP 按设计稿 4s 后 160ms 淡出；其余主题保持原来的直接隐藏。 */
    if (document.body.dataset.design !== 'uwp') { el.hidden = true; return; }
    el.classList.add('is-uwp-out');
    noticeHideTimer = setTimeout(() => { el.hidden = true; el.classList.remove('is-uwp-out'); }, 160);
  }, 4000);
}
function commit(change) {
  const next = normalizeStudio({ ...prefs, ...change }, themes);
  try { localStorage.setItem(STUDIO_KEY, JSON.stringify(next)); }
  catch { notice('外观或文件夹保存失败，浏览器存储空间可能不足。'); return false; }
  prefs = next; return true;
}
function applyTheme() {
  applying = true;
  const dark = prefs.mode === 'dark' || prefs.mode === 'system' && systemDark.matches;
  const pack = themes.get(prefs.themePack, prefs.custom);
  // UWP 的默认蓝仍取 pack.seed；一旦用户改过主题色，就用 prefs.accent。
  // 旧默认 accent 是 Studio 的鼠尾草绿，不能让它把首次 UWP 染绿。
  /* UWP / Claude 的默认强调色取主题包 seed；用户一旦改过就跟随 prefs。 */
  const seedAccent = (pack.design === 'uwp' || pack.design === 'claude') && prefs.accent === defaults.accent ? pack.seed : prefs.accent;
  /* Claude 的 seed（#B0512F）是为浅色纸面调的，深色下直接用只有 2.6:1，
     箭头、计数、链接会全部糊在深底上。这里换成提亮变体 #DE8A64（6.1:1）。
     不用 palette() 的 readable()：它会把陶土一路洗到 #EABEAE（三文鱼粉），丢掉色相。
     用户自选颜色时仍交给 palette() 做可读性兜底。 */
  const accent = pack.design === 'claude' && dark
    ? (seedAccent === pack.seed ? '#DE8A64' : themes.palette(seedAccent, true)['--accent'])
    : seedAccent;
  const palette = themes.palette(accent, dark);
  document.body.dataset.theme = dark ? 'dark' : 'light';
  document.body.dataset.design = pack.design;
  document.body.dataset.themePack = pack.id;
  document.body.dataset.bg = prefs.background;
  document.body.dataset.motion = prefs.motion;
  document.body.dataset.auroraMotion = prefs.auroraMotion;
  document.body.dataset.pageVisible = String(!document.hidden);
  let tokens = pack.design === 'material' ? palette : pack.design === 'uwp' ? {
    ...palette, '--accent': accent.toUpperCase(), '--on-accent': themes.contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#101318', '--bg': dark ? '#1F1F1F' : '#F3F3F3', '--surface': dark ? '#2B2B2B' : '#FFFFFF',
    '--surface-2': dark ? '#333333' : '#EDEDED', '--surface-3': dark ? '#3A3A3A' : '#E5E5E5', '--text': dark ? '#F3F3F3' : '#202020', '--muted': dark ? '#C5C5C5' : '#606060',
    '--line': dark ? '#666666' : '#B8B8B8', '--accent-soft': palette['--accent-soft'], '--accent-hover': dark ? '#383838' : '#E5F1FB', '--outline': dark ? '#C8C8C8' : '#666666'
  } : pack.design === 'claude' ? {
    /* Claude：暖纸底 + 陶土强调。中性色固定为纸/墨两套，强调色仍取用户偏好；
       --outline 专供控件描边（比 --line 深，保证 1px 边仍能看清控件轮廓）。 */
    ...palette,
    '--bg': dark ? '#1A1916' : '#F6F4EE',
    '--surface': dark ? '#24221B' : '#FCFBF7',
    '--surface-2': dark ? '#2C2A23' : '#EFECE3',
    '--surface-3': dark ? '#35322A' : '#E7E3D7',
    '--text': dark ? '#EDE9DE' : '#1C1B18',
    '--muted': dark ? '#A5A091' : '#6B675C',
    '--line': dark ? '#37342C' : '#E1DDD1',
    '--accent-soft': dark ? '#3A2A20' : '#F3E2D7',
    '--accent-hover': dark ? '#2E2620' : '#F7ECE4',
    '--outline': dark ? '#78715C' : '#8C8571'
  } : {
    ...themes.palette(prefs.accent, dark), '--bg': dark ? '#1c221e' : '#f6f7f2', '--surface': dark ? '#252d27' : '#fffefa',
    '--surface-2': dark ? '#2c352e' : '#eef1e8', '--text': dark ? '#e0e6da' : '#28372b', '--muted': dark ? '#b2bdae' : '#647161', '--line': dark ? '#465244' : '#dce2d5'
  };
  // 自定义包只能覆盖白名单令牌；UWP 的中性色固定，但强调色跟随用户选择。
  if (pack.design !== 'uwp') {
    tokens = { ...tokens, ...themes.tokenOverrides(pack, dark) };
    // 包的调色板可以自绘，但设置中的强调色仍是最终用户偏好。
    // 用 accent 而不是 prefs.accent：Claude/UWP 在用户没改过颜色时要落在主题包 seed 上。
    tokens['--accent'] = accent.toUpperCase();
    /* 深色兜底按 design 分流：Claude 用暖褐 #241B14 与纸面基调一致；
       其它主题保持原有的近黑蓝 #101318，避免波及 Material/Classic/Studio。 */
    tokens['--on-accent'] = themes.contrast(accent, '#ffffff') >= 4.5 ? '#ffffff'
      : (dark && pack.design === 'claude' ? '#241B14' : '#101318');
  }
  // 原控件和 canvas 都从 root 读变量，统一映射为原程序的令牌名。
  window.SSAccent.apply(tokens['--accent']);
  const st = document.documentElement.style;
  Object.entries(tokens).forEach(([k, v]) => st.setProperty(k, v));
  for (const [k, v] of Object.entries({ '--bg-0': tokens['--bg'], '--bg-1': tokens['--surface'], '--bg-2': tokens['--surface-2'], '--bg-3': tokens['--accent-soft'], '--border': tokens['--line'], '--text-0': tokens['--text'], '--text-1': tokens['--muted'], '--text-2': tokens['--muted'], '--zh': tokens['--text'], '--en': tokens['--muted'], '--accent-ink': tokens['--on-accent'] })) st.setProperty(k, v);
  st.colorScheme = dark ? 'dark' : 'light';
  st.setProperty('--sf-glass-dim', prefs.glassDim + '%');
  st.setProperty('--sf-glass-blur', prefs.glassBlur + 'px');
  st.setProperty('--sf-glass-opacity', prefs.glassOpacity + '%');
  // 纯黑基底配浅色正文，即使背后是纯白图片也保留足够对比度。
  // 压暗控制黑色基底强度，透明度单独控制实际 alpha；默认 80/100 保持此前视觉。
  const glassAlpha = prefs.glassDim * prefs.glassOpacity / 10000;
  st.setProperty('--sf-glass-surface', `rgb(8 11 10 / ${glassAlpha})`);
  st.setProperty('--sf-glass-raised', `rgb(12 16 14 / ${Math.min(.96, glassAlpha + .06)})`);
  // 浅色模式使用独立的黑色半透明层：压暗值控制底色深度，透明度控制材质透出量。
  // 这样同一组设置在 Studio、Material、UWP、Classic 主题中都能工作，且默认值不会把浅色面板压成深色。
  const lightGlassAlpha = Math.max(.06, Math.min(.42, (prefs.glassDim - 60) / 100 * prefs.glassOpacity / 100));
  st.setProperty('--sf-glass-light-surface', `rgb(0 0 0 / ${lightGlassAlpha})`);
  st.setProperty('--sf-glass-light-raised', `rgb(0 0 0 / ${Math.min(.5, lightGlassAlpha + .06)})`);
  $('sf-glass-dim').value = String(prefs.glassDim);
  $('sf-glass-blur').value = String(prefs.glassBlur);
  $('sf-glass-opacity').value = String(prefs.glassOpacity);
  $('sf-glass-dim-value').textContent = prefs.glassDim + '%';
  $('sf-glass-blur-value').textContent = prefs.glassBlur + 'px';
  $('sf-glass-opacity-value').textContent = prefs.glassOpacity + '%';
  /* UWP 的流光只从中性色与固定蓝里取；Material 的 secondary/tertiary 是紫/粉，
     直接继承会把 Windows 主题染成 Material 色。 */
  const auroraColors = prefs.auroraColors.length ? prefs.auroraColors
    : pack.design === 'uwp' || pack.design === 'claude'
      ? [tokens['--accent-soft'], tokens['--surface-2'], tokens['--line']]
      : [tokens['--accent-soft'], tokens['--secondary-container'], tokens['--tertiary-container']];
  auroraColors.forEach((color, i) => {
    st.setProperty('--sf-aurora-' + (i + 1), color);
    const input = $('sf-aurora-color-' + (i + 1));
    input.value = color; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('sf-aurora-options').hidden = prefs.background !== 'aurora';
  $('sf-image-tools').hidden = prefs.background !== 'image';
  $('sf-aurora-motion').value = prefs.auroraMotion;
  /* 流光速度：CSS 里 animation-duration 取 --sf-aurora-duration（20s / speed）。 */
  const auroraSpeed = prefs.auroraSpeed;
  st.setProperty('--sf-aurora-duration', (20 / auroraSpeed).toFixed(2) + 's');
  const auroraSpeedInput = $('sf-aurora-speed');
  if (auroraSpeedInput) auroraSpeedInput.value = String(auroraSpeed);
  const auroraSpeedValue = $('sf-aurora-speed-value');
  if (auroraSpeedValue) auroraSpeedValue.textContent = auroraSpeed.toFixed(1) + '×';
  const auroraSpeedRow = $('sf-aurora-speed-row');
  if (auroraSpeedRow) auroraSpeedRow.hidden = prefs.auroraMotion !== 'dynamic';
  $('sf-aurora-palette').value = !prefs.auroraColors.length ? 'theme' : Object.keys(auroraPalettes).find(key => auroraPalettes[key].every((color, i) => color === prefs.auroraColors[i])) || 'custom';
  $('sf-background').value = prefs.background; $('sf-mode').value = prefs.mode; $('sf-motion').value = prefs.motion; $('sf-color').value = accent;
  $('sf-color').disabled = false;
  $('sf-color').title = '';
  $('sf-image-pick').disabled = prefs.background !== 'image';
  $('sf-image-clear').disabled = !prefs.image;
  /* 莫奈取色只对 Material You 有意义；图片由用户临时选择，不改背景素材。 */
  const monetRow = $('sf-monet-row');
  if (monetRow) monetRow.hidden = pack.design !== 'material';
  for (const input of document.querySelectorAll('#sf-color, #theme-color, [data-theme-color]')) {
    input.value = accent;
    input.disabled = false;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.querySelectorAll('.theme-sw[data-hex]').forEach(b => { b.classList.toggle('active', b.dataset.hex === accent); b.disabled = false; });
  document.querySelector('.sf-backdrop').style.backgroundImage = prefs.background === 'image' && imageData(prefs.image) ? `url("${prefs.image}")` : 'none';
  st.setProperty('--sf-image-blur', prefs.imageBlur + 'px');
  st.setProperty('--sf-image-dim', (prefs.imageDim / 100).toFixed(2));
  $('sf-image-blur').value = String(prefs.imageBlur);
  $('sf-image-dim').value = String(prefs.imageDim);
  $('sf-image-blur-value').textContent = prefs.imageBlur + 'px';
  $('sf-image-dim-value').textContent = prefs.imageDim + '%';
  window.SF_PROGRESS.sync();
  window.dispatchEvent(new CustomEvent('ss-accent', { detail: { hex: accent } }));
  window.dispatchEvent(new Event('sf-studio-theme'));
  syncUwpTiles();
  syncUwpRanges();
  /* 主题切换/首屏应用时 route 可能早于 data-design 写入；这里按当前可见页补一次
     Material 卡片入场，避免稿件库首屏停在 .proj-card 的 fade-up。 */
  if (pack.design === 'material') {
    requestAnimationFrame(() => {
      if (document.body.dataset.design !== 'material') return;
      const h = location.hash || '#/dashboard';
      if (h === '#/home') animateMaterialPage($('home-view'));
      else if (h === '#/settings') {
        const panel = [...$('st-view').querySelectorAll('.st-panel:not([hidden])')][0];
        if (panel) animateMaterialPage(panel);
      } else if (h === '#/help') animateMaterialPage($('sf-help'));
      else if (h === '#/editor' || h.startsWith('#/project/')) {
        animateMaterialEditorShell();
        animateMaterialCueList();
      }
      animateMaterialPage($('sf-folders'));
    });
  }
  applying = false;
  renderPacks();
  syncAppearanceChoices();
  configureRim({ material: pack.id === 'material-you', enabled: prefs.rimEnabled, prefs, tokens, dark });
}
function syncAppearanceChoices() {
  for (const kind of ['background', 'mode']) {
    document.querySelectorAll(`[data-appearance-${kind}]`).forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset[kind === 'mode' ? 'appearanceMode' : 'appearanceBackground'] === prefs[kind]));
    });
  }
  const imageThumb = document.querySelector('.sf-background-thumb.image');
  if (imageThumb) imageThumb.style.backgroundImage = imageData(prefs.image) ? `url("${prefs.image}")` : '';
}
for (const kind of ['background', 'mode']) {
  document.querySelectorAll(`[data-appearance-${kind}]`).forEach(button => button.addEventListener('click', () => {
    const select = $('sf-' + kind);
    select.value = button.dataset[kind === 'mode' ? 'appearanceMode' : 'appearanceBackground'];
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }));
}
// 侧栏取色控件写入 Studio 独立偏好，不改变项目业务配置。
window.SSAccent.current = () => {
  const pack = themes.get(prefs.themePack, prefs.custom);
  return pack.design === 'uwp' && prefs.accent === defaults.accent ? pack.seed : prefs.accent;
};
window.SSAccent.set = hex => {
  if (applying) return false;
  if (!themes.hex(hex) || !commit({ accent: hex })) return false;
  applyTheme(); return true;
};
window.SSAccent.reset = () => { const seed = themes.get(prefs.themePack, prefs.custom).seed; if (commit({ accent: seed })) applyTheme(); return seed; };
function renderPacks() {
  const render = pack => {
    // 示意卡片的工作区预览跟随当前明暗模式，避免深色设置页内仍显示浅色工作区。
    const dark = document.body.dataset.theme === 'dark';
    const previewAccent = pack.id === prefs.themePack && pack.design === 'uwp' && prefs.accent !== defaults.accent
      ? prefs.accent : pack.seed;
    const palette = pack.design === 'uwp'
      ? { '--bg': dark ? '#1F1F1F' : '#F3F3F3', '--accent': previewAccent, '--on-accent': '#FFFFFF' }
      : pack.design === 'claude'
        /* Claude 示意图必须显示纸感底色，不能落回 Material 的色调推导。 */
        ? { '--bg': dark ? '#1A1916' : '#F6F4EE', '--accent': pack.seed, '--on-accent': dark ? '#241B14' : '#FDFBF6' }
        : { ...themes.palette(pack.seed, dark), ...themes.tokenOverrides(pack, dark) };
    /* 自定义主题包统一用 Windows 10 的斜向四格窗户图标；内置包保留各自标识。 */
    const customGlyph = '<path d="M4 6.3 11 4.4v7.1H4zM12.6 4.1 20 2.1v9.4h-7.4zM4 12.6h7v7.1l-7-1.9zM12.6 12.6H20v9.3l-7.4-1.9z" fill="currentColor" stroke="none"/>';
    const glyph = !pack.builtin
      ? customGlyph
      : pack.design === 'material'
        ? '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3ZM20 2v4m-2-2h4M4 18v4m-2-2h4"/>'
        : pack.design === 'uwp'
          /* Windows 10 开始菜单四格徽标：斜向四窗、实心；不再是嵌套方框。 */
          ? '<path d="M3 4.4 11 3.1v8.4H3zM12 2.9 21 1.6v10.2h-9zM3 12.3h8v8.4l-8-1.3zM12 12.3h9v10.2l-9-1.3z" fill="currentColor" stroke="none"/>'
          : pack.design === 'claude'
            /* Claude 的星芒标识：八向发光，圆头描边。 */
            ? '<path d="M12 2.8v18.4M2.8 12h18.4M5.5 5.5l13 13M18.5 5.5l-13 13"/>'
            : '<path d="M4 6.5 12 3l8 3.5v11L12 21l-8-3.5z"/><path d="m4 6.5 8 3.5 8-3.5M12 10v11M8 4.8l8 3.5"/>';
    const selected = prefs.themePack === pack.id;
    const builtin = themes.isBuiltin(pack);
    const preview = pack.assets?.preview ? `--preview-image:url("${pack.assets.preview}");` : '';
    return `<article class="sf-pack" data-pack="${esc(pack.id)}" data-builtin="${builtin}" aria-current="${selected ? 'true' : 'false'}"><button type="button" class="sf-pack-select" data-pack-select="${esc(pack.id)}" aria-pressed="${selected}"><span class="sf-pack-art ${pack.design}" aria-hidden="true" style="--preview-bg:${palette['--bg']};--preview-accent:${palette['--accent']};--preview-ink:${palette['--on-accent']};${preview}"><span class="sf-pack-symbol"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span><span class="sf-pack-lines"><i></i><i></i><i></i></span></span><span class="sf-pack-name"><b>${esc(pack.name)}</b>${selected ? ico('checkCircle') : ''}</span><small>${esc(pack.description)}</small><em>${builtin ? '内置主题包' : '我的主题包'}</em></button>${builtin ? '' : `<button type="button" class="sf-pack-delete" data-delete-pack="${esc(pack.id)}" title="删除主题包" aria-label="删除 ${esc(pack.name)}">${ico('trash')}</button>`}</article>`;
  };
  const builtin = themes.list([]).map(render).join('');
  const custom = prefs.custom.map(render).join('');
  $('sf-theme-packs').innerHTML = `<section class="sf-pack-group"><h4>内置主题包</h4><div class="sf-theme-pack-grid">${builtin}</div></section><section class="sf-pack-group"><h4>我的主题包</h4><div class="sf-theme-pack-grid">${custom || '<p class="sf-pack-empty">导入你绘制的 JSON 主题包，它会显示在这里。</p>'}</div></section>`;
  scheduleGlassForeground();
}

/* ═══════════════════════════════════════════════════════════════════════
   玻璃面板前景色自动检测
   -----------------------------------------------------------------------
   浅色模式下玻璃基底是 rgb(0 0 0 / alpha)。压暗/透明度调高、或者背后是深色
   背景图时，合成后的卡片会变深，而 --text 仍是深色。这里把卡片背景逐层与
   页面底色（图片背景取平均色）做 alpha 合成，算相对亮度后给面板加
   .sf-fg-on-dark，局部把 --text/--muted/--line 换成浅色。
   只作用于浅色模式；深色模式本来就用浅色字，不需要也不应该重复覆盖。
   ═══════════════════════════════════════════════════════════════════════ */
const GLASS_FG_SELECTOR = [
  '.sf-pack', '.st-card', '.set-group', '.st-section', '.sf-asr-family',
  '.proj-card', '.page-surface', '.cue-card', '.role-card', '.sm-model',
  '.st-entry', '.st-scheme', '.panel-head', '.tl-toolbar', '.tab-head',
  '.sf-pack-group h4',
].join(',');
let glassFgFrame = 0;
let glassBackdropImage = { src: '', color: null, loading: false };

function cssVarColor(name, fallback = null) {
  try {
    return parseCssColor(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;
  } catch { return fallback; }
}

function pageBaseColor() {
  const bg = cssVarColor('--bg');
  if (bg) return { ...bg, a: 1 };
  const body = parseCssColor(getComputedStyle(document.body).backgroundColor);
  if (body && body.a >= 0.999) return body;
  return { r: 255, g: 255, b: 255, a: 1 };
}

function loadGlassBackdropImage(src) {
  glassBackdropImage = { src, color: null, loading: true };
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const base = pageBaseColor();
      ctx.fillStyle = `rgb(${base.r} ${base.g} ${base.b})`;
      ctx.fillRect(0, 0, 16, 16);
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      glassBackdropImage = { src, color: n ? { r: r / n, g: g / n, b: b / n, a: 1 } : null, loading: false };
    } catch {
      glassBackdropImage = { src, color: null, loading: false };
    }
    scheduleGlassForeground();
  };
  img.onerror = () => { glassBackdropImage = { src, color: null, loading: false }; };
  img.src = src;
}

/** 页面底色 +（若当前背景是图片）图片平均色 × 透明度/亮度。 */
function glassBackdropColor() {
  const base = pageBaseColor();
  if (prefs.background === 'image' && imageData(prefs.image)) {
    if (!glassBackdropImage.loading && glassBackdropImage.src !== prefs.image) loadGlassBackdropImage(prefs.image);
    if (glassBackdropImage.src === prefs.image && glassBackdropImage.color) {
      const backdrop = document.querySelector('.sf-backdrop');
      const cs = backdrop ? getComputedStyle(backdrop) : null;
      if (cs && cs.display !== 'none') {
        const opacity = Number.parseFloat(cs.opacity);
        if (Number.isFinite(opacity) && opacity > 0) {
          const bright = Math.max(0, 1 - (Number(prefs.imageDim) || 0) / 100);
          const img = {
            r: glassBackdropImage.color.r * bright,
            g: glassBackdropImage.color.g * bright,
            b: glassBackdropImage.color.b * bright,
            a: 1,
          };
          return compositeColor({ ...img, a: opacity }, base);
        }
      }
    }
    return base;
  }
  if (prefs.background === 'aurora') {
    const colors = [1, 2, 3].map(i => cssVarColor('--sf-aurora-' + i)).filter(Boolean);
    if (colors.length) {
      const avg = colors.reduce((acc, c) => ({ r: acc.r + c.r / colors.length, g: acc.g + c.g / colors.length, b: acc.b + c.b / colors.length }), { r: 0, g: 0, b: 0 });
      return compositeColor({ ...avg, a: 0.55 }, base);
    }
  }
  return base;
}

/** 把元素自身的半透明背景逐层压到 backdrop 上，得到真实合成色。 */
function glassElementBackground(el) {
  const layers = [];
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    const color = parseCssColor(getComputedStyle(node).backgroundColor);
    if (color && color.a > 0.001) {
      layers.push(color);
      if (color.a >= 0.999) break;
    }
  }
  let out = glassBackdropColor();
  for (let i = layers.length - 1; i >= 0; i--) out = compositeColor(layers[i], out);
  return out;
}

function syncGlassForeground() {
  glassFgFrame = 0;
  if (!document.body || typeof getComputedStyle !== 'function') return;
  const light = document.body.dataset.theme === 'light';
  for (const el of document.querySelectorAll(GLASS_FG_SELECTOR)) {
    el.classList.toggle('sf-fg-on-dark', light && shouldUseLightText({ background: glassElementBackground(el) }));
  }
  /* 分组标题本身是透明背景，合成值可能落在阈值边缘；只要同组主题卡已经被判定为
     深底，就跟着切浅色，避免“卡片白字、上面的‘内置主题包’仍是深灰字”。 */
  const packOnDark = !!document.querySelector('.sf-pack.sf-fg-on-dark');
  for (const heading of document.querySelectorAll('.sf-pack-group h4, .sf-pack-empty')) {
    heading.classList.toggle('sf-fg-on-dark', light && packOnDark);
  }
}

function scheduleGlassForeground() {
  if (glassFgFrame || typeof getComputedStyle !== 'function') return;
  glassFgFrame = requestAnimationFrame(syncGlassForeground);
}
window.addEventListener('hashchange', scheduleGlassForeground);
window.addEventListener('resize', scheduleGlassForeground);
$('sf-theme-packs').addEventListener('click', e => {
  const del = e.target.closest('[data-delete-pack]');
  if (del) {
    const id = del.dataset.deletePack;
    if (!themes.canDelete(id)) return;
    const next = themes.remove(prefs.custom, id);
    const selected = prefs.themePack === id;
    if (commit(selected ? { custom: next, themePack: 'windows-uwp', accent: themes.get('windows-uwp').seed } : { custom: next })) { applyTheme(); themeStatus(); }
    return;
  }
  const b = e.target.closest('[data-pack-select]'); if (!b) return;
  // 卡片把主题 ID 放在 data-pack-select；读取错误的 dataset.pack 会让
  // themes.get(undefined) 静默回退到 Studio，造成“点击没有任何反应”。
  const pack = themes.get(b.dataset.packSelect, prefs.custom);
  if (commit({ themePack: pack.id, accent: pack.seed })) { applyTheme(); themeStatus(); }
});
function themeStatus() { $('sf-theme-status').textContent = t('外观已保存，刷新后保留。'); }
for (const [id, key] of [['sf-glass-dim', 'glassDim'], ['sf-glass-blur', 'glassBlur'], ['sf-glass-opacity', 'glassOpacity']]) $(id).addEventListener('input', () => {
  if (commit({ [key]: Number($(id).value) })) { applyTheme(); themeStatus(); }
});
const rimEnabled = $('sf-rim-enabled');
if (rimEnabled) rimEnabled.addEventListener('change', () => {
  if (commit({ rimEnabled: rimEnabled.checked })) { applyTheme(); themeStatus(); }
});
for (const [id, key] of [['sf-rim-sat-low', 'rimSatLow'], ['sf-rim-bri-gain', 'rimBriGain'], ['sf-rim-spec-base', 'rimSpecBase'], ['sf-rim-power', 'rimPower']]) {
  const input = $(id);
  if (!input) continue;
  /* 拖动时只重画曲线/已有环：不能 applyTheme()。applyTheme 会 renderPacks() 重建主题卡、
   * 重播设置卡入场并重算全部令牌，连续 input 看起来就是整页反复刷新。 */
  input.addEventListener('input', () => {
    prefs[key] = Number(input.value);
    updateRimParams(prefs);
  });
  input.addEventListener('change', () => {
    if (commit({ [key]: prefs[key] })) {
      updateRimParams(prefs);
      themeStatus();
    }
  });
}
$('sf-background').addEventListener('change', () => {
  if (commit({ background: $('sf-background').value })) applyBackgroundWithFade();
});
for (const [id, key] of [['sf-motion', 'motion'], ['sf-aurora-motion', 'auroraMotion']]) $(id).addEventListener('change', () => {
  if (commit({ [key]: $(id).value })) { applyTheme(); themeStatus(); }
});
/* 流光速度：拖动时实时改 --sf-aurora-duration，松手才写 localStorage。 */
{
  const speed = $('sf-aurora-speed'), output = $('sf-aurora-speed-value');
  const read = () => Math.round(Math.max(0.4, Math.min(2.5, Number(speed.value) || 1)) * 10) / 10;
  const preview = () => {
    const v = read();
    document.documentElement.style.setProperty('--sf-aurora-duration', (20 / v).toFixed(2) + 's');
    if (output) output.textContent = v.toFixed(1) + '×';
  };
  if (speed) {
    speed.addEventListener('input', preview);
    speed.addEventListener('change', () => {
      const v = read();
      if (commit({ auroraSpeed: v })) { applyTheme(); themeStatus(); }
    });
  }
}
$('sf-mode').addEventListener('change', () => {
  if (commit({ mode: $('sf-mode').value })) applyModeWithReveal();
});
/** 纯色 / 流光 / 自定义图片切换：两种主题都用整屏交叉淡变，背景不会硬切。 */
let bgFadeSeq = 0;
function applyBackgroundWithFade() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    || document.body.dataset.motion === 'off';
  if (reduced || typeof document.startViewTransition !== 'function') {
    applyTheme(); themeStatus(); return;
  }
  const root = document.documentElement;
  const seq = ++bgFadeSeq;
  root.dataset.bgTransition = 'fade';
  const done = () => {
    if (seq !== bgFadeSeq) return;
    delete root.dataset.bgTransition;
  };
  try {
    const transition = document.startViewTransition(() => { applyTheme(); });
    themeStatus();
    transition.finished.finally(done);
  } catch {
    applyTheme(); themeStatus(); done();
  }
}
/** Material You 明暗切换：从被点击的浅色/深色按钮处用圆形遮罩扩散到全屏。 */
let modeRevealSeq = 0;
function applyModeWithReveal() {
  const value = prefs.mode;
  const button = document.querySelector(`[data-appearance-mode="${value}"]`);
  const rect = button?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : innerHeight / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 2;
  const root = document.documentElement;
  const seq = ++modeRevealSeq;
  root.style.setProperty('--sf-mode-x', `${x}px`);
  root.style.setProperty('--sf-mode-y', `${y}px`);
  root.style.setProperty('--sf-mode-r', `${radius}px`);
  const cleanup = () => {
    if (seq !== modeRevealSeq) return;
    root.style.removeProperty('--sf-mode-x');
    root.style.removeProperty('--sf-mode-y');
    root.style.removeProperty('--sf-mode-r');
  };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    || document.body.dataset.motion === 'off';
  const material = document.body.dataset.design === 'material';
  const uwp = document.body.dataset.design === 'uwp';
  if ((!material && !uwp) || reduced || typeof document.startViewTransition !== 'function') {
    applyTheme();
    themeStatus();
    cleanup();
    return;
  }
  if (uwp) {
    /* Windows 10：不用 Material 的圆形揭示，直接旧主题褪出、新主题淡入。 */
    root.dataset.modeTransition = 'uwp-fade';
    const done = () => {
      if (seq !== modeRevealSeq) return;
      delete root.dataset.modeTransition;
      cleanup();
    };
    try {
      const transition = document.startViewTransition(() => { applyTheme(); });
      themeStatus();
      transition.finished.finally(done);
    } catch {
      applyTheme();
      themeStatus();
      done();
    }
    return;
  }
  try {
    const transition = document.startViewTransition(() => { applyTheme(); });
    themeStatus();
    transition.finished.finally(cleanup);
  } catch {
    applyTheme();
    themeStatus();
    cleanup();
  }
}

// 只有可见的动态背景运行动画；静态/后台/减少动效不启动 JS 时钟。
document.addEventListener('visibilitychange', () => { document.body.dataset.pageVisible = String(!document.hidden); });
$('sf-aurora-palette').addEventListener('change', () => {
  const choice = $('sf-aurora-palette').value;
  const colors = choice === 'theme' ? [] : auroraPalettes[choice] || [1, 2, 3].map(i => $('sf-aurora-color-' + i).value);
  if (commit({ auroraColors: colors })) { applyTheme(); themeStatus(); }
});
for (let i = 1; i <= 3; i++) $('sf-aurora-color-' + i).addEventListener('change', () => {
  const colors = [1, 2, 3].map(n => $('sf-aurora-color-' + n).value);
  if (!colors.every(color => themes.hex(color))) { notice('主题色需要使用 #RRGGBB 格式。'); applyTheme(); return; }
  if (commit({ auroraColors: colors })) { applyTheme(); themeStatus(); }
});
$('sf-color').addEventListener('change', () => {
  if (!themes.hex($('sf-color').value)) { notice('主题色需要使用 #RRGGBB 格式。'); return; }
  if (commit({ accent: $('sf-color').value })) { applyTheme(); themeStatus(); }
});
// 同步原有取色控件；不让主题初始化产生递归事件或污染旧 UI 的偏好。
window.addEventListener('ss-accent', e => {
  if (applying || !themes.hex(e.detail?.hex)) return;
  if (commit({ accent: e.detail.hex })) applyTheme();
});
systemDark.addEventListener('change', () => { if (prefs.mode === 'system') applyTheme(); });
window.addEventListener('storage', e => {
  if (e.key !== STUDIO_KEY) return;
  try { prefs = normalizeStudio(JSON.parse(e.newValue || '{}'), themes); applyTheme(); renderFolders(); refreshLibrary(); } catch { /* 保持当前可用界面。 */ }
});
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('sf-theme-export').addEventListener('click', () => {
  const pack = themes.get(prefs.themePack, prefs.custom);
  download(`${pack.id}.theme.json`, { ...pack, seed: pack.design === 'uwp' ? pack.seed : prefs.accent });
});
$('sf-theme-import').addEventListener('click', () => $('sf-theme-file').click());
$('sf-theme-file').addEventListener('change', async () => {
  const f = $('sf-theme-file').files[0]; $('sf-theme-file').value = ''; if (!f) return;
  try {
    if (f.size > 800000) throw Error('主题包过大，最大支持 800KB。');
    const imported = JSON.parse(await f.text()); if (!themes.valid(imported)) throw Error('主题包格式无效，只支持声明式主题 JSON。');
    let pack = imported;
    if (themes.isBuiltin(pack)) {
      const base = pack.id + '-custom';
      let id = base, n = 2;
      while (themes.get(id, prefs.custom).id === id) id = `${base}-${n++}`;
      pack = { ...pack, id, name: `${pack.name}（自定义）`, builtin: false };
    }
    pack = themes.asCustom(pack); if (!pack) throw Error('内置主题包不能直接覆盖，请使用新的主题包 ID。');
    let custom = prefs.custom;
    custom = [...custom.filter(p => p.id !== pack.id), pack];
    if (!themes.validList(custom)) throw Error('主题包数量已达上限。');
    if (commit({ custom, themePack: pack.id, accent: pack.seed })) { applyTheme(); themeStatus(); }
  } catch (e) { notice(e.message); }
});
$('sf-image-pick').addEventListener('click', () => $('sf-image-file').click());
$('sf-image-clear').addEventListener('click', () => { if (commit({ image: '', background: 'solid' })) applyBackgroundWithFade(); });
/* Material You 莫奈取色：从当前背景图提取种子色，再按现有 palette() 生成整套配色。
 * 不是取平均色（平均常是灰），monet.js 会按色相桶 + 饱和度/明度权重挑主色。 */
$('sf-color-from-image')?.addEventListener('click', () => $('sf-monet-file').click());
$('sf-monet-file')?.addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';                       // 允许连续选同一张图
  if (!file) return;
  if (!(BG_IMAGE_TYPES.test(file.type || '') || BG_IMAGE_EXT.test(file.name || '')) || file.size > 64 * 1024 * 1024) {
    notice('请选择 PNG、JPEG、WebP、HEIC 或 HEIF 图片（单文件不超过 64MB）。');
    return;
  }
  const btn = $('sf-color-from-image');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '取色中…'; }
  try {
    /* 动态加载：取色模块是本期新增文件。旧服务进程的静态白名单还没它时，
     * 顶层静态 import 会让整个 studio.js 加载失败（主题/背景/流光全部不应用）。
     * 放在点击里，最坏也只是取色不可用，其余界面照常。 */
    const { extractSeedFromImageSrc } = await import('./monet.js');
    const data = await prepareBackgroundImage(file);   // 兼容 HEIC，顺手压到可解码的小图
    const seed = await extractSeedFromImageSrc(data);
    if (!seed) throw new Error('图片里没有找到可用的颜色');
    if (!commit({ accent: seed })) throw new Error('主题色保存失败');
    applyTheme();
    notice(`已从图片提取主题色 ${seed.toUpperCase()}（莫奈取色）`);
  } catch (error) {
    notice('图片取色失败：' + (error && error.message ? error.message : error));
  } finally {
    if (btn) { btn.textContent = label; btn.disabled = false; }
  }
});
/* 背景图不再限制 2MB 输入：先 decode，再压到长边 2560 的 WebP/JPEG。
   HEIC/HEIF 走浏览器/系统解码器；Windows 装了 HEIF 图像扩展的 Edge 可直接读。
   这样既支持大图，也不会把 localStorage 撑爆。 */
const BG_IMAGE_TYPES = /^image\/(?:png|jpe?g|webp|heic|heif)$/i;
const BG_IMAGE_EXT = /\.(?:png|jpe?g|webp|heic|heif)$/i;
const isHeicFile = f => /^image\/hei[cf]/i.test(f.type || '') || /\.(?:heic|heif)$/i.test(f.name || '');
async function decodeBackgroundImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* 再给 <img> 一次机会 */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
async function prepareBackgroundImage(file) {
  let bitmap;
  try { bitmap = await decodeBackgroundImage(file); }
  catch (error) {
    /* 浏览器没有 HEVC 解码器时，让本地服务端用 ffmpeg 解一帧；
       ffmpeg 本来就是本项目音频/波形的依赖。 */
    if (!isHeicFile(file)) throw error;
    const response = await fetch('/api/image/convert', { method: 'POST', body: file });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !imageData(payload.data || '')) {
      throw new Error(payload.error || 'HEIF/HEIC 转换失败');
    }
    return payload.data;
  }
  const sourceW = bitmap.width || bitmap.naturalWidth, sourceH = bitmap.height || bitmap.naturalHeight;
  if (!sourceW || !sourceH) throw new Error('decode');
  const scale = Math.min(1, 2560 / Math.max(sourceW, sourceH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceW * scale));
  canvas.height = Math.max(1, Math.round(sourceH * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (typeof bitmap.close === 'function') bitmap.close();
  const webp = canvas.toDataURL('image/webp', 0.9);
  return /^data:image\/webp;base64,/.test(webp) ? webp : canvas.toDataURL('image/jpeg', 0.9);
}
$('sf-image-file').addEventListener('change', async () => {
  const f = $('sf-image-file').files[0]; $('sf-image-file').value = ''; if (!f) return;
  if (!(BG_IMAGE_TYPES.test(f.type || '') || BG_IMAGE_EXT.test(f.name || '')) || f.size > 64 * 1024 * 1024) {
    notice('请选择 PNG、JPEG、WebP、HEIC 或 HEIF 图片（单文件不超过 64MB）。'); return;
  }
  try {
    const data = await prepareBackgroundImage(f);
    if (!imageData(data)) throw Error('图片格式无效。');
    if (commit({ image: data, background: 'image' })) applyBackgroundWithFade();
  } catch (error) {
    notice(isHeicFile(f)
      ? (/HEIF|HEIC|ffmpeg|转换/i.test(error?.message || '')
        ? String(error.message || 'HEIF/HEIC 转换失败')
        : '当前浏览器无法解码 HEIF/HEIC，且服务端转换不可用；请安装 HEIF 图像扩展或可用的 ffmpeg。')
      : '图片读取失败。');
  }
});
for (const [id, key, unit] of [['sf-image-blur', 'imageBlur', 'px'], ['sf-image-dim', 'imageDim', '%']]) {
  const input = $(id), output = $(id + '-value');
  input.addEventListener('input', () => {
    const value = Math.max(0, Math.min(Number(input.max) || 100, Number(input.value) || 0));
    prefs[key] = value;
    document.documentElement.style.setProperty(key === 'imageBlur' ? '--sf-image-blur' : '--sf-image-dim', key === 'imageBlur' ? value + 'px' : (value / 100).toFixed(2));
    if (output) output.textContent = value + unit;
  });
  input.addEventListener('change', () => { commit({ [key]: prefs[key] }); });
}

// 工作台偏好在全局设置与编辑器之间移动；ASS 样式始终留在编辑器。
// 旧 HTML 的特效组少一个闭合层，浏览器将后续五张卡解析进特效组；
// 新界面先恢复同级关系，否则移动特效卡会把音频、导出设置一起搬走。
const fx = $('ass-fx-group');
let afterFx = fx;
for (const child of [...fx.children].filter(el => el.classList.contains('set-group') || el.classList.contains('setting-note'))) { afterFx.after(child); afterFx = child; }
if ($('fx-status-note').parentElement !== fx) fx.appendChild($('fx-status-note'));
// 分组沿用常驻真实节点；重新分类不重建表单，离开后恢复编辑器原位置。
const styleGroups = ['sf-editor-timeline', 'sf-editor-display', 'sf-editor-roles', 'sf-editor-media', 'sf-editor-export'].map(id => $(id));
function moveStyles() {}

// 增强配置按使用顺序组织，控件的 ID、值、事件及模型委托祖先不变。
const enhance = $('st-panel-enhance');
const cardOf = id => $(id).closest('.st-card');
const heal = cardOf('cb-heal-words');
// 必须放回 .settings-list（滚动区）内部；直接挂到 #tab-settings 会落在滚动区外，
// 在编辑器设置底部形成一张固定/遮挡内容的浮窗。优先放在「高级字幕操作」组后面，
// 与它的语义位置一致；找不到时退化为设置列表末尾。
const settingsList = $('tab-settings').querySelector('.settings-list') || $('tab-settings');
const advanced = $('editor-advanced-actions');
if (advanced && advanced.parentElement === settingsList) advanced.after(heal);
else settingsList.appendChild(heal);
for (const [title, ids] of [
  ['识别结果', ['st-conf-mode', 'st-cast-enabled']],
  ['热词与专有名词', ['ah-terms-list', 'ah-score', 'an-use-translate']],
  ['纠错', ['st-correct-mode']]
]) {
  const group = document.createElement('section'); group.className = 'sf-settings-cluster';
  const heading = document.createElement('h3'); heading.className = 'sf-settings-group-title'; heading.textContent = t(title);
  group.appendChild(heading);
  ids.forEach(id => group.appendChild(cardOf(id))); enhance.appendChild(group);
}
function explain(card, summary, nodes) {
  if (!nodes.length) return;
  const details = document.createElement('details'); details.className = 'sf-settings-details';
  const label = document.createElement('summary'); label.textContent = t(summary); details.appendChild(label);
  nodes.forEach(node => details.appendChild(node)); card.appendChild(details);
}
for (const id of ['an-use-translate', 'ass-style-group']) {
  const card = id === 'ass-style-group' ? $(id) : cardOf(id);
  const notes = [...card.children].filter(el => el.tagName === 'P' && !el.id);
  explain(card, '工作方式与使用说明', notes);
}
const correctCard = cardOf('st-correct-mode');
explain(correctCard, '重识别范围与批量参数', [$('st-correct-pad').closest('.st-row')]);
const performanceCard = $('perf-start').closest('.st-section');
explain(performanceCard, '测试方法与硬件要求', [performanceCard.querySelector('.st-help')]);
// 老版 setting-name 只是 span；重排后补上可访问名称，键盘和读屏仍能辨认每个参数。
for (const group of [...styleGroups, $('ass-style-group'), $('ass-fx-group'), $('word-convert-group'), heal]) {
  group.querySelectorAll('.setting-row').forEach(row => {
    const label = row.querySelector('.setting-name')?.textContent.trim();
    if (!label) return;
    row.querySelectorAll('input,select').forEach(input => {
      if (!input.getAttribute('aria-label') && !input.labels?.length) input.setAttribute('aria-label', label);
    });
  });
}
for (const [id, label] of Object.entries({
  'st-conf-mode': '置信度模式', 'st-correct-mode': '自动纠错', 'ah-score': '热词强度',
  'st-correct-provider': '纠错服务商', 'st-correct-pad': '前后上下文秒数',
  'st-correct-max': '单段时长上限', 'st-correct-batch': '每批字幕行数',
})) $(id).setAttribute('aria-label', t(label));
document.querySelectorAll('#st-view .st-grid').forEach(grid => {
  let label = '';
  for (const child of grid.children) {
    if (child.classList.contains('st-lbl')) label = child.textContent.trim();
    else if (label && ['INPUT', 'SELECT', 'TEXTAREA'].includes(child.tagName) && !child.getAttribute('aria-label')) child.setAttribute('aria-label', label);
  }
});

const settingTabs = [...document.querySelectorAll('#st-view .st-tab')];
function settingPresentation(name) {
  $('st-test').hidden = true;
  /* 手动保存只属于「识别与校对」；按钮已在该面板底部，不再占用全局动作栏。 */
  $('st-save').hidden = name !== 'enhance';
  for (const tab of settingTabs) {
    tab.setAttribute('tabindex', tab.dataset.stp === name ? '0' : '-1');
    const panel = $('st-panel-' + tab.dataset.stp);
    panel.setAttribute('aria-labelledby', tab.id);
  }
}
settingTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.stp; settingPresentation(name);
    if (name !== 'translate' && !$('st-scheme-drawer').hidden) $('st-scheme-close').click();
    // 原二级入口仍管理服务商列表刷新，一级分类只委托给它。
    if (name === 'translate' || name === 'models') document.querySelector(`.st-subtab[data-stsub="${name === 'translate' ? 'llm' : 'asr'}"]`)?.click();
    $('st-view').scrollTop = 0;
  });
  tab.addEventListener('keydown', event => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!delta && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = settingTabs[event.key === 'Home' ? 0 : event.key === 'End' ? settingTabs.length - 1 : (index + delta + settingTabs.length) % settingTabs.length];
    next.click(); next.focus();
  });
});
$('st-entry-asr').addEventListener('click', () => document.querySelector('.st-tab[data-stp="models"]').click());
$('st-entry-llm').addEventListener('click', () => document.querySelector('.st-tab[data-stp="translate"]').click());
for (const id of ['btn-open-video', 'btn-open-sub']) $(id).addEventListener('click', () => {
  if (route === '#/settings') location.hash = '#/editor';
});
settingPresentation('theme');
function setting(name) {
  pendingSetting = name;
  if (location.hash === '#/settings') selectSetting(name); else location.hash = '#/settings';
}
function selectSetting(name) {
  document.querySelector(`.st-tab[data-stp="${name === 'llm' ? 'translate' : name}"]`)?.click();
  if (name === 'llm') $('st-entry-llm').click();
  pendingSetting = '';
}
document.querySelectorAll('[data-setting]').forEach(b => b.addEventListener('click', () => setting(b.dataset.setting)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.go; }));
// 自定义主页小组件：计数卡片只切筛选，动作卡片走现有入口，不复制业务逻辑。
// UWP 下先让磁贴整组飞出，再执行真实导航/弹窗；其余主题立即执行。
$('sf-widgets').addEventListener('click', (e) => {
  const w = e.target.closest('[data-widget],[data-widget-filter]');
  if (!w) return;
  uwpTileExit(() => {
    if (w.dataset.widgetFilter) {
      filter = w.dataset.widgetFilter;
      folder = '';
      if (location.hash === '#/home') refreshLibrary();
      else location.hash = '#/home';
      requestAnimationFrame(() => $('home-list')?.scrollIntoView({ block: 'start' }));
      return;
    }
    if (w.dataset.widget === 'new') { $('btn-new-project').click(); return; }
    if (w.dataset.widget === 'settings') { location.hash = '#/settings'; return; }
    if (w.dataset.widget === 'library') { goLibraryFilter('all'); return; }
    if (w.dataset.widget === 'resume') {
      const p = projects.find(p => p.id === prefs.recent && p.format) || projects.find(p => p.format);
      if (p) location.hash = '#/project/' + p.id; else $('btn-new-project').click();
    }
  });
});
// 真实快捷键目前固定；帮助页准确显示当前映射，不承诺不存在的自定义能力。
$('sf-shortcuts').addEventListener('click', () => {
  const box = $('sf-help').querySelector('.sf-help-grid article:nth-child(3)');
  if (box.querySelector('dl')) return;
  const dl = document.createElement('dl');
  const list = [['Space / K', '播放 / 暂停'], ['← / →', '前后跳转 2 秒'], ['Shift + ← / →', '前后跳转 5 秒'], [', / .', '逐帧移动'], ['Home / End', '开头 / 末尾'], ['= / − / 0', '放大 / 缩小 / 适应全片'], ['F', '跟随播放'], ['↑ / ↓（或 Alt + ↑ / ↓）', '上一条 / 下一条字幕'], ['Alt + P', '选中播放句'], ['Ctrl + Enter', '提交编辑'], ['Ctrl + F', '搜索字幕'], ['Ctrl + S', '导出字幕'], ['F8', '逐词 JSON 导出入口']];
  dl.innerHTML = list.map(([key, value]) => `<div><dt><kbd>${key}</kbd></dt><dd>${t(value)}</dd></div>`).join(''); box.appendChild(dl);
  if (document.body.dataset.design === 'material') animateMaterialPage(box, 'dl > div');
});

function folderSnapshotSignature() {
  return prefs.folders.map(f => f.id + ':' + projects.filter(p => prefs.assignments[p.id] === f.id).length).join('|');
}
function renderFolders() {
  $('sf-folders').innerHTML = prefs.folders.map(f => `<div class="sf-folder"><button type="button" class="${folder === f.id ? 'active' : ''}" data-folder="${f.id}">${ico('folder')}<span>${esc(f.name)}</span><small>${projects.filter(p => prefs.assignments[p.id] === f.id).length}</small></button><button type="button" data-remove-folder="${f.id}" aria-label="移除文件夹">×</button></div>`).join('');
  folderSnapshotSig = folderSnapshotSignature();
  animateMaterialPage($('sf-folders'));
}
/* 文件夹的新建/移除都用页面内 Dialog，不再调用浏览器 prompt()/confirm()。
   UWP 走 2px 直角 + 150ms，Material You 走 28px 圆角 + 大输入框。 */
const folderDialog = document.createElement('div');
folderDialog.id = 'sf-folder-dialog'; folderDialog.className = 'sf-folder-dialog'; folderDialog.hidden = true;
folderDialog.innerHTML = `<div class="sf-folder-box" role="dialog" aria-modal="true" aria-labelledby="sf-folder-title">
  <h3 id="sf-folder-title">新建文件夹</h3>
  <p class="sf-folder-desc" id="sf-folder-desc"></p>
  <label class="sf-folder-field">文件夹名称<input id="sf-folder-name" maxlength="60" autocomplete="off" spellcheck="false"></label>
  <small class="sf-folder-error" id="sf-folder-error" aria-live="polite"></small>
  <div class="sf-folder-actions"><button type="button" class="btn" data-folder-cancel>取消</button><button type="button" class="btn btn-accent" data-folder-ok>创建</button></div>
</div>`;
document.body.appendChild(folderDialog);
let folderDialogMode = 'create', folderDialogId = '', folderDialogTrigger = null, folderDialogCloseTimer = 0;
function setFolderDialogButtons(uwp) {
  folderDialog.querySelectorAll('button').forEach(button => {
    if (uwp) button.classList.add('uwp-tile'); else button.classList.remove('uwp-tile');
  });
}
/** 退场：先加 is-closing 播 120ms 淡出，动画结束再摘 hidden。
 *  减少动效/关闭动画时 CSS 把 animation-duration 算成 0s，这里随之直接收起，不留延迟。 */
function closeFolderDialog() {
  if (folderDialog.hidden) return;
  folderDialog.classList.add('is-closing');
  const duration = parseFloat(getComputedStyle(folderDialog).animationDuration) || 0;
  const finish = () => {
    clearTimeout(folderDialogCloseTimer); folderDialogCloseTimer = 0;
    folderDialog.hidden = true;
    folderDialog.classList.remove('is-closing');
    folderDialog.removeAttribute('data-mode');
    folderDialogTrigger?.focus?.();
    folderDialogTrigger = null;
  };
  if (!duration) { finish(); return; }
  clearTimeout(folderDialogCloseTimer);
  folderDialogCloseTimer = setTimeout(finish, duration * 1000 + 40);
}
function openFolderDialog(mode, id = '', trigger = null) {
  folderDialogMode = mode; folderDialogId = id; folderDialogTrigger = trigger || document.activeElement;
  /* 退场途中再次打开：撤掉 is-closing 让入场动画从头来过，并取消待隐藏的计时。 */
  clearTimeout(folderDialogCloseTimer); folderDialogCloseTimer = 0;
  folderDialog.classList.remove('is-closing');
  folderDialog.dataset.mode = mode; folderDialog.hidden = false;
  const title = folderDialog.querySelector('#sf-folder-title');
  const desc = folderDialog.querySelector('#sf-folder-desc');
  const input = folderDialog.querySelector('#sf-folder-name');
  const error = folderDialog.querySelector('#sf-folder-error');
  const ok = folderDialog.querySelector('[data-folder-ok]');
  if (mode === 'create') {
    title.textContent = t('新建文件夹');
    desc.textContent = t('文件夹只影响稿件库分组，不会移动磁盘文件。');
    input.value = ''; input.disabled = false; error.textContent = ''; ok.textContent = t('创建');
  } else {
    title.textContent = t('移除文件夹？');
    desc.textContent = t('稿件会回到全部稿件，文件不会删除。');
    input.value = ''; error.textContent = ''; ok.textContent = t('移除');
  }
  setFolderDialogButtons(document.body.dataset.design === 'uwp');
  requestAnimationFrame(() => {
    if (mode === 'create') input.focus();
    else ok.focus();
  });
}
function submitFolderDialog() {
  const input = folderDialog.querySelector('#sf-folder-name');
  const error = folderDialog.querySelector('#sf-folder-error');
  if (folderDialogMode === 'create') {
    const name = input.value.trim();
    if (!name) { error.textContent = t('请输入文件夹名称。'); input.focus(); return; }
    if (name.length > 60 || prefs.folders.length >= 40) { error.textContent = t('文件夹名称最多 60 字，最多 40 个文件夹。'); input.focus(); return; }
    if (prefs.folders.some(f => f.name === name)) { error.textContent = t('已经有同名文件夹。'); input.focus(); return; }
    if (!commit({ folders: [...prefs.folders, { id: 'f-' + crypto.randomUUID(), name }] })) { error.textContent = t('保存失败，浏览器存储空间可能不足。'); return; }
    renderFolders(); closeFolderDialog(); return;
  }
  if (commit({ folders: prefs.folders.filter(f => f.id !== folderDialogId) })) {
    if (folder === folderDialogId) folder = '';
    renderFolders(); refreshLibrary(); closeFolderDialog();
  }
}
folderDialog.addEventListener('click', e => {
  if (e.target === folderDialog || e.target.closest('[data-folder-cancel]')) closeFolderDialog();
  else if (e.target.closest('[data-folder-ok]')) submitFolderDialog();
});
folderDialog.querySelector('#sf-folder-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitFolderDialog(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFolderDialog(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !folderDialog.hidden) closeFolderDialog(); });
$('sf-folder-add').addEventListener('click', e => openFolderDialog('create', '', e.currentTarget));
$('sf-folders').addEventListener('click', e => {
  const f = e.target.closest('[data-folder]'), del = e.target.closest('[data-remove-folder]');
  if (f) { folder = f.dataset.folder; filter = 'all'; location.hash = '#/home'; renderFolders(); refreshLibrary(); if (document.body.dataset.design === 'material') animateMaterialPage($('home-view')); }
  if (del) openFolderDialog('remove', del.dataset.removeFolder, del);
});
$('sf-folders').addEventListener('dragover', e => { if (e.target.closest('[data-folder]')) e.preventDefault(); });
$('sf-folders').addEventListener('drop', e => {
  const f = e.target.closest('[data-folder]'); if (!f) return; e.preventDefault();
  const id = e.dataTransfer.getData('application/x-subfabric-project'); if (!projects.some(p => p.id === id)) return;
  if (commit({ assignments: { ...prefs.assignments, [id]: f.dataset.folder } })) { renderFolders(); refreshLibrary(); notice('稿件已移入文件夹。'); }
});
$('sf-nav').querySelector('[data-route="home"]').addEventListener('click', () => { folder = ''; filter = 'all'; renderFolders(); refreshLibrary(); if (document.body.dataset.design === 'material') animateMaterialPage($('home-view')); });
$('sf-filters').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) { filter = b.dataset.filter; refreshLibrary(); } });
$('sf-search').addEventListener('input', refreshLibrary);
/** 列表/卡片视图切换后，按“刚进入稿件库/文件夹”的同一套元素入场重播。
 *  只使用独立的 data-view-enter / is-view-switching，绝不挂 data-my-enter /
 *  data-uwp-enter；否则动画结束摘掉切换类时，旧入场选择器会重新接管并闪一下。 */
function animateLibraryViewChange() {
  const view = $('home-view');
  if (!view || view.hidden) return;
  const design = document.body.dataset.design;
  const list = view.querySelector('.home-list');
  const cards = [...view.querySelectorAll('.proj-card')]
    .filter(card => card.getClientRects().length)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
    });
  if (!cards.length) return;
  /* 连点切换：先彻底清掉上一轮，再强制一次布局，保证每轮都能重新起播。 */
  clearTimeout(view._viewSwitchTimer);
  view.classList.remove('is-view-switching');
  list?.classList.remove('anim-in');
  view.querySelectorAll('.proj-card').forEach(card => {
    card.removeAttribute('data-view-enter');
    card.removeAttribute('data-my-enter');
    card.removeAttribute('data-uwp-enter');
    card.style.removeProperty('--view-enter-delay');
    card.style.removeProperty('--my-enter-delay');
    card.style.removeProperty('--uwp-enter-delay');
  });
  void view.offsetWidth;
  /* 保留 Material 页面的 is-my-page-entering，让 refreshLibrary 的自动补动画不再触发。 */
  if (design === 'material') view.classList.add('is-my-page-entering');
  /* Classic 与 UWP 同为 24ms 步长、但落定更慢（340ms）；Material 仍是 45ms / 420ms。 */
  const step = design === 'classic' || design === 'uwp' ? 24 : 45;
  cards.forEach((card, i) => {
    card.setAttribute('data-view-enter', '');
    card.style.setProperty('--view-enter-delay', (i * step) + 'ms');
  });
  view.classList.add('is-view-switching');
  const maxDelay = (cards.length - 1) * step;
  const duration = design === 'uwp' ? 180 : design === 'classic' ? 340 : 420;
  view._viewSwitchTimer = setTimeout(() => {
    view.classList.remove('is-view-switching');
    view.querySelectorAll('.proj-card[data-view-enter]').forEach(card => {
      card.removeAttribute('data-view-enter');
      card.style.removeProperty('--view-enter-delay');
    });
  }, duration + maxDelay + 80);
}
$('sf-list-mode').addEventListener('click', () => {
  if (commit({ view: prefs.view === 'grid' ? 'list' : 'grid' })) {
    refreshLibrary();
    animateLibraryViewChange();
  }
});
$('sf-clear-filter').addEventListener('click', () => { filter = 'all'; folder = ''; $('sf-search').value = ''; renderFolders(); refreshLibrary(); });
/** 自定义主页：按项目真实阶段渲染小组件；UWP 下 CSS 会转成磁贴。
 *  ⚠ 只在第一次建节点；之后**只改文字**。整块 innerHTML 重建会在
 *  `#dashboard-view.is-entering` 的错峰入场还没播完时换掉所有磁贴，新节点会把
 *  动画从头再播一遍 —— 用户看到的就是「动画播完过一会又刷新一下」。
 *  进入主页后项目快照还会异步到一次，这条路径必须保持幂等。 */
function setWidgetText(root, selector, value) {
  const node = root.querySelector(selector);
  if (!node) return;
  const text = String(value);
  if (node.textContent !== text) node.textContent = text;
}
function renderWidgets() {
  const el = $('sf-widgets');
  if (!el) return;
  const count = phase => projects.filter(p => projectPhase(p) === phase).length;
  const recent = projects.find(p => p.id === prefs.recent && p.format) || projects.find(p => p.format);
  const active = count('active'), ready = count('ready'), attention = count('attention');
  const all = projects.length;
  const recentMeta = recent
    ? `${String(recent.format).toUpperCase()}${recent.subName ? ' · ' + recent.subName : ''}`
    : t('从视频或字幕开始');
  if (!el.querySelector('.sf-widget')) {
    el.innerHTML = `
    <button type="button" class="sf-widget sf-widget-wide sf-widget-resume uwp-tile" data-widget="resume" data-tone="accent">
      <span class="sf-widget-kicker">YOUR NEXT STORY</span>
      <strong class="sf-widget-title">${esc(recent?.name || t('开始新的创作'))}</strong>
      <small>${esc(recentMeta)}</small>
      <span class="sf-widget-cta"><span class="sf-widget-cta-label">${t(recent ? '继续编辑' : '新建稿件')}</span> <b aria-hidden="true">→</b></span>
      <span class="sf-widget-wm" aria-hidden="true">${ico('play')}</span>
    </button>
    <button type="button" class="sf-widget uwp-tile" data-widget-filter="active">
      <span class="sf-widget-kicker">IN PROGRESS</span>
      <span class="sf-widget-ico" aria-hidden="true">${ico('activity')}</span>
      <strong class="sf-widget-num">${active}</strong>
      <span class="sf-widget-label">${t('处理中')}</span>
      <small>${t('正在识别 / 翻译')}</small>
    </button>
    <button type="button" class="sf-widget uwp-tile" data-widget-filter="ready">
      <span class="sf-widget-kicker">READY</span>
      <span class="sf-widget-ico" aria-hidden="true">${ico('check')}</span>
      <strong class="sf-widget-num">${ready}</strong>
      <span class="sf-widget-label">${t('可编辑')}</span>
      <small>${t('已经可以改字幕')}</small>
    </button>
    <button type="button" class="sf-widget uwp-tile" data-widget-filter="attention" data-tone="warn">
      <span class="sf-widget-kicker">ATTENTION</span>
      <span class="sf-widget-ico" aria-hidden="true">${ico('alert')}</span>
      <strong class="sf-widget-num">${attention}</strong>
      <span class="sf-widget-label">${t('需处理')}</span>
      <small>${t('失败 / 待重试')}</small>
    </button>
    <button type="button" class="sf-widget uwp-tile" data-widget-filter="all">
      <span class="sf-widget-kicker">ALL</span>
      <span class="sf-widget-ico" aria-hidden="true">${ico('folder')}</span>
      <strong class="sf-widget-num">${all}</strong>
      <span class="sf-widget-label">${t('全部稿件')}</span>
      <small>${t('本地工作空间')}</small>
    </button>
    <button type="button" class="sf-widget sf-widget-wide uwp-tile" data-widget="new" data-tone="accent">
      <span class="sf-widget-plus" aria-hidden="true">${ico('plus')}</span>
      <span class="sf-widget-text">
        <span class="sf-widget-kicker">NEW</span>
        <strong class="sf-widget-title">${t('新建稿件')}</strong>
        <small>${t('视频、链接或字幕')}</small>
      </span>
      <span class="sf-widget-arrow" aria-hidden="true">→</span>
    </button>
    <button type="button" class="sf-widget uwp-tile" data-widget="settings">
      <span class="sf-widget-ico" aria-hidden="true">${ico('sliders')}</span>
      <span class="sf-widget-kicker">SETTINGS</span>
      <strong class="sf-widget-title">${t('全局设置')}</strong>
      <small>${t('模型、翻译与外观')}</small>
    </button>
    <button type="button" class="sf-widget sf-widget-library uwp-tile" data-widget="library">
      <span class="sf-widget-ico" aria-hidden="true">${ico('folder')}</span>
      <span class="sf-widget-kicker">BROWSE</span>
      <strong class="sf-widget-title">${t('稿件库')}</strong>
      <small>${all} ${t('个项目')}</small>
    </button>`;
    return;
  }
  setWidgetText(el, '[data-widget="resume"] .sf-widget-title', recent?.name || t('开始新的创作'));
  setWidgetText(el, '[data-widget="resume"] small', recentMeta);
  setWidgetText(el, '[data-widget="resume"] .sf-widget-cta-label', t(recent ? '继续编辑' : '新建稿件'));
  setWidgetText(el, '[data-widget-filter="active"] .sf-widget-num', active);
  setWidgetText(el, '[data-widget-filter="ready"] .sf-widget-num', ready);
  setWidgetText(el, '[data-widget-filter="attention"] .sf-widget-num', attention);
  setWidgetText(el, '[data-widget-filter="all"] .sf-widget-num', all);
  setWidgetText(el, '[data-widget="library"] small', all + ' ' + t('个项目'));
}

/** Material You 主页：复刻旧版稿件库的三段式 hero；只在 material-you 主题启用。 */
function isMaterialHome() { return document.body.dataset.themePack === 'material-you'; }
function muCounts() {
  const counts = { all: projects.length, active: 0, ready: 0, attention: 0 };
  for (const p of projects) {
    const phase = projectPhase(p);
    if (Object.prototype.hasOwnProperty.call(counts, phase)) counts[phase]++;
  }
  return counts;
}
function updateMuClock() {
  const now = new Date();
  const date = $('sf-mu-date');
  if (date) date.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  const hourHand = $('sf-mu-clock-hour'), minuteHand = $('sf-mu-clock-minute'), secondHand = $('sf-mu-clock-second'), flowerFace = $('sf-mu-flower-face');
  const hourDeg = ((now.getHours() % 12) + now.getMinutes() / 60) * 30;
  const minuteDeg = now.getMinutes() * 6;
  const secondDeg = now.getSeconds() * 6;
  if (hourHand) hourHand.setAttribute('transform', `rotate(${hourDeg} 50 50)`);
  if (minuteHand) minuteHand.setAttribute('transform', `rotate(${minuteDeg} 50 50)`);
  if (secondHand) secondHand.setAttribute('transform', `rotate(${secondDeg} 50 50)`);
  if (flowerFace) flowerFace.setAttribute('transform', `rotate(${secondDeg} 50 50)`);
}
function fmtMuDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '—';
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function muDeviceOf(project) {
  const engine = String(project?.draft?.engine || '').toLowerCase();
  const model = String(project?.draft?.modelId || '').toLowerCase();
  if (!engine) return '—';
  if (engine === 'dual') return 'NPU+GPU';
  if (engine === 'openvino' || model.includes('npu')) return 'NPU';
  if (engine === 'bcut' || engine === 'capcut' || engine.includes('cloud')) return '云端';
  return 'GPU';
}
function renderMuProcessing() {
  const latest = projects.find(p => projectPhase(p) === 'active') || projects.find(p => p.draft) || projects[0] || null;
  const active = !!latest && projectPhase(latest) === 'active';
  const draftStatus = latest?.draft?.status || '';
  const done = !!latest && (!!latest.format || draftStatus === 'done' || draftStatus === 'ready');
  let progress = Number(latest?.draft?.progress) || 0;
  if (done) progress = 100;
  else if (active && latest?.prepare?.status === 'running' && progress < 5) progress = 5;
  progress = Math.max(0, Math.min(100, Math.round(progress)));
  const name = $('sf-mu-processing-name'), kicker = $('sf-mu-processing-kicker'), fill = $('sf-mu-processing-fill'), pct = $('sf-mu-processing-pct');
  const card = $('sf-mu-processing');
  if (name) name.textContent = latest?.name || '还没有处理中的稿件';
  if (kicker) kicker.textContent = !latest ? '处理中' : active ? '处理中' : done ? '已完成' : draftStatus === 'error' ? '处理中断' : '最近处理';
  if (fill) fill.style.width = progress + '%';
  if (pct) pct.textContent = progress + '%';
  if (card) {
    card.dataset.processing = latest?.id || '';
    /* 需要重试（识别/提取失败）→ 进度条转红，和列表卡片 .pc-draft.error 一致。 */
    card.classList.toggle('is-error', !!latest && (draftStatus === 'error' || latest?.prepare?.status === 'error'));
  }
  const dur = Number(latest?.prepare?.duration || latest?.source?.duration || latest?.duration || 0);
  const durEl = $('sf-mu-processing-duration'), devEl = $('sf-mu-processing-device');
  if (durEl) durEl.textContent = fmtMuDuration(dur);
  if (devEl) devEl.textContent = muDeviceOf(latest);
}
function renderMaterialHome() {
  const root = $('sf-mu-home');
  if (!root || root.hidden) return;
  updateMuClock();
  const counts = muCounts();
  const current = projects.find(p => p.id === prefs.recent) || null;
  const write = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
  write('sf-mu-status-num', counts.ready);
  renderMuProcessing();
  write('sf-mu-ready-widget', counts.ready);
  write('sf-mu-attention-count', counts.attention);
  const attentionProject = projects.find(p => projectPhase(p) === 'attention') || null;
  const attentionCard = $('sf-mu-attention');
  if (attentionCard) attentionCard.dataset.projectId = attentionProject?.id || '';
  write('sf-mu-all-count', counts.all);
  write('sf-mu-resume-eyebrow', current ? '当前正在编辑' : '开始新的创作');
  write('sf-mu-next-title', current?.name || '还没有正在编辑的稿件');
  write('sf-mu-next-meta', current
    ? `${String(current.format || 'ASS').toUpperCase()}${current.subName ? ' · ' + current.subName : ''}`
    : '从视频或字幕开始');
  write('sf-mu-resume-cta', current ? '继续编辑 →' : '新建稿件 →');
  const resume = $('sf-mu-resume');
  if (resume) resume.dataset.projectId = current?.id || '';

}
const uwpReduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
/* 系统减少动效或界面偏好 data-motion=off 都必须停掉 JS 3D/整页退场；
   放在页面入场函数之前，模块初始化时 syncDashboardMode() 就能安全调用。 */
const uwpMotionOff = () => uwpReduceMotion.matches || document.body.dataset.motion === 'off';
let dashboardEnterTimer = 0;
let libraryEnterTimer = 0;
/* UWP 页面入场：页面整体 .92→1 淡入；元素按可视位置“下→上、右→左”依次
   scale(.94→1)+淡入。所有 UWP 页面共用同一套 keyframes/easing，和主页 Tab 一致。 */
const SETTINGS_ENTER_ITEMS = '.st-card, .st-scheme, .sf-asr-family, .sm-model, .st-entry, .sf-prerequisite, .ws-panel, .st-hw, .st-subhead, .sf-scheme-empty';
const UWP_ENTER_ITEM_SELECTORS = {
  'dashboard-view': '#sf-widgets > .sf-widget',
  'home-view': '.home-list > .proj-card',
  'np-view': ':scope > .page-intro, .ws-grid .ws-panel',
  'detail-view': ':scope > .page-intro, .ws-grid > .ws-panel',
  'sf-help': '.sf-page-content > .sf-eyebrow, .sf-page-content > h1, .sf-page-content > p, .sf-help-grid > article, .sf-help-grid article dl > div'
};
function uwpSettingsItems(panel) {
  const visible = el => el.getClientRects().length > 0;
  const content = [...panel.querySelectorAll(SETTINGS_ENTER_ITEMS)].filter(visible);
  const heading = [...panel.querySelectorAll(':scope > .sf-settings-heading')].filter(visible);
  /* 性能页没有 .st-card/.st-scheme，只有标题和两个 .st-section；
     标题始终补入，内容为空时再把 section 拉进来，避免 heading 被漏掉。 */
  if (!content.length) {
    return [...heading, ...panel.querySelectorAll(':scope > .st-section')].filter(visible);
  }
  return [...content, ...heading];
}
function uwpEnterCandidates(root) {
  if (!root) return [];
  if (root.classList?.contains('st-panel')) return uwpSettingsItems(root);
  if (root.id === 'st-view') {
    const panel = [...root.querySelectorAll('.st-panel:not([hidden])')][0];
    return panel ? uwpSettingsItems(panel) : [];
  }
  const selector = UWP_ENTER_ITEM_SELECTORS[root.id];
  return selector ? [...root.querySelectorAll(selector)] : [];
}
function uwpOrderByGeometry(items) {
  const entries = items.map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0);
  return entries.sort((a, b) =>
    Math.abs(a.r.bottom - b.r.bottom) > 8 ? b.r.bottom - a.r.bottom : b.r.right - a.r.right
  ).map(({ el }) => el);
}
function animateUwpPage(root, itemsOnly = false) {
  if (document.body.dataset.design !== 'uwp' || !root || root.hidden || uwpMotionOff()) return;
  let items = uwpEnterCandidates(root).filter(el => el.getClientRects().length);
  /* 页面刚显示时卡片可能还没渲染完；不要先占用节流时间片，否则后面补渲染不会动。 */
  if (!items.length && !itemsOnly) return;
  const now = performance.now();
  /* 同一批 DOM 的重复调用要节流；但项目数据刷新会换掉卡片节点，新节点没有
     data-uwp-enter，必须允许立即补一次动画，否则首屏/刷新后元素静止。 */
  if (!itemsOnly && root._uwpEnterAt && now - root._uwpEnterAt < 80
    && items.every(el => el.hasAttribute('data-uwp-enter'))) return;
  if (!itemsOnly) root._uwpEnterAt = now;
  root.querySelectorAll('[data-uwp-enter]').forEach(el => {
    if (!items.includes(el)) { el.removeAttribute('data-uwp-enter'); el.style.removeProperty('--uwp-enter-delay'); }
  });
  items.forEach(el => el.setAttribute('data-uwp-enter', ''));
  uwpOrderByGeometry(items).forEach((el, i) => {
    el.style.setProperty('--uwp-enter-delay', (i * 24) + 'ms');
  });
  const cls = itemsOnly ? 'is-uwp-items-entering' : 'is-uwp-page-entering';
  root.classList.remove(cls);
  void root.offsetWidth;
  root.classList.add(cls);
  /* 面板类只用于本次重播；动画结束后摘掉，避免 3991 的 :not() 永久失效、
     也避免 next 次切回时依赖残留类。页面类保留，用来压住 .workspace-page 基础动画。 */
  if (itemsOnly) {
    clearTimeout(root._uwpItemsTimer);
    const maxDelay = Math.max(0, (items.length - 1) * 24);
    root._uwpItemsTimer = setTimeout(() => {
      root.classList.remove(cls);
      root._uwpItemsTimer = 0;
    }, 180 + maxDelay + 100);
  }
}
/* Material You 页面卡片：与主页同一套 .42s 上浮，按可视位置 top→bottom、left→right
   依次错峰；只作用于稿件库/文件夹/设置/帮助，不接管主页本身。 */
const MY_SETTINGS_ITEMS = '.st-card, .st-scheme, .sf-asr-family, .sm-model, .st-entry, .sf-prerequisite, .sf-settings-heading';
const MY_ENTER_ITEMS = {
  'home-view': '.home-list > .proj-card',
  'st-view': `.st-panel:not([hidden]) :is(${MY_SETTINGS_ITEMS})`,
  'sf-help': '.sf-help-grid > article',
  'sf-folders': '.sf-folder'
};
function animateMaterialPage(root, selector = '', force = false) {
  if (document.body.dataset.design !== 'material' || !root || root.hidden || uwpMotionOff()) return;
  const sel = selector || (root.classList?.contains('st-panel') ? MY_SETTINGS_ITEMS : MY_ENTER_ITEMS[root.id]);
  if (!sel) return;
  const items = [...root.querySelectorAll(sel)].filter(el => el.getClientRects().length);
  if (!items.length) return;
  const now = performance.now();
  if (!force && root._myEnterAt && now - root._myEnterAt < 80
    && items.every(el => el.hasAttribute('data-my-enter'))) return;
  root._myEnterAt = now;
  root.querySelectorAll('[data-my-enter]').forEach(el => {
    if (!items.includes(el)) { el.removeAttribute('data-my-enter'); el.style.removeProperty('--my-enter-delay'); }
  });
  items.forEach(el => el.setAttribute('data-my-enter', ''));
  const ordered = items.map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0)
    .sort((a, b) => Math.abs(a.r.top - b.r.top) > 8 ? a.r.top - b.r.top : a.r.left - b.r.left);
  ordered.forEach(({ el }, i) => el.style.setProperty('--my-enter-delay', (i * 45) + 'ms'));
  root.classList.remove('is-my-page-entering');
  void root.offsetWidth;
  root.classList.add('is-my-page-entering');
}
let uwpEditorPending = false;
let uwpEditorTimer = 0;
let uwpCueTimer = 0;
let materialEditorPending = false;
let materialEditorTimer = 0;
let materialCueTimer = 0;
function animateMaterialEditorShell() {
  if (document.body.dataset.design !== 'material' || uwpMotionOff()) return;
  const app = $('app');
  if (!app) return;
  app.classList.remove('is-material-editor-entering');
  void app.offsetWidth;
  app.classList.add('is-material-editor-entering');
  clearTimeout(materialEditorTimer);
  materialEditorTimer = setTimeout(() => app.classList.remove('is-material-editor-entering'), 420);
}
let materialCueSeen = new Set();
let materialCueRaf = 0;
/** 只给真正进入视口的卡片播放入场；预渲染/overscan 的卡片等滚到眼前再播。 */
function animateMaterialCueList(added = null, retry = true) {
  if (document.body.dataset.design !== 'material') return false;
  if (uwpMotionOff()) { materialEditorPending = false; return false; }
  const list = $('cue-list');
  if (!list) return false;
  const all = [...list.querySelectorAll('.cue-card')];
  const wanted = Array.isArray(added) ? new Set(added.map(Number)) : null;
  const pool = wanted ? all.filter(card => wanted.has(Number(card.dataset.idx))) : all;
  if (!pool.length) return false;

  const run = () => {
    const lr = list.getBoundingClientRect();
    const visible = pool
      .filter(card => {
        const key = `${location.hash}|${card.dataset.idx}`;
        if (materialCueSeen.has(key)) return false;
        const r = card.getBoundingClientRect();
        return r.height > 0 && r.bottom > lr.top + 8 && r.top < lr.bottom - 8;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (!visible.length) return;
    visible.forEach((card, i) => {
      const key = `${location.hash}|${card.dataset.idx}`;
      materialCueSeen.add(key);
      /* 重新赋属性，确保虚拟列表复用同一 DOM 节点换了新下标时也会重新起播。 */
      card.removeAttribute('data-my-cue');
      void card.offsetWidth;
      card.setAttribute('data-my-cue', '');
      card.style.setProperty('--my-cue-delay', (i * 22) + 'ms');
    });
    if (!list.classList.contains('is-my-cue-entering')) list.classList.add('is-my-cue-entering');
    materialEditorPending = false;
    clearTimeout(materialCueTimer);
    materialCueTimer = setTimeout(() => {
      list.classList.remove('is-my-cue-entering');
      list.querySelectorAll('.cue-card[data-my-cue]').forEach(card => {
        card.removeAttribute('data-my-cue');
        card.style.removeProperty('--my-cue-delay');
      });
    }, 420 + Math.max(0, visible.length - 1) * 22 + 120);
  };
  run();
  /* 路由刚切换时列表可能还没布局，下一帧再按真实视口补一次（只补一次，避免递归空转）。 */
  if (retry && !materialCueRaf) materialCueRaf = requestAnimationFrame(() => {
    materialCueRaf = 0;
    if (document.body.dataset.design === 'material') animateMaterialCueList(added, false);
  });
  return true;
}

function animateUwpEditorShell() {
  if (document.body.dataset.design !== 'uwp' || uwpMotionOff()) return;
  const app = $('app');
  if (!app) return;
  app.classList.remove('is-uwp-editor-entering');
  void app.offsetWidth;
  app.classList.add('is-uwp-editor-entering');
  clearTimeout(uwpEditorTimer);
  uwpEditorTimer = setTimeout(() => app.classList.remove('is-uwp-editor-entering'), 420);
}

/* 编辑器三大板块的入场：视频区 → 右侧列表 → 时间轴（CSS 里 0/90/180ms 错峰）。
 * 三个主题共用同一套淡入上浮，只跟主题的 `--sf-card-duration` 变快慢。
 * 只在**进入编辑器或切换稿件**时播一次；同一路由的重复 applyHash、项目数据刷新不重播。 */
let editorPanelsTimer = 0;
function animateEditorPanels() {
  const app = $('app');
  if (!app || uwpMotionOff()) return;
  app.classList.remove('is-editor-panels-entering');
  void app.offsetWidth;                 // 强制回流，确保连续两次进入都能重新起播
  app.classList.add('is-editor-panels-entering');
  clearTimeout(editorPanelsTimer);
  editorPanelsTimer = setTimeout(() => app.classList.remove('is-editor-panels-entering'), 900);
  /* 通知时间轴：面板淡入结束后再把字幕块从左到右逐个浮出来（canvas 里没有 CSS 动画）。
   * 刷新时时间轴还没构造，它会通过 #app 上的入场类自行补一次。 */
  try { if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('sf-editor-panels-enter')); } catch {}
}
function clearEditorPanelsEntrance() {
  clearTimeout(editorPanelsTimer);
  editorPanelsTimer = 0;
  $('app')?.classList.remove('is-editor-panels-entering');
}
function animateUwpCueList(added = null) {
  if (document.body.dataset.design !== 'uwp') return false;
  if (uwpMotionOff()) { uwpEditorPending = false; return false; }
  const list = $('cue-list');
  if (!list) return false;
  const all = [...list.querySelectorAll('.cue-card')];
  const wanted = Array.isArray(added) ? new Set(added.map(Number)) : null;
  const cards = wanted ? all.filter(card => wanted.has(Number(card.dataset.idx))) : all;
  if (!cards.length) return false;
  /* 只保留本批卡片的入场标记；上一批已播完的卡片不能因为 class 重加而重播。 */
  list.querySelectorAll('.cue-card[data-uwp-cue]').forEach(card => {
    if (!cards.includes(card)) {
      card.removeAttribute('data-uwp-cue');
      card.style.removeProperty('--uwp-cue-delay');
    }
  });
  cards.forEach((card, i) => {
    card.setAttribute('data-uwp-cue', '');
    card.style.setProperty('--uwp-cue-delay', (i * 8) + 'ms');
  });
  list.classList.remove('is-uwp-cue-entering');
  void list.offsetWidth;
  list.classList.add('is-uwp-cue-entering');
  uwpEditorPending = false;
  clearTimeout(uwpCueTimer);
  uwpCueTimer = setTimeout(() => {
    list.classList.remove('is-uwp-cue-entering');
    cards.forEach(card => {
      card.removeAttribute('data-uwp-cue');
      card.style.removeProperty('--uwp-cue-delay');
    });
  }, 120 + Math.max(0, cards.length - 1) * 8 + 100);
  return true;
}
$('cue-list')?.addEventListener('sf-cue-rendered', e => {
  if (document.body.dataset.workspace !== 'editor') return;
  const added = e.detail?.added;
  if (document.body.dataset.design === 'uwp') {
    if (Array.isArray(added) && added.length) animateUwpCueList(added);
    else if (uwpEditorPending) animateUwpCueList();
  } else if (document.body.dataset.design === 'material') {
    /* 只在进入编辑器时播放入场；之后虚拟列表/下拉滚动不再补动画。 */
    if (materialEditorPending) animateMaterialCueList(added);
  }
});
function animateDashboardCards() {
  const view = $('dashboard-view');
  if (!view || view.hidden) return;
  if (document.body.dataset.design === 'uwp') {
    view.classList.remove('is-entering');
    clearTimeout(dashboardEnterTimer);
    animateUwpPage(view);
    return;
  }
  view.classList.remove('is-entering');
  void view.offsetWidth;
  view.classList.add('is-entering');
  clearTimeout(dashboardEnterTimer);
  dashboardEnterTimer = setTimeout(() => view.classList.remove('is-entering'), 1100);
}
function animateLibraryCards() {
  const view = $('home-view');
  if (!view || view.hidden) return;
  if (document.body.dataset.design === 'uwp') {
    view.classList.remove('is-entering');
    clearTimeout(libraryEnterTimer);
    animateUwpPage(view);
    return;
  }
  if (document.body.dataset.design === 'material') {
    view.classList.remove('is-entering');
    clearTimeout(libraryEnterTimer);
    animateMaterialPage(view);
    return;
  }
  view.classList.remove('is-entering');
  void view.offsetWidth;
  view.classList.add('is-entering');
  clearTimeout(libraryEnterTimer);
  libraryEnterTimer = setTimeout(() => view.classList.remove('is-entering'), 1100);
}
window.addEventListener('sf-settings-panel-shown', e => {
  if (document.body.dataset.design === 'uwp') animateUwpPage(e.detail?.panel, true);
  else if (document.body.dataset.design === 'material') animateMaterialPage(e.detail?.panel);
});
let dashboardHomeMode = '';
function syncDashboardMode(replay = false) {
  const dashboard = $('dashboard-view'), material = $('sf-mu-home'), widgets = $('sf-widgets');
  if (!dashboard || !material || !widgets) return;
  const on = isMaterialHome();
  const mode = on ? 'material' : 'widgets';
  /* 只有模式真的切换（Material 主页 ↔ 磁贴）或主题切换才重播入场。
     项目快照刷新也走这里，每次都重播就是「动画播完过一会又刷新一下」。 */
  const modeChanged = !!dashboardHomeMode && dashboardHomeMode !== mode;
  dashboardHomeMode = mode;
  dashboard.dataset.homeMode = mode;
  material.hidden = !on;
  widgets.hidden = on;
  if (on) renderMaterialHome();
  if (!dashboard.hidden && (modeChanged || replay)) animateDashboardCards();
}
function goLibraryFilter(nextFilter, clearSearch = true) {
  filter = nextFilter;
  folder = '';
  if (clearSearch && $('sf-search')) $('sf-search').value = '';
  if (location.hash === '#/home') refreshLibrary(); else location.hash = '#/home';
  requestAnimationFrame(() => $('home-list')?.scrollIntoView({ block: 'start' }));
}
$('sf-mu-new').addEventListener('click', () => $('btn-new-project').click());
$('sf-mu-temp').addEventListener('click', () => goLibraryFilter('ready'));
$('sf-mu-resume').addEventListener('click', () => {
  const id = $('sf-mu-resume').dataset.projectId;
  if (id) location.hash = '#/project/' + encodeURIComponent(id); else $('btn-new-project').click();
});
$('sf-mu-widgets').addEventListener('click', (e) => {
  const attentionAction = e.target.closest('[data-mu-attn]');
  if (attentionAction) {
    if (attentionAction.dataset.muAttn === 'resume') {
      const id = $('sf-mu-attention')?.dataset.projectId;
      if (id) location.hash = '#/project/' + encodeURIComponent(id);
      else goLibraryFilter('attention');
    } else if (attentionAction.dataset.muAttn === 'details') {
      goLibraryFilter('attention');
    }
    return;
  }
  const processing = e.target.closest('#sf-mu-processing');
  if (processing) {
    const id = processing.dataset.processing;
    if (id) {
      /* 处理中 → 详情页看进度；跑完 → 编辑器。 */
      const p = projects.find(x => x.id === id);
      const active = !!p && projectPhase(p) === 'active';
      location.hash = (active ? '#/details/' : '#/project/') + encodeURIComponent(id);
    } else goLibraryFilter('active');
    return;
  }
  const b = e.target.closest('[data-mu-filter],[data-mu-action]');
  if (!b) return;
  if (b.dataset.muFilter) { goLibraryFilter(b.dataset.muFilter); return; }
  if (b.dataset.muAction === 'new') { $('btn-new-project').click(); return; }
  if (b.dataset.muAction === 'settings') { location.hash = '#/settings'; }
});
window.addEventListener('sf-studio-theme', () => syncDashboardMode(true));
const muClockTimer = setInterval(updateMuClock, 1000);
if (muClockTimer && typeof muClockTimer.unref === 'function') muClockTimer.unref();
updateMuClock();
syncDashboardMode();
// Replay the card stagger whenever the dashboard page becomes visible again.
const dashboardViewEl = $('dashboard-view');
if (dashboardViewEl) {
  if (typeof MutationObserver === 'function') {
    let dashboardWasHidden = dashboardViewEl.hidden;
    new MutationObserver(() => {
      const hidden = dashboardViewEl.hidden;
      if (dashboardWasHidden && !hidden) animateDashboardCards();
      dashboardWasHidden = hidden;
    }).observe(dashboardViewEl, { attributes: true, attributeFilter: ['hidden'] });
  }
  if (!dashboardViewEl.hidden) animateDashboardCards();
}
const libraryViewEl = $('home-view');
if (libraryViewEl) {
  if (typeof MutationObserver === 'function') {
    let libraryWasHidden = libraryViewEl.hidden;
    new MutationObserver(() => {
      const hidden = libraryViewEl.hidden;
      if (libraryWasHidden && !hidden) animateLibraryCards();
      libraryWasHidden = hidden;
    }).observe(libraryViewEl, { attributes: true, attributeFilter: ['hidden'] });
  }
  if (!libraryViewEl.hidden) animateLibraryCards();
}

/* UWP 磁贴：鼠标靠近（不必在卡片内）时，卡片与相邻卡片边框逐渐点亮。 */
let uwpGlowFrame = 0;
let uwpGlowPoint = null;
function uwpGlowCards() {
  return [...document.querySelectorAll('.home-list > .proj-card, .sf-widgets > .sf-widget')]
    .filter(el => typeof el.getBoundingClientRect === 'function');
}
function setUwpGlow(el, glow, edge, face, mx, my, faceR) {
  if (!el?.style) return;
  el.style.setProperty('--uwp-glow', glow.toFixed(3));
  el.style.setProperty('--uwp-edge', edge.toFixed(3));
  if (face !== undefined) el.style.setProperty('--uwp-face', face ? '1' : '0');
  if (mx !== undefined) el.style.setProperty('--uwp-mx', mx + '%');
  if (my !== undefined) el.style.setProperty('--uwp-my', my + '%');
  if (faceR !== undefined) el.style.setProperty('--uwp-face-r', faceR + 'px');
}
function resetUwpGlow() {
  uwpGlowPoint = null;
  if (uwpGlowFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(uwpGlowFrame);
  uwpGlowFrame = 0;
  for (const el of uwpGlowCards()) setUwpGlow(el, 0, 0, 0);
  resetUwpTileHover();
}
function updateUwpGlow() {
  uwpGlowFrame = 0;
  if (document.body.dataset.design !== 'uwp' || !uwpGlowPoint) return;
  const px = uwpGlowPoint.x, py = uwpGlowPoint.y;
  const radius = 46;
  const cards = uwpGlowCards();
  const rects = new Map();
  let activeEl = null;
  for (const el of cards) {
    const r = el.getBoundingClientRect();
    rects.set(el, r);
    if (r.width <= 0 || r.height <= 0) { setUwpGlow(el, 0, 0, 0); continue; }
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    const dist = Math.hypot(dx, dy);
    let glow = 0, edge = 0;
    if (dist < 0.5) {
      glow = 1; edge = 1; activeEl = el;
      setUwpGlow(el, 1, 1, 1,
        ((px - r.left) / r.width * 100).toFixed(1),
        ((py - r.top) / r.height * 100).toFixed(1),
        (Math.min(r.width, r.height) * 1.2).toFixed(1));
    }
    else if (dist < radius) {
      const t = 1 - dist / radius;
      glow = t * t * 0.32;
      edge = t * 0.55;
      setUwpGlow(el, glow, edge, 0);
    } else setUwpGlow(el, 0, 0, 0);
  }
  if (!activeEl) return;
  // 指针在卡片内部时，紧邻的上下左右卡片边框也略微发亮。
  const active = rects.get(activeEl);
  for (const el of cards) {
    if (el === activeEl) continue;
    const r = rects.get(el);
    if (!r || r.width <= 0 || r.height <= 0) continue;
    const gapX = Math.max(0, active.left - r.right, r.left - active.right);
    const gapY = Math.max(0, active.top - r.bottom, r.top - active.bottom);
    if (Math.max(gapX, gapY) > 8) continue;
    const glow = parseFloat(el.style.getPropertyValue('--uwp-glow')) || 0;
    const edge = parseFloat(el.style.getPropertyValue('--uwp-edge')) || 0;
    setUwpGlow(el, Math.max(glow, 0.10), Math.max(edge, 0.34), 0);
  }
}
function scheduleUwpGlow(e) {
  if (document.body.dataset.design !== 'uwp') return;
  uwpGlowPoint = { x: e.clientX, y: e.clientY };
  if (uwpGlowFrame) return;
  if (typeof requestAnimationFrame === 'function') uwpGlowFrame = requestAnimationFrame(updateUwpGlow);
  else updateUwpGlow();
}
document.addEventListener('pointermove', scheduleUwpGlow, { passive: true });
document.addEventListener('pointerleave', resetUwpGlow);
document.addEventListener('scroll', resetUwpGlow, true);
window.addEventListener('blur', resetUwpGlow);
window.addEventListener('sf-studio-theme', resetUwpGlow);

/* ── UWP 磁贴化：所有 button/.btn 共用 Reveal 面光与 3D 按压 ─────────── */
function syncUwpTiles() {
  if (document.body.dataset.design !== 'uwp') return;
  // 欢迎页 CUDA / Vulkan 选择卡是 label 不是 button；显式纳入磁贴，保持和
  // 工作台 .sf-widget 同一套 Reveal 面光/边缘，而不是另做一套圆角卡。
  document.querySelectorAll('button, .btn, [role=button], .welcome-card').forEach(el => el.classList.add('uwp-tile'));
}
/* UWP range 轨道用 accent 填到当前值；原生 range 没有 CSS 可读 value 的钩子，
   所以由 JS 写 --uwp-range。只写自定义属性，不碰 value/布局，其它主题零影响。 */
function syncUwpRange(input) {
  if (!input || input.type !== 'range') return;
  const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value || 0);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--uwp-range', Math.max(0, Math.min(100, pct)).toFixed(2) + '%');
}
function syncUwpRanges(root = document) {
  if (document.body.dataset.design !== 'uwp') return;
  root.querySelectorAll('input[type=range]').forEach(syncUwpRange);
}
document.addEventListener('input', e => {
  if (document.body.dataset.design === 'uwp' && e.target?.matches?.('input[type=range]')) syncUwpRange(e.target);
}, true);
let uwpHoverTile = null;
function resetUwpTileHover() {
  if (!uwpHoverTile) return;
  uwpHoverTile.style.setProperty('--uwp-face', '0');
  uwpHoverTile.style.setProperty('--uwp-edge', '0');
  uwpHoverTile = null;
}
function uwpTilesTarget(e) {
  const t = e.target && e.target.closest ? e.target.closest('button, .btn, [role=button], .welcome-card') : null;
  return t && !t.disabled && t.getAttribute('aria-disabled') !== 'true' ? t : null;
}
function uwpTileHover(e) {
  if (document.body.dataset.design !== 'uwp') { resetUwpTileHover(); return; }
  const t = uwpTilesTarget(e);
  if (t !== uwpHoverTile) {
    resetUwpTileHover();
    if (!t) return;
    t.classList.add('uwp-tile');
    uwpHoverTile = t;
  }
  if (!t) return;
  const r = t.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  t.style.setProperty('--uwp-face', '1');
  t.style.setProperty('--uwp-edge', '1');
  t.style.setProperty('--uwp-mx', (x * 100).toFixed(1) + '%');
  t.style.setProperty('--uwp-my', (y * 100).toFixed(1) + '%');
  t.style.setProperty('--uwp-face-r', (Math.min(r.width, r.height) * 1.2).toFixed(1) + 'px');
}
document.addEventListener('pointermove', uwpTileHover, { passive: true });
document.addEventListener('pointerleave', resetUwpTileHover);

let uwpPress = null;
function uwpPressTile(tile, x, y) {
  if (!tile || uwpMotionOff()) return;
  const r = tile.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const fx = Math.min(1, Math.max(0, (x - r.left) / r.width));
  const fy = Math.min(1, Math.max(0, (y - r.top) / r.height));
  const local = Math.max(Math.abs(fx - .5), Math.abs(fy - .5)) * 2;
  const span = Math.max(r.width, r.height);
  // 168px 以上沿用原型的 2.6°·168/max；更小的按钮按尺寸等比收小。
  const maxTilt = 2.6 * Math.min(span, 168) / Math.max(span, 168);
  const rx = (0.5 - fy) * 2 * maxTilt;
  const ry = (fx - 0.5) * 2 * maxTilt;
  const pressed = `perspective(760px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(-3px) scale(.99)`;
  const overshoot = `perspective(760px) rotateX(${(-rx * .20).toFixed(2)}deg) rotateY(${(-ry * .20).toFixed(2)}deg) translateZ(.6px) scale(1.002)`;
  cancelUwpPress();
  tile.getAnimations().forEach(a => {
    if (a.id === 'uwp-tile-press' || a.id === 'uwp-tile-rebound') { try { a.cancel(); } catch { /* 已结束 */ } }
  });
  tile.style.transform = '';
  tile.style.transformOrigin = `${((1 - fx) * 100).toFixed(2)}% ${((1 - fy) * 100).toFixed(2)}%`;
  tile.style.setProperty('--uwp-px', (fx * r.width).toFixed(1) + 'px');
  tile.style.setProperty('--uwp-py', (fy * r.height).toFixed(1) + 'px');
  tile.style.setProperty('--uwp-press-r', (Math.min(r.width, r.height) * 1.15).toFixed(1) + 'px');
  tile.style.setProperty('--uwp-press-local', local.toFixed(3));
  tile.classList.remove('is-uwp-rebounding');
  tile.classList.add('is-uwp-pressing');
  uwpPress = { tile, pressed, overshoot, anim: null, startX: x, startY: y };
  const anim = tile.animate([{ transform: 'none' }, { transform: pressed }], { duration: 105, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  anim.id = 'uwp-tile-press';
  uwpPress.anim = anim;
}
function releaseUwpPress() {
  if (!uwpPress) return;
  const p = uwpPress;
  uwpPress = null;
  const tile = p.tile;
  if (!tile || !tile.isConnected) return;
  tile.classList.remove('is-uwp-pressing');
  tile.classList.add('is-uwp-rebounding');
  if (uwpMotionOff() || !p.anim) {
    tile.style.transform = ''; tile.style.transformOrigin = '';
    setTimeout(() => tile.classList.remove('is-uwp-rebounding'), 60);
    return;
  }
  tile.style.transform = p.pressed;
  try { p.anim.cancel(); } catch { /* 已结束 */ }
  const reb = tile.animate([
    { transform: p.pressed, offset: 0 },
    { transform: p.overshoot, offset: .42 },
    { transform: 'none', offset: 1 }
  ], { duration: 420, easing: 'cubic-bezier(.22,.8,.24,1)' });
  reb.id = 'uwp-tile-rebound';
  reb.onfinish = () => {
    if (uwpPress && uwpPress.tile === tile) return;
    tile.style.transform = ''; tile.style.transformOrigin = '';
    tile.classList.remove('is-uwp-rebounding');
  };
}
function cancelUwpPress() {
  if (uwpPress) {
    const p = uwpPress;
    uwpPress = null;
    if (p.anim) { try { p.anim.cancel(); } catch { /* 已结束 */ } }
    if (p.tile) {
      p.tile.classList.remove('is-uwp-pressing', 'is-uwp-rebounding');
      p.tile.style.transform = ''; p.tile.style.transformOrigin = '';
    }
  }
  document.querySelectorAll('.uwp-tile.is-uwp-pressing, .uwp-tile.is-uwp-rebounding').forEach(tile => {
    tile.classList.remove('is-uwp-pressing', 'is-uwp-rebounding');
    tile.style.transform = ''; tile.style.transformOrigin = '';
    tile.getAnimations().forEach(a => {
      if (a.id === 'uwp-tile-press' || a.id === 'uwp-tile-rebound') { try { a.cancel(); } catch { /* 已结束 */ } }
    });
  });
}
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || document.body.dataset.design !== 'uwp') return;
  const tile = uwpTilesTarget(e);
  if (!tile) return;
  tile.classList.add('uwp-tile');
  uwpPressTile(tile, e.clientX, e.clientY);
}, { passive: true });
window.addEventListener('pointerup', releaseUwpPress);
window.addEventListener('pointercancel', releaseUwpPress);
window.addEventListener('blur', releaseUwpPress);
document.addEventListener('pointermove', e => {
  if (!uwpPress) return;
  if (Math.hypot(e.clientX - uwpPress.startX, e.clientY - uwpPress.startY) > 12) releaseUwpPress();
}, { passive: true });

/* 主页磁贴整组飞出后再执行真实导航；退出期间锁住重复点击。 */
let uwpExiting = false;
function uwpTileExit(run) {
  const dash = $('dashboard-view');
  if (uwpExiting) return;
  if (document.body.dataset.design !== 'uwp' || !dash || dash.hidden || uwpMotionOff()) { run(); return; }
  uwpExiting = true;
  cancelUwpPress();
  dash.classList.remove('is-entering');
  const tiles = [...$('sf-widgets').querySelectorAll(':scope > .sf-widget')];
  const rects = tiles.map(t => t.getBoundingClientRect());
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  const ordered = tiles.map((t, i) => ({ t, r: rects[i] })).sort((a, b) =>
    Math.abs(a.r.top - b.r.top) > 2 ? a.r.top - b.r.top : a.r.left - b.r.left);
  ordered.forEach(({ t, r }, i) => {
    t.style.setProperty('--uwp-exit-ox', (cx - r.left).toFixed(1) + 'px');
    t.style.setProperty('--uwp-exit-oy', (cy - r.top).toFixed(1) + 'px');
    t.style.setProperty('--uwp-exit-delay', (i * 16) + 'ms');
  });
  dash.classList.add('is-uwp-tile-leaving');
  setTimeout(() => {
    dash.classList.remove('is-uwp-tile-leaving');
    tiles.forEach(t => {
      t.style.removeProperty('--uwp-exit-ox');
      t.style.removeProperty('--uwp-exit-oy');
      t.style.removeProperty('--uwp-exit-delay');
    });
    uwpExiting = false;
    run();
  }, 300);
}

/* 返回主页：当前二级页 1.18 前向淡出，主页 .94→1 + 底部行先亮。 */
let uwpPageOutTimer = 0;
document.addEventListener('click', e => {
  if (document.body.dataset.design !== 'uwp' || uwpMotionOff()) return;
  const a = e.target.closest?.('#sf-nav a[href="#/dashboard"]');
  if (!a || location.hash === '#/dashboard') return;
  const current = [...document.querySelectorAll('.workspace-page:not([hidden]), #home-view:not([hidden]), .sf-page:not([hidden])')].find(el => el.id !== 'dashboard-view');
  if (!current) return;
  e.preventDefault();
  if (uwpPageOutTimer) return;
  current.classList.add('is-uwp-page-leaving');
  uwpPageOutTimer = setTimeout(() => {
    current.classList.remove('is-uwp-page-leaving');
    uwpPageOutTimer = 0;
    location.hash = '#/dashboard';
  }, 190);
});

function refreshLibrary() {
  let visible = 0;
  const current = prefs.folders.find(f => f.id === folder);
  $('sf-library-title').textContent = t(current?.name || '稿件库');
  // 小组件与稿件库共用同一组卡片，必须尊重用户选择的列表/卡片视图。
  $('home-view').dataset.list = prefs.view;
  $('sf-list-mode').setAttribute('aria-pressed', String(prefs.view === 'list'));
  $('sf-list-mode').textContent = t(prefs.view === 'list' ? '卡片视图' : '列表视图');
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  for (const card of $('home-list').querySelectorAll('.proj-card')) {
    const p = projects.find(p => p.id === card.dataset.id); if (!p) continue;
    card.hidden = !matchesProject(p, { route, filter, folder, search: $('sf-search').value }, prefs.assignments);
    if (!card.hidden) visible++;
    card.dataset.phase = projectPhase(p);
    if (!card.querySelector('.sf-cover')) {
      const cover = document.createElement('div'); cover.className = 'sf-cover'; cover.innerHTML = ico('film') + '<span>SUBFABRIC</span>';
      card.prepend(cover);
      card.draggable = true; card.addEventListener('dragstart', e => { if (e.target.closest('button,select,input')) { e.preventDefault(); return; } e.dataTransfer.setData('application/x-subfabric-project', p.id); });
      const assign = document.createElement('select'); assign.className = 'sf-assign'; assign.setAttribute('aria-label', t('移动到文件夹'));
      assign.addEventListener('click', e => e.stopPropagation());
      assign.addEventListener('change', e => { e.stopPropagation(); if (commit({ assignments: { ...prefs.assignments, [p.id]: assign.value } })) { renderFolders(); refreshLibrary(); } });
      card.querySelector('.pc-actions').appendChild(assign);
    }
    // 在线来源优先使用来源缩略图；没有绑定来源时使用服务端从本地视频抽取的封面。
    const cover = card.querySelector('.sf-cover');
    const coverUrl = /^https?:\/\//.test(p.source?.thumbnail || '') ? p.source.thumbnail : (p.cover || '');
    let coverImg = cover.querySelector('img');
    if (coverUrl) {
      if (!coverImg) {
        coverImg = document.createElement('img'); coverImg.alt = ''; coverImg.referrerPolicy = 'no-referrer';
        coverImg.addEventListener('error', () => coverImg.remove()); cover.prepend(coverImg);
      }
      if (coverImg.getAttribute('src') !== coverUrl) coverImg.src = coverUrl;
    } else if (coverImg) coverImg.remove();
    const assign = card.querySelector('.sf-assign');
    const options = `<option value="">${t('全部稿件')}</option>` + prefs.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    if (assign.innerHTML !== options) assign.innerHTML = options;
    assign.value = prefs.assignments[p.id] || '';
    const bar = card.querySelector('.pc-draft-bar');
    if (bar) {
      if (!bar.classList.contains('sf-progress')) {
        bar.classList.add('sf-progress'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', t('任务进度')); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
        bar.innerHTML = window.SF_PROGRESS.visual(p.draft?.progress); bar.querySelector('.sf-progress-fill').classList.add('pc-draft-bar-in');
      }
      window.SF_PROGRESS.set(bar, p.draft?.progress, p.draft?.status);
    }
  }
  $('home-empty').hidden = projects.length > 0;
  $('sf-filter-empty').hidden = visible > 0 || projects.length === 0;
  renderWidgets();
  syncDashboardMode();
  /* 首次项目数据晚于 applyTheme 到达时，卡片此前还不存在；渲染完后补一次
     Material 入场。类已存在说明本次已播过，轮询重绘不重复触发。 */
  if (document.body.dataset.design === 'material' && !$('home-view').hidden
    && !$('home-view').classList.contains('is-my-page-entering')) animateMaterialPage($('home-view'));
  window.SF_PROGRESS.mount($('home-list'));
}

// 真实播放器波浪控件按媒体事件更新，暂停时没有额外的 JS 动画循环。
const video = $('video');
// 只显示这套控件，并补齐原生条上的音量和倍速能力。
video.controls = false;
const player = document.createElement('div'); player.id = 'sf-player';
player.innerHTML = `<button type="button" class="btn" id="sf-play" aria-label="${t('播放 / 暂停')}">${ico('play')}</button><span id="sf-play-time">00:00</span><div id="sf-seek" class="sf-progress" data-progress-state="paused">${window.SF_PROGRESS.visual(0)}<input id="sf-seek-range" type="range" min="0" max="100" step="0.01" value="0" aria-label="${t('播放进度')}"></div><span id="sf-play-duration">00:00</span><button type="button" class="btn" id="sf-mute" aria-label="${t('静音')}" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="sf-sound-waves" d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sf-sound-muted" d="m16 9 6 6m0-6-6 6" hidden/></svg></button><input id="sf-volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="${t('音量')}"><select id="sf-rate" aria-label="${t('播放速度')}">${[0.25,0.5,0.75,1,1.25,1.5,1.75,2].map(rate => `<option value="${rate}">${rate}×</option>`).join('')}</select>`;
$('stage-wrap').appendChild(player);
// Material 主题的前后按钮只负责十秒定位；主题切换不重建播放器或丢失焦点。
for (const [id, label, path, before] of [
  ['sf-back-ten', '后退 10 秒', 'M6 5v14M19 5l-9 7 9 7', $('sf-play')],
  ['sf-forward-ten', '前进 10 秒', 'M18 5v14M5 5l9 7-9 7', $('sf-play-time')]
]) {
  const button = document.createElement('button');
  button.type = 'button'; button.id = id; button.className = 'btn sf-skip-ten';
  button.setAttribute('aria-label', t(label)); button.title = t(label);
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  player.insertBefore(button, before);
}
const transport = document.createElement('span'); transport.className = 'sf-transport';
player.insertBefore(transport, $('sf-back-ten'));
for (const id of ['sf-back-ten', 'sf-play', 'sf-forward-ten']) transport.appendChild($(id));
// 图标按钮不带文字，清除通用图标留白；音量图形的可见墨迹横向中心为 13.5。
player.querySelector('#sf-mute svg').setAttribute('viewBox', '1.5 0 24 24');
const rateShell = document.createElement('span'); rateShell.className = 'sf-rate-shell';
player.insertBefore(rateShell, $('sf-rate')); rateShell.appendChild($('sf-rate'));
const rateToggle = document.createElement('button'); rateToggle.id = 'sf-rate-toggle'; rateToggle.type = 'button';
rateToggle.setAttribute('aria-label', t('播放速度')); rateToggle.setAttribute('aria-haspopup', 'menu');
rateToggle.setAttribute('aria-expanded', 'false'); rateToggle.setAttribute('aria-controls', 'sf-rate-menu');
rateToggle.innerHTML = `<span id="sf-rate-label">1×</span>${ico('chevronDown')}`;
const rateMenu = document.createElement('div'); rateMenu.id = 'sf-rate-menu'; rateMenu.className = 'sf-rate-menu';
rateMenu.setAttribute('role', 'menu'); rateMenu.setAttribute('aria-label', t('播放速度')); rateMenu.hidden = true;
rateMenu.innerHTML = [0.25,0.5,0.75,1,1.25,1.5,1.75,2].map(rate => `<button type="button" role="menuitemradio" data-rate="${rate}" aria-checked="${rate === 1}" tabindex="-1"><span>${rate}×</span>${ico('check')}</button>`).join('');
rateShell.append(rateToggle, rateMenu);
function closeRateMenu(restoreFocus = false) {
  rateMenu.hidden = true; rateToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) rateToggle.focus();
}
function openRateMenu(edge = '') {
  rateMenu.hidden = false; rateToggle.setAttribute('aria-expanded', 'true');
  const triggerRect = rateToggle.getBoundingClientRect(), menuRect = rateMenu.getBoundingClientRect();
  popOrigin(rateMenu, triggerRect.left + triggerRect.width / 2, triggerRect.top, menuRect.left, menuRect.top);
  const options = [...rateMenu.querySelectorAll('[data-rate]')];
  const selected = options.find(option => Number(option.dataset.rate) === video.playbackRate);
  (edge === 'first' ? options[0] : edge === 'last' ? options.at(-1) : selected || options[0]).focus();
}
rateToggle.addEventListener('click', () => { if (rateMenu.hidden) openRateMenu(); else closeRateMenu(true); });
function chooseRate(option) {
  $('sf-rate').value = option.dataset.rate;
  $('sf-rate').dispatchEvent(new Event('change', { bubbles: true }));
  closeRateMenu(true);
}
rateMenu.addEventListener('click', e => {
  const option = e.target.closest('[data-rate]'); if (option) chooseRate(option);
});
rateShell.addEventListener('keydown', e => {
  if (e.target === $('sf-rate')) return;
  e.stopPropagation();
  // 主播放器在捕获阶段取消空格默认动作，菜单显式处理以保留按钮键盘操作。
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault(); if (e.repeat) return;
    const option = e.target.closest('[data-rate]');
    if (option) chooseRate(option); else if (e.target === rateToggle) rateToggle.click();
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeRateMenu(true); return; }
  if (e.key === 'Tab') { closeRateMenu(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  if (rateMenu.hidden) { openRateMenu(e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : ''); return; }
  const options = [...rateMenu.querySelectorAll('[data-rate]')], current = options.indexOf(document.activeElement);
  const index = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
    : (current + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[index].focus();
});
rateShell.addEventListener('keyup', e => { if (e.target !== $('sf-rate')) e.stopPropagation(); });
rateShell.addEventListener('focusout', e => { if (!rateShell.contains(e.relatedTarget)) closeRateMenu(); });
document.addEventListener('pointerdown', e => { if (!rateShell.contains(e.target)) closeRateMenu(); }, true);
for (const event of ['hashchange', 'resize', 'sf-studio-theme']) window.addEventListener(event, () => closeRateMenu());
const seekRange = $('sf-seek-range'), seekBar = $('sf-seek'), seekTip = $('video-hover-tip');
// 旧原生控件的提示模块不在 Studio 加载；沿用同一提示节点，命中范围改为真实播放条。
seekBar.appendChild(seekTip);
seekTip.hidden = true;
let scrubbing = false, requestedTime = null;
function syncPlayer() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const time = requestedTime ?? video.currentTime;
  const value = duration ? Math.max(0, Math.min(100, time / duration * 100)) : 0;
  const active = !video.paused && !video.ended;
  if (!scrubbing) seekRange.value = value;
  seekRange.disabled = !duration;
  $('sf-play').disabled = !video.currentSrc;
  $('sf-play').dataset.playing = String(active);
  for (const id of ['sf-back-ten', 'sf-forward-ten']) $(id).disabled = !duration || !video.currentSrc;
  $('sf-play').innerHTML = active ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>' : ico('play');
  $('sf-play').setAttribute('aria-label', t(active ? '暂停' : '播放'));
  $('sf-play-time').textContent = fmtTime(time || 0).slice(0, 8);
  $('sf-play-duration').textContent = fmtTime(duration).slice(0, 8);
  window.SF_PROGRESS.set(seekBar, value, active ? 'running' : 'paused');
}
for (const event of ['timeupdate', 'play', 'pause', 'ended', 'durationchange', 'emptied', 'loadedmetadata']) video.addEventListener(event, syncPlayer);
$('sf-play').addEventListener('click', () => { if (video.paused) video.play().catch(() => notice('视频暂时无法播放。')); else video.pause(); });
function skipTen(delta) {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.currentSrc) return;
  requestedTime = Math.max(0, Math.min(video.duration, (requestedTime ?? video.currentTime) + delta));
  scrubbing = false; hideSeekTip(); syncPlayer();
  if (video.currentTime !== requestedTime) video.currentTime = requestedTime;
  else if (!video.seeking) requestedTime = null;
}
$('sf-back-ten').addEventListener('click', () => skipTen(-10));
$('sf-forward-ten').addEventListener('click', () => skipTen(10));
seekRange.addEventListener('pointerdown', () => { scrubbing = true; hideSeekTip(); });
function finishScrub() { scrubbing = false; syncPlayer(); }
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'change', 'blur']) seekRange.addEventListener(event, finishScrub);
seekRange.addEventListener('input', () => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  requestedTime = Math.max(0, Math.min(100, Number(seekRange.value) || 0)) / 100 * video.duration;
  // 先显示拖动目标，不能等长视频解码触发 timeupdate，也不能被迟到的旧进度拉回。
  syncPlayer(); hideSeekTip();
  if (video.currentTime !== requestedTime) video.currentTime = requestedTime;
  else if (!video.seeking) requestedTime = null;
});
video.addEventListener('seeked', () => { if (!video.seeking) { requestedTime = null; syncPlayer(); } });
for (const event of ['emptied', 'loadstart', 'loadedmetadata']) video.addEventListener(event, () => {
  scrubbing = false; requestedTime = null; hideSeekTip(); syncPlayer();
});
function hideSeekTip() { seekTip.hidden = true; }
seekRange.addEventListener('pointermove', e => {
  if (scrubbing || seekRange.disabled || !Number.isFinite(video.duration) || video.duration <= 0) { hideSeekTip(); return; }
  const rect = seekRange.getBoundingClientRect();
  /* 原生 range 的拇指在两端各内缩半个拇指宽（见 CSS 的 --sf-hit-thumb）：
     命中位置 → 时间要按 (x - 半个拇指) / (宽 - 整个拇指) 反算，否则越靠两端偏得越多。
     4 小时视频、700px 宽时旧算法两端能差 2 分钟。测试用的假 DOM 没有 getComputedStyle，
     取不到就退回与 CSS 相同的 14px。 */
  let thumb = 14;
  try {
    const v = parseFloat(getComputedStyle(seekRange).getPropertyValue('--sf-hit-thumb'));
    if (isFinite(v) && v > 0) thumb = v;
  } catch {}
  const usable = Math.max(1, rect.width - thumb);
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - thumb / 2) / usable));
  const time = ratio * video.duration;
  seekTip.textContent = fmtTime(time).slice(0, 8);
  seekTip.title = fmtTime(time);
  /* 提示块对准拇指中心（同一个映射），两端各留 36px 不出界。 */
  const barW = seekBar.clientWidth || rect.width;
  const cx = thumb / 2 + ratio * Math.max(1, barW - thumb);
  seekTip.style.left = `${Math.max(36, Math.min(barW - 36, cx)).toFixed(1)}px`;
  seekTip.hidden = false;
});
for (const event of ['pointerleave', 'pointercancel', 'blur']) seekRange.addEventListener(event, hideSeekTip);
video.addEventListener('seeking', hideSeekTip);
window.addEventListener('resize', hideSeekTip);
window.addEventListener('hashchange', hideSeekTip);
function syncPlayerSound() {
  const muted = video.muted || video.volume === 0;
  $('sf-volume').value = video.muted ? 0 : video.volume;
  $('sf-volume').style.setProperty('--sf-volume', `${Math.max(0, Math.min(1, Number($('sf-volume').value) || 0)) * 100}%`);
  /* 静音/恢复也会改 value，但不发 input；UWP 的 accent 填充要同步重算。 */
  syncUwpRange($('sf-volume'));
  $('sf-mute').setAttribute('aria-pressed', String(muted));
  $('sf-mute').setAttribute('aria-label', t(muted ? '取消静音' : '静音'));
  player.querySelector('.sf-sound-waves').toggleAttribute('hidden', muted);
  player.querySelector('.sf-sound-muted').toggleAttribute('hidden', !muted);
  $('sf-rate').value = String(video.playbackRate);
  $('sf-rate-label').textContent = `${video.playbackRate}×`;
  for (const option of rateMenu.querySelectorAll('[data-rate]')) option.setAttribute('aria-checked', String(Number(option.dataset.rate) === video.playbackRate));
}
video.addEventListener('volumechange', syncPlayerSound);
video.addEventListener('ratechange', syncPlayerSound);
$('sf-mute').addEventListener('click', () => {
  if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 1; }
  else video.muted = true;
});
$('sf-volume').addEventListener('input', () => { video.volume = Number($('sf-volume').value); video.muted = video.volume === 0; });
$('sf-rate').addEventListener('change', () => { video.playbackRate = Number($('sf-rate').value); syncPlayerSound(); });
syncPlayerSound();

window.__sfStudio = {
  projects(snapshot) {
    projects = snapshot;
    /* 识别进度每 1.5 秒推一次快照；文件夹名称和归属计数没变就不要重建
       #sf-folders，否则左侧「文件夹」会跟着识别进度反复闪。 */
    if (folderSnapshotSignature() !== folderSnapshotSig) renderFolders();
    refreshLibrary();
  },
  route(h, project, format) {
    if (h === '#/resources') h = '#/settings';
    const previous = route; route = h;
    /* 第一次收到路由（含 F5 直接刷新在 #/project/...）也要播入场：
     * 刷新时模块顶部的 `route` 已经等于 location.hash，只看 wasEditor / h!==previous
     * 会误判成"同一路由的重复 applyHash"而跳过。 */
    const firstRoute = !routeBooted;
    routeBooted = true;
    const editor = h === '#/editor' || h.startsWith('#/project/');
    const wasEditor = previous === '#/editor' || previous.startsWith('#/project/');
    document.body.dataset.workspace = editor ? 'editor' : h.slice(2).split('/')[0];
    $('sf-nav').hidden = editor; $('sf-topbar').hidden = editor; $('sf-help').hidden = h !== '#/help'; $('sf-help').inert = h !== '#/help';
    const global = h === '#/settings';
    moveStyles(global);
    const titles = { dashboard: '主页', home: '稿件库', settings: '设置', help: '帮助与快捷键', new: '新建稿件', details: '稿件详情' };
    $('sf-breadcrumb').textContent = t(titles[h.slice(2).split('/')[0]] || '字幕工作台');
    document.querySelectorAll('[data-route]').forEach(a => { const active = h === '#/' + a.dataset.route; a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (global) {
      $('st-view').querySelector('.page-intro h1').textContent = t('设置');
      if (pendingSetting) selectSetting(pendingSetting);
    }
    if (editor && h.startsWith('#/project/') && prefs.recent !== h.slice(10)) commit({ recent: h.slice(10) });
    refreshLibrary();
    /* 所有 UWP 非编辑器页面共用同一套入场：页面 .92→1，元素按几何位置错峰。 */
    if (!editor && document.body.dataset.design === 'uwp') {
      const page = h === '#/dashboard' ? $('dashboard-view') : h === '#/home' ? $('home-view')
        : h === '#/settings' ? $('st-view') : h === '#/new' ? $('np-view')
          : h === '#/help' ? $('sf-help') : h.startsWith('#/details/') ? $('detail-view') : null;
      if (page && !page.hidden) animateUwpPage(page);
    }
    /* Material You：稿件库/文件夹/设置/帮助各自按几何顺序上浮，主页保持原卡片节奏。
       延后一帧，兼容 project.js 路由早于 applyTheme 写入 data-design 的首屏顺序。 */
    if (!editor) requestAnimationFrame(() => {
      if (document.body.dataset.design !== 'material') return;
      if (h === '#/home') { animateMaterialPage($('home-view')); animateMaterialPage($('sf-folders')); }
      else if (h === '#/settings') {
        const panel = [...$('st-view').querySelectorAll('.st-panel:not([hidden])')][0];
        if (panel) animateMaterialPage(panel);
      } else if (h === '#/help') animateMaterialPage($('sf-help'));
    });
    /* UWP 编辑器：外壳轻微 scale(.97→1) 淡入；字幕卡在 cue 渲染后自上而下 120ms/14ms 淡入上移。 */
    if (editor) {
      /* 三大板块（视频 / 右侧列表 / 时间轴）逐个淡入：进入编辑器、切换稿件或直接刷新时播一次。 */
      if (firstRoute || !wasEditor || h !== previous) animateEditorPanels();
      uwpEditorPending = true;
      materialEditorPending = true;
      if (!wasEditor) {
        /* 每次进入编辑器是新的会话：角色/设置页入场只在该会话第一次点开时播放。 */
        window.__panel?.resetEntranceAnimations?.();
        if (document.body.dataset.design === 'uwp') animateUwpEditorShell();
        else if (document.body.dataset.design === 'material') animateMaterialEditorShell();
      }
      /* 已有卡片（从稿件库直接进项目）可立即播放；新项目则在 editor.js 的
         sf-cue-rendered 事件到达后播放，不额外占用动画帧。 */
      animateUwpCueList();
      animateMaterialCueList();
    } else {
      uwpEditorPending = false;
      materialEditorPending = false;
      materialCueSeen.clear();
      clearEditorPanelsEntrance();
    }
  }
};
// 三个主题共用菜单行为，各自用 CSS 定义材质；原 select 保留业务链路。
function installThemeChoices() {
  // 覆盖动态稿件卡片、新建与资源页；倍速已有独立菜单，避免重复接管。
  const selector = 'select';
  let controlId = 0;
  const records = new Map();
  const menu = document.createElement('div'); menu.id = 'sf-choice-menu'; menu.className = 'sf-choice-menu';
  menu.setAttribute('role', 'listbox'); menu.setAttribute('data-sf-choice-control', ''); menu.hidden = true;
  document.body.appendChild(menu);
  let active = null, cursor = -1, fingerprint = '', typed = '', typedAt = 0;
  const themed = () => ['studio', 'material', 'uwp'].includes(document.body.dataset.design);
  const options = record => [...record.select.options];
  const unavailable = option => option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled;
  function name(select) {
    if (select.id === 'sel-display-mode') return t('显示模式');
    return (select.getAttribute('aria-label') || select.title || select.labels?.[0]?.textContent ||
      select.closest('.setting-row,.st-row,.set-row,.field,.st-grid,.sm-model')?.querySelector('label,.setting-name,.st-lbl,.st-label,.sm-name')?.textContent || select.id || '').trim();
  }
  function index(record) {
    return Number.isInteger(record.select.selectedIndex) ? record.select.selectedIndex : options(record).findIndex(option => option.value === record.select.value);
  }
  function close(restoreFocus = false) {
    if (!active) return;
    const record = active; active = null; menu.hidden = true;
    record.toggle.setAttribute('aria-expanded', 'false'); record.toggle.removeAttribute('aria-activedescendant');
    if (restoreFocus) (themed() ? record.toggle : record.select).focus();
  }
  function setCursor(next) {
    cursor = next;
    for (const row of menu.querySelectorAll('[data-choice-index]')) row.classList.toggle('is-active', Number(row.dataset.choiceIndex) === cursor);
    const row = menu.querySelector(`[data-choice-index="${cursor}"]`);
    if (row) { active.toggle.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
  }
  function position() {
    const r = active.toggle.getBoundingClientRect(), viewport = document.documentElement.getBoundingClientRect();
    const width = Math.max(0, Math.min(Math.max(r.width, 200), viewport.width - 24));
    const below = viewport.height - r.bottom - 12, above = r.top - 12;
    const down = below >= Math.min(280, menu.scrollHeight) || below >= above;
    const maxHeight = Math.max(0, Math.min(320, down ? below : above));
    menu.style.width = width + 'px'; menu.style.maxHeight = maxHeight + 'px';
    const left = Math.max(12, Math.min(r.left, viewport.width - width - 12));
    const top = down ? r.bottom + 6 : Math.max(12, r.top - menu.getBoundingClientRect().height - 6);
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    popOrigin(menu, r.left + r.width / 2, down ? r.bottom : r.top, left, top);
  }
  function signature(record) {
    return JSON.stringify([index(record), record.select.disabled, options(record).map(option => [option.textContent, option.value, !!unavailable(option), option.parentElement?.label])]);
  }
  function render() {
    const record = active, selected = index(record); menu.replaceChildren();
    menu.setAttribute('aria-label', name(record.select));
    let group = null;
    options(record).forEach((option, i) => {
      const parent = option.parentElement;
      if (parent?.tagName === 'OPTGROUP' && parent !== group) {
        group = parent; const heading = document.createElement('div'); heading.className = 'sf-choice-group';
        heading.textContent = parent.label; heading.setAttribute('role', 'presentation'); menu.appendChild(heading);
      }
      const row = document.createElement('button'); row.type = 'button'; row.className = 'sf-choice-option';
      row.id = 'sf-choice-option-' + i; row.dataset.choiceIndex = String(i); row.tabIndex = -1;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === selected));
      row.disabled = !!unavailable(option); row.setAttribute('aria-disabled', String(row.disabled));
      const text = document.createElement('span'); text.textContent = option.textContent;
      row.appendChild(text); const check = document.createElement('span'); check.innerHTML = ico('check');
      check.className = 'sf-choice-check'; check.setAttribute('aria-hidden', 'true'); row.appendChild(check); menu.appendChild(row);
    });
    fingerprint = signature(record);
    const enabled = options(record).map((option, i) => unavailable(option) ? -1 : i).filter(i => i >= 0);
    setCursor(enabled.includes(cursor) ? cursor : enabled.includes(selected) ? selected : enabled[0] ?? -1);
    position();
  }
  function sync(record) {
    const select = record.select, selected = options(record)[index(record)];
    const label = selected?.textContent || '—';
    if (record.label.textContent !== label) record.label.textContent = label;
    record.toggle.setAttribute('aria-label', name(select)); record.toggle.title = name(select);
    record.toggle.disabled = select.disabled || !!select.closest('[inert]')?.inert || !options(record).some(option => !unavailable(option));
    if (record.shell.hidden !== select.hidden) record.shell.hidden = select.hidden;
    record.shell.style.maxWidth = select.style.maxWidth || '100%';
    record.shell.style.width = select.style.width || '';
    record.shell.classList.toggle('sf-choice-wide', select.matches('.st-select,.st-input,.ws-fld,.sf-assign'));
    record.shell.classList.toggle('sf-choice-assignment', select.matches('.sf-assign'));
    if (active === record) {
      if (record.toggle.disabled || !themed()) close();
      else if (fingerprint !== signature(record)) render();
    }
  }
  function open(record, edge = '') {
    sync(record); if (!themed() || record.toggle.disabled) return;
    close(); active = record; cursor = index(record); typed = ''; typedAt = 0;
    menu.hidden = false; record.toggle.setAttribute('aria-expanded', 'true'); render();
    if (edge) {
      const enabled = options(record).map((option, i) => unavailable(option) ? -1 : i).filter(i => i >= 0);
      setCursor(edge === 'last' ? enabled.at(-1) ?? -1 : enabled[0] ?? -1);
    }
    record.toggle.focus();
  }
  function choose(i) {
    const record = active, option = options(record)[i];
    if (!option || unavailable(option) || record.toggle.disabled) return;
    const previous = index(record);
    record.select.selectedIndex = i;
    if (previous !== i) {
      record.select.dispatchEvent(new Event('input', { bubbles: true }));
      record.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync(record); close(true); (themed() ? record.toggle : record.select).focus();
  }
  function key(e, record = active) {
    if (!record) return; e.stopPropagation();
    if (e.key === 'Tab') { close(); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault(); if (e.repeat) return;
      if (active === record) choose(cursor); else open(record); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      if (active !== record) { open(record, e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : ''); return; }
      const enabled = options(record).map((option, i) => unavailable(option) ? -1 : i).filter(i => i >= 0);
      const current = enabled.indexOf(cursor);
      setCursor(e.key === 'Home' ? enabled[0] : e.key === 'End' ? enabled.at(-1) : enabled[(current + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
      return;
    }
    if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault(); if (active !== record) open(record);
      const now = Date.now(); typed = now - typedAt < 700 ? typed + e.key.toLocaleLowerCase() : e.key.toLocaleLowerCase(); typedAt = now;
      const list = options(record), start = cursor + 1;
      for (let offset = 0; offset < list.length; offset++) {
        const i = (start + offset) % list.length;
        if (!unavailable(list[i]) && list[i].textContent.trim().toLocaleLowerCase().startsWith(typed)) { setCursor(i); break; }
      }
    }
  }
  function enhance(select) {
    if (records.has(select) || select.id === 'sf-rate' || select.multiple || select.size > 1) return;
    const shell = document.createElement('span'); shell.className = 'sf-choice-shell';
    select.before(shell); shell.appendChild(select); select.classList.add('sf-choice-native');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.id = select.id ? select.id + '-choice' : 'sf-choice-control-' + ++controlId; toggle.className = 'sf-choice-toggle';
    toggle.setAttribute('role', 'combobox'); toggle.setAttribute('data-sf-choice-control', '');
    toggle.setAttribute('aria-haspopup', 'listbox'); toggle.setAttribute('aria-controls', menu.id); toggle.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); label.className = 'sf-choice-value'; toggle.appendChild(label);
    const arrow = document.createElement('span'); arrow.className = 'sf-choice-arrow'; arrow.innerHTML = ico('chevronDown'); arrow.setAttribute('aria-hidden', 'true'); toggle.appendChild(arrow); shell.appendChild(toggle);
    const record = { select, shell, toggle, label, hooks: [] }; records.set(select, record);
    toggle.addEventListener('click', e => { e.stopPropagation(); if (active === record) close(true); else open(record); });
    toggle.addEventListener('keydown', e => key(e, record)); toggle.addEventListener('keyup', e => e.stopPropagation());
    toggle.addEventListener('focusout', e => { if (active === record && !menu.contains(e.relatedTarget) && e.relatedTarget !== toggle) close(); });
    select.addEventListener('change', () => sync(record));
    // 业务代码经常直接写 value/selectedIndex/disabled，不会发 change 或属性变更。
    // 在该实例上透传原生访问器，避免轮询和重复刷新整页。
    const prototype = typeof HTMLSelectElement === 'function' ? HTMLSelectElement.prototype : null;
    for (const property of ['value', 'selectedIndex', 'disabled']) {
      const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.get || !descriptor.set || Object.hasOwn(select, property)) continue;
      Object.defineProperty(select, property, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); sync(record); } });
      record.hooks.push(property);
    }
    if (typeof MutationObserver === 'function') {
      record.observer = new MutationObserver(() => sync(record));
      record.observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    sync(record);
  }
  function scan() {
    for (const [select, record] of records) {
      if (!select.isConnected || !record.shell.isConnected) {
        if (active === record) close(); record.observer?.disconnect();
        record.hooks.forEach(property => { delete select[property]; }); records.delete(select);
      }
    }
    document.querySelectorAll(selector).forEach(enhance); records.forEach(sync);
  }
  menu.addEventListener('click', e => { const row = e.target.closest('[data-choice-index]'); if (active && row) choose(Number(row.dataset.choiceIndex)); });
  menu.addEventListener('keydown', e => key(e)); menu.addEventListener('keyup', e => e.stopPropagation());
  menu.addEventListener('pointermove', e => { const row = e.target.closest('[data-choice-index]'); if (active && row && !row.disabled) setCursor(Number(row.dataset.choiceIndex)); });
  document.addEventListener('pointerdown', e => { if (active && !menu.contains(e.target) && !active.toggle.contains(e.target)) close(); }, true);
  document.addEventListener('scroll', e => { if (active && !menu.contains(e.target)) close(); }, true);
  document.addEventListener('click', e => {
    const label = e.target.closest('label[for]'); const record = label && records.get($(label.getAttribute('for')));
    if (themed() && record) record.toggle.focus();
  });
  for (const event of ['resize', 'hashchange']) window.addEventListener(event, () => close());
  window.addEventListener('sf-studio-theme', () => { close(); scan(); });
  if (typeof MutationObserver === 'function') {
    // 忽略播放读数、字幕虚拟列表和菜单自己的文字更新，避免每帧扫描所有设置。
    const hasSelect = node => node.nodeType === 1 && (node.matches('select,.sf-choice-shell') || node.querySelector('select,.sf-choice-shell'));
    const observer = new MutationObserver(changes => {
      if (changes.some(change => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some(hasSelect))) scan();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] });
  }
  scan();
}
installThemeChoices();
// 编辑快捷键只在工作台生效，其他页面保留按钮的原生键盘行为。
for (const event of ['keydown', 'keyup']) document.addEventListener(event, e => {
  const typing = e.target.closest?.('input,textarea,select,[contenteditable=true],[data-sf-choice-control]');
  if (!typing && document.body.dataset.workspace !== 'editor' && shortcuts.actionForCombo(comboFromEvent(e))) e.stopImmediatePropagation();
}, true);
applyTheme(); renderFolders(); syncPlayer(); window.SF_PROGRESS.mount();
// #/editor 的旧直开 boot 不经过项目路由，也须初始化独立工作台可见性。
window.__sfStudio.route(route, null, '');
