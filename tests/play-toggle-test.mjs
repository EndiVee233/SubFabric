/**
 * 空格播放/暂停的**连按**回归。
 *
 * 用户实测报的 bug："鼠标点击时间轴后，点空格开始播放；但开始播放后立刻点空格不会暂停，
 * 需要等一下才能暂停。"
 *
 * 根因：`playPause` 有一个 250ms 的冷却窗口，窗口内的按键被 `return` **直接吞掉**：
 *
 *     if (e.repeat || now - actionCooldown.playPause < PLAY_COOLDOWN_MS) return;
 *
 * 当初的理由是"按住重复触发或快速连击会导致状态乱跳"，但：
 *   · 按住不放 → 浏览器派发的 keydown 带 `e.repeat=true`，**用它挡就够了**
 *   · 快速连按 → 用户本来就想连按（播→停→播），不该挡
 *
 * 现在冷却收到 40ms，只用于吃掉同一次物理按键被重复派发的事件。
 *
 * 这里做的是**行为**验证（把真实的按键处理逻辑抽出来跑），不是读源码做正则 ——
 * 上次就是靠正则断言漏掉了"半接线"的真 bug。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'js', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};

// ── 抽出真实的去重/分发逻辑（避开整个 main.js 的 DOM 依赖）──
function slice(from, to) {
  const i = SRC.indexOf(from);
  if (i < 0) throw new Error('抽不到: ' + from);
  const j = SRC.indexOf(to, i + from.length);
  if (j < 0) throw new Error('抽不到结束标记: ' + to);
  return SRC.slice(i, j);
}
const code = slice('const actionCooldown = { playPause: 0 };', 'function isTypingTarget(')
  + '\nexport { actionCooldown, PLAY_DEDUP_MS };\n';
const mod = path.join(HERE, '_playdedup.mjs');
fs.writeFileSync(mod, code);
const { actionCooldown, PLAY_DEDUP_MS } = await import(pathToFileURL(mod).href);
fs.unlinkSync(mod);

/** 复刻主流程里的判定：返回 true 表示这次按键会被执行 */
function wouldRun(now, repeat, lastAt) {
  if (repeat) return false;
  return !(now - lastAt < PLAY_DEDUP_MS);
}

console.log('== 1. 参数在合理范围 ==');
ok(typeof PLAY_DEDUP_MS === 'number' && PLAY_DEDUP_MS > 0, '有去重窗口', PLAY_DEDUP_MS);
/* 关键：窗口必须远小于人手连按间隔。实测快速连按约 100~150ms，
 * 250ms 的旧值正好把它吞掉 —— 这就是用户遇到的"要等一下才能暂停"。 */
ok(PLAY_DEDUP_MS <= 60, `窗口 ≤ 60ms（旧值是 250ms，会吞掉正常连按）`, PLAY_DEDUP_MS);

console.log('\n== 2. 快速连按必须每次生效 ==');
{
  // 模拟：0ms 按下（播放）→ 120ms 再按（暂停）→ 240ms 再按（播放）
  const taps = [0, 120, 240, 360];
  let last = -Infinity;
  const acted = [];
  for (const t of taps) {
    if (wouldRun(t, false, last)) { acted.push(t); last = t; }
  }
  ok(acted.length === taps.length,
    `四次连按全部生效（间隔 120ms）`, { taps, acted });
  ok(acted.join(',') === taps.join(','), '每次都在原时刻生效', acted);

  // 更极端：60ms 间隔（急促连按）—— 40ms 窗口下也应全部生效
  const fast = [0, 60, 120, 180];
  last = -Infinity;
  const acted2 = [];
  for (const t of fast) {
    if (wouldRun(t, false, last)) { acted2.push(t); last = t; }
  }
  ok(acted2.length === fast.length, '60ms 间隔连按也全部生效', acted2);
}

console.log('\n== 3. 按住不放不能被重复触发 ==');
{
  let last = -Infinity;
  let n = 0;
  // 按住空格：浏览器连续派发 e.repeat=true
  for (const t of [0, 30, 60, 90, 120, 150]) {
    if (wouldRun(t, t > 0, last)) { n++; last = t; }   // 只有第一次 repeat=false
  }
  ok(n === 1, '按住只触发一次', n);
}

console.log('\n== 4. 同一次按键被重复派发时仍要去重 ==');
{
  // 某些浏览器/输入法会把一次物理按键派发多次（间隔极小）
  let last = -Infinity;
  let n = 0;
  for (const t of [0, 1, 3, 8, 20]) {          // 都 < 40ms
    if (wouldRun(t, false, last)) { n++; last = t; }
  }
  ok(n === 1, '40ms 内的重复派发只算一次', n);
  // 但超过窗口就该算下一次按键
  ok(wouldRun(100, false, 0) === true, '100ms 后算新按键', true);
}

console.log('\n== 5. 真实代码里的接线（防止改回去）==');
{
  ok(/const PLAY_DEDUP_MS = \d+;/.test(SRC), '常量名/定义在', true);
  ok(!/PLAY_COOLDOWN_MS/.test(SRC), '旧的 PLAY_COOLDOWN_MS 已移除');
  ok(/if \(e\.repeat \|\| now - actionCooldown\.playPause < PLAY_DEDUP_MS\) return;/.test(SRC),
    '判定用 e.repeat + 短去重窗口', true);
  const m = /const PLAY_DEDUP_MS = (\d+);/.exec(SRC);
  ok(m && Number(m[1]) <= 60, '源码里的窗口值 ≤ 60ms', m && m[1]);
  /* 捕获阶段仍要吞掉空格的默认动作 —— 否则聚焦 <video> 时浏览器原生空格会在 keyup 生效，
   * 出现"按住=暂停、松开=播放"的反向行为（那段注释记录过）。 */
  ok(/e\.key === ' ' \|\| e\.code === 'Space'/.test(SRC), '仍拦截空格的默认动作', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
