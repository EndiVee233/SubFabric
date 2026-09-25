// 扫描 index.html + js/*.js 里所有含中文的字符串字面量与静态文本,
// 生成 lang/zh-CN.json（键=原文, 值=原文, 供用户直接改值润色）。
// 用法: node tests/gen-lang.mjs  (或在 editor 目录外运行也可)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ED = path.resolve(HERE, '..', 'editor');
const OUT = path.join(ED, 'lang', 'zh-CN.json');

const strings = new Set();
const add = (s) => { const k = String(s).trim(); if (/[\u4e00-\u9fa5]/.test(k) && k.length >= 2) strings.add(k); };

// ── index.html: 文本节点 + title/placeholder 属性 ──
const html = fs.readFileSync(path.join(ED, 'index.html'), 'utf8');
for (const m of html.matchAll(/>([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g)) add(m[1]);
for (const m of html.matchAll(/(title|placeholder)="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) add(m[2]);

// ── js: 字符串字面量(排除注释行) ──
for (const f of fs.readdirSync(path.join(ED, 'js'))) {
  if (!f.endsWith('.js')) continue;
  const lines = fs.readFileSync(path.join(ED, 'js', f), 'utf8').split('\n');
  for (const line of lines) {
    if (!/[\u4e00-\u9fa5]/.test(line)) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;          // 注释跳过
    // 单引号 / 双引号 / 反引号 字面量
    for (const m of line.matchAll(/'([^']*[^\u0000-䶿][^']*|[^']*[\u4e00-\u9fa5][^']*)'/g)) add(m[1]);
    for (const m of line.matchAll(/"([^"]*[\u4e00-\u9fa5][^"]*)"/g)) add(m[1]);
    for (const m of line.matchAll(/`([^`]*[\u4e00-\u9fa5][^`]*)`/g)) {
      // 模板串: 把 ${...} 归一成 {x} 作为键(显示出口的模糊匹配按归一化比对)
      let k = m[1].replace(/\$\{[^}]*\}/g, '{x}');
      add(k);
    }
  }
}

const out = {};
for (const s of [...strings].sort()) out[s] = s;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('zh-CN.json 已生成:', Object.keys(out).length, '条文案');
