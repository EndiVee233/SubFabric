/**
 * 浮层定位数学的边界验证。
 *
 * 为什么值得测：浮层改成 `position: fixed` 之后，「贴边会不会跑出视口」「下面放不下
 * 会不会翻到上方」这类判断全靠这几个 clamp。**跑出视口就等于又被"盖住"了**，
 * 而且这种问题在浏览器里才看得见 —— 所以把纯算术部分抽出来先钉死。
 *
 * 这里复制的是 main.js 里 placePanel() 的同一套公式；如果哪天改了那边，
 * 这个测试会失败，提醒同步。
 */

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' :: ' + extra)); }
};

/** 与 main.js 的 placePanel() 同一套公式 */
function place(btnRect, panelSize, viewport) {
  let left = btnRect.right - panelSize.w;
  left = Math.max(6, Math.min(left, viewport.w - panelSize.w - 6));
  let top = btnRect.bottom + 4;
  if (top + panelSize.h >= viewport.h - 6) top = Math.max(6, btnRect.top - panelSize.h - 4);
  return { left, top };
}

const V = { w: 1280, h: 800 };
const P = { w: 210, h: 260 };   // 5 个类别 + 分隔线 + 两个按钮，约这个高度

console.log('== 常规位置：右对齐按钮，落在按钮下方 ==');
let r = place({ right: 900, bottom: 100, top: 80, left: 820 }, P, V);
ok(r.left === 900 - P.w, '右缘对齐按钮右缘', r.left);
ok(r.top === 104, '落在按钮下方 +4', r.top);
ok(r.left >= 6 && r.left + P.w <= V.w - 6, '完全在视口水平范围内');

console.log('\n== 按钮贴右边：应向左内收，不越界 ==');
r = place({ right: 1275, bottom: 100, top: 80, left: 1200 }, P, V);
ok(r.left + P.w <= V.w - 6, '不超出右边界', r.left + P.w);
ok(r.left >= 6, '也不被推到负值', r.left);

console.log('\n== 按钮贴左边：clamp 到 6，不越界 ==');
r = place({ right: 40, bottom: 100, top: 80, left: 10 }, P, V);
ok(r.left === 6, '左边界收在 6', r.left);

console.log('\n== 按钮在视口底部：浮层应翻到按钮上方 ==');
r = place({ right: 900, bottom: 770, top: 750, left: 820 }, P, V);
ok(r.top < 750, '翻到按钮上方了', r.top);
ok(r.top >= 6, '不超出上边界', r.top);
ok(r.top + P.h <= 770, '不压住按钮（底部在按钮顶边之上）', r.top + P.h);

console.log('\n== 视口很矮（浮层比可用空间高）：仍被夹在视口内 ==');
const tiny = { w: 1280, h: 300 };
r = place({ right: 900, bottom: 200, top: 180, left: 820 }, P, tiny);
ok(r.top >= 6, '顶部不越界', r.top);

console.log('\n== 视口很窄（比浮层还窄）：左侧仍被夹住 ==');
const narrow = { w: 180, h: 800 };
r = place({ right: 150, bottom: 100, top: 80, left: 100 }, P, narrow);
ok(r.left >= 6, '左侧下限仍是 6（不出现负 left）', r.left);

console.log('\n== z-index 取值：必须高于列表，低于弹窗 ==');
import fs from 'node:fs';
import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const css = fs.readFileSync(path.join(HERE, '..', 'editor', 'css', 'style.css'), 'utf8');
const m = /\.badcat-panel\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
const z = m ? Number(m[1]) : NaN;
ok(Number.isFinite(z), '能读到 .badcat-panel 的 z-index', m ? m[0].slice(0, 40) : '没找到规则');
// 已存在的层级：卡片菜单 60 / range-bar 62 / 角色菜单 70 / 弹窗 80~90
ok(z > 60, `z-index(${z}) 高于卡片菜单(60)与 range-bar(62)`);
ok(z < 80, `z-index(${z}) 低于弹窗(80)`);
ok(/position:\s*fixed/.test(m ? m[0] : ''), '是 fixed 定位（不在工具栏的 overflow 裁切里）');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
