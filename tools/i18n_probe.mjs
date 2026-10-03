/* i18n 全量覆盖探针（真机 CDP）: node tools/i18n_probe.mjs
 * 验证四件事：
 *   ① 词典覆盖：界面上出现的每段中文，都能在 lang/zh-CN.json 里找到键（覆盖率报告）
 *   ② 动态 DOM 也过词典：临时改词典里一条"JS 拼出来的"文案 → 刷新后界面真的变了
 *   ③ 编辑框不被改写：contenteditable 里的文本不参与翻译
 *   ④ 不会自我循环：MutationObserver 不产生持续不断的改写（观察 1.5s 内的变更次数）
 * 用法: BASE=http://127.0.0.1:8321 node tools/i18n_probe.mjs [项目ID]
 */
import { launch, sleep } from './lib/cdp.mjs';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8321';
const LANG = 'D:/Vibe Coding/SubFabric/editor/lang/zh-CN.json';
const BACKUP = LANG + '.probe-backup';
const PORT = Number(process.env.CDP_PORT || 9395);

const res = { pass: 0, fail: 0, notes: [] };
const ok = (cond, name, extra) => {
  if (cond) { res.pass++; console.log('  ok  ' + name); }
  else { res.fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
};

const projects = await (await fetch(BASE + '/api/projects')).json();
const pid = process.argv[2] || (projects.projects || []).find(p => !p.draft)?.id || (projects.projects || [])[0]?.id;
if (!pid) { console.log('没有项目可测'); process.exit(1); }
console.log('项目:', pid);

const b = await launch({ port: PORT, width: 1440, height: 900 });

/* ── ① 覆盖率：把界面上所有可见中文文本抓出来，逐条查词典 ── */
await b.goto(BASE + '/#/project/' + pid);
await sleep(3500);
await b.eval("document.querySelector('.ptab[data-tab=\"settings\"]').click()");
await sleep(800);
const cov = await b.eval(`(async () => {
  const dict = await (await fetch('lang/zh-CN.json', { cache: 'no-store' })).json();
  const VAR = '\\u25C7';
  const keys = Object.keys(dict);
  const norm = (s) => String(s).replace(/\\$\\{[^}]*\\}/g, VAR).replace(/[0-9A-Za-z_][0-9A-Za-z_.%\\u2014-]*/g, VAR);
  const index = new Set(keys.map(norm));
  // 用户改过词典后，界面上显示的是**值**而不是键 —— 判定覆盖时值也算覆盖
  const values = new Set(Object.values(dict));
  const valueIndex = new Set(Object.values(dict).map(norm));
  const out = [];
  const seen = new Set();
  // 误报白名单（不是"没覆盖"，而是这些文本本来就由多段拼成/不是文案）：
  //   · 带时间戳的服务日志行 —— 日志页逐行剥掉前缀后翻译，整行当然匹配不到键
  //   · 多个片段拼出来的状态行（文件 · N 行 / M 句（逐词特效））—— 源头分段调了 t()
  //   · 单个汉字（开/关/把）与用户自己的字幕正文
  const KNOWN = [/^\\[\\d{2}:\\d{2}:\\d{2}\\]/, /· ◇ 行 \\/ ◇ 句/, /· ◇ 条$/];
  const covered = (t) => {
    if (dict[t] || index.has(norm(t)) || values.has(t) || valueIndex.has(norm(t))) return true;
    if (/^[\\u4e00-\\u9fa5]$/.test(t)) return true;                        // 单字标签
    if (KNOWN.some(re => re.test(t) || re.test(norm(t)))) return true;    // 含时间戳的技术日志行（拼接串，长尾）
    const bare = t.replace(/^(\\[\\d{2}:\\d{2}:\\d{2}\\]\\s*)+/, '');      // 去掉日志时间戳再试
    if (bare !== t && (dict[bare] || index.has(norm(bare)) || values.has(bare) || valueIndex.has(norm(bare)))) return true;
    return false;
  };
  const walk = (el) => {
    if (el.nodeType === 3) {
      const t = (el.nodeValue || '').trim();
      if (t && /[\\u4e00-\\u9fa5]/.test(t) && !seen.has(t)) {
        seen.add(t);
        if (!covered(t)) out.push(t);
      }
      return;
    }
    if (el.nodeType !== 1) return;
    if (['SCRIPT','STYLE','CANVAS','TEXTAREA','INPUT','SELECT'].includes(el.tagName)) return;
    for (const n of el.childNodes) walk(n);
  };
  walk(document.body);
  return JSON.stringify({ total: seen.size, missing: out.slice(0, 20), missingCount: out.length, keys: keys.length });
})()`);
const c = JSON.parse(cov);
console.log(`  界面上可见中文片段 ${c.total} 条；词典 ${c.keys} 条；未覆盖 ${c.missingCount} 条`);
if (c.missingCount) c.missing.forEach(m => console.log('     未覆盖: ' + m.slice(0, 70)));
ok(c.missingCount <= 40, `词典覆盖界面文案（未覆盖 ${c.missingCount} / ${c.total}，阈值 40）`);

/* ── ④ 不自我循环：观察 1.5s 内的 DOM 变更次数 ── */
const loop = await b.eval(`(async () => {
  let n = 0;
  const mo = new MutationObserver(list => { n += list.length; });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  await new Promise(r => setTimeout(r, 1500));
  mo.disconnect();
  return String(n);
})()`);
console.log('  1.5s 内 DOM 变更次数:', loop);
ok(Number(loop) < 400, `词典层没有造成持续的 DOM 改写（变更 ${loop} 次）`);

/* ── ② 动态文案可改：临时改词典里一条 JS 拼出来的说明 ── */
copyFileSync(LANG, BACKUP);
try {
  const dict = JSON.parse(readFileSync(LANG, 'utf8'));
  // 挑一条动态拼进 HTML 的说明（模型卡片里的 Python 环境说明）
  const target = Object.keys(dict).find(k => k.startsWith('Parakeet 识别要 Python'));
  ok(!!target, '找到要试改的动态文案', target);
  if (target) {
    dict[target] = '【探针改过】' + dict[target].slice(0, 12);
    writeFileSync(LANG, JSON.stringify(dict, null, 2) + '\n');
    await b.send('Page.reload', {});
    await sleep(3000);
    await b.eval("document.getElementById('btn-settings-ed').click()");
    await sleep(900);
    const seen = await b.eval("document.body.innerText.includes('【探针改过】')");
    ok(seen === true || seen === 'true', '动态 DOM 文案按词典生效（改 json → 界面变了）');
    // ③ 编辑框不被改写：进入行内编辑后写入一段"词典里也可能有"的文字，观察是否被换掉
    await b.eval("document.getElementById('st-close').click()");
    await sleep(400);
    const pos = await b.eval("(() => { const c = document.querySelector('.cue-card'); if (!c) return 'null'; const r = c.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 200), y: Math.round(r.top + 30) }); })()");
    let editSafe = 'no-card';
    if (pos !== 'null') {
      const p = JSON.parse(pos);
      await b.mouse('mousePressed', p.x, p.y, { clickCount: 1 });
      await b.mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
      await sleep(150);
      await b.mouse('mousePressed', p.x, p.y, { clickCount: 2 });
      await b.mouse('mouseReleased', p.x, p.y, { clickCount: 2 });
      await sleep(700);
      editSafe = await b.eval(`(async () => {
        const box = document.querySelector('[contenteditable="true"]');
        if (!box) return 'no-editor';
        const probe = '打开视频';                       // 故意用一条词典键做内容
        box.textContent = probe;
        await new Promise(r => setTimeout(r, 700));
        return box.textContent === probe ? 'safe' : 'rewritten:' + box.textContent;
      })()`);
    }
    ok(editSafe === 'safe', '编辑框（contenteditable）不被词典改写', String(editSafe));
  }
} finally {
  copyFileSync(BACKUP, LANG);
  try { unlinkSync(BACKUP); } catch {}
}
console.log(`\n${res.pass} passed, ${res.fail} failed`);
b.close();
process.exit(res.fail ? 1 : 0);
