import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const editor = fs.readFileSync(path.join(root, 'editor/js/editor.js'), 'utf8');
const studio = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.match(css, /@keyframes settings-group-in \{[\s\S]*?opacity:\s*0;[\s\S]*?translateY\(8px\)[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*none/, 'settings groups fade in and rise slightly');
assert.match(css, /#tab-settings \.settings-list\.is-settings-entering > \.set-group[\s\S]*?animation:\s*settings-group-in 260ms[\s\S]*?--settings-i/, 'settings groups are staggered by index');
assert.match(css, /is-settings-entering > \.st-card[\s\S]*?settings-group-in/, 'dynamically mounted settings cards share the entrance');
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?is-settings-entering > \.set-group[\s\S]*?animation: none;/, 'reduced motion disables the settings entrance');
assert.match(editor, /_settingsEnterPlayed/, 'settings entrance is tracked as a one-shot flag');
assert.match(editor, /name === 'settings'[\s\S]*?const animate = !this\._settingsEnterPlayed;[\s\S]*?this\._settingsEnterPlayed = true;[\s\S]*?_animateSettings\(\)/, 'only the first settings-tab click after entering the editor animates');
assert.match(editor, /_animateSettings\(\) \{[\s\S]*?is-settings-entering[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?remove\('is-settings-entering'\)/, 'the settings entrance class is cleaned up');
assert.match(editor, /setFileName\(name\) \{[\s\S]*?this\.resetEntranceAnimations\(\);/, 'loading a file resets the settings entrance');
assert.match(studio, /!wasEditor[\s\S]*?resetEntranceAnimations/, 're-entering the editor route resets the settings entrance');

console.log('Editor settings entrance: fade/rise stagger, one-shot per editor entry and reduced-motion fallback passed');
