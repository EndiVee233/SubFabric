/* ass-group 单测: node tests/ass-group-test.mjs
 *
 * 钉住的约定：**逐词 ASS 里一句英文是"每词一条 Dialogue"，必须聚合成一句**。
 * 用户实测的 bug：226 句的稿件被读成「区间内 43 行」、中英配对错乱、逐词高亮全丢。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  /* 镜像同步: 只补齐/更新本族自己的文件, **绝不清空目录** —— jsmod 是两族共用镜像
   * (上游族源 editor/js, fork 族源 editor/), 旧实现 rmSync 清空会顺手删掉另一族的文件,
   * 于是"哪个测试先跑"决定别的测试能不能过(2026-10-10 修复)。内容比对保证镜像恒等于源。 */
  fs.mkdirSync(JSMOD, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(b, a);
  }
  fs.writeFileSync(marker, '{"type":"module"}\n');
}
ensureJsmod();
const { groupAssRows } = await import('./jsmod/ass-group.js');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};
const eq = (g, w, n) => ok(JSON.stringify(g) === JSON.stringify(w), n, { got: g, want: w });

const ZH = '中文字幕', EN = 'Default';
const r = (s, e, style, text) => ({ start: s, end: e, style, text });

console.log('== ① 逐词 ASS：每词一条 Dialogue → 必须聚合成一句 ==');
{
  const SENT = 'The unstable SMP is in chaos.';
  // 真实形态：每条词行的文本都是**整句**，只把当前词包在高亮标签里
  const words = [
    [0, 0.19, 'The'], [0.19, 0.85, 'unstable'], [0.85, 1.52, 'SMP'],
    [1.52, 1.7, 'is'], [1.7, 1.89, 'in'], [1.89, 2.32, 'chaos.'],
  ];
  const kara = (w) => SENT.replace(w, `{\\c&H00FF00&}${w}{\\c}`);
  const rows = [r(0, 2.32, ZH, 'Unstable SMP陷入混乱')];
  for (const [s, e, w] of words) rows.push(r(s, e, EN, kara(w)));
  const g = groupAssRows(rows);
  ok(g.ok, '解析成功', g.error);
  eq(g.lines.length, 1, '★ 6 条词行 + 1 条整句 → **1 句**（而不是 6 行）', g.lines.length);
  eq(g.lines[0].lines, ['Unstable SMP陷入混乱', SENT], '主语言=中文整句，副语言=英文整句');
  eq([g.lines[0].start, g.lines[0].end], [0, 2.32], '跨度取整句');
  eq(g.stats.sentences, 1, '统计：1 句');
  eq(g.stats.wordRows, 6, '统计：6 条词行');
}

console.log('\n== ② 多句：不能跨句粘在一起 ==');
{
  const mk = (s0, e0, zh, sent, ws) => {
    const out = [r(s0, e0, ZH, zh)];
    const step = (e0 - s0) / ws.length;
    let cur = s0;
    for (const w of ws) {
      out.push(r(cur, cur + step, EN, sent.replace(w, `{\\c&H00FF00&}${w}{\\c}`)));
      cur += step;
    }
    return out;
  };
  const rows = [
    ...mk(0, 3, '第一句中文', 'First sentence here.', ['First', 'sentence', 'here.']),
    ...mk(4, 9, '第二句中文', 'Second sentence follows.', ['Second', 'sentence', 'follows.']),
  ];
  const g = groupAssRows(rows);
  eq(g.lines.length, 2, '★ 两句分开（时间不连续 + 文本不同 → 不粘）', g.lines.length);
  eq(g.lines[0].lines, ['第一句中文', 'First sentence here.'], '第一句配对正确');
  eq(g.lines[1].lines, ['第二句中文', 'Second sentence follows.'], '第二句配对正确');
}

console.log('\n== ③ 单语 ASS（没有逐词）：一条一条原样出来 ==');
{
  const rows = [
    r(0, 2, ZH, '中文一'), r(2, 4, ZH, '中文二'), r(4, 6, ZH, '中文三'),
  ];
  const g = groupAssRows(rows);
  eq(g.lines.length, 3, '3 条整句 → 3 句');
  eq(g.lines.map(x => x.lines[0]), ['中文一', '中文二', '中文三'], '内容原样');
  eq(g.stats.wordRows, 0, '没有逐词行');
}

console.log('\n== ④ 逐词样式名不含 "word" 也要认出来（用户的叫 Default）==');
{
  // 真实形态：每条词行的文本都是**同一个整句**，只把当前词包进高亮标签
  const SENT = 'hello brave new world';
  const rows = [
    r(0, 2, '中文字幕', '中文'),
    r(0, 1, 'Default', SENT.replace('brave', '{\\c&H00FF00&}brave{\\c}')),
    r(1, 2, 'Default', SENT.replace('world', '{\\c&H00FF00&}world{\\c}')),
  ];
  const g = groupAssRows(rows);
  eq(g.stats.wordStyles, ['Default'], '★ 靠"带高亮标签"认出 Default 是逐词样式（样式名不含 word）');
  eq(g.lines.length, 1, '聚合成 1 句', g.lines.length);
  eq(g.lines[0].lines, ['中文', SENT], '中文与英文整句都正确');
}

console.log('\n== ⑤ 同跨度多条 → 也能认出逐词样式 ==');
{
  // 一句英文被拆成两条 Dialogue，**起止时间相同**（换行/切片时会出现），且无高亮标签。
  // 这是"多行一屏"的形态：必须合并成一行，而不是当成两句。
  const rows = [
    r(0, 2, '中文字幕', '中文整句'),
    r(0, 2, 'Default', 'first half of the sentence'),
    r(0, 2, 'Default', 'second half of the sentence'),
  ];
  const g = groupAssRows(rows);
  console.log('    stats:', JSON.stringify(g.stats));
  ok(g.stats.wordStyles.includes('Default'), '★ 同跨度多条 → 认出 Default 是逐词/多行样式', g.stats.wordStyles);
  eq(g.lines.length, 1, '合并成 1 句（不是 2 句）', g.lines.length);
  eq(g.lines[0].lines[0], '中文整句', '中文保留');
  ok(/first half/.test(g.lines[0].lines[1] || ''), '英文里含第一段', g.lines[0].lines[1]);
}

console.log('\n== ⑥ 词间空档行（无标签整句）不能把一句切碎 ==');
{
  /* 真实导出的逐词 ASS 会在词与词之间补一条**无高亮标签的整句行**（buildWordSpecsColor
   * 的 head/gap/tail 填充）。旧实现只把"带标签且紧接"的词行算同一句，空档行会把一句切成
   * 十几段；分段导入后每段单独成行 → 中文行与英文词行配不上，时间轴显示成上下两半 + 整排 ⚠
   * （用户实测：02:34~02:53 进了 3848 行）。 */
  const SENT = 'Hold down the wall!';
  const kara = (w) => SENT.replace(w, `{\\c&H00FF00&}${w}{\\c}`);
  const rows = [
    r(0, 1.2, ZH, '守住墙！'),
    r(0, 0.2, EN, kara('Hold')),
    r(0.2, 0.26, EN, SENT),          // 词间空档：无标签
    r(0.26, 0.5, EN, kara('down')),
    r(0.5, 0.52, EN, SENT),
    r(0.52, 0.9, EN, kara('the')),
    r(0.9, 0.92, EN, SENT),
    r(0.92, 1.2, EN, kara('wall!')),
  ];
  const g = groupAssRows(rows);
  eq(g.lines.length, 1, '★ 词行 + 空档行 → 1 句（旧实现会被切成 7 段）', g.lines.length);
  eq(g.lines[0].lines, ['守住墙！', SENT], '中英仍然配对');
  eq([g.lines[0].start, g.lines[0].end], [0, 1.2], '跨度覆盖首词到末词');
  eq((g.lines[0].words || []).length, 4, '只把带高亮标签的 4 个词当词，空档行不算词');
  eq(g.lines[0].words.map(w => w.word), ['Hold', 'down', 'the', 'wall!'], '词序正确');
}

console.log('\n== ⑦ 英文词行带中文角色名时，逐词样式仍然要认出来 ==');
{
  /* 用户真实文件里的两条英文行是「整行角色色」：`{\c&H00FFFF&}[路人] They're immortal!`。
   * 旧实现拿整段明文跑 CJK 判断「该样式也承载整句」，两条就把 Default 踢出逐词样式，
   * 整份文件退化成"一条 Dialogue 一行"。角色标记 `[..]` 必须先剥掉再判语言。 */
  const SENT = 'They are immortal!';
  const kara = (w) => SENT.replace(w, `{\\c&H00FF00&}${w}{\\c}`);
  const rows = [
    r(0, 2, ZH, '他们是不死之身！'),
    r(0, 1, EN, '{\\c&H00FFFF&}[路人] They are immortal!'),   // 整行角色色（无复位），普通整句行
    r(0, 0.5, EN, kara('They')),
    r(0.5, 1, EN, kara('are')),
    r(1, 2, EN, kara('immortal!')),
  ];
  const g = groupAssRows(rows);
  ok(g.stats.wordStyles.includes('Default'), '★ 带中文角色名的英文行不会把 Default 踢出逐词样式', g.stats.wordStyles);
  ok(g.stats.wordRows >= 3, '词行仍被识别', g.stats.wordRows);
  ok(g.lines.length >= 2 && g.lines.length <= 3, '不会退化成"每个词一行"（旧实现是 5 行）', g.lines.length);
  const pair = g.lines.find(x => x.lines.length === 2);
  ok(pair && pair.lines[0] === '他们是不死之身！', '★ 中文行配给逐词句，不被整行角色色副本抢走', pair && pair.lines);
}

console.log('\n== ⑧ 10ms 词间空档不能拆成「中文+首词」和「其余英文」两行 ==');
{
  /* 用户实测 3:26:26.43~3:26:28.75：中文「放箭放箭」配第一行英文（0.05s），
   * 余下 2.26s 只有英文。原因是首词结束 26.48、第二词开始 26.49（10ms 空档），
   * 导出文件没补空档整句行，旧逻辑按 1ms 容差断句。
   * 期望：合并成一行，中文行结尾延长到英文原本的结尾。 */
  const SENT = 'Bow, bow, bow, bow, bow, bow.';
  const tokens = SENT.split(' ');
  const kara = (k) => tokens.map((t, i) => i === k ? `{\\c&H00FF00&}${t}{\\c}` : t).join(' ');
  const words = [[0, 0.05], [0.06, 0.1], [0.1, 0.14], [0.14, 0.15], [0.15, 2.31], [2.31, 2.32]];
  const rows = [r(0, 2.32, ZH, '放箭放箭')];
  words.forEach(([s, e], k) => rows.push(r(s, e, EN, kara(k))));
  const g = groupAssRows(rows);
  eq(g.lines.length, 1, '★ 合并成 1 句（旧实现拆成 0.05s 中英 + 2.26s 英文两行）', g.lines.length);
  eq(g.lines[0].lines, ['放箭放箭', SENT], '中文与完整英文在同一行');
  eq([g.lines[0].start, g.lines[0].end], [0, 2.32], '中文行结尾延长到英文原本的结尾');
  eq((g.lines[0].words || []).length, 6, '6 个词级时间全部保留');
}

console.log('\n== ⑨ 空行 / 空输入 ==');
{
  eq(groupAssRows([]).ok, false, '空数组 → 不 ok');
  eq(groupAssRows(null).lines.length, 0, 'null 不炸');
  const g = groupAssRows([r(0, 1, ZH, '   '), r(1, 2, ZH, '有内容')]);
  eq(g.lines.length, 1, '空白行被丢掉');
  eq(g.lines[0].lines[0], '有内容', '留下的是有内容的');
}

console.log('\n== ⑦ 用真实的 (5) 文件验证规模 ==');
{
  const P = 'C:/Users/Terry/Downloads/subtitle_edited (5).ass';
  if (process.env.SUBFABRIC_TEST_ISOLATED !== '1' && fs.existsSync(P)) {
    const t = (x) => { const m = /(\d+):(\d+):(\d+)\.(\d+)/.exec(x); return m ? (+m[1])*3600+(+m[2])*60+(+m[3])+(+m[4])/100 : 0; };
    const rows = [];
    for (const l of fs.readFileSync(P, 'utf8').split(/\r?\n/)) {
      if (!l.startsWith('Dialogue:')) continue;
      const b = l.slice(l.indexOf(':') + 1).split(',');
      if (b.length < 10) continue;
      rows.push({ start: t(b[1]), end: t(b[2]), style: b[3].trim(), text: b.slice(9).join(',') });
    }
    const g = groupAssRows(rows);
    console.log('    %d 条 Dialogue → %d 句', rows.length, g.lines.length);
    ok(g.lines.length > 200 && g.lines.length < 260, '★ 3676 行聚合成 ~226 句（不是 3676 行）', g.lines.length);
    ok(g.lines.every(x => x.lines.length >= 1), '每句都有内容');
    const both = g.lines.filter(x => x.lines.length === 2).length;
    ok(both > 200, `★ ${both} 句是中英成对的`, both);
  } else {
    console.log('    （跳过：找不到 (5)）');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
