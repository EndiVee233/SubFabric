/**
 * 文案层（display-choke-point）。
 *
 * **界面只有中文**：工具是给国人做双语字幕（中/英字幕轨）的，英文 UI 没有意义 —— 多语言已移除，
 * `lang/en-US.json` 也删了。这里保留下来的是它**另一个**用途：
 * `lang/zh-CN.json` 是「原文 → 原文」词典（键=原文，值可改），想让文案更对自己胃口（"打开"改成"载入"
 * 之类）就直接改那个文件的值，不用碰代码。键缺失一律回退原文，界面永不缺字。
 *
 * 设计：**不改 400 个调用点**，而是在文案流向屏幕的必经函数（toast / 确认框 / 徽标 / 时间轴标签 /
 * 静态 DOM）上查一次词典。带变量的文案在运行时到达显示函数时已是成品字符串，用**归一化模式匹配**
 * （数字/拉丁串归一成 ◇）找到模板再回填变量。
 */
const DICT_URL = 'lang/zh-CN.json';
const VAR = '\u25C7';                       // 归一化占位符 ◇

let dict = {};                              // 原文 → 译文
let normIndex = new Map();                  // 归一化模板 → 原文键（用于模糊匹配）

export function getLocale() { return 'zh-CN'; }

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

async function loadDict() {
  dict = {}; normIndex = new Map();
  try {
    const r = await fetch(DICT_URL, { cache: 'no-store' });
    if (r.ok) { dict = await r.json(); rebuildIndex(); }
  } catch {}
}

export async function initI18n() {
  await loadDict();
  applyDom();
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

/** 把词典应用到静态 DOM（index.html 的静态文案）:
 *  文本节点按去除首尾空白后的整段文本查词典；title/placeholder 属性同样处理 */
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
