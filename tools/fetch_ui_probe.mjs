/* 下载初稿流水线 · 界面真机探针:
 *   ① 新建项目 → 初稿模式 → 出现"链接"输入行
 *   ② 填 bilibili 链接 → 创建按钮变可用 → 点创建
 *   ③ 项目卡片立刻出现且**不是** proj-missing（fetching=true）、阶段显示下载中
 *   ④ 等下载完成: 卡片不再显示"找不到视频"、视频落在项目目录内
 *   ⑤ 设置 → 下载与登录: 保存 Cookie → 接口只回键名不回值（安全断言）→ 清除后回到"未设置"
 * 用完删掉测试项目并把设置恢复原样。 */
import { launch, sleep } from './lib/cdp.mjs';
import { existsSync, readFileSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8360';
const PROJ = process.env.PROJ_DIR || 'D:/Vibe Coding/SubFabric/projects';
const URL = process.env.VIDEO_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7';
let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + extra : '')); } };
const list = async () => (await (await fetch(BASE + '/api/projects')).json()).projects || [];
const settings = async () => await (await fetch(BASE + '/api/fetch/settings')).json();

let id = '';
const b = await launch({ port: 9427, width: 1440, height: 900 });
const orig = await settings();
try {
  await b.goto(BASE + '/');
  await sleep(2500);

  /* ① 对话框 + 链接行 */
  await b.eval("document.getElementById('btn-new-project').click()");
  await sleep(500);
  ok(await b.eval("!document.getElementById('np-overlay').hidden"), '① 新建项目对话框打开了');
  await b.eval("document.getElementById('np-mode-draft').click()");
  await sleep(400);
  ok(await b.eval("!document.getElementById('np-row-url').hidden"), '① 初稿模式出现"链接"输入行');
  ok(await b.eval("document.getElementById('np-url') !== null"), '① #np-url 存在');

  /* ② 填链接 → 按钮可用 */
  const wasDisabled = await b.eval("document.getElementById('np-create').disabled");
  await b.eval(`(() => { const el = document.getElementById('np-url'); el.value = ${JSON.stringify(URL)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(500);
  const nowDisabled = await b.eval("document.getElementById('np-create').disabled");
  console.log('  按钮 disabled:', wasDisabled, '→', nowDisabled);
  ok(nowDisabled === false || nowDisabled === 'false', '② 填了链接后创建按钮可用', nowDisabled);

  /* ③ 点创建 → 卡片立刻出现且不是"找不到视频" */
  await b.eval("document.getElementById('np-create').click()");
  for (let i = 0; i < 20 && !id; i++) {
    await sleep(500);
    const m = (await list()).find((p) => p.fetch && p.fetch.url === URL) || (await list()).find((p) => /BV1GJ411x7h7/.test(p.name || ''));
    if (m) id = m.id;
  }
  ok(!!id, '③ 项目已创建', id);
  if (!id) throw new Error('没创建出项目');
  const l0 = (await list()).find((p) => p.id === id) || {};
  const dom = JSON.parse(await b.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('.proj-card'));
    const c = cards.find(x => /BV1GJ411x7h7|Never Gonna/.test(x.textContent || ''));
    if (!c) return 'null';
    return JSON.stringify({ cls: c.className, text: (c.textContent || '').replace(/\\s+/g, ' ').slice(0, 70), missing: !!c.querySelector('.pc-missing') });
  })()`));
  console.log('  卡片:', JSON.stringify(dom), ' fetching=', l0.fetching, ' stage=', l0.draft && l0.draft.stage);
  ok(!!dom && !/proj-missing/.test(dom.cls), '③ 卡片没有 proj-missing 样式', dom && dom.cls);
  ok(!!dom && !dom.missing, '③ 卡片不显示"找不到这个视频"', dom && dom.text);
  ok(!!l0.fetching, '③ 接口 marking fetching=true', l0.fetching);

  /* ④ 等下载完成 */
  let done = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const p = (await list()).find((x) => x.id === id) || {};
    const st = (p.draft || {}).stage;
    if (st && st !== '下载中') { done = true; break; }
    if ((p.draft || {}).status && (p.draft || {}).status !== 'running') break;
  }
  const meta = await (await fetch(BASE + '/api/projects/' + id)).json();
  const vpath = (meta.video && meta.video.path) || '';
  ok(done, '④ 离开了"下载中"阶段', (meta.draft || {}).stage);
  ok(!!vpath && vpath.replace(/\\/g, '/').includes('/' + id + '/'), '④ 视频落在项目目录内', vpath);
  ok(!!vpath && existsSync(vpath), '④ 视频文件存在', vpath);
  ok(existsSync(`${PROJ}/${id}/source.json`), '④ source.json 已写出');
  const dom2 = await b.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('.proj-card'));
    const c = cards.find(x => /BV1GJ411x7h7|Never Gonna/.test(x.textContent || ''));
    return c ? (c.querySelector('.pc-missing') ? 'has-missing' : 'ok') : 'no-card';
  })()`);
  ok(dom2 === 'ok', '④ 下载完后卡片也没有"找不到视频"', dom2);

  /* ⑤ 设置: Cookie 只写不读回 */
  await b.eval("document.getElementById('st-overlay').hidden = true; document.getElementById('btn-settings').click()");
  await sleep(1200);
  await b.eval("document.querySelector('.st-tab[data-stp=\"fetch\"]').click()");
  await sleep(400);
  ok(await b.eval("document.querySelector('.st-panel[data-stp=\"fetch\"]').classList.contains('active')"), '⑤ 切到"下载与登录"页签');
  const fake = 'SESSDATA=FAKE_SECRET_12345; bili_jct=abc; DedeUserID=42';
  await b.eval(`(() => { document.getElementById('st-fetch-cookie').value = ${JSON.stringify(fake)}; document.getElementById('st-fetch-cookie-save').click(); })()`);
  await sleep(1200);
  const s1 = await settings();
  console.log('  settings:', JSON.stringify(s1));
  ok(s1.hasBiliCookie === true, '⑤ Cookie 已保存（hasBiliCookie=true）', s1.hasBiliCookie);
  ok((s1.biliCookieKeys || []).includes('SESSDATA'), '⑤ 只回键名', JSON.stringify(s1.biliCookieKeys));
  ok(!JSON.stringify(s1).includes('FAKE_SECRET_12345'), '⑤ 接口里**没有** cookie 值（安全）', JSON.stringify(s1).slice(0, 120));
  const note = await b.eval("document.getElementById('st-fetch-cookie-note').textContent");
  ok(/已保存/.test(note) && !/FAKE_SECRET/.test(note), '⑤ 界面提示不泄露值', note);
  const inputVal = await b.eval("document.getElementById('st-fetch-cookie').value");
  ok(inputVal === '', '⑤ 保存后输入框已清空', JSON.stringify(inputVal));
  await b.eval("document.getElementById('st-fetch-cookie-clear').click()");
  await sleep(1000);
  const s2 = await settings();
  ok(s2.hasBiliCookie === false, '⑤ 清除后 hasBiliCookie=false', s2.hasBiliCookie);
  await b.shot('D:/Vibe Coding/_t/shots/fetch-ui.png');
  console.log('  已截图 fetch-ui.png');
} catch (e) {
  fail++; console.log('FAIL  探针异常: ' + ((e && e.message) || e));
} finally {
  if (id) { try { await fetch(BASE + '/api/projects/' + id, { method: 'DELETE' }); console.log('已删除测试项目'); } catch {} }
  try { await fetch(BASE + '/api/fetch/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: orig.quality, proxy: orig.proxy, cookiesFromBrowser: orig.cookiesFromBrowser, biliCookie: '' }) }); console.log('设置已恢复'); } catch {}
  b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
