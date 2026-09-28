/* LLM 回复卫生与解析单测: node tests/llm-text-test.mjs
 * 覆盖用户报的三个现象: 思维链乱跑、JSON 被带偏、小模型"每词加逗号"。 */
'use strict';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const L = require_('../editor/llm-text.js');

let pass = 0, fail = 0;
/* 尖括号标签用拼接构造: 直接写 `<think>` 在某些写入链路上会被吞掉(实测踩过) */
const LT = '<', GT = '>', SLASH = '/';
const thinkBlock = (inner) => LT + 'think' + GT + inner + LT + SLASH + 'think' + GT;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};

/* ── stripReasoning: 思维链必须被剥掉（以前完全没处理） ── */
ok(L.stripReasoning(thinkBlock('let me think about [1,2]…') + '["译文"]') === '["译文"]', '剥闭合的 think 块');
ok(L.stripReasoning('<thinking>a</thinking>答案') === '答案', '剥 <thinking> 块');
ok(L.stripReasoning('答案<reasoning>被截断的思考') === '答案', '剥未闭合的 <reasoning>（被截断）');
ok(L.stripReasoning('```think\n思考\n```\n["x"]') === '["x"]', '剥 ```think 围栏');
ok(L.stripReasoning('没有任何标签') === '没有任何标签', '无标签时原样');
ok(L.stripReasoning('\uFEFF["a"]') === '["a"]', '去 BOM');
ok(L.looksLikeReasoning(LT + 'think' + GT + 'x') === true && L.looksLikeReasoning('["a"]') === false, 'looksLikeReasoning 判别');

/* ── extractJsonArray: 平衡扫描（旧实现"首个[到末个]"会被思考/说明里的方括号带偏） ── */
ok(L.extractJsonArray('前缀 [1,2] 后缀 [3]') === '[1,2]', '取第一个完整闭合数组（不是到末个]）');
ok(L.extractJsonArray('["含 ] 的字符串"]') === '["含 ] 的字符串"]', '字符串里的 ] 不误判');
ok(L.extractJsonArray('["转义 \\"] 引号"]') === '["转义 \\"] 引号"]', '转义引号不误判');
ok(L.extractJsonArray('["未闭合"') === null, '未闭合 → null（被截断的典型形态）');
ok(L.extractJsonArray('没有任何数组') === null, '无数组 → null');

/* ── parseJsonArray ── */
let r = L.parseJsonArray('```json\n["甲","乙"]\n```');
ok(Array.isArray(r) && r.length === 2 && r[0] === '甲', '围栏 JSON');
r = L.parseJsonArray(thinkBlock('示例格式是 ["x"]，照这个来') + '\n好的，结果如下：["真值"]');
ok(Array.isArray(r) && r.length === 1 && r[0] === '真值', '思考里的示例数组不带偏（剥思维链+平衡扫描）');
r = L.parseJsonArray('[[3, ","],[7, "."]]');
ok(Array.isArray(r) && r.length === 2 && r[0][0] === 3, '标点对数组');
r = L.parseJsonArray('not json at all');
ok(r === null, '非 JSON → null');

/* ── parseLineArrayReply: 逐行纯文本兜底（用户报过模型无视 JSON 直接吐译文） ── */
let a = L.parseLineArrayReply('["第一行","第二行"]', 2);
ok(a && a.join('|') === '第一行|第二行', 'JSON 数组');
a = L.parseLineArrayReply('1. 第一行\n2. 第二行', 2);
ok(a && a.join('|') === '第一行|第二行', '编号行');
a = L.parseLineArrayReply('“第一行”\n"第二行"', 2);
ok(a && a.join('|') === '第一行|第二行', '带引号的行');
a = L.parseLineArrayReply('好的，以下是译文：\n第一行\n第二行', 2);
ok(a && a.join('|') === '第一行|第二行', '吃掉寒暄行');
a = L.parseLineArrayReply(LT + 'think' + GT + '我需要先分析用户意图…\n先看看这段英文' + LT + SLASH + 'think' + GT + '\n第一行\n第二行', 2);
ok(a && a.join('|') === '第一行|第二行', '吃掉思考行（以前会把思考行算成译文 → 行数不符）');
a = L.parseLineArrayReply('第一行\n第二行\n第三行', 2);
ok(a === null, '行数不符 → null');
a = L.parseLineArrayReply('[', 2);
ok(a === null, '只有括号 → null');

/* ── punctPairsSane: 防"每个词都加逗号"这类抽风 ── */
const everyWord = Array.from({ length: 40 }, (_, i) => [i, ',']);
ok(L.punctPairsSane(everyWord, 40) === false, '每词加逗号 → 判异常');
ok(L.punctPairsSane([[5, ','], [16, '.'], [22, ','], [34, '.'], [44, ',']], 56) === true, '正常密度 → 通过');
ok(L.punctPairsSane([], 56) === false, '一个标点都没有 → 异常');
const fourCommas = [[3, ','], [4, ','], [5, ','], [6, ',']];
ok(L.punctPairsSane(fourCommas, 30) === false, '连续 4 个逗号 → 异常（疑似逐词逗号）');
const listCommas = [[3, ','], [8, ','], [12, '.']];
ok(L.punctPairsSane(listCommas, 30) === true, '正常列举的逗号（不连续）→ 通过');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
