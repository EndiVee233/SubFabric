/* 翻译方案导出/导入：JSON 文件、不带 API Key、重名自动加后缀。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const project = fs.readFileSync(path.join(root, 'editor/js/project.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');
assert.match(template, /id="st-scheme-import"/, '方案导入按钮存在');
assert.match(template, /id="st-scheme-export"/, '方案导出按钮存在');
assert.match(template, /id="st-scheme-file"[^>]*application\/json/, '导入文件选择器接受 JSON');
assert.match(project, /subfabric\.translate-schemes/, '导出格式标识');
assert.match(project, /schemeFileFields[\s\S]*?hasKey/, '导出字段包含 hasKey 但不含 apiKey');
assert.doesNotMatch(project.slice(project.indexOf('function schemeExportJson'), project.indexOf('function downloadSchemeFile')),
  /apiKey/, '导出函数不写 API Key');
assert.match(project, /（导入 \$\{n\}）/, '重名方案自动加后缀');
assert.match(css, /\.st-scheme-actions/, '方案导入导出按钮布局');
console.log('translation-schemes-io: 方案 JSON 导入/导出与重名处理通过');
