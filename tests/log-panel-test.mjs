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
 * realign 尤其重要：锚点率决定这次对齐可不可信。
 * ⚠ 文案 2026-10-12 随新方案改：完成提示里原来是 `锚点 ${b.anchors}`（只有分子、没有分母），
 *   看的人判断不了这次对齐可不可信；现在给全 `${b.anchors}/${b.words.length} 个词对上`
 *   并带上**词吻合率**。断言跟着改，别改回单个数。 */
ok(/\$\{b\.anchors\}\/\$\{b\.words\.length\} 个词对上/.test(MJ), '重排记录了锚点率作为依据');
ok(/词吻合率 \$\{Math\.round/.test(MJ), '重排记录了词吻合率作为依据');
/* ⚠ 这里原本还有一条 `重排记录了发音人/语速`（`/发音人 \$\{b\.voice/`）。
 *   它钉的是 **TTS 朗读方案**的日志字段 —— 新方案改成"切出这句在原片音频里的那一段
 *   重新识别"，没有"发音人/语速"可记，所以随那三个控件一起删掉。 */
ok(/切点取第 \$\{k\}\/\$\{totW\} 个词的词间中点/.test(MJ), '分句记录了切点依据');
ok(/两行本是同一句/.test(MJ), '合并说明了原因');

console.log('\n== 6. 重排设置（全局设置里）==');
/* ⚠ 2026-10-12 删掉过时断言：`#st-realign-voice` / `#st-realign-rate` / `#st-realign-rate-val`
 *   属于**旧的 TTS 朗读方案** —— 把台词合成语音、再识别那段合成语音，逐词时间是按 TTS 节奏
 *   **缩放**出来的，不是从原片量出来的。
 *   该方案已改成"切出这句在**原片音频**里的那一段重新识别"，不再朗读，这三个控件随之移除
 *   （它们的绑定与"只列英文语音"也一并没了），所以这里不能再要求它们存在。
 *   新契约（切原片音频 / rawTimes / realignOne 里不得出现 TTS）由正在开发的那条改动
 *   连同实现一起钉住 —— 本文件不重复钉，也不去钉别人的在制品。 */
for (const id of ['st-realign-minratio', 'st-realign-note']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
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
ok(/minAnchorRatio: prep\.minAnchorRatio \}/.test(SRV), '**真的传给了 planBlock**（不是只存不用）');
/* ⚠ 2026-10-12 一并删掉三条 TTS 相关断言：
 *   · `朗读语音默认取设置`（看的是 `voice: … ? o.voice : rs.voice`）
 *   · `语速默认取设置`（看的是 `rate: … : clamp(rs.rate …)`）
 *   · 下面那组里的 `语音下拉只列英文语音` 与 `拖语速时先更新旁边的文字`
 *   理由同上：新方案不朗读，这几个控件/绑定已移除。 */
ok(/realignLoad\(\)/.test(fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8')),
  '设置页加载时读取');

console.log('\n== 7. ★ 字幕自动保存必须能成功（丢字幕的真凶）==');
{
  /* 实测：PUT /api/projects/<id>/subtitle 每次保存都返回 500，
   * 日志里累计 58 次 `[handler error] ... ReferenceError: finish is not defined`。
   * 根因：那版实现引用了作用域里根本不存在的 finish()。
   * 后果：文件其实被写进去了，但前端收到 500 会认为没存上；
   * 用户那边的表现就是"改了半天，稿子莫名其妙缺内容"。
   *
   * 现在这段是**流式落盘**实现（上游版）: finish 在本段内就地定义、req.pipe(out)
   * 是真实接线（out = createWriteStream）。断言按这个形态守，但保留原来的本意:
   * 「不许引用未定义的符号」「成功必须回 200」「失败要明确报错」「原子替换」。
   */
  const i = SRV.indexOf("action === 'subtitle' && (req.method === 'PUT' || req.method === 'POST')");
  ok(i > 0, '找到字幕保存路由');
  // 只看这一段（到下一个 action 判断为止），并**剥掉注释** ——
  // 注释里也会出现 `finish(...)` / `req.pipe(out)` 字样，不剥会误报（实测踩过）。
  const raw = SRV.slice(i, SRV.indexOf("action === 'subtitle' && req.method === 'GET'", i));
  const seg = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const defAt = seg.search(/const\s+finish\s*=\s*\(code, body\)\s*=>/);
  ok(defAt >= 0, 'finish 在本段内有局部定义（不是引用外部符号）');
  const calls = [];
  { const re = /[^\w.$]finish\s*\(/g; let m; while ((m = re.exec(seg))) calls.push(m.index); }
  ok(defAt >= 0 && calls.length > 0 && calls.every(ix => ix > defAt),
    '所有 finish() 调用都在局部定义之后（不再有 "finish is not defined"）');
  ok(/const out = fs\.createWriteStream\(subTmp\)/.test(seg) && /req\.pipe\(out\)/.test(seg),
    '流式落盘接线完整（out 有定义 + req.pipe(out) 是真接线）');
  ok(/finish\(200, \{ ok: true, savedAt: meta\.modifiedAt \}\)/.test(seg),
    '成功时回应 200（sendJson 由 finish 收口）');
  // 写盘失败必须报出来，而不是静默或抛到外层
  ok(/写入失败\(磁盘\/权限\?\)/.test(seg), '写盘失败会返回明确的错误信息');
  ok(/renameSync\(subTmp/.test(seg), '仍是原子替换（打开方读不到半截字幕）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
