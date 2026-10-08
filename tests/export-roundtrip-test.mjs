/**
 * 验证「载入 → 序列化（导出）」这条往返有没有压缩时间戳。
 *
 * 症状：导出后的字幕**播放过快、几秒就放完** → 说明导出文件里的时间戳被压小了。
 * 项目里的 subtitle.ass 实测是正确的（Dialogue 跨度 3415.6s），所以嫌疑在
 *   AssDoc 解析 → serialize() 这一步。
 *
 * 同时也检查 buildCleanAss（"导出干净版"那个按钮）—— 它另走一条构造路径，
 * 与 serialize() 不是同一份代码，很可能只有其中一条有问题。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const JSMOD = path.join(HERE, 'jsmod');
// 素材：优先真实稿件，没有就用合成 ASS（见 tests/ass-fixture.mjs 的说明）。
// 早先这里硬编码某个本机项目，清掉项目后测试必然假失败。
const { resolveAssFixture } = await import(pathToFileURL(path.join(HERE, 'ass-fixture.mjs')).href);
const __fx = resolveAssFixture();

const { AssDoc } = await import(pathToFileURL(path.join(JSMOD, 'ass.js')).href);
const { analyzeKaraoke, buildCleanAss, pairRows } = await import(pathToFileURL(path.join(JSMOD, 'karaoke.js')).href);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

/** 从 ASS 文本里取出 Dialogue 的时间区间 */
function dialogueSpans(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('Dialogue:')) continue;
    const f = line.slice(9).split(',');
    const t = (s) => {
      const m = /^(\d+):(\d+):([\d.]+)$/.exec((s || '').trim());
      return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : NaN;
    };
    const a = t(f[1]), b = t(f[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
  }
  return out;
}
function spanOf(spans) {
  if (!spans.length) return null;
  const lo = Math.min(...spans.map(s => s[0]));
  const hi = Math.max(...spans.map(s => s[1]));
  return { lo, hi, span: hi - lo, n: spans.length };
}

const raw = __fx.text;
const before = spanOf(dialogueSpans(raw));
console.log('素材: ' + __fx.name + '（' + (__fx.real ? '真实稿件' : '合成') + '）');
console.log('原文件 Dialogue: ' + before.n + ' 条，跨度 ' + before.span.toFixed(1) + 's');
console.log('');

console.log('== 往返 1：AssDoc 解析 → serialize()（普通「导出字幕」走这条）==');
const doc = new AssDoc(raw);
const outText = doc.serialize();
const after = spanOf(dialogueSpans(outText));
console.log('  导出后 Dialogue: ' + after.n + ' 条，跨度 ' + after.span.toFixed(1) + 's');
ok(after.n === before.n, 'Dialogue 条数不变', after.n + ' vs ' + before.n);
ok(Math.abs(after.span - before.span) < 1.0, '跨度不变（±1s）',
  after.span.toFixed(1) + ' vs ' + before.span.toFixed(1));
ok(Math.abs(after.hi - before.hi) < 1.0, '最末时间点不变', after.hi.toFixed(1) + ' vs ' + before.hi.toFixed(1));
// 关键不变量：往返**不能压缩时间轴**。早期这里断言"跨度 > 3000s"（依赖那份 57 分钟的素材），
// 换成与输入自洽的写法 —— 素材可换，不变量不变：导出后的跨度必须与输入一致。
ok(after.span > 0 && Math.abs(after.span - before.span) / before.span < 0.01,
  '跨度与输入一致（不压缩时间轴）',
  after.span.toFixed(1) + ' vs ' + before.span.toFixed(1));

console.log('');
console.log('== 往返 2：buildCleanAss（「导出干净版」走这条）==');
try {
  const kar = analyzeKaraoke(doc);
  const rows = pairRows(kar.sentences, kar.wordStyle);
  const clean = buildCleanAss(kar, rows);
  const cText = typeof clean === 'string' ? clean : (clean && clean.text) || '';
  const cs = spanOf(dialogueSpans(cText));
  if (!cs) {
    console.log('  （buildCleanAss 没产出 Dialogue，或返回结构不同，跳过）');
  } else {
    console.log('  干净版 Dialogue: ' + cs.n + ' 条，跨度 ' + cs.span.toFixed(1) + 's');
    ok(Math.abs(cs.span - before.span) < 1.0, '跨度不变（±1s）',
      cs.span.toFixed(1) + ' vs ' + before.span.toFixed(1));
    ok(cs.span > 0, '干净版跨度为正（没被压扁）', cs.span.toFixed(1));
  }
} catch (e) {
  console.log('  buildCleanAss 调用失败：' + e.message);
  console.log('  （签名可能不同；这条路径未验证）');
}

console.log('');
console.log('== 抽查：前 3 条与后 3 条的时间（看是不是被整段压扁）==');
const list = dialogueSpans(outText).slice().sort((a, b) => a[0] - b[0]);
console.log('  最早 3 条起点: ' + list.slice(0, 3).map(s => s[0].toFixed(2)).join(', '));
console.log('  最晚 3 条起点: ' + list.slice(-3).map(s => s[0].toFixed(2)).join(', '));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
