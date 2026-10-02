/* ASS 双语样式设置 → 视频区预览同步 探针(无头 Edge + CDP)
 *
 * 复现用户报的问题: 在稿件「设置」里改 ASS 双语样式, 稿件文本确实改了,
 * 但视频播放区的 libass 画面没跟着变(尤其视频处于暂停状态时)。
 *
 * 逐项测试四个控件(字号 / 粗体 / 字体名 / 逐词色), 每项都对比 libass canvas 指纹,
 * 从而定位"到底哪一个改完视频区不动"。
 *
 * 做法:
 *   1) 起本地服务(node editor/server.js, 端口用 PORT 环境变量隔离)
 *   2) 无头 Edge 打开编辑器页
 *   3) 页面内用 canvas.captureStream() 合成"视频源" —— 不依赖外部素材,
 *      同时让 videoWidth/Height 有值(libass 建 canvas 需要)
 *   4) 用 DataTransfer 把 ASS 塞进 #file-sub, 走真实导入路径(routeSub → setAss)
 *   5) 暂停取 canvas 指纹 → 改一个控件 → 再取指纹
 *
 * 用法:
 *   node tools/ass_style_preview_probe.mjs                 # 内联小样例
 *   node tools/ass_style_preview_probe.mjs <某个.ass 路径>  # 用真实稿件(会被复制到项目根供页面 fetch)
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PROBE_PORT || 8399);
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9399);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 内联 ASS: 中文行与英文逐词行都铺满整段 —— 不论合成视频停在哪个时刻,
 * 画面上都同时有中文(整句样式)和英文逐词(Default), 四类改动都能看出差异。 */
const ASS = [
  '[Script Info]',
  'Title: style preview probe',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  'PlayResY: 720',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,60,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,60,1',
  'Style: 中文字幕,Arial,60,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,80,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:02:00.00,中文字幕,,0,0,0,,这是中文字幕样式预览',
  'Dialogue: 0,0:00:00.00,0:02:00.00,Default,,0,0,0,,{\\c&H00FF00&}ALWAYS{\\c} visible highlighted word',
  'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\c&H00FF00&}Chinese{\\c} subtitle preview',
  'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Chinese {\\c&H00FF00&}subtitle{\\c} preview',
  'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Chinese subtitle {\\c&H00FF00&}preview{\\c}',
  'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Chinese subtitle preview {\\c&H00FF00&}again{\\c}',
  'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Chinese subtitle preview again {\\c&H00FF00&}done{\\c}',
  'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\c&H00FF00&}Last{\\c} slice for word style',
  ''
].join('\n');

/** 页面内执行: 逐项改控件, 每项对比 canvas 指纹 */
async function pageProbe(assUrl, fontUrl) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { cases: [] };

  const hashCanvas = () => {
    const cv = document.querySelector('canvas.libassjs-canvas');
    if (!cv) return null;
    let d;
    try { d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; }
    catch (e) { return 'ERR ' + e.message; }
    let h = 2166136261, opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]) opaque++;
      h ^= (d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h + ':' + opaque;
  };

  const dbg = window.__dbg;

  /* 大字幕稿(2 万+ 事件)重建 libass 轨要好几秒 —— 等画面真的画出来再取指纹,
   * 顺便把等待时长记下来(它就是用户感受到的"改完多久才变")。 */
  /* 出问题时需要的现场: 有几个 canvas、多大、是否显示、渲染器状态 */
  const diag = () => {
    const canvases = document.querySelectorAll('canvas.libassjs-canvas');
    const cv = canvases[0];
    const inst = dbg && dbg.assPlayer && dbg.assPlayer.instance;
    return {
      canvases: canvases.length,
      size: cv ? cv.width + 'x' + cv.height : null,
      display: cv ? (cv.style.display || '') : null,
      ready: !!(dbg && dbg.assPlayer && dbg.assPlayer.ready),
      error: (dbg && dbg.assPlayer && dbg.assPlayer.error) || null,
      workerActive: !!(inst && inst.workerActive),
      parentKids: document.getElementById('video-stage') ? document.getElementById('video-stage').children.length : null
    };
  };

  const waitPainted = async (ms = 40000) => {
    const t0 = Date.now();
    for (;;) {
      const h = hashCanvas();
      if (typeof h === 'string' && !h.endsWith(':0')) return Date.now() - t0;
      if (Date.now() - t0 > ms) return -1;
      await sleep(300);
    }
  };

  /* 直接问 libass worker: 它解析到的样式表是什么 —— 用来区分
   * 「样式根本没送到渲染器」和「送到了但字体不可用 → 回退字体、画面看着没变」。 */
  const libassStyles = () => new Promise((resolve) => {
    const inst = dbg && dbg.assPlayer && dbg.assPlayer.instance;
    if (!inst || typeof inst.getStyles !== 'function') return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), 8000);
    try {
      inst.getStyles((styles) => {
        const pick = (n) => {
          const s = (styles || []).find(x => x.Name === n);
          return s ? { font: s.FontName, size: s.FontSize, bold: s.Bold, italic: s.Italic } : null;
        };
        finish({ count: (styles || []).length, zh: pick('中文字幕'), en: pick('Default') });
      }, () => finish(null));
    } catch (e) { finish(null); }
  });

  /* 1) 合成视频源 */
  const video = document.getElementById('video');
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const cx = c.getContext('2d');
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    cx.fillStyle = '#101820'; cx.fillRect(0, 0, 640, 360);
    cx.fillStyle = '#26343f'; cx.fillRect(30, 250, 580, 70);
    cx.fillStyle = '#ffffff'; cx.font = '24px sans-serif';
    cx.fillText('frame ' + frame, 30, 60);
  }, 40);
  video.srcObject = c.captureStream(25);
  video.muted = true;
  await video.play().catch(() => {});
  for (let i = 0; i < 60 && !video.videoWidth; i++) await sleep(100);
  out.videoSize = video.videoWidth + 'x' + video.videoHeight;
  if (!video.videoWidth) { clearInterval(timer); out.error = 'no video size'; return out; }

  /* 2) 导入 ASS(真实导入路径) */
  const text = await (await fetch(assUrl)).text();
  out.assBytes = text.length;
  const dt = new DataTransfer();
  dt.items.add(new File([text], 'probe.ass', { type: 'text/plain' }));
  const input = document.getElementById('file-sub');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  const waitReady = async (want, ms = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = !!(dbg && dbg.assPlayer && dbg.assPlayer.ready);
      if (r === want) return true;
      await sleep(150);
    }
    return false;
  };

  /* 3) 等 libass 就绪 */
  await waitReady(true);
  out.assReady = !!(dbg && dbg.assPlayer && dbg.assPlayer.ready);
  if (!out.assReady) { out.error = (dbg && dbg.assPlayer && dbg.assPlayer.error) || 'not ready'; clearInterval(timer); return out; }

  video.pause();
  await sleep(1500);

  const els = {
    zhSize: document.getElementById('ass-style-zh-size'),
    zhBold: document.getElementById('ass-style-zh-bold'),
    zhFont: document.getElementById('ass-style-zh-font'),
    wordColor: document.getElementById('ass-style-word-color')
  };
  out.panelEnabled = !!(els.zhSize && !els.zhSize.disabled);

  const step = async (name, mutate, note, which = 'zh', expect = 'canvas') => {
    const before = hashCanvas();
    const diagBefore = diag();
    const beforeDoc = note();
    const beforeLibass = await libassStyles();
    mutate();
    await sleep(600);
    // 字体名变化会走整轨重载(load) → 等它再次就绪
    if (!dbg.assPlayer.ready) await waitReady(true);
    const paintMs = await waitPainted();
    await sleep(400);   // 让最后一帧稳定下来
    const after = hashCanvas();
    const afterDoc = note();
    const afterLibass = await libassStyles();
    const pick = (s) => (s ? s[which] : null);
    const notes = [document.getElementById('ass-style-zh-font-note'), document.getElementById('ass-style-en-font-note')]
      .map(n => (n && n.textContent) || '').filter(Boolean);
    out.cases.push({
      name, expect, before, after,
      canvasChanged: before !== after,
      canvasBlank: typeof after === 'string' && after.endsWith(':0'),
      docBefore: beforeDoc, docAfter: afterDoc,
      docChanged: beforeDoc !== afterDoc,
      libassBefore: pick(beforeLibass), libassAfter: pick(afterLibass),
      libassGotIt: !!(beforeLibass && afterLibass
        && JSON.stringify(pick(beforeLibass)) !== JSON.stringify(pick(afterLibass))),
      ready: !!dbg.assPlayer.ready,
      paintMs,
      diagBefore, diagAfter: diag(),
      fontNotes: notes
    });
  };

  const zhSizeOf = () => dbg.state.assDoc.getStyle('中文字幕').fontsize;
  const zhBoldOf = () => dbg.state.assDoc.getStyle('中文字幕').bold;
  const zhFontOf = () => dbg.state.assDoc.getStyle('中文字幕').fontname;
  const wordColorOf = () => dbg.state.assDoc.getScriptInfoComment('SubFabricWordHighlightColor');

  await step('字号 60→150', () => {
    els.zhSize.value = '150';
    els.zhSize.dispatchEvent(new Event('change', { bubbles: true }));
  }, zhSizeOf);

  await step('粗体 关→开', () => {
    els.zhBold.checked = !els.zhBold.checked;
    els.zhBold.dispatchEvent(new Event('change', { bubbles: true }));
  }, zhBoldOf);

  // 只改字体名、不载入字体文件: libass 会回退内置字体 → 画面**预期不变**(不是 bug)
  await step('字体名 Arial→Verdana', () => {
    els.zhFont.value = 'Verdana';
    els.zhFont.dispatchEvent(new Event('change', { bubbles: true }));
  }, zhFontOf, 'zh', 'deliver');

  await step('逐词色 #00ff00→#ff44aa', () => {
    els.wordColor.value = '#ff44aa';
    els.wordColor.dispatchEvent(new Event('input', { bubbles: true }));
  }, wordColorOf);

  /* 载入本机字体: 英文轨换成 Consolas(本机字体文件), 画面应当真的变字形 */
  if (fontUrl) {
    const enFontOf = () => dbg.state.assDoc.getStyle('Default').fontname;
    const blob = await (await fetch(fontUrl)).blob();
    const fontFile = new File([blob], 'consola.ttf', { type: 'font/ttf' });
    await step('载入本机字体 Consolas', () => {
      const nameEl = document.getElementById('ass-style-en-font');
      nameEl.value = 'ConsolasProbe';
      nameEl.dispatchEvent(new Event('change', { bubbles: true }));   // 先写名字
      const fileEl = document.getElementById('ass-style-en-font-file');
      const dt2 = new DataTransfer();
      dt2.items.add(fontFile);
      fileEl.files = dt2.files;
      fileEl.dispatchEvent(new Event('change', { bubbles: true }));    // 再载入字体文件
    }, enFontOf, 'en', 'canvas');
  }

  out.statusText = (document.getElementById('ass-style-status') || {}).textContent || '';
  clearInterval(timer);
  video.pause();
  return out;
}

/* ── 可选: 用真实稿件 ── */
let assUrl = '/__probe_inline.ass';
let copiedPath = null;
const userAss = process.argv[2];
if (userAss) {
  if (!existsSync(userAss)) { console.error('找不到稿件:', userAss); process.exit(1); }
  copiedPath = join(ROOT, '__probe_sample.ass');
  copyFileSync(userAss, copiedPath);
  assUrl = '/__probe_sample.ass';
  console.log('使用真实稿件:', userAss);
}
const inlinePath = join(ROOT, '__probe_inline.ass');
if (!userAss) {
  const fsMod = await import('node:fs');
  fsMod.writeFileSync(inlinePath, ASS, 'utf8');
}

/* 本机字体文件(用于验证「载入字体」这条路真的能把字形换掉) */
const SYS_FONT = 'C:/Windows/Fonts/consola.ttf';
let fontUrl = null;
let fontCopied = null;
if (existsSync(SYS_FONT)) {
  fontCopied = join(ROOT, '__probe_font.ttf');
  copyFileSync(SYS_FONT, fontCopied);
  fontUrl = '/__probe_font.ttf';
}

const cleanupFiles = () => {
  for (const p of [copiedPath, userAss ? null : inlinePath, fontCopied]) {
    if (!p) continue;
    try { unlinkSync(p); } catch {}
  }
};

/* ── 起服务 ── */
const server = spawn(process.execPath, [join(ROOT, 'editor', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
let serverUp = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) { serverUp = true; break; } } catch {}
}
if (!serverUp) { console.error('服务未起来'); server.kill(); cleanupFiles(); process.exit(1); }

/* ── 起无头 Edge ── */
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + join(process.env.TEMP || '.', 'edge-ass-style-probe-' + Date.now()),
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required',
  `http://127.0.0.1:${PORT}/editor/index.html`
], { stdio: 'ignore' });

const cleanup = () => { try { edge.kill(); } catch {} try { server.kill(); } catch {} cleanupFiles(); };
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes(String(PORT))) || list.find(t => t.type === 'page');
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.error('未找到页面目标'); cleanup(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    logs.push('[console.' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    logs.push('[log] ' + m.params.entry.text);
  } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    logs.push('[HTTP ' + m.params.response.status + '] ' + m.params.response.url);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await sleep(3000);

const expr = '(' + pageProbe.toString() + ')(' + JSON.stringify(assUrl) + ',' + JSON.stringify(fontUrl) + ')';
const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const out = res && res.result && res.result.value;
const err = res && res.exceptionDetails;

console.log('=== ASS 样式 → 视频区预览同步探针 ===');
if (err) console.log('页面异常:', err.exception?.description || err.text);
if (out) {
  console.log('稿件字节      :', out.assBytes, '| 视频源:', out.videoSize, '| libass 就绪:', out.assReady, out.error ? '错误=' + out.error : '');
  console.log('样式面板可用  :', out.panelEnabled);
  for (const c of out.cases || []) {
    const verdict = c.canvasBlank ? '空白!'
      : (c.expect === 'deliver'
        ? (c.libassGotIt ? '已送达(字体未载入→画面预期不变)' : '未送达!')
        : (c.canvasChanged ? '画面已同步' : '画面未变!'));
    console.log(`  ${c.canvasBlank || (c.expect === 'canvas' && !c.canvasChanged) || (c.expect === 'deliver' && !c.libassGotIt) ? '✗' : '✓'} `
      + `${c.name.padEnd(22)} 稿件:${c.docChanged ? '已改' : '未改'}  画布:${c.before} → ${c.after}  ${verdict}`
      + `${c.paintMs >= 0 ? `  刷新 ${c.paintMs}ms` : '  刷新超时!'}`
      + `${c.ready ? '' : '  (渲染器未就绪!)'}`);
    if (c.canvasBlank || c.paintMs < 0) {
      console.log(`      现场: 改前 ${JSON.stringify(c.diagBefore)} → 改后 ${JSON.stringify(c.diagAfter)}`);
    }
    if (c.fontNotes && c.fontNotes.length) console.log(`      面板提示: ${c.fontNotes.join(' | ')}`);
  }
  console.log('面板状态文案  :', out.statusText);
} else {
  console.log('未取到结果:', JSON.stringify(res).slice(0, 800));
}
if (logs.length) console.log('\n页面日志:\n' + logs.slice(0, 20).join('\n'));

const cases = (out && out.cases) || [];
const bad = cases.filter(c => c.canvasBlank || c.paintMs < 0
  || (c.expect === 'canvas' && (!c.docChanged || !c.canvasChanged))
  || (c.expect === 'deliver' && (!c.docChanged || !c.libassGotIt))
  || !c.ready);
console.log('\n结论:', !cases.length ? '未跑到用例'
  : (bad.length ? 'FAIL — ' + bad.map(b => b.name + (b.canvasBlank ? '(画面空白)' : '')).join('、')
                : 'PASS — 样式改完稿件、libass 与视频画面三者一致'));
cleanup();
process.exit(bad.length || !cases.length ? 1 : 0);
