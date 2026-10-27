import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const properties = new Map();
const context = { window: {}, document: { body: { dataset: {}, style: {
  setProperty(key, value) { properties.set(key, value); }, removeProperty(key) { properties.delete(key); },
} } } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../editor/js/studio-themes.js', import.meta.url), 'utf8'), context);
const themes = context.window.SF_THEMES;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const shade = (hex, factor) => '#' + rgb(hex).map(v => Math.round(v * factor).toString(16).padStart(2, '0')).join('');
// Default blue, pale custom colors, dark colors and saturated colors must all work.
for (const accent of ['#0078D7', '#FFFFFF', '#FFFF00', '#CCFFCC', '#000000', '#4B0082', '#FF0000', '#00FF00', '#00FFFF']) {
  const selected = themes.palette(accent, false)['--accent-soft'];
  const colors = themes.uwpLightColors(accent, selected);
  for (const bg of ['#FFFFFF', '#EDEDED', '#E5E5E5', '#E5F1FB', selected]) {
    assert.ok(themes.contrast(colors['--accent-text'], bg) >= 4.6, accent + ' small text on ' + bg);
  }
  for (const [key, bg] of [['--on-accent', accent], ['--on-accent-hover', shade(accent, .86)],
    ['--on-accent-pressed', shade(accent, .72)]]) {
    assert.ok(themes.contrast(colors[key], bg) >= 4.5, accent + ' button state ' + key);
  }
  for (const key of ['--danger', '--success', '--warning', '--info']) {
    assert.ok(themes.contrast(colors[key], '#E5E5E5') >= 4.5, key + ' status on light hover surface');
  }
}
themes.apply({ themePack: 'windows-uwp', accent: '#0078D7' }, [], false);
assert.equal(properties.get('--surface'), '#FFFFFF');
assert.equal(properties.get('--accent'), '#0078D7', 'brand accent is preserved');
assert.equal(properties.get('--danger'), '#A4262C');
themes.apply({ themePack: 'windows-uwp', accent: '#0078D7' }, [], true);
assert.equal(properties.get('--surface'), '#2B2B2B');
assert.equal(properties.get('--danger'), themes.palette('#0078D7', true)['--danger'], 'dark status replaces the light status');
assert.ok(themes.contrast(properties.get('--danger'), properties.get('--surface')) >= 4.5);
assert.equal(properties.has('--accent-text'), false);
themes.apply({ themePack: 'windows-uwp', accent: '#FFFF00' }, [], false);
themes.apply({ themePack: 'material-you', accent: '#5789dc' }, [], false);
assert.equal(properties.has('--accent-text'), false, 'UWP-only roles cannot leak into another theme');

const css = fs.readFileSync(new URL('../editor/css/studio.css', import.meta.url), 'utf8');
assert.match(css, /\.sf-studio:where\(:not\(\[data-design=uwp\]\)\)\[data-theme=light\] :is\([^\n]+\.sm-model/,
  'shared translucent panel layer excludes UWP, including moved model cards');
assert.match(css, /\.sf-studio:not\(:where\(\[data-design=uwp\]\[data-theme=light\]\)\)\[data-workspace=settings\]/,
  'settings glass layer also excludes UWP');
const auditLayer = css.slice(css.indexOf('/* Windows 10 浅色：'));
for (const component of ['--cc-text-3', '.sm-state.ok', '.hw-chip.ok', '.setting-val', '.fp-btn',
  '.sf-background-choice[aria-pressed=true]', '.log-subtab.active', '.btn-accent:hover', '.btn-accent:active',
  '.pc-st.st-running', '.pc-retry', '.fr-tabs', '.fr-hint', '.fr-menu-item:hover', '.fp-item.active',
  '.sf-cover > span', '.cc-skip.is-on', '::placeholder', '#np-pct', '.sf-ev-step[data-status=error]']) {
  assert.ok(auditLayer.includes(component), 'light contrast coverage: ' + component);
}
assert.ok(!auditLayer.includes('[data-theme=dark]'), 'contrast fixes stay in the light-mode scope');
console.log('uwp-light-test: ok (custom accents, state contrasts, semantic colors, theme switching, shared surfaces)');
