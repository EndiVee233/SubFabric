/**
 * 文案层（display-choke-point）。
 *
 * **界面只有中文**：工具是给国人做双语字幕（中/英字幕轨）的，英文 UI 没有意义 —— 多语言已移除，
 * `lang/en-US.json` 也删了。这里保留下来的是它**另一个**用途：
 * `lang/zh-CN.json` 是「原文 → 原文」词典（键=原文，值可改），想让文案更对自己胃口（"打开"改成"载入"
 * 之类）就直接改那个文件的值，不用碰代码。键缺失一律回退原文，界面永不缺字。
 *
 * 覆盖范围（**所有用户可见文案**都能改，改完刷新页面即生效）：
 *   ① 静态 DOM：index.html 的文本 / title / placeholder / aria-label
 *   ② 显示出口：toast / 确认框 / 徽标 / 时间轴标签（这些函数里已调 t()）
 *   ③ **动态插入的 DOM**：JS 拼出来的 HTML（模型卡片说明、字幕卡角标、进度浮层日志…）
 *      由 MutationObserver 在节点落地后过一遍词典
 *   ④ 服务端返回的消息：server.js 的中文串由客户端显示时过词典
 *
 * 带变量的文案（`已替换 ${n} 处` / `模型 ${name} 不完整`）：
 *   词典键里变量位置写成 `◇`（生成器 tests/gen-lang.mjs 自动归一），运行时按位置回填实际值。
 *   归一化模式匹配把数字与拉丁串都当变量，所以 `已替换 12 处` 能命中 `已替换 ◇ 处`。
 */
const DICT_URL = 'lang/zh-CN.json';
const VAR = '\u25C7';                       // 归一化占位符 ◇
const HAN = /[\u4e00-\u9fa5]/;
/** 变量片段：`${...}` 整块，或一个裸拉丁/数字串（含 . % - 与全角破折号） */
const VAR_RE = /\$\{[^}]*\}|[0-9A-Za-z_][0-9A-Za-z_.%\u2014-]*/g;

let dict = {};                              // 原文 → 译文
let normIndex = new Map();                  // 归一化模板 → 原文键（用于模糊匹配）
const trCache = new Map();                  // 最近翻译过的原文 → 译文（避免反复归一化）

export function getLocale() { return 'zh-CN'; }

/** 归一化: `${x}` 与数字/拉丁串 → ◇（中文与标点保留），用于模糊匹配带变量的文案 */
function normalize(s) {
  return String(s).replace(/\$\{[^}]*\}/g, VAR).replace(/[0-9A-Za-z_][0-9A-Za-z_.%\u2014-]*/g, VAR);
}

function rebuildIndex() {
  normIndex = new Map();
  for (const k of Object.keys(dict)) {
    const n = normalize(k);
    if (!normIndex.has(n)) normIndex.set(n, k);
  }
  trCache.clear();
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
  watchDom();
}

/** 翻译入口。无法匹配 → 原样返回（永不破坏界面） */
export function t(s) {
  if (s == null || typeof s !== 'string' || !s) return s;
  if (!HAN.test(s)) return s;                                 // 不含中文 → 原样(纯数字/英文/样式名)
  const cached = trCache.get(s);
  if (cached != null) return cached;
  let out = s;
  if (dict[s] != null) {
    out = dict[s];
  } else {
    // 模糊匹配: 归一化后比对模板, 再把输入里的变量值按顺序回填进译文的占位
    const key = normIndex.get(normalize(s));
    const val = key == null ? null : dict[key];
    if (val != null) {
      const vars = [];
      let m;
      VAR_RE.lastIndex = 0;
      while ((m = VAR_RE.exec(s))) { vars.push(m[0]); if (vars.length > 12) break; }
      let vi = 0;
      // 值里的占位有三形态：◇（词典规范形）、${x}（未规范化的手写值）、裸拉丁串 —— 都要按位置回填
      out = String(val).replace(/\u25C7|\$\{[^}]*\}|[0-9A-Za-z_][0-9A-Za-z_.%\u2014-]*/g,
        () => (vars[vi] != null ? vars[vi++] : ''));
    }
  }
  trCache.set(s, out);
  return out;
}

/** 不该被词典碰的节点：用户正在编辑的、表单控件、脚本样式、画布 */
function skipNode(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CANVAS' || tag === 'TEXTAREA' ||
      tag === 'INPUT' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function inSkipped(el) {
  for (let n = el; n; n = n.parentElement) if (skipNode(n)) return true;
  return false;
}

/** 把一个文本节点按词典替换（保留首尾空白；整段匹配不上就不动） */
function trTextNode(n) {
  const raw = n.nodeValue;
  if (!raw || !HAN.test(raw)) return;
  const key = raw.trim();
  if (!key) return;
  const tv = t(key);
  if (tv === key) return;
  n.nodeValue = raw.replace(key, tv);
}

/**
 * 把词典应用到一段 DOM（含动态插入的节点）。root 默认 document。
 * 只处理「整段文本等于词典键」的节点；匹配不上的一律不动。
 */
export function applyDom(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && HAN.test(n.nodeValue) && !inSkipped(n.parentElement)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  let n = walker.currentNode;
  while (n) { trTextNode(n); n = walker.nextNode(); }
  if (root.querySelectorAll) {
    for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
      if (inSkipped(el)) continue;
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (!v || !HAN.test(v)) continue;
        const tv = t(v.trim());
        if (tv !== v.trim()) el.setAttribute(attr, v.replace(v.trim(), tv));
      }
    }
  }
}

/* ── 动态 DOM：JS 拼出来的 HTML 落地后也过一遍词典 ──
 * 用 MutationObserver 而不是给 400 个调用点加 t()：与「在文案流向屏幕的必经处查一次」同思路。
 * 幂等（译文查不到键就不再变），因此不会自我循环；列表每 1.5s 重绘也只是 Map 查表。 */
let mo = null;
let pending = null;
function flush() {
  const nodes = pending;
  pending = null;
  if (!nodes) return;
  for (const n of nodes) {
    if (!n.isConnected) continue;
    if (n.nodeType === 3) { if (!inSkipped(n.parentElement)) trTextNode(n); }
    else if (n.nodeType === 1) applyDom(n);
  }
}
function queue(n) {
  if (!pending) { pending = new Set(); queueMicrotask(flush); }
  pending.add(n);
}
export function watchDom() {
  if (mo || typeof MutationObserver !== 'function') return;
  mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') queue(m.target);
      else if (m.type === 'attributes') queue(m.target);
      else for (const n of m.addedNodes) queue(n);
    }
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'],
  });
}
