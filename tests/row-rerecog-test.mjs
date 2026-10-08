/**
 * 验证两件事：
 *   1. jsmod 与 editor/js 整体同步（正确做法是整目录复制，而不是挑文件复制）；
 *   2. 每行卡片真的渲染出「↻ 重识别」按钮，且只在区间合法时出现；
 *      置信度徽标与「低置信度」判定也一并核对。
 *
 * `_cardHtml` 不碰 DOM，所以可以直接在 Node 里调它 —— 这是在没有浏览器的情况下
 * 能拿到的最强证据（能验证 HTML 输出，但验证不了视觉呈现）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = path.join(REPO, 'editor', 'js');
const JSMOD = path.join(HERE, 'jsmod');

// ── 1) 整体同步 jsmod（与 gen-fixture.mjs 的自举同一套做法）──
if (!fs.existsSync(JSMOD)) fs.mkdirSync(JSMOD, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith('.js')) continue;
  fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
  n++;
}
fs.writeFileSync(path.join(JSMOD, 'package.json'), '{"type":"module"}\n');
console.log(`jsmod 已整体同步：${n} 个 js 文件`);

// ── 2) 取 EditorPanel，直接验证 _cardHtml ──
const { EditorPanel } = await import(
  pathToFileURL(path.join(REPO, 'editor', 'js', 'editor.js')).href);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

const panel = Object.create(EditorPanel.prototype);
panel._mode = 'bi';
panel._hW = 400;
panel._offsets = null;
panel._metricsDirty = true;

const base = { start: 1.0, end: 3.5, l1: '你好', l2: 'hello', no: 1 };

console.log('\n== 有合法区间：应出现重识别按钮 ==');
let html = panel._cardHtml(Object.assign({}, base, {
  confidence: { score: 0.91, low: false, worstWord: null },
}), 0);
ok(html.includes('cc-rerecog'), '含 cc-rerecog');
ok(html.includes('data-act="rerecog"'), '含 data-act="rerecog"');
ok(html.includes('↻ 重识别'), '含按钮文案');
ok(html.includes('91%'), '含置信度 91%');
ok(html.includes('chip-conf') && !html.includes('chip-conf-low'), '高置信度用弱化样式');
ok(html.includes('data-idx="0"'), '含 data-idx（事件委托靠它取行数据）');
// 位置：用户要求放在**左侧时间点下方**。仅存在不够 —— 得确认它在 .cc-times 内、
// 且在 .cc-left-stack 里（否则又跑回右侧徽标行了）
{
  const times = /<div class="cc-times">([\s\S]*?)<\/div>\s*<div class="cc-body"/.exec(html);
  ok(!!times, '能找到 .cc-times 块');
  const inner = times ? times[1] : '';
  ok(inner.includes('cc-left-stack'), '左列里有 cc-left-stack 容器');
  ok(inner.includes('cc-rerecog'), '重识别按钮在左列里');
  ok(inner.includes('chip-conf'), '置信度徽标在左列里');
  // 反向：右侧徽标行里不该再有这两样
  const headM = /<div class="cc-head">([\s\S]*?)<\/div>/.exec(html);
  const head = headM ? headM[1] : '';
  ok(!head.includes('cc-rerecog'), '右侧徽标行里没有重识别按钮');
  ok(!head.includes('chip-conf'), '右侧徽标行里没有置信度徽标');
}

console.log('\n== 低置信度：徽标用警示样式 ==');
html = panel._cardHtml(Object.assign({}, base, {
  confidence: { score: 0.41, low: true, worstWord: 2 },
}), 7);
ok(html.includes('chip-conf-low'), '含 chip-conf-low');
ok(html.includes('◔ 41%'), '含低置信度分值');
ok(html.includes('41%'), '含 41%');
ok(html.includes('最可疑的是第 3 个词'), 'tooltip 里有可疑词位置');
ok(html.includes('data-idx="7"'), 'data-idx 跟随传入下标');
ok(/<div class="cc-times">[\s\S]*?chip-conf-low[\s\S]*?<\/div>\s*<div class="cc-body"/.test(html),
  '低置信度徽标也在左列里');

console.log('\n== 无置信度元数据：不显示徽标，但按钮仍在 ==');
html = panel._cardHtml(Object.assign({}, base, { confidence: null }), 0);
ok(!html.includes('chip-conf'), '不显示置信度徽标');
ok(html.includes('cc-rerecog'), '重识别按钮仍在（不依赖置信度）');

console.log('\n== 区间非法：不应出现按钮 ==');
for (const bad of [{ start: 2, end: 2 }, { start: 3, end: 1 }, { start: NaN, end: 1 }]) {
  const h = panel._cardHtml(Object.assign({}, base, bad), 0);
  ok(!h.includes('cc-rerecog'), `区间 ${bad.start}~${bad.end} 不显示按钮`);
}

console.log('\n== itemAt：按过滤后下标取数 ==');
panel.filtered = [{ start: 1, end: 2, l1: 'A' }, { start: 5, end: 6, l1: 'B' }];
ok(panel.itemAt(1) && panel.itemAt(1).l1 === 'B', 'itemAt(1) 取到第二条');
ok(panel.itemAt(9) === null, '越界返回 null');
ok(panel.itemAt(-1) === null, '负数返回 null');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
