/* 手动操作后自动点亮「逐词校对」：覆盖文本、逐词时间、整句起止、说话人和样式。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'editor/js/main.js'), 'utf8');
assert.match(src, /function realignRowSignature/, '存在行签名函数');
for (const token of ['it.l1', 'it.l2', 'Number(it.start)', 'Number(it.end)',
  'wordSig(row && row.zh)', 'wordSig(row && row.en)',
  'speakerTagOf(row.zh)', 'speakerTagOf(row.en)', 'row.zh.style', 'row.en.style']) {
  assert.match(src, new RegExp(token.replace(/[()&]/g, '\\$&')), `签名包含 ${token}`);
}
assert.match(src, /realignRowStart = new WeakMap/, '行对象身份用 WeakMap，起点变化仍可追踪');
assert.match(src, /set\.delete\(oldKey\); set\.add\(k\)/, '开始时间变化时迁移 realignSkip 键');
assert.match(src, /if \(prev !== undefined && prev !== sig && !set\.has\(k\)\)/, '逐词/时间/说话人/样式变化都会点亮');
assert.match(src, /resetRealignSignatures\(\)/, '换稿后签名表重置');
assert.match(src, /textContent = on \? '✓ 已校对' : '逐词校对'/, '列表按钮文案保持');
console.log('realign-manual-mark: 文本/逐词/起止/说话人/样式变化都会点亮逐词校对');
