/**
 * 右侧字幕列表 Quiet Card 的生产实装回归。
 *
 * 这次改版的目标：
 *   · 卡片只保留「角色 + 常驻样式 + 中文/英文」三层信息；
 *   · 样式标签常驻，不再依赖 hover；
 *   · 时间/置信度降为低对比的参照信息，重识别仍在左列（兼容原有交互）；
 *   · 分隔线、样式胶囊、播放中 pseudo 标签都不再出现。
 *
 * 断言直接读生产源码；同时保留结构类名（.cc-times/.cc-body/.cc-l1/
 * .cc-l2/.cc-left-stack/.cc-rerecog），避免破坏既有事件委托与虚拟滚动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'studio.css'), 'utf8');
const JS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'editor.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};
const ruleBody = (sel) => {
  const i = CSS.indexOf(sel + ' {');
  if (i < 0) return null;
  return CSS.slice(i + sel.length + 3, CSS.indexOf('}', i));
};
const CARD = ':is(#editor-panel #cue-list, .cue-measure)';

console.log('== 结构：新卡片仍在旧结构类名上 ==');
for (const token of ['cc-times', 'cc-body', 'cc-head', 'cc-l1', 'cc-l2', 'cc-left-stack', 'cc-rerecog', 'cc-role', 'cc-style', 'cc-playing']) {
  ok(JS.includes(token), `_cardHtml 含 ${token}`);
}
ok(/<div class="cc-times">/.test(JS), '.cc-times 仍是左列容器（重识别/置信度事件依赖）');
ok(/<div class="cc-body">/.test(JS), '.cc-body 仍存在');
ok(/cc-l1/.test(JS) && /cc-l2/.test(JS), '中文/英文行仍用 cc-l1 / cc-l2');
ok(!/cc-l2-sep/.test(JS), '不再输出旧的中英分隔线 class');
ok(/cc-style/.test(JS) && /\.join\(' · '\)/.test(JS), '样式名合并为常驻的「中文字幕 · Default」文本');
ok(/cc-role/.test(JS) && /cardDisplayL1/.test(JS), '角色名进入独立的 .cc-role，正文用 cardDisplayL1 去掉行首 [角色]');
ok(/cc-playing/.test(JS), '播放中状态由 .cc-playing 元素承担，不再用 ::after 伪元素');

console.log('\n== 视觉：单容器 + 角色色左条 + 常驻样式 ==');
const card = ruleBody(CARD + ' .cue-card');
ok(card !== null, '存在生产卡片的 Quiet Card 规则');
ok(/border-left:\s*3px solid var\(--role/.test(card || ''), '左侧 3px 角色色条');
ok(/grid-template-columns:\s*76px minmax\(0,\s*1fr\)/.test(card || ''), '左列 76px + 内容列');
ok(CSS.includes(':is(#editor-panel #cue-list, .cue-measure) .cue-card'), '隐藏测量容器复用同一套卡片样式（虚拟滚动高度一致）');
ok(/background:\s*var\(--cc-bg\)/.test(card || ''), '卡片使用主题卡片底色');
ok(/overflow:\s*hidden/.test(card || ''), '仍保留 overflow:hidden（逐词溢出裁切）');
const styleRule = ruleBody(CARD + ' .cc-style');
ok(styleRule !== null, '存在 .cc-style 规则');
ok(!/opacity:\s*0/.test(styleRule || ''), '样式标签没有隐藏（常驻）');
ok(/font-size:\s*9px/.test(styleRule || ''), '样式标签是低对比小字号（9px）');
ok(/\.cue-card\.playing::after\s*\{\s*content:\s*none/.test(CSS), '旧的 playing ::after 文本已关闭');
const l2sep = ruleBody(CARD + ' .cc-l2-sep');
ok(/border-top:\s*0/.test(l2sep || ''), '新卡片不画中英分隔线');
const times = ruleBody(CARD + ' .cc-times');
ok(times !== null && /border-right:\s*0/.test(times), '时间栏不再有竖分隔线');
const tspan = CSS.match(/:is\(#editor-panel #cue-list, \.cue-measure\) \.cc-t > span \{ display: none; \}/);
ok(!!tspan, '时间标签隐藏，只留低对比时间值');
const l1 = ruleBody(CARD + ' .cc-l1');
ok(/font-size:\s*13\.5px/.test(l1 || '') && /font-weight:\s*500/.test(l1 || ''), '中文行 13.5px / 500');
const l2 = ruleBody(CARD + ' .cc-l2');
ok(/font-size:\s*11\.2px/.test(l2 || ''), '英文行 11.2px（比中文退一档）');

console.log('\n== 主题与兼容 ==');
ok(/body\[data-theme="light"\] :is\(#editor-panel #cue-list, \.cue-measure\)/.test(CSS), '浅色主题有独立卡片变量');
ok(/--cc-bg:\s*#fbfcfc/.test(CSS) && /--cc-text:\s*#202930/.test(CSS), '浅色卡片底色/正文色已定义');
ok(/@media/.test(CSS), '媒体查询结构仍在（未误删）');
ok(/\.sf-studio\[data-design=uwp\] #editor-panel #cue-list \.cue-card/.test(CSS), 'UWP 仍保留 4px 小圆角覆盖');
ok(/\.cc-left-stack \.cc-rerecog/.test(CSS), '重识别按钮仍在左列样式内');
ok(/chip-conf-low/.test(CSS) && /--cc-warn/.test(CSS), '低置信度仍使用警示色');
const nb = (CSS.match(/\{/g) || []).length, ncb = (CSS.match(/\}/g) || []).length;
ok(nb === ncb, '花括号配对', nb + ' vs ' + ncb);
const nc = (CSS.match(/\/\*/g) || []).length, ncc = (CSS.match(/\*\//g) || []).length;
ok(nc === ncc, '注释配对', nc + ' vs ' + ncc);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
