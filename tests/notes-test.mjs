/**
 * 备注弹幕的回归。
 *
 * 用户要求（三条，都要钉住）：
 *   ① 播放时备注作为**置顶弹幕**实时显示
 *   ② 持续跟随播放时长约 **2~5 秒**
 *   ③ **暂停时不消失**
 *
 * 第 ③ 条最容易在重构里被破坏 —— 只要有人写成"每帧重算 + 过期就清"，
 * 暂停后 timeupdate 再跑一次就会把它抹掉。所以这里用"闩住"模型并单独测它。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const D = await import(pathToFileURL(path.join(REPO, 'editor', 'danmaku.js')).href);

const SRV = fs.readFileSync(path.join(REPO, 'editor', 'server.js'), 'utf8');
const MJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO, 'editor', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'editor', 'css', 'style.css'), 'utf8');
const PJ = fs.readFileSync(path.join(REPO, 'editor', 'js', 'project.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

console.log('== 1. 停留时长限定在 2~5 秒 ==');
{
  ok(D.DUR_MIN === 2 && D.DUR_MAX === 5, '范围就是 2~5 秒', [D.DUR_MIN, D.DUR_MAX]);
  ok(D.danmakuDuration({ danmaku: 3 }) === 3, '正常值原样返回');
  ok(D.danmakuDuration({ danmaku: 99 }) === 5, '超上限夹到 5');
  ok(D.danmakuDuration({ danmaku: 0.1 }) === 2, '低于下限夹到 2');
  ok(D.danmakuDuration({ danmaku: 'x' }) === 2.5, '非法值 → 默认 2.5');
  ok(D.danmakuDuration(null) === 2.5, 'null → 默认 2.5');
  ok(D.danmakuDuration({}) === 2.5, '缺字段 → 默认 2.5');
}

console.log('\n== 2. 到点显示、过期不显示 ==');
{
  const notes = [{ id: 'a', at: 10, danmaku: 3, text: 'A' }];
  ok(D.pickDanmaku(notes, 9.9, null) === null, '还没到 → 不显示');
  ok(D.pickDanmaku(notes, 10, null) === notes[0], '刚到点 → 显示');
  ok(D.pickDanmaku(notes, 12.9, null) === notes[0], '窗口内 → 显示');
  ok(D.pickDanmaku(notes, 13.1, null) === null, '超过停留时长 → 不显示');
  // 时长可调，窗口随之变化
  ok(D.pickDanmaku([{ id: 'b', at: 10, danmaku: 5 }], 14.9, null) !== null, '时长设为 5 秒时窗口更长');
  ok(D.pickDanmaku([{ id: 'b', at: 10, danmaku: 2 }], 12.5, null) === null, '时长设为 2 秒时窗口更短');
}

console.log('\n== 3. ★ 暂停时不消失 ==');
{
  /* 模拟真实播放：播到 11.0 显示 → 用户**暂停**（位置不再变化）→
   * 之后每一次 timeupdate 都拿同一个位置去判定，必须一直显示同一条。 */
  const notes = [{ id: 'a', at: 10, danmaku: 2.5, text: 'A' }];
  let cur = null;
  cur = D.pickDanmaku(notes, 9.0, cur);            // 还没到
  ok(cur === null, '播放中：未到点 → 无弹幕');
  cur = D.pickDanmaku(notes, 11.0, cur);           // 到了
  ok(cur && cur.id === 'a', '播放中：到点 → 显示');
  // 暂停：位置冻结在 11.0，模拟后续多次 timeupdate
  let stayed = true;
  for (let i = 0; i < 20; i++) {
    const next = D.pickDanmaku(notes, 11.0, cur);
    if (!next || next.id !== 'a') stayed = false;
    cur = next;
  }
  ok(stayed, '暂停后连续 20 次判定都保持显示（不消失）');
  // 即使"暂停"时长超过了停留窗口也不该消失 —— 位置没变，窗口就没走完
  ok(D.pickDanmaku(notes, 11.0, cur) !== null, '暂停很久（位置不变）仍然显示');
  // 恢复播放、播过窗口 → 才消失
  ok(D.pickDanmaku(notes, 13.0, cur) === null, '恢复播放并播过窗口 → 消失');
  ok(D.keepOnPause() === true, 'keepOnPause() 明确返回 true（约定写在代码里了）');
}

console.log('\n== 4. 多条备注：取"最近到点的那条" ==');
{
  const notes = [
    { id: 'a', at: 10, danmaku: 5, text: 'A' },
    { id: 'b', at: 12, danmaku: 5, text: 'B' },
    { id: 'c', at: 20, danmaku: 5, text: 'C' },
  ];
  ok(D.pickDanmaku(notes, 11, null).id === 'a', '11s → a（b 还没到）');
  ok(D.pickDanmaku(notes, 13, null).id === 'b', '13s → b（比 a 更晚且仍在窗口内）');
  ok(D.pickDanmaku(notes, 19, null) === null, '19s → 都没了（c 还没到）');
  ok(D.pickDanmaku(notes, 21, null).id === 'c', '21s → c');
  // 倒序传入也要对（调用方不该依赖顺序）
  ok(D.pickDanmaku(notes.slice().reverse(), 13, null).id === 'b', '乱序传入结果一致');
}

console.log('\n== 5. 边界 ==');
{
  ok(D.pickDanmaku([], 10, null) === null, '没有备注 → null');
  ok(D.pickDanmaku(null, 10, null) === null, 'notes 为 null → null');
  ok(D.pickDanmaku([{ id: 'a', at: 10 }], NaN, null) === null, '位置非法 → null');
  ok(D.pickDanmaku([{ id: 'a', at: 'x' }], 10, null) === null, '备注位置非法 → 跳过');
  ok(D.pickDanmaku([{ id: 'a', at: 0, danmaku: 3 }], 0, null) !== null, '第 0 秒的备注也能显示');
  // 同一条备注的 id 稳定，才不会被判成"换了条"而重绘
  const n = { id: 'same', at: 5, danmaku: 3 };
  ok(D.pickDanmaku([n], 6, n) === n, '窗口内返回同一个对象（不触发重绘）');
  /* ★ Number(null) === 0 是个**有限数** —— 早期写成 Number(n && n.danmaku) 时，
   *   n 为 null 会短路成 null，再变成 0，于是那条备注的窗口宽度是 0、永远不显示。 */
  ok(D.danmakuDuration(null) === 2.5, '★ null 不能变成 0（Number(null)===0 的陷阱）');
  ok(D.danmakuDuration(undefined) === 2.5, 'undefined → 默认');
  ok(D.danmakuDuration({ danmaku: null }) === 2.5, '字段为 null → 默认（不是 0）');
}

console.log('\n== 6. 接线（前端/服务端/样式/菜单图标）==');
{
  // 重排逐词时间的菜单图标
  const ICONS = fs.readFileSync(path.join(REPO, 'editor', 'js', 'icons.js'), 'utf8');
  ok(/^\s*wand:/m.test(ICONS), 'icons.js 里有 wand 图标');
  ok(/^\s*chat:/m.test(ICONS), 'icons.js 里有 chat 图标');
  ok((HTML.match(/data-act="realign" data-ico="wand"/g) || []).length === 2,
    '两个右键菜单的「重排逐词时间」都带 wand 图标');

  // 输入条在视频与时间轴之间
  const iTl = HTML.indexOf('id="timeline-panel"');
  const iBar = HTML.indexOf('id="note-bar"');
  const iHead = HTML.indexOf('class="tl-head"', iTl);
  ok(iTl > 0 && iBar > iTl && iBar < iHead, '备注输入条在 #timeline-panel 内、时间轴头部之前');
  for (const id of ['note-input', 'note-at', 'note-dur', 'btn-note-send', 'cb-danmaku']) {
    ok(new RegExp(`id="${id}"`).test(HTML), `有 #${id}`);
  }
  // 弹幕层贴在 #video-stage 里，且不吃指针事件（绝不能挡视频控件）
  const iStage = HTML.indexOf('id="video-stage"');
  const iDmk = HTML.indexOf('id="danmaku-layer"');
  ok(iDmk > iStage, '弹幕层在 #video-stage 内');
  ok(/#danmaku-layer\s*\{[^}]*pointer-events:\s*none/.test(CSS), '弹幕层 pointer-events:none（不挡控件）');
  ok(/#danmaku-layer\s*\{[^}]*top:\s*0/.test(CSS), '弹幕层贴顶（"置顶弹幕"）');

  // 备注列表在日志栏
  ok(/data-log="note"/.test(HTML), '日志页有「备注列表」板块');
  ok(/id="log-pane-note"/.test(HTML) && /id="note-view"/.test(HTML), '备注列表面板与容器都在');
  ok(/note: document\.getElementById\('log-pane-note'\)/.test(MJ), '子标签切换认识 note 面板');

  // 服务端
  ok(/action === 'notes'/.test(SRV), '有 /notes 路由');
  ok(/readNotes|writeNotes/.test(SRV), '有读/写函数');
  ok(/notesPath = \(id\) => path\.join\(projDir\(id\), 'notes\.json'\)/.test(SRV),
    '落盘 projects/<id>/notes.json');
  ok(/DUR_MIN = 2, DUR_MAX = 5/.test(SRV), '服务端也把停留时长夹在 2~5 秒');
  ok(/text\.length > 2000/.test(SRV), '备注有长度上限');
  ok(/NOTES_MAX = 1000/.test(SRV), '备注条数有上限');

  // 前端使用了抽出来的纯逻辑
  ok(/import \{ pickDanmaku/.test(MJ), 'main.js 复用 danmaku.js 的判定');
  ok(/pickDanmaku\(notes, t0, showing\)/.test(MJ), 'tickDanmaku 用 pickDanmaku');
  ok(/addEventListener\('timeupdate', tickDanmaku\)/.test(MJ), '跟随播放进度（timeupdate）');
  ok(/addEventListener\('seeked', \(\) => \{ hideDanmaku\(\); tickDanmaku\(\); \}\)/.test(MJ),
    '拖动后清掉旧弹幕再重算（否则拖到别处还挂着上一条）');
  // 切项目要重载备注，否则会把上一个项目的备注当弹幕放出来
  ok(/__notesReload/.test(PJ), '切项目时重载备注');
  // 右下角日志页承接操作记录
  ok(/logOp\('note'/.test(MJ), '写备注也记进操作日志');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
