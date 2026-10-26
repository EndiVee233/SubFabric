import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const editor = fs.readFileSync(path.join(root, 'editor/js/editor.js'), 'utf8');
const studio = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.match(css, /@keyframes role-card-in \{[\s\S]*?opacity:\s*0;[\s\S]*?translateY\(10px\) scale\(\.96\)[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*none/, 'role cards get a fade-in, slight scale and upward entrance');
assert.match(css, /\.role-list\.is-role-entering \.role-card \{[\s\S]*?animation:\s*role-card-in 260ms[\s\S]*?--role-i/, 'the entrance is staggered by the card index');
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?role-list\.is-role-entering \.role-card \{ animation: none; \}/, 'reduced motion disables the role entrance');
assert.match(editor, /const animate = !this\._roleEnterPlayed;[\s\S]*?this\._roleEnterPlayed = true;[\s\S]*?this\._renderRoles\(animate\)/, 'only the first roles-tab click after entering the editor plays the entrance');
assert.match(editor, /setFileName\(name\) \{[\s\S]*?this\.resetEntranceAnimations\(\);/, 'loading or switching a file resets the one-shot entrance');
assert.match(studio, /!wasEditor[\s\S]*?resetEntranceAnimations/, 'entering the editor route starts a new one-shot session');
assert.match(editor, /_renderRoles\(animate = false\)/, 'data refreshes do not replay the entrance by default');
assert.match(editor, /style="--role-i:\$\{i\}"/, 'each role card carries its stagger index');
assert.match(editor, /role-add" style="--role-i:\$\{this\._roles\.length\}"/, 'the add-role card joins the stagger');
assert.match(editor, /el\.classList\.add\('is-role-entering'\)[\s\S]*?setTimeout\(\(\) => el\.classList\.remove\('is-role-entering'\)/, 'the entrance class is cleaned up after the animation');
/* 并排侧栏「人物」列表：首次真正看到且有角色时，也走同一套逐个入场。 */
assert.match(editor, /_splitRoleEnterPlayed = false/, 'split pane keeps its own one-shot entrance flag');
assert.match(editor, /_renderSplitRoles\(\) \{[\s\S]*?!this\._splitRoleEnterPlayed && this\._roles\.length > 0[\s\S]*?this\._renderRoles\(animate\)/, 'split pane animates once, only with real roles');
assert.match(editor, /const visible = !el \|\| !el\.hidden;/, 'hidden (notes) pane does not consume the entrance');
assert.match(editor, /_switchSplitPane[\s\S]*?else if \(this\._splitRoles\) this\._renderSplitRoles\(\);/, 'switching back to 人物 replays the entrance if not played');
assert.match(editor, /resetEntranceAnimations\(\) \{[\s\S]*?this\._splitRoleEnterPlayed = false;/, 'a new editor session resets the split pane entrance too');

console.log('Role list entrance: fade/scale/up stagger, one-shot per editor entry and reduced-motion fallback passed');
