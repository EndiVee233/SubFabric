import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const production = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
const studio = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
const mirror = fs.readFileSync(path.join(root, 'tests/jsmod/studio.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.equal(production, template, 'production studio.html stays byte-identical to the template');
assert.equal(mirror, studio, 'studio.js test mirror stays byte-identical to production');

for (const id of [
  'dashboard-view', 'sf-mu-home', 'sf-mu-new', 'sf-mu-resume', 'sf-mu-next-title',
  'sf-mu-next-meta', 'sf-mu-resume-cta', 'sf-mu-temp', 'sf-mu-status-num',
]) assert.match(template, new RegExp(`id="${id}"`), `${id} is present in the homepage template`);

assert.match(template, /class="sf-hero"/, 'Material You uses the legacy three-column hero');
assert.match(template, /class="sf-flower"/, 'new-work entry uses the Material flower silhouette');
assert.match(template, /class="sf-resume"/, 'resume card is present');
assert.match(template, /class="sf-orbit"/, 'editable count uses the tilted Material capsule');
assert.equal((template.match(/sf-mu-search-form/g) || []).length, 0, 'New Tab search is removed from the Material homepage');

assert.match(studio, /let projects = \[\], filter = 'all', folder = '', route = location\.hash \|\| '#\/dashboard'/,
  'dashboard is the default route');
assert.match(studio, /function isMaterialHome\(\) \{ return document\.body\.dataset\.themePack === 'material-you'; \}/,
  'Material You detection is scoped to the theme pack');
assert.match(studio, /dashboard\.dataset\.homeMode = on \? 'material' : 'widgets'/,
  'theme switching selects exactly one homepage presentation');
for (const handler of ['sf-mu-new', 'sf-mu-temp', 'sf-mu-resume']) {
  assert.match(studio, new RegExp(`\\$\\('${handler}'\\)\\.addEventListener`), `${handler} has an event handler`);
}

assert.match(css, /\.sf-studio\[data-theme-pack="material-you"\] \.dashboard-view/, 'Material styling is theme-scoped');
assert.match(css, /\.sf-mu-shell\s*\{[\s\S]*width:min\(1120px,100%\)/, 'homepage is centered at the legacy hero width');
assert.match(css, /\.sf-mu \.sf-hero\s*\{[\s\S]*grid-template-columns:150px minmax\(0,1fr\) 112px/, 'homepage uses the reference three-column composition');
assert.match(css, /\.sf-mu \.sf-flower>span svg/, 'the flower is a single SVG silhouette');
assert.match(css, /\.sf-mu \.sf-orbit\s*\{[\s\S]*background:var\(--tertiary-container\)/, 'the right capsule uses the tertiary container');
assert.match(css, /@media \(max-width:900px\)/, 'homepage has a tablet layout');
assert.match(css, /@media \(max-width:560px\)/, 'homepage has a phone layout');

console.log('material-home: template/mirror parity, flower clock, theme gating, live counts, controls and responsive CSS passed');
