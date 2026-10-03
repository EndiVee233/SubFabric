/* UI 主题色 / 动效验证探针（开发用，不进发布包）
 * 用法: 先起服务(PORT=8399), 再 `node tools/ui_theme_probe.mjs`
 * 断言: 主题变量是否真的落到计算样式上、色块/自定义/恢复默认、弹窗与卡片动画是否生效、
 *       prefers-reduced-motion 是否关闭动效、有无 JS 报错；同时输出截图到 _t/。
 */
import { launch, sleep, report } from './lib/cdp.mjs';

const BASE = 'http://127.0.0.1:8399';
const OUT = 'D:/Vibe Coding/_t/';
const probe = await fetch(BASE + '/api/projects').then(r => r.json());
const first = (probe.projects || [])[0];

const b = await launch({ url: BASE + '/#/home', port: 9341, width: 1440, height: 940 });
const R = {};
const accentVar = () => b.eval("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
/* .btn-accent 的底色是 linear-gradient(--accent,--accent-2) → backgroundColor 必然是透明, 要看 backgroundImage;
   文字色则应是 --accent-ink（深色字压在亮色块上, 默认=原设计的深棕 #1a1206=rgb(26,18,6)） */
const accentBtn = () => b.eval("(() => { const s = getComputedStyle(document.querySelector('.btn-accent')); return s.backgroundImage.replace(/\\s+/g,' ') + '  ink=' + s.color; })()");
const ls = () => b.eval("localStorage.getItem('ss-accent')");
/* 时间轴画布指纹: 必须按 id 取 —— 胶片缩略图会 createElement('canvas') 造离屏画布,
   用 querySelector('canvas') 可能算到那个永远不动的画布上(踩过) */
const canvasHash = () => b.eval("(() => { const c = document.getElementById('timeline'); const d = c.toDataURL(); let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d.charCodeAt(i)) | 0; return h; })()");

try {
  await b.goto(BASE + '/#/home');                     // launch 的 url 参数不负责导航, 必须显式 goto
  await b.waitFor("document.querySelectorAll('.proj-card').length > 0", { label: '首页项目卡片' });
  await sleep(900);                                   // 等错峰入场动画跑完
  await b.shot(OUT + 'ui_01_home.png');
  R.首页卡片数 = await b.eval("document.querySelectorAll('.proj-card').length");
  R.错峰延迟 = await b.eval("Array.from(document.querySelectorAll('.proj-card')).slice(0,5).map(c => getComputedStyle(c).animationDelay)");
  // 入场动画只在"进入首页"那一帧播（轮询刷新不重播）→ 用 .anim-in 类名判定
  R.列表入场动画 = await b.eval("document.getElementById('home-list').classList.contains('anim-in')");
  R.卡片动画 = await b.eval("getComputedStyle(document.querySelector('.proj-card')).animationName");
  R.骨架屏类 = await b.eval("!!document.querySelector('.skel-row') || '已换真实卡片'");
  R.图标数 = await b.eval("document.querySelectorAll('svg.ico').length");
  R.首屏图标漏注入 = await b.eval("Array.from(document.querySelectorAll('[data-ico]')).filter(el => !el.querySelector('svg.ico')).length");
  R.滚动条已定制 = await b.eval("getComputedStyle(document.documentElement).getPropertyValue('--r-3').trim()");
  R.环境光 = await b.eval("getComputedStyle(document.body, '::before').backgroundImage.includes('radial-gradient')");
  R.默认主题色 = await accentVar();
  R.默认按钮背景 = await accentBtn();
  R.默认localStorage = await ls();
  R.内联覆盖数 = await b.eval("document.documentElement.style.length");

  // 打开一个项目 → 编辑器界面（时间轴/字幕卡片）
  if (first) {
    await b.goto(`${BASE}/#/project/${first.id}`);
    await sleep(1800);
    await b.shot(OUT + 'ui_02_editor.png');
    R.编辑器_条目数 = await b.eval("document.querySelectorAll('.cue-card').length");
    R.编辑器_卡片过渡 = await b.eval("getComputedStyle(document.querySelector('.cue-card') || document.body).transitionProperty");
  }

  // 设置页签 → 外观
  await b.eval("document.querySelector('.ptab[data-tab=\"settings\"]').click()");
  await b.waitFor("document.querySelectorAll('.theme-sw').length > 0", { label: '主题色块' });
  await sleep(400);
  R.色块数 = await b.eval("document.querySelectorAll('.theme-sw').length");
  R.预设列表 = await b.eval("window.SSAccent.PRESETS.map(p => p.hex).join(',')");
  R.面板动画 = await b.eval("(() => { const p = document.querySelector('.st-panel:not([hidden])'); return p ? getComputedStyle(p).animationName : 'n/a'; })()");
  await b.shot(OUT + 'ui_03_settings.png');

  // 换色 → 紫色：变量、按钮背景、localStorage 三处都要变
  await b.eval("document.querySelector('.theme-sw[data-hex=\"#8b7cf6\"]').click()");
  await sleep(500);
  R.换色后_变量 = await accentVar();
  R.换色后_按钮背景 = await accentBtn();
  R.换色后_localStorage = await ls();
  R.换色后_选中态 = await b.eval("document.querySelectorAll('.theme-sw.active').length");
  await b.shot(OUT + 'ui_04_purple.png');

  // 自定义色（模拟拖色盘）
  await b.eval("(() => { const c = document.getElementById('theme-color'); c.value = '#4fd1a5'; c.dispatchEvent(new Event('input', {bubbles:true})); return true; })()");
  await sleep(300);
  R.自定义后_变量 = await accentVar();
  R.自定义后_按钮背景 = await accentBtn();

  // 恢复默认 → 变量回落 + toast 动画
  await b.eval("document.getElementById('theme-reset').click()");
  await sleep(120);                                    // 抓 toast 滑入的那一帧
  await b.shot(OUT + 'ui_05_toast.png');
  R.toast动画 = await b.eval("(() => { const t = document.getElementById('toast'); return t ? getComputedStyle(t).animationName : 'n/a'; })()");
  R.toast文案 = await b.eval("(document.getElementById('toast') || {}).textContent");
  await sleep(400);
  R.恢复后_变量 = await accentVar();
  R.恢复后_localStorage = await ls();
  R.恢复后_内联覆盖数 = await b.eval("document.documentElement.style.length");

  // 弹窗动画：新建项目对话框
  await b.goto(BASE + '/#/home');
  await sleep(600);
  await b.eval("document.getElementById('btn-new-project').click()");
  await sleep(80);
  R.弹窗遮罩动画 = await b.eval("getComputedStyle(document.getElementById('np-overlay')).animationName");
  R.弹窗盒子动画 = await b.eval("getComputedStyle(document.querySelector('#np-overlay > *:first-child')).animationName");
  await b.shot(OUT + 'ui_06_dialog.png');
  await b.eval("document.getElementById('np-overlay').hidden = true");

  // 时间轴缩放是否还有缓动（对比"中途帧"与"末帧"的画布指纹）
  if (first) {
    // 注意: 只改 hash 的 goto 不会重载页面; 首页覆盖编辑器时 ResizeObserver 会把画布缩成 1×1,
    // 那时 elementFromPoint 命中的是首页, 滚轮根本到不了时间轴 → 这里必须整页重载
    await b.goto(`${BASE}/#/project/${first.id}`);
    await b.send('Page.reload', {});
    await sleep(2600);
    const geo = await b.eval("(() => { const c = document.getElementById('timeline'); const r = c.getBoundingClientRect(); const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2); const top = document.elementFromPoint(x, y); return JSON.stringify({ x, y, w: Math.round(r.width), h: Math.round(r.height), top: top ? top.id || top.className : null }); })()");
    R.缩放_画布 = geo;
    const p = JSON.parse(geo);
    if (p.w > 10 && p.top === 'timeline') {
      const before = await canvasHash();
      await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -120, modifiers: 2 });
      await sleep(45);
      const mid = await canvasHash();
      await sleep(450);
      const end = await canvasHash();
      R.缩放_有中间帧 = mid !== before && mid !== end;      // 缓动生效: 中途帧既不是起点也不是终点
      R.缩放_末帧有变化 = end !== before;
    } else { R.缩放 = '画布不可用(被遮挡或尺寸为 0)'; }
  }

  // prefers-reduced-motion: 动效应被关掉（回首页才有 .proj-card）
  await b.goto(BASE + '/#/home');
  await b.waitFor("document.querySelectorAll('.proj-card').length > 0", { label: '首页卡片(动效检查)' });
  await sleep(300);
  const normalDur = await b.eval("getComputedStyle(document.querySelector('.proj-card')).animationDuration");
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(250);
  R.正常动效时长 = normalDur;
  R.减少动效_卡片时长 = await b.eval("(() => { const c = document.querySelector('.proj-card'); return c ? getComputedStyle(c).animationDuration : 'n/a'; })()");
  await b.send('Emulation.setEmulatedMedia', { features: [] });

  R.失败请求 = b.net.filter(n => n.phase === 'fail' || (n.phase === 'res' && n.status >= 400))
    .map(n => (n.status ? n.status + ' ' : 'FAIL ') + String(n.url).replace(BASE, '')).slice(0, 6);
  R.JS报错 = b.logs.filter(l => /exception|\[JS错误\]/i.test(l)).slice(0, 8);

  /* 界面只有中文: 语言下拉没了、en-US.json 404、zh-CN.json 仍在(改措辞用) */
  R.语言行已移除 = !(await b.eval("!!document.getElementById('set-locale')"));
  R.enUS已删除 = await b.eval("fetch('lang/en-US.json').then(r => r.status)");
  R.zhCN词典 = await b.eval("fetch('lang/zh-CN.json').then(r => r.status)");
} catch (e) {
  R.探针异常 = String(e && e.message || e);
} finally {
  report('UI 主题/动效验证', R);
  b.close();
}
