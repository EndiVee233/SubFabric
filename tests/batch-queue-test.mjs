/* 批量初稿独立页：视频队列、全局/单个设置、串行处理契约。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const html = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'editor/js/project.js'), 'utf8');
const studio = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.equal(html, tpl, 'studio.html 与模板一致');
for (const id of ['batch-view', 'batch-add', 'batch-files', 'batch-list', 'batch-start', 'batch-summary', 'batch-model', 'batch-scheme']) {
  assert.match(tpl, new RegExp(`id="${id}"`), `批量页包含 ${id}`);
}
assert.match(tpl, /id="batch-item-overlay"[\s\S]*id="batch-item-model"[\s\S]*id="batch-item-scheme"/, '单个视频设置弹窗有模型/方案');
assert.match(css, /\.batch-list \{[\s\S]*?flex-direction:column/, '队列纵向排列');
assert.match(js, /const batchState = \{ items: \[\], running: false/, '队列状态存在');
assert.match(js, /for \(const item of pending\) \{/, '队列按顺序逐个处理');
assert.doesNotMatch(js.slice(js.indexOf('async function batchStart'), js.indexOf('$(\'#batch-add\')')), /Promise\.all/, '批处理不并行');
assert.match(js, /await batchWaitDraft\(item\)/, '前一个完成后再继续');
assert.match(js, /data-batch-settings/, '每个视频有单独设置按钮');
assert.match(js, /#\/batch/, '按钮进入独立批量页');
assert.match(studio, /batch: '批量初稿'/, '面包屑标题');
assert.match(studio, /h === '#\/batch'/, '路由识别批量页');
console.log('batch-queue: 独立页、队列、全局/单个设置与串行处理接线通过');
