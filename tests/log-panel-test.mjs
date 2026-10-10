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
// ⚠ 必须定义在 handleRequest 内部（要用 projDir）
const hIdx = SRV.indexOf('function handleRequest(');
const appendIdx = SRV.indexOf('function appendOpLog(');
ok(appendIdx > 0 && appendIdx > hIdx, 'appendOpLog 定义在 handleRequest 之后（内部）');
ok(/const opLogPath = \(id\) => path\.join\(projDir\(id\), 'oplog\.json'\)/.test(SRV),
  '落盘到 projects/<id>/oplog.json');
// 反向断言：模块作用域里不许再有直接调 projDir 的定义
const beforeHandle = SRV.slice(0, hIdx);
ok(!/function appendOpLog/.test(beforeHandle), '模块作用域里没有 appendOpLog（那会 ReferenceError）');
ok(!/const opLogPath/.test(beforeHandle), '模块作用域里没有 opLogPath');
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
ok(/锚点 \$\{b\.anchors\}\/\$\{b\.words\.length\}/.test(MJ), '重排记录了锚点率作为依据');
ok(/发音人 \$\{b\.voice/.test(MJ), '重排记录了发音人/语速');
ok(/切点取第 \$\{k\}\/\$\{totW\} 个词的词间中点/.test(MJ), '分句记录了切点依据');
ok(/两行本是同一句/.test(MJ), '合并说明了原因');

console.log('\n== 6. 重排设置（全局设置里）==');
for (const id of ['st-realign-voice', 'st-realign-rate', 'st-realign-rate-val',
                  'st-realign-minratio', 'st-realign-note']) {
  ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
}
ok(/action === 'realign-settings'/.test(SRV), '有读写接口');
ok(/readAsrSettings\(\)\.realign/.test(SRV), '设置存在 asr/settings.json 的 realign 段');
/* ★ 关键：设置存进去还不够，**必须真的被用**。
 *   第一版就漏了这步 —— minAnchorRatio 存了却从没传给 planBlock，"最低锚点率"是个摆设。 */
ok(/clamp\(rs\.minAnchorRatio, 0\.3, 1, alignMod\.MIN_ANCHOR_RATIO\)/.test(SRV),
  '服务端读取 minAnchorRatio（在 realignPrep 里统一解析）');
ok(/minAnchorRatio: prep\.minAnchorRatio \}/.test(SRV), '**真的传给了 planBlock**（不是只存不用）');
ok(/voice: String\(\(o\.voice !== undefined \? o\.voice : rs\.voice\)/.test(SRV),
  '朗读语音默认取设置');
ok(/rate: Number\.isFinite\(Number\(o\.rate\)\) \? Number\(o\.rate\) : clamp\(rs\.rate/.test(SRV),
  '语速默认取设置');
ok(/realignLoad\(\)/.test(fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8')),
  '设置页加载时读取');
{
  const PJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');
  // 语音下拉要只列英文：TTS 是拿英文台词去念的，中文/日文声音念英文会糊
  ok(PJ.includes('/^en/i.test(String(vo.culture'), '语音下拉只列英文语音');
  ok(/if \(rate\) rate\.addEventListener\('input'/.test(PJ), '拖语速时先更新旁边的文字');
}

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
