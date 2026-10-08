/**
 * 本地模型（Ollama + Qwen3）接入的回归。
 *
 * 踩过的三个坑，每个都写一条断言钉住：
 *   1. Ollama 把思考放在 `message.reasoning`，而代码只认 OpenAI 的 `reasoning_content`
 *      → 截断时报成"内容为空"，看不出真实原因
 *   2. 思考吃掉整个预算时，错误是 kind='empty' + finish_reason='length'（**不是** 'truncated'）
 *      → 自适应重试只认 truncated 就完全失效
 *   3. Ollama 的 OpenAI 兼容端点**不认** think 参数（原生端点才认），
 *      所以不能指望"关掉思考"，只能靠给够预算
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== 1. 思考字段名要兼容 Ollama ==');
ok(/typeof message\.reasoning_content === 'string'/.test(SRV), '仍支持 reasoning_content（OpenAI/DeepSeek）');
ok(/typeof message\.reasoning === 'string'/.test(SRV), '也支持 reasoning（Ollama / Qwen3）');
// 两者必须在同一个表达式里兜底，不能只加一个变量就算
ok(/reasoning_content === 'string'\)[\s\S]{0,200}message\.reasoning === 'string'/.test(SRV),
  '两个字段在同一处兜底（不是各写一遍）');

console.log('\n== 2. 自适应重试：truncated 与 empty+length 都要认 ==');
ok(/const REFLECT_MAX_TOKENS = 16384;/.test(SRV), '有预算上限常量（防止无限翻倍）');
ok(/kind === 'truncated'/.test(SRV), '认 truncated（有正文但被切断）');
ok(/kind === 'empty' && e && e\.finishReason === 'length'/.test(SRV),
  '也认 empty + finish_reason=length（预算全被思考吃掉）——漏掉这条自适应就失效');
ok(/budget < REFLECT_MAX_TOKENS/.test(SRV), '只在未到上限时重试');
ok(/Math\.min\(REFLECT_MAX_TOKENS, budget \* 2\)/.test(SRV), '每次翻倍，且不超过上限');
ok(/return runBatch\(user, next\)/.test(SRV), '递归重试同一批');
ok(/已自动把预算从 \$\{cfg\.maxTokens\} 提到 \$\{out\.budget\} 后成功/.test(SRV),
  '提预算的事实要报给用户（否则用户不知道发生了什么）');

console.log('\n== 3. 重试只针对"可救"的错误 ==');
// 认证/网络/格式错误翻倍预算没有意义，不该重试
ok(/if \(!canRetry\) throw e;/.test(SRV), '不可救的错误直接抛出，不浪费一次调用');
const retryBlock = SRV.slice(SRV.indexOf('const canRetry = truncated'), SRV.indexOf('const canRetry = truncated') + 400);
ok(!/kind === 'http'/.test(retryBlock) && !/kind === 'net'/.test(retryBlock),
  '没有把 http/net 错误也纳入重试');

console.log('\n== 4. 纠错的默认配置要够本地模型用 ==');
// maxTokens 默认 2048 对带思考的模型偏小；自适应用来兜底，但默认值也别太抠
ok(/Math\.max\(512, Math\.min\(8192, parseInt\(t\.maxTokens, 10\) \|\| 2048\)\)/.test(SRV),
  'correctCfg 的 maxTokens 范围 512~8192（默认 2048，靠自适应补足）');
ok(/REFLECT_MAX_TOKENS = 16384/.test(SRV) && 16384 > 8192,
  '重试上限高于配置上限（允许多次翻倍的余量）');

console.log('\n== 5. llmChat 的错误信息要能被用户看懂 ==');
ok(/把「每批行数」调小后重试`/.test(SRV), '截断提示给出可操作的建议');
ok(!/重试重试/.test(SRV), '没有重复的"重试重试"字样');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
