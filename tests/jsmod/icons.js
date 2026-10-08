/**
 * 内联 SVG 图标集（统一 24×24 网格 / 描边风格 / currentColor）。
 *
 * 为什么不用 emoji：emoji 在不同机器上是不同的彩色贴图，字重、留白、基线都不受控，
 * 一排按钮里混着 📁📄💾 会显得"拼凑"；换成同一套描边图标后，按钮的视觉重量才一致。
 *
 * 用法：
 *   import { ico } from './icons.js';
 *   btn.innerHTML = ico('folder') + '打开视频';     // 文本节点保持独立 → i18n 的文本节点翻译照旧生效
 *   el.innerHTML = ico('trash', 'x') + '删除';      // 第二个参数是额外 class
 * 注意：**不要**把图标塞进文本节点中间（会拆散文案，词典就匹配不上了）。
 */
const P = {
  /* 品牌/导航 */
  film: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M2.5 9h19M2.5 15h19"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/>',
  /* 文件/媒体 */
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  file: '<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  inbox: '<path d="M3 13.5 5.5 5h13L21 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13.5h5l1 2h6l1-2h5"/>',
  download: '<path d="M12 3.5v11"/><path d="M7.5 10 12 14.5 16.5 10"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 20.5v-11"/><path d="M7.5 14 12 9.5 16.5 14"/><path d="M4.5 4.5h15"/>',
  /* 动作 */
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4.5h-4.5"/>',
  rotate: '<path d="M12 5.5a6.5 6.5 0 1 1-6.5 6.5"/><path d="M12 2.5v3.2M12 2.5 9.6 5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6.5 6.5 7.5 19a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12.5"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
  wrench: '<path d="M14.5 6.8a3.7 3.7 0 0 1 5.2 5.2L9.6 22H6.5L4 19.5v-3.1z"/>',
  pencil: '<path d="M4 20h3.5L20 7.5a2.1 2.1 0 0 0-3-3L4.5 17z"/><path d="M14.5 6.5l3 3"/>',
  sliders: '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5z"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3M9 21h6"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.8s-.6-1.7-.6-2.6c0-1 .8-1.8 1.9-1.8h1.4a3.8 3.8 0 0 0 3.8-3.8c0-3.9-3.8-7-8.5-7z"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="8" r="1.2"/><circle cx="15.8" cy="10.4" r="1.2"/>',
  activity: '<path d="M3.5 12.5h4l2-6 3.5 11 2.5-7 1.5 2h3.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  eraser: '<path d="M8 19.5h11.5"/><path d="M4.5 15.5 12 8l4.5 4.5-4 4H7.5z"/><path d="M12 8l3.5-3.5a1.6 1.6 0 0 1 2.3 0l2.2 2.2a1.6 1.6 0 0 1 0 2.3L16.5 12.5"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  /* 状态 */
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.2"/>',
  alert: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  languages: '<path d="M4 6h9M8.5 6v1.5c0 4-1.8 7.3-4.5 9.5"/><path d="M10.5 10.5c1.6 3 4 5.2 7 6.5"/><path d="M12.5 19.5l4-9 4 9"/><path d="M14 17h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1"/>',
  /* 备注 / 弹幕 */
  chat: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/><path d="M9 9.5h6M9 12.5h3.5"/>',
  /* 魔法棒：重排逐词时间 —— 逐个点词的时间轴像被"重新对齐"了一遍。
   * ⚠ 这个图标以前**不存在**：菜单项写了 data-ico="wand"，而 ico() 对未知名字
   *   返回空串，于是那行字前面一直是空的（用户报"加个图标"时才发现）。 */
  wand: '<path d="M4 20l9.5-9.5"/><path d="M15 5.5l3.5 3.5"/><path d="M13.2 7.3l3.5 3.5-2.4 2.4-3.5-3.5z"/>'
    + '<path d="M17.5 3.2v2.4M20.6 7.2h-2.4M19.6 4.2l-1.7 1.7"/>',
};

/** 取一个图标的 SVG 字符串；未知名字返回空串（不会破坏 DOM） */
export function ico(name, extraClass) {
  const path = P[name];
  if (!path) return '';
  const cls = 'ico' + (extraClass ? ' ' + extraClass : '');
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

export const ICON_NAMES = Object.keys(P);
