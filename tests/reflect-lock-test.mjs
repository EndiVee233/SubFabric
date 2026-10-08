/**
 * 两个用户实测报的 bug 的回归。
 *
 * 【Bug 1】"纠错重识别启动失败：这个稿件已有重新识别任务在跑"
 *   根因：POST 的互斥检查只看任务表里有没有这个 id，**不看状态** ——
 *   一个已跑完/已失败的旧任务，只要还没被 10 分钟的老化清理掉，就把稿件挡死。
 *   前端的钩子（applyReflect）又没有重入保护，连点两次就必然撞上。
 *
 * 【Bug 2】"选中『用字幕翻译的模型』后无法取消勾选"
 *   根因：服务端用"地址与模型都为空 ⇒ 跟随翻译"来**推断**开关，
 *   而取消勾选那一刻地址正是空的 → 又被算回"跟随翻译"，勾选框回弹。
 *   而且 POST 里只处理 `useTranslate === true`，前端传的 `false` 完全被忽略。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
const MJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
const PJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== Bug 1：已结束的旧任务不能挡新任务 ==');
ok(/function jobStillRunning\(job\)/.test(SRV), '有"真的还在跑"的判定函数');
ok(/if \(!job \|\| job\.status !== 'running'\) return false;/.test(SRV),
  '非 running 状态 → 不算在跑（已结束/失败的任务直接放行）');
ok(/if \(jobStillRunning\(prevJob\)\) return sendJson\(res, 409/.test(SRV),
  'POST 用 jobStillRunning 判定，而不是"表里有没有"');
ok(!/if \(jobRerecog\.has\(id\)\) return sendJson\(res, 409/.test(SRV),
  '旧的 has(id) 判断已移除（那正是挡死用户的写法）');
ok(/const JOB_STALE_MS = 15 \* 60 \* 1000;/.test(SRV), '有"心跳停了就算死任务"的超时');
ok(/Date\.now\(\) - beat > JOB_STALE_MS/.test(SRV), '用最后心跳判断，而不是只看状态');
ok(/job\.updatedAt = new Date\(\)\.toISOString\(\)/.test(SRV), '任务带 updatedAt（心跳字段）');
ok(/job\.touch = \(\) => \{ job\.updatedAt/.test(SRV), '有刷新心跳的方法');
ok(/job\.touch\(\);/.test(SRV), '等待每段完成时刷新心跳（长任务不会被误判为死）');

console.log('\n== Bug 1 前端：防重入 ==');
ok(/let reflectApplying = false;/.test(MJ), '有重入标志');
ok(/if \(reflectApplying\) return;/.test(MJ), 'applyReflect 进来先检查');
ok(/reflectApplying = true;/.test(MJ), '进入时置位');
ok(/reflectApplying = false;[\s\S]{0,80}reflectEls\.btn\.disabled = false;/.test(MJ),
  'finally 里复位（失败也要能再试）');
// 弹窗一关用户就以为"回到编辑页"，最容易连点
ok(/reflectShow\(false\);[\s\S]{0,80}reflectApplying = true;/.test(MJ),
  '关弹窗与置位在同一处（那正是用户连点的时机）');

console.log('\n== Bug 2：开关必须是显式的 ==');
ok(/function correctUseTranslate\(raw\)/.test(SRV), '有统一的开关解析函数');
ok(/if \(typeof t\.useTranslate === 'boolean'\) return t\.useTranslate;/.test(SRV),
  '显式字段优先');
ok(/return !String\(t\.baseUrl \|\| ''\)\.trim\(\) && !String\(t\.model \|\| ''\)\.trim\(\);/.test(SRV),
  '旧配置回退到推断（向后兼容，不能让老配置失去"跟随翻译"）');
ok(/if \(p\.useTranslate !== undefined\) cur\.useTranslate = p\.useTranslate === true;/.test(SRV),
  'POST 双向处理（原来只认 === true，false 被忽略）');
ok(!/if \(p\.useTranslate === true\) \{ cur\.baseUrl = ''/.test(SRV),
  '不再在切换时清空用户填的地址（切来切回不用重填）');
ok(/raw\.baseUrl/.test(SRV) === false || /const useTranslate = correctUseTranslate\(raw\);/.test(SRV),
  'view() 用统一的解析函数，不自己再推断一遍');

console.log('\n== Bug 2 前端 ==');
ok(/await correctSave\(\{ useTranslate: ut\.checked \}\);/.test(PJ),
  '两个方向都发显式开关');
ok(!/correctSave\(ut\.checked \? \{ useTranslate: true \} : \{ baseUrl:/.test(PJ),
  '不再在取消勾选时发 baseUrl（那会被服务端算回"跟随翻译"）');
ok(/还没填地址与模型名；在填好之前仍会临时沿用/.test(PJ),
  '空值时会说明"临时沿用翻译模型"，避免用户以为取消无效');

console.log('\n== 不破坏既有行为 ==');
// correctCfg 不能因为改造丢掉 mode/batchLines 的兜底
ok(/mode: \(t\.mode === 'off' \|\| t\.mode === 'preview' \|\| t\.mode === 'auto'\) \? t\.mode : 'preview'/.test(SRV),
  'correctCfg 仍给出 mode 默认值（"关闭"档不能失效）');
ok(/batchLines: Math\.max\(20, Math\.min\(200, parseInt\(t\.batchLines, 10\) \|\| reflectMod\.BATCH_LINES\)\)/.test(SRV),
  'correctCfg 仍给出 batchLines 默认值');
ok(/maxTokens: Math\.max\(512, Math\.min\(8192/.test(SRV), 'correctCfg 仍给出 maxTokens 默认值');
// 跟随翻译时要真的用翻译的 Key/模型
ok(/provider: provider \|\| base\.provider/.test(SRV), '跟随翻译时 provider 兜底到翻译配置');
ok(/model: pick\(f\.model, preset \? preset\.model : base\.model\)/.test(SRV),
  '跟随翻译时 model 兜底到翻译配置');

console.log('\n== 跟随开关必须真的作用到字段上（这里踩过一次"半接线"）==');
/* 真实 bug：correctCfg 里算了 follow，却只拿它决定 provider，
 * 地址/模型仍用 pick(t.baseUrl/t.model) 直接读自定义值 ——
 * 于是勾选"用字幕翻译的模型"后 useTranslate=true、实际调用的却还是自定义模型。
 * 上面几条按源码匹配的断言抓不到这种错，所以这里专测"开关有没有接到字段上"。
 * （真正的行为验证在 correct-switch-test.mjs，那个要连运行中的服务。） */
ok(/const f = follow \? \{\} : t;/.test(SRV),
  '跟随翻译时把自定义值整体置空（f = {}），字段一律从 f 取');
ok(/baseUrl: pick\(f\.baseUrl,/.test(SRV), 'baseUrl 从 f 取（不是 t）');
ok(/apiKey: pick\(f\.apiKey,/.test(SRV), 'apiKey 从 f 取（不是 t）');
ok(!/baseUrl: pick\(t\.baseUrl/.test(SRV), 'baseUrl 没有残留直接读 t 的写法');
ok(!/model: pick\(t\.model/.test(SRV), 'model 没有残留直接读 t 的写法');
ok(!/apiKey: pick\(t\.apiKey/.test(SRV), 'apiKey 没有残留直接读 t 的写法');
ok(!/const provider = follow \? '' : \(t\.provider \|\| ''\);/.test(SRV),
  'provider 也走统一的 f，不再单独特判（特判正是当初漏掉其它字段的原因）');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
