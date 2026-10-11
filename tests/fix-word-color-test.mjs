/* 「修复字幕」不得把逐词高亮色改回绿色 —— node tests/fix-word-color-test.mjs
 *
 * 用户报的 bug：右键「修复字幕」之后逐词高亮色变成绿色，**重开稿件才恢复**。
 *
 * 根因：main.js 的 `rebuildEnglishFromText` 是「修复字幕」三条路径（角色名 / 逐词与文本
 * 不一致 / 没有逐词效果）**唯一**的重建入口，它里面写死了 `{\c&H00FF00&}`（注释还写着
 * "逐词高亮回绿"）。重建把整句切片换成绿的；而重开稿件时会从 SubFabricWordColor 元数据
 * 读回用户配置色并 `setWordHighlightColor`，所以只有重开才恢复。
 *
 * 修复字幕的语义是"修坏掉的逐词/文本"，不该顺手改颜色。纯逻辑已抽到 karaoke.js 的
 * `highlightTagForRebuild()`，这里钉住它（DOM 那侧由 CDP 用例覆盖）。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* ⚠ jsmod 是**两族共用**镜像：上游族源 `editor/js`（本测试要的 karaoke.js 在这族），
 *   fork 族源 `editor/`。同步时只补齐/更新本族文件、绝不清空目录 —— 清空会顺手删掉
 *   另一族的文件，于是"哪个测试先跑"决定别的测试能不能过（2026-10-10 修复过）。 */
const SRC = path.resolve(HERE, '..', 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');

function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
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
const { highlightTagForRebuild, setWordHighlightColor, getWordHighlightColor,
        wordHighlightTag, recalcWords, buildWordSpecs } = K;

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

console.log('== 1. 行上原有的高亮色必须沿用（含非绿）==');
ok(highlightTagForRebuild('{\\c&HFFFFFF&}') === '{\\c&HFFFFFF&}', '白色原样保留');
ok(highlightTagForRebuild('{\\c&HFF00FF&}') === '{\\c&HFF00FF&}', '品红原样保留');
ok(highlightTagForRebuild('{\\c&H0088FF&}') === '{\\c&H0088FF&}', '橙红原样保留');
ok(highlightTagForRebuild('{\\c&H00FF00&}') === '{\\c&H00FF00&}', '本来就是绿的也原样保留');
ok(highlightTagForRebuild('{\\c&H00ff00&}') === '{\\c&H00ff00&}', '小写同样保留（不强制转大写）');

console.log('\n== 2. 行上没有/非法时才退回"当前配置色"，绝不是写死的绿 ==');
setWordHighlightColor('#ff00ff');
ok(getWordHighlightColor() === '#ff00ff', '配置色已设为品红');
ok(highlightTagForRebuild(null) === '{\\c&HFF00FF&}', '没有 highlightTag → 用配置色', highlightTagForRebuild(null));
ok(highlightTagForRebuild('') === '{\\c&HFF00FF&}', '空串 → 用配置色', highlightTagForRebuild(''));
ok(highlightTagForRebuild(undefined) === '{\\c&HFF00FF&}', 'undefined → 用配置色');
ok(highlightTagForRebuild('绿的') === '{\\c&HFF00FF&}', '垃圾值 → 用配置色', highlightTagForRebuild('绿的'));
ok(highlightTagForRebuild('{\\c&H00FF00&} extra') === '{\\c&HFF00FF&}',
  '★ 带多余内容的标签不算合法（不整段吞进事件文本）', highlightTagForRebuild('{\\c&H00FF00&} extra'));

console.log('\n== 3. 端到端：模拟「修复字幕」重建后切片用的仍是配置色 ==');
{
  /* 与 main.js rebuildEnglishFromText 同序：highlightTag → recalcWords → buildWordSpecs */
  const en = {
    style: '英文逐词', start: 10, end: 12, text: 'fix this line',
    words: [],                                                  // 修复前没有逐词
    events: [{ text: 'fix this line', style: '英文逐词', start: 10, end: 12, lineIdx: 0 }],
    proto: { layer: '0', name: '', effect: '', margins: { l: 0, r: 0, v: 0 }, style: '英文逐词' },
    highlightTag: null,                                         // 行上没有高亮色
  };
  en.highlightTag = highlightTagForRebuild(en.highlightTag);
  en.words = recalcWords(en, en.text, en.start, en.end);
  const specs = buildWordSpecs(en);
  ok(specs.length === 3, '重建出 3 条切片', specs.length);
  ok(specs.every(sp => /\{\\c&HFF00FF&\}/.test(sp.text)),
    '★ 每条切片都用配置的品红，而不是写死的绿', specs[0].text);
  ok(!specs.some(sp => /\{\\c&H00FF00&\}/.test(sp.text)),
    '★ 一条绿色的都没有（这就是用户报的现象）');
}

console.log('\n== 4. 没设过配置色时默认仍是绿（默认行为不变）==');
setWordHighlightColor('#00ff00');
ok(wordHighlightTag() === '{\\c&H00FF00&}', '默认 tag 是绿');
ok(highlightTagForRebuild(null) === '{\\c&H00FF00&}', '没有行内色时回退到默认绿');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
