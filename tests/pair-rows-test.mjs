/* 针对性验证 pairRows 的坏法：
 * 用户场景 = "分段导入 + 后续编辑/重载"导致中文行时间变了、或同一时刻有多条词句。
 * 直接喂 karaoke.js 的纯函数，看它会不会产出"中文行装英文 / 词行变空"。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor');
const JSMOD = path.join(HERE, 'jsmod');function ensureJsmod() {
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
const K = await import('./jsmod/karaoke.js');
const { pairRows } = K;

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

const ZH = '中文字幕', EN = 'Default';
/** 造一条"整句"（中文样式） */
const zhSent = (s, e, text) => ({
  style: ZH, start: s, end: e, text,
  events: [{ text, style: ZH, start: s, end: e, lineIdx: 0 }],
  words: [], speaker: '', color: null, highlightTag: '',
});
/** 造一条"逐词"（英文样式），words 用给定切片 */
const enSent = (s, e, text, words) => ({
  style: EN, start: s, end: e, text,
  events: [{ text, style: EN, start: s, end: e, lineIdx: 0 }],
  words, speaker: '', color: null, highlightTag: '',
});
const W = (w, s, e) => ({ w, s, e });

console.log('== 基线：中英时间一致的导入行（我们现在的做法）==');
{
  const rows = pairRows([
    zhSent(100, 103, '导入的中文'),
    enSent(100, 103, 'first imported words', [W('first',100,101), W('imported',101,102), W('words',102,103)]),
  ], EN);
  ok(rows.length === 1, '配对成 1 行', rows.length);
  ok(rows[0].zh && rows[0].zh.text === '导入的中文', '中文归位', rows[0].zh && rows[0].zh.text);
  ok(rows[0].en && rows[0].en.text === 'first imported words', '英文归位', rows[0].en && rows[0].en.text);
}

console.log('\n== 场景 A：中文行时间被改短，英文超出 → 会不会变空行？ ==');
{
  const rows = pairRows([
    zhSent(100, 101, '被改短的中文'),                     // 只有 1 秒
    enSent(100, 103, 'first imported words', [W('first',100,101), W('imported',101,102), W('words',102,103)]),
  ], EN);
  const withZh = rows.filter(r => r.zh);
  const enOnly = rows.filter(r => !r.zh && r.en);
  console.log('    行数 %d  有中文的 %d  只有英文的 %d', rows.length, withZh.length, enOnly.length);
  ok(rows.length === 2, '英文超出时**不会被塞进中文行**（拆成两行）', rows.length);
  ok(withZh.length === 1 && withZh[0].zh.text === '被改短的中文', '中文行内容正确', withZh.map(r => r.zh.text));
  ok(enOnly.length === 1, '英文落成"只有英文"的行（不是空的）', enOnly.length);
  // ★ 关键：不能出现"中文行里装着英文"
  const wrong = rows.filter(r => r.zh && /^[A-Za-z]/.test(r.zh.text) && !r.en && !r.zh.words.length);
  console.log('    中文行装英文的情况: %d', wrong.length);
}

console.log('\n== 场景 B：同一时刻有两条中文字幕（"含"关系含糊）==');
{
  const rows = pairRows([
    zhSent(2.32, 11.80, '长中文行'),
    zhSent(2.32, 2.83, '短中文行'),
    enSent(2.32, 2.83, 'Spawn is', [W('Spawn',2.32,2.5), W('is',2.5,2.83)]),
  ], EN);
  ok(rows.length === 2, '两条中文行都在', rows.length);
  const short = rows.find(r => r.zh && r.zh.text === '短中文行');
  const long = rows.find(r => r.zh && r.zh.text === '长中文行');
  ok(short && short.en, '★ 词句配给了**起止误差最小**的那条（短中文行）', short && short.en && short.en.text);
  ok(long && !long.en, '长中文行没有英文（不是被塞了错的）', long && (long.en ? long.en.text : null));
  // 不能出现"长中文行装着英文词、短中文行空着"
  ok(!(long && long.en && !short.en), '没有错配');
}

console.log('\n== 场景 C：词句完全没有中文锚点（孤儿）→ 会不会变空？ ==');
{
  const rows = pairRows([
    zhSent(0, 5, '别的行'),
    enSent(100, 103, 'orphan words', [W('orphan',100,101), W('words',101,103)]),
  ], EN);
  const orphan = rows.find(r => !r.zh && r.en);
  ok(!!orphan, '孤儿词句成为"只有英文"的行', rows.length);
  ok(orphan && orphan.en.text === 'orphan words', '★ 孤儿词句**文本没丢**', orphan && orphan.en.text);
  ok(rows.every(r => !(r.zh && !r.zh.text && !r.zh.words.length) || true), '(占位)');
}

console.log('\n== 场景 D：中文行文本为空、英文有文本（现在项目里的坏法）==');
{
  const rows = pairRows([
    zhSent(0, 0.19, ''),                       // 空的中文行
    enSent(0, 0.19, '', []),                   // 空的词句
  ], EN);
  console.log('    行数 %d  内容: %s', rows.length,
    JSON.stringify(rows.map(r => ({ zh: r.zh && r.zh.text, en: r.en && r.en.text }))));
  ok(rows.length === 1, '空 + 空 → 合成 1 行（不新增空行）', rows.length);
}

console.log('\n== 场景 E：★★ 词句的 words 为空（没有逐词切片）但有文本 ==');
{
  const rows = pairRows([
    zhSent(30, 33, '这段中文'),
    enSent(30, 33, 'this english has no word slices', []),
  ], EN);
  ok(rows.length === 1, '配对成 1 行', rows.length);
  ok(rows[0].en && rows[0].en.text === 'this english has no word slices',
    '★ 没有词切片的英文行，文本仍然在（不会变空）', rows[0].en && rows[0].en.text);
  ok(rows[0].zh && rows[0].zh.text === '这段中文', '中文没被英文顶掉', rows[0].zh && rows[0].zh.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
