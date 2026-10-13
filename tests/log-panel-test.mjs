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
const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
const MJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
const PJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');

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
 * realign 尤其重要：锚点率决定这次对齐可不可信。 */
ok(/\$\{b\.anchors\}\/\$\{b\.words\.length\} 个词对上/.test(MJ), '重排记录了锚点率作为依据');
ok(/词吻合率 \$\{Math\.round/.test(MJ), '重排记录了词吻合率作为依据');
ok(/切点取第 \$\{k\}\/\$\{totW\} 个词的词间中点/.test(MJ), '分句记录了切点依据');
ok(/两行本是同一句/.test(MJ), '合并说明了原因');

console.log('\n== 6. 重排设置（全局设置里）==');
/* ⚠ 2026-10-12 重写：重校对不再"用 TTS 朗读合成语音、再识别那段合成语音"
 *   （那样得到的逐词时间是按 TTS 节奏**缩放**出来的，不是从原片量出来的），
 *   改成切出该句在**原片音频**里的那一段重新识别。旧的"朗读语音 / 语速"控件与绑定
 *   一并移除；这一节改成钉**新契约**，而且比原来钉得更严（见下面那组 ★）。 */
for (const id of ['st-realign-minratio', 'st-realign-note']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
ok(!/id="st-realign-voice"/.test(HTML) && !/id="st-realign-rate"/.test(HTML),
  '★ TTS 专用的语音/语速控件已移除（新方案不朗读）');
/* ⚠ 这条以前断言的是 `action === 'realign-settings'` —— 即它**钉住了错误的挂载位置**：
 *   服务端把处理块放在 handleProjectsRoutes 里（只能被 /api/projects/<id>/... 命中），
 *   而前端 project.js 调的是 /api/asr/realign-settings → 一律 404（面板读不到、存不了）。
 *   2026-10-11 无头浏览器探针实测抓到这个 404 后把处理块搬回 asr 段。
 *   现在断言"挂在 /api/asr/ 下"，并**交叉核对前端调的是同一个路径** —— 防止再被搬回去。 */
ok(/pathname === '\/api\/asr\/realign-settings'/.test(SRV),
  '有读写接口（挂在 /api/asr/ 下）');
ok(/\/api\/asr\/realign-settings/.test(PJ),
  '★ 前端调的是同一个路径（否则又是一律 404）');
ok(/readAsrSettings\(\)\.realign/.test(SRV), '设置存在 asr/settings.json 的 realign 段');
/* ★ 关键：设置存进去还不够，**必须真的被用**。
 *   第一版就漏了这步 —— minAnchorRatio 存了却从没传给 planBlock，"最低锚点率"是个摆设。 */
ok(/clamp\(rs\.minAnchorRatio, 0\.3, 1, alignMod\.MIN_ANCHOR_RATIO\)/.test(SRV),
  '服务端读取 minAnchorRatio（在 realignPrep 里统一解析）');
ok(/minAnchorRatio: prep\.minAnchorRatio, rawTimes: true \}/.test(SRV),
  '**真的传给了 planBlock**，且 rawTimes=true（用实测时间，不做整体缩放）');
ok(/realignLoad\(\)/.test(PJ), '设置页加载时读取');
ok(!/st-realign-voice|st-realign-rate/.test(PJ), '前端不再绑定已移除的 TTS 控件');
/* ★ 新方案的命门逐条钉住 —— 任何一条错了，逐词时间都会整体偏掉或回到"编的"老路。 */
{
  const a = SRV.indexOf('async function realignOne');
  const b = SRV.indexOf('async function realignRecognize');
  const one = (a >= 0 && b > a) ? SRV.slice(a, b) : '';
  ok(one.length > 0, '找得到 realignOne 的实现');
  ok(/audioSlice\.sliceAudio\(FFMPEG, prep\.audioWav/.test(one),
    '★ 切的是 prep.audioWav（原片音频），不是合成语音');
  ok(!/ttsToWav|ttsText/.test(one), '★ realignOne 里不再出现 TTS');
  ok(/Number\(w\.start\) \+ from/.test(one),
    '★ 切片内的相对时间必须加回切片起点（否则整句平移，且在稿子上看不出来）');
  ok(/if \(r2\.ratio > r\.ratio\)/.test(SRV),
    '★ 第二级必须**更吻合才采纳**（实测热词偏置不稳定，没有闸门就是引入风险）');
  ok(/REALIGN_MODEL_ID = 'parakeet-tdt-0\.6b-v2'/.test(SRV),
    '★ 引擎定到 sherpa-onnx 版 parakeet（热词只有这个后端支持，NPU 会静默忽略）');
}

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
