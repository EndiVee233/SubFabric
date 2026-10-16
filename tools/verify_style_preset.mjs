// 验收「ASS 双语样式：导出/导入预设」的真界面路径（真页面 + 真稿件 + 真点击）。
// 纯逻辑另有单测 tests/ass-style-preset-test.mjs；这里只管**接线**：
//   按钮在不在、点了会不会真的下载那串 JSON、导入后样式有没有落到稿件与面板上。
//
// 手法说明：导出不落盘 —— 临时替换 window.Blob 把内容截下来，再点按钮（不依赖下载目录）。
//
// 用法: node tools/verify_style_preset.mjs [项目id]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9400;
const APP = process.env.APP_URL || 'http://127.0.0.1:8321';
const PROJ = process.argv[2] || 'p-mv3bl3ln-jn2nr';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? '   ' + x : '')); } };

const detail = await (await fetch(`${APP}/api/projects/${PROJ}`)).json();
if (!detail?.subtitle) { console.log('该项目没有字幕文件'); process.exit(1); }
console.log('项目:', detail.name, '| 字幕:', detail.subtitle);

const profile = mkdtempSync(join(tmpdir(), 'edge-sp-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1500,1000', `${APP}/editor/studio.html#/project/${PROJ}`,
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
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
const pageErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') pageErrors.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.text || 'exception');
});
const evalJS = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
  return r?.result?.value;
};

await sleep(5000);

console.log('\n── 1. 面板里有这两个按钮吗（先展开设置里的 ASS 双语样式）──');
const btnInfo = await evalJS(`(() => {
  const exp = document.getElementById('ass-style-preset-export');
  const imp = document.getElementById('ass-style-preset-import');
  const file = document.getElementById('ass-style-preset-file');
  const grp = document.getElementById('ass-style-group');
  return JSON.stringify({
    exp: !!exp, imp: !!imp, file: !!file,
    expText: exp ? exp.textContent.trim() : '', impText: imp ? imp.textContent.trim() : '',
    expDisabled: exp ? exp.disabled : null, impDisabled: imp ? imp.disabled : null,
    groupDisabledClass: grp ? grp.classList.contains('ass-style-disabled') : null,
  });
})()`);
console.log('   按钮状态:', btnInfo);
const b = JSON.parse(btnInfo);
ok(b.exp && b.imp && b.file, '三个元素都在 DOM 里');
ok(b.expText.length > 0 && b.impText.length > 0, `按钮有文案（${b.expText} / ${b.impText}）`);
ok(b.groupDisabledClass === false, '稿件是双语 ASS，样式组已启用（不是 disabled 状态）');
ok(b.expDisabled === false && b.impDisabled === false, '两个按钮都没被禁用');

console.log('\n── 2. 点「导出样式预设…」：应下载一份合法预设 JSON ──');
const exported = await evalJS(`(async () => {
  // 截住 Blob 内容：不依赖下载目录，也不需要 CDP 的下载行为
  const origBlob = window.Blob;
  let captured = null, capturedName = null;
  window.Blob = function (parts, opts) { captured = parts.join(''); return new origBlob(parts, opts); };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { capturedName = this.download || null; };
  try {
    document.getElementById('ass-style-preset-export').click();
    await new Promise(r => setTimeout(r, 300));
  } finally {
    window.Blob = origBlob;
    HTMLAnchorElement.prototype.click = origClick;
  }
  return JSON.stringify({ name: capturedName, text: captured });
})()`);
const ex = JSON.parse(exported);
ok(!!ex.text, '导出确实产生了内容', exported.slice(0, 120));
ok(/\.style-preset\.json$/.test(String(ex.name)), `下载文件名带 .style-preset.json（${ex.name}）`);
let preset = null;
try { preset = JSON.parse(ex.text); } catch { /* 下面报错 */ }
ok(!!preset && preset.kind === 'subfabric.ass-style-preset', '导出内容是本项目的预设格式');
ok(!!(preset && preset.tracks && preset.tracks.zh && preset.tracks.en), '预设里有中英两条轨');
ok(!!(preset && preset.tracks && preset.tracks.zh.values && preset.tracks.zh.values.length > 5),
  '中文轨带完整 Style 字段（不是只有面板那几项）',
  preset && preset.tracks ? String(preset.tracks.zh.values.length) : '');
console.log('   预设摘要:',
  JSON.stringify({
    zh: preset && preset.tracks.zh.styleName, en: preset && preset.tracks.en.styleName,
    fields: preset && preset.tracks.zh.format.length,
    wordColor: preset && preset.wordColor, kBase: preset && preset.kBase, kSweep: preset && preset.kSweep,
  }));

console.log('\n── 3. 把样式改掉，再导入刚才那份预设：应当改回来 ──');
// 先把面板上的中文轨字体/字号改掉（走真实交互：改控件 + 触发 input 事件）
const before = await evalJS(`(async () => {
  const f = document.getElementById('ass-style-zh-font');
  const s = document.getElementById('ass-style-zh-size');
  const old = { font: f.value, size: s.value };
  f.value = '这种字体根本不存在XYZ';
  f.dispatchEvent(new Event('input', { bubbles: true }));
  s.value = '12';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  return JSON.stringify({ old, changed: { font: f.value, size: s.value } });
})()`);
console.log('   改动前后:', before);

const imported = await evalJS(`(async () => {
  const text = ${JSON.stringify(ex.text)};
  const dt = new DataTransfer();
  dt.items.add(new File([text], 'preset.style-preset.json', { type: 'application/json' }));
  const inp = document.getElementById('ass-style-preset-file');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  const f = document.getElementById('ass-style-zh-font');
  const s = document.getElementById('ass-style-zh-size');
  const hint = document.getElementById('ass-style-preset-hint');
  return JSON.stringify({ font: f.value, size: s.value, hint: hint ? hint.textContent.trim() : '' });
})()`);
const im = JSON.parse(imported);
console.log('   导入后面板:', imported);
const orig = JSON.parse(before).old;
ok(im.font === orig.font, `中文字体回到导出时的值（${im.font}）`);
ok(String(im.size) === String(orig.size), `中文字号回到导出时的值（${im.size}）`);
ok(/已导入/.test(im.hint), `面板给出导入回显（${im.hint}）`);

console.log('\n── 4. 导入后稿件里的样式真的变了吗（问服务端要字幕）──');
const assNow = await (await fetch(`${APP}/api/projects/${PROJ}/subtitle`)).text();
const styleLines = assNow.match(/^Style: .+$/gm) || [];
const zhLine = styleLines.find(l => l.includes(orig.font));
ok(!!zhLine, `服务端保存的字幕里出现导出时的字体「${orig.font}」`, styleLines.slice(0, 3).join(' || ').slice(0, 200));
ok(styleLines.length >= 2, `样式行还在（${styleLines.length} 条），没被导入弄丢`);
ok(!assNow.includes('这种字体根本不存在XYZ'), '临时乱填的字体名已经被覆盖掉');

console.log('\n── 5. 坏文件：必须报错且不改动样式 ──');
const junk = await evalJS(`(async () => {
  const before = document.getElementById('ass-style-zh-font').value;
  const dt = new DataTransfer();
  dt.items.add(new File(['{"kind":"nope"}'], 'bad.json', { type: 'application/json' }));
  const inp = document.getElementById('ass-style-preset-file');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  return JSON.stringify({ before, after: document.getElementById('ass-style-zh-font').value,
    toast: (document.querySelector('.toast, #toast') || {}).textContent || '' });
})()`);
const j = JSON.parse(junk);
ok(j.before === j.after, '坏文件没有改动任何样式值', junk);

console.log('\n── 6. 无 JS 报错 ──');
ok(pageErrors.length === 0, '控制台没有 error', pageErrors.slice(0, 3).join(' | '));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
ws.close(); edge.kill();
process.exit(fail ? 1 : 0);
