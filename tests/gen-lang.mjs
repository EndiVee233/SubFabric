// 扫描全部用户可见中文文案，生成 lang/zh-CN.json（键=原文, 值=原文, 供用户直接改值润色）。
// 覆盖: studio.html（文本/title/placeholder/aria-label/alt/value）· js/*.js · server.js · scripts/*
// 带变量的模板串把变量归一成 ◇（运行时 i18n.js 按位置回填实际值）；
// JS 里的 HTML 模板只收「屏幕上真正出现的那段文字」，不收整段标签。
// 用法: node tests/gen-lang.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanCopy } from '../tools/lib/copy_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ED = path.join(ROOT, 'editor');
const OUT = path.join(ED, 'lang', 'zh-CN.json');

const strings = new Set();
const add = (s) => {
  const k = String(s).replace(/\$\{[^}]*\}/g, '\u25C7').trim();
  if (/[\u4e00-\u9fa5]/.test(k) && k.length >= 2) strings.add(k);
};

// 统一走共享扫描器：studio.html（文本/属性）+ js/*.js + server.js + scripts/*，
// 自动跳过 JS 注释和 HTML 注释；这样 gen-lang 与文案盘点/覆盖率测试口径一致。
for (const { text } of scanCopy(ROOT)) add(text);

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
// 旧版本有、当前源码不再出现的键也保留：词典是用户可编辑文件，不能因为重构
// 就静默删掉用户已经润色过的措辞。要清理用 --reset。
let preserved = 0;
if (!RESET) for (const [k, v] of Object.entries(prev)) if (!(k in out)) { out[k] = v; preserved++; }
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n');
console.log('zh-CN.json 已更新:', Object.keys(sorted).length, '条文案（保留改过的', kept, '条，保留旧键', preserved, '条）');
