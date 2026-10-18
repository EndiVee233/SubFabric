import assert from 'node:assert/strict';
import { applyPostProcess, cloneConfig } from './jsmod/postprocess.js';

let count = 0;
const check = fn => { fn(); count++; };

const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,65,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,10,10,10,1
Style: 中文字幕,Arial,65,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,中文字幕,Spoke,0,0,0,,{\\c&H0C0CF3&}[Spoke] 你好
Dialogue: 0,0:00:01.00,0:00:03.00,Default,Spoke,0,0,0,,{\\c&H00FF00&}Hello{\\c} world
Dialogue: 0,0:00:04.00,0:00:06.00,中文字幕,Wemmbu,0,0,0,,{\\c&HF65C8B&}[Wemmbu] 再见
Dialogue: 0,0:00:04.00,0:00:06.00,Default,Wemmbu,0,0,0,,{\\c&H00FF00&}Bye{\\c} world
Dialogue: 0,0:00:07.00,0:00:08.00,Default,Ghost,0,0,0,,{\\c&H00FF00&}Ghost{\\c} world
Dialogue: 0,0:00:09.00,0:00:11.00,中文字幕,Mapicc,0,0,0,,{\\c&H0C0CF3&}[Spoke] 甲
Dialogue: 0,0:00:09.00,0:00:11.00,Default,Mapicc,0,0,0,,{\\c&H00FF00&}Alpha{\\c} line
Dialogue: 0,0:00:11.00,0:00:13.00,中文字幕,Mapicc,0,0,0,,{\\c&H8080FF&}[Mapicc] 乙
Dialogue: 0,0:00:11.00,0:00:13.00,Default,Mapicc,0,0,0,,{\\c&H00FF00&}Beta{\\c} line
Dialogue: 0,0:00:13.00,0:00:15.00,中文字幕,JamatoP,0,0,0,,{\\c&H00FF00&}[JamatoP] 老兄 这正是我一直想做的事
Dialogue: 0,0:00:13.00,0:00:15.00,Default,JamatoP,0,0,0,,{\\c&H00FF00&}Dude{\\c} this is what I have always set out to do`;

const TARGETS = { zh: '中文字幕', en: 'Default' };
const mk = (target = 'active_word', followRole = true) => cloneConfig({
  enabled: true,
  glow: {
    enabled: true,
    target,
    followRole,
    zh: { enabled: true, channel: 'shadow', color: '#00ff88', radius: 4, intensity: 100 },
    en: { enabled: true, channel: 'shadow', color: '#00ff88', radius: 4, intensity: 100 }
  },
  grow: { enabled: false },
  fadein: { enabled: false }
});
const out = cfg => applyPostProcess(ASS, cfg, TARGETS);
const dialogue = (text, style, name) => text.split(/\r?\n/).find(l => l.startsWith('Dialogue:') && l.includes(`,${style},${name},`));
const withText = (text, style, name, needle) => text.split(/\r?\n/).find(l => l.startsWith('Dialogue:') && l.includes(`,${style},${name},`) && l.includes(needle));

console.log('== 角色色 → 微光颜色 ==');
check(() => assert.equal(cloneConfig({}).glow.followRole, false, '旧配置默认不跟随角色'));
check(() => assert.equal(cloneConfig({ glow: { followRole: true } }).glow.followRole, true, 'followRole 被保留'));

const followed = out(mk('active_word', true));
const spokeEn = dialogue(followed, 'Default', 'Spoke');
const wemmbuEn = dialogue(followed, 'Default', 'Wemmbu');
const spentZh = dialogue(followed, '中文字幕', 'Spoke');
check(() => assert.ok(spokeEn.includes('\\4c&H0C0CF3&'), 'Spoke 的活动词微光用红色角色色'));
check(() => assert.ok(wemmbuEn.includes('\\4c&HF65C8B&'), 'Wemmbu 的活动词微光用紫色角色色'));
check(() => assert.ok(!spokeEn.includes('\\4c&H88FF00&'), '跟随角色时不使用固定绿色'));
check(() => assert.ok(!spentZh.includes('\\4c&H'), '活动词模式不改中文行发光'));

const fixed = out(mk('active_word', false));
check(() => assert.ok(dialogue(fixed, 'Default', 'Spoke').includes('\\4c&H88FF00&'), '关闭时保留手动颜色'));
check(() => assert.ok(dialogue(fixed, 'Default', 'Wemmbu').includes('\\4c&H88FF00&'), '关闭时两个角色都用同一个手动色'));

const zhOnly = out(mk('zh', true));
check(() => assert.ok(dialogue(zhOnly, '中文字幕', 'Spoke').includes('\\4c&H0C0CF3&'), '中文整行微光跟随角色'));
check(() => assert.ok(!dialogue(zhOnly, 'Default', 'Wemmbu').includes('\\4c&H'), '中文模式不碰英文行'));

const all = out(mk('all', true));
check(() => assert.ok(dialogue(all, '中文字幕', 'Spoke').includes('\\4c&H0C0CF3&'), 'all 模式中文跟随角色'));
check(() => assert.ok(dialogue(all, 'Default', 'Wemmbu').includes('\\4c&HF65C8B&'), 'all 模式英文跟随各自角色'));
check(() => assert.ok(dialogue(followed, 'Default', 'Ghost').includes('\\4c&H88FF00&'), '没有角色色的行回退手动色'));
// 同一个 Name（Mapicc）下有两个不同角色 → 必须按中文行/时间转色，不能按 Name 合并
check(() => assert.ok(withText(followed, 'Default', 'Mapicc', 'Alpha').includes('\\4c&H0C0CF3&'), '同 Name 的 Spoke 行仍用红色'));
check(() => assert.ok(withText(followed, 'Default', 'Mapicc', 'Beta').includes('\\4c&H8080FF&'), '同 Name 的 Mapicc 行用紫色'));
// JamatoP 的角色色本身就是逐词高亮绿：有 [JamatoP] 时必须保留绿标，不能当泄漏剥掉
check(() => assert.ok(dialogue(all, '中文字幕', 'JamatoP').includes('[JamatoP]'), '中文 JamatoP 行仍在'));
check(() => assert.ok(dialogue(all, '中文字幕', 'JamatoP').includes('\\c&H00FF00&'), '绿色角色色标没有被剥掉'));
check(() => assert.ok(dialogue(all, 'Default', 'JamatoP').includes('\\4c&H00FF00&'), '绿色角色微光保持绿色'));

console.log(`\n${count} assertions passed`);
