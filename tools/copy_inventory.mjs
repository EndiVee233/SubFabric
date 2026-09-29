/* 文案清单提取（开发用）：把用户可见的中文文案按文件+行号列出来，供文案审评。
 * 用法: node tools/copy_inventory.mjs   → 写 _t/copy_inventory.md
 * 覆盖: index.html(文本/title/placeholder) · editor/js/*.js 与 editor/*.js 的字符串字面量
 *       · editor/server.js 的返回消息 · 托盘脚本 editor/scripts/tray.ps1
 * 不覆盖: 代码注释(不可见) —— 评论里出现的中文不参与审评。
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanCopy } from './lib/copy_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = 'D:/Vibe Coding/_t/copy_inventory.md';
const lines = scanCopy(ROOT);

/* 输出 */
const byFile = new Map();
for (const r of lines) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}
let md = '# SubFabric 用户可见文案清单\n\n';
md += `共 ${lines.length} 条（去重后）。kind: text=界面文本 / title·placeholder=悬停与占位 / str·tpl=JS 里的提示与消息\n\n`;
for (const [file, rows] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  md += `## ${file}（${rows.length} 条）\n\n`;
  for (const r of rows.sort((a, b) => a.line - b.line)) {
    md += `- L${r.line} [${r.kind}] ${r.text}\n`;
  }
  md += '\n';
}
writeFileSync(OUT, md);
console.log(`${lines.length} 条文案 → ${OUT}`);
for (const [file, rows] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${file}: ${rows.length}`);
}
