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
assert.match(studio, /function animateMaterialPage/, 'Material You has a shared page-card entrance');
assert.match(studio, /a\.r\.top - b\.r\.top[\s\S]*?a\.r\.left - b\.r\.left/, 'Material cards animate top-to-bottom then left-to-right');
assert.match(studio, /animateMaterialPage\(\$\('sf-folders'\)\)/, 'folder rows use the Material entrance');
assert.match(studio, /animateMaterialPage\(\$\('sf-help'\)\)/, 'help cards use the Material entrance');
assert.match(studio, /animateMaterialPage\(e\.detail\?\.panel\)/, 'settings panels use the Material entrance');
assert.match(css, /\.sf-studio\[data-design=material\] \.is-my-page-entering \[data-my-enter\]/, 'Material page cards use data-my-enter');
assert.match(css, /sf-home-card-in var\(--sf-card-duration,\.42s\)/, 'Material page cards reuse the homepage float-up curve');
assert.match(studio, /function animateMaterialCueList/, 'Material editor cues have their own entrance');
assert.match(studio, /\(i \* 55\)/, 'Material cue cards enter one by one every 55ms');
assert.match(studio, /addEventListener\('scroll'[\s\S]*?animateMaterialCueList\(\)/, 'Material cue list animates cards revealed by scrolling');
assert.match(studio, /function applyBackgroundWithFade/, 'Material background mode changes crossfade');
assert.match(css, /@keyframes sf-bg-fade-in/, 'Material background crossfade uses the shared CSS fade');
assert.match(studio, /materialCueSeen/, 'Material cue entries are not replayed for already-seen cards');
assert.match(studio, /is-material-editor-entering/, 'Material editor shell animates in');
assert.match(css, /@keyframes my-editor-in/, 'Material editor has the upward fade keyframes');
assert.match(css, /@keyframes my-cue-in \{[\s\S]*?translate3d\(0,-64px,60px\) scale\(1\.07\)[\s\S]*?translate3d\(0,0,-1px\) scale\(\.994\)[\s\S]*?transform:none/, 'Material cue flies and rebounds in one continuous curve with a small overshoot');
assert.match(css, /my-cue-in 420ms[\s\S]*?--my-cue-delay/, 'Material cue duration overlaps the next card delay');

console.log('material-home: template/mirror parity, flower clock, theme gating, live counts, controls and responsive CSS passed');
