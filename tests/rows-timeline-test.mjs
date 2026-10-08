/**
 * 从 ASS 走到「列表/时间轴实际用的行」，看时间有没有在中途被压扁。
 *
 * 已排除的层（都实测过，都正确）：
 *   asr.json 时间戳      → 跨度 3416s，2.94 词/秒
 *   subtitle.ass Dialogue → 10905 行，0~3415.6s，分布均匀
 *   analyzeKaraoke        → 1740 句，跨度 3416s，分布均匀
 * 剩下没验的是 **pairRows**（把中英配成"一行"）与 `rows` 的 start/end ——
 * 列表和时间轴用的正是 rows。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const JSMOD = path.join(HERE, 'jsmod');
// 素材：优先真实稿件，没有就用合成 ASS（见 tests/ass-fixture.mjs）
const { resolveAssFixture } = await import(pathToFileURL(path.join(HERE, 'ass-fixture.mjs')).href);
const __fx = resolveAssFixture();

const { AssDoc } = await import(pathToFileURL(path.join(JSMOD, 'ass.js')).href);
const { analyzeKaraoke } = await import(pathToFileURL(path.join(JSMOD, 'karaoke.js')).href);
const { pairRows } = await import(pathToFileURL(path.join(JSMOD, 'karaoke.js')).href);

console.log(`素材: ${__fx.name}（${__fx.real ? '真实稿件' : '合成'}）`);
const doc = new AssDoc(__fx.text);
const kar = analyzeKaraoke(doc);
console.log(`sentences=${kar.sentences.length}  wordStyle=${kar.wordStyle}`);

if (pairRows) {
  const rows = pairRows(kar.sentences, kar.wordStyle);
  console.log(`\npairRows → rows = ${rows.length}`);
  const s = rows.filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  const lo = Math.min(...s.map(r => r.start));
  const hi = Math.max(...s.map(r => r.end));
  console.log(`  有效行 ${s.length} 条，跨度 ${lo.toFixed(2)}s ~ ${hi.toFixed(2)}s（${(hi - lo).toFixed(1)}s）`);
  const buckets = new Map();
  for (const r of s) { const b = Math.floor(r.start / 600); buckets.set(b, (buckets.get(b) || 0) + 1); }
  console.log('  每 10 分钟分档: ' + [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([b, n]) => `${b * 10}-${b * 10 + 10}分:${n}`).join('  '));
  const bad = s.filter(r => !(r.end > r.start));
  console.log(`  start>=end 的坏行: ${bad.length}`);
  console.log(`\n结论：rows 跨度 ${(hi - lo).toFixed(1)}s → ` +
    ((hi - lo) < 60 ? '✗ 被压扁了，问题在 pairRows' : '✓ 正常'));
} else {
  console.log('\n退而求其次：检查 main.js 里 rows 是怎么来的');
  const k = mainSrc.indexOf('pairRows(');
  console.log(mainSrc.slice(Math.max(0, k - 400), k + 200));
}
