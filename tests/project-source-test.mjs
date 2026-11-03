/* 本地视频项目可单独解析在线链接补元数据；不下载链接视频、不改字幕/进度。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const template = read('tools/templates/studio.html');
const project = read('editor/js/project.js');
const server = read('editor/server.js');
assert.match(template, /id="detail-url"[\s\S]*?id="detail-probe"/, '详情页有独立的在线链接解析入口');
assert.match(project, /detail-probe/, '详情页解析按钮已接线');
assert.match(project, /body: JSON\.stringify\(\{ name, source \}\)/, '解析结果随项目信息保存');
assert.match(project, /isDraft && npUrl && !npVideo\.path/, '有本地视频时优先生成本地初稿，不下载链接');
assert.match(project, /payload\.source = npUrlSource/, '本地视频初稿也带上解析到的元数据');
assert.match(server, /function cleanProjectSource/, '服务端清理在线元数据');
assert.match(server, /if \(manualSource\) meta\.source = manualSource/, '创建本地项目时保存元数据');
assert.match(server, /if \(data\.source !== undefined\)/, '详情页 info 支持更新元数据');
const studio = read('editor/js/studio.js');
assert.match(studio, /cover\.classList\.toggle\('has-cover'/, '有封面时标记卡片封面状态');
assert.match(read('editor/css/studio.css'), /\.sf-cover\.has-cover>svg/, '有封面时隐藏占位图标/文字');
console.log('project-source: 本地视频/详情页单独解析在线链接并保存元数据');
