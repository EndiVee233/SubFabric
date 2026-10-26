/* 动态流光速度：偏好归一化、CSS 变量与设置页接线。
 *
 *  速度以倍率存 prefs.auroraSpeed（0.4~2.5，默认 1）；
 *  CSS 动画 duration = 20s / speed，通过 --sf-aurora-duration 写入；
 *  只在「动态流光」显示速度行，静态流光隐藏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults, normalizeStudio } from '../editor/js/studio-state.js';

const root = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const themes = {
  validList: () => false, asCustom: p => p, get: id => ({ id: id || 'windows-uwp' }),
  hex: v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
};
const norm = value => normalizeStudio(value, themes);

assert.equal(defaults.auroraSpeed, 1, '默认速度 1×');
assert.equal(norm({}).auroraSpeed, 1, '旧偏好自动补 1×');
assert.equal(norm({ auroraSpeed: 2.46 }).auroraSpeed, 2.5, '上限 2.5 且四舍五入到一位');
assert.equal(norm({ auroraSpeed: 0.1 }).auroraSpeed, 0.4, '下限 0.4');
assert.equal(norm({ auroraSpeed: 'fast' }).auroraSpeed, 1, '非法值回落默认');
assert.equal(norm({ auroraSpeed: 1.24 }).auroraSpeed, 1.2, '保留一位小数');

const template = read('tools/templates/studio.html');
const html = read('editor/studio.html');
const js = read('editor/js/studio.js');
const css = read('editor/css/studio.css');
assert.equal(html, template, 'studio.html 与模板一致');
assert.match(template, /id="sf-aurora-speed"[^>]*min="0.4"[^>]*max="2.5"[^>]*step="0.1"/, '速度滑杆范围 0.4~2.5');
assert.match(template, /id="sf-aurora-speed-value"/, '速度值回显');
assert.match(css, /animation-duration:var\(--sf-aurora-duration,20s\)/, '流光动画读 CSS 变量');
assert.match(js, /'--sf-aurora-duration', \(20 \/ v\)\.toFixed\(2\)/, '速度倍率换算成 duration');
assert.match(js, /auroraSpeedRow\.hidden = prefs\.auroraMotion !== 'dynamic'/, '静态流光隐藏速度行');
assert.match(js, /commit\(\{ auroraSpeed: v \}\)/, '松手后持久化速度');

console.log('aurora-speed: 1× 默认、0.4~2.5 夹取、CSS 变量与静态隐藏通过');
