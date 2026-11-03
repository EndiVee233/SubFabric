/* 设置卡片间距与术语输入聚焦框：聚焦环不能被滚动容器裁掉。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(css, /#st-view \.st-body \{[^}]*gap:24px/, '翻译/术语设置卡片垂直间距 24px');
assert.match(css, /st-scheme-inline \.st-card \{[^}]*margin:0 0 16px/, '添加方案子卡片垂直间距 16px');
assert.match(css, /#st-view \.gl-input:focus \{ outline:none; box-shadow:inset 0 0 0 1px var\(--accent\); \}/,
  '术语输入聚焦使用内阴影，不被 .gl-rows 裁切');
assert.match(css, /\.glossary-row input:focus \{[^}]*box-shadow:inset 0 0 0 1px var\(--accent\)/,
  '术语表弹窗输入聚焦同样使用内阴影');
assert.match(css, /data-design=uwp\] \.sf-theme-color-panel \{ padding:14px 16px 12px/, 'UWP 主题色面板高度收紧');
console.log('settings-gap-focus: 卡片间距与术语输入聚焦环通过');
