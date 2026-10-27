import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const studioSource = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
assert.match(studioSource, /data-pack-select=\"\$\{esc\(pack\.id\)\}\"/, 'theme cards expose the pack id through data-pack-select');
assert.match(studioSource, /themes\.get\(b\.dataset\.packSelect, prefs\.custom\)/, 'theme picker reads the data-pack-select value when switching packs');
assert.doesNotMatch(studioSource, /themes\.get\(b\.dataset\.pack, prefs\.custom\)/, 'theme picker does not read the stale dataset.pack key');
assert.match(studioSource, /class="sf-pack-art \$\{pack\.design\}"/, 'preview art carries the design of its own pack');
assert.match(studioSource, /pack\.design === 'claude'/, 'theme card previews render the Claude paper palette instead of the material tonal derivation');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'editor/js/studio-themes.js'), 'utf8'), context);
const themes = context.window.SF_THEMES;

assert.equal(themes.builtins.length, 4, 'four built-in theme packs are registered (Studio removed, Claude added)');
assert.equal(themes.get('claude').design, 'claude', 'the Claude pack selects its own design family');
assert.equal(themes.get('claude').seed, '#B0512F', 'Claude keeps its terracotta seed');
assert.equal(themes.get('nope').id, 'windows-uwp', 'unknown pack ids still fall back to the first built-in');
for (const pack of themes.builtins) {
  assert.equal(pack.builtin, true, `${pack.id} is marked built-in`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'editor/themes', `${pack.id}.theme.json`), 'utf8')), JSON.parse(JSON.stringify(pack)), `${pack.id} has a distributable JSON package`);
}

/* 示意图圆角跟随卡片自身的 design，而不是当前启用主题的 body[data-design]。 */
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(css, /\.sf-pack-art \{[^}]*--pack-art-radius:12px[^}]*border-radius:var\(--pack-art-radius\)!important/, 'preview art defaults to the Studio radius through its own token');
assert.match(css, /\.sf-pack-art\.uwp \{[^}]*--pack-art-radius:2px[^}]*--pack-symbol-radius:2px[^}]*--pack-line-radius:0/, 'Windows 10 previews keep compact 2px corners under any active theme');
assert.match(css, /\.sf-pack-art\.material \{[^}]*--pack-art-radius:24px/, 'Material You previews keep the large rounded corner under any active theme');
assert.match(css, /\.sf-pack-art\.classic \{[^}]*--pack-art-radius:8px/, 'Classic previews keep the classic corner under any active theme');
assert.match(css, /\.sf-pack-art\.claude \{[^}]*--pack-art-radius: ?14px/, 'Claude previews keep the 14px corner under any active theme');
assert.match(css, /\.sf-studio\[data-design=claude\] :is\(h1,h2,h3,h4/, 'Claude applies the serif display stack to headings');
assert.match(css, /\[data-design=material\] \.sf-pack:not\(\[aria-current=true\]\):hover \{[^}]*border-color:var\(--accent\)/, 'Material You lights the hovered theme card border without competing with the selected ring');

const custom = {
  schema: 'subfabric-theme-v1', id: 'painted-studio', name: 'Painted Studio', version: '1.2.0', description: 'Local palette', author: 'Tester', design: 'studio', seed: '#112233',
  tokens: { light: { bg: '#fefefe', surface: '#ffffff', accent: '#225588' }, dark: { bg: '#111111', text: '#eeeeee' } },
  assets: { preview: 'data:image/png;base64,AAAA' }
};
assert.equal(themes.valid(custom), true, 'custom pack accepts safe token overrides and local preview art');
const stored = themes.asCustom({ ...custom, builtin: true });
assert.equal(stored.builtin, undefined, 'stored custom packs cannot masquerade as built-ins');
assert.equal(stored.seed, '#112233');
assert.deepEqual(JSON.parse(JSON.stringify(themes.tokenOverrides(custom, false))), { '--bg': '#fefefe', '--surface': '#ffffff', '--accent': '#225588' });
assert.deepEqual(JSON.parse(JSON.stringify(themes.tokenOverrides(custom, true))), { '--bg': '#111111', '--text': '#eeeeee' });
assert.equal(themes.valid({ ...custom, script: 'alert(1)' }), false, 'scripts are rejected');
assert.equal(themes.valid({ ...custom, css: 'body{}' }), false, 'CSS injection is rejected');
assert.equal(themes.valid({ ...custom, assets: { preview: 'https://example.com/a.png' } }), false, 'remote assets are rejected');
assert.equal(themes.valid({ ...custom, assets: { preview: 'data:image/svg+xml;base64,AAAA' } }), false, 'SVG assets are rejected');
assert.equal(themes.valid({ ...custom, tokens: { light: { '--bg': '#fff' } } }), false, 'token names stay on the safe allowlist');
const portable = {
  ...custom,
  personalization: {
    accent: '#225588', mode: 'dark', motion: 'on', background: 'aurora',
    auroraColors: ['#112233', '#445566', '#778899'], auroraMotion: 'dynamic', auroraSpeed: 1.6,
    glassDim: 84, glassBlur: 20, glassOpacity: 90,
    rimEnabled: true, rimSatLow: 0.9, rimBriGain: 0.5, rimSpecBase: 0.62, rimPower: 1.8,
  },
};
assert.equal(themes.valid(portable), true, 'theme pack accepts a personalization snapshot');
const portableStored = themes.asCustom(portable);
assert.equal(portableStored.personalization.accent, '#225588', 'asCustom keeps personalization');
assert.equal(portableStored.personalization.rimSpecBase, 0.62, 'asCustom keeps rim curve params');
assert.equal(themes.valid({ ...portable, personalization: { ...portable.personalization, evil: 1 } }), false, 'unknown personalization keys are rejected');
assert.equal(themes.valid({ ...portable, personalization: { accent: 'red' } }), false, 'personalization colors must be hex');
assert.equal(themes.valid({ ...portable, personalization: { auroraColors: [] } }), true, 'empty aurora colors mean follow theme');
assert.match(studioSource, /personalization: personalizationSnapshot\(\)/, 'export packages a personalization snapshot');
assert.match(studioSource, /const p = pack\.personalization;[\s\S]*?rimSpecBase/, 'import restores personalization fields');
assert.match(studioSource, /function activatePack[\s\S]*?Object\.assign\(change, p\)/, 'selecting a portable pack restores its snapshot');
assert.equal(themes.canDelete('windows-uwp'), false, 'built-in packs cannot be deleted');
assert.equal(themes.canDelete('painted-studio'), true, 'custom packs can be deleted');
assert.equal(themes.remove([stored], 'painted-studio').length, 0, 'custom pack removal is deterministic');
console.log('Theme packs: built-in JSON packages, safe custom import/export fields, grouping metadata and deletion rules passed');
