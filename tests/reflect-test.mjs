/**
 * 长稿反思纠错 —— 纯逻辑部分
 *
 * 三条用户要求对应三组断言：
 *   1. 结合全片反思   → 分批带重叠、行号用全片编号、跨批结论要合并
 *   2. 预览优先       → 只产出 findings，不碰字幕（本模块无副作用）
 *   3. 同稿只重识别一遍 → planRegions 必须**求并**，重叠区间不能重复出现
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const R = await import(pathToFileURL(path.join(REPO, 'editor', 'reflect.js')).href);

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

/** 造 n 行，每行 2 秒 */
const mkRows = (n, sec = 2) => Array.from({ length: n }, (_, i) => ({
  start: i * sec, end: (i + 1) * sec, text: 'line ' + (i + 1),
}));

console.log('== 1. 分批：全片编号 + 相邻批重叠（跨批衔接才看得到）==');
{
  let b = R.planBatches(mkRows(10));
  ok(b.length === 1, '10 行只切 1 批', b);
  ok(b[0][1] === 1 && b[0][2] === 10, '区间是 1~10', b[0]);

  b = R.planBatches(mkRows(100), 60, 4);
  ok(b.length === 2, '100 行切 2 批', b.length);
  ok(b[0][2] === 60, '第一批到 60', b[0]);
  ok(b[1][1] === 57, '第二批从 57 开始（与第一批重叠 4 行）', b[1]);
  ok(b[1][2] === 100, '第二批到 100', b[1]);
  // 覆盖完整：所有行都至少出现在一批里
  const seen = new Set();
  for (const [, lo, hi] of b) for (let i = lo; i <= hi; i++) seen.add(i);
  ok(seen.size === 100, '每一行都至少进过一批', seen.size);

  ok(R.planBatches([]).length === 0, '空行表 → 0 批');
  b = R.planBatches(mkRows(60), 60, 4);
  ok(b.length === 1, '刚好一批的行数不重复切', b.length);
  b = R.planBatches(mkRows(61), 60, 4);
  ok(b.length === 2 && b[1][2] === 61, '多一行就切两批且末行不丢', b);
}

console.log('\n== 2. 批次提示词：给全片规模 + 全片行号（模型才好跨批判断）==');
{
  const rows = mkRows(100);
  const p = R.buildBatchPrompt(rows, 57, 100, 100, 1, 2);
  ok(/全片共 100 行/.test(p), '写明全片总行数');
  ok(/第 2\/2 批/.test(p), '写明批次位置');
  ok(/第 57~100 行/.test(p), '写明本批行范围');
  ok(/^57\t/m.test(p), '行号是全片编号（57 开头，不是 1 开头）');
  ok(p.includes('line 57') && p.includes('line 100'), '内容对得上');
  // 每行带 [起-止 时长]，模型据此判断"短时间内塞了很多词"。
  // 行尾可能是 \r\n，所以 ^ 后面要允许 \r（实测踩过：不带 \r? 时匹配为 null）。
  const m = /^57\t\[([\d.]+)-([\d.]+) ([\d.]+)s\]/m.exec(p);
  ok(m !== null, '行格式为「行号 [起-止 时长] 文本」', p.split('\n').find(l => l.startsWith('57')));
  if (m) {
    ok(Number(m[1]) === 112 && Number(m[2]) === 114, '行 57 的时间是 112~114（每行 2 秒）', m.slice(1, 3));
    ok(Number(m[3]) === 2, '时长 2.00s', m[3]);
  }
}

console.log('\n== 3. 解析：宽容包装、丢弃越界与低置信度 ==');
{
  let f = R.parseFindings('{"findings":[{"kind":"merge","from":3,"to":4,"reason":"接下一行","confidence":0.9}]}', 100)[0];
  ok(f.length === 1 && f[0].kind === 'merge' && f[0].from === 3, '标准输出', f);

  f = R.parseFindings('```json\n{"findings":[{"kind":"reidentify","from":5,"to":5,"reason":"拼接","confidence":0.8}]}\n```', 100)[0];
  ok(f.length === 1, '代码块围栏被剥掉', f);

  f = R.parseFindings('好的，结果如下：{"findings":[{"kind":"gap","from":10,"to":12,"reason":"疑似漏句","confidence":0.7}]} 以上。', 100)[0];
  ok(f.length === 1 && f[0].kind === 'gap', '前后废话被容忍', f);

  f = R.parseFindings('{"findings":[{"kind":"merge","from":50,"to":200,"reason":"越界","confidence":0.9}]}', 100)[0];
  ok(f.length === 0, '行号越界被丢弃', f);

  f = R.parseFindings('{"findings":[{"kind":"merge","from":3,"to":4,"reason":"低置信","confidence":0.3}]}', 100)[0];
  ok(f.length === 0, '置信度 < 0.5 被丢弃', f);

  f = R.parseFindings('{"findings":[{"kind":"乱写","from":3,"to":4,"reason":"x","confidence":0.9}]}', 100)[0];
  ok(f.length === 0, '未知 kind 被丢弃', f);

  f = R.parseFindings('{"findings":[{"kind":"merge","from":9,"to":4,"reason":"反了","confidence":0.9}]}', 100)[0];
  ok(f.length === 1 && f[0].from === 4 && f[0].to === 9, 'from>to 自动交换', f);

  f = R.parseFindings('{"findings":[]}', 100)[0];
  ok(f.length === 0, '空 findings 正常');
  f = R.parseFindings('完全不是 JSON', 100)[0];
  ok(f.length === 0, '非 JSON 不炸');
  f = R.parseFindings('', 100)[0];
  ok(f.length === 0, '空串不炸');
  const note = R.parseFindings('{"findings":[{"kind":"merge","from":500,"to":501,"reason":"x","confidence":0.9}]}', 100)[1];
  ok(/越界/.test(note), '丢弃原因写进 note（便于排查）', note);
}

console.log('\n== 4. 跨批合并：重叠区重复上报只留一条 ==');
{
  // 两批都看到"第 60 行接第 61 行"
  const raw = [
    { kind: 'merge', from: 60, to: 61, reason: 'A批：60 以 that 结尾', confidence: 0.85 },
    { kind: 'merge', from: 60, to: 61, reason: 'B批：同样问题', confidence: 0.9 },
  ];
  let f = R.mergeFindings(raw, 100)[0];
  ok(f.length === 1, '完全相同的区间只留一条', f.length);
  ok(f[0].confidence === 0.9, '留置信度高的那条', f[0].confidence);
  ok(/A批/.test(f[0].reason) && /B批/.test(f[0].reason), '两批的原因都保留（信息不丢）', f[0].reason);

  // 相邻的 merge 区间要并起来（同稿只跑一次）
  f = R.mergeFindings([
    { kind: 'merge', from: 10, to: 11, reason: 'x', confidence: 0.9 },
    { kind: 'merge', from: 12, to: 13, reason: 'y', confidence: 0.9 },
  ], 100)[0];
  ok(f.length === 1 && f[0].from === 10 && f[0].to === 13, '相邻区间合并成一段', f);

  // 不相邻的不并
  f = R.mergeFindings([
    { kind: 'merge', from: 10, to: 11, reason: 'x', confidence: 0.9 },
    { kind: 'merge', from: 40, to: 41, reason: 'y', confidence: 0.9 },
  ], 100)[0];
  ok(f.length === 2, '不相邻的保持两条', f.length);

  // 同一区间同时被 merge 与 reidentify 判到 → 只留 merge
  f = R.mergeFindings([
    { kind: 'merge', from: 10, to: 12, reason: '没说完', confidence: 0.9 },
    { kind: 'reidentify', from: 11, to: 11, reason: '拼接', confidence: 0.9 },
  ], 100)[0];
  ok(f.length === 1 && f[0].kind === 'merge', 'merge 覆盖范围内不再重复报 reidentify', f);

  // gap 只提示，不参与区间合并
  f = R.mergeFindings([
    { kind: 'gap', from: 10, to: 10, reason: '疑似漏句', confidence: 0.8 },
    { kind: 'gap', from: 11, to: 11, reason: '疑似漏句2', confidence: 0.8 },
  ], 100)[0];
  ok(f.length === 2, 'gap 不合并（避免夸大）', f.length);

  // 空输入
  ok(R.mergeFindings([], 100)[0].length === 0, '空输入不炸');
}

console.log('\n== 5. 区间求并：同稿每段只重识别一遍（用户明确要求）==');
{
  const rows = mkRows(100);   // 每行 2 秒：行 i → [2(i-1), 2i]
  // 上下文按**秒**取（默认前后各 2 秒）。相邻建议时间上真的挨着 → 必须并成一段
  let reg = R.planRegions(rows, [
    { kind: 'merge', from: 20, to: 21, reason: 'a', confidence: 0.9 },   // 38~42
    { kind: 'reidentify', from: 22, to: 22, reason: 'b', confidence: 0.9 }, // 42~46
  ]);
  ok(reg.length === 1, '时间上相接的两条并成 1 段（不重复识别）', reg.length);
  // 行 20~21 是 38~42s，行 22 是 42~44s
  // → 起点是第一条建议的前 pad（38-2=36），终点是最后一条建议的后 pad（44+2=46）
  ok(reg[0].start === 36 && reg[0].end === 46, '区间 = 两端各 pad 2 秒的并集', [reg[0].start, reg[0].end]);
  ok(reg[0].kinds.length === 2, '两个来源 kind 都记下', reg[0].kinds);

  // 分开的建议 → 两段，互不重叠（这是"只跑一遍"的关键）
  reg = R.planRegions(rows, [
    { kind: 'merge', from: 20, to: 21, reason: 'a', confidence: 0.9 },
    { kind: 'merge', from: 80, to: 81, reason: 'b', confidence: 0.9 },
  ]);
  ok(reg.length === 2, '相距很远的两条 → 两段', reg.length);
  ok(reg[0].end < reg[1].start, '两段时间区间不重叠', [reg[0].end, reg[1].start]);

  // 关键回归：密集稿子上**不能**把全片并成一段（早期按行取上下文就是这样退化的）
  const dense = mkRows(45, 5.24);   // 45 行 / 236 秒，接近实测那份稿子
  const many = [];
  for (let i = 1; i <= 45; i += 3) many.push({ kind: 'merge', from: i, to: i, reason: 'r', confidence: 0.9 });
  reg = R.planRegions(dense, many);
  ok(reg.length >= 8, `密集稿子上 15 条建议至少分成 8 段（不能并成一片），实得 ${reg.length}`, reg.length);
  ok(reg.every(r => r.dur <= 30 + 0.01), '每段不超过 30 秒上限', reg.map(r => r.dur));

  // 边界：建议就在开头/结尾
  reg = R.planRegions(rows, [{ kind: 'merge', from: 1, to: 1, reason: 'x', confidence: 0.9 }]);
  ok(reg[0].start >= 0, '开头不会算出负时间', reg[0].start);
  ok(reg[0].lo === 1, '行范围含第 1 行', reg[0].lo);
  reg = R.planRegions(rows, [{ kind: 'merge', from: 100, to: 100, reason: 'x', confidence: 0.9 }]);
  ok(reg[0].hi === 100, '结尾行不会越界', reg[0].hi);

  // 超长建议要被截到上限（否则一段吞掉全片）
  const long = mkRows(50, 60);   // 每行 60 秒
  reg = R.planRegions(long, [{ kind: 'merge', from: 1, to: 50, reason: 'x', confidence: 0.9 }]);
  ok(reg.length === 1 && reg[0].dur <= 30 + 0.01, '超长建议被截到 30 秒上限', reg[0].dur);

  /* gap 现在**可执行**：区间就是那段空档本身（用 findTimeGaps 给的精确时间），
   * 不额外扩上下文 —— 空档两边是已经识别好的行，扩进去只会白白重识别并替换掉正确的行。
   * （早期 gap 只是提示、不产生区间，导致漏掉的内容永远补不回来。） */
  reg = R.planRegions(rows, [{ kind: 'gap', from: 50, to: 51, start: 100, end: 104.5, dur: 4.5,
                               reason: '空了 4.5 秒', confidence: 0.9 }]);
  ok(reg.length === 1, 'gap 产生一段区间（可执行了）', reg.length);
  ok(reg[0].start === 100 && reg[0].end === 104.5, 'gap 区间 = 空档本身，不扩上下文', [reg[0].start, reg[0].end]);
  ok(reg[0].kinds[0] === 'gap', 'kinds 标成 gap', reg[0].kinds);
  // gap 没有精确时间（模型报的、且 parseFindings 补不上）→ 不该瞎猜，直接跳过
  reg = R.planRegions(rows, [{ kind: 'gap', from: 50, to: 51, reason: 'x', confidence: 0.9 }]);
  ok(reg.length === 0, 'gap 缺精确时间时不产生区间（不瞎猜范围）', reg.length);
  ok(R.planRegions(rows, []).length === 0, '没有建议 → 没有区间');
  ok(R.planRegions([], [{ kind: 'merge', from: 1, to: 1, reason: 'x', confidence: 0.9 }]).length === 0,
    '没有行 → 没有区间');
  // 可调参数：padSec 是**前后各**留多少秒
  // 行 20 是 38~40s，padSec=10 → 28~50 = 22 秒
  reg = R.planRegions(rows, [{ kind: 'merge', from: 20, to: 20, reason: 'x', confidence: 0.9 }], { padSec: 10 });
  ok(reg[0].start === 28 && reg[0].end === 50, 'padSec 可调（前后各 10 秒 → 28~50）', [reg[0].start, reg[0].end]);
  ok(reg[0].dur === 22, '区间时长 = 行时长 2s + 2×padSec 10s', reg[0].dur);
  // maxSec 可调：把上限压到 10 秒，上面那条会被截短
  reg = R.planRegions(rows, [{ kind: 'merge', from: 20, to: 20, reason: 'x', confidence: 0.9 }],
                      { padSec: 10, maxSec: 10 });
  ok(reg[0].dur <= 10 + 0.01, 'maxSec 可调（压到 10 秒）', reg[0].dur);
}

console.log('\n== 6. 区间求并的"只跑一遍"性质（随机压力测试）==');
{
  const rows = mkRows(200, 3);
  let bad = 0, worst = 0, maxDur = 0;
  for (let t = 0; t < 200; t++) {
    const k = 1 + Math.floor(Math.random() * 12);
    const f = [];
    for (let i = 0; i < k; i++) {
      const a = 1 + Math.floor(Math.random() * 200);
      f.push({ kind: Math.random() < 0.5 ? 'merge' : 'reidentify', from: a, to: a,
               reason: 'r', confidence: 0.9 });
    }
    const reg = R.planRegions(rows, f);
    // 性质 1：输出区间两两不重叠（= 每段只跑一次）
    for (let i = 1; i < reg.length; i++) {
      if (!(reg[i - 1].end < reg[i].start)) bad++;
    }
    // 性质 2：每个建议的目标行都落在某段区间内（不能漏掉要改的地方）
    for (const it of f) {
      const t0 = rows[it.from - 1].start, t1 = rows[it.to - 1].end;
      const hit = reg.some(r => r.start <= t0 + 1e-6 && r.end >= t1 - 1e-6);
      if (!hit) bad++;
    }
    // 性质 3：每段不超上限
    for (const r of reg) { maxDur = Math.max(maxDur, r.dur); if (r.dur > 30 + 0.01) bad++; }
    worst = Math.max(worst, reg.length);
  }
  ok(bad === 0, '200 轮随机：区间互不重叠 & 每条建议都被覆盖 & 不超上限', bad);
  console.log('      （最多并出 ' + worst + ' 段，单段最长 ' + maxDur.toFixed(1) + 's）');
}

console.log('\n== 7. 概览 ==');
{
  const rows = mkRows(100);
  const f = R.mergeFindings([
    { kind: 'merge', from: 10, to: 11, reason: 'a', confidence: 0.9 },
    { kind: 'gap', from: 50, to: 50, reason: 'b', confidence: 0.8 },
  ], 100)[0];
  const reg = R.planRegions(rows, f, { padSec: 2, maxSec: 30 });
  const s = R.summarize(rows, f, reg);
  ok(s.rows === 100, '行数', s.rows);
  ok(s.findings === 2, '建议数', s.findings);
  ok(s.byKind.merge === 1 && s.byKind.gap === 1, '按类别统计', s.byKind);
  ok(s.regions === 1, '区间数', s.regions);
  ok(s.audioSec > 0, '待重识别音频时长（用于给用户报成本）', s.audioSec);
}

console.log('\n== 8. findTimeGaps：确定性检出"没识别出内容的空档" ==');
{
  /* 为什么必须确定性检出：模型的输入是**文本**，看不到静音，只能靠语义感觉。
   * 实测（41 行 / 235.6 秒）：全片唯一一处 ≥3 秒空档是 78.23~82.98（4.75 秒），
   * 模型没报成 gap 而是报成 merge —— 那段漏掉的内容就永远补不回来了。 */

  // 行 start/end 严丝合缝（reseg 的 groupsToSegments 会规整掉重叠），
  // 只有**逐词**时间保留真实间隔 —— 所以必须按词判定
  const tight = [
    { start: 0, end: 8, text: 'a', words: [{ start: 0, end: 4 }, { start: 4, end: 8 }] },
    { start: 8, end: 16, text: 'b', words: [{ start: 12.5, end: 16 }] },   // 词起点 12.5 → 空档 4.5s
  ];
  ok(tight[0].end === tight[1].start, '前提：行时间严丝合缝（空档按行看是 0）');
  let g = R.findTimeGaps(tight, {});
  ok(g.length === 1, '仍然检出了空档（靠逐词时间，不是行时间）', g);
  ok(Math.abs(g[0].start - 8) < 1e-6 && Math.abs(g[0].end - 12.5) < 1e-6,
    '空档起止 = 前一行末词 end ~ 后一行首词 start', [g[0].start, g[0].end]);
  ok(Math.abs(g[0].dur - 4.5) < 1e-6, '时长正确', g[0].dur);
  ok(g[0].from === 1 && g[0].to === 2, '记录夹着空档的两行行号', [g[0].from, g[0].to]);
  ok(/4\.5 秒/.test(g[0].reason), '说明里带明确秒数（用户好判断值不值得补）', g[0].reason);

  // 没有逐词数据 → 退回行时间
  const noWords = [
    { start: 0, end: 10, text: 'a' },
    { start: 15, end: 20, text: 'b' },
  ];
  g = R.findTimeGaps(noWords, {});
  ok(g.length === 1 && Math.abs(g[0].dur - 5) < 1e-6, '缺逐词数据时退回行时间', g);

  // 阈值：默认 3 秒，2.9 秒不算
  const small = [
    { start: 0, end: 10, text: 'a' },
    { start: 12.9, end: 20, text: 'b' },
  ];
  ok(R.findTimeGaps(small, {}).length === 0, '默认阈值 3 秒：2.9 秒不算', R.GAP_MIN_SEC);
  ok(R.findTimeGaps(small, { minSec: 2 }).length === 1, '阈值可调（minSec=2 就算）');

  // 上限：过长的多半是音乐/停播，不是漏词
  const huge = [
    { start: 0, end: 10, text: 'a' },
    { start: 100, end: 110, text: 'b' },
  ];
  ok(R.findTimeGaps(huge, {}).length === 0, '超过上限（30s）不当作漏词', R.GAP_MAX_SEC);
  ok(R.findTimeGaps(huge, { maxSec: 200 }).length === 1, '上限可调');

  // 边界
  ok(R.findTimeGaps([], {}).length === 0, '空数组 → 无空档');
  ok(R.findTimeGaps([{ start: 0, end: 1, text: 'a' }], {}).length === 0, '只有一行 → 无空档');
  const overlap = [
    { start: 0, end: 10, text: 'a', words: [{ start: 0, end: 10 }] },
    { start: 10, end: 20, text: 'b', words: [{ start: 9, end: 20 }] },   // 词时间重叠
  ];
  ok(R.findTimeGaps(overlap, {}).length === 0, '词时间重叠（负空档）不报', R.findTimeGaps(overlap, {}));

  // 与 planRegions 串起来：区间应恰好覆盖空档、不扩上下文
  const rows3 = [
    { start: 0, end: 10, text: 'a' }, { start: 10, end: 20, text: 'b' },
    { start: 20, end: 34, text: 'c' }, { start: 34, end: 40, text: 'd' },
  ];
  const gaps3 = R.findTimeGaps(rows3, { minSec: 3, maxSec: 30 });
  const regs3 = R.planRegions(rows3, gaps3, { padSec: 2, maxSec: 30 });
  ok(regs3.length === gaps3.length, '每处空档 → 一段区间', [gaps3.length, regs3.length]);
  ok(regs3.every((r, i) => Math.abs(r.start - gaps3[i].start) < 1e-6
    && Math.abs(r.end - gaps3[i].end) < 1e-6),
    'gap 区间不被 padSec 撑大（两端是已识别好的行，扩进去只会白白替换）', regs3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
