/**
 * 可自定义快捷键 / 鼠标手势管理器
 * - 键盘: 支持多修饰键组合(Ctrl/Alt/Shift/Meta + 键), 每个动作可绑定多个组合
 * - 鼠标: 滚轮(可带修饰键) / 左键拖动(可带修饰键) / 中键拖动 / 右键拖动 / 双击 → 可指定行为
 * - 配置存 localStorage, 可一键恢复默认
 */
const STORE_KEY = 'se.shortcuts.v1';

/* ─────────── 动作定义 ─────────── */
export const ACTIONS = [
  { id: 'playPause', name: '播放 / 暂停', group: '播放', defaults: ['Space', 'K'] },
  { id: 'seekBack2', name: '后退 2 秒', group: '播放', defaults: ['ArrowLeft'] },
  { id: 'seekFwd2', name: '前进 2 秒', group: '播放', defaults: ['ArrowRight'] },
  { id: 'seekBack5', name: '后退 5 秒', group: '播放', defaults: ['Shift+ArrowLeft'] },
  { id: 'seekFwd5', name: '前进 5 秒', group: '播放', defaults: ['Shift+ArrowRight'] },
  { id: 'stepBack', name: '后退 1 帧 (0.04s)', group: '播放', defaults: [','] },
  { id: 'stepFwd', name: '前进 1 帧 (0.04s)', group: '播放', defaults: ['.'] },
  { id: 'gotoStart', name: '跳到开头', group: '播放', defaults: ['Home'] },
  { id: 'gotoEnd', name: '跳到结尾', group: '播放', defaults: ['End'] },

  { id: 'zoomIn', name: '时间轴放大', group: '时间轴', defaults: ['=', 'Ctrl+='] },
  { id: 'zoomOut', name: '时间轴缩小', group: '时间轴', defaults: ['-', 'Ctrl+-'] },
  { id: 'fitAll', name: '缩放至全片', group: '时间轴', defaults: ['0'] },
  { id: 'toggleFollow', name: '跟随播放开关', group: '时间轴', defaults: ['F'] },
  { id: 'prevCue', name: '上一条字幕', group: '时间轴', defaults: ['Alt+ArrowUp'] },
  { id: 'nextCue', name: '下一条字幕', group: '时间轴', defaults: ['Alt+ArrowDown'] },
  { id: 'selectPlayCue', name: '选中播放中的字幕', group: '时间轴', defaults: ['Alt+P'] },

  { id: 'applyEdit', name: '应用编辑', group: '编辑', defaults: ['Ctrl+Enter'] },
  { id: 'insertCue', name: '下方插入字幕', group: '编辑', defaults: ['Alt+N'] },
  { id: 'deleteCue', name: '删除字幕', group: '编辑', defaults: ['Alt+Delete'] },
  { id: 'focusSearch', name: '聚焦搜索框', group: '编辑', defaults: ['Ctrl+F'] },
  { id: 'exportSub', name: '导出字幕', group: '编辑', defaults: ['Ctrl+S'] },
  { id: 'openShortcuts', name: '打开快捷键设置', group: '编辑', defaults: ['Ctrl+,'] }
];

/* ─────────── 鼠标手势 ─────────── */
export const MOUSE_GESTURES = [
  { id: 'wheel', name: '滚轮' },
  { id: 'wheel+Shift', name: 'Shift + 滚轮' },
  { id: 'wheel+Ctrl', name: 'Ctrl + 滚轮' },
  { id: 'wheel+Alt', name: 'Alt + 滚轮' },
  { id: 'drag', name: '左键拖动' },
  { id: 'drag+Shift', name: 'Shift + 左键拖动' },
  { id: 'drag+Ctrl', name: 'Ctrl + 左键拖动' },
  { id: 'drag+Alt', name: 'Alt + 左键拖动' },
  { id: 'drag+Middle', name: '中键拖动' },
  { id: 'drag+Right', name: '右键拖动' },
  { id: 'dblclick', name: '双击' }
];

export const MOUSE_BEHAVIORS = [
  { id: 'zoom', name: '缩放' },
  { id: 'pan', name: '平移视图' },
  { id: 'scrub', name: '定位 / 擦洗' },
  { id: 'cue', name: '移动·改时长字幕块 (空白=平移)' },
  { id: 'edit', name: '选中并编辑条目' },
  { id: 'none', name: '无操作' }
];

const DEFAULT_MOUSE = {
  wheel: 'zoom',
  'wheel+Shift': 'pan',
  'wheel+Ctrl': 'scrub',
  'wheel+Alt': 'scrub',
  drag: 'cue',
  'drag+Shift': 'scrub',
  'drag+Ctrl': 'scrub',
  'drag+Alt': 'pan',
  'drag+Middle': 'pan',
  'drag+Right': 'scrub',
  dblclick: 'edit'
};

/* ─────────── 组合键规范化 ─────────── */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

export function comboFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  let k = e.key;
  if (!k) return null;
  if (k === ' ') k = 'Space';
  else if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null; // 仅按修饰键
  else if (k.length === 1) k = k.toUpperCase();
  return mods.concat([k]).join('+');
}

/** 鼠标事件 → 手势 id(拖动/点击类) */
export function gestureFromEvent(e, kind) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (kind === 'drag' || kind === 'click') {
    if (e.button === 1) return 'drag+Middle';
    if (e.button === 2) return 'drag+Right';
  }
  return 'drag' + (mods.length ? '+' + mods.join('+') : '');
}

export function wheelGesture(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return 'wheel' + (mods.length ? '+' + mods.join('+') : '');
}

/** 组合键可读显示 */
export function comboLabel(combo) {
  if (!combo) return '';
  const parts = combo.split('+');
  const map = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win', Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: '回车', Delete: 'Del', Home: 'Home', End: 'End' };
  // 键名可能是 '+' 等, 只映射已知名
  return parts.map(p => map[p] || p).join('+');
}

/* ─────────── 管理器 ─────────── */
class ShortcutManager {
  constructor() {
    this.bindings = {};   // actionId → [combo]
    this.mouse = Object.assign({}, DEFAULT_MOUSE);
    this._capturing = null;
    this._changeHandlers = [];
    this.load();
  }

  load() {
    const base = {};
    for (const a of ACTIONS) base[a.id] = a.defaults.slice();
    let saved = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) { saved = null; }
    if (saved && saved.bindings) {
      for (const id of Object.keys(base)) {
        if (Array.isArray(saved.bindings[id])) base[id] = saved.bindings[id].filter(x => typeof x === 'string');
      }
    }
    if (saved && saved.mouse) {
      for (const g of MOUSE_GESTURES) {
        if (typeof saved.mouse[g.id] === 'string') this.mouse[g.id] = saved.mouse[g.id];
      }
    }
    this.bindings = base;
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ bindings: this.bindings, mouse: this.mouse }));
    } catch (e) { /* 忽略存储失败 */ }
    this._emit();
  }

  reset() {
    this.bindings = {};
    for (const a of ACTIONS) this.bindings[a.id] = a.defaults.slice();
    this.mouse = Object.assign({}, DEFAULT_MOUSE);
    this.save();
  }

  onChange(fn) { this._changeHandlers.push(fn); }
  _emit() { for (const fn of this._changeHandlers) { try { fn(); } catch (e) {} } }

  /** 组合键 → 动作 id */
  actionForCombo(combo) {
    if (!combo) return null;
    for (const id of Object.keys(this.bindings)) {
      const list = this.bindings[id] || [];
      if (list.indexOf(combo) !== -1) return id;
    }
    return null;
  }

  /** 手势 → 行为 id */
  mouseBehavior(gesture) {
    return this.mouse[gesture] || 'none';
  }

  /** 冲突: 同一组合被多个动作占用 */
  conflicts() {
    const map = new Map();
    for (const id of Object.keys(this.bindings)) {
      for (const c of (this.bindings[id] || [])) {
        if (!map.has(c)) map.set(c, []);
        map.get(c).push(id);
      }
    }
    const out = [];
    for (const [c, ids] of map) if (ids.length > 1) out.push({ combo: c, actions: ids });
    return out;
  }

  /* 录入模式 */
  beginCapture(actionId, cb) { this._capturing = { actionId, cb }; }
  cancelCapture() { this._capturing = null; }
  get isCapturing() { return !!this._capturing; }
  _handleCapture(combo) {
    if (!this._capturing) return false;
    const { actionId, cb } = this._capturing;
    this._capturing = null;
    cb && cb(actionId, combo);
    return true;
  }
}

export const shortcuts = new ShortcutManager();
