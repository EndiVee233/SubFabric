/* 功能 B（LLM 分角色）纯逻辑单测 —— 全离线, 用假 LLM: node tests/cast-test.mjs
 * 覆盖: 提示词/信息摘要 · 阵容解析(各种脏回复) · SPK 采样 · 对应关系解析 ·
 *       整流程(注入假 LLM) · **"3 个人物但分出 4 个 SPK → 多余的保留编号"这条核心规则** ·
 *       各步失败的降级(绝不打断初稿) */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cast = require(path.join(HERE, '..', 'editor', 'cast.js'));

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, { got: a, want: b });

const SOURCE = {
  title: '【MC 动画】我在 Unstable SMP 的一天',
  description: '本期出场：Wifies、Parrot、Wato。感谢大家的支持！',
  uploader: 'Wifies',
  duration: 612,
  tags: ['我的世界', '动画', 'SMP'],
};

console.log('== 视频信息摘要 ==');
const brief = cast.sourceBrief(SOURCE);
ok(brief.includes('标题：') && brief.includes('Wifies') && brief.includes('612 秒'), '摘要含标题/UP/时长', brief.slice(0, 60));
ok(brief.includes('简介：') && brief.includes('Parrot'), '摘要含简介');
ok(cast.sourceBrief({}) === '' && cast.sourceBrief(null) === '', '空信息 → 空摘要');
ok(cast.sourceBrief({ description: 'x'.repeat(5000) }).length < 2200, '超长简介被截断');

console.log('\n== 提示词 ==');
const cm = cast.castMessages(SOURCE);
ok(cm.length === 2 && cm[0].role === 'system' && cm[1].role === 'user', '阵容: 两条消息');
ok(cm[1].content.includes('Unstable SMP'), '阵容: 用户消息带视频信息');
ok(cast.castMessages(null)[1].content.includes('没有任何视频信息'), '阵容: 没信息时明确说明');
const mm = cast.mapMessages(SOURCE, [{ name: 'Wifies', aliases: ['Wif'] }], { SPK1: { samples: ['hello'], lines: 1, seconds: 2, firstAt: 0.5 } });
ok(mm[1].content.includes('候选角色') && mm[1].content.includes('Wifies（别名：Wif）'), '对应: 候选角色含别名');
ok(mm[1].content.includes('SPK1') && mm[1].content.includes('hello'), '对应: 带 SPK 样本');

console.log('\n== 阵容解析（脏回复容错） ==');
const good = '{"characters":[{"name":"Wifies","aliases":["Wif"],"evidence":"UP主"},{"name":"Parrot"},{"name":"Wato"}]}';
let r = cast.parseCastReply(good);
eq(r.characters.map((c) => c.name), ['Wifies', 'Parrot', 'Wato'], '标准 JSON');
ok(r.error === '' && r.characters[0].aliases[0] === 'Wif', '保留别名');
r = cast.parseCastReply('```json\n' + good + '\n```');
eq(r.characters.length, 3, '```围栏');
r = cast.parseCastReply(' thinking先想想…这里有3个人物\n可能有别人<｜end▁of▁thinking｜>\n' + good);
eq(r.characters.length, 3, '思维链前缀');
r = cast.parseCastReply('好的，我来分析一下。\n' + good + '\n以上是我的判断。');
eq(r.characters.length, 3, '前后有寒暄');
r = cast.parseCastReply('["Wifies","Parrot","Wato"]');
eq(r.characters.map((c) => c.name), ['Wifies', 'Parrot', 'Wato'], '裸数组');
r = cast.parseCastReply('{"roles":[{"character":"甲","alias":"小甲"},{"character":"乙"}]}');
eq(r.characters.map((c) => c.name), ['甲', '乙'], 'roles/character/alias 别名写法');
r = cast.parseCastReply('{"characters":[{"name":"Rick"},{"name":"Rick"},{"name":"未知"},{"name":""}]}');
eq(r.characters.map((c) => c.name), ['Rick'], '去重并丢掉"未知/空"');
r = cast.parseCastReply('{"characters":[' + Array.from({ length: 20 }, (_, i) => '{"name":"角色' + i + '"}').join(',') + ']}');
eq(r.characters.length, 12, '最多 12 个');
r = cast.parseCastReply('我不知道，视频信息太少了');
eq(r.characters, [], '非 JSON → 空列表');
ok(!!r.error, '非 JSON → 有错误说明', r.error);
r = cast.parseCastReply('{"SPK1":"甲","SPK2":"乙"}');
eq(r.characters.map((c) => c.name), ['甲', '乙'], '{"SPK1":名} 写法');
r = cast.parseCastReply('{"characters":[{"name":"' + 'x'.repeat(80) + '"}]}');
ok(r.characters[0].name.length === 40, '超长名字被截断');

console.log('\n== 说话人数量 ==');
eq(cast.speakerCountFromCast([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 6), 3, '3 个人物 → 3');
eq(cast.speakerCountFromCast([], 6), 6, '没推断出来 → 用用户的 6');
eq(cast.speakerCountFromCast([], 0), 0, '都没填 → 0（交给聚类自己定）');
eq(cast.speakerCountFromCast(Array.from({ length: 20 }, () => ({ name: 'x' })), 6), 12, '上限 12');

console.log('\n== SPK 台词采样 ==');
const segs = [
  { start: 1, end: 4, speaker: 0, text: '大家好，我是 Wifies' },
  { start: 4, end: 6, speaker: 1, text: '我是 Parrot' },
  { start: 6, end: 12, speaker: 0, text: '今天我们做点好玩的' },
  { start: 12, end: 14, speaker: 2, text: 'Wato 也来了' },
  { start: 14, end: 15, speaker: null, text: '（这段没有说话人）' },
];
let sm = cast.sampleBySpeaker(segs, {});
eq(Object.keys(sm).sort(), ['SPK1', 'SPK2', 'SPK3'], 'speaker 0 → SPK1（编号从 1 开始）');
eq(sm.SPK1.lines, 2, 'SPK1 有 2 句');
eq(sm.SPK1.seconds, 9, 'SPK1 说话 9 秒');
eq(sm.SPK1.firstAt, 1, 'SPK1 首次出现 1s');
ok(!JSON.stringify(sm).includes('没有说话人'), 'speaker 为 null 的段落不计入');
sm = cast.sampleBySpeaker([{ start: 0, end: 1, speaker: 0, text: 'x'.repeat(200) }], { perLineChars: 10 });
eq(sm.SPK1.samples[0], 'xxxxxxxxxx…', '超长台词按字数截断');
sm = cast.sampleBySpeaker([{ start: 0, end: 1, speaker: 0, text: 'x'.repeat(50) }], { totalChars: 10 });
eq(sm.SPK1.samples, [], '超出总字数预算 → 不再取样本');

console.log('\n== 对应关系解析 ==');
const KEYS = ['SPK1', 'SPK2', 'SPK3', 'SPK4'];
const NAMES = ['Wifies', 'Parrot', 'Wato'];
r = cast.parseMapReply('{"mapping":{"SPK1":"Wifies","SPK2":"Parrot","SPK3":"Wato","SPK4":null}}', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies', SPK2: 'Parrot', SPK3: 'Wato' }, '标准 mapping');
eq(r.extra, ['SPK4'], '没映射上的进 extra');
r = cast.parseMapReply('{"SPK1":"Wifies"}', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies' }, '顶层直接 {SPK1:名}');
eq(r.extra, ['SPK2', 'SPK3', 'SPK4'], '其余都算 extra');
r = cast.parseMapReply('[["SPK1","Wifies"],["SPK2","Parrot"]]', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies', SPK2: 'Parrot' }, '数组对写法');
r = cast.parseMapReply('{"assignments":[{"speaker":"SPK1","character":"Wifies"}]}', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies' }, 'assignments 写法');
r = cast.parseMapReply('{"1":"Wifies","2":"Parrot"}', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies', SPK2: 'Parrot' }, '数字键 → SPKn');
r = cast.parseMapReply('{"mapping":{"SPK9":"谁","Wifies":"Wifies"}}', KEYS, NAMES);
eq(r.map, {}, '不认识的键丢掉');
r = cast.parseMapReply('{"mapping":{"SPK1":"Wifies","SPK2":"Wifies"}}', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies', SPK2: 'Wifies' }, '一个角色被拆成两个 SPK → 都映射到该角色');
r = cast.parseMapReply('{"mapping":{"SPK1":"路人甲"}}', KEYS, NAMES);
eq(r.unlisted, ['SPK1→路人甲'], '不在候选里的名字记进 unlisted');
r = cast.parseMapReply('```json\n{"mapping":{"SPK1":"Wifies"}}\n```', KEYS, NAMES);
eq(r.map, { SPK1: 'Wifies' }, '```围栏');
r = cast.parseMapReply('算了，判断不出来', KEYS, NAMES);
ok(!!r.error && Object.keys(r.map).length === 0, '非 JSON → 有错误且不映射', r.error);
r = cast.parseMapReply('{"mapping":{"SPK1":"null","SPK2":"未知","SPK3":"Wato"}}', KEYS, NAMES);
eq(r.map, { SPK3: 'Wato' }, '字面 "null"/"未知" 不算映射');

console.log('\n== 显示名（核心规则: 多出来的保留编号） ==');
eq(cast.roleNameFor({ SPK1: 'Wifies' }, 1), 'Wifies', '有映射 → 用真名');
eq(cast.roleNameFor({ SPK1: 'Wifies' }, 4), 'SPK4', '没映射 → 保留 SPK4');
eq(cast.roleNameFor({ SPK2: '  ' }, 2), 'SPK2', '空白映射 → 保留 SPK2');
eq(cast.roleNameFor(null, 3), 'SPK3', '没有映射表 → 保留编号');

console.log('\n== 整流程（注入假 LLM） ==');
const CAST_REPLY = '{"characters":[{"name":"Wifies"},{"name":"Parrot"},{"name":"Wato"}]}';
const MAP_REPLY = '{"mapping":{"SPK1":"Wifies","SPK2":"Parrot","SPK3":"Wato"}}';
const fakeCall = (replies) => async (messages) => {
  const sys = messages[0].content;
  if (sys.includes('说话的角色')) return typeof replies.cast === 'function' ? replies.cast() : replies.cast;
  return typeof replies.map === 'function' ? replies.map() : replies.map;
};

let calls = 0;
let out = await cast.runCastFlow({
  source: SOURCE, segments: segs, userCount: 6,
  call: async (m) => { calls++; return fakeCall({ cast: CAST_REPLY, map: MAP_REPLY })(m); },
});
ok(calls === 2, '一次初稿 = 两次模型调用（阵容 + 对应）', calls);
ok(out.usedLlm === true && out.error === '', '整流程成功且无错误', out.error);
eq(out.cast.characters.map((c) => c.name), ['Wifies', 'Parrot', 'Wato'], '拿到阵容');
eq(out.speakerCount, 3, '**用推断出的人数作为说话人分离的 SPK 数**');
eq(out.map, { SPK1: 'Wifies', SPK2: 'Parrot', SPK3: 'Wato' }, '拿到对应关系');
eq(out.extra, [], '样本里只有 3 个 SPK → 没有多余的');
eq(cast.roleNameFor(out.map, 1), 'Wifies', 'SPK1 显示真名');
eq(cast.roleNameFor(out.map, 4), 'SPK4', 'SPK4 显示 SPK4');

const segs4 = segs.concat([{ start: 20, end: 22, speaker: 3, text: '（背景里有人在喊）' }]);
out = await cast.runCastFlow({ source: SOURCE, segments: segs4, userCount: 6, call: fakeCall({ cast: CAST_REPLY, map: MAP_REPLY }) });
eq(out.speakerCount, 3, '3 个人物 → SPK 数 3');
eq(out.extra, ['SPK4'], '实际识别出 4 个说话人时, 第 4 个保留 SPK4');
eq(cast.roleNameFor(out.map, 4), 'SPK4', '第 4 个显示为 SPK4（不是硬套角色）');

out = await cast.runCastFlow({ source: SOURCE, segments: segs, userCount: 5, call: fakeCall({ cast: CAST_REPLY, map: '我不知道' }) });
eq(out.speakerCount, 3, '对应失败不影响说话人数');
eq(out.map, {}, '对应失败 → 空映射');
ok(!!out.error, '对应失败 → 有错误说明', out.error);
eq(cast.roleNameFor(out.map, 2), 'SPK2', '对应失败 → 全部保留编号');

out = await cast.runCastFlow({ source: SOURCE, segments: segs, userCount: 7, call: async () => { throw new Error('网络炸了'); } });
eq(out.speakerCount, 7, '模型调用失败 → 保留用户填的人数');
eq(out.map, {}, '模型调用失败 → 不映射');
ok(out.error.includes('网络炸了'), '错误信息带上原因', out.error);

out = await cast.runCastFlow({ source: SOURCE, segments: segs, userCount: 7, call: fakeCall({ cast: '胡说八道', map: MAP_REPLY }) });
eq(out.speakerCount, 7, '阵容解析失败 → 保留用户填的人数');
eq(out.cast.characters, [], '阵容解析失败 → 空阵容');

out = await cast.runCastFlow({ source: {}, segments: segs, userCount: 4, call: fakeCall({ cast: CAST_REPLY, map: MAP_REPLY }) });
eq(out.usedLlm, false, '没有视频信息 → 根本不调模型');
eq(out.speakerCount, 4, '没有视频信息 → 用用户填的人数');

out = await cast.runCastFlow({ source: SOURCE, segments: [{ start: 0, end: 1, text: '没有说话人' }], userCount: 3, call: fakeCall({ cast: CAST_REPLY, map: MAP_REPLY }) });
ok(!!out.error && out.map && Object.keys(out.map).length === 0, '没有 SPK 样本 → 只推断阵容不映射', out.error);

out = await cast.runCastFlow({ source: SOURCE, segments: segs, userCount: 3, call: null });
eq(out.usedLlm, false, '没有模型调用能力 → 直接降级');
eq(out.speakerCount, 3, '降级时保留用户人数');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
