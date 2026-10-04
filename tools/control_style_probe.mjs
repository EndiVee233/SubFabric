/* 控件外观一致性探针：比较两组选择器的 computed style，列出差异。
 *
 * 用途：新页面里的控件（输入框 / 下拉 / 文本域）应当和「全局设置」里的长一样。
 * 肉眼比对容易漏，这里把 background / border / radius / padding / 字体 / focus 环
 * 逐项拉出来做差集，并各截一张「未聚焦 + 聚焦」的图（聚焦那张能看出浏览器默认焦点环
 * 有没有被干掉 —— 没写 outline:none 的控件会露出一圈浅蓝，一眼就能认出来）。
 *
 * 用法: node tools/control_style_probe.mjs [baseUrl] [outDir]
 *   （跑之前先起服务: PORT=8356 node editor/server.js）
 * 选择器对写在下面的 PAIRS 里；需要先跳到某个路由时用 goto 字段。
 * 会自己造/删 tools/lib/fixture.mjs 里的探针项目（详细信息页那条路径需要它）。
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';
import { makeProbeProject, removeProbeProject, FIXTURE_ID } from './lib/fixture.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8356';
const OUT = process.argv[3] || join(tmpdir(), 'control-style-shots');
mkdirSync(OUT, { recursive: true });

/* 逐项比对的属性 —— 挑"看起来不一样"最容易露馅的那些 */
const PROPS = [
  'backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderTopStyle', 'borderTopColor',
  'borderTopLeftRadius', 'borderBottomLeftRadius', 'paddingTop', 'paddingLeft', 'paddingBottom',
  'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'boxSizing',
  'resize', 'outlineStyle', 'outlineWidth', 'boxShadow',
  'width', 'height',
];
/* 这几个由布局决定（flex:1 的控件是 auto，显式全宽的有像素值），
 * 不参与"一致/不一致"判定，只打印出来供参考。 */
const LAYOUT_PROPS = ['width', 'height'];

/* 比对对：a = 工作台里的控件，b = 全局设置里的同款 */
const PAIRS = [
  { id: 'input',   label: '单行输入  np-input  vs  st-input',  goto: '#/new', a: '#np-name', b: '#st-baseurl' },
  { id: 'select',  label: '下拉选择  np-select vs  st-select', goto: '#/new', a: '#np-set-provider', b: '#st-provider' },
  { id: 'area-np', label: '多行文本  新建项目 vs  st-area',    goto: '#/new', a: '#np-set-prompt', b: '#st-prompt' },
  { id: 'area-dt', label: '多行文本  详细信息 vs  st-area',    goto: '#/details/' + FIXTURE_ID, a: '#dt-set-castprompt', b: '#st-prompt' },
];

makeProbeProject();
process.on('exit', () => removeProbeProject());

const page = await launch({ url: BASE + '/editor/index.html', port: 9342, width: 1440, height: 1000 });
await sleep(2600);
// 路由靠 hash 切，先确保落在首页再逐个 goto（深链需要 app 已初始化）
await page.goto(BASE + '/editor/index.html');
await sleep(1800);

/* ⚠ 读 computed style 之前必须先把焦点挪开。
 * focus 会改 border-color / outline / box-shadow，而这些正是我们要比的项。
 * 之前基准控件是"读完之后才截图"，而 shots() 结尾会把元素 focus() 掉，
 * 于是下一轮读同一个选择器（area-np 和 area-dt 共用 #st-prompt）时
 * 读到的是"带着焦点环"的值 —— 假差异。
 *
 * 而且不能只 sleep 一下：焦点环是带 transition 的，blur 之后几百毫秒内
 * box-shadow 还在衰减（曾读到 alpha=0.004 / 宽 0.06px 的残影），照样算差异。
 * 渐近的尾巴还会让"连续两轮采样相等"的判据提前收工，所以干脆把 transition 关掉：
 * 我们比的是终态，两边都在无过渡环境下取值，公平且确定。
 * （注入放在页面入场动画跑完之后，避免影响 fade-up。） */
const NO_TRANS = `(() => {
  if (document.getElementById('__probe_notrans')) return;
  const s = document.createElement('style');
  s.id = '__probe_notrans';
  s.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.appendChild(s);
})()`;

const blurAll = async () => {
  await page.eval('document.activeElement && document.activeElement.blur()');
  await sleep(80);
};

// 入场动画已经跑完，现在关掉过渡再开始量（只注入一次，后续 hash 切换不重载页面）
await page.eval(NO_TRANS);

const READ = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const cs = getComputedStyle(el);
  const o = {};
  for (const p of ${JSON.stringify(PROPS)}) o[p] = cs[p];
  o.__tag = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '');
  return o;
})()`;

const readStyle = async (sel) => { await blurAll(); return page.eval(READ(sel)).catch(() => null); };

const report = [];
const shots = async (sel, tag) => {
  await blurAll();
  await page.shotEl(sel, join(OUT, `${tag}-blur.png`));
  await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.focus(); })()`);
  await sleep(250);
  await page.shotEl(sel, join(OUT, `${tag}-focus.png`));
};

/* 先把基准（全局设置）读一遍 —— #st-prompt 在「字幕翻译」页签里，默认是 hidden，
 * 不切过去的话截图会是空白（computed style 仍可读，但看着不踏实）。 */
await page.eval(`location.hash = '#/settings'`);
await sleep(1500);
await page.eval(`(() => { const t = document.querySelector('.st-tab[data-stp="translate"]'); if (t) t.click(); })()`);
await sleep(600);
const baseStyles = {};
for (const p of PAIRS) {
  baseStyles[p.id] = await readStyle(p.b);
  await shots(p.b, `${p.id}-b`);
}

/* 再逐个跳去工作台读被测控件 */
for (const p of PAIRS) {
  await page.eval(`location.hash = ${JSON.stringify(p.goto)}`);
  await sleep(1600);
  const a = await readStyle(p.a);
  const b = baseStyles[p.id];
  if (!a || !b) {
    report.push({ label: p.label, error: '选择器没找到: ' + JSON.stringify({ a: !!a, b: !!b }) });
    continue;
  }
  const diffs = [], layout = [];
  for (const k of PROPS) {
    if (a[k] === b[k]) continue;
    (LAYOUT_PROPS.includes(k) ? layout : diffs).push({ prop: k, a: a[k], b: b[k] });
  }
  report.push({ label: p.label, aTag: a.__tag, bTag: b.__tag,
                sameCount: PROPS.length - LAYOUT_PROPS.length - diffs.length, diffs, layout });
  await shots(p.a, `${p.id}-a`);
}

for (const r of report) {
  if (r.error) { console.log(`\n✗ ${r.label}\n   ${r.error}`); continue; }
  console.log(`\n${r.diffs.length ? '✗' : '✓'} ${r.label}   [${r.aTag} vs ${r.bTag}]  相同 ${r.sameCount}/${PROPS.length - LAYOUT_PROPS.length}`);
  for (const d of r.diffs) console.log(`    ${d.prop.padEnd(22)} A=${d.a}   B=${d.b}`);
  for (const d of r.layout) console.log(`    (布局, 不计) ${d.prop.padEnd(10)} A=${d.a}   B=${d.b}`);
}
const bad = report.filter((r) => r.error || r.diffs.length).length;
console.log(`\n=== 不一致的控件对: ${bad}/${PAIRS.length} ===`);
console.log('=== 控制台/日志 ===');
console.log(page.logs.length ? page.logs.join('\n') : '(无错误)');
console.log('截图目录:', OUT);

page.close();
process.exit(bad ? 1 : 0);
