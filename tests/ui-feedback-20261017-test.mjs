/**
 * 2026-10-17 用户反馈 6 项的回归钉：
 *   1. 在角色/设置/日志页新增字幕后自动切回字幕页
 *   2. Ctrl+左键拖动后的批量浮条不能被时间轴的 backdrop-filter 包含块推到视口外
 *   3. 右下角任务卡失败后不再转圈
 *   4. 时间轴字幕块不显示行首 [角色名]，但块颜色（角色色）保留
 *   5. 从其它页切回字幕列表时，播放高亮/滚动立即回到当前播放句
 *   6. 查找替换弹窗不压暗背景，并收紧叠加的纵向间距
 *
 * 这些是 UI/DOM 行为，Node 侧用真实源码文本 + 抽出的纯函数做保护；
 * 真实鼠标与几何验收另见本轮 CDP 探针（不进入 run-all，避免依赖浏览器/项目数据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const html = read('editor', 'studio.html');
const tpl = read('tools', 'templates', 'studio.html');
const css = read('editor', 'css', 'studio.css');
const main = read('editor', 'js', 'main.js');
const editor = read('editor', 'js', 'editor.js');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

/* ── 抽纯函数：timelineBlockBody（时间轴块正文） ── */
const fnStart = main.indexOf('function timelineBlockBody(');
const fnEnd = fnStart >= 0 ? main.indexOf('\n}', fnStart) : -1;
const fn = (fnStart >= 0 && fnEnd > fnStart) ? main.slice(fnStart, fnEnd + 2) : null;
ok(fn !== null, '抽到 timelineBlockBody');
let strip = null;
if (fn) strip = new Function(fn + '; return timelineBlockBody;')();
console.log('\n== 4. 时间轴块：去掉行首角色名，正文与颜色保留 ==');
ok(strip('[Wemmbu] 这就是废弃文明的模样') === '这就是废弃文明的模样', '去掉行首 [角色名] + 空格');
ok(strip('  [Gav] 正文') === '正文', '前导空格也收掉');
ok(strip('没有角色标签的正文') === '没有角色标签的正文', '没有标签时原样保留');
ok(strip('正文里 [Gav] 不是行首') === '正文里 [Gav] 不是行首', '只处理行首，正文中的方括号不动');
ok(strip('{音效} [Gav] 正文') === '{音效} [Gav] 正文', '正文里的 {..} 不被当成 ASS 标签吞掉');
ok(strip('') === '' && strip(null) === '', '空值不崩');
ok(/text2:\s*timelineBlockBody\(\(zhText \|\| ''\)\.slice\(0, 60\)\)/.test(main),
  'ASS 双语块的中文行也走同一条去名逻辑');
ok(/text:\s*timelineBlockBody\(\(enText \|\| ''\)\.slice\(0, 60\)\)/.test(main),
  'ASS 双语块的英文行也走同一条去名逻辑');
ok(/text:\s*timelineBlockBody\(zhText\.slice\(0, 60\)\)/.test(main)
  && /text:\s*timelineBlockBody\(enText\.slice\(0, 60\)\)/.test(main),
  '单语孤行（半块）同样不显示角色名');
ok(/color, speaker: row\.speaker/.test(main) || /color, speaker:/.test(main),
  '块的角色色字段仍在下传（颜色没有跟着名字一起删）');

console.log('\n== 1. 新增字幕后自动切回字幕页 ==');
ok((main.match(/panel\.showTab\('subs'\)/g) || []).length >= 2,
  'SRT 与 ASS 两条 createRowAt 分支都切回字幕页');
const createSeg = main.slice(main.indexOf('function createRowAt('),
  main.indexOf('timeline.onCreate'));
ok(/rebuildItemsAndLanes\(true, true\);[\s\S]{0,500}panel\.showTab\('subs'\);[\s\S]{0,300}panel\.startEdit/.test(createSeg),
  '切页发生在重建列表之后、进入行内编辑之前（新行可见并可输入）');

console.log('\n== 2. Ctrl 拖动浮条不能被时间轴的固定定位包含块吃掉 ==');
const tlStart = html.indexOf('<div id="tl-canvas-wrap">');
const sectionEnd = html.indexOf('</section>', tlStart);
const tlBlock = html.slice(tlStart, sectionEnd);
ok(tlStart > 0 && sectionEnd > tlStart, '找到时间轴容器');
ok(!tlBlock.includes('id="range-bar"'), '批量浮条已移出 #tl-canvas-wrap / #timeline-panel');
ok(html.indexOf('id="range-bar"') > html.indexOf('id="vsplit"'),
  '批量浮条位于 #app 之外（处于 body 的固定定位坐标系）');
ok(html.indexOf('id="range-bar"') > 0 && html.indexOf('id="fr-overlay"') > html.indexOf('id="range-bar"'),
  '批量浮条仍是独立元素，未落进其它 fixed 容器的包含块');
ok(/backdrop-filter:blur\(var\(--sf-glass-blur\)\)!important/.test(css)
  && /#timeline-panel/.test(css), '确认时间轴仍会建立固定定位包含块（这是移出浮条的原因）');
ok(html === tpl, 'editor/studio.html 与生成模板逐字节一致（改模板后已重新生成）');

console.log('\n== 3. 失败任务卡停止转圈 ==');
ok(/#job-card\.jc-err \.jc-spin \{ display: none; \}/.test(css),
  'jc-err 时隐藏转圈');
ok(/#job-card\.jc-done \.jc-spin \{ display: none; \}/.test(css),
  '成功时仍隐藏转圈（原有行为不丢）');
const doneSeg = main.slice(main.indexOf('function jobCardDone('), main.indexOf('function jobCardHide('));
ok(/classList\.add\(ok \? 'jc-done' : 'jc-err'\)/.test(doneSeg),
  'jobCardDone 失败分支确实加 jc-err（CSS 才有机会命中）');
ok(/classList\.remove\('jc-indet'\)/.test(doneSeg),
  '结束态同时撤掉不确定进度条纹（不会一直动）');

console.log('\n== 5. 切回字幕页立即同步播放进度 ==');
ok(/this\._playingT = null;/.test(editor), '记录最近播放时间');
ok(/setPlayingByTime\(t, force = false\)/.test(editor), 'setPlayingByTime 支持强制同步');
ok(/this\._playingT = t;/.test(editor), '每次播放 tick 都更新最近时间');
ok(/if \(this\._tab !== 'subs' \|\| !this\.listEl\.clientHeight\) return;/.test(editor),
  '字幕页隐藏时不做滚动（否则会把 scrollTop 重置到 0）');
ok(/if \(found === this\.playingItem && !force\) return;/.test(editor),
  '非强制时仍保留原来的轻量短路');
ok(/syncPlaying\(\) \{[\s\S]{0,200}setPlayingByTime\(this\._playingT, true\)/.test(editor),
  'syncPlaying 用最近播放时间强制重定位');
const showTabSeg = editor.slice(editor.indexOf('showTab(name) {'), editor.indexOf('/** 角色(说话人)列表'));
ok(/const prevTab = this\._tab;/.test(showTabSeg), 'showTab 记录切换前的页签');
ok(/if \(prevTab !== 'subs'\) this\.syncPlaying\(\);/.test(showTabSeg),
  '从别的页切回字幕页时触发同步');

console.log('\n== 6. 查找替换：不压暗背景 + 收紧纵向间距 ==');
ok(/#fr-overlay\s*\{[\s\S]{0,500}?background: transparent;/.test(css),
  '查找替换遮罩背景透明（不再压暗）');
const dimRule = css.match(/#confirm-overlay,[^{]*\{[^}]*rgba\(5, 5, 8/);
ok(!!dimRule && !dimRule[0].includes('#fr-overlay'),
  '统一的黑玻璃遮罩分组不再包含 #fr-overlay（其它弹窗不受影响）');
ok(/#fr-overlay \.fr-box \{[\s\S]{0,300}background: var\(--bg-2\) !important;/.test(css),
  '查找弹窗自身保持不透明实底（移除压暗后表单不会透出视频）');
ok(/\.fr-box \{[\s\S]{0,200}gap: 10px;/.test(css), '弹窗纵向 gap 从 14px 收紧到 10px');
ok(/#fr-overlay \.fr-head \{ padding-bottom: 8px; margin-bottom: 0; \}/.test(css),
  '标题栏不再与 flex gap 叠加出双份间距');
ok(/#fr-overlay \.fr-actions \{ padding-top: 8px; margin-top: 0; \}/.test(css),
  '按钮栏不再与 flex gap 叠加出双份间距');
ok(/#fr-pane-text, #fr-pane-role \{ display: flex; flex-direction: column; gap: 8px; \}/.test(css),
  '正文/角色面板的输入区与提示条统一 gap');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
