/* 存储圆环：在磁盘已用弧上叠加 SubFabric 数据占用，颜色取主题第二强调色。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'editor/js/storage.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(html, /id="stg-ring-app"/, '圆环有 SubFabric 占用层');
assert.match(html, /id="stg-app-size"[\s\S]*?id="stg-app-pct"/, '有 SubFabric 占用读数和占比');
assert.match(src, /const appBytes = \(state\.items \|\| \[\]\)\.reduce/, '按扫描项目汇总 SubFabric 占用');
assert.match(src, /stg-ring-app/, '写入 SubFabric 弧长');
assert.match(src, /占已用/, '显示占已用比例');
assert.match(src, /size \/ totalCat >= 0\.001/, '小于 0.1% 的分类不画进条，避免右端被压成 0px');
assert.match(src, /barTotal/, '条内百分比按实际绘制分类归一化');
assert.match(css, /\.stg-ring-app \{[^}]*stroke: var\(--accent\)[^}]*hue-rotate\(135deg\)/, 'SubFabric 弧使用主题色的互补色相');
assert.match(css, /\.stg-app-line i \{[^}]*background:var\(--accent\)[^}]*hue-rotate\(135deg\)/, '图例圆点同色');
assert.match(css, /\.stg-bar \{[^}]*clip-path: inset\(0 round 999px\)/, '存储条整体裁成半圆端，避免小分段裁切');
console.log('storage-ring: SubFabric 占用层与主题色可视化通过');
