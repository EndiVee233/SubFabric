/* Material You ambient rim: background S/V → border sat/brightness curve.
 *
 * 只对内置 Material You 主题包生效。色场由主题的 Material 角色色生成
 * （accent / tertiary / secondary / on-container / accent-soft），不依赖
 * 设置页被隐藏的 .sf-ambient；这样设置里的示例卡和二级弹层都能取到
 * 同一套局部颜色。
 *
 * 规则：背景饱和度 S 越高，kSat 越低、kBri 越高。
 * 高饱和背景只提亮 + 轻微去饱和，靠顶部白高光保住暗背景下的轮廓。
 */

export const RIM_DEFAULTS = Object.freeze({
  rimSatLow: 0.85,
  rimBriGain: 0.58,
  rimSpecBase: 0.60,
  rimPower: 1.5
});

/* 只给二级弹层、取色器与曲线卡的实时预览挂环。一级界面（主题包/背景/模型/角色/
   方案卡、下拉触发器、字幕卡）不挂，避免把环境环扩散到整个界面。 */
export const RIM_SELECTOR = [
  '.sf-choice-menu',
  '.sf-rim-sample',
  '.sscp'
].join(',');

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const clamp01 = n => clamp(n, 0, 1);
const HEX = /^#[0-9a-f]{6}$/i;
const PREVIEW = { x: 0.22, y: 0.22 };
const viewportW = () => Number(window.innerWidth) || 1440;
const viewportH = () => Number(window.innerHeight) || 900;

const state = {
  material: false,
  enabled: false,
  dark: false,
  active: false,
  params: null,
  field: null,
  sampleEl: null,
  observer: null,
  rings: new WeakMap(),
  raf: 0,
  listening: false,
  chartBuilt: false
};

const nextFrame = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : fn => setTimeout(fn, 16);
const cancelFrame = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : id => clearTimeout(id);

function rgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function rgba(hex, alpha) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixHex(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return '#' + A.map((v, i) => Math.round(v * (1 - t) + B[i] * t).toString(16).padStart(2, '0')).join('');
}

function toHsv(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  return { s: max ? d / max : 0, v: max };
}

export function rimActive(themePack, enabled = true) {
  return themePack === 'material-you' && enabled !== false;
}

export function rimParams(prefs = {}) {
  const number = (key, lo, hi) => {
    const v = Number(prefs[key]);
    return Number.isFinite(v) ? clamp(v, lo, hi) : RIM_DEFAULTS[key];
  };
  return {
    rimSatLow: number('rimSatLow', 0.70, 1.00),
    rimBriGain: number('rimBriGain', 0.30, 0.80),
    rimSpecBase: number('rimSpecBase', 0.45, 0.75),
    rimPower: number('rimPower', 1.00, 2.20)
  };
}

/* kSat: 1.10 → rimSatLow；高 S 端不再加饱和。
   kBri: 1.40 + gain·S^1.2 + 0.10·(1−V)，S 越高、背景越暗越亮。
   kSpec: 0.60 + 0.18·S，高 S 背景多叠白光。 */
export function rimMap(params, s, v = 0.5) {
  s = clamp01(s);
  v = clamp01(v);
  const satHigh = 1.10;
  const kSat = satHigh - (satHigh - params.rimSatLow) * Math.pow(s, params.rimPower);
  const kBri = clamp(1.40 + params.rimBriGain * Math.pow(s, 1.2) + 0.10 * (1 - v), 1.32, 2.20);
  const kSpec = clamp(params.rimSpecBase + 0.18 * s, 0.40, 0.88);
  return { kSat, kBri, kSpec };
}

function pick(tokens, key) {
  return HEX.test(tokens?.[key] || '') ? tokens[key] : '#8b93a6';
}

/* 与原型相同的思路：深底 + 若干 Material 角色色径向色场。
   CSS 与 sampleField 使用同一组 blob 数据，设置里的曲线和实际描边同源。 */
export function makeField(tokens = {}, dark = false) {
  const base = dark ? '#070a0f' : '#0b0f16';
  const end = dark ? '#111827' : '#151c27';
  /* 浅色表面用更深的同一批角色色：亮度倍率不变，但边缘落在中间调，
     不会被白底/白高光一起洗成浅灰。深色表面保留原色。 */
  const tone = color => dark ? color : mixHex(color, '#0b1220', 0.55);
  const accent = tone(pick(tokens, '--accent'));
  const blobs = [
    { x: 0.22, y: 0.22, rx: 980, ry: 680, color: accent, alpha: 0.82, fade: 0.74 },
    { x: 0.80, y: 0.18, rx: 900, ry: 640, color: tone(mixHex(pick(tokens, '--accent'), pick(tokens, '--tertiary-container'), 0.55)), alpha: 0.70, fade: 0.74 },
    { x: 0.82, y: 0.82, rx: 940, ry: 700, color: tone(mixHex(pick(tokens, '--accent'), pick(tokens, '--secondary-container'), 0.55)), alpha: 0.66, fade: 0.76 },
    { x: 0.24, y: 0.84, rx: 840, ry: 620, color: tone(pick(tokens, '--on-container')), alpha: 0.58, fade: 0.74 },
    { x: 0.52, y: 0.50, rx: 820, ry: 600, color: tone(pick(tokens, '--accent-soft')), alpha: 0.34, fade: 0.80 }
  ].map(blob => ({ ...blob, rgb: rgb(blob.color) }));
  const layers = blobs.map(blob =>
    `radial-gradient(${blob.rx}px ${blob.ry}px at ${(blob.x * 100).toFixed(1)}% ${(blob.y * 100).toFixed(1)}%, ${rgba(blob.color, blob.alpha)} 0%, ${rgba(blob.color, 0)} ${(blob.fade * 100).toFixed(0)}%)`
  );
  layers.push(`linear-gradient(135deg, ${base} 0%, ${end} 100%)`);
  return { base, blobs, css: layers.join(', ') };
}

export function sampleField(field, x, y, w, h) {
  if (!field) return { s: 0, v: 0 };
  let c = rgb(field.base);
  for (let i = field.blobs.length - 1; i >= 0; i--) {
    const blob = field.blobs[i];
    const d = Math.hypot((x - blob.x * w) / blob.rx, (y - blob.y * h) / blob.ry);
    if (d >= blob.fade) continue;
    const a = blob.alpha * (1 - d / blob.fade);
    c = [c[0] * (1 - a) + blob.rgb[0] * a, c[1] * (1 - a) + blob.rgb[1] * a, c[2] * (1 - a) + blob.rgb[2] * a];
  }
  return toHsv(c);
}

function sampleRect(r) {
  if (!state.field || r.width < 2 || r.height < 2) return { s: 0, v: 0 };
  const w = viewportW(), h = viewportH();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const points = [
    [cx, r.top + 2], [cx, r.bottom - 2],
    [r.left + 2, cy], [r.right - 2, cy], [cx, cy]
  ];
  let s = 0, v = 0;
  for (const [x, y] of points) {
    const hsv = sampleField(state.field, x, y, w, h);
    s += hsv.s; v += hsv.v;
  }
  return { s: s / points.length, v: v / points.length };
}

function syncControls(prefs = {}) {
  const p = rimParams(prefs);
  const enabled = $('sf-rim-enabled');
  if (enabled) enabled.checked = prefs.rimEnabled !== false;
  const range = (id, value, format) => {
    const input = $(id);
    if (input) input.value = String(value);
    const output = $(id + '-value');
    if (output) output.textContent = format(value);
  };
  range('sf-rim-sat-low', p.rimSatLow, v => '×' + v.toFixed(2));
  range('sf-rim-bri-gain', p.rimBriGain, v => '+' + v.toFixed(2));
  range('sf-rim-spec-base', p.rimSpecBase, v => Math.round(v * 100) + '%');
  range('sf-rim-power', p.rimPower, v => v.toFixed(2));
}

/* Chart geometry. One shared Y axis (0.80–2.20) so kSat/kBri never read as a
   dual-axis crossing; the gap between the two curves is meaningful. */
const CH = { l: 40, r: 486, t: 22, b: 140 };
const xAt = s => CH.l + clamp01(s) * (CH.r - CH.l);
const yAt = k => CH.b - (k - 0.80) / (2.20 - 0.80) * (CH.b - CH.t);
const NS = 'http://www.w3.org/2000/svg';

function tag(parent, name, attrs, text) {
  if (!parent || typeof document.createElementNS !== 'function') return null;
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function buildChart() {
  if (state.chartBuilt) return;
  const chart = $('sf-rim-chart');
  const grid = $('sf-rim-grid');
  const axis = $('sf-rim-axis');
  if (!chart || !grid || !axis || typeof document.createElementNS !== 'function') return;

  for (let i = 0; i <= 4; i++) {
    const x = xAt(i / 4);
    tag(grid, 'line', { x1: x, y1: CH.t, x2: x, y2: CH.b, class: 'sf-rim-grid-line' });
  }
  for (let i = 0; i <= 4; i++) {
    const y = CH.t + i * (CH.b - CH.t) / 4;
    tag(grid, 'line', { x1: CH.l, y1: y, x2: CH.r, y2: y, class: 'sf-rim-grid-line' });
    const value = 2.20 - i * (2.20 - 0.80) / 4;
    tag(axis, 'text', { x: CH.l - 7, y: y + 3, 'text-anchor': 'end', class: 'sf-rim-axis-label' }, '×' + value.toFixed(2));
  }
  for (const s of [0, 0.5, 1]) {
    tag(axis, 'text', { x: xAt(s), y: CH.b + 12, 'text-anchor': 'middle', class: 'sf-rim-axis-label' }, Math.round(s * 100) + '%');
  }
  tag(axis, 'text', { x: CH.l, y: 13, class: 'sf-rim-axis-title' }, '倍率 ×');
  tag(axis, 'text', { x: CH.r, y: 13, 'text-anchor': 'end', class: 'sf-rim-hot-label' }, 'S 高 → 只提亮');
  tag(axis, 'text', { x: (CH.l + CH.r) / 2, y: 166, 'text-anchor': 'middle', class: 'sf-rim-axis-label' }, '背景饱和度 S');
  state.chartBuilt = true;
}

function drawCurves() {
  const group = $('sf-rim-curves');
  if (!group || !state.params || typeof group.replaceChildren !== 'function' || typeof document.createElementNS !== 'function') return;
  group.replaceChildren();
  tag(group, 'rect', { x: xAt(0.6), y: CH.t, width: xAt(1) - xAt(0.6), height: CH.b - CH.t, class: 'sf-rim-hot' });
  let sat = '', bri = '';
  for (let i = 0; i <= 100; i++) {
    const s = i / 100;
    const m = rimMap(state.params, s, 0.5);
    sat += `${i ? 'L' : 'M'}${xAt(s).toFixed(1)},${yAt(m.kSat).toFixed(1)} `;
    bri += `${i ? 'L' : 'M'}${xAt(s).toFixed(1)},${yAt(m.kBri).toFixed(1)} `;
  }
  tag(group, 'path', { d: sat, class: 'sf-rim-curve-sat' });
  tag(group, 'path', { d: bri, class: 'sf-rim-curve-bri' });
}

function updateMarker(s, m) {
  const group = $('sf-rim-marker');
  const line = $('sf-rim-marker-line');
  const dotSat = $('sf-rim-dot-sat');
  const dotBri = $('sf-rim-dot-bri');
  if (!group || !line || !dotSat || !dotBri) return;
  const x = xAt(s);
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  dotSat.setAttribute('cx', x); dotSat.setAttribute('cy', yAt(m.kSat));
  dotBri.setAttribute('cx', x); dotBri.setAttribute('cy', yAt(m.kBri));
  if (group.style) group.style.opacity = 1;
}

function updateSample(el, allowInactive = false) {
  if (!el || !state.field || (!state.active && !allowInactive)) return;
  let s, v;
  if (el.id === 'sf-rim-sample') {
    ({ s, v } = sampleField(state.field, PREVIEW.x * viewportW(), PREVIEW.y * viewportH(), viewportW(), viewportH()));
  } else {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    ({ s, v } = sampleRect(r));
  }
  const m = rimMap(state.params, s, v);
  state.sampleEl = el;
  const name = el.dataset.rimName || '示例选择框';
  const set = (id, text) => { const node = $(id); if (node) node.textContent = text; };
  set('sf-rim-name', name);
  set('sf-rim-s', Math.round(s * 100) + '%');
  set('sf-rim-v', 'V ' + Math.round(v * 100) + '%');
  set('sf-rim-sat', '×' + m.kSat.toFixed(2));
  set('sf-rim-bri', '×' + m.kBri.toFixed(2));
  set('sf-rim-spec', Math.round(visualSpec(m) * 100) + '%');
  set('sf-rim-out', Math.round(clamp01(s * m.kSat) * 100) + '%');
  updateMarker(s, m);
}

function dropRing(el) {
  el.classList.remove('sf-has-rim', 'sf-rim-anchor');
  const ring = state.rings.get(el);
  if (ring) { ring.remove(); state.rings.delete(el); }
  const child = el.querySelector(':scope > .sf-rim-ring');
  if (child) child.remove();
  for (const key of ['--sf-rim-pos', '--sf-rim-sat', '--sf-rim-bri', '--sf-rim-spec']) el.style.removeProperty(key);
}

function collect() {
  if (!state.active) return;
  for (const el of $$('.sf-has-rim')) {
    if (!el.matches(RIM_SELECTOR)) dropRing(el);
  }
  for (const el of $$(RIM_SELECTOR)) {
    if (typeof el.getClientRects === 'function' && !el.getClientRects().length) continue;
    if (!state.rings.has(el)) {
      const ring = document.createElement('span');
      ring.className = 'sf-rim-ring';
      ring.setAttribute('aria-hidden', 'true');
      /* fixed 弹层（选择菜单、浮层）不能把环放在滚动内容里：菜单内部滚动时环会跟着走。
         环改为 body 级 fixed overlay，只按菜单外框定位，滚动内容从它下面穿过。 */
      const floating = typeof getComputedStyle === 'function' && getComputedStyle(el).position === 'fixed';
      if (floating) {
        ring.classList.add('sf-rim-floating');
        document.body.appendChild(ring);
      } else {
        el.appendChild(ring);
      }
      state.rings.set(el, ring);
    }
    /* 只给 static 元素补锚点；弹层本身是 fixed/absolute，不能改成 relative。 */
    if (typeof getComputedStyle === 'function' && getComputedStyle(el).position === 'static') el.classList.add('sf-rim-anchor');
    el.classList.add('sf-has-rim');
  }
}

function removeRings() {
  for (const el of $$('.sf-has-rim')) dropRing(el);
}

function visualSpec(m) {
  return state.dark ? m.kSpec : m.kSpec * 0.45;
}

function place() {
  if (!state.active || !state.field) return;
  for (const el of $$('.sf-has-rim')) {
    if (el.id === 'sf-rim-sample') {
      const x = PREVIEW.x * viewportW(), y = PREVIEW.y * viewportH();
      const { s, v } = sampleField(state.field, x, y, viewportW(), viewportH());
      const m = rimMap(state.params, s, v);
      el.style.setProperty('--sf-rim-pos', `${-x}px ${-y}px`);
      el.style.setProperty('--sf-rim-sat', m.kSat.toFixed(3));
      el.style.setProperty('--sf-rim-bri', m.kBri.toFixed(3));
      el.style.setProperty('--sf-rim-spec', visualSpec(m).toFixed(3));
      continue;
    }
    const ring = state.rings.get(el);
    if (!ring) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) {
      if (ring.classList.contains('sf-rim-floating')) ring.style.display = 'none';
      continue;
    }
    const { s, v } = sampleRect(r);
    const m = rimMap(state.params, s, v);
    if (ring.classList.contains('sf-rim-floating')) {
      ring.style.display = 'block';
      ring.style.left = `${r.left}px`;
      ring.style.top = `${r.top}px`;
      ring.style.width = `${r.width}px`;
      ring.style.height = `${r.height}px`;
      const br = getComputedStyle(el).borderRadius;
      if (br) ring.style.borderRadius = br;
      ring.style.setProperty('--sf-rim-pos', `${-r.left}px ${-r.top}px`);
      ring.style.setProperty('--sf-rim-sat', m.kSat.toFixed(3));
      ring.style.setProperty('--sf-rim-bri', m.kBri.toFixed(3));
      ring.style.setProperty('--sf-rim-spec', visualSpec(m).toFixed(3));
    } else {
      el.style.setProperty('--sf-rim-pos', `${-r.left}px ${-r.top}px`);
      el.style.setProperty('--sf-rim-sat', m.kSat.toFixed(3));
      el.style.setProperty('--sf-rim-bri', m.kBri.toFixed(3));
      el.style.setProperty('--sf-rim-spec', visualSpec(m).toFixed(3));
    }
  }
  updateSample($('sf-rim-sample'));
}

function schedule() {
  if (!state.active || state.raf) return;
  state.raf = nextFrame(() => {
    state.raf = 0;
    collect();
    place();
  });
}

function start() {
  if (!state.listening) {
    state.listening = true;
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', schedule);
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('scroll', schedule, true);
      document.addEventListener('click', schedule, true);
    }
    if ('MutationObserver' in window) {
      state.observer = new MutationObserver(schedule);
      state.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    }
  }
  collect();
}

function stop() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  if (state.listening) {
    if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', schedule);
    if (typeof document.removeEventListener === 'function') {
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('click', schedule, true);
    }
    state.listening = false;
  }
  if (state.raf) {
    cancelFrame(state.raf);
    state.raf = 0;
  }
}

/* 只更新曲线参数（设置页拖动滑杆时用）：不重建色场、不重挂观察器、不改主题。
 * 之前 studio.js 每收到一次 input 就 applyTheme()，会重建主题包 DOM / 重播设置卡入场，
 * 看起来像页面在反复刷新；拖动时只需要重画曲线和已有环。 */
export function updateParams(prefs = {}) {
  state.params = rimParams(prefs);
  if (typeof document === 'undefined') return;
  syncControls(prefs);
  if (!state.active) {
    updateSample($('sf-rim-sample'), true);
    return;
  }
  drawCurves();
  schedule();
}

export function configure(options = {}) {
  const material = options.material === true;
  const enabled = options.enabled !== false;
  state.dark = options.dark === true;
  state.material = material;
  state.enabled = enabled;
  state.active = material && enabled;
  state.params = rimParams(options.prefs || {});

  const card = $('sf-rim-card');
  if (card) card.hidden = !material;
  document.body.dataset.rim = state.active ? 'on' : 'off';
  syncControls(options.prefs || {});

  if (!material) {
    stop();
    removeRings();
    return;
  }

  state.field = makeField(options.tokens || {}, options.dark === true);
  document.documentElement.style.setProperty('--sf-rim-field', state.field.css);
  // 轻量测试 DOM 没有 SVG/布局 API：保留卡片和读数，不挂环、不起观察器。
  if (typeof document.createElementNS !== 'function') {
    document.body.dataset.rim = 'off';
    stop();
    removeRings();
    return;
  }
  buildChart();
  drawCurves();

  if (!state.active) {
    stop();
    removeRings();
    updateSample($('sf-rim-sample'), true);
    return;
  }

  start();
  schedule();
}
