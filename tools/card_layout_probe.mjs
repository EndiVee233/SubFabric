/* 首页卡片几何探针（只读）:
 *   ① 主栏**填满**徽标与按钮之间的空间: mainW + badgeW + actionsW + 2*gap == cardW（±1.5px）
 *      —— 用户报的"两张都 100% 的卡片条一长一短"就是因为 .pc-main 没有 flex, 栏宽跟着内容(项目名长度)走
 *   ② **按钮个数相同**的卡片, 主栏(以及进度条轨道)宽度一致（±1px）—— 这是用户那个场景的直接复现
 *   ③ 100% 的卡片: 填充宽度 == 轨道宽度
 *   ④ 主栏左边缘对齐 */
import { launch, sleep } from './lib/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8356';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };

const b = await launch({ port: 9424, width: 1440, height: 900 });
try {
  await b.goto(BASE + '/');
  await sleep(3000);
  const cards = JSON.parse(await b.eval(`(() => JSON.stringify(Array.from(document.querySelectorAll('.proj-card')).map(c => {
    const track = c.querySelector('.pc-draft-bar'), inner = c.querySelector('.pc-draft-bar-in'), main = c.querySelector('.pc-main');
    const badge = c.querySelector('.pc-badge'), actions = c.querySelector('.pc-actions');
    const num = c.querySelector('.pc-draft-txt .pct');
    const r = (e) => e ? e.getBoundingClientRect() : null;
    const W = (e) => e ? Math.round(r(e).width * 10) / 10 : 0;
    const ccs = getComputedStyle(c);
    const chrome = parseFloat(ccs.paddingLeft) + parseFloat(ccs.paddingRight)
      + Math.abs(parseFloat(ccs.columnGap || ccs.gap) || 0) * 2;   // 内边距 + 两个间隙
    return {
      name: ((c.querySelector('.pc-name') || {}).textContent || '').trim().slice(0, 22),
      hasBar: !!track,
      trackW: W(track), fillW: W(inner), mainW: W(main), badgeW: W(badge), actionsW: W(actions),
      btns: c.querySelectorAll('.pc-actions .btn').length,
      mainX: main ? Math.round(r(main).left * 10) / 10 : null,
      num: num ? String(num.textContent).trim() : null,
      cardW: W(c), chrome: Math.round(chrome * 10) / 10,
    };
  })))()`));

  const withBar = cards.filter(c => c.hasBar);
  console.log('  卡片数:', cards.length, ' 有进度条:', withBar.length);
  for (const c of withBar) console.log(`    ${c.name}  按钮${c.btns}  卡${c.cardW}  主栏${c.mainW}  条${c.trackW}  填充${c.fillW}  ${c.num}`);
  ok(withBar.length >= 2, '至少两张卡片有进度条', withBar.length);

  /* ① 主栏填满 徽标–按钮 之间（加上卡片内边距与两个间隙） */
  const bad = withBar.filter(c => Math.abs((c.badgeW + c.mainW + c.actionsW + c.chrome) - c.cardW) > 2);
  ok(bad.length === 0, '主栏填满徽标与按钮之间的空间（±2px）', JSON.stringify(bad.map(c => [c.name, c.cardW, c.chrome, c.badgeW + c.mainW + c.actionsW])));

  /* ② 按钮数相同的卡 → 主栏与轨道宽度一致 */
  const byBtns = {};
  for (const c of withBar) (byBtns[c.btns] = byBtns[c.btns] || []).push(c);
  for (const [n, arr] of Object.entries(byBtns)) {
    if (arr.length < 2) continue;
    const spread = Math.max(...arr.map(c => c.trackW)) - Math.min(...arr.map(c => c.trackW));
    ok(spread <= 1, `按钮数相同的 ${arr.length} 张卡（${n} 个按钮）轨道宽度一致（±1px）`, arr.map(c => c.name + '=' + c.trackW).join(' / ') + ' 差=' + spread.toFixed(1));
  }

  /* ③ 100% 的卡: 填充 == 轨道 */
  const hundreds = withBar.filter(c => c.num === '100%');
  ok(hundreds.length >= 1, '有 100% 的卡片', hundreds.length);
  ok(hundreds.every(c => Math.abs(c.fillW - c.trackW) <= 1), '100% 的卡片填充 == 轨道', hundreds.map(c => c.fillW + '/' + c.trackW).join(' '));

  /* ④ 左边缘对齐 */
  const xs = withBar.map(c => c.mainX);
  ok(Math.max(...xs) - Math.min(...xs) <= 1, '主栏左边缘对齐', xs.join(' / '));
  await b.shot('D:/Vibe Coding/_t/shots/card-bars.png');
  console.log('  已截图 card-bars.png');
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
