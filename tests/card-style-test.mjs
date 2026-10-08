/**
 * 三项显示调整的回归：
 *   1. 每句置信度换亮色（原来 var(--text-2) 灰字，可读性差）
 *   2. 中英字幕之间加淡灰分隔行（**只在两行都有时**出现）
 *   3. 字幕块右侧内容顶部对齐（原来是垂直居中，与左侧时间列不齐）
 *
 * 断言策略：既要"新值在"，也要"旧值不在" —— 只查新值的话，
 * 旧规则残留（两条规则同时命中、后者覆盖前者）会静默失效。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');
const JS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'editor.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

/** 取某条规则的属性体（第一条匹配） */
const ruleBody = (sel) => {
  const i = CSS.indexOf(sel + ' {');
  if (i < 0) return null;
  const j = CSS.indexOf('}', i);
  return CSS.slice(i + sel.length + 3, j);
};

console.log('== 1. 置信度徽标换成亮色 ==');
const conf = ruleBody('.chip-conf');
ok(conf !== null, '能找到 .chip-conf 规则');
ok(/color:\s*#7fd8e8/.test(conf || ''), '用亮色 #7fd8e8（浅青）', conf);
ok(!/color:\s*var\(--text-2\)/.test(conf || ''),
  '不再用 var(--text-2) 灰字（旧值必须消失，否则可能被覆盖）');
// 低置信度仍要更显眼：与正常档不同色，且加粗
const low = ruleBody('.chip-conf-low');
ok(/color:\s*#ffd54a/.test(low || ''), '低置信度仍是琥珀 #ffd54a');
ok(/font-weight:\s*700/.test(low || ''), '低置信度加粗（比正常档更显眼）');
ok(conf !== low, '两档样式不同（不靠"灰一点/亮一点"区分）');

console.log('\n== 2. 中英分隔行 ==');
const sep = ruleBody('.cc-l2-sep');
ok(sep !== null, '定义了 .cc-l2-sep');
ok(/border-top:\s*1px solid rgba\(255,255,255,?\.14\)/.test(sep || ''),
  '是 1px 淡灰线（不是彩色，避免抢注意力）', sep && sep.slice(0, 90));
// 只跟英文行一样长，不横贯整块
ok(/width:\s*fit-content/.test(sep || ''), 'width: fit-content（线长跟随文本）');
ok(/padding-top/.test(sep || '') && /margin-top/.test(sep || ''), '有上下间距，不贴着文字');

// 关键：只在**两行都有**时加这个类
ok(/cc-l2\$\{l1 \? ' cc-l2-sep' : ''\}/.test(JS),
  'editor.js 只在中文行存在时才加 cc-l2-sep');
// 占位行不该有分隔线
ok(!/cc-ph2[^`]*cc-l2-sep/.test(JS), '新建占位行（cc-ph2）不带分隔线');

console.log('\n== 3. 右侧内容顶部对齐 ==');
const body = ruleBody('.cc-body');
ok(body !== null, '能找到 .cc-body 规则');
ok(/justify-content:\s*flex-start/.test(body || ''), '改成 flex-start（顶部对齐）', body);
ok(!/justify-content:\s*center/.test(body || ''),
  '不再是 center（旧值必须消失 —— 否则两条规则打架）');

console.log('\n== 4. 三处改动不能破坏已有结构 ==');
ok(CSS.includes('.cc-l1 {'), '.cc-l1 规则仍在（我改这几项时误删过一次）');
ok(CSS.includes('.cc-l2 {'), '.cc-l2 规则仍在');
ok(CSS.includes('.cc-left-stack'), '左列容器样式仍在（置信度+重识别按钮）');
ok(ruleBody('.cc-left-stack') !== null, '.cc-left-stack 规则完好');
// 括号与注释配对
const nb = (CSS.match(/\{/g) || []).length, ncb = (CSS.match(/\}/g) || []).length;
ok(nb === ncb, '花括号配对', nb + ' vs ' + ncb);
const nc = (CSS.match(/\/\*/g) || []).length, ncc = (CSS.match(/\*\//g) || []).length;
ok(nc === ncc, '注释配对', nc + ' vs ' + ncc);

console.log('\n== 5. 更早的修复仍在（防回退）==');
ok(/position:\s*fixed;\s*z-index:\s*65/.test(CSS), '异常筛选浮层仍是 fixed + z-index 65');
ok(/padding-bottom:\s*8px/.test(CSS), '.ptab 双线修复仍在');
ok(/padding-bottom:\s*9px/.test(CSS), '.st-tab 双线修复仍在');

console.log('\n== 6. 卡片右边界不能被裁掉 ==');
// 关键：relative 定位下 right 不生效（left 非 auto 时 right 被算成 -left），
// 于是卡片只是整体右移 → 超出 #cue-list 内容框 → 被 overflow 裁掉。
// 必须用 margin 留边距。（注意：不能直接查 `left: 8px` 字符串 —— 规则上方的注释里
// 就提到了这个错误写法，会误判；要把注释剥掉再查。）
const cssNoComment = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const cardBody = (() => {
  const i = cssNoComment.indexOf('.cue-card {');
  return i < 0 ? null : cssNoComment.slice(i + 11, cssNoComment.indexOf('}', i));
})();
ok(cardBody !== null, '能找到 .cue-card 规则（已剥注释）');
ok(/margin:\s*0 8px 6px/.test(cardBody || ''), '用 margin 留出左右 8px 边距', cardBody && cardBody.slice(0, 60));
ok(!/(^|[;{\s])left:\s*8px/.test(cardBody || ''),
  '规则体内没有 left: 8px（那会整体右移、把右边界推出容器）');
ok(!/(^|[;{\s])right:\s*8px/.test(cardBody || ''),
  '规则体内没有 right: 8px（relative 下它本就不生效，留着只会误导）');
ok(/overflow:\s*hidden/.test(cardBody || ''),
  'overflow: hidden 保留（不能靠去掉裁切来"露出"边界，那会让逐词高亮溢出卡片）');
// 悬停也不能位移，否则悬停瞬间右边又被切。
// ⚠ 取**最后一条** .cue-card:hover —— 文件里前面还有一条旧的（只改背景色），
// 真正生效的是后面那条（CSS 后者覆盖前者）。用 search 会匹配到错的那条。
const hovIdx = cssNoComment.lastIndexOf('.cue-card:hover');
const hov = hovIdx < 0 ? null : cssNoComment.slice(hovIdx, cssNoComment.indexOf('}', hovIdx) + 1);
ok(hov !== null, '能找到 .cue-card:hover（取最后一条，即生效的那条）');
ok(/transform:\s*none/.test(hov || ''), '悬停不再位移（改用 inset 阴影）', hov && hov.trim().slice(0, 80));
ok(/inset/.test(hov || ''), '悬停改用 inset 阴影做强调');
ok(!/translateX/.test(hov || ''), '生效的悬停规则里没有 translateX');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
