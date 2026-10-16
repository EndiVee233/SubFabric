// 验收设计稿 ②「模型设置 · 可折叠 + 硬件感知」：
//   · 本机硬件条只显示**探测到**的硬件（不谎报），右侧计数与模型列表同源
//   · 模型列表按系列分组、可折叠，且折叠状态在重画（下载轮询）后**不丢**
//   · 分组标题的箭头图标注入成功
//   · 分组内每行仍有下载/删除按钮（抽取 modelRowHtml 后没弄丢）
//
// 用法: node tools/verify_model_groups.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9514;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const OUT = process.env.OUT || 'D:\\DSH\\npu-verify\\model-groups';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const profile = mkdtempSync(join(tmpdir(), 'edge-mg-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1500,1000',
  '--force-device-scale-factor=1', `${APP}/editor/studio.html#/settings`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes('8321')) || list.find(t => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到页面'); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable'); await send('Page.enable');
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
  return r?.result?.value;
};
await sleep(7000);

console.log('\n── ① 本机硬件条 ──');
const hw = await evalJS(`(() => {
  const box = document.getElementById('st-hardware');
  if (!box) return JSON.stringify({ err: 'no #st-hardware' });
  return JSON.stringify({
    text: box.textContent.replace(/\\s+/g, ' ').trim(),
    chips: [...box.querySelectorAll('.hw-chip')].map(c => c.textContent.trim()),
    okChips: [...box.querySelectorAll('.hw-chip.ok')].map(c => c.textContent.trim()),
    right: (box.querySelector('.hw-right') || {}).textContent || '',
    hasCapIcon: !!box.querySelector('.hw-cap svg'),
  });
})()`);
console.log('   ', hw);
const HW = JSON.parse(hw);
if (HW.err) { console.log('  ✗ ' + HW.err); ws.close(); edge.kill(); process.exit(1); }
ok(HW.okChips.length >= 1, `至少识别出一项加速硬件（${HW.okChips.join(' / ')}）`);
ok(!/未检测到/.test(HW.text) || HW.okChips.length === 0, '硬件条不会同时说"未检测到"又有可用项');
ok(/已安装 \d+ \/ \d+/.test(HW.right), `右侧给出装/总计数（${HW.right}）`);
ok(HW.hasCapIcon, '「本机硬件」前的小图标已注入');

console.log('\n── ② 按系列分组 ──');
const grp = await evalJS(`(() => {
  const box = document.getElementById('st-models');
  const gs = [...box.querySelectorAll('.sm-group')];
  return JSON.stringify({
    groups: gs.map(g => ({
      fam: g.dataset.family,
      name: (g.querySelector('.sm-group-name') || {}).textContent,
      count: (g.querySelector('.sm-group-count') || {}).textContent,
      ready: (g.querySelector('.sm-group-ready') || {}).textContent,
      rows: g.querySelectorAll('.sm-model').length,
      open: !g.querySelector('.sm-group-body').hidden,
      caretSvg: !!g.querySelector('.sm-caret svg'),
    })),
    totalRows: box.querySelectorAll('.sm-model').length,
    dlBtns: box.querySelectorAll('.sm-dl').length,
    delBtns: box.querySelectorAll('.sm-del').length,
    /* 分组之外的 .sm-model 是**固定卡**（Python 环境 / 说话人分离 / NeMo 运行时 /
       重新识别模型）—— 它们复用同一个 .sm-model 外观类，但不在"按系列分组"的范围内。
       这里按卡片名把它们排除掉，剩下的才应该是 0。 */
    fixedCards: [...box.querySelectorAll('.sm-model')]
      .filter(r => !r.closest('.sm-group'))
      .map(r => (r.querySelector('.sm-name') || {}).textContent || '(无名)'),
    strayModelRows: [...box.querySelectorAll('.sm-model')]
      .filter(r => !r.closest('.sm-group'))
      .filter(r => !/环境|分离|运行时|重新识别/.test((r.querySelector('.sm-name') || {}).textContent || ''))
      .length,
    groupedRows: [...box.querySelectorAll('.sm-group .sm-model')].length,
  }, null, 1);
})()`);
console.log(grp);
const G = JSON.parse(grp);
ok(G.groups.length >= 2, `模型被分成 ${G.groups.length} 个系列`, JSON.stringify(G.groups.map(g => g.fam)));
ok(G.strayModelRows === 0, '没有游离在分组之外的**识别模型**行',
  JSON.stringify(G.fixedCards));
ok(G.groups.every(g => g.rows > 0), '每个分组都有模型行', JSON.stringify(G.groups.map(g => g.rows)));
ok(G.groups.every(g => /个模型/.test(g.count)), '分组标题显示了模型数量');
ok(G.groups.every(g => g.caretSvg), '每个分组的折叠箭头都注入了');
ok(G.dlBtns + G.delBtns > 0, `每行的下载/删除按钮仍在（下载 ${G.dlBtns} / 删除 ${G.delBtns}）`);
// 分组内的识别模型数应等于服务端给的模型数（本机 8 个）
ok(G.groupedRows === 8, `分组里正好 8 个识别模型（实际 ${G.groupedRows}）`);

console.log('\n── ③ 折叠 + 折叠状态在重画后不丢 ──');
const col = await evalJS(`(async () => {
  const box = document.getElementById('st-models');
  const g = box.querySelector('.sm-group');
  const fam = g.dataset.family;
  const head = g.querySelector('.sm-group-head');
  head.click();
  await new Promise(r => setTimeout(r, 120));
  const afterCollapse = { hidden: g.querySelector('.sm-group-body').hidden, aria: head.getAttribute('aria-expanded'),
                          caretOpen: !!head.querySelector('.sm-caret.open') };
  // 触发一次重画（等价于下载进度轮询）：切走再切回来会重渲染
  document.querySelector('.st-tab[data-stp="enhance"]').click();
  document.querySelector('.st-tab[data-stp="models"]').click();
  await new Promise(r => setTimeout(r, 1500));
  const g2 = [...document.querySelectorAll('#st-models .sm-group')].find(x => x.dataset.family === fam);
  const afterRedraw = g2 ? { hidden: g2.querySelector('.sm-group-body').hidden,
                             aria: g2.querySelector('.sm-group-head').getAttribute('aria-expanded') } : null;
  // 展开回去
  if (g2) g2.querySelector('.sm-group-head').click();
  await new Promise(r => setTimeout(r, 120));
  const g3 = [...document.querySelectorAll('#st-models .sm-group')].find(x => x.dataset.family === fam);
  return JSON.stringify({ fam, afterCollapse, afterRedraw, afterExpand: g3 ? g3.querySelector('.sm-group-body').hidden : null });
})()`);
console.log('   ', col);
const C = JSON.parse(col);
ok(C.afterCollapse.hidden === true && C.afterCollapse.aria === 'false', '点击标题能收起该分组');
ok(C.afterCollapse.caretOpen === false, '收起后箭头转成朝右');
ok(C.afterRedraw && C.afterRedraw.hidden === true, '重画之后折叠状态**没有丢**（仍是收起）', JSON.stringify(C.afterRedraw));
ok(C.afterExpand === false, '再点一次能展开');

console.log('\n── ④ 截图 ──');
const clip = await evalJS(`(() => { const b = document.querySelector('.st-body').getBoundingClientRect();
  return JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }); })()`);
if (typeof clip === 'string') {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
  if (r?.data) { writeFileSync(OUT + '.png', Buffer.from(r.data, 'base64')); console.log('   ' + OUT + '.png'); }
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
