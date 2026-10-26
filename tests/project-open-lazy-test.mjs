/* 打开稿件的加载路径（静态契约）：少解析一遍、只重建一次、网络并行、libass 延后。
 *
 * 背景（用户反馈"打开稿件/刷新等待久"）：
 *  · 旧 openProject 先 `new AssDoc(text).events` 校验、再 routeSub 里再构造一次 AssDoc ——
 *    3~4MB 的 ASS 白解析两遍；
 *  · project meta 与字幕串行请求；
 *  · 先 routeSub 建一次列表，openProject 末尾 __realignRefresh() 又整份重建一次；
 *  · 视频/波形要等字幕解析完才开始请求；
 *  · setAss 末尾同步 serialize 整份 ASS + 初始化 libass worker，挡住首屏。
 * 现在：并行取 meta+字幕、轻量校验、先装项目身份再只建一次、视频/波形提前请求、
 * libass 首帧后再加载、peaks 并发请求合并。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'editor/js/project.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'editor/js/main.js'), 'utf8');
const openStart = src.indexOf('async function openProject(pid)');
const openEnd = src.indexOf('\n  function promptRelink(', openStart);
assert.ok(openStart > 0 && openEnd > openStart, 'openProject 存在');
const open = src.slice(openStart, openEnd);

assert.match(open, /Promise\.all\(\[[\s\S]*?fetch\('\/api\/projects\/' \+ pid\)[\s\S]*?\/subtitle`/, '项目元信息与字幕并行请求');
const openCode = open.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
assert.doesNotMatch(openCode, /new AssDoc\(text\)\.events/, '不再为校验把整份 ASS 解析一遍');
assert.match(open, /\/\(\^\|\\n\)\\s\*Dialogue\\s\*:\/i/, 'ASS 用轻量的 Dialogue 行校验');
const projectAt = open.indexOf('state.project = { id: pid, meta: m, loadPeaks }');
const routeAt = open.indexOf('routeSub(text, name)');
assert.ok(projectAt > 0 && routeAt > projectAt, '先装项目身份再同步构建一次字幕');
assert.doesNotMatch(open, /__realignRefresh/, '不再在打开末尾整份重建第二次');
assert.ok(open.indexOf('loadVideoUrl(') < routeAt, '视频请求在同步解析之前就开始');
assert.ok(open.indexOf('handlePrepare(m)') < routeAt, '波形请求在同步解析之前就开始');

assert.match(src, /let peaksInFlight = null, peaksTarget = null;/, 'peaks 并发请求合并');
assert.match(src, /if \(peaksInFlight && peaksTarget === project\) return peaksInFlight;/, '同一项目复用进行中的 peaks 请求');

assert.match(main, /function scheduleAssRender\(doc, fonts\)/, 'libass 整轨加载有延后入口');
assert.match(main, /requestAnimationFrame\(\(\) => \{ assRenderTimer = setTimeout\(run, 0\); \}\)/, '首帧绘制后再 serialize ASS + 初始化 worker');
assert.match(main, /scheduleAssRender\(state\.assDoc, renderFonts\)/, 'setAss 走延后加载');
const setAssAt = main.indexOf('function setAss(');
const setAssEnd = main.indexOf('\n}\n', setAssAt);
assert.ok(setAssAt > 0 && setAssEnd > setAssAt, 'setAss 存在');
assert.doesNotMatch(main.slice(setAssAt, setAssEnd), /assPlayer\.load\(/, 'setAss 内不再同步加载整轨');

console.log('project-open-lazy: 少解析一遍 / 只建一次 / 网络并行 / libass 延后 / peaks 合并通过');
