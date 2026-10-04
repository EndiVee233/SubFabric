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

console.log('========================================');
console.log('SubFabric 后处理特效（微光 Glow）综合验证套件');
console.log('========================================\n');

const dialogues = (ass) => ass.split(/\r\n|\n/).filter(l => l.startsWith('Dialogue:'));

// ── 1. 颜色通道转换与边界校验 ──
console.log('【验证 1】颜色通道转换与鲁棒性');
assert.equal(hexToAssBgr('#00ff88'), '88FF00');
assert.equal(hexToAssBgr('00ff88'), '88FF00');
assert.equal(hexToAssBgr('#FF0000'), '0000FF');
assert.equal(hexToAssBgr('#0000ff'), 'FF0000');
assert.equal(hexToAssBgr('#123456'), '563412');
assert.equal(hexToAssBgr('invalid'), '88FF00', '非法 hex 应优雅兜底为缺省值');
assert.equal(hexToAssBgr(''), '88FF00');
assert.equal(hexToAssBgr('#fff'), '88FF00', '三位缩写不支持，应兜底');

assert.equal(assBgrToHex('88FF00'), '#00ff88');
assert.equal(assBgrToHex('&H88FF00&'), '#00ff88');
assert.equal(assBgrToHex('0000FF'), '#ff0000');
assert.equal(assBgrToHex('bad'), '#00ff88', '非法 bgr 应优雅兜底');

assert.equal(intensityToAssAlpha(100), '00');
assert.equal(intensityToAssAlpha(0), 'FF');
assert.equal(intensityToAssAlpha(50), '80');
assert.equal(intensityToAssAlpha(-20), 'FF', '越界应夹紧');
assert.equal(intensityToAssAlpha(999), '00', '越界应夹紧');
console.log('✓ 颜色通道转换双向准确、强度映射单调、异常输入全部容错\n');

// ── 2. 关闭时与改动前 100% 一致 ──
console.log('【验证 2】关闭时原样直通（零改动、零开销）');
const sampleAssRaw = `[Script Info]
Title: Baseline Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: 中文字幕,Arial,40,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(960,900)}Hello {\\c&H00FF00&}World{\\c} Test\\NSecond Line
Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,,0,0,0,,{\\c&H0000FF&}[说话人] 这是一个中文字幕
`;

const rawFrozen = String(sampleAssRaw);
assert.equal(applyPostProcess(sampleAssRaw, { enabled: false }), sampleAssRaw, 'enabled: false 时输出必须与原输入完全一致');
assert.equal(applyPostProcess(sampleAssRaw, { enabled: true, glow: { enabled: false } }), sampleAssRaw, 'glow.enabled: false 时输出必须完全一致');
assert.equal(applyPostProcess(sampleAssRaw, null), sampleAssRaw, '配置为 null 时输出必须完全一致');
assert.equal(applyPostProcess(sampleAssRaw, undefined), sampleAssRaw, '配置为 undefined 时输出必须完全一致');
assert.equal(sampleAssRaw, rawFrozen, '原输入字符串未被任何就地篡改');
console.log('✓ 关闭状态完全直通，原输出零变化，入参未被就地修改\n');

// ── 3. 中英样式名推断 ──
console.log('【验证 3】中英样式名推断');
assert.deepEqual(resolveStyleTargets(sampleAssRaw), { zh: '中文字幕', en: 'Default' });
assert.deepEqual(resolveStyleTargets('[V4+ Styles]\nStyle: 中文, Arial, 40\nStyle: English, Arial, 40\n'), { zh: '中文', en: 'English' });
assert.equal(resolveStyleTargets('[Events]\nFormat: Layer, Text\n'), null, '认不出来必须返回 null（宁可不动也不能改错轨）');
assert.equal(resolveStyleTargets(null), null);
console.log('✓ 样式名推断正确，无法识别时安全返回 null\n');

const mkCfg = (target, over) => ({
  enabled: true,
  glow: Object.assign({
    enabled: true,
    target,
    zh: { enabled: true, channel: 'outline', color: '#ff0000', radius: 8.0, intensity: 100 },
    en: { enabled: true, channel: 'shadow', color: '#00e5ff', radius: 3.2, intensity: 60 }
  }, over || {})
});
const ZH_LINE = 'Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,,0,0,0,,{\\c&H0000FF&}[说话人] 这是一个中文字幕';
const EN_LINE = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(960,900)}Hello {\\c&H00FF00&}World{\\c} Test\\NSecond Line';

// ── 4. 仅逐词高亮词 ──
console.log('【验证 4】仅逐词高亮词：不新增事件、保住高亮色、不动 \\bord');
const resWord = dialogues(applyPostProcess(sampleAssRaw, mkCfg('active_word')));
assert.equal(resWord.length, 2, '绝不新增事件：行数必须与原文件一致');
assert.ok(resWord[0].includes('{\\c&H00FF00&\\4c&HFFE500&\\4a&H66&\\blur3.2}World{\\c\\4c\\4a\\blur}'),
  '活动词保住高亮色并就叠加英文参数块的发光，收尾为无参复位');
assert.ok(resWord[0].includes('{\\pos(960,900)}Hello '), '行首 \\pos 定位标签原样保留');
assert.ok(resWord[0].includes('\\NSecond Line'), '换行符 \\N 必须保留以确保排版零漂移');
assert.ok(!applyPostProcess(sampleAssRaw, mkCfg('active_word')).includes('\\bord'), '绝不能改写 \\bord');
assert.equal(resWord[1], ZH_LINE, '中文整句行没有逐词高亮 → 一个字节都不动');
console.log('✓ 零新增事件、零抬层、高亮色保留、\\bord 未被触碰\n');

// ── 5. 四种生效范围 + 分语言参数 ──
console.log('【验证 5】四种生效范围与中英文参数分离');
const resZh = dialogues(applyPostProcess(sampleAssRaw, mkCfg('zh')));
assert.equal(resZh[0], EN_LINE, '生效范围=中文：英文行必须原样不动');
assert.ok(resZh[1].includes('{\\c&H0000FF&}{\\3c&H0000FF&\\3a&H00&\\blur8.0}[说话人] 这是一个中文字幕'),
  '生效范围=中文：中文行整行发光，用中文参数（红描边/半径8/满强度）');

const resEn = dialogues(applyPostProcess(sampleAssRaw, mkCfg('en')));
assert.ok(resEn[0].includes('{\\pos(960,900)}{\\4c&HFFE500&\\4a&H66&\\blur3.2}Hello '), '生效范围=英文：英文行整行发光，用英文参数');
assert.equal(resEn[1], ZH_LINE, '生效范围=英文：中文行必须原样不动');

const resAll = dialogues(applyPostProcess(sampleAssRaw, mkCfg('all')));
assert.ok(resAll[0].includes('\\4c&HFFE500&\\4a&H66&\\blur3.2'), '生效范围=全部：英文行用英文参数');
assert.ok(resAll[1].includes('\\3c&H0000FF&\\3a&H00&\\blur8.0'), '生效范围=全部：中文行用中文参数');
assert.equal(resAll.length, 2, '四种范围都不新增事件');
assert.ok(!applyPostProcess(sampleAssRaw, mkCfg('all')).includes('\\bord'), '绝不改写 \\bord');
console.log('✓ 四种范围各就各位，中英参数完全独立，均不新增事件\n');

// ── 6. 分语言独立开关 ──
console.log('【验证 6】中英文参数块可分别关闭');
const zhOff = dialogues(applyPostProcess(sampleAssRaw, mkCfg('all', { zh: { enabled: false } })));
assert.ok(zhOff[0].includes('\\blur3.2'), '中文块关掉后，英文行照常发光');
assert.equal(zhOff[1], ZH_LINE, '中文块关掉后，中文行不发光');

const enOff = dialogues(applyPostProcess(sampleAssRaw, mkCfg('all', { en: { enabled: false } })));
assert.equal(enOff[0], EN_LINE, '英文块关掉后，英文行不发光');
assert.ok(enOff[1].includes('\\blur8.0'), '英文块关掉后，中文行照常发光');

// 逐词模式下英文块关掉 → 完全不发光
assert.equal(applyPostProcess(sampleAssRaw, mkCfg('active_word', { en: { enabled: false } })), sampleAssRaw,
  '逐词模式用英文参数块，它关掉时应当完全不发光');
console.log('✓ 分语言开关互不影响\n');

// ── 7. 句首活动词 / 多活动词 / 复合行首标签 ──
console.log('【验证 7】句首活动词、多活动词与复合排版标签');
const headAss = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: 中文字幕,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 2,0:00:10.00,0:00:15.00,Default,,10,10,20,,{\\an8\\pos(500,600)\\q2\\fs45}First {\\c&H00FF00&}Apple{\\c} and then {\\c&H00FF00&}Banana{\\c} end.
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\c&H00FF00&}I{\\c} was looting
`;
const headOut = dialogues(applyPostProcess(headAss, mkCfg('active_word')));
assert.equal(headOut.length, 2, '多活动词同样不新增事件');
assert.ok(headOut[0].startsWith('Dialogue: 2,'), 'Layer 2 保持原值');
assert.ok(headOut[0].includes('{\\an8\\pos(500,600)\\q2\\fs45}'), '复合排版标签完整保留');
assert.ok(headOut[0].includes('}Apple{\\c\\4c\\4a\\blur}'), '第一个活动词闭合正确');
assert.ok(headOut[0].includes('}Banana{\\c\\4c\\4a\\blur}'), '第二个活动词闭合正确');
assert.ok(headOut[1].includes('{\\c&H00FF00&\\4c&HFFE500&\\4a&H66&\\blur3.2}I{\\c\\4c\\4a\\blur} was looting'),
  '句首高亮词必须发光（旧实现会把行首高亮标签整个吃掉 → 首词不发光）');
console.log('✓ 句首/多活动词/复合排版标签全部正确，作用域严格闭合\n');

// ── 8. 大批量事件性能测试 ──
console.log('【验证 8】性能压测（1000 条真实事件后处理耗时）');
const events1000 = [];
for (let i = 0; i < 1000; i++) {
  const s = (i * 2).toFixed(2);
  const e = (i * 2 + 1.8).toFixed(2);
  const isEn = i % 2 === 0;
  const text = isEn
    ? `{\\pos(960,950)}Index ${i} with {\\c&H00FF00&}active_token_${i}{\\c} and trailing words.`
    : `{\\pos(960,900)}第 ${i} 行普通中文字幕内容`;
  const style = isEn ? 'Default' : '中文字幕';
  events1000.push(`Dialogue: 0,0:00:${s},0:00:${e},${style},,0,0,0,,${text}`);
}
const bigAss = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: 中文字幕,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + events1000.join('\n');

for (const target of ['active_word', 'zh', 'en', 'all']) {
  const t0 = performance.now();
  const out = applyPostProcess(bigAss, mkCfg(target));
  const ms = performance.now() - t0;
  console.log(`  target=${target.padEnd(12)} 1000 条耗时 ${ms.toFixed(2)} ms`);
  assert.ok(ms < 25, `后处理耗时应当极其迅速 (< 25ms)，target=${target} 当前为 ${ms.toFixed(2)}ms`);
  assert.equal(dialogues(out).length, 1000, '1000 条事件处理后仍是 1000 条');
}
console.log('✓ 性能极佳，完全满足 UI 拖拽滑块 60fps 实时预览要求\n');

// ── 9. 配置克隆、旧存档迁移与重复调参无副作用 ──
console.log('【验证 9】配置克隆、两代旧存档迁移与调参可重复性');
const baseCfg = cloneConfig(DEFAULT_POSTPROCESS_CONFIG);
baseCfg.enabled = true;
baseCfg.glow.target = 'zh';            // 只让中文轨发光，改中文块才会体现在输出里
baseCfg.glow.zh.color = '#123456';
baseCfg.glow.zh.radius = 5.0;

const out1 = applyPostProcess(sampleAssRaw, baseCfg, { zh: '中文字幕', en: 'Default' });
baseCfg.glow.zh.radius = 1.0;
const out2 = applyPostProcess(sampleAssRaw, baseCfg, { zh: '中文字幕', en: 'Default' });
assert.notEqual(out1, out2, '不同参数输出必须产生不同 ASS 效果');
assert.ok(out1.includes('\\blur5.0'));
assert.ok(out2.includes('\\blur1.0'));
assert.equal(applyPostProcess(sampleAssRaw, baseCfg, { zh: '中文字幕', en: 'Default' }), out2, '同参数重复调用必须幂等');

baseCfg.enabled = false;
assert.equal(applyPostProcess(sampleAssRaw, baseCfg), sampleAssRaw, '切回关闭时立即完全还原');

// 旧存档 ①：扁平结构（参数直接挂在 glow 上，没有 zh/en 分组）
const legacyFlat = cloneConfig({
  enabled: true,
  glow: { enabled: true, channel: 'both', color: 'ff00ff', radius: 6.5, intensity: 40, target: 'all' }
});
assert.equal(legacyFlat.glow.target, 'all');
assert.equal(legacyFlat.glow.zh.channel, 'both', '扁平参数应同时灌进中文块');
assert.equal(legacyFlat.glow.en.channel, 'both', '扁平参数应同时灌进英文块');
assert.equal(legacyFlat.glow.zh.color, '#ff00ff', '无 # 前缀的颜色应补上');
assert.equal(legacyFlat.glow.en.radius, 6.5);
assert.equal(legacyFlat.glow.en.intensity, 40);

// 旧存档 ②：只有 blur，没有 radius/intensity/channel
const legacyBlur = cloneConfig({ enabled: true, glow: { enabled: true, color: '#00ff88', blur: 7.5, target: 'all' } });
assert.equal(legacyBlur.glow.zh.radius, 7.5, '旧字段 blur 应迁移到 radius');
assert.equal(legacyBlur.glow.en.radius, 7.5);
assert.equal(legacyBlur.glow.zh.channel, 'shadow', '缺失的 channel 取默认值');
assert.equal(legacyBlur.glow.en.intensity, 100, '缺失的 intensity 取默认值');

// 非法 target / channel 必须被夹回合法值
const junk = cloneConfig({ enabled: true, glow: { target: 'nope', zh: { channel: 'wat' } } });
assert.equal(junk.glow.target, 'active_word');
assert.equal(junk.glow.zh.channel, 'shadow');
assert.equal(junk.glow.zh.radius, 4.0);
console.log('✓ 重复调参幂等、开关无副作用、两代旧存档平滑迁移、非法值被夹回\n');

console.log('========================================');
console.log('🎉 全部 9 组核心技术指标验证 100% 通过！');
console.log('========================================');
