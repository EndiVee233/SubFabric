/**
 * overlay.js 活动 cue 检索回归测试。
 *
 * 背景（2026-10-10 修复）：update() 的回扫原来用 cues[k].end > t 作终止条件 ——
 * cues 只按 start 排序，重叠/嵌套时一个早已结束的短块会挡住对更早开始的长块的
 * 回扫（反例 A=[0,100], B=[1,2], t=50：bisect 命中 B 后立即退出，A 整条漏显示）。
 * 修复后 setCues 预计算前缀最大 end（_maxEnd），回扫用 _maxEnd > t 判断能否提前终止。
 * 与 timeline.js 的 _maxEnd（同文件 296/926 行）是同一套防御 —— 那边先防住了，这边漏了。
 */
import { SrtOverlay } from './jsmod/overlay.js';

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' —— ' + detail : ''}`); }
}

function mkOverlay(cues) {
  const el = { style: {}, innerHTML: '' };
  const video = {};
  const ov = new SrtOverlay(el, video);
  ov.setCues(cues);
  ov.visible = true;
  return ov;
}

/** 跑 update() 并返回当前渲染的 cue 文本集合（cue.lines join） */
function textsAt(ov, t) {
  ov.update(t);
  const out = [];
  const re = /<div class="ov-cue">([\s\S]*?)<\/div>\s*(?=<div class="ov-cue">|$)/g;
  let m;
  while ((m = re.exec(ov.el.innerHTML)) !== null) {
    out.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  return out.sort();
}

const C = (id, start, end, lines) => ({ id, start, end, lines });

// ── 1) 核心回归: 长块被短块"遮住"的场景（旧实现整条漏显示）──
{
  const ov = mkOverlay([C('a', 0, 100, ['Long cue']), C('b', 1, 2, ['Short cue'])]);
  const got = textsAt(ov, 50);
  ok(got.length === 1 && got[0] === 'Long cue', 'O1 重叠: t=50 只显示长块 A（旧实现漏显示）', JSON.stringify(got));
}
{
  const ov = mkOverlay([C('a', 0, 100, ['Long cue']), C('b', 1, 2, ['Short cue'])]);
  const got = textsAt(ov, 1.5);
  ok(got.length === 2, 'O2 重叠: t=1.5 两块同显', JSON.stringify(got));
  ok(got.includes('Long cue') && got.includes('Short cue'), 'O2 重叠: 两块文本都对');
}

// ── 2) 链中短块已结束、后面还有长块（回扫必须继续而不是停）──
{
  const ov = mkOverlay([
    C('a', 0, 2, ['early short']),
    C('b', 1, 10, ['long span']),
  ]);
  const got = textsAt(ov, 5);
  ok(got.length === 1 && got[0] === 'long span', 'O3 回扫跳过已结束短块', JSON.stringify(got));
}

// ── 3) 非重叠常规场景不回归 ──
{
  const ov = mkOverlay([C('x', 0, 5, ['first']), C('y', 6, 10, ['second'])]);
  ok(textsAt(ov, 2).join() === 'first', 'O4 常规: t=2 显示第一块');
  ok(textsAt(ov, 7).join() === 'second', 'O5 常规: t=7 显示第二块');
  ok(textsAt(ov, 5.5).length === 0, 'O6 常规: 间隙不显示任何块');
  ok(textsAt(ov, 11).length === 0, 'O7 常规: 全部结束后不显示');
}

// ── 4) 三层嵌套: 短→中→长, 中段时刻全部同显 ──
{
  const ov = mkOverlay([
    C('a', 0, 50, ['outer']),
    C('b', 5, 20, ['middle']),
    C('c', 10, 15, ['inner']),
  ]);
  const got = textsAt(ov, 12);
  ok(got.length === 3, 'O8 嵌套: t=12 三块同显', JSON.stringify(got));
  const got2 = textsAt(ov, 30);
  ok(got2.length === 1 && got2[0] === 'outer', 'O9 嵌套: t=30 只剩最外层（inner/middle 已结束）', JSON.stringify(got2));
}

// ── 5) 乱序输入（未按 start 排序）也不崩、结果一致 ──
{
  const ov = mkOverlay([C('b', 1, 2, ['Short cue']), C('a', 0, 100, ['Long cue'])]);
  const got = textsAt(ov, 50);
  ok(got.length === 1 && got[0] === 'Long cue', 'O10 乱序输入: t=50 仍显示长块', JSON.stringify(got));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
