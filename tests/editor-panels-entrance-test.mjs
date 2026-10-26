/* 编辑器入场：三大板块 CSS 错峰 + 时间轴字幕块从左到右逐个淡入（纯逻辑 + 静态契约）。
 *
 *  · studio.js 在每次进入编辑器/切换稿件/刷新时给 #app 加 is-editor-panels-entering，
 *    并派发 sf-editor-panels-enter；CSS 按 0/90/180ms 让视频区、右侧列表、时间轴依次浮现。
 *  · 时间轴是 canvas，字幕块没法用 CSS 动画：Timeline 在面板动画结束后按可见顺序
 *    给每块算 opacity/位移（_blockEnterProgress），由主循环重绘。
 *  · 刷新时 studio.js 的事件早于 Timeline 构造，Timeline 看 #app 上的类补一次。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const css = read('editor/css/studio.css');
const studio = read('editor/js/studio.js');
const timelineSrc = read('editor/js/timeline.js');

/* ── CSS：三大板块按顺序淡入，且跟随“减少动效” ── */
assert.match(css, /@keyframes sf-editor-panel-in\s*\{[\s\S]*?translate:0 14px/, '板块入场动效存在');
assert.match(css, /#app\.is-editor-panels-entering #stage-wrap \{ --sf-panel-delay:0ms; \}/, '视频区第一个');
assert.match(css, /#app\.is-editor-panels-entering #editor-panel \{ --sf-panel-delay:90ms; \}/, '右侧列表第二个');
assert.match(css, /#app\.is-editor-panels-entering #timeline-panel \{ --sf-panel-delay:180ms; \}/, '时间轴第三个');
assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?#app\.is-editor-panels-entering/, '减少动效时关闭');

/* ── studio.js：进入/切换/刷新都触发，并通知时间轴 ── */
assert.match(studio, /function animateEditorPanels\(\)/, '入场入口函数存在');
assert.match(studio, /sf-editor-panels-enter/, '面板入场开始时通知时间轴');
assert.match(studio, /const firstRoute = !routeBooted/, '刷新被当作第一次路由');
assert.match(studio, /if \(firstRoute \|\| !wasEditor \|\| h !== previous\) animateEditorPanels\(\)/,
  '刷新 / 进入编辑器 / 切换稿件时触发');

/* ── timeline.js：字幕块入场只从面板结束后开始，且左→右错峰 ── */
assert.match(timelineSrc, /BLOCK_ENTER_STAGGER/, '块间错峰常量存在');
assert.match(timelineSrc, /sf-editor-panels-enter/, '时间轴监听面板入场事件');
assert.match(timelineSrc, /_panelEntranceWait\(\)/, '按面板动画剩余时长推迟块入场');
assert.match(timelineSrc, /_blockEnterProgress\(rank\)/, '绘制时按可见顺序计算每块进度');
assert.match(timelineSrc, /ctx\.globalAlpha \*= enterP/, '块逐个淡入');
assert.doesNotMatch(timelineSrc, /translate\(0, \(1 - enterP\)/, '字幕块不再做上浮位移');
assert.doesNotMatch(timelineSrc, /sy \/ dpr \+ \(1 - p\)/, '预渲染块合成也不带上浮偏移');
assert.match(timelineSrc, /const blockAnimating = this\._blockEnterArmed/, '入场窗口内保持重绘');
assert.match(timelineSrc, /if \(enterP <= 0\) continue;/, '还没轮到的块完全不画（负载优化）');
assert.match(timelineSrc, /const BLOCK_ENTER_BLUR = 300/, '浮现结束后模糊渐入时长');
assert.match(timelineSrc, /const BLOCK_ENTER_DUR = 480/, '单块浮现时长已放慢');
assert.match(timelineSrc, /const BLOCK_ENTER_STAGGER = 28/, '块间错峰已放慢');
assert.match(timelineSrc, /if \(this\._blockEnterNow < blocksEnd\) return;/, '浮现阶段完全不画遮罩（省一次全画布合成）');
assert.match(timelineSrc, /_buildBlockBackdrop\(W, true\)/, '模糊遮罩只预建一次');
assert.match(timelineSrc, /ctx\.drawImage\(blur/, '浮现结束后渐变到模糊位图');
assert.match(timelineSrc, /if \(this\._blockEnterNow < blocksEnd\)/, '模糊只在块全部浮现后开始渐入');
assert.match(timelineSrc, /_backdropKey\(W\)/, '视野/尺寸/轨道变化会让遮罩缓存失效');
assert.match(timelineSrc, /_blockEnterWaveWait/, '浮现会等波形就绪');
assert.match(timelineSrc, /setBlockEntranceWaveExpected\(expect\)/, '项目侧可以告知是否应该等波形');
assert.match(timelineSrc, /_noteWaveRendered\(\)/, 'setPeaks/setWaveform 就绪后释放等待');
assert.match(timelineSrc, /_ensureEnterBase\(W, H\)/, '入场期间静态底图缓存');
assert.match(timelineSrc, /ctx\.drawImage\(base, 0, 0, W, H\)/, '逐帧只合成底图，不再重画整条波形');
assert.match(timelineSrc, /_ensureEnterSprites\(W, H\)/, '所有可见块预渲染成块层');
assert.match(timelineSrc, /ctx\.drawImage\(layer, sx, sy, sw, sh/, '逐帧只按块裁剪合成位图，不重排文字');
assert.match(timelineSrc, /_drawLanes\(c, W, this\._lastT \|\| 0, \{ blocksOnly: true, forceFull: true, collect: rects \}\)/, '块层一次性渲染');
assert.match(timelineSrc, /restartBlockEntrance\(\)/, '解析完成后重新起算入场');
assert.match(read('editor/js/main.js'), /timeline\.restartBlockEntrance\?\.\(\)/, 'ASS/SRT 构建完成时重排入场时间');
assert.match(read('editor/js/project.js'), /setBlockEntranceWaveExpected\?\./, '打开项目时把波形预期传给时间轴');

const { Timeline } = await import('./jsmod/timeline.js');
const progress = (state, rank) => Timeline.prototype._blockEnterProgress.call(state, rank);
const base = () => ({ _blockEnterArmed: true, _blockEnterAt: 1000, _blockEnterNow: 1000 });
assert.equal(progress(base(), 0), 0, '面板刚结束时第一块还未出现');
assert.equal(progress(base(), 5), 0, '靠后的块还没轮到');

const atHalf = base();
atHalf._blockEnterNow = 1000 + 240;
assert.ok(progress(atHalf, 0) > 0.8 && progress(atHalf, 0) < 1, '第一块 240ms 时接近完成');
assert.equal(progress(atHalf, 9), 0, '后面的块仍在等待');

const ordered = base();
ordered._blockEnterNow = 1000 + 100;
assert.ok(progress(ordered, 0) > progress(ordered, 1), '同一时刻左边的块更靠前');
assert.ok(progress(ordered, 1) > progress(ordered, 2), '顺序严格从左到右');

const done = base();
done._blockEnterNow = 1000 + 2000;
assert.equal(progress(done, 0), 1, '窗口结束后完全显示');
assert.equal(progress({ _blockEnterArmed: false }, 0), 1, '未启用入场时直接显示');

const capped = { _blockEnterArmed: true, _blockEnterAt: 1000, _blockEnterNow: 1000 + 392 + 240 };
assert.ok(progress(capped, 999) > 0.8, '块很多时延迟封顶，不会无限等待');

console.log('editor-panels-entrance: 三板块错峰 + 时间轴字幕块左→右淡入通过');
