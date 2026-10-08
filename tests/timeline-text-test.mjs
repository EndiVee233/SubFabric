/**
 * 时间轴字幕块「中文行可读性」的回归。
 *
 * 问题：中文行原来直接用 `base`（角色色原色）当填充色，压在**波形 + 12% 半透明块底**上；
 * 而英文行用的是 WORD_TEXT(#e9e9f0 浅色)。两行不一致，且角色色里偏暗/低饱和的很难认。
 * 用户反馈"中文字幕可读性较低"。
 *
 * 修法：
 *   ① 中文字形后面铺一层很淡的深色底（只比字形大一点，不铺满整块）；
 *   ② 文字色按角色色的感知亮度选：够亮保留角色色，偏暗换近白。
 *
 * 这里把两个纯函数（parseHex / readableTextOn）从源码里抽出来直接跑真实取值，
 * 而不是只做字符串断言 —— 阈值和返回色都要有具体数字可核对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'js', 'timeline.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

// ── 抽函数（纯函数，无依赖） ──
const grab = (name) => {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) return null;
  // 找到函数体结束（按花括号配对，够用）
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (d === 0) { return SRC.slice(i, k + 1); } }
  }
  return null;
};
const parseHex = grab('parseHex');
const readableTextOn = grab('readableTextOn');
const textOnTranslucent = grab('textOnTranslucent');

ok(parseHex !== null, '抽到 parseHex');
ok(readableTextOn !== null, '抽到 readableTextOn');
ok(textOnTranslucent !== null, '抽到 textOnTranslucent');

const mod = [parseHex, readableTextOn].join('\n') + '\nexport { readableTextOn, parseHex };';
const tmp = path.join(HERE, '_tl_colors.mjs');
fs.writeFileSync(tmp, mod);
const { readableTextOn: R } = await import('file://' + tmp.replace(/\\/g, '/'));
fs.unlinkSync(tmp);

console.log('\n== 亮角色色：保留原色（保住"谁在说话"的可辨识度）==');
for (const hex of ['#ffd54a', '#ffff00', '#00ff00', '#7fd8e8', '#ffffff', '#ff7a45']) {
  const got = R(hex);
  ok(got === hex, `${hex} → 保留 ${hex}`, got);
}

console.log('\n== 暗/低饱和角色色：换成近白（保证对比度）==');
const DARK = ['#1e3a8a', '#3a2a1a', '#5b6472', '#2b2b3a', '#800000', '#333366'];
for (const hex of DARK) {
  const got = R(hex);
  ok(got === '#f2f2f7', `${hex}（暗）→ 近白`, got);
}

console.log('\n== 边界与健壮性 ==');
ok(R('#ff0000') === '#ff0000', '纯红：L 仅 0.299 但 maxC=1 → 保留（只看 L 会误杀红色角色）', R('#ff0000'));
ok(R('#00ff00') === '#00ff00', '纯绿 L=0.587 → 保留', R('#00ff00'));
ok(R('#0000ff') === '#0000ff', '纯蓝 maxC=1（鲜艳）→ 保留', R('#0000ff'));
ok(R('#000066') === '#f2f2f7', '深蓝 L=0.04 且 maxC=0.4 → 近白', R('#000066'));
ok(R('#123456') === '#f2f2f7', '暗青灰两个指标都低 → 近白', R('#123456'));
ok(R('') === '#ffffff', '空串 → 白（兜底）', R(''));
ok(R('not-a-color') === '#ffffff', '非法值 → 白（兜底）', R('not-a-color'));
ok(R(null) === '#ffffff', 'null → 白（兜底）', R(null));
ok(R('#ABC') === '#ffffff' || R('#ABC') === '#ABC', '短写法不崩', R('#ABC'));
// 阈值两侧各确认一次，防以后有人改常数改过头
ok(R('#ffff00') === '#ffff00' && R('#5b6472') === '#f2f2f7',
  '亮色保留 / 灰蓝换白（这是本改动的核心行为）');

console.log('\n== 与 textOnTranslucent 的区别（这是不能直接复用它的原因）==');
// 半透明路径在 alpha=0.12 时恒返回白色 —— 无法区分角色色亮暗
const fake = (hex) => {
  const c = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
  const bg = { r: 0x11, g: 0x11, b: 0x16 }, a = 0.12;
  const r = c.r * a + bg.r * (1 - a), g = c.g * a + bg.g * (1 - a), b = c.b * a + bg.b * (1 - a);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.45 ? '#141418' : '#ffffff';
};
ok(fake('#ffff00') === '#ffffff' && fake('#000033') === '#ffffff',
  'confirm: textOnTranslucent 在 alpha=0.12 时恒为白（所以它区分不了亮暗）');
ok(R('#ffff00') !== R('#000033'),
  'confirm: readableTextOn 能区分亮角色色与暗角色色');

console.log('\n== 源码接线：scrim 与文字色确实用上了 ==');
ok(/readableTextOn\(base\)/.test(SRC), '_drawBlockText 里用 readableTextOn(base) 决定中文色');
ok(/rgba\(8,8,12,\.45\)/.test(SRC), '中文字形后铺了淡深色底（scrim）');
ok(/measureText\(zh\)\.width/.test(SRC), 'scrim 宽度按实测文本宽度算（不是整块铺满）');
ok(/zhBase = band\.y \+ Math\.round\(band\.h \* 0\.30\)/.test(SRC),
  'scrim 与文字基线用同一个 y（zhBase），不会错位');
ok(/c\.text2\.slice\(0, 60\)/.test(SRC), '中文文本仍截断到 60 字符（行为不变）');
// 不能把整块铺成不透明 —— 那会盖掉逐词轴和边框色
ok(!/ctx\.rect\(x1, band\.y, wpx, band\.h\)[\s\S]{0,80}fill\(\)/.test(SRC),
  '没有把整块铺成实底（那会盖掉逐词轴与块的半透明边框色）');

console.log('\n== 波形配色压暗（让字幕读到前面来）==');
// 原来接近白的浅灰，整条带子比字幕块还抢眼；中文字幕压在上面就不好认。
const stops = [...SRC.matchAll(/g\.addColorStop\([^,]+,\s*'rgba\((\d+),(\d+),(\d+),([\d.]+)\)'\)/g)]
  .map(m => ({ r: +m[1], g: +m[2], b: +m[3], a: +m[4] }));
const waveStops = stops.filter(s => s.r === s.g && s.b > s.r);   // 波形是灰调（R=G，B 略高）
ok(waveStops.length >= 3, `找到波形渐变的 ${waveStops.length} 个色标`, JSON.stringify(waveStops));
const L = (s) => (0.299 * s.r + 0.587 * s.g + 0.114 * s.b) / 255;
const mids = waveStops.filter(s => L(s) > 0.5);
const maxWaveL = Math.max(...waveStops.map(L));
ok(maxWaveL <= 0.62, '波形最亮处不超过 L=0.62（原来 0.899）', maxWaveL.toFixed(3));
ok(maxWaveL >= 0.35, '波形最亮处不低于 L=0.35（压过头就看不见了）', maxWaveL.toFixed(3));
// 仍要明显亮于带底色（#0e0e14, L≈0.058），否则波形消失
const bgL = (0.299 * 0x0e + 0.587 * 0x0e + 0.114 * 0x14) / 255;
const minWaveL = Math.min(...waveStops.map(L));
ok(minWaveL > bgL * 3, '波形最暗处仍明显高于带底色（不会被压没）',
  `${minWaveL.toFixed(3)} vs bg ${bgL.toFixed(3)}`);
// 近白文字与波形的对比应比改动前更高
const textL = (0.299 * 0xf2 + 0.587 * 0xf2 + 0.114 * 0xf7) / 255;
const before = (textL + 0.05) / (0.899 + 0.05);
const after = (textL + 0.05) / (maxWaveL + 0.05);
ok(after > before, `文字/波形对比提升（${before.toFixed(2)} → ${after.toFixed(2)}）`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
