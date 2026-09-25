/**
 * i18n: 轻量文案翻译层（choke-point / 显示出口方案）。
 *
 * 设计：**不改 400 个调用点**，而是在文案流向屏幕的必经函数（toast/确认框/徽标/
 * 时间轴标签/静态 DOM）上做翻译。语言文件是「原文 → 译文」词典：
 *   { "打开视频": "Open video", "已批量删除 {n} 条字幕": "Deleted {n} subtitles" }
 * - 键缺失 → 回退原文，界面永不缺字
 * - 带变量的文案（代码里是 ${n} 拼接）在运行时到达显示函数时已是成品字符串，
 *   用**归一化模式匹配**（数字/拉丁串归一成 ◇）找到对应模板再回填变量
 * - 语言文件动态加载：lang/<locale>.json，新增语言 = 放一个新 json
 * - zh-CN.json 的值可以直接改写来润色文案（键是原文，值可改）
 */
const LOCALE_KEY = 'ss-locale';
const FALLBACK_LOCALE = 'zh-CN';
const VAR = '\u25C7';                       // 归一化占位符 ◇

let dict = {};                              // 原文 → 译文
let normIndex = new Map();                  // 归一化模板 → 原文键（用于模糊匹配）
let locale = FALLBACK_LOCALE;
const listeners = new Set();

export function getLocale() { return locale; }
export function getLocales() {
  return [
    { id: 'zh-CN', name: '简体中文' },
    { id: 'en-US', name: 'English' },
  ];
}
export function onLocaleChange(fn) { listeners.add(fn); }

/** 归一化: 数字/拉丁字母开头的连续串 → ◇（中文与标点保留），用于模糊匹配带变量的文案 */
function normalize(s) {
  return String(s).replace(/[0-9A-Za-z_][0-9A-Za-z_.%\u2014-]*/g, VAR);
}

function rebuildIndex() {
  normIndex = new Map();
  for (const k of Object.keys(dict)) {
    const n = normalize(k);
    if (!normIndex.has(n)) normIndex.set(n, k);
  }
}

async function loadDict(loc) {
  dict = {}; normIndex = new Map();
  try {
    const r = await fetch(`lang/${loc}.json`, { cache: 'no-store' });
    if (r.ok) { dict = await r.json(); rebuildIndex(); }
  } catch {}
}

export async function initI18n() {
  locale = localStorage.getItem(LOCALE_KEY) || FALLBACK_LOCALE;
  await loadDict(locale);
  applyDom();
}

export async function setLocale(loc) {
  locale = loc;
  localStorage.setItem(LOCALE_KEY, loc);
  await loadDict(loc);
  applyDom();
  for (const fn of listeners) { try { fn(loc); } catch {} }
}

/** 翻译入口。无法匹配 → 原样返回（永不破坏界面） */
export function t(s) {
  if (s == null || typeof s !== 'string' || !s) return s;
  if (!/[\u4e00-\u9fa5]/.test(s)) return s;                    // 不含中文 → 原样(纯数字/英文/样式名)
  if (dict[s] != null) return dict[s];
  // 模糊匹配: 归一化后比对模板, 再把输入里的变量值按顺序回填进译文的占位
  const key = normIndex.get(normalize(s));
  if (key == null) return s;
  const val = dict[key];
  if (val == null) return s;
  const re = /[0-9A-Za-z_][0-9A-Za-z_.%\u2014-]*/g;
  const vars = [];
  let m;
  while ((m = re.exec(s))) { vars.push(m[0]); if (vars.length > 12) break; }
  let out = val;
  let vi = 0;
  out = out.replace(/[0-9A-Za-z_][0-9A-Za-z_.%\u2014-]*/g, () => (vars[vi++] != null ? vars[vi - 1] : ''));
  return out;
}

/** 把当前语言应用到静态 DOM（index.html 的静态文案）:
 *  文本节点按去除首尾空白后的整段文本查词典；title/placeholder 属性同样翻译 */
export function applyDom(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.currentNode;
  while (n) {
    const raw = n.nodeValue;
    if (raw && raw.trim()) {
      const key = raw.trim();
      if (key !== (dict[key] ?? key)) n.nodeValue = raw.replace(key, t(key));
    }
    n = walker.nextNode();
  }
  for (const el of root.querySelectorAll('[title],[placeholder]')) {
    for (const attr of ['title', 'placeholder']) {
      const v = el.getAttribute(attr);
      if (v && v.trim()) {
        const tv = t(v);
        if (tv !== v) el.setAttribute(attr, tv);
      }
    }
  }
}
