/**
 * 「日志」页两个板块的回归。
 *
 * 用户反馈"日志栏什么都没有"。查下来是两件事叠加：
 *   ① server.js 只包装了 console.log / console.error，**console.warn 从没包** ——
 *      warn 级信息从来没进过日志页；
 *   ② 服务端本身日志就稀疏（启动 + 识别/翻译/导出），空面板又没有任何说明，
 *      看着就像功能坏了。
 * 另外顺手加了「用户操作日志」（谁改了什么、为什么），它踩过一个更隐蔽的坑：
 *   读写辅助定义在模块作用域、却要用 handleRequest 内部的 projDir()，
 *   每次调用都 ReferenceError，被 catch 吞成 `written: 0` —— 只表现为"写不进去"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
const RB = fs.readFileSync(path.join(REPO, 'editor', 'realign-batch.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO, 'editor', 'studio.html'), 'utf8');
const MJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
const PJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'studio.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== 1. console.warn 也要进日志 ==');
ok(/console\.warn = \(\.\.\.a\) =>[\s\S]{0,90}pushLog\('warn', a\)/.test(SRV),
  'console.warn 已被包装并推入日志缓冲');
ok(/_cWarn = console\.warn\.bind\(console\)/.test(SRV), '保留原始 warn（仍打到控制台）');
ok(/\.log-warn\s*\{/.test(CSS), '日志页有 warn 级配色');

console.log('\n== 2. 日志页分成三个板块（操作 / 运行 / 备注）==');
for (const id of ['log-sub-app', 'log-sub-op', 'log-sub-note',
                  'log-pane-app', 'log-pane-op', 'log-pane-note',
                  'log-view', 'oplog-view', 'note-view',
                  'log-empty', 'oplog-empty', 'note-empty',
                  'btn-oplog-refresh', 'btn-log-clear', 'btn-note-refresh']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
// 默认显示「操作日志」—— 用户的诉求是"记录我对字幕的修改"，那栏放第一个且默认展开。
// （旧版默认显示运行日志；改成操作日志优先是刻意的。）
ok(/id="log-pane-op">/.test(HTML) && !/id="log-pane-op" hidden/.test(HTML),
  '★ 操作日志默认显示（它记的是"我改了什么"，用户最想看）');
ok(/id="log-pane-app" hidden/.test(HTML), '运行日志默认隐藏');
ok(/id="log-pane-note" hidden/.test(HTML), '备注默认隐藏');
// 高亮必须跟默认内容一致：操作日志显示时，子标签高亮也必须在操作日志上。
ok(/class="log-subtab active"[^>]*id="log-sub-op"/.test(HTML), '★ 默认高亮操作日志');
ok(!/class="log-subtab active"[^>]*id="log-sub-app"/.test(HTML), '运行日志默认不高亮');
ok(/data-log="app"/.test(HTML) && /data-log="op"/.test(HTML) && /data-log="note"/.test(HTML),
  '三个子标签都在');
ok(/\.log-subtab\.active/.test(CSS), '子标签有选中态样式');
ok(/\.log-pane\s*\{[^}]*flex: 1/.test(CSS), '面板能撑满剩余高度（否则内层滚动区拿不到高度）');

console.log('\n== 3. 空状态必须给说明（这是"什么都没有"的观感来源）==');
ok(/id="log-empty"/.test(HTML) && /暂时没有运行日志/.test(HTML), '运行日志空时有说明');
ok(/id="oplog-empty"/.test(HTML) && /还没有操作记录/.test(HTML), '操作日志空时有说明');
ok(/const syncEmpty = \(\) => \{ if \(empty\) empty\.hidden = view\.childElementCount > 0; \}/.test(MJ),
  '有日志时自动隐藏空状态');
ok(/\.log-empty\[hidden\] \{ display: none; \}/.test(CSS), '隐藏规则在');

console.log('\n== 4. 操作日志：服务端读写 ==');
// ⚠ 必须与 projDir 同作用域（历史上跨作用域引用 → 每次调用 ReferenceError，
//    被 catch 吞成 written: 0）。2026-10-10 路由重构后 projDir/appendOpLog/opLogPath
//    全在模块作用域 —— 断言改为"模块级 + 同域"，跨域坑从此结构上不可能再出现。
const hIdx = SRV.indexOf('function handleRequest(');
const appendIdx = SRV.indexOf('function appendOpLog(');
const projDirIdx = SRV.indexOf('function projDir(');
ok(appendIdx > 0 && appendIdx < hIdx, 'appendOpLog 定义在模块作用域（不再是 handleRequest 内部）');
ok(/const opLogPath = \(id\) => path\.join\(projDir\(id\), 'oplog\.json'\)/.test(SRV),
  '落盘到 projects/<id>/oplog.json');
ok(projDirIdx > 0 && projDirIdx < hIdx, 'projDir 也在模块作用域（appendOpLog/opLogPath 与它同域，无跨域 ReferenceError）');
ok(/function readOpLog\(id\)/.test(SRV), '有读函数');
ok(/return \{ ok: false, err \};/.test(SRV), '写失败返回**原因**（不是静默 false）');
ok(/errors: errs/.test(SRV), '接口把错误带出来，便于排查"written: 0"');
ok(/renameSync\(p \+ '\.tmp', p\)/.test(SRV), '原子替换（不留半截文件）');
ok(/while \(list\.length > OP_LOG_MAX\) list\.shift\(\)/.test(SRV), '有上限，超了丢最旧的');
ok(/action === 'oplog'/.test(SRV), '有 /oplog 路由');

console.log('\n== 5. 操作日志：前端记录了什么 ==');
ok(/function logOp\(action, target, detail, why\)/.test(MJ), '有 logOp(action, target, detail, why)');
ok(/navigator\.sendBeacon/.test(MJ), '用 sendBeacon 发送（页面切走也能发出去）');
ok(/flushOpLog, 1500/.test(MJ), '攒一小批再发（不每次编辑打一次请求）');
ok(/visibilitychange[\s\S]{0,80}flushOpLog/.test(MJ), '页面隐藏前把攒的发掉');
ok(/OP_ACTION_LABEL/.test(MJ), '动作名有中文标签');
// 各动作都接了
for (const act of ['realign', 'split', 'merge', 'delete', 'retranslate', 'reflect']) {
  ok(new RegExp(`logOp\\('${act}'`).test(MJ), `接了 logOp('${act}')`);
}
/* why 里要带**依据**，否则事后没法复盘 —— 这是"为什么"这个需求的核心。
 * realign 的依据现在是 Qwen3-ForcedAligner（文本已确认，不需要锚点率）。 */
ok(/切点取第 \$\{k\}\/\$\{totW\} 个词的词间中点/.test(MJ), '分句记录了切点依据');
ok(/两行本是同一句/.test(MJ), '合并说明了原因');

console.log('\n== 6. 重排设置（Qwen3 纯对齐）==');
/* 2026-10-22 产品定义：realign 的前提是文本已确认正确，只需要精确时间。
 * 因此不再跑 ASR、不再用锚点率/置信度决定“文本对不对”，只调用 Qwen3-ForcedAligner。
 * 文本不确定的情况交给独立的「重新识别」。 */
ok(!/id="st-realign-minratio"/.test(HTML) && !/id="st-realign-minconf"/.test(HTML),
  '★ 设置页不再有 ASR 重排的锚点率/置信度输入');
ok(!/id="st-realign-note"/.test(HTML), '★ 不再有 ASR 重排的设置说明节点');
ok(!/id="realign-conf"|id="realign-conf-thr"/.test(HTML),
  '★ 全片预览不再有置信度门槛');
ok(/Qwen3-ForcedAligner/.test(HTML), '设置页说明使用 Qwen3 对齐器');
ok(!/pathname === '\/api\/asr\/realign-settings'/.test(SRV),
  '★ 已删除 realign-settings 接口（不再有阈值设置）');
ok(!/\/api\/asr\/realign-settings/.test(PJ), '★ 前端不再请求 realign-settings');
ok(!/st-realign-minratio|st-realign-minconf|st-realign-voice|st-realign-rate/.test(PJ),
  '★ 前端不再绑定旧 realign 设置/TTS 控件');

/* 新契约：只走 Qwen3 对齐器；ASR 重识别只属于「重新识别」功能。 */
ok(/function realignPrep\(/.test(SRV), '有 realignPrep');
ok(/qwen3-forced-aligner-0\.6b-q8_0\.gguf/.test(SRV), '★ Vulkan 对齐器文件已接');
ok(/qwen3-asr-1\.7b.*aligner|aligner.*qwen3-asr-1\.7b/s.test(SRV), '★ CUDA 对齐器目录已接');
ok(/realignAlignBatch/.test(SRV), '有批量对齐入口');
ok(/qwen_align\.py/.test(SRV), '★ CUDA 走独立 qwen_align.py');
ok(/--align-only/.test(SRV) && /crispAlignOnly/.test(SRV), '★ Vulkan 走 CrispASR --align-only');
ok(!/async function realignOne/.test(SRV), '★ 已删除 realignOne（不再逐句 ASR）');
ok(!/async function realignRecognize/.test(SRV), '★ 已删除 realignRecognize');
ok(!/async function realignTwoTier/.test(SRV), '★ 已删除热词第二级');
ok(!/REALIGN_MODEL_ID/.test(SRV), '★ 不再固定 NPU ASR 模型');
ok(/realignBatchMod\.planBatches/.test(SRV), '服务端用批量分段模块');
ok(/minAnchorRatio: 0, rawTimes: true/.test(RB),
  '★ 只做序列映射，不再用锚点率拒绝；rawTimes=true 保留实测绝对时间');
ok(!/threshold: 0|job\.threshold|r\.threshold/.test(SRV), '★ 作业不再返回采纳门槛');
ok(/const cudaReady = qwenRuntimeOk\(\)/.test(SRV), 'CUDA 对齐器有运行时门禁');
/* 逐词映射随批量对齐抽到 editor/realign-batch.js；整段和逐行都走 planBlock，
 * 防止以后重构退回"直接把模型词时间写进字幕"。 */
ok(/const whole = align\.planBlock\(b\.text/.test(RB)
  && /const plan = align\.planBlock\(m\.text/.test(RB),
  '对齐器结果仍经过 planBlock 做 token 映射/单调性修正');

console.log('\n== 7. ★ 字幕自动保存必须能成功（丢字幕的真凶）==');
{
  // 原断言绑定临时文件参数和旧响应形状，版本保存升级后改为实际 HTTP 行为。
  const { isolatedServer } = await import('./helpers/isolated-server.mjs');
  const s = await isolatedServer();
  try {
    const dir = path.join(s.root, 'projects/p-log-save'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'subtitle.srt');
    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nold\n');
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-log-save', subtitle: { file: 'subtitle.srt' } }));
    const url = '/api/projects/p-log-save/subtitle';
    const revision = (await s.call(url)).headers.get('etag').replaceAll('"', '');
    const text = '1\n00:00:01,000 --> 00:00:02,000\nupdated\n';
    const saved = await s.call(url + '?revision=' + revision, { method: 'PUT', body: text });
    const body = await saved.json();
    ok(saved.status === 200 && body.ok && /^[a-f0-9]{64}$/.test(body.revision), '完整提交后回应 200 与新稿件版本');
    ok(fs.readFileSync(file, 'utf8') === text && await (await s.call(url)).text() === text, '响应成功时磁盘和重载内容都是完整新稿件');
    const stale = await s.call(url + '?revision=' + revision, { method: 'POST', body: 'stale' });
    ok(stale.status === 409 && !!(await stale.json()).error, '过期补存明确返回冲突');
    ok(fs.readFileSync(file, 'utf8') === text, '冲突保留已经保存的新稿件');
  } finally { await s.close(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
