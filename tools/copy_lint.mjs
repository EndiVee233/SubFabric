/* 文案自检（去 AI 味）: node tools/copy_lint.mjs [--all] [--rule=dash]
 *  默认只列强制项（非 white）；--all 连提示项一起列；--rule=<id> 只看某条规则。
 * 退出码: 有强制违规 → 1（可用于发版前卡口）。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { scanCopy, RULES } from './lib/copy_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const only = (argv.find(a => a.startsWith('--rule=')) || '').split('=')[1] || '';

const items = scanCopy(ROOT);
const results = [];
for (const rule of RULES) {
  if (only && rule.id !== only) continue;
  if (rule.white && !showAll && !only) continue;
  const hits = items.filter(it => rule.re.test(it.text));
  results.push({ rule, hits });
}

let hard = 0;
console.log(`扫描 ${items.length} 条用户可见文案\n`);
for (const { rule, hits } of results) {
  const flag = rule.white ? '提示' : '强制';
  console.log(`[${flag}] ${rule.name} —— ${hits.length} 条   （${rule.advice}）`);
  if (!rule.white) hard += hits.length;
  for (const h of hits.slice(0, only ? 100 : 6)) {
    console.log(`    ${h.file}:${h.line}  ${h.text.slice(0, 96)}`);
  }
  if (!only && hits.length > 6) console.log(`    … 其余 ${hits.length - 6} 条用 --rule=${rule.id} 看`);
  console.log('');
}
console.log(`强制违规合计 ${hard} 条${showAll ? '（含提示项）' : ''}`);
process.exit(hard ? 1 : 0);
