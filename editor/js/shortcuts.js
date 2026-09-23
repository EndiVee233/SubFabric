/**
 * 固定键盘快捷键映射
 *
 * 本项目交付给非技术用户使用, 因此**不提供自定义功能**: 没有设置界面、不读写 localStorage,
 * 键位全部写死在这里, 行为始终可预期。
 *
 * 鼠标行为(滚轮平移/缩放、单击跳转、拖动改时间、空白拖动新建、右键菜单)由
 * timeline.js 自己实现, 不走这张表 —— 它们是时间轴专属交互, 没有可配置项。
 */

/* ─────────── 键盘动作(动作 id → 触发的组合键) ─────────── */
const KEY_MAP = {
  playPause: ['Space', 'K'],
  seekBack2: ['ArrowLeft'],
  seekFwd2: ['ArrowRight'],
  seekBack5: ['Shift+ArrowLeft'],
  seekFwd5: ['Shift+ArrowRight'],
  stepBack: [','],
  stepFwd: ['.'],
  gotoStart: ['Home'],
  gotoEnd: ['End'],

  zoomIn: ['=', 'Ctrl+='],
  zoomOut: ['-', 'Ctrl+-'],
  fitAll: ['0'],
  toggleFollow: ['F'],
  prevCue: ['Alt+ArrowUp'],
  nextCue: ['Alt+ArrowDown'],
  selectPlayCue: ['Alt+P'],

  applyEdit: ['Ctrl+Enter'],
  focusSearch: ['Ctrl+F'],
  exportSub: ['Ctrl+S']
};

/** 组合键 → 动作 id */
const COMBO_TO_ACTION = (() => {
  const m = new Map();
  for (const id of Object.keys(KEY_MAP)) {
    for (const c of KEY_MAP[id]) if (!m.has(c)) m.set(c, id);
  }
  return m;
})();

/* ─────────── 事件 → 记号 ─────────── */
const MODS = [
  ['ctrlKey', 'Ctrl'],
  ['altKey', 'Alt'],
  ['shiftKey', 'Shift'],
  ['metaKey', 'Meta']
];

function modsOf(e) {
  const out = [];
  for (const [prop, name] of MODS) if (e[prop]) out.push(name);
  return out;
}

/** 键盘事件 → 组合键记号(如 'Ctrl+Shift+K') */
export function comboFromEvent(e) {
  let k = e.key;
  if (!k) return null;
  if (k === ' ') k = 'Space';
  else if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;  // 仅按修饰键
  else if (k.length === 1) k = k.toUpperCase();
  return modsOf(e).concat([k]).join('+');
}

/** 对外只暴露一个查询接口 */
export const shortcuts = {
  /** 组合键 → 动作 id */
  actionForCombo(combo) {
    if (!combo) return null;
    return COMBO_TO_ACTION.get(combo) || null;
  }
};
