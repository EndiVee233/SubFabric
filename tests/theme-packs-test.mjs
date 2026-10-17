import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'editor/js/studio-themes.js'), 'utf8'), context);
const themes = context.window.SF_THEMES;

assert.equal(themes.builtins.length, 4, 'all four built-in theme packs are registered');
for (const pack of themes.builtins) {
  assert.equal(pack.builtin, true, `${pack.id} is marked built-in`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'editor/themes', `${pack.id}.theme.json`), 'utf8')), JSON.parse(JSON.stringify(pack)), `${pack.id} has a distributable JSON package`);
}

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
assert.equal(themes.canDelete('windows-uwp'), false, 'built-in packs cannot be deleted');
assert.equal(themes.canDelete('painted-studio'), true, 'custom packs can be deleted');
assert.equal(themes.remove([stored], 'painted-studio').length, 0, 'custom pack removal is deterministic');
console.log('Theme packs: built-in JSON packages, safe custom import/export fields, grouping metadata and deletion rules passed');
