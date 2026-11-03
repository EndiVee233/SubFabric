/* 侧栏底部「设置 / 帮助」与主导航的垂直间距一致。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(css, /\.sf-nav-bottom \{ display: flex; flex-direction: column; gap: inherit; \}/,
  '底部导航继承主导航 gap');
assert.match(css, /\.sf-nav a \{ display:flex; align-items:center; gap:12px;/, '主导航仍使用统一链接样式');
assert.match(css, /\.sf-folder>button:first-child:hover \{[^}]*background:var\(--surface-2\)/, '文件夹悬浮可见');
console.log('nav-spacing: 侧栏底部导航与主导航间距一致');
