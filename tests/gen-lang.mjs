// 扫描全部用户可见中文文案，生成 lang/zh-CN.json（键=原文, 值=原文, 供用户直接改值润色）。
// 覆盖: index.html（文本/title/placeholder/aria-label）· js/*.js · server.js · scripts/*
// 带变量的模板串把变量归一成 ◇（运行时 i18n.js 按位置回填实际值）；
// JS 里的 HTML 模板只收「屏幕上真正出现的那段文字」，不收整段标签。
// 用法: node tests/gen-lang.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractVisible, jsLiterals } from '../tools/lib/copy_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ED = path.resolve(HERE, '..', 'editor');
const OUT = path.join(ED, 'lang', 'zh-CN.json');

const strings = new Set();
const add = (s) => {
  const k = String(s).replace(/\$\{[^}]*\}/g, '\u25C7').trim();
  if (/[\u4e00-\u9fa5]/.test(k) && k.length >= 2) strings.add(k);
};

// ── index.html ──（静态文本允许 1 个字：开/关/把 这类切换标签用户也可能想改）
const html = fs.readFileSync(path.join(ED, 'index.html'), 'utf8');
for (const m of html.matchAll(/>([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g)) {
  const v = m[1].trim();
  if (v) strings.add(v);
}
for (const m of html.matchAll(/(title|placeholder|aria-label)="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) add(m[2]);

// ── JS（逐行剥离注释后扫字面量；HTML 模板只收屏幕上真正出现的文字）──
function scanJs(file) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const { text } of jsLiterals(src)) {
    const pieces = extractVisible(text);
    if (pieces.length) pieces.forEach(add);
    else add(text);
  }
}
for (const f of fs.readdirSync(path.join(ED, 'js'))) if (f.endsWith('.js')) scanJs(path.join(ED, 'js', f));
scanJs(path.join(ED, 'server.js'));
for (const f of fs.readdirSync(path.join(ED, 'scripts'))) {
  if (f.endsWith('.ps1') || f.endsWith('.cjs')) scanJs(path.join(ED, 'scripts', f));
}

// ⚠ 生成时**必须保留你已经改过的值**：词典是「键=原文，值=你润色后的话」，
//    天真地 out[s]=s 会把用户的润色全部冲回原文（踩过，害用户重改一遍）。
//    新增的键才填原文；已存在的键沿用现有值。要强制重置整份词典用 --reset。
const RESET = process.argv.includes('--reset');
let prev = {};
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
const out = {};
let kept = 0;
for (const s of [...strings].sort()) {
  if (!RESET && prev[s] != null) { out[s] = prev[s]; if (prev[s] !== s) kept++; }
  else out[s] = s;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('zh-CN.json 已更新:', Object.keys(out).length, '条文案（保留了你改过的', kept, '条）');
