/**
 * Firefox 风格的自绘取色器。
 *
 * 设计目标：
 *   - 全应用不再触发浏览器原生 <input type="color"> 弹窗；HTML 里的颜色入口
 *     都是普通文本输入，点击后打开这个浮层。
 *   - 交互接近用户给的 Firefox 截图：左侧基础色板、中央 HSV 色彩区域、右侧
 *     色相条；底部 Hex / RGB / HSV 数值输入，以及确定/取消。
 *   - 保留原有输入元素和 input/change 事件：旧的主题色、ASS 样式、角色逻辑
 *     不用改业务代码，取色器只是它们共同的 UI 适配层。
 *
 * 不使用 EyeDropper 或任何浏览器原生颜色控件：这是纯 DOM/CSS/Pointer Events。
 */

const RECENT_KEY = 'ss-color-picker-recent';
const RECENT_MAX = 16;
const PRESETS = [
  '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0080ff', '#0000ff', '#ff00ff', '#ffffff',
  '#c00000', '#ff8000', '#80ff00', '#00c080', '#0080c0', '#4040ff', '#c000c0', '#c0c0c0',
  '#800000', '#804000', '#408000', '#008080', '#004080', '#000080', '#400080', '#808080',
  '#400000', '#804000', '#004000', '#004040', '#000040', '#202080', '#400040', '#404040',
  '#000000', '#404000', '#808000', '#008000', '#008080', '#0000a0', '#800080', '#606060',
  '#ff0080', '#80ff00', '#00ff80', '#0080ff', '#8000ff', '#8040ff', '#ff8040', '#c0ff80',
];

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export function normalizeHex(value, fallback = '#ffffff') {
  const s = String(value == null ? '' : value).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return ('#' + s.split('').map(c => c + c).join('')).toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return ('#' + s).toLowerCase();
  return fallback;
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function rgbToHsv(r, g, b) {
  r = clamp(Number(r) / 255, 0, 1); g = clamp(Number(g) / 255, 0, 1); b = clamp(Number(b) / 255, 0, 1);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  h = ((Number(h) % 360) + 360) % 360;
  s = clamp(Number(s), 0, 1); v = clamp(Number(v), 0, 1);
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function hsvToHex(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

function readRecent() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a.filter(x => /^#[0-9a-f]{6}$/i.test(x)).map(normalizeHex).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function saveRecent(hex) {
  const a = [normalizeHex(hex), ...readRecent().filter(x => x !== normalizeHex(hex))].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(a)); } catch {}
}

const state = { h: 0, s: 0, v: 1 };
let popup = null;
let activeInput = null;
let originalValue = '';
let swatchButton = null;
let bound = false;
let openPoint = null;
let dragged = false;

function setInputValue(value, emit = true) {
  if (!activeInput) return;
  const hex = hsvToHex(state.h, state.s, state.v);
  activeInput.value = hex;
  if (emit) activeInput.dispatchEvent(new Event('input', { bubbles: true }));
  if (swatchButton) swatchButton.style.backgroundColor = hex;
}

function setFromHex(hex, emit = true) {
  const rgb = hexToRgb(hex), hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  state.h = hsv.h; state.s = hsv.s; state.v = hsv.v;
  updateUi(emit);
}

function field(id) { return popup && popup.querySelector('[data-field="' + id + '"]'); }
function updateUi(emit = true) {
  if (!popup) return;
  const rgb = hsvToRgb(state.h, state.s, state.v);
  const hex = hsvToHex(state.h, state.s, state.v);
  const svEl = popup.querySelector('.sscp-sv');
  if (svEl) svEl.style.setProperty('--sscp-h', state.h + 'deg');
  const sv = popup.querySelector('.sscp-sv-cursor');
  const hue = popup.querySelector('.sscp-hue-cursor');
  if (sv) { sv.style.left = (state.s * 100) + '%'; sv.style.top = ((1 - state.v) * 100) + '%'; }
  if (hue) hue.style.top = (state.h / 360 * 100) + '%';
  popup.querySelectorAll('.sscp-preview').forEach(el => { el.style.backgroundColor = hex; });
  /* 当前颜色对应的色板要有选中态（UWP 用 2px 外框；读屏用 aria-pressed）。 */
  const norm = hex.toUpperCase();
  popup.querySelectorAll('.sscp-swatch[data-color]').forEach(el => {
    const on = String(el.dataset.color || '').toUpperCase() === norm;
    el.classList.toggle('active', on); el.setAttribute('aria-pressed', String(on));
  });
  const hexEl = field('hex'); if (hexEl && document.activeElement !== hexEl) hexEl.value = hex.toUpperCase();
  for (const [id, value] of [['r', rgb.r], ['g', rgb.g], ['b', rgb.b], ['h', Math.round(state.h)],
    ['s', Math.round(state.s * 240)], ['v', Math.round(state.v * 240)]]) {
    const el = field(id); if (el && document.activeElement !== el) el.value = value;
  }
  setInputValue(hex, emit);
}

function pointerRatio(ev, el) {
  const r = el.getBoundingClientRect();
  return { x: clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1), y: clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1) };
}
function bindPointer(el, fn) {
  let down = false;
  el.addEventListener('pointerdown', (ev) => {
    down = true;
    try { el.setPointerCapture?.(ev.pointerId); } catch { /* CDP 合成事件可能没有可捕获的真实指针 */ }
    fn(ev);
    ev.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => { if (down) fn(ev); });
  el.addEventListener('pointerup', () => { down = false; });
  el.addEventListener('pointercancel', () => { down = false; });
}

function makePopup() {
  const el = document.createElement('div');
  el.id = 'ss-color-picker';
  el.className = 'sscp';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '颜色');
  el.innerHTML = `
    <div class="sscp-head"><span>颜色</span><span class="sscp-preview"></span><button type="button" class="sscp-x" data-act="cancel" aria-label="关闭">×</button></div>
    <div class="sscp-body">
      <div class="sscp-columns">
        <div class="sscp-left">
          <div class="sscp-label">基本颜色(B):</div>
          <div class="sscp-palette" data-palette="basic"></div>
          <div class="sscp-label sscp-custom-label">自定义颜色(C):</div>
          <div class="sscp-palette sscp-recent" data-palette="recent"></div>
          <button type="button" class="btn btn-mini sscp-add" data-act="add">添加到自定义颜色</button>
          <div class="sscp-actions">
            <button type="button" class="btn btn-mini" data-act="cancel">取消</button>
            <button type="button" class="btn btn-mini btn-accent" data-act="ok">确定</button>
          </div>
        </div>
        <div class="sscp-right">
          <div class="sscp-main">
            <div class="sscp-sv"><span class="sscp-sv-cursor"></span></div>
            <div class="sscp-hue"><span class="sscp-hue-cursor"></span></div>
          </div>
          <div class="sscp-current"><span class="sscp-preview sscp-preview-large"></span><span class="sscp-current-label">当前颜色</span></div>
          <div class="sscp-fields">
            <label>Hex <input data-field="hex" maxlength="7" spellcheck="false"></label>
            <label>红(R) <input data-field="r" inputmode="numeric"></label>
            <label>绿(G) <input data-field="g" inputmode="numeric"></label>
            <label>蓝(B) <input data-field="b" inputmode="numeric"></label>
            <label>色调(H) <input data-field="h" inputmode="numeric"></label>
            <label>饱和度(S) <input data-field="s" inputmode="numeric"></label>
            <label>亮度(V) <input data-field="v" inputmode="numeric"></label>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  popup = el;

  const head = el.querySelector('.sscp-head');
  let drag = null;
  head.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = { id: ev.pointerId, dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    el.classList.add('is-dragging');
    try { head.setPointerCapture(ev.pointerId); } catch {}
    ev.preventDefault();
  });
  head.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    dragged = true;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = clamp(ev.clientX - drag.dx, 4, Math.max(4, innerWidth - w - 4)) + 'px';
    el.style.top = clamp(ev.clientY - drag.dy, 4, Math.max(4, innerHeight - h - 4)) + 'px';
  });
  const endDrag = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    drag = null;
    el.classList.remove('is-dragging');
    try { head.releasePointerCapture(ev.pointerId); } catch {}
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  const sv = el.querySelector('.sscp-sv');
  bindPointer(sv, (ev) => { const p = pointerRatio(ev, sv); state.s = p.x; state.v = 1 - p.y; updateUi(); });
  const hue = el.querySelector('.sscp-hue');
  bindPointer(hue, (ev) => { state.h = pointerRatio(ev, hue).y * 360; updateUi(); });

  el.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'ok') close(true);
    else if (act === 'cancel') close(false);
    else if (act === 'add') { saveRecent(hsvToHex(state.h, state.s, state.v)); renderPalettes(); }
    const sw = ev.target.closest('[data-color]');
    if (sw) setFromHex(sw.dataset.color);
  });
  el.querySelector('[data-field="hex"]').addEventListener('change', (ev) => {
    const v = ev.target.value.trim();
    if (/^#?[0-9a-f]{3,6}$/i.test(v)) setFromHex(v);
    else ev.target.value = hsvToHex(state.h, state.s, state.v).toUpperCase();
  });
  for (const id of ['r', 'g', 'b']) el.querySelector('[data-field="' + id + '"]').addEventListener('change', () => {
    const rgb = hsvToRgb(state.h, state.s, state.v);
    rgb[id] = clamp(parseInt(field(id).value, 10) || 0, 0, 255);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); state.h = hsv.h; state.s = hsv.s; state.v = hsv.v; updateUi();
  });
  for (const id of ['h', 's', 'v']) el.querySelector('[data-field="' + id + '"]').addEventListener('change', () => {
    const h = id === 'h' ? clamp(parseFloat(field(id).value) || 0, 0, 360) : state.h;
    const s = id === 's' ? clamp((parseFloat(field(id).value) || 0) / 240, 0, 1) : state.s;
    const v = id === 'v' ? clamp((parseFloat(field(id).value) || 0) / 240, 0, 1) : state.v;
    state.h = h; state.s = s; state.v = v; updateUi();
  });
  return el;
}

function renderPalettes() {
  if (!popup) return;
  const basic = popup.querySelector('[data-palette="basic"]');
  const recent = popup.querySelector('[data-palette="recent"]');
  basic.innerHTML = PRESETS.map(c => `<button type="button" class="sscp-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
  const r = readRecent();
  recent.innerHTML = Array.from({ length: RECENT_MAX }, (_, i) => r[i]
    ? `<button type="button" class="sscp-swatch" data-color="${r[i]}" style="background:${r[i]}" title="${r[i]}"></button>`
    : '<span class="sscp-slot" aria-hidden="true"></span>').join('');
}

function eventPoint(ev) {
  const x = Number(ev?.clientX), y = Number(ev?.clientY);
  return (x || y) ? { x, y } : null;
}

function placePopup() {
  if (!popup || !activeInput) return;
  const w = popup.offsetWidth || 560, h = popup.offsetHeight || 440;
  if (dragged) {
    popup.style.left = clamp(parseFloat(popup.style.left) || 8, 4, Math.max(4, innerWidth - w - 4)) + 'px';
    popup.style.top = clamp(parseFloat(popup.style.top) || 8, 4, Math.max(4, innerHeight - h - 4)) + 'px';
    return;
  }
  if (openPoint) {
    let left = openPoint.x + 10, top = openPoint.y + 10;
    if (left + w > innerWidth - 6) left = openPoint.x - w - 10;
    if (top + h > innerHeight - 6) top = openPoint.y - h - 10;
    popup.style.left = clamp(left, 6, Math.max(6, innerWidth - w - 6)) + 'px';
    popup.style.top = clamp(top, 6, Math.max(6, innerHeight - h - 6)) + 'px';
    return;
  }
  const r = activeInput.getBoundingClientRect();
  const left = clamp(r.left, 8, Math.max(8, innerWidth - w - 8));
  const below = r.bottom + 8;
  const top = below + h <= innerHeight - 8 ? below : clamp(r.top - h - 8, 8, Math.max(8, innerHeight - h - 8));
  popup.style.left = left + 'px'; popup.style.top = top + 'px';
}

export function open(input, point = null) {
  if (!input) return;
  if (!popup) makePopup();
  activeInput = input;
  swatchButton = input.parentElement?.querySelector('.sscp-trigger') || null;
  originalValue = normalizeHex(input.value);
  openPoint = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
  dragged = false;
  setFromHex(originalValue, false);
  renderPalettes();
  popup.hidden = false;
  placePopup();
  field('hex')?.focus();
  field('hex')?.select();
}

function close(ok) {
  if (!popup || !activeInput) return;
  if (!ok) {
    activeInput.value = originalValue;
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    saveRecent(activeInput.value);
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  popup.hidden = true;
  activeInput = null;
  swatchButton = null;
  openPoint = null;
  dragged = false;
}

function syncInputVisual(input, button) {
  const hex = normalizeHex(input.value);
  if (button) button.style.backgroundColor = hex;
  input.title = hex.toUpperCase();
}

function bindInput(input) {
  if (!input || input.dataset.sscpBound) return;
  input.dataset.sscpBound = '1';
  input.dataset.colorInput = '1';
  input.type = 'text';
  input.readOnly = true;
  input.autocomplete = 'off';
  input.setAttribute('aria-haspopup', 'dialog');
  input.classList.add('sscp-value');
  const shell = document.createElement('span');
  shell.className = 'sscp-control';
  input.parentNode.insertBefore(shell, input);
  shell.appendChild(input);
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'sscp-trigger'; button.setAttribute('aria-label', '打开取色器');
  shell.insertBefore(button, input);
  button.addEventListener('click', (ev) => { ev.preventDefault(); open(input, eventPoint(ev)); });
  input.addEventListener('click', (ev) => { ev.preventDefault(); open(input, eventPoint(ev)); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(input); }
  });
  input.addEventListener('input', () => syncInputVisual(input, button));
  syncInputVisual(input, button);
  /* main.js/editor.js 会在加载或项目切换时直接写 input.value；拦截原生 setter，
   * 让旁边的色块也同步，而不改变 value 的标准语义。 */
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.get && desc?.set) Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => desc.get.call(input),
    set: (v) => { desc.set.call(input, v); syncInputVisual(input, button); },
  });
}

export function init(root = document) {
  root.querySelectorAll('input[type="color"], input[data-color-input]').forEach(bindInput);
  if (!bound) {
    bound = true;
    document.addEventListener('pointerdown', (ev) => {
      if (!popup || popup.hidden || popup.contains(ev.target) || ev.target === activeInput || ev.target === swatchButton) return;
      close(false);
    }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && popup && !popup.hidden) close(false); });
    window.addEventListener('resize', () => { if (popup && !popup.hidden) placePopup(); }, { passive: true });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
  else init();
}

if (typeof window !== 'undefined') window.SSColorPicker = { open, init, normalizeHex, hexToRgb, rgbToHsv, hsvToRgb, hsvToHex };
