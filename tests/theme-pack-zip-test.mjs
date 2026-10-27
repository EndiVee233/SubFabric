/* 主题包 ZIP：store 模式读写 + 页面布局声明的安全校验。
 *
 * 导出应是一个 .zip：theme.json + layouts/{home,library,editor,help}.json；
 * 导入时若 ZIP 里有布局文件则覆盖 theme.json 里的同名页，再交给 themes.valid()。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { makeZip, readZip, textOf } from './jsmod/zip.js';

const root = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const files = [
  { name: 'theme.json', text: '{"schema":"subfabric-theme-v1"}' },
  { name: 'layouts/home.json', text: JSON.stringify({ widgets: ['processing', 'ready'] }) },
  { name: 'layouts/帮助.json', text: '{"columns":3}' },
];
const blob = makeZip(files);
const bytes = new Uint8Array(await blob.arrayBuffer());
assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b); assert.equal(bytes[2], 3); assert.equal(bytes[3], 4);
const back = readZip(bytes);
assert.equal(back.size, 3, '三个条目都写入');
assert.equal(textOf(back.get('theme.json')), files[0].text);
assert.deepEqual(JSON.parse(textOf(back.get('layouts/home.json'))), { widgets: ['processing', 'ready'] });
assert.equal(textOf(back.get('layouts/帮助.json')), '{"columns":3}', 'UTF-8 文件名可往返');
assert.throws(() => readZip(new Uint8Array([1, 2, 3, 4, 5])), /ZIP|压缩包/);

const context = { window: {} };
vm.createContext(context);
vm.runInContext(read('editor/js/studio-themes.js'), context);
const themes = context.window.SF_THEMES;
const base = {
  schema: 'subfabric-theme-v1', id: 'layout-pack', name: 'Layout Pack', version: '1.0.0',
  description: 'layout', design: 'material', seed: '#5789dc',
};
const layouts = {
  home: { widgets: ['processing', 'ready'] },
  library: { view: 'list', columns: 2 },
  editor: { timelineHeight: 260, panelWidth: 420, splitPane: 'notes' },
  help: { columns: 3 },
};
assert.equal(themes.valid({ ...base, layouts }), true, '四个页面的布局声明合法');
assert.equal(themes.valid({ ...base, layouts: { ...layouts, home: { widgets: ['<script>'] } } }), false, 'widget key 只允许标识符');
assert.equal(themes.valid({ ...base, layouts: { ...layouts, library: { columns: 9 } } }), false, '列数越界拒绝');
assert.equal(themes.valid({ ...base, layouts: { ...layouts, editor: { timelineHeight: 10 } } }), false, '时间轴高度越界拒绝');
assert.equal(themes.valid({ ...base, layouts: { ...layouts, help: { columns: 4 } } }), false, '帮助页列数越界拒绝');
assert.equal(themes.valid({ ...base, layouts: { ...layouts, settings: {} } }), false, '只允许四个页面');
const stored = themes.asCustom({ ...base, layouts });
assert.deepEqual(JSON.parse(JSON.stringify(stored.layouts)), layouts, 'asCustom 保留布局');

const studio = read('editor/js/studio.js');
const tpl = read('tools/templates/studio.html');
assert.match(studio, /await import\('\.\/zip\.js'\)/, 'zip 读写动态加载（旧服务缺文件也不会拖垮界面）');
assert.doesNotMatch(studio, /^import \{ makeZip/m, 'zip 模块不能顶层静态 import');
assert.match(studio, /function zipStore\(files\)/, '内置 store ZIP 兜底存在');
assert.match(studio, /function zipRead\(buffer\)/, '内置 ZIP 读取兜底存在');
assert.match(studio, /let writeZip = zipStore;[\s\S]*?await import\('\.\/zip\.js'\)/, '导出优先动态模块、失败用兜底');
assert.match(studio, /function layoutsSnapshot\(\)/, '导出采集四页布局');
assert.match(studio, /`\$\{pack\.id\}\.theme\.zip`/, '导出扩展名为 .theme.zip');
assert.match(studio, /layouts\/\$\{page\}\.json/, 'ZIP 内按页写布局文件');
assert.match(studio, /files\.get\(`layouts\/\$\{page\}\.json`\)/, '导入优先读 ZIP 内的布局文件');
assert.match(studio, /applyLayouts\(layouts\)/, '导入/选中主题包应用布局');
assert.match(tpl, /id="sf-theme-file" accept="\.zip,application\/zip,\.json,application\/json"/, '导入支持 zip 与旧 json');
console.log('theme-pack-zip: store ZIP 往返、UTF-8 文件名、四页布局校验与导入导出接线通过');
