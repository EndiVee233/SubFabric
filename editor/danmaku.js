/**
 * 备注弹幕的显示判定（纯逻辑，不碰 DOM）。
 *
 * 抽出来的原因：这段是"跟着播放进度显示、**暂停时不消失**"的核心，
 * 而它恰恰容易写成每帧重算 —— 那样暂停时一旦 timeupdate 又跑一次、
 * 或者窗口刚好走完，弹幕就闪掉了。用户明确要求暂停时**不消失**。
 *
 * 模型（"闩住"而不是重算）：
 *   · 播放位置落在某条备注的 [at, at+停留时长] 窗口内 → 显示它
 *   · 已经显示的这条，只要还在窗口内就**保持不变**（不因为又跑了
 *     timeupdate 而重绘 —— 重绘会重放进入动画，看起来在闪）
 *   · 暂停时位置不再变化，窗口也就不会走完 → 自然**保持显示**
 *   · 拖到别处 → 清掉，等下次进入某条的窗口再显示
 */

/** 一条备注在画面上停留多久（秒）。非法值回退到默认 2.5。 */
const DUR_DEFAULT = 2.5;
const DUR_MIN = 2;
const DUR_MAX = 5;

function danmakuDuration(n) {
  /* ⚠ 不能写 `Number(n && n.danmaku)`：n 为 null 时短路得到 null，
   *   而 Number(null) === 0（是个**有限数**），于是不会走默认分支、
   *   返回 0 —— 那条备注的弹幕窗口宽度就是 0，等于永远不显示。
   *   必须先取出字段、确认它不是 null/undefined/空串。 */
  const raw = (n && typeof n === 'object') ? n.danmaku : undefined;
  if (raw === null || raw === undefined || raw === '') return DUR_DEFAULT;
  const d = Number(raw);
  if (!Number.isFinite(d)) return DUR_DEFAULT;
  return Math.max(DUR_MIN, Math.min(DUR_MAX, d));
}

/**
 * 给定播放位置，决定该显示哪条备注。
 *
 * @param {Array}  notes   全部备注（顺序不限）
 * @param {number} time    当前播放位置（秒）
 * @param {object} current 当前正在显示的那条（没有就 null）
 * @returns {object|null}  该显示的备注；null = 都不显示
 */
function pickDanmaku(notes, time, current) {
  const t = Number(time);
  if (!Number.isFinite(t) || !Array.isArray(notes) || !notes.length) return null;

  // 1) 正在显示的还在窗口内 → 保持不动（关键：暂停时位置不变，就不会走到这里以外）
  if (current) {
    const at = Number(current.at);
    if (Number.isFinite(at) && t >= at && t <= at + danmakuDuration(current)) return current;
  }
  // 2) 找"已到点、且还没过期"里**最晚**的一条
  let best = null;
  for (const n of notes) {
    const at = Number(n && n.at);
    if (!Number.isFinite(at)) continue;
    if (at > t) continue;                              // 还没到
    if (t - at > danmakuDuration(n)) continue;         // 已过期
    if (!best || at > Number(best.at)) best = n;
  }
  return best;
}

/**
 * 暂停时弹幕该不该消失？—— **不该**。这是用户明确的要求
 * （"暂停时不会消失"：停下来正是为了看清它）。
 *
 * 单独写成一个函数是为了把这条约定**钉在测试里**：
 * 谁要是以后加了"暂停就清掉"的逻辑，测试会立刻红。
 */
function keepOnPause() {
  return true;
}

export { danmakuDuration, pickDanmaku, keepOnPause, DUR_DEFAULT, DUR_MIN, DUR_MAX };
