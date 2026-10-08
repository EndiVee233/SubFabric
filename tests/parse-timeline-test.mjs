/**
 * 用真实的 subtitle.ass 跑一遍编辑器的解析链，看时间轴有没有被压扁。
 *
 * 为什么怀疑这里：数据层（asr.json / ASS 的 Dialogue）实测都是正确的
 * （跨度 3415s、分布均匀），所以"字幕挤在前几秒"只可能出在**读入后的解析**：
 *   ass.js 的 AssDoc → karaoke.js 的 analyzeKaraoke → main.js 的 pairRows
 * 这条链任何一环丢了时间，列表/时间轴看到的就是挤成一团。
 *
 * 这比在浏览器里点点看快得多，而且能给出精确数字。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const JSMOD = path.join(HERE, 'jsmod');
const ASS = path.join(REPO, 'projects', 'p-muz7axuw-f0bdc', 'subtitle.ass');

const { AssDoc } = await import(pathToFileURL(path.join(JSMOD, 'ass.js')).href);
const { analyzeKaraoke } = await import(pathToFileURL(path.join(JSMOD, 'karaoke.js')).href);

const text = fs.readFileSync(ASS, 'utf8');
console.log(`ASS 文件: ${(text.length / 1024).toFixed(0)} KB`);

const doc = new AssDoc(text);
const kar = analyzeKaraoke(doc);
console.log(`\n解析结果：`);
console.log(`  sentences = ${kar.sentences.length}`);
console.log(`  wordStyle = ${JSON.stringify(kar.wordStyle)}`);

function span(list, name) {
  const s = list.filter(x => x && Number.isFinite(x.start) && Number.isFinite(x.end));
  if (!s.length) { console.log(`  ${name}: 空`); return; }
  const lo = Math.min(...s.map(x => x.start));
  const hi = Math.max(...s.map(x => x.end));
  console.log(`  ${name}: ${s.length} 条，跨度 ${lo.toFixed(2)}s ~ ${hi.toFixed(2)}s（${(hi - lo).toFixed(1)}s）`);
  // 前 5 条的起点，看是否都堆在开头
  const first = s.slice().sort((a, b) => a.start - b.start).slice(0, 5).map(x => x.start.toFixed(2));
  console.log(`     最早 5 条起点: ${first.join(', ')}`);
}

span(kar.sentences, 'sentences(全部)');
const zh = kar.sentences.filter(x => x.style !== kar.wordStyle);
const en = kar.sentences.filter(x => x.style === kar.wordStyle);
span(zh, '中文整句');
span(en, '英文逐词句');

// 逐词事件的时间是否也铺开
if (en.length) {
  const evs = en.flatMap(s => s.events || []);
  span(evs, '英文事件');
}

// 关键：按每 10 分钟分档，看句子的时间分布是否均匀
const buckets = new Map();
for (const s of kar.sentences) {
  const b = Math.floor(s.start / 600);
  buckets.set(b, (buckets.get(b) || 0) + 1);
}
const dist = [...buckets.entries()].sort((a, b) => a[0] - b[0])
  .map(([b, n]) => `${b * 10}-${b * 10 + 10}分:${n}`).join('  ');
console.log(`\n  每 10 分钟分档: ${dist}`);

// 结论
const allLo = Math.min(...kar.sentences.map(s => s.start));
const allHi = Math.max(...kar.sentences.map(s => s.end));
console.log(`\n结论：解析后时间轴跨度 ${(allHi - allLo).toFixed(1)}s`);
if (allHi - allLo < 60 && text.includes('3:4')) {
  console.log('  ✗ 被压扁了 —— 解析链丢了时间，这就是"挤在前几秒"的原因');
} else {
  console.log('  ✓ 跨度正常，解析链没问题；问题不在这里');
}
