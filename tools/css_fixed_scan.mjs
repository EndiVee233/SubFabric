// 列出 style.css 中所有 position:fixed 规则块及选择器（含所在行号）
import { readFileSync } from 'node:fs';
const s = readFileSync(new URL('../editor/css/style.css', import.meta.url), 'utf8');
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(s))) {
  if (/position:\s*fixed/.test(m[2])) {
    const line = s.slice(0, m.index).split('\n').length;
    console.log('L' + line, m[1].trim().replace(/\s+/g, ' ').slice(0, 90));
  }
}
