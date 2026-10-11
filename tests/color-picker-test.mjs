/* 自绘取色器的纯数学回归：不打开浏览器也能钉住颜色往返。 */
import assert from 'node:assert/strict';
import { normalizeHex, hexToRgb, rgbToHsv, hsvToRgb, hsvToHex } from './jsmod/color-picker.js';

let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log('  ok ', name); };

console.log('== 1. Hex 规范化 ==');
ok(normalizeHex('#ABC') === '#aabbcc', '三位 Hex 展开');
ok(normalizeHex('ABCDEF') === '#abcdef', '无 # 的六位 Hex');
ok(normalizeHex('#bad-value', '#123456') === '#123456', '非法值回退');

console.log('\n== 2. RGB / HSV 往返 ==');
for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ad5cff', '#173a92', '#00ff88']) {
  const rgb = hexToRgb(hex);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const got = hsvToHex(hsv.h, hsv.s, hsv.v);
  ok(got === hex, `${hex} → HSV → Hex = ${got}`);
  const back = hsvToRgb(hsv.h, hsv.s, hsv.v);
  ok(Math.max(Math.abs(back.r - rgb.r), Math.abs(back.g - rgb.g), Math.abs(back.b - rgb.b)) <= 1,
    `${hex} → HSV → RGB 误差 ≤ 1`);
}

console.log('\n== 3. Firefox 风格数值边界 ==');
ok(hsvToHex(0, 1, 1) === '#ff0000', 'H=0/S=240/V=240 对应红色');
ok(hsvToHex(120, 1, 1) === '#00ff00', 'H=120 对应绿色');
ok(hsvToHex(240, 1, 1) === '#0000ff', 'H=240 对应蓝色');
ok(hsvToHex(360, 1, 1) === '#ff0000', 'H=360 与 H=0 等价');
ok(hsvToHex(200, 0, 0.5) === '#808080', 'S=0 是灰阶，H 不影响结果');

console.log(`\n${pass} passed, 0 failed`);
