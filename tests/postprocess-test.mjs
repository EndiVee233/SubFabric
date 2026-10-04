import assert from 'node:assert/strict';
import {
  DEFAULT_POSTPROCESS_CONFIG,
  cloneConfig,
  hexToAssBgr,
  assBgrToHex,
  intensityToAssAlpha,
  resolveStyleTargets,
  applyPostProcess
} from '../editor/js/postprocess.js';

console.log('--- 测试 1: 颜色通道转换 ---');
assert.equal(hexToAssBgr('#00ff88'), '88FF00');
assert.equal(hexToAssBgr('#ff0000'), '0000FF');
assert.equal(hexToAssBgr('#123456'), '563412');
assert.equal(hexToAssBgr('nope'), '88FF00');
assert.equal(assBgrToHex('88FF00'), '#00ff88');
assert.equal(assBgrToHex('&H0000FF&'), '#ff0000');
assert.equal(intensityToAssAlpha(100), '00', '100% 强度 = 完全不透明');
assert.equal(intensityToAssAlpha(0), 'FF', '0% 强度 = 全透明');
assert.equal(intensityToAssAlpha(50), '80');
console.log('颜色转换通过！');

console.log('--- 测试 2: 关闭状态直通 ---');
const sampleAss = `[Script Info]
Title: Sample
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: 中文字幕,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello {\\c&H00FF00&}world{\\c} today
Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Full gap sentence
Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,,0,0,0,,{\\c&HFF33FF&}[说话人] 这是中文字幕
`;

assert.equal(applyPostProcess(sampleAss, { enabled: false }), sampleAss, '关闭状态必须原样输出！');
assert.equal(applyPostProcess(sampleAss, { enabled: true, glow: { enabled: false } }), sampleAss, '微光分开关关闭时必须原样输出！');
assert.equal(applyPostProcess(sampleAss, null), sampleAss, '配置为 null 时必须原样输出！');
console.log('关闭直通测试通过！');

console.log('--- 测试 3: 样式名推断 ---');
assert.deepEqual(resolveStyleTargets(sampleAss), { zh: '中文字幕', en: 'Default' });
assert.equal(resolveStyleTargets('[Events]\nFormat: Layer, Text\n'), null, '认不出来时必须返回 null');
console.log('样式名推断通过！');

const mkCfg = (target, over) => ({
  enabled: true,
  glow: Object.assign({
    enabled: true,
    target,
    zh: { enabled: true, channel: 'outline', color: '#ff0000', radius: 8.0, intensity: 100 },
    en: { enabled: true, channel: 'shadow', color: '#00e5ff', radius: 3.2, intensity: 60 }
  }, over || {})
});

const lines = (ass) => ass.split(/\r\n|\n/).filter(l => l.startsWith('Dialogue:'));
const ZH_LINE = 'Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,,0,0,0,,{\\c&HFF33FF&}[说话人] 这是中文字幕';
const EN_LINE = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello {\\c&H00FF00&}world{\\c} today';

console.log('--- 测试 4: 仅逐词高亮词（用英文字幕参数）---');
const resWord = lines(applyPostProcess(sampleAss, mkCfg('active_word')));
assert.equal(resWord.length, 3, '绝不新增事件 —— 行数必须与原文件一致');
assert.ok(resWord[0].includes('{\\c&H00FF00&\\4c&HFFE500&\\4a&H66&\\blur3.2}world{\\c\\4c\\4a\\blur}'),
  '活动词保住高亮色并叠加英文参数块的发光，收尾用无参复位');
assert.ok(!resWord[0].includes('\\bord'), '绝不能改写 \\bord');
assert.equal(resWord[1], 'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Full gap sentence');
assert.equal(resWord[2], ZH_LINE, '仅逐词模式下中文字幕行一个字节都不动');
console.log('仅逐词高亮词通过！');

console.log('--- 测试 5: 生效范围 = 中文字幕 ---');
const resZh = lines(applyPostProcess(sampleAss, mkCfg('zh')));
assert.equal(resZh[0], EN_LINE, '英文行必须原样不动');
assert.equal(resZh[1], 'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Full gap sentence');
assert.ok(resZh[2].includes('{\\c&HFF33FF&}{\\3c&H0000FF&\\3a&H00&\\blur8.0}[说话人] 这是中文字幕'),
  '中文行整行发光，且用中文参数块（红描边 / 半径 8 / 满强度）');
console.log('生效范围=中文通过！');

console.log('--- 测试 6: 生效范围 = 英文字幕 ---');
const resEn = lines(applyPostProcess(sampleAss, mkCfg('en')));
assert.ok(resEn[0].includes('{\\4c&HFFE500&\\4a&H66&\\blur3.2}Hello '), '英文行整行发光，用英文参数块');
assert.ok(resEn[1].includes('\\blur3.2'), '英文轨上的空档行同样属于「英文字幕」，也整行发光');
assert.equal(resEn[2], ZH_LINE, '中文行必须原样不动');
console.log('生效范围=英文通过！');

console.log('--- 测试 7: 生效范围 = 中英文全部（各用各自参数）---');
const resAll = lines(applyPostProcess(sampleAss, mkCfg('all')));
assert.ok(resAll[0].includes('\\4c&HFFE500&\\4a&H66&\\blur3.2'), '英文行用英文参数');
assert.ok(resAll[2].includes('\\3c&H0000FF&\\3a&H00&\\blur8.0'), '中文行用中文参数');
assert.notEqual(resAll[0].split('\\blur')[1], resAll[2].split('\\blur')[1], '两行的发光参数必须不同');
console.log('生效范围=中英文全部通过！');

console.log('--- 测试 8: 分语言独立开关 ---');
const resZhOff = lines(applyPostProcess(sampleAss, mkCfg('all', {
  zh: { enabled: false, channel: 'outline', color: '#ff0000', radius: 8.0, intensity: 100 }
})));
assert.ok(resZhOff[0].includes('\\blur3.2'), '英文块开着 → 英文行仍发光');
assert.equal(resZhOff[2], ZH_LINE, '中文块关掉 → 中文行不发光');

const resEnOff = lines(applyPostProcess(sampleAss, mkCfg('all', {
  en: { enabled: false, channel: 'shadow', color: '#00e5ff', radius: 3.2, intensity: 60 }
})));
assert.equal(resEnOff[0], EN_LINE, '英文块关掉 → 英文行不发光');
assert.ok(resEnOff[2].includes('\\blur8.0'), '中文块开着 → 中文行仍发光');
console.log('分语言独立开关通过！');

console.log('--- 测试 9: 调用方传入的样式名优先于自动推断 ---');
const forced = applyPostProcess(sampleAss, mkCfg('zh'), { zh: 'Default', en: '中文字幕' });
const forcedLines = lines(forced);
assert.ok(forcedLines[0].includes('\\blur8.0'), '按传入映射，Default 被当成中文轨 → 用中文参数');
assert.equal(forcedLines[2], ZH_LINE, '中文字幕行此时被当成英文轨 → 不动');
console.log('样式名覆盖通过！');

console.log('--- 测试 10: 行首定位标签与换行保留 ---');
const posOut = lines(applyPostProcess(sampleAss, mkCfg('en')))[0];
assert.ok(posOut.includes('Hello '), '正文保持');
assert.ok(posOut.split('\\N').length === 1, '本样例无换行');

const posAss = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: 中文字幕,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(192,200)\\an5}Wait for {\\c&H00FF00&}me{\\c} here\\Nsecond line
`;
const posEn = lines(applyPostProcess(posAss, mkCfg('en')))[0];
assert.ok(posEn.includes('{\\pos(192,200)\\an5}{\\4c&HFFE500&\\4a&H66&\\blur3.2}Wait for '), '发光标签插在 \\pos\\an 之后');
assert.ok(posEn.includes('\\Nsecond line'), '换行符 \\N 必须保留');
assert.equal(posEn.split('\\N').length, 2, '换行数量不变');
console.log('定位标签与换行保留通过！');

console.log('\n全部基础测试通过！');
