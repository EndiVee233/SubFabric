/**
 * 采样温度 / 上下文行数 / 带上下文的批次切分 —— 纯函数单测。
 *
 * 背景：设计稿 ③ 的 LLM 面板里有「采样温度」与「上下文行数」两项（原来温度写死 0.3、
 * 上下文根本没有）。接线时最容易出错的两点，本文件专门钉住：
 *   ① **不带上下文时，批次划分必须与旧的 planChunks 完全一致** —— 否则老用户的翻译行为
 *      会莫名其妙变掉（分批边界一变，模型看到的上下文就变了，译文会跟着变）。
 *   ② **参考行不参与译文行数校验**：buildTranslateUserMessage 里额外塞了参考行，
 *      但它返回的字符串里"待翻译行"必须仍是 texts.length 条，
 *      否则 parseTranslationReply 的等行数校验会失配、整批报格式错。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// editor/llm-text.js 是 CJS（module.exports）—— 必须 require 而不是 import。
// tests/jsmod/llm-text.js 是**浏览器侧**的同名镜像（ESM），
// 这两条链路由 run-all 的一致性检查保证同源，本文件最后一段会拿两者对拍。
const S = require('../editor/llm-text.js');
const L = S;

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failed++; console.log('  ✗', name, extra == null ? '' : '   ' + extra); }
}

console.log('\n── ① 采样温度夹取 ──');
{
  check('默认值 0.3', L.clampTemperature(undefined) === 0.3, String(L.clampTemperature(undefined)));
  check('0 合法（确定性输出）', L.clampTemperature(0) === 0);
  check('2 合法（上限）', L.clampTemperature(2) === 2);
  check('越界上限夹回 2', L.clampTemperature(9) === 2, String(L.clampTemperature(9)));
  check('负数夹回 0', L.clampTemperature(-1) === 0, String(L.clampTemperature(-1)));
  check('非数字 → 默认', L.clampTemperature('abc') === 0.3);
  check('字符串数字可用', L.clampTemperature('0.7') === 0.7);
  check('NaN → 默认', L.clampTemperature(NaN) === 0.3);
}

console.log('\n── ② 上下文行数夹取 ──');
{
  check('默认 0（= 不带上下文，旧行为）', L.clampContextRows(undefined) === 0);
  check('负数 → 0', L.clampContextRows(-5) === 0);
  check('0 → 0', L.clampContextRows(0) === 0);
  check('20 保留', L.clampContextRows(20) === 20);
  check('小数取整', L.clampContextRows(12.7) === 13, String(L.clampContextRows(12.7)));
  check('上限 200 夹回', L.clampContextRows(9999) === 200, String(L.clampContextRows(9999)));
}

console.log('\n── ③ 不带上下文时批次划分与旧 planChunks 完全一致（回归护栏）──');
{
  const items = Array.from({ length: 57 }, (_, i) => ({ text: 't' + i, zh: i % 3 ? '译' + i : '' }));
  const plain = L.planChunks(items, 25);                 // 旧函数
  const jobs0 = L.planJobs(items, 25, 0);                // 新函数 contextRows = 0
  const sameIdx = plain.length === jobs0.length
    && plain.every((chunk, i) => chunk.length === jobs0[i].idxs.length
      && chunk.every((it, k) => it === items[jobs0[i].idxs[k]]));
  check(`分批边界一致（${plain.length} 批）`, sameIdx,
    JSON.stringify({ plain: plain.map(c => c.length), jobs: jobs0.map(j => j.idxs.length) }));
  check('contextRows=0 时每批 refs 都为空', jobs0.every(j => j.refs.length === 0));
  const def = L.planJobs(items, 25);
  check('不传 ctx 参数同样不带 refs（默认 0）', def.every(j => j.refs.length === 0));
}

console.log('\n── ④ 带上下文：refs 只取"前面已有译文"的行 ──');
{
  const items = [];
  for (let i = 0; i < 60; i++) items.push({ text: 'line' + i, zh: i < 20 ? '译' + i : '' });
  const jobs = L.planJobs(items, 25, 5);
  check('仍是 3 批（上下文不改变分批）', jobs.length === 3, String(jobs.length));
  check('第 1 批没有上文（前面没东西）', jobs[0].refs.length === 0);
  // 第 2 批从第 25 行开始，往前 5 行是 20..24，但这 5 行 zh 都是空 → 一条参考都没有
  check('第 2 批的上文被"无译文"过滤掉', jobs[1].refs.length === 0, JSON.stringify(jobs[1].refs));
  // 第 3 批从第 50 行开始，往前 5 行是 45..49，同样无译文
  check('第 3 批同理', jobs[2].refs.length === 0);
  const items2 = [];
  for (let i = 0; i < 60; i++) items2.push({ text: 'line' + i, zh: '译' + i });   // 全都有译文
  const jobs2 = L.planJobs(items2, 25, 5);
  check('全都有译文时：第 2 批带 5 条参考', jobs2[1].refs.length === 5, String(jobs2[1].refs.length));
  check('参考内容是紧邻的前几行', jobs2[1].refs[0].text === 'line20' && jobs2[1].refs[4].text === 'line24',
    JSON.stringify(jobs2[1].refs.map(r => r.text)));
  check('参考里带上已定译文', jobs2[1].refs[0].zh === '译20');
  const jobs3 = L.planJobs(items2, 25, 999);            // 超上限会被夹到 200
  check('上下文超上限时夹到 200（不会把整篇塞进去）', jobs3[1].refs.length === 25, String(jobs3[1].refs.length));
}

console.log('\n── ⑤ 提示词拼装：参考行不能算进"待翻译行数" ──');
{
  const texts = ['a', 'b', 'c'];
  const plain = L.buildTranslateUserMessage(texts, null);
  check('无参考时就是纯文本（与旧行为一致）', plain === 'a\nb\nc', JSON.stringify(plain));

  const withRefs = L.buildTranslateUserMessage(texts, [{ text: 'x', zh: 'X' }, { text: 'y', zh: 'Y' }]);
  check('有参考时含参考标记', /前文参考/.test(withRefs) && /不要翻译/.test(withRefs));
  check('含"以下 3 行"的准确计数', /以下 3 行/.test(withRefs), withRefs.slice(0, 80));
  const tail = withRefs.split('本次要翻译的内容]]\n')[1];
  check('标记之后正好是待翻的 3 行', tail === 'a\nb\nc', JSON.stringify(tail));
  check('参考行在最前面（模型的阅读顺序对）', withRefs.indexOf('x\t=> X') < withRefs.indexOf('a\nb\nc'));

  const empty = L.buildTranslateUserMessage(texts, [{ text: '', zh: '' }]);
  check('空白参考被忽略', empty === 'a\nb\nc', JSON.stringify(empty));
  const onlyZh = L.buildTranslateUserMessage(['z'], [{ text: '', zh: '有译文' }]);
  check('只有译文的参考仍然带上', /有译文/.test(onlyZh));
  check('单行 + 参考 → 计数写 1', /以下 1 行/.test(onlyZh));
}

console.log('\n── ⑥ 服务端加载的是同一份实现（镜像不会分叉）──');
{
  check('两侧都是函数', typeof S.clampTemperature === 'function' && typeof L.clampTemperature === 'function');
  const cases = [undefined, 0, 0.7, 2, 9, -1, 'abc', NaN];
  check('温度夹取逐例一致', cases.every(v => S.clampTemperature(v) === L.clampTemperature(v)));
  const cs = [undefined, -5, 0, 12.7, 9999];
  check('上下文夹取逐例一致', cs.every(v => S.clampContextRows(v) === L.clampContextRows(v)));
  const items = Array.from({ length: 30 }, (_, i) => ({ text: 't' + i, zh: i < 10 ? 'z' + i : '' }));
  const a = JSON.stringify(S.planJobs(items, 7, 4));
  const b = JSON.stringify(L.planJobs(items, 7, 4));
  check('planJobs 输出逐字一致', a === b);
  check('buildTranslateUserMessage 逐字一致',
    S.buildTranslateUserMessage(['p', 'q'], [{ text: 'r', zh: 'R' }]) === L.buildTranslateUserMessage(['p', 'q'], [{ text: 'r', zh: 'R' }]));
}

console.log('');
if (failed) { console.log(`✗ ${failed} 项失败`); process.exit(1); }
console.log('全部通过');
