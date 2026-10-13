// 保留旧入口原样；新入口从真实控件生成，避免复制原型的演示状态或丢功能。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let html = fs.readFileSync(path.join(root, 'editor/index.html'), 'utf8');
html = html.replace('<body>', `<body class="sf-studio" data-theme="light" data-design="studio" data-bg="solid">
<div class="sf-ambient" aria-hidden="true"><i></i><i></i><i></i></div><div class="sf-backdrop" aria-hidden="true"></div>
<aside id="sf-nav" class="sf-nav" aria-label="主导航">
  <a href="#/home" class="sf-brand"><span data-ico="film"></span><b>SubFabric<small>字幕创作工作室</small></b></a>
  <span class="sf-nav-label">工作空间</span>
  <a href="#/home" data-route="home" data-ico="folder">稿件库</a>
  <a href="#/tasks" data-route="tasks" data-ico="activity">任务中心 <span id="sf-task-count"></span></a>
  <a href="#/resources" data-route="resources" data-ico="inbox">资源管理</a>
  <div class="sf-folder-head"><span>文件夹</span><button type="button" id="sf-folder-add" aria-label="新建文件夹">＋</button></div>
  <div id="sf-folders"></div>
  <div class="sf-nav-bottom"><a href="#/settings" data-route="settings" data-ico="sliders">设置</a><a href="#/help" data-route="help" data-ico="info">帮助与快捷键</a><p>本地工作空间 · 自动保存</p></div>
</aside>
<header id="sf-topbar" class="sf-topbar"><span>工作空间 <i>/</i> <b id="sf-breadcrumb">稿件库</b></span><div><button type="button" class="btn" id="sf-direct-editor">打开编辑器</button><button type="button" class="btn btn-accent" id="sf-create">新建稿件</button></div></header>
<div id="sf-notice" role="status" hidden></div>
<section id="sf-help" class="sf-page" hidden><div class="sf-page-content"><p class="sf-eyebrow">SUBFABRIC STUDIO</p><h1>让每一句话，清晰可见。</h1><p>真实媒体、字幕与识别任务都在本机处理。编辑器沿用原有操作习惯。</p><div class="sf-help-grid"><article><h2>从视频到稿件</h2><p>新建稿件 → 选择本地视频或链接 → 导入字幕或生成初稿 → 在任务中心查看处理 → 打开编辑器复核 → 导出字幕或项目包。</p><button class="btn btn-accent" data-go="new">创建稿件</button></article><article><h2>编辑与保存</h2><p>单击字幕就地编辑，Enter 提交，Esc 取消。时间轴拖动句子和逐词边界。角色单击分配，右键修改名字与颜色。项目自动保存；保存冲突会明确提示。</p><p>ASS 字体、颜色和特效会写入当前稿件，可导出样式预设用于其他稿件。</p><button class="btn" data-setting="ass">ASS 样式设置</button></article><article><h2>快捷键与日志</h2><p>可在编辑器查看和修改快捷键；操作日志、备注、热词与服务日志保留在编辑器「日志」页。</p><button class="btn" id="sf-shortcuts">查看快捷键</button></article><article><h2>界面切换</h2><p>在程序根目录的 ui-config.json 中设 ui 为 legacy，然后刷新根入口，即可启用旧界面；new 为默认新界面。</p><a class="btn" href="index.html#/home">打开旧界面</a></article></div></div></section>`);
html = html.replace('<script src="js/accent.js"></script>', '<script src="js/accent.js"></script>\n<link rel="stylesheet" href="css/studio.css">');
html = html.replace('可在编辑器查看和修改快捷键', '可在此查看固定快捷键');
html = html.replace('ASS 字体、颜色和特效会写入当前稿件，可导出样式预设用于其他稿件。', 'ASS 字体与颜色写入当前稿件，可导出样式预设；后处理特效保存在本机，导出时应用。');
html = html.replace('<h1 class="home-title">SubFabric</h1>', '<h1 class="home-title" id="sf-library-title">稿件库</h1>');
html = html.replace('<div class="home-toolbar">', `<section class="sf-hero" id="sf-hero"><button type="button" class="sf-flower" id="sf-hero-create"><span>＋</span><b>开始新的创作</b><small>视频、链接或字幕</small></button><div class="sf-resume"><p class="sf-eyebrow">YOUR NEXT STORY</p><h2 id="sf-resume-name">为每一句话，留出呼吸的空间。</h2><p id="sf-resume-meta">从视频开始，把灵感变成字幕。</p><button type="button" class="btn btn-accent" id="sf-resume-open">新建稿件</button></div><button class="sf-orbit" id="sf-show-ready"><span><b id="sf-ready-count">0</b><small>可编辑稿件</small></span></button></section>
    <div class="home-toolbar">`);
html = html.replace('<div id="home-list" class="home-list"></div>', `<div class="sf-library-tools"><div id="sf-filters" role="group" aria-label="稿件筛选"><button class="active" data-filter="all">全部</button><button data-filter="active">处理中</button><button data-filter="ready">可编辑</button><button data-filter="attention">需处理</button></div><input id="sf-search" type="search" placeholder="搜索稿件名称"><button type="button" class="btn" id="sf-list-mode" aria-pressed="false">列表视图</button></div>
    <div id="home-list" class="home-list"></div><div id="sf-filter-empty" class="home-empty" hidden>没有符合条件的稿件<button type="button" class="btn" id="sf-clear-filter">清除筛选</button></div>`);
html = html.replace('<div class="st-body">', `<div class="st-body">
      <div id="sf-resource-links" class="sf-resource-links" hidden><button type="button" data-setting="models">识别模型</button><button type="button" data-resource="llm">翻译方案与术语</button><button type="button" data-setting="ass">ASS 样式与特效</button><button type="button" data-setting="enhance">热词与识别增强</button></div>
      <div class="st-panel" id="st-panel-ass" role="tabpanel" data-stp="ass" hidden><div class="st-card"><h2>ASS 样式与特效</h2><p class="gl-hint" id="sf-ass-context">设置作用于当前打开的 ASS 稿件；更改立即预览并由项目自动保存。尚未打开稿件时请先选择稿件。</p><button type="button" class="btn" id="sf-ass-open">选择 ASS 稿件</button></div><div id="sf-ass-mount"></div></div>`);
html = html.replace('<button type="button" class="st-tab" role="tab" aria-selected="false" aria-controls="st-panel-theme"', '<button type="button" class="st-tab" role="tab" aria-selected="false" aria-controls="st-panel-ass" data-stp="ass" data-ico="file">ASS 样式与特效</button>\n      <button type="button" class="st-tab" role="tab" aria-selected="false" aria-controls="st-panel-theme"');
html = html.replace('<div class="st-panel" id="st-panel-theme" role="tabpanel" data-stp="theme" hidden>', `<div class="st-panel" id="st-panel-theme" role="tabpanel" data-stp="theme" hidden>
      <div class="st-card"><h2>外观与主题包</h2><p class="gl-hint">与设计原型共用主题语言，设置保存在本机浏览器。</p><div id="sf-theme-packs" class="sf-theme-packs"></div><div class="sf-theme-tools"><button type="button" class="btn" id="sf-theme-import">导入主题包</button><button type="button" class="btn" id="sf-theme-export">导出主题包</button><input type="file" id="sf-theme-file" accept=".json,application/json" hidden></div>
      <div class="setting-row"><label for="sf-color">自定义主题色</label><input type="text" id="sf-color" data-color-input="1" value="#5c7560"></div>
      <div class="setting-row"><label for="sf-mode">明暗模式</label><select id="sf-mode"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></div>
      <div class="setting-row"><label for="sf-background">背景材质</label><select id="sf-background"><option value="solid">纯色</option><option value="aurora">模糊流光</option><option value="image">自定义图片</option></select><button type="button" class="btn" id="sf-image-pick">选择图片</button><button type="button" class="btn" id="sf-image-clear">清除图片</button><input type="file" id="sf-image-file" accept="image/png,image/jpeg,image/webp" hidden></div>
      <div class="setting-row"><label for="sf-motion">界面动效</label><select id="sf-motion"><option value="on">开启</option><option value="off">减少动效</option></select></div><p id="sf-theme-status" class="gl-hint" role="status">外观更改立即保存。</p></div>`);
// 原界面两处历史重复 id 在新入口中规范为稳定唯一 id；原代码支持这些 data 属性。
let colors = 0, resets = 0;
html = html.replace(/id="theme-color"/g, () => ++colors === 1 ? 'id="theme-color"' : 'id="theme-color-global" data-theme-color="1"');
html = html.replace(/id="theme-reset"/g, () => ++resets === 1 ? 'id="theme-reset"' : 'id="theme-reset-global" data-theme-reset="1"');
html = html.replace('<script src="vendor/subtitles-octopus.js"></script>', '<script src="js/studio-themes.js"></script>\n<script src="js/studio-progress.js"></script>\n<script type="module" src="js/studio.js"></script>\n<script src="vendor/subtitles-octopus.js"></script>');
fs.writeFileSync(path.join(root, 'editor/studio.html'), html);
for (const [src, dest] of [['themes.js', 'studio-themes.js'], ['progress.js', 'studio-progress.js']])
  fs.copyFileSync(path.join(root, 'prototypes/subfabric-ui', src), path.join(root, 'editor/js', dest));
console.log('Studio entry generated; legacy HTML unchanged.');
