import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'tools/templates/studio.html'), 'utf8');
const production = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
const studioSource = fs.readFileSync(path.join(root, 'editor/js/studio.js'), 'utf8');
const studio = studioSource.replace(/\r\n/g, '\n');
const mirror = fs.readFileSync(path.join(root, 'tests/jsmod/studio.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'editor/css/studio.css'), 'utf8');

assert.equal(production, template, 'production studio.html stays byte-identical to the template');
assert.equal(mirror, studioSource, 'studio.js test mirror stays byte-identical to production');

for (const id of [
  'dashboard-view', 'sf-mu-home', 'sf-mu-new', 'sf-mu-resume', 'sf-mu-next-title',
  'sf-mu-next-meta', 'sf-mu-resume-cta', 'sf-mu-temp', 'sf-mu-status-num', 'sf-mu-greeting', 'sf-mu-edits-total',
]) assert.match(template, new RegExp(`id="${id}"`), `${id} is present in the homepage template`);

assert.match(template, /class="sf-hero"/, 'Material You uses the legacy three-column hero');
assert.match(template, /class="sf-flower"/, 'new-work entry uses the Material flower silhouette');
assert.match(template, /class="sf-resume"/, 'resume card is present');
assert.match(template, /id="sf-mu-resume-detail">详情信息/, 'resume card has details button');
assert.match(studio, /#\/details\/.*encodeURIComponent\(id\)/, 'details button opens the details route');
assert.match(css, /\.sf-resume-actions \.btn:hover \{[^}]*border-color:var\(--accent\)[^}]*translateY\(-1px\)/, 'resume buttons lift and light on hover');
assert.match(template, /class="sf-mu-widget sf-mu-combo"[\s\S]*?data-mu-action="new"[\s\S]*?data-mu-action="batch"/,
  '新建稿件长卡内嵌批量初稿子选项');
assert.match(css, /\.sf-mu-combo \{[^}]*grid-column:span 2;/, '合并卡横跨两列');
assert.match(css, /\.sf-mu-combo-main \{[^}]*position:absolute; inset:0;/, '新建稿件主卡铺满整张长卡');
assert.match(css, /\.sf-mu-combo-batch \{[^}]*position:absolute; top:8px; right:8px; bottom:8px; z-index:2; width:47.5%/, '批量初稿覆盖在右侧且边界对齐');
assert.doesNotMatch(css, /\.sf-mu-combo:hover \.sf-mu-combo-batch \{[^}]*border-color/, '仅悬浮子卡时亮框');
assert.match(css, /\.sf-mu-combo-batch:hover \{[^}]*translateY\(-1px\)[^}]*border-color:var\(--accent\)/, '批量初稿悬浮轻微上浮并亮框');
assert.match(studio, /dashboardViewEl\.classList\.add\('is-scrolling'\)/, 'MY 主页滚动时显示滚动条');
assert.match(css, /data-home-mode="material"\]\.is-scrolling::-webkit-scrollbar-thumb/, 'MY 主页静止时隐藏滚动条');
assert.match(css, /\.sf-mu \.sf-orbit,[\s\S]*?transform:rotate\(40deg\)/, '胶囊整体固定旋转 40°');
assert.match(css, /\.sf-mu \.sf-orbit > span,[\s\S]*?transform:rotate\(-40deg\)/, '胶囊文字反向旋转保持水平');
assert.match(css, /\.sf-mu \.sf-orbit:hover,[\s\S]*?transform:rotate\(40deg\)[\s\S]*?translate:0 -2px/, '悬浮时旋转不变、仅上浮');
assert.equal((template.match(/sf-mu-search-form/g) || []).length, 0, 'New Tab search is removed from the Material homepage');
assert.match(template, /id="sf-mu-attention"[\s\S]*?data-mu-attn="resume"[\s\S]*?data-mu-attn="details"/,
  'attention card exposes continue and details overlay actions');
assert.match(studio, /dataset\.muAttn === 'resume'[\s\S]*?#\/project\//,
  'continue action opens the attention project');

assert.match(studio, /let projects = \[\], filter = 'all', folder = '', route = location\.hash \|\| '#\/dashboard'/,
  'dashboard is the default route');
assert.match(studio, /renderEditStats\(\)/, '主页圆环渲染已接线');
assert.match(studio, /\/api\/oplog\/stats\?days=7/, '圆环读取最近 7 天日志统计');
assert.match(studio, /greeting\.textContent = materialGreeting\(now\.getHours\(\)\)/, '花形按钮按小时显示问候语');
assert.match(studio, /function isMaterialHome\(\) \{ return document\.body\.dataset\.themePack === 'material-you'; \}/,
  'Material You detection is scoped to the theme pack');
assert.match(studio, /const mode = on \? 'material' : 'widgets';/,
  'theme switching selects exactly one homepage presentation');assert.match(studio, /dashboard\.dataset\.homeMode = mode;/,
  'theme switching writes the selected homepage presentation');
assert.match(studio, /material\.hidden = !on;\n  widgets\.hidden = on;/,
  'only one homepage presentation stays visible');
assert.match(studio, /const modeChanged = !!dashboardHomeMode && dashboardHomeMode !== mode;/,
  'data refreshes must not count as a homepage mode switch');
assert.match(studio, /if \(!dashboard\.hidden && \(modeChanged \|\| replay\)\) animateDashboardCards\(\);/,
  'the homepage entrance replay is limited to real mode/theme switches');
assert.match(studio, /if \(!el\.querySelector\('\.sf-widget'\)\) \{\n    el\.innerHTML = `[\s\S]*?\n    return;\n  \}\n  setWidgetText\(/,
  'homepage widgets are built once, then updated in place without replacing their nodes');
for (const handler of ['sf-mu-new', 'sf-mu-temp', 'sf-mu-resume']) {
  assert.match(studio, new RegExp(`\\$\\('${handler}'\\)\\.addEventListener`), `${handler} has an event handler`);
}

assert.match(css, /\.sf-studio\[data-theme-pack="material-you"\] \.dashboard-view/, 'Material styling is theme-scoped');
assert.match(css, /\.sf-mu-shell\s*\{[\s\S]*width:min\(1120px,100%\)/, 'homepage is centered at the legacy hero width');
assert.match(css, /\.sf-mu \.sf-hero\s*\{[\s\S]*grid-template-columns:150px minmax\(0,1fr\) 112px/, 'homepage uses the reference three-column composition');
assert.match(css, /\.sf-mu \.sf-flower>span svg/, 'the flower is a single SVG silhouette');
assert.match(css, /\.sf-mu \.sf-orbit\s*\{[\s\S]*background:var\(--tertiary-container\)/, 'the right capsule uses the tertiary container');
assert.match(css, /@media \(max-width:900px\)/, 'homepage has a tablet layout');
assert.match(css, /@media \(max-width:560px\)/, 'homepage has a phone layout');
assert.match(studio, /function animateMaterialPage/, 'Material You has a shared page-card entrance');
assert.match(studio, /a\.r\.top - b\.r\.top[\s\S]*?a\.r\.left - b\.r\.left/, 'Material cards animate top-to-bottom then left-to-right');
assert.match(studio, /animateMaterialPage\(\$\('sf-folders'\)\)/, 'folder rows use the Material entrance');
assert.match(studio, /animateMaterialPage\(\$\('sf-help'\)\)/, 'help cards use the Material entrance');
assert.match(studio, /animateMaterialPage\(e\.detail\?\.panel\)/, 'settings panels use the Material entrance');
assert.match(css, /\.sf-studio\[data-design=material\] \.is-my-page-entering \[data-my-enter\]/, 'Material page cards use data-my-enter');
assert.match(css, /sf-home-card-in var\(--sf-card-duration,\.42s\)/, 'Material page cards reuse the homepage float-up curve');
assert.match(studio, /function animateMaterialCueList/, 'Material editor cues have their own entrance');
assert.match(template, /data-kind="all"[\s\S]*?data-mu-action="new"[\s\S]*?data-mu-action="batch"[\s\S]*?data-mu-action="settings"/,
  '第二行：全部稿件 / 新建稿件 / 批量初稿 / 全局设置');
assert.match(css, /\.sf-mu-widget\[data-kind="all"\] \{ grid-column:span 1; \}/, '全部稿件让出一格给新建稿件');
assert.match(studio, /muAction === 'batch'[\s\S]*?btn-batch-draft/, '主页批量初稿卡打开批量弹窗');
assert.match(studio, /\(i \* 22\)/, 'Material cue cards appear one by one every 22ms (bounce duration unchanged)');
assert.doesNotMatch(
  studio.slice(studio.indexOf('function animateMaterialCueList'), studio.indexOf('function animateUwpEditorShell')),
  /addEventListener\('scroll'/,
  'Material cue list stays still while scrolling');
assert.match(studio, /function applyBackgroundWithFade/, 'Material background mode changes crossfade');
assert.match(studio, /function animateLibraryViewChange/, 'library grid/list switches replay the page entrance');
assert.match(studio, /is-view-switching/, 'grid/list switches use a non-flashing visible-card animation');
assert.match(studio, /data-view-enter/, 'grid/list switches use a dedicated marker, not page-entrance markers');
assert.match(css, /@keyframes my-view-in \{ from \{ opacity:1;/, 'Material view switch keeps cards visible');
assert.match(css, /\.sf-studio\[data-design=material\] \.home-list > \.proj-card \.pc-badges \{ margin-top:2px; \}/, 'Material project status pill keeps its vertical offset');
assert.match(css, /\.sf-studio\[data-design=material\] \.home-list > \.proj-card \.pc-st \{[\s\S]*?padding:3px 8px;[\s\S]*?margin-left:0/, 'Material project status pill has symmetric padding and aligns left');
assert.match(css, /\.sf-studio\[data-design=material\] \.home-list > \.proj-card \.pc-actions \{[\s\S]*?padding-left:8px/, 'Material project actions align with the title and status pill');
assert.match(css, /@keyframes sf-bg-fade-in/, 'Material background crossfade uses the shared CSS fade');
assert.match(studio, /materialEditorPending\) animateMaterialCueList\(added\)/, 'Material cue animation is limited to editor entry');
assert.match(studio, /is-material-editor-entering/, 'Material editor shell animates in');
assert.match(css, /@keyframes my-editor-in/, 'Material editor has the upward fade keyframes');
assert.match(css, /@keyframes my-cue-in \{[\s\S]*?translate3d\(0,-64px,60px\) scale\(1\.07\)[\s\S]*?translate3d\(0,0,-1px\) scale\(\.994\)[\s\S]*?transform:none/, 'Material cue flies and rebounds in one continuous curve with a small overshoot');
assert.match(css, /my-cue-in 420ms[\s\S]*?--my-cue-delay/, 'Material cue duration overlaps the next card delay');

console.log('material-home: template/mirror parity, flower clock, theme gating, live counts, controls and responsive CSS passed');
