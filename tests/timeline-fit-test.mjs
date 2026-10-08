/**
 * 验证「载入稿件后时间轴铺满全片」。
 *
 * 修的是一个**看起来像识别坏了**的显示问题：时间轴原来一律用 DEFAULT_SPAN = 30s
 * 作为初始视图，于是打开几十分钟的稿子时，只有开头 30 秒内的字幕落在视野里，
 * 其余都在视野右侧之外 —— 用户看到的是"字幕全挤在前几秒"，会以为 ASR 出了问题
 * （数据一直是对的：实测 asr.json / ASS / rows 跨度都是 3416s）。
 *
 * Timeline 依赖 canvas/DOM，没法整体实例化，所以把纯逻辑函数抄出来按同规则验证，
 * 并断言源码里那三个关键点仍在（防回退）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = fs.readFileSync(path.join(REPO, 'editor', 'js', 'timeline.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

const DEFAULT_SPAN = 30;
const W = 1200;

/** 与 timeline.js 的 _contentRange 同规则 */
const contentRange = (duration, subEnd) => {
  const end = Math.max(duration || 0, subEnd || 0);
  return end > 0 ? { a: 0, b: end, span: end } : null;
};

/** 与 _applyDefaultView 同规则（含 _fitOnLoad 分支）；返回 {mode, pxPerSec, viewStart} */
function applyDefaultView({ duration, subEnd, w, fitOnLoad }) {
  const r = contentRange(duration, subEnd);
  if (!r || w <= 0) return null;
  if (fitOnLoad && r.span > DEFAULT_SPAN) {
    return { mode: 'fit', pxPerSec: w / Math.max(0.2, r.span), viewStart: r.a };
  }
  return {
    mode: 'default',
    pxPerSec: w / Math.max(0.2, Math.min(DEFAULT_SPAN, r.span)),
    viewStart: r.a,
  };
}

const visibleSpan = (r) => W / r.pxPerSec;

console.log('== 长稿子（57 分钟）：铺满全片，而不是只看前 30 秒 ==');
let r = applyDefaultView({ duration: 3428, subEnd: 3416, w: W, fitOnLoad: true });
ok(r.mode === 'fit', '走 fit', r.mode);
ok(r.viewStart === 0, '视图从 0 开始', r.viewStart);
ok(visibleSpan(r) >= 3428 - 1e-6, '可见范围 ' + visibleSpan(r).toFixed(0) + 's >= 3428s');

console.log('\n== 用户报的那个（236 秒）==');
r = applyDefaultView({ duration: 236, subEnd: 228.5, w: W, fitOnLoad: true });
ok(r.mode === 'fit', '走 fit', r.mode);
ok(visibleSpan(r) >= 236 - 1e-6, '可见范围 ' + visibleSpan(r).toFixed(0) + 's >= 236s');

console.log('\n== 很短的稿子（< 30s）：保持原有默认行为 ==');
r = applyDefaultView({ duration: 12, subEnd: 12, w: W, fitOnLoad: true });
ok(r.mode === 'default', '走默认', r.mode);
ok(Math.abs(r.pxPerSec - W / 12) < 1e-9, '跨度取 min(30, 12) = 12', r.pxPerSec);

console.log('\n== 边界与健壮性 ==');
r = applyDefaultView({ duration: 0, subEnd: 228.5, w: W, fitOnLoad: true });
ok(r && r.mode === 'fit', '视频时长未知但字幕有范围 -> 仍可 fit', r && r.mode);
ok(applyDefaultView({ duration: 0, subEnd: 0, w: W, fitOnLoad: true }) === null,
  '完全没有范围 -> 不动视图（等下次 setLanes）');
ok(applyDefaultView({ duration: 236, subEnd: 0, w: 0, fitOnLoad: true }) === null,
  '宽度为 0 -> 不动视图');
r = applyDefaultView({ duration: 30, subEnd: 30, w: W, fitOnLoad: true });
ok(r.mode === 'default', '恰好 30s -> 不算"长"，走默认（不会无意义地 fit）', r.mode);

console.log('\n== 源码关键点仍在（防回退）==');
// 用 lastIndexOf 找**方法定义**：indexOf 会命中注释/调用点（实测踩过）
const resetDef = SRC.lastIndexOf('resetView() {');
const flagSet = SRC.indexOf('this._fitOnLoad = true');
ok(resetDef > 0 && flagSet > resetDef && flagSet - resetDef < 900,
  'resetView 的定义里设了 _fitOnLoad = true');
const defDef = SRC.lastIndexOf('_applyDefaultView() {');
const branch = SRC.indexOf('if (this._fitOnLoad)', defDef);
ok(defDef > 0 && branch > defDef && branch - defDef < 900,
  '_applyDefaultView 的定义里有 _fitOnLoad 分支');
ok(/const DEFAULT_SPAN = 30/.test(SRC), 'DEFAULT_SPAN 仍是 30（短视频与未知时长仍用它）');
// 不能是"每次重绘都强行 fit" —— 那会打掉用户的手动缩放
ok(!/tick\(\)[\s\S]{0,200}?this\.fit\(\)/.test(SRC), 'fit 没有被放进每帧循环');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
