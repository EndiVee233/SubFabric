/* Declarative theme packs. JSON only: no scripts, CSS, URLs or remote assets. */
(function () {
  'use strict';
  const tokenKeys = Object.freeze({ bg: '--bg', surface: '--surface', surface2: '--surface-2', text: '--text', muted: '--muted', line: '--line', accent: '--accent', accentSoft: '--accent-soft', onAccent: '--on-accent', outline: '--outline', accentHover: '--accent-hover' });
  const dataImage = value => typeof value === 'string' && value.length <= 700000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
  const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const allowedKeys = new Set(['schema', 'id', 'name', 'version', 'description', 'author', 'design', 'seed', 'tokens', 'assets', 'builtin', 'personalization', 'layouts']);
  const designNames = new Set(['studio', 'material', 'uwp', 'classic', 'claude']);
  const tokenNames = new Set(Object.keys(tokenKeys));
  /* 主题包除了自带设计/tokens，还可以携带导出时的个性化快照：强调色、明暗、毛玻璃、
   * 流光、描边映射参数等。导入时恢复这套设置；不含背景图片（体积大且属于用户素材）。 */
  const personalizationKeys = new Set(['accent', 'mode', 'motion', 'background', 'auroraColors', 'auroraMotion',
    'auroraSpeed', 'glassDim', 'glassBlur', 'glassOpacity', 'rimEnabled', 'rimSatLow', 'rimBriGain', 'rimSpecBase', 'rimPower']);
  /* 2026-10-19：Studio 主题已从内置选择器移除；保留 design:'studio' 供旧自定义包使用。
     顺序即默认回退顺序，Windows UWP 作为新的第一内置主题。 */
  const builtins = Object.freeze([
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'windows-uwp', name: 'Windows 10', version: '1.0.0', description: 'Fluent：紧凑控件、细描边与规整工作区', design: 'uwp', seed: '#0078D7', builtin: true }),
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'material-you', name: 'Material You', version: '1.0.0', description: '动态色、柔软轮廓与波浪播放进度', design: 'material', seed: '#5789dc', builtin: true }),
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'subfabric-classic', name: 'SubFabric Classic', version: '1.0.0', description: '经典 SubFabric：深色工作台、橙色强调与紧凑编辑器', design: 'classic', seed: '#ff7a45', builtin: true }),
    /* 追加在末尾：builtins[0] 仍是未知 id 的回退主题，不改变旧行为。 */
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'claude', name: 'Claude', version: '1.0.0', description: '暖纸底、陶土强调、衬线标题与柔和圆角', design: 'claude', seed: '#B0512F', builtin: true })
  ]);
  const builtinIds = new Set(builtins.map(pack => pack.id));
  function validTokens(tokens) {
    if (tokens === undefined) return true;
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return false;
    return Object.keys(tokens).every(mode => ['light', 'dark'].includes(mode) && tokens[mode] && typeof tokens[mode] === 'object' && !Array.isArray(tokens[mode])
      && Object.keys(tokens[mode]).every(key => tokenNames.has(key) && hex(tokens[mode][key])));
  }
  function validPersonalization(value) {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!Object.keys(value).every(key => personalizationKeys.has(key))) return false;
    const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    return (value.accent === undefined || hex(value.accent))
      && (value.mode === undefined || ['light', 'dark', 'system'].includes(value.mode))
      && (value.motion === undefined || ['on', 'off'].includes(value.motion))
      && (value.background === undefined || ['solid', 'aurora'].includes(value.background))
      && (value.auroraColors === undefined || (Array.isArray(value.auroraColors) && (value.auroraColors.length === 0 || (value.auroraColors.length === 3 && value.auroraColors.every(hex)))))
      && (value.auroraMotion === undefined || ['dynamic', 'static'].includes(value.auroraMotion))
      && (value.auroraSpeed === undefined || num(value.auroraSpeed, 0.4, 2.5))
      && (value.glassDim === undefined || num(value.glassDim, 72, 92))
      && (value.glassBlur === undefined || num(value.glassBlur, 0, 32))
      && (value.glassOpacity === undefined || num(value.glassOpacity, 20, 100))
      && (value.rimEnabled === undefined || typeof value.rimEnabled === 'boolean')
      && (value.rimSatLow === undefined || num(value.rimSatLow, 0.70, 1.00))
      && (value.rimBriGain === undefined || num(value.rimBriGain, 0.30, 0.80))
      && (value.rimSpecBase === undefined || num(value.rimSpecBase, 0.45, 0.75))
      && (value.rimPower === undefined || num(value.rimPower, 1.00, 2.20));
  }
  function validLayouts(value) {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!Object.keys(value).every(key => ['home', 'library', 'editor', 'help'].includes(key))) return false;
    const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    const home = value.home;
    if (home !== undefined && (!home || typeof home !== 'object' || Array.isArray(home)
      || !Object.keys(home).every(k => k === 'widgets')
      || (home.widgets !== undefined && (!Array.isArray(home.widgets) || home.widgets.length > 16
        || !home.widgets.every(k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(k)))))) return false;
    const library = value.library;
    if (library !== undefined && (!library || typeof library !== 'object' || Array.isArray(library)
      || !Object.keys(library).every(k => k === 'view' || k === 'columns')
      || (library.view !== undefined && !['grid', 'list'].includes(library.view))
      || (library.columns !== undefined && !num(library.columns, 1, 4)))) return false;
    const editor = value.editor;
    if (editor !== undefined && (!editor || typeof editor !== 'object' || Array.isArray(editor)
      || !Object.keys(editor).every(k => k === 'timelineHeight' || k === 'panelWidth' || k === 'splitPane')
      || (editor.timelineHeight !== undefined && !num(editor.timelineHeight, 132, 420))
      || (editor.panelWidth !== undefined && !num(editor.panelWidth, 280, 720))
      || (editor.splitPane !== undefined && !['roles', 'notes'].includes(editor.splitPane)))) return false;
    const help = value.help;
    return help === undefined || (help && typeof help === 'object' && !Array.isArray(help)
      && Object.keys(help).every(k => k === 'columns')
      && (help.columns === undefined || num(help.columns, 1, 3)));
  }
  function validAssets(assets) {
    if (assets === undefined) return true;
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return false;
    return Object.keys(assets).every(key => key === 'preview' && dataImage(assets[key]));
  }
  function valid(pack) {
    return Boolean(pack) && typeof pack === 'object' && !Array.isArray(pack)
      && Object.keys(pack).every(k => allowedKeys.has(k))
      && pack.schema === 'subfabric-theme-v1' && typeof pack.id === 'string' && /^[a-z][a-z0-9-]{1,47}$/.test(pack.id)
      && typeof pack.name === 'string' && pack.name.trim().length > 0 && pack.name.length <= 48
      && typeof pack.description === 'string' && pack.description.length <= 160
      && (pack.author === undefined || typeof pack.author === 'string' && pack.author.length <= 80)
      && typeof pack.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(pack.version)
      && designNames.has(pack.design) && hex(pack.seed) && (pack.builtin === undefined || typeof pack.builtin === 'boolean')
      && validTokens(pack.tokens) && validAssets(pack.assets) && validPersonalization(pack.personalization)
      && validLayouts(pack.layouts);
  }
  function validList(list) {
    return Array.isArray(list) && list.length <= 24 && list.every(valid)
      && new Set(list.map(p => p.id)).size === list.length
      && list.every(p => !builtinIds.has(p.id) && p.builtin !== true);
  }
  function clone(pack, builtin = false) {
    const out = { schema: pack.schema, id: pack.id, name: pack.name.trim(), version: pack.version, description: pack.description.trim(), design: pack.design, seed: pack.seed.toUpperCase() };
    if (pack.author?.trim()) out.author = pack.author.trim();
    if (pack.tokens) out.tokens = Object.fromEntries(Object.entries(pack.tokens).map(([mode, values]) => [mode, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toUpperCase()]))]));
    if (pack.assets?.preview) out.assets = { preview: pack.assets.preview };
    if (pack.personalization) {
      const p = pack.personalization;
      out.personalization = { ...p };
      if (p.accent) out.personalization.accent = p.accent.toUpperCase();
      if (Array.isArray(p.auroraColors)) out.personalization.auroraColors = p.auroraColors.map(c => c.toUpperCase());
    }
    if (pack.layouts) {
      out.layouts = {};
      for (const [page, layout] of Object.entries(pack.layouts)) {
        out.layouts[page] = { ...layout };
        if (Array.isArray(layout.widgets)) out.layouts[page].widgets = [...layout.widgets];
      }
    }
    if (builtin) out.builtin = true;
    return out;
  }
  function customPack(pack, id = pack.id, name = pack.name) { return clone({ ...pack, id, name, builtin: false }); }
  const list = custom => [...builtins, ...(validList(custom) ? custom.map(p => clone(p)) : [])];
  const get = (id, custom) => list(custom).find(p => p.id === id) || builtins[0];
  const isBuiltin = packOrId => builtinIds.has(typeof packOrId === 'string' ? packOrId : packOrId?.id);
  const canDelete = packOrId => !isBuiltin(packOrId);
  const remove = (custom, id) => validList(custom) ? custom.filter(pack => pack.id !== id).map(pack => clone(pack)) : [];
  const asCustom = pack => valid(pack) && !isBuiltin(pack) ? customPack(pack) : null;
  const tokenOverrides = (pack, dark) => {
    const values = pack?.tokens?.[dark ? 'dark' : 'light'] || {};
    return Object.fromEntries(Object.entries(values).filter(([key]) => tokenKeys[key]).map(([key, value]) => [tokenKeys[key], value]));
  };
  function rgb(color) { return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255); }
  function hueSeed(color) {
    const [r, g, b] = rgb(color), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, d ? d / (1 - Math.abs(max + min - 1)) : 0];
  }
  function tone(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }
  function luminance(color) { return rgb(color).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); }
  function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
  // Keep the selected fill, but derive a readable foreground for links/counts.
  function foregroundColor(color, surfaces, dark) {
    const channels = rgb(color).map(v => v * 255), target = dark ? 255 : 0;
    for (let step = 0; step <= 100; step++) {
      const ink = '#' + channels.map(v => Math.round(v + (target - v) * step / 100).toString(16).padStart(2, '0')).join('');
      if (surfaces.every(bg => contrast(ink, bg) >= 4.6)) return ink;
    }
    return dark ? '#ffffff' : '#000000';
  }
  // Windows 浅色模式把强调底色与文字色分开：保留用户的颜色，但保证小字可读。
  function uwpLightColors(accent, selectedSurface) {
    const surfaces = ['#FFFFFF', '#EDEDED', '#E5E5E5', '#E5F1FB', selectedSurface];
    const channels = rgb(accent).map(v => v * 255);
    const shade = factor => '#' + channels.map(v => Math.round(v * factor).toString(16).padStart(2, '0')).join('');
    let ink = accent;
    for (let step = 0; step <= 100; step++) {
      ink = shade(1 - step / 100);
      if (surfaces.every(bg => contrast(ink, bg) >= 4.6)) break;
    }
    const on = bg => contrast('#FFFFFF', bg) >= contrast('#000000', bg) ? '#FFFFFF' : '#000000';
    return { '--accent-text': ink, '--on-accent': on(accent),
      '--on-accent-hover': on(shade(.86)), '--on-accent-pressed': on(shade(.72)),
      '--danger': '#A4262C', '--success': '#0B6A3C', '--warning': '#7A4600', '--info': '#005A9E', '--dim': '#606060' };
  }
  function readable(color, background, h, s, dark) {
    let l = dark ? 76 : 38;
    while (contrast(color, background) < 4.6 && l > 8 && l < 98) { l += dark ? 1 : -1; color = tone(h, s, l); }
    return color;
  }
  // Local tonal palette inspired by Material color roles; not the Google HCT algorithm.
  function palette(seed, dark = false) {
    const [h, rawS] = hueSeed(hex(seed) ? seed : '#5789dc'), s = Math.max(.24, Math.min(.7, rawS)), n = .12;
    const bg = tone(h, n, dark ? 9 : 96), surface = tone(h, n, dark ? 13 : 99), container = tone(h, s * .65, dark ? 23 : 88);
    const primary = readable(tone(h, s, dark ? 80 : 38), surface, h, s, dark);
    const onPrimary = contrast(primary, '#ffffff') >= 4.5 ? '#ffffff' : '#101318';
    const text = readable(tone(h, n, dark ? 92 : 12), bg, h, n, dark);
    const muted = readable(tone(h, .09, dark ? 73 : 38), bg, h, .09, dark);
    // Every pack starts with a complete palette. A switch must never inherit a
    // previous pack's raised surface or rely on bright dark-mode status fallbacks.
    return { '--bg': bg, '--surface': surface, '--surface-2': tone(h, n, dark ? 18 : 92), '--surface-3': tone(h, n, dark ? 23 : 87), '--text': text, '--muted': muted, '--dim': muted, '--line': tone(h, .12, dark ? 31 : 80), '--accent': primary, '--accent-soft': container, '--accent-hover': tone(h, n, dark ? 23 : 90), '--on-accent': onPrimary, '--on-container': tone(h, .4, dark ? 91 : 16), '--secondary-container': tone((h + 18) % 360, .24, dark ? 23 : 88), '--tertiary-container': tone((h + 65) % 360, .32, dark ? 24 : 88), '--outline': tone(h, .08, dark ? 66 : 43),
      '--success': dark ? '#4FD1A5' : '#0B6A3C', '--warning': dark ? '#FFD35C' : '#7A4600', '--danger': dark ? '#FF6B76' : '#A4262C', '--info': dark ? '#8AB4F8' : '#005A9E' };
  }
  function apply(settings, custom, dark) {
    const pack = get(settings.themePack, custom), root = document.body;
    document.body.dataset.themePack = pack.id;
    document.body.dataset.design = pack.design;
    const accent = settings.accent || pack.seed;
    const tokens = palette(accent, dark);
    [...Object.keys(tokens), '--accent-text', '--on-accent-hover', '--on-accent-pressed',
      '--danger', '--success', '--warning', '--info', '--dim'].forEach(key => root.style.removeProperty(key));
    Object.entries(tokens).forEach(([key, value]) => root.style.setProperty(key, value));
    if (pack.design === 'uwp') {
      Object.entries({ ...tokens,
        '--accent': accent,
        '--on-accent': contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#101318',
        '--bg': dark ? '#1F1F1F' : '#F3F3F3',
        '--surface': dark ? '#2B2B2B' : '#FFFFFF',
        '--surface-2': dark ? '#333333' : '#EDEDED',
        '--surface-3': dark ? '#3A3A3A' : '#E5E5E5',
        '--text': dark ? '#F3F3F3' : '#202020',
        '--muted': dark ? '#C5C5C5' : '#606060',
        '--line': dark ? '#666666' : '#B8B8B8',
        '--accent-soft': tokens['--accent-soft'],
        '--accent-hover': dark ? '#383838' : '#E5F1FB',
        '--outline': dark ? '#C8C8C8' : '#666666',
        ...(!dark ? uwpLightColors(accent, tokens['--accent-soft']) : {})
      }).forEach(([key, value]) => root.style.setProperty(key, value));
    } else if (pack.design === 'classic') {
      const accent = settings.accent || pack.seed;
      Object.entries({
        '--bg': dark ? '#0b0b0e' : '#f4f5f7', '--surface': dark ? '#131318' : '#ffffff', '--surface-2': dark ? '#1f1f27' : '#eef0f3',
        '--text': dark ? '#eceef2' : '#202124', '--muted': dark ? '#a8a8b4' : '#60656d', '--line': dark ? '#2a2a34' : '#d4d8df',
        '--accent': accent, '--accent-soft': dark ? 'rgba(255,122,69,.16)' : 'rgba(255,122,69,.12)',
        '--on-accent': contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#1a1206', '--outline': dark ? '#777b86' : '#7c828d'
      }).forEach(([key, value]) => root.style.setProperty(key, value));
    } else if (pack.design === 'claude') {
      /* 与 studio.js 的 applyTheme() 保持同一套值：这里供原型/测试直接调用。 */
      Object.entries({ ...tokens,
        '--bg': dark ? '#1A1916' : '#F6F4EE',
        '--surface': dark ? '#24221B' : '#FCFBF7',
        '--surface-2': dark ? '#2C2A23' : '#EFECE3',
        '--surface-3': dark ? '#35322A' : '#E7E3D7',
        '--text': dark ? '#EDE9DE' : '#1C1B18',
        '--muted': dark ? '#A5A091' : '#6B675C',
        '--line': dark ? '#37342C' : '#E1DDD1',
        '--accent': settings.accent || pack.seed,
        '--accent-soft': dark ? '#3A2A20' : '#F3E2D7',
        '--accent-hover': dark ? '#2E2620' : '#F7ECE4',
        '--on-accent': contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : (dark ? '#241B14' : '#FDFBF6'),
        '--outline': dark ? '#78715C' : '#8C8571'
      }).forEach(([key, value]) => root.style.setProperty(key, value));
    } else {
      const accent = readable(settings.accent, dark ? '#252d27' : '#fffefa', ...hueSeed(settings.accent), dark);
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-soft', tone(hueSeed(settings.accent)[0], .2, dark ? 23 : 93));
      root.style.setProperty('--on-accent', contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#101318');
    }
  }
  window.SF_THEMES = Object.freeze({ builtins, hex, valid, validList, list, get, isBuiltin, canDelete, remove, asCustom, tokenOverrides, palette, contrast, foregroundColor, uwpLightColors, apply });
}());
