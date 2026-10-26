/* Material You 莫奈取色：从图片像素挑种子色 + 设置页接线契约。
 *
 *  · 不是取平均色（平均常是灰）：按 15° 色相桶、饱和度² 与中等明度权重打分；
 *  · 透明/过暗/过亮/灰像素跳过，灰图走中性兜底；
 *  · studio.js 只在 Material You 主题显示「从图片取色」，素材是当前背景图。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { seedFromPixels } from '../editor/js/monet.js';

const root = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const pixels = (colors) => {
  const w = 8, h = 8, data = new Uint8ClampedArray(w * h * 4);
  colors.forEach((c, i) => {
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = c[3] === undefined ? 255 : c[3];
  });
  return [data, w, h];
};
const hueOf = hex => {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
};

const green = seedFromPixels(...pixels(Array.from({ length: 64 }, (_, i) => i < 58 ? [58, 143, 74] : [221, 51, 51])));
assert.match(green, /^#[0-9a-f]{6}$/, '返回合法 #rrggbb');
assert.ok(hueOf(green) > 90 && hueOf(green) < 160, '主色取占比高的绿色而不是占比低的红色：' + green);

const blueOrange = seedFromPixels(...pixels(Array.from({ length: 64 }, () => [30, 90, 220])));
assert.ok(hueOf(blueOrange) > 190 && hueOf(blueOrange) < 260, '蓝色图取到蓝色：' + blueOrange);

const gray = seedFromPixels(...pixels(Array.from({ length: 64 }, () => [128, 128, 128])));
assert.match(gray, /^#[0-9a-f]{6}$/, '灰图有中性兜底');
assert.ok(Math.abs(parseInt(gray.slice(1, 3), 16) - parseInt(gray.slice(3, 5), 16)) < 4, '灰图不凭空染色');

assert.equal(seedFromPixels(new Uint8ClampedArray(64 * 4), 8, 8), null, '全透明返回 null');
assert.equal(seedFromPixels(null, 8, 8), null, '空数据安全');
assert.equal(seedFromPixels(new Uint8ClampedArray(4), 0, 0), null, '零尺寸安全');

const studio = read('editor/js/studio.js');
const template = read('tools/templates/studio.html');
const css = read('editor/css/studio.css');
assert.match(studio, /await import\('\.\/monet\.js'\)/, 'studio.js 动态加载 monet 模块（旧服务缺文件也不会拖垮整个界面）');
assert.doesNotMatch(studio, /^import .*monet\.js/m, 'monet 模块不能顶层静态 import');
assert.match(template, /id="sf-monet-row"[\s\S]*?id="sf-color-from-image"[\s\S]*?id="sf-monet-file"/, '设置页有莫奈取色入口与图片选择');
assert.match(studio, /monetRow\.hidden = pack\.design !== 'material'/, '莫奈取色只在 Material You 显示');
assert.match(studio, /prepareBackgroundImage\(file\)[\s\S]*?extractSeedFromImageSrc\(data\)/, '从选择的图片提取种子色（兼容 HEIC）');
assert.match(studio, /commit\(\{ accent: seed \}\)[\s\S]*?applyTheme\(\)/, '取色后写回并应用主题');
assert.match(studio, /图片里没有找到可用的颜色/, '取不到颜色时明确报错');
assert.match(css, /\[hidden\] \{ display: none !important; \}/, '隐藏态不会被布局覆盖');
assert.match(css, /#sf-monet-row \{ margin-top:14px; padding-top:14px; border-top:1px solid var\(--line\); \}/, '莫奈取色与上行拉开距离');

console.log('monet: 图片种子色提取（色相桶/中性兜底/透明安全）与 MY 设置页接线通过');
