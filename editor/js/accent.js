/* 主题色（界面强调色 · 界面里可自定义）
 *
 * 为什么是"经典脚本"而不是 ES 模块：它要在 <head> 里**同步**执行，
 * 首屏绘制前就把用户存的颜色套上 —— 否则模块是延迟执行的，会看到"先橙后紫"闪一下。
 * 强调色的唯一来源就是 CSS 变量族（--accent / --accent-2 / --accent-ink / --accent-aNN / --accent-glow），
 * 这里只负责"按用户颜色重算这一族并写到 :root 内联样式"：
 *   · 不设过 → 完全不写内联样式，用 style.css 里的默认橙
 *   · 「恢复默认」= 把内联值全清掉，保证不留半套残留
 * 只管界面强调色，不碰字幕色(--zh/--en)、角色色、轨道色。
 */
(function (w, d) {
  'use strict';
  var KEY = 'ss-accent';
  var DEFAULT = '#ff7a45';
  /* 预设：都按深色底 + 白字可读性挑的，一个都不用改 CSS 就能整站换色 */
  var PRESETS = [
    { hex: '#ff7a45', name: '橙 · 默认' },
    { hex: '#ffb340', name: '琥珀' },
    { hex: '#ffd54a', name: '金' },
    { hex: '#a3e635', name: '草绿' },
    { hex: '#4fd1a5', name: '青绿' },
    { hex: '#61b8ff', name: '天蓝' },
    { hex: '#8b7cf6', name: '靛紫' },
    { hex: '#c084fc', name: '薰衣草' },
    { hex: '#ff5f8f', name: '桃粉' },
    { hex: '#ff5f6b', name: '红' }
  ];
  /* 需要跟着主题色走的透明度档（CSS 里用的就是这一组） */
  var ALPHAS = [7, 9, 10, 12, 14, 16, 18, 28, 40, 45, 55];
  var VARS = ['--accent', '--accent-2', '--accent-ink', '--accent-glow'].concat(
    ALPHAS.map(function (a) { return '--accent-a' + (a < 10 ? '0' + a : a); }));

  function normHex(v) {
    var s = String(v == null ? '' : v).trim();
    if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '';
  }
  function rgbOf(hex) {
    var h = normHex(hex);
    if (!h) return null;
    return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
  }
  function hex2(n) {
    var s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return s.length < 2 ? '0' + s : s;
  }
  /** 朝 target 混合 ratio（0~1）—— 用来算 hover 亮一档的 --accent-2 */
  function mixTo(hex, target, ratio) {
    var a = rgbOf(hex), b = rgbOf(target);
    if (!a || !b) return hex;
    return '#' + hex2(a.r + (b.r - a.r) * ratio) + hex2(a.g + (b.g - a.g) * ratio) + hex2(a.b + (b.b - a.b) * ratio);
  }
  /** 相对亮度（WCAG 公式）—— 决定主题色块上该用白字还是深字 */
  function lum(rgb) {
    function ch(c) { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
  }
  function rootStyle() { return d.documentElement.style; }
  /** 通知需要"跟着主题重画"的地方（时间轴 canvas 那种拿不到 CSS 变量的场合） */
  function notify() {
    try { w.dispatchEvent(new CustomEvent('ss-accent', { detail: { hex: current() } })); } catch (e) {}
  }

  function apply(hex) {
    var h = normHex(hex), rgb = rgbOf(h);
    if (!rgb) return false;
    var st = rootStyle();
    st.setProperty('--accent', h);
    st.setProperty('--accent-2', mixTo(h, '#ffffff', 0.18));
    st.setProperty('--accent-ink', lum(rgb) > 0.18 ? '#1a1206' : '#ffffff');
    for (var i = 0; i < ALPHAS.length; i++) {
      var a = ALPHAS[i];
      st.setProperty('--accent-a' + (a < 10 ? '0' + a : a),
        'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + (a / 100) + ')');
    }
    st.setProperty('--accent-glow', '0 6px 20px rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', .28)');
    notify();
    return true;
  }
  function clear() {
    var st = rootStyle();
    for (var i = 0; i < VARS.length; i++) st.removeProperty(VARS[i]);
    notify();
  }
  function saved() { try { return normHex(localStorage.getItem(KEY)); } catch (e) { return ''; } }
  function current() { return saved() || DEFAULT; }
  function set(hex) {
    var h = normHex(hex);
    if (!h) return false;
    try { localStorage.setItem(KEY, h); } catch (e) {}
    return apply(h);
  }
  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) {}
    clear();
    return DEFAULT;
  }

  w.SSAccent = {
    KEY: KEY, DEFAULT: DEFAULT, PRESETS: PRESETS,
    normHex: normHex, mixTo: mixTo, apply: apply, clear: clear,
    current: current, set: set, reset: reset,
  };
  // 首屏引导：存过就立刻套用（没存过什么都不做 = 用 CSS 默认）
  var s = saved();
  if (s) apply(s);
})(window, document);
