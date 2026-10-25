/* 高级字幕操作的两个低频道具：接线与"二次确认"契约（静态回归）。
 *
 *   · 「全片逐词重校对」按钮 -> beginRealignFull -> panel.showConfirm -> startRealignFull；
 *     SRT 稿件必须带 allowSrtToAss（否则服务端拒绝静默改格式），应用走 realign-full-apply；
 *   · 「说话人分离」按钮 -> beginDiarize -> panel.showConfirm -> startDiarize
 *     -> POST /api/projects/:id/diarize；结果按 speakerSpansForRows 写 [SPKn]；
 *   · 生产入口 editor/studio.html 必须与模板逐字节一致，按钮在「高级字幕操作」组里。
 *
 * 只读源码，不起服务、不加载模型。行为本身见 srt-ass-test / speaker-map-test /
 * srt-realign-api-test / srt-ass-e2e-test / diarize-api-test。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const main = read('editor/js/main.js');
const server = read('editor/server.js');
const css = read('editor/css/studio.css');
const template = read('tools/templates/studio.html');
const studio = read('editor/studio.html');

/** 取顶层函数体（文件里顶层函数都以行首 `}` 收尾）。 */
function bodyOf(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, '函数 ' + name + ' 没有正常的结束位置');
  return source.slice(start, end);
}

/* ── 入口与模板一致 ── */
assert.equal(studio, template, 'editor/studio.html 必须由 tools/templates/studio.html 逐字节生成');

const groupAt = template.indexOf('id="editor-advanced-actions"');
assert.ok(groupAt > 0, '高级字幕操作组存在');
const groupEnd = template.indexOf('</div>\n        </div>', groupAt);
const group = template.slice(groupAt, groupEnd);
assert.match(group, /id="btn-realign-full"/, '全片逐词重校对在高级字幕操作组内');
assert.match(group, /id="btn-diarize"/, '说话人分离在高级字幕操作组内');
assert.match(group, /id="btn-diarize"[^>]*title="[^"]*先确认再跑/, '说话人分离按钮提示二次确认');

/* ── 全片逐词重校对：先确认，再启动 ── */
assert.match(main, /realignEls\.btn\.addEventListener\('click', \(\) => beginRealignFull\(\)\)/,
  '主按钮必须走确认入口（左键 = 全片），不能直接 startRealignFull');
const beginRealign = bodyOf(main, 'beginRealignFull');
assert.match(beginRealign, /panel\.showConfirm\(/, '全片逐词重校对必须先二次确认');
assert.match(beginRealign, /state\.format === 'srt'/, 'SRT 与 ASS 的确认文案要分开');
assert.match(beginRealign, /startRealignFull\(rg\)/, '确认后才真正启动（可带区域）');
assert.match(beginRealign, /区域逐词重校对/, '右键的区域重校对走同一个确认入口');

const startRealign = bodyOf(main, 'startRealignFull');
assert.match(startRealign, /allowSrtToAss/, '启动请求必须带 SRT→ASS 的确认标记');
assert.match(startRealign, /state\.format === 'srt'/, 'SRT 模式才带该标记');

const applySrt = bodyOf(main, 'applySrtRealignToAss');
assert.match(applySrt, /realign-full-apply/, 'SRT 的应用走服务端写 ASS');
assert.match(applySrt, /Projects\.openProject\(pid\)/, '写完后重新载入项目以切换到 ASS');

/* ── 说话人分离：先确认，再跑后台作业 ── */
assert.match(main, /btnDiarize\.addEventListener\('click', beginDiarize\)/);
const beginDiarize = bodyOf(main, 'beginDiarize');
assert.match(beginDiarize, /panel\.showConfirm\(/, '说话人分离必须先二次确认');
assert.match(beginDiarize, /state\.format !== 'ass'/, 'SRT 稿件要提示先转 ASS');
const startDiarize = bodyOf(main, 'startDiarize');
assert.match(startDiarize, /\/diarize`/, 'POST 到项目的 diarize 接口');
const applyDiarize = bodyOf(main, 'applyDiarizeResult');
assert.match(applyDiarize, /speakerSpansForRows\(/, '按重叠给每行找说话人');
assert.match(applyDiarize, /applyRoleToRowWith\(/, '写入 [SPKn] 与角色色复用现有角色逻辑');
assert.match(applyDiarize, /scheduleSave/, '写完后保存字幕');

/* ── 服务端接口与状态表 ── */
assert.match(server, /const diarizeJobs = new Map\(\)/, '分离作业表必须在模块作用域');
assert.match(server, /action === 'diarize' && req\.method === 'POST'/, 'diarize POST 路由');
assert.match(server, /action === 'diarize' && req\.method === 'GET'/, 'diarize GET 轮询');
assert.match(server, /action === 'realign-full-apply' && req\.method === 'POST'/, 'SRT 应用路由');
assert.match(server, /job\.status !== 'done'/, '只有完成的重校对才能应用');
assert.match(server, /sourceFormat: j\.sourceFormat/, '作业要把来源格式带回前端');

/* ── 进度卡跟随主题（浅色主题下不能是一块写死的黑卡） ── */
const jobCardRule = /#job-card \{[\s\S]*?\n\}/.exec(css);
assert.ok(jobCardRule, '找到 #job-card 规则');
assert.match(jobCardRule[0], /background: var\(--surface\)/, '进度卡背景必须用主题 surface');
assert.doesNotMatch(jobCardRule[0], /rgba\(22, 24, 31/, '进度卡不能写死深色背景');

/* ── 长任务要能停止、退出时不能留孤儿 Python ── */
assert.match(server, /action === 'realign-full-cancel' && req\.method === 'POST'/, '有停止重校对接口');
assert.match(server, /action === 'diarize-cancel' && req\.method === 'POST'/, '有停止说话人分离接口');
assert.match(server, /job\.estSec/, '分离作业带预计时长/心跳');
assert.match(main, /diarize-cancel/, '前端停止按钮会调分离取消接口');
assert.match(main, /预计约/, '长音频确认框给出预计耗时');
assert.match(server, /killAllProjProcs\(\)/, '退出时收掉所有项目长任务');
assert.match(server, /trackProjProc\(prep\.meta\.id, p\)/, '对齐 worker 要登记进 projProcs');
assert.match(server, /SUBFABRIC_PARENT_WATCH/, 'worker 要带父进程存活看护');
assert.match(main, /realign-full-cancel/, '前端停止按钮会调取消接口');

console.log('advanced-actions-test: ok（确认入口 / SRT 标记 / 分离接线 / 模板一致 / 主题与取消）');
