import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanCopy } from '../tools/lib/copy_scan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'editor/lang/zh-CN.json'), 'utf8'));
const missing = new Map();
for (const { file, line, text } of scanCopy(ROOT)) {
  const key = String(text).replace(/\$\{[^}]*\}/g, '◇').replace(/\s+/g, ' ').trim();
  if (!/[\u4e00-\u9fa5]/.test(key) || key.length < 2) continue;
  if (!(key in dict)) missing.set(key, file + ':' + line);
}
assert.equal(
  missing.size, 0,
  '以下用户可见文案还没有进 editor/lang/zh-CN.json：\n'
    + [...missing].slice(0, 20).map(([k, where]) => where + ' ' + k).join('\n'),
);
console.log('i18n-coverage-test: ok (' + Object.keys(dict).length + ' keys)');
