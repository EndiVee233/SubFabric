import assert from 'node:assert/strict';
import {
  parseCssColor, compositeColor, relativeLuminance, contrastRatio, shouldUseLightText,
} from '../editor/js/glass-contrast.js';

const near = (a, b, eps = 1.5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

assert.deepEqual(parseCssColor('#000'), { r: 0, g: 0, b: 0, a: 1 });
assert.deepEqual(parseCssColor('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
assert.deepEqual(parseCssColor('#11223380').a.toFixed(3), '0.502');
assert.deepEqual(parseCssColor('rgb(10 20 30 / 40%)'), { r: 10, g: 20, b: 30, a: 0.4 });
assert.deepEqual(parseCssColor('rgba(10, 20, 30, 0.4)'), { r: 10, g: 20, b: 30, a: 0.4 });
const srgb = parseCssColor('color(srgb 0.5 0.25 0)');
near(srgb.r, 127.5); near(srgb.g, 63.75); near(srgb.b, 0);
assert.equal(parseCssColor('oklab(0.5 0 0)'), null);
assert.equal(parseCssColor('transparent').a, 0);

const composite = compositeColor({ r: 0, g: 0, b: 0, a: 0.3 }, { r: 255, g: 255, b: 255, a: 1 });
near(composite.r, 178.5); near(composite.g, 178.5); near(composite.b, 178.5);
assert.equal(composite.a, 1);
near(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
near(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
near(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, 0.01);

// 真实截图里的深灰背景（约 #5b5d62）应切浅色；浅色纸面不应切。
assert.equal(shouldUseLightText({ background: parseCssColor('#5b5d62') }), true);
assert.equal(shouldUseLightText({ background: parseCssColor('#6d6d6d') }), true);
assert.equal(shouldUseLightText({ background: parseCssColor('#f6f7f2') }), false);
assert.equal(shouldUseLightText({ background: parseCssColor('#a6a6a6') }), false);
// 30% 黑压在浅底上的中间值不一定需要切；切不切都以 3:1 浅色可读性为底线。
for (const hex of ['#8d8f90', '#999999', '#b3b3b3']) {
  const bg = parseCssColor(hex);
  const light = parseCssColor('#f8f8f3');
  const expected = relativeLuminance(bg) < 0.30 && contrastRatio(light, bg) >= 3;
  assert.equal(shouldUseLightText({ background: bg }), expected, hex);
}

console.log('glass-contrast-test: ok');
