import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 性能页卡片间距回归。
 *
 * 「双引擎分工」页签里是两张并排堆叠的 `.st-section`（测试卡片 + 当前已应用配置）。
 * `.st-panel` 的 flex gap 只作用到 `.perf-view` 这一层，两张卡片直接相邻时没有间距；
 * 而设置页卡片规则带 `#st-view` ID 选择器且写死 `margin:0`，不能靠给 `.st-section`
 * 加 margin 解决。这里钉住「间距由 .perf-view 的 flex gap 提供」以及两段 HTML 结构。
 */
const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const production = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');

assert.equal(production, template, 'production studio.html stays byte-identical to the template');
assert.match(css, /\.perf-view \{ display: flex; flex-direction: column; gap: 16px; \}/,
  'perf views stack their cards with a vertical gap');
assert.match(css, /\.perf-view\[hidden\] \{ display: none; \}/,
  'the flex layout still respects the hidden tabs');
assert.match(template, /<div id="perf-dual-view"[\s\S]*?<div class="st-section">[\s\S]*?<\/div>\s*<div class="st-section">/,
  'dual-engine test card and applied-config card are sibling sections inside the perf view');

console.log('perf-view-spacing-test: ok');
