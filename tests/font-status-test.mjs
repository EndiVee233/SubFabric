/* 改字体名之后的「三态反馈」回归 —— 需要**真实应用页**（要用 #ass-style-status
 * 与 #ass-style-*-font-note 这些元素），所以单独一个文件。
 *   node tests/font-status-test.mjs
 *
 * 钉住的 bug：
 *   onFontNameChange 先写「正在查找本机字体「X」…」，却**只在
 *   ensureSystemFont 返回 'loaded' 时**更新成"已载入"。而打开稿件时
 *   autoLoadSystemFonts 已经把样式里用到的字体载进内存了 —— 用户再手动改字体名
 *   时走的是 `isFontAvailable → true` 那条路、返回 **'present'**（不是 'loaded'），
 *   两个 if 都不成立，状态就**永远停在"正在查找…"**（实测卡 6 秒以上不动）。
 *   用户的感受正是「英文字幕字体没法调节，只会和中文字幕保持一致」。
 *
 * 三种结果都必须有明确文案：
 *   present → 已切换为「X」（该字体已在预览里可用）
 *   loaded  → 已从本机字体库载入「X」
 *   missing → 字段下方警告"本机没装 → 预览会回退"（refreshFontNotes 写）
 */
'use strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SUBFABRIC_BASE || 'http://127.0.0.1:8321';
const PID = process.env.SUBFABRIC_FONT_PID || 'p-muzokbdd-cdds5';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
};
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

let svc = null;
try { svc = await (await fetch(BASE + '/api/version', { signal: AbortSignal.timeout(4000) })).json(); } catch {}
if (!svc) { console.log('  (跳过：本地服务没在跑)'); done(); }

const PORT = 9865;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefst-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-sync', '--disable-background-networking', '--disable-component-update',
  '--disable-extensions', '--window-size=1500,1000',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  `${BASE}/editor/index.html?debug#/project/${PID}`,
], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let u = null;
for (let i = 0; i < 60 && !u; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) u = p.webSocketDebuggerUrl;
  } catch {}
  if (!u) await sleep(500);
}

try {
  const ws = new WebSocket(u);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 160));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (m, p) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const js = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200) };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await sleep(14000);

  ok(await js("!!document.getElementById('ass-style-zh-font')"), '应用页加载成功');

  const origZh = await js("document.getElementById('ass-style-zh-font').value");
  const origEn = await js("document.getElementById('ass-style-en-font').value");
  console.log('  项目原字体: 中文=%s 英文=%s', origZh, origEn);

  const change = (which, name) => js(`(async function(){
    var el = document.getElementById('ass-style-${which}-font');
    var st = document.getElementById('ass-style-status');
    el.value = ${JSON.stringify(name)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    var last = '';
    for (var i = 0; i < 20; i++) {
      await new Promise(function(x){ setTimeout(x, 400); });
      last = String(st.textContent || '');
      if (last && !/正在查找/.test(last)) break;
    }
    var note = document.getElementById('ass-style-${which}-font-note');
    return { status: last, stuck: /正在查找/.test(last), value: el.value,
             note: note ? String(note.textContent||'') : '',
             noteCls: note ? note.className : '' };
  })()`);

  console.log('\n== ① present：改成当前已在内存的字体（bug 就在这里）==');
  {
    const r = await change('zh', origZh);
    console.log('  状态: %s', r && r.status);
    ok(r && !r.stuck, '★ 不再卡在「正在查找本机字体…」', r && r.status);
    ok(r && /(已切换为|已从本机字体库载入)/.test(r.status), '给出了明确结果', r && r.status);
  }

  console.log('\n== ② loaded：换成本机装了、但还没载入的字体 ==');
  {
    const r = await change('en', 'Georgia');
    console.log('  状态: %s', r && r.status);
    ok(r && !r.stuck, '不卡住', r && r.status);
    ok(r && /(载入|已切换为)/.test(r.status), '给出了明确结果', r && r.status);
  }

  console.log('\n== ③ missing：本机没装的字体 ==');
  {
    const r = await change('en', 'NoSuchFont XYZ 123');
    console.log('  状态栏  : %s', r && r.status);
    console.log('  字段提示: %s  [%s]', r && r.note, r && r.noteCls);
    ok(r && !r.stuck, '状态栏不卡住', r && r.status);
    ok(r && r.value === 'NoSuchFont XYZ 123', '手打的名字仍写进输入框', r && r.value);
    ok(r && /没装/.test(r.note) && /回退/.test(r.note),
      '★ 字段下方说清"本机没装、预览会回退"（最容易误判成没生效）', r && r.note);
    ok(r && /warn/.test(r.noteCls), '用警告色', r && r.noteCls);
  }

  console.log('\n== ④ 装了的字体：字段提示应当是"已载入" ==');
  {
    const r = await change('en', origEn || 'Comic Sans MS');
    console.log('  字段提示: %s  [%s]', r && r.note, r && r.noteCls);
    ok(r && /已载入/.test(r.note), '★ 提示"预览已载入该字体"', r && r.note);
    ok(r && /\bok\b/.test(r.noteCls), '用正常色', r && r.noteCls);
  }

  console.log('\n== ⑤ 中英两轨独立 ==');
  {
    const zhBefore = await js("document.getElementById('ass-style-zh-font').value");
    await change('en', 'Georgia');
    const zhAfter = await js("document.getElementById('ass-style-zh-font').value");
    ok(zhBefore === zhAfter, '★ 改英文字体不会连带改中文字体', { zhBefore, zhAfter });
  }

  /* 还原：测试改了用户项目的字体，必须放回去 */
  console.log('\n== ⑥ 还原项目原字体 ==');
  {
    await change('zh', origZh);
    await change('en', origEn);
    const nowZh = await js("document.getElementById('ass-style-zh-font').value");
    const nowEn = await js("document.getElementById('ass-style-en-font').value");
    ok(nowZh === origZh && nowEn === origEn, '★ 中英文都还原成原值（不留脏数据）', { origZh, origEn, nowZh, nowEn });
  }

  ok(errs.length === 0, '浏览器无未捕获异常', errs.slice(0, 3));
  try { ws.close(); } catch {}
} finally {
  try { child.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
done();
