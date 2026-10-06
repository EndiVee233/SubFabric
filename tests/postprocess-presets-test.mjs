/**
 * SubFabric 后处理特效 —— 词生长 (Grow) / 柔和淡入 (Fade In) 验证套件
 *
 * ★ 最重要的一组是【验证 4】：全局不变式「输出永不含 `\t(`」。
 *   这条就是本套件存在的理由 —— libass 的 `\t` 会执行
 *      state->detect_collisions = 0;        // ass_parse.c:694
 *   让该事件彻底退出碰撞避让（ass_render.c:3216/3255 两处 continue），
 *   结果就是中英双行直接叠在一起。用 ffmpeg+libass 实测确认过：
 *     静态 `\fscx\fscy` → 文字带 3 条 ✓   带动画 `\t()` → 2 条 ✗（哪怕空转）
 *   所以只要有人把 `\t` 加回来，这条断言立刻变红。
 *
 * 覆盖要点（对应 postprocess.js 文件头「设计要点」第 1~10 条）：
 *   - 不新增事件、不抬 Layer、不碰 \bord（要点 1/2）
 *   - 词生长用静态缩放、柔和淡入用 \fade，两者都不打断避让（要点 6/7/9/10）
 *   - 淡入时长钳制在事件自身长度内（要点 8）
 *   - 旧存档平滑迁移（老存档无 grow/fadein 键，或 grow.scale 是旧语义）
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_POSTPROCESS_CONFIG,
  cloneConfig,
  applyPostProcess,
  assTimeToMs,
  resolveAnimDuration,
  opacityToAlphaValue
} from '../editor/js/postprocess.js';

console.log('========================================');
console.log('SubFabric 后处理特效：词生长 / 柔和淡入');
console.log('========================================\n');

const dialogues = (ass) => ass.split(/\r\n|\n/).filter(l => l.startsWith('Dialogue:'));
const body = (ass, i) => dialogues(ass)[i].split(',,').slice(1).join(',,');

const ASS = `[Script Info]
Title: Preset Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
Style: 中文字幕,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(960,900)}Hello {\\c&H00FF00&}World{\\c} Test
Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,,0,0,0,,{\\c&H0000FF&}[说话人] 这是中文字幕
`;

const ZH_LINE = 'Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕,,0,0,0,,{\\c&H0000FF&}[说话人] 这是中文字幕';
const EN_LINE = 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(960,900)}Hello {\\c&H00FF00&}World{\\c} Test';

const BASE_GLOW = {
  enabled: true, target: 'active_word',
  zh: { enabled: true, channel: 'shadow', color: '#00ff88', radius: 4.0, intensity: 100 },
  en: { enabled: true, channel: 'shadow', color: '#00ff88', radius: 4.0, intensity: 100 }
};
const OFF_GLOW = { ...BASE_GLOW, enabled: false };

/** 只开指定特效的配置（其余关掉，方便断言纯净标签） */
const mk = (grow, fadein) => ({
  enabled: true,
  glow: OFF_GLOW,
  grow: Object.assign({ enabled: true, scale: 130 }, grow || {}),
  fadein: Object.assign({ enabled: false, target: 'zh', from: 55, duration: 300, ratio: 70 }, fadein || {})
});

// ── 1. ASS 时间码解析与时长钳制 ──
console.log('【验证 1】ASS 时间码解析与动画时长钳制');
assert.equal(assTimeToMs('0:00:01.00'), 1000);
assert.equal(assTimeToMs('0:00:01.50'), 1500);
assert.equal(assTimeToMs('0:01:00.00'), 60000);
assert.equal(assTimeToMs('1:00:00.00'), 3600000);
assert.equal(assTimeToMs('0:00:01.5'), 1500, '单位数百分秒应补零');
assert.equal(assTimeToMs('0:00:01.123'), 1123, '三位毫秒秒数');
assert.equal(assTimeToMs('0:00:01'), 1000, '无小数部分');
assert.equal(assTimeToMs('garbage'), null, '非法时间码必须返回 null 而不是 0');
assert.equal(assTimeToMs(''), null);
assert.equal(assTimeToMs(null), null);

assert.equal(resolveAnimDuration(300, 2000, 70), 300, '配置时长小于事件时长时用配置值');
assert.equal(resolveAnimDuration(800, 200, 70), 140, '要点8：超出事件长度时按 ratio% 钳制');
assert.equal(resolveAnimDuration(800, 200, 50), 100, 'ratio 越小钳得越狠');
assert.equal(resolveAnimDuration(240, null, 85), 240, '事件时长未知时只用配置值');

assert.equal(opacityToAlphaValue(100), 0, '100% 不透明 → 0');
assert.equal(opacityToAlphaValue(0), 255, '0% → 255');
assert.equal(opacityToAlphaValue(55), 115, '55% → 115（\\fade 用十进制）');
console.log('✓ 时间码解析正确、时长钳制按事件长度生效、alpha 映射正确\n');

// ── 2. 关闭态逐字节直通 ──
console.log('【验证 2】关闭状态逐字节直通');
const frozen = String(ASS);
assert.equal(applyPostProcess(ASS, { enabled: false }), ASS);
assert.equal(applyPostProcess(ASS, cloneConfig(DEFAULT_POSTPROCESS_CONFIG)), ASS, '默认配置必须原样输出');
assert.equal(applyPostProcess(ASS, {
  enabled: true,
  glow: { enabled: false, zh: { enabled: true }, en: { enabled: true } },
  grow: { enabled: false }, fadein: { enabled: false }
}), ASS, '三个特效全关时必须原样输出');
assert.equal(applyPostProcess(ASS, null), ASS);
assert.equal(applyPostProcess(ASS, undefined), ASS);
assert.equal(ASS, frozen, '入参未被就地篡改');
console.log('✓ 未开启时零改动、零开销，入参不可变\n');

// ── 3. 词生长：静态放大标签 ──
console.log('【验证 3】词生长：静态放大（不是动画）');
const growOut = applyPostProcess(ASS, mk({ scale: 130 }));
assert.equal(dialogues(growOut).length, 2, '绝不新增事件：行数必须与原文件一致');
assert.ok(body(growOut, 0).includes('{\\c&H00FF00&\\fscx130\\fscy130}World{\\c\\fscx\\fscy}'),
  '活动词静态放大到 130%，收尾无参复位');
assert.ok(body(growOut, 0).includes('{\\pos(960,900)}Hello '), '行首 \\pos 定位标签原样保留');
assert.ok(!growOut.includes('\\bord'), '绝不改写 \\bord');
assert.equal(dialogues(growOut)[1], ZH_LINE, '中文整句行没有逐词高亮 → 一个字节都不动');

// 100% = 不放大 → 完全不动
assert.equal(applyPostProcess(ASS, mk({ scale: 100 })), ASS, 'scale=100 等于不放大，必须逐字节直通');
console.log('✓ 词生长只改活动词，行首标签/高亮色/\\bord 全部安全\n');

// ── 4. ★ 全局不变式：输出永不含 `\t(` ──
console.log('【验证 4】★ 不变式：输出永不含 \\t(（这是多行避让不被打断的根本保证）');
const allConfigs = [
  ['默认', cloneConfig(DEFAULT_POSTPROCESS_CONFIG)],
  ['只微光', { enabled: true, glow: BASE_GLOW }],
  ['只词生长', mk({})],
  ['只淡入', mk({ enabled: false }, { enabled: true })],
  ['三者全开', { enabled: true, glow: BASE_GLOW, grow: { enabled: true, scale: 130 }, fadein: { enabled: true, target: 'all', from: 40, duration: 400, ratio: 80 } }],
  ['生长+淡入', mk({ scale: 200 }, { enabled: true, target: 'all' })],
  ['微光整行+生长', { enabled: true, glow: { ...BASE_GLOW, target: 'all' }, grow: { enabled: true, scale: 150 }, fadein: { enabled: false } }]
];
for (const [name, cfg] of allConfigs) {
  const out = applyPostProcess(ASS, cfg, { zh: '中文字幕', en: 'Default' });
  assert.ok(!/\{?\\t\(/.test(out), `★ ${name}：输出出现 \\t( —— 会关掉 libass 碰撞避让，中英行会叠压！`);
  assert.ok(!out.includes('\\move('), `★ ${name}：输出出现 \\move(`);
  assert.ok(!out.includes('\\org('), `★ ${name}：输出出现 \\org(`);
}
console.log('✓ 所有配置组合下都不含 \\t( / \\move( / \\org( —— 碰撞避让不会被关闭\n');

// ── 5. 柔和淡入：\fade 标签 ──
console.log('【验证 5】柔和淡入：\\fade 实现（碰撞安全）');
const fadeOut = applyPostProcess(ASS, mk({ enabled: false }, { enabled: true, target: 'zh', from: 55, duration: 300, ratio: 70 }));
assert.equal(dialogues(fadeOut).length, 2, '淡入同样不新增事件');
assert.ok(body(fadeOut, 1).includes('{\\c&H0000FF&}{\\fade(115,0,0,0,300,300,300)}'),
  '中文行整行淡入：起始 alpha 115(55%) → 完全不透明，插入在行首色标之后');
assert.ok(body(fadeOut, 1).includes('[说话人] 这是中文字幕'), '正文原样保留');
assert.ok(!body(fadeOut, 1).includes('\\1a'), '「静态高亮」：不改写 alpha 标签，只挂 \\fade');
assert.ok(!body(fadeOut, 1).includes('\\fscx'), '淡入不应带缩放');
assert.equal(dialogues(fadeOut)[0], EN_LINE, '英文行不在生效范围内 → 完全不动');

// 起始 100% = 不淡入 → 完全不动
assert.equal(applyPostProcess(ASS, mk({ enabled: false }, { enabled: true, target: 'zh', from: 100 })), ASS,
  'from=100 等于不淡入，必须逐字节直通');

// 三档范围
const fzh = applyPostProcess(ASS, mk({ enabled: false }, { enabled: true, target: 'zh' }));
const fen = applyPostProcess(ASS, mk({ enabled: false }, { enabled: true, target: 'en' }));
const fall = applyPostProcess(ASS, mk({ enabled: false }, { enabled: true, target: 'all' }));
assert.ok(body(fzh, 1).includes('\\fade(') && !body(fzh, 0).includes('\\fade('), 'zh：只有中文行淡入');
assert.ok(body(fen, 0).includes('\\fade(') && !body(fen, 1).includes('\\fade('), 'en：只有英文行淡入');
assert.ok(body(fall, 0).includes('\\fade(') && body(fall, 1).includes('\\fade('), 'all：两行都淡入');
assert.ok(!fall.includes('\\bord'), '绝不改写 \\bord');
console.log('✓ 柔和淡入三档范围正确，只挂 \\fade 不碰颜色与 \\bord\n');

// ── 6. 淡入时长按事件长度钳制 ──
console.log('【验证 6】要点8：短事件不会被超长淡入拖住');
const shortAss = ASS.replace('Dialogue: 0,0:00:03.00,0:00:05.00,中文字幕', 'Dialogue: 0,0:00:03.00,0:00:03.20,中文字幕');
const clamped = applyPostProcess(shortAss, mk({ enabled: false }, { enabled: true, target: 'zh', duration: 1200, ratio: 70 }));
assert.ok(body(clamped, 1).includes('\\fade(115,0,0,0,140,140,140)'),
  '200ms 事件 × 70% = 140ms，绝不能出现 1200ms');
assert.ok(!clamped.includes('\\fade(115,0,0,0,1200'), '超长淡入必须被钳制');
console.log('✓ 超长淡入被按事件实际时长钳制\n');

// ── 7. 多特效叠加 ──
console.log('【验证 7】微光 + 词生长 + 柔和淡入三者叠加');
const all3 = applyPostProcess(ASS, {
  enabled: true, glow: BASE_GLOW,
  grow: { enabled: true, scale: 130 },
  fadein: { enabled: true, target: 'all', from: 55, duration: 300, ratio: 70 }
});
assert.equal(dialogues(all3).length, 2, '叠加后依然不新增事件');
assert.ok(body(all3, 0).includes('{\\c&H00FF00&\\4c&H88FF00&\\4a&H00&\\blur4.0\\fscx130\\fscy130}World{\\c\\4c\\4a\\blur\\fscx\\fscy}'),
  '同一 {…} 内合并 高亮色→微光→生长，收尾一次复位全部通道');
assert.ok(body(all3, 0).includes('{\\pos(960,900)}{\\fade(115,0,0,0,300,300,300)}Hello'),
  '整行 pass 的 \\fade 插在行首 \\pos 之后');
assert.ok(body(all3, 0).includes('\\blur4.0'), '微光 \\blur 保留');
assert.ok(body(all3, 1).includes('\\fade('), '中文行同样淡入');
console.log('✓ 三者叠加：逐词块与整行块各就各位，开闭标签严格配对\n');

// ── 8. 两个 pass 互不排斥 ──
console.log('【验证 8】逐词 pass 与整行 pass 互不排斥（旧实现会二选一）');
const combo = applyPostProcess(ASS, {
  enabled: true,
  glow: { ...BASE_GLOW, target: 'active_word' },
  grow: { enabled: false },
  fadein: { enabled: true, target: 'all', from: 55, duration: 300, ratio: 70 }
});
assert.ok(body(combo, 0).includes('\\blur4.0'), '同一行既要有活动词微光');
assert.ok(body(combo, 0).includes('\\fade('), '……又要有整行淡入');
console.log('✓ 同一行可同时命中逐词与整行两个 pass\n');

// ── 9. 旧存档迁移 ──
console.log('【验证 9】旧存档平滑迁移');
const legacy = cloneConfig({ enabled: true, glow: { enabled: true, target: 'zh', color: '#00ff88', radius: 6.0 } });
assert.equal(legacy.glow.enabled, true);
assert.equal(legacy.glow.zh.radius, 6.0, '原有微光参数必须完整保留');
assert.equal(legacy.grow.enabled, false, '老存档没有 grow → 必须默认关闭（升级后画面不突变）');
assert.equal(legacy.fadein.enabled, false, '老存档没有 fadein → 必须默认关闭');

// 旧 grow 语义（起始缩放，恒 <100）必须换成新默认 130，不能变成「反而变小」
const legacyGrow = cloneConfig({ enabled: true, grow: { enabled: true, target: 'active_word', scale: 72, duration: 240, ratio: 85, fade: true } });
assert.equal(legacyGrow.grow.scale, 130, '旧 scale=72（起始缩放）应迁移为 130（放大倍数）');
assert.equal(legacyGrow.grow.target, undefined, '旧 target 字段应被丢弃（生长只作用活动词）');

// 旧 fadein 的 active_word / channels 应被安全丢弃
const legacyFade = cloneConfig({ enabled: true, fadein: { enabled: true, target: 'active_word', from: 40, duration: 250, ratio: 60, channels: 'all' } });
assert.equal(legacyFade.fadein.target, 'zh', 'active_word 落回整行默认（\\fade 无法只作用一个词）');
assert.equal(legacyFade.fadein.channels, undefined, 'channels 字段应被丢弃');
assert.equal(legacyFade.fadein.from, 40, '其它参数保留');

// 非法值夹回
const junk = cloneConfig({
  enabled: true,
  grow: { enabled: true, scale: 9999 },
  fadein: { enabled: true, target: 'wat', from: 999, duration: 0, ratio: 300 }
});
assert.equal(junk.grow.scale, 250, '超界放大倍数夹到上限');
assert.equal(junk.fadein.target, 'zh');
assert.equal(junk.fadein.from, 100);
assert.equal(junk.fadein.duration, 20);
assert.equal(junk.fadein.ratio, 100);
const junk2 = cloneConfig({ enabled: true, grow: { enabled: true, scale: 10 } });
assert.equal(junk2.grow.scale, 130, '低于 100 的值按旧语义迁移为 130');
console.log('✓ 老存档无损迁移、旧语义正确换挡、非法值全部夹回\n');

// ── 10. 幂等性与性能 ──
console.log('【验证 10】幂等性与性能');
const cfg = mk({ scale: 150 }, { enabled: true, target: 'all', from: 30 });
const r1 = applyPostProcess(ASS, cfg);
const r2 = applyPostProcess(ASS, cfg);
assert.equal(r1, r2, '同参数重复调用必须幂等');
cfg.enabled = false;
assert.equal(applyPostProcess(ASS, cfg), ASS, '切回关闭立即完全还原');

// 开、关、再开 不残留
const on1 = applyPostProcess(ASS, mk({}));
applyPostProcess(ASS, { enabled: false });
const on2 = applyPostProcess(ASS, mk({}));
assert.equal(on1, on2, '关掉再打开必须得到完全相同的结果（无状态残留）');

const evs = [];
for (let i = 0; i < 1000; i++) {
  const s = (i * 2).toFixed(2);
  const e = (i * 2 + 1.8).toFixed(2);
  evs.push(i % 2 === 0
    ? `Dialogue: 0,0:00:${s},0:00:${e},Default,,0,0,0,,{\\pos(960,950)}Index ${i} {\\c&H00FF00&}word_${i}{\\c} tail`
    : `Dialogue: 0,0:00:${s},0:00:${e},中文字幕,,0,0,0,,第 ${i} 行中文字幕`);
}
const bigAss = ASS.split('[Events]')[0] + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' + evs.join('\n');
const heavy = {
  enabled: true,
  glow: { enabled: true, target: 'active_word', zh: { enabled: true }, en: { enabled: true, color: '#00ff88', radius: 4, intensity: 100 } },
  grow: { enabled: true, scale: 130 },
  fadein: { enabled: true, target: 'all', from: 55, duration: 300, ratio: 70 }
};
const t0 = performance.now();
const bigOut = applyPostProcess(bigAss, heavy);
const ms = performance.now() - t0;
console.log(`  三特效全开 · 1000 条耗时 ${ms.toFixed(2)} ms`);
assert.ok(ms < 30, `必须足够快以支撑拖滑块实时预览 (< 30ms)，实测 ${ms.toFixed(2)}ms`);
assert.equal(dialogues(bigOut).length, 1000, '1000 条处理后仍是 1000 条');
assert.ok(!/\{?\\t\(/.test(bigOut), '压测输出同样不含 \\t(');
console.log('✓ 幂等、无残留、性能满足实时预览\n');

console.log('========================================');
console.log('🎉 词生长 / 柔和淡入全部 10 组验证通过！');
console.log('========================================');
