/* Declarative theme packs. JSON only: no scripts, CSS, URLs or remote assets. */
(function () {
  'use strict';
  const builtins = Object.freeze([
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'studio', name: 'Studio', version: '1.0.0', description: '纸白、细描边与安静的创作空间', design: 'studio', seed: '#5c7560' }),
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'material-you', name: 'Material You', version: '1.0.0', description: '动态色、柔软轮廓与波浪播放进度', design: 'material', seed: '#5789dc' }),
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'subfabric-classic', name: 'SubFabric Classic', version: '1.0.0', description: '经典 SubFabric：深色工作台、橙色强调与紧凑编辑器', design: 'classic', seed: '#ff7a45' }),
    Object.freeze({ schema: 'subfabric-theme-v1', id: 'windows-uwp', name: 'Windows UWP', version: '1.0.0', description: 'Windows 10 Fluent：紧凑控件、细描边与规整工作区', design: 'uwp', seed: '#0078D7' })
  ]);
  const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  function valid(pack) {
    return Boolean(pack) && typeof pack === 'object' && !Array.isArray(pack)
      && Object.keys(pack).every(k => ['schema', 'id', 'name', 'version', 'description', 'design', 'seed'].includes(k))
      && pack.schema === 'subfabric-theme-v1' && typeof pack.id === 'string' && /^[a-z][a-z0-9-]{1,47}$/.test(pack.id)
      && typeof pack.name === 'string' && pack.name.trim().length > 0 && pack.name.length <= 48
      && typeof pack.description === 'string' && pack.description.length <= 160
      && typeof pack.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(pack.version)
      && ['studio', 'material', 'uwp', 'classic'].includes(pack.design) && hex(pack.seed);
  }
  function validList(list) {
    return Array.isArray(list) && list.length <= 24 && list.every(valid)
      && new Set(list.map(p => p.id)).size === list.length
      && list.every(p => !builtins.some(b => b.id === p.id));
  }
  const list = custom => [...builtins, ...(validList(custom) ? custom : [])];
  const get = (id, custom) => list(custom).find(p => p.id === id) || builtins[0];
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
    return { '--bg': bg, '--surface': surface, '--surface-2': tone(h, n, dark ? 18 : 92), '--text': text, '--muted': muted, '--line': tone(h, .12, dark ? 31 : 80), '--accent': primary, '--accent-soft': container, '--on-accent': onPrimary, '--on-container': tone(h, .4, dark ? 91 : 16), '--secondary-container': tone((h + 18) % 360, .24, dark ? 23 : 88), '--tertiary-container': tone((h + 65) % 360, .32, dark ? 24 : 88), '--outline': tone(h, .08, dark ? 66 : 43) };
  }
  function apply(settings, custom, dark) {
    const pack = get(settings.themePack, custom), root = document.body;
    document.body.dataset.themePack = pack.id;
    document.body.dataset.design = pack.design;
    const tokens = palette(settings.accent || pack.seed, dark);
    Object.keys(tokens).forEach(key => root.style.removeProperty(key));
    if (pack.design === 'material') Object.entries(tokens).forEach(([key, value]) => root.style.setProperty(key, value));
    else if (pack.design === 'uwp') {
      Object.entries({ ...tokens,
        '--accent': settings.accent || pack.seed,
        '--on-accent': contrast(settings.accent || pack.seed, '#ffffff') >= 4.5 ? '#ffffff' : '#101318',
        '--bg': dark ? '#1F1F1F' : '#F3F3F3',
        '--surface': dark ? '#2B2B2B' : '#FFFFFF',
        '--surface-2': dark ? '#333333' : '#EDEDED',
        '--text': dark ? '#F3F3F3' : '#202020',
        '--muted': dark ? '#C5C5C5' : '#606060',
        '--line': dark ? '#454545' : '#D1D1D1',
        '--accent-soft': dark ? '#153A5A' : '#CCE4F7',
        '--accent-hover': dark ? '#383838' : '#E5F1FB',
        '--outline': dark ? '#A6A6A6' : '#767676'
      }).forEach(([key, value]) => root.style.setProperty(key, value));
    } else if (pack.design === 'classic') {
      const accent = settings.accent || pack.seed;
      Object.entries({
        '--bg': dark ? '#0b0b0e' : '#f4f5f7', '--surface': dark ? '#131318' : '#ffffff', '--surface-2': dark ? '#1f1f27' : '#eef0f3',
        '--text': dark ? '#eceef2' : '#202124', '--muted': dark ? '#a8a8b4' : '#60656d', '--line': dark ? '#2a2a34' : '#d4d8df',
        '--accent': accent, '--accent-soft': dark ? 'rgba(255,122,69,.16)' : 'rgba(255,122,69,.12)',
        '--on-accent': contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#1a1206', '--outline': dark ? '#777b86' : '#7c828d'
      }).forEach(([key, value]) => root.style.setProperty(key, value));
    } else {
      const accent = readable(settings.accent, dark ? '#252d27' : '#fffefa', ...hueSeed(settings.accent), dark);
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-soft', tone(hueSeed(settings.accent)[0], .2, dark ? 23 : 93));
      root.style.setProperty('--on-accent', contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#101318');
    }
  }
  window.SF_THEMES = Object.freeze({ builtins, hex, valid, validList, list, get, palette, contrast, apply });
}());
