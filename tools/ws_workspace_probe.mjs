/* 2×2 工作台验证探针：新建项目页 / 详细信息页
 * 用法: node tools/ws_workspace_probe.mjs [baseUrl] [outDir]
 *   （跑之前先起服务: PORT=8356 node editor/server.js）
 * 检查项：
 *   · 两页都是 2×2 网格（左上预览 / 右上输入 / 左下进度 / 右下生成设置）
 *   · 新建项目页：导入/初稿两种模式下「语音识别 · 识别来源 · 分角色」整组显隐
 *   · 详细信息页：稿件预览铺元数据、进度面板常驻、生成设置回显 + 保存
 *   · 「解析」真跑一次（只粘 BV 号，验证前端补全 + 元数据/缩略图落地）
 *   · 窄屏（<=1080px）退化成单列
 * 自己造一个带 source 的探针项目（projects/p-wsprobe-0001），跑完删掉。
 * 注意：--window-size 必须显式传（无头默认约 745px 宽，会直接落进窄屏分支）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8356';
const OUT = process.argv[3] || join(tmpdir(), 'ws-probe-shots');
const CDP_PORT = 9341;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

/* ── 测试项目 fixture：详细信息页要看「有 source / 有 draft」的那条路径 ── */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX_ID = 'p-wsprobe-0001';
const FIX_DIR = join(ROOT, 'projects', FIX_ID);
function writeFixture() {
  const thumb = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#2b2b3a"/>' +
    '<text x="320" y="190" font-size="34" fill="#ff7a45" text-anchor="middle">THUMB</text></svg>');
  const now = new Date().toISOString();
  const meta = {
    id: FIX_ID, name: '【探针】2×2 工作台验证用项目', nameCustomized: true, createdAt: now, modifiedAt: now,
    video: { path: join(ROOT, 'probe.mp4'), name: 'probe.mp4' },
    prepare: { status: 'done', finishedAt: now, error: null, duration: 3725.5, rate: 100, mode: 'denoise' },
    subtitle: { format: 'ass', file: 'subtitle.ass', name: 'probe.ass' },
    duration: 3725.5,
    source: {
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7', site: 'bilibili', id: 'BV1GJ411x7h7',
      title: '【探针】这是一条很长的标题，用来验证稿件预览面板在窄列里会不会把面板撑破或者把其他信息挤下去',
      uploader: 'SubFabric 探针账号', description: '这是简介。'.repeat(20),
      duration: 3725.5, uploadDate: '2026-10-01', tags: ['字幕', '探针'], viewCount: 123456,
      thumbnail: thumb, height: 1080, qualityPreset: '1080p', fileSize: 0, fetchedAt: now,
    },
    draft: {
      words: 1200, lines: 180, status: 'done', stage: '完毕', progress: 100,
      message: '初稿已生成：180 行（含中文译文）', error: null, wordLevel: true, translated: true,
      needTranslate: false, modelId: 'parakeet-tdt-0.6b-v2', engine: 'sherpa-onnx',
      speakers: true, speakerCount: 4, startedAt: now, failedStage: '', resegDone: true,
      pendingTranslate: 0, finishedAt: now,
    },
  };
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(join(FIX_DIR, 'project.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(FIX_DIR, 'subtitle.ass'),
    '[Script Info]\nTitle: probe\nScriptType: v4.00+\n\n[V4+ Styles]\n'
    + 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    + 'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,30,1\n\n'
    + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,probe line one\n'
    + 'Dialogue: 0,0:00:03.50,0:00:05.00,Default,,0,0,0,,probe line two\n');
  writeFileSync(join(FIX_DIR, 'draft.log'), '[probe] 初稿已生成\n');
}
/** 只删自己造的那一个目录（名字是常量，不做通配） */
function removeFixture() { rmSync(FIX_DIR, { recursive: true, force: true }); }
writeFixture();
process.on('exit', removeFixture);

const profile = mkdtempSync(join(tmpdir(), 'edge-ws-'));
// 沙箱会给子进程塞 HTTP(S)_PROXY，本地 127.0.0.1 走代理会变成 chrome-error 页 —— 直连。
const cleanEnv = { ...process.env };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete cleanEnv[k];
cleanEnv.NO_PROXY = '127.0.0.1,localhost';
cleanEnv.no_proxy = '127.0.0.1,localhost';
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--window-size=1440,1000',
  '--proxy-server=direct://', '--proxy-bypass-list=*',
  BASE + '/editor/index.html'
], { stdio: 'ignore', env: cleanEnv });

let target = null;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page' && t.url.includes(BASE.replace(/^https?:\/\//, '')))
          || list.find(t => t.type === 'page');
    if (target && target.webSocketDebuggerUrl) break;
  } catch {}
}
if (!target) { console.log('未找到页面目标'); edge.kill(); process.exit(1); }
console.log('target:', target.url);

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
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('[console.' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  } else if (m.method === 'Log.entryAdded') {
    if (m.params.entry.level === 'error') logs.push('[log.error] ' + m.params.entry.text);
  } else if (m.method === 'Network.responseReceived') {
    const st = m.params.response.status;
    if (st >= 400) logs.push('[HTTP ' + st + '] ' + m.params.response.url);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await sleep(2600);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r && r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) { writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); return join(OUT, name); }
  return null;
};
/** 单块面板截图。工作页面是 position:fixed 的滚动容器（滚的不是 document），
 *  captureBeyondViewport 抓不到视口外的部分 —— 所以先把视口撑到够高，再按元素矩形裁剪。 */
const shotEl = async (sel, name) => {
  const geo = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: innerWidth, need: Math.ceil(r.y + r.height) + 40 };
  })()`);
  if (!geo || geo.__err) return null;
  const restore = viewportH;
  await setViewport(geo.w, Math.max(900, geo.need));
  await sleep(320);
  const rect = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height) };
  })()`);
  let saved = null;
  if (rect && !rect.__err) {
    const r = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
    });
    if (r && r.data) { writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); saved = join(OUT, name); }
  }
  await setViewport(geo.w, restore);
  await sleep(260);
  return saved;
};
let viewportW = 1440, viewportH = 1000;
const setViewport = async (w, h) => {
  viewportW = w; viewportH = h;
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
};

// ── 通用：读某个工作台页的网格几何 ────────────────────────────────────────
const GRID_JS = (rootSel) => `(() => {
  const root = document.querySelector('${rootSel}');
  if (!root) return { missing: true };
  const grid = root.querySelector('.ws-grid');
  const cs = getComputedStyle(grid);
  const panels = [...grid.children].map(el => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, id: el.id || '', title: (el.querySelector('h2') || {}).textContent || '',
             x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const rows = [...new Set(panels.map(p => p.y))].sort((a,b)=>a-b);
  const cols = [...new Set(panels.map(p => p.x))].sort((a,b)=>a-b);
  return { cols: cs.gridTemplateColumns, gap: cs.gap, rows: rows.length, colCount: cols.length,
           panels, viewport: [innerWidth, innerHeight],
           bodyScrollW: document.body.scrollWidth, docScrollW: document.documentElement.scrollWidth };
})()`;

const result = {};

/* ══════════ 1. 新建项目页 ══════════ */
await evalJs(`location.hash = '#/new'`);
await sleep(1400);
result.np_import = await evalJs(`(async () => {
  const o = ${GRID_JS('#np-view')};
  const g = (s) => document.querySelector(s);
  o.mode = 'import';
  o.voiceGroupHidden = g('#np-voice-group').hidden;
  o.castGroupHidden  = g('#np-cast-group').hidden;
  o.sourceGroupHidden= g('#np-source-group').hidden;
  o.urlRowHidden     = g('#np-row-url').hidden;
  o.partRowHidden    = g('#np-row-part').hidden;
  o.subRowHidden     = g('#np-row-sub').hidden;
  o.previewEmptyHidden = g('#np-preview-empty').hidden;
  o.badge = g('#np-preview-badge').textContent;
  o.badgeClass = g('#np-preview-badge').className;
  o.setProviderOptions = g('#np-set-provider').options.length;
  o.setModelValue = g('#np-set-model').value;
  o.setModelPh = g('#np-set-model').placeholder;
  o.setCastChecked = g('#np-set-cast').checked;
  o.setCastPromptLen = g('#np-set-castprompt').value.length;
  o.setPromptLen = g('#np-set-prompt').value.length;
  o.setState = g('#np-set-state').textContent;
  o.steps = g('#np-steps').children.length;
  o.stepClasses = [...g('#np-steps').children].map(e => e.className);
  o.createDisabled = g('#np-create').disabled;
  o.createLabel = g('#np-create').textContent;
  return o;
})()`);
result.np_import_shot = await shot('01-np-import-wide.png');

// 切到「创建初稿」
await evalJs(`document.getElementById('np-mode-draft').click()`);
await sleep(1600);
result.np_draft = await evalJs(`(() => {
  const g = (s) => document.querySelector(s);
  const o = {};
  o.voiceGroupHidden = g('#np-voice-group').hidden;
  o.castGroupHidden  = g('#np-cast-group').hidden;
  o.sourceGroupHidden= g('#np-source-group').hidden;
  o.urlRowHidden     = g('#np-row-url').hidden;
  o.partRowHidden    = g('#np-row-part').hidden;
  o.subRowHidden     = g('#np-row-sub').hidden;
  o.wordRowHidden    = g('#np-row-word').hidden;
  o.spkRowHidden     = g('#np-row-spk').hidden;
  o.sourceOptions = [...g('#np-set-source').options].map(x => x.value + '|' + x.textContent);
  o.sourceValue = g('#np-set-source').value;
  o.modelOptions = [...g('#np-model-sel').options].map(x => x.value + '|' + x.textContent);
  o.modelValue = g('#np-model-sel').value;
  o.probeBtn = !!g('#np-probe');
  o.hint = g('#np-hint').textContent.slice(0, 80);
  o.createLabel = g('#np-create').textContent;
  // 解析按钮：空链接 → 只提示，不发请求
  g('#np-probe').click();
  return o;
})()`);
await sleep(500);
result.np_draft_shot = await shot('02-np-draft-wide.png');
result.np_draft_settings_shot = await shotEl('#np-settings-panel', '02b-np-settings.png');
result.np_draft_input_shot = await shotEl('#np-view .ws-grid > section:nth-child(2)', '02c-np-input.png');

// 「解析」真跑一次（只读元数据，不下载）：预览面板应铺上标题/作者/时长 + 缩略图
// 需要外网；拉不到就只记 error，不影响其它检查
result.np_probe_live = await evalJs(`(async () => {
  const g = (s) => document.querySelector(s);
  g('#np-url').value = 'BV1GJ411x7h7';   // 故意只给 BV 号，验证前端会补成完整链接
  g('#np-url').dispatchEvent(new Event('input', { bubbles: true }));
  g('#np-probe').click();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const b = g('#np-preview-badge').textContent;
    if (b !== '解析中…') break;
  }
  return { badge: g('#np-preview-badge').textContent,
           badgeClass: g('#np-preview-badge').className,
           title: g('#np-m-title').textContent.slice(0, 40),
           uploader: g('#np-m-uploader').textContent,
           duration: g('#np-m-duration').textContent,
           descLen: g('#np-m-desc').textContent.length,
           emptyHidden: g('#np-preview-empty').hidden,
           thumbHidden: g('#np-thumb').hidden,
           thumbW: g('#np-thumb').naturalWidth,
           nameFilled: g('#np-name').value.slice(0, 40),
           createDisabled: g('#np-create').disabled };
})()`);
result.np_probe_shot = await shotEl('#np-view .ws-grid > section:nth-child(1)', '02d-np-preview-parsed.png');

// 窄屏：网格应退化成单列
await setViewport(820, 1000);
await sleep(500);
result.np_narrow = await evalJs(GRID_JS('#np-view'));
result.np_narrow_shot = await shot('03-np-narrow.png');
await setViewport(1440, 1000);

/* ══════════ 2. 详细信息页 ══════════ */
await evalJs(`location.hash = '#/details/p-wsprobe-0001'`);
await sleep(1800);
result.dt = await evalJs(`(async () => {
  const g = (s) => document.querySelector(s);
  const o = ${GRID_JS('#detail-view')};
  o.format = g('#detail-format').textContent;
  o.title = g('#detail-m-title').textContent.slice(0, 40);
  o.uploader = g('#detail-m-uploader').textContent;
  o.duration = g('#detail-m-duration').textContent;
  o.descLen = g('#detail-m-desc').textContent.length;
  o.thumbHidden = g('#detail-thumb').hidden;
  o.thumbW = g('#detail-thumb').naturalWidth;
  o.previewEmptyHidden = g('#detail-preview-empty').hidden;
  o.video = g('#detail-video').textContent;
  o.subtitle = g('#detail-subtitle').textContent;
  o.dpIdleHidden = g('#dp-idle').hidden;
  o.dpBodyHidden = g('#dp-body').hidden;
  o.dpSteps = g('#dp-steps').children.length;
  o.dpMsg = g('#dp-msg').textContent;
  o.dpPct = g('#dp-pct').textContent;
  o.dtSourceOptions = [...g('#dt-set-source').options].map(x => x.value);
  o.dtModelOptions = [...g('#dt-model-sel').options].map(x => x.value);
  o.dtModelValue = g('#dt-model-sel').value;
  o.dtProviderOptions = [...g('#dt-set-provider').options].map(x => x.value);
  o.dtProviderValue = g('#dt-set-provider').value;
  o.dtModel = g('#dt-set-model').value;
  o.dtSetState = g('#dt-set-state').textContent;
  o.dtSpeakersChecked = g('#dt-set-speakers').checked;
  o.dtSpeakersDisabled = g('#dt-set-speakers').disabled;
  o.dtSpeakersNote = g('#dt-set-speakers-note').hidden;
  o.dtOpenSettings = !!g('#dt-open-settings');
  const pan = g('#dt-settings-panel');
  o.panelH = Math.round(pan.getBoundingClientRect().height);
  o.panelScrollH = pan.scrollHeight;
  o.areaH = ['#dt-set-prompt','#dt-set-castprompt','#dt-model-sel'].map(x => Math.round(g(x).getBoundingClientRect().height));
  o.areaRows = ['#dt-set-prompt','#dt-set-castprompt'].map(x => g(x).rows + '/' + g(x).minHeight || '');
  o.gridRowH = Math.round(g('#detail-progress').getBoundingClientRect().height);
  return o;
})()`);
result.dt_shot = await shot('04-details-wide.png');
result.dt_settings_shot = await shotEl('#dt-settings-panel', '04b-dt-settings.png');
result.dt_progress_shot = await shotEl('#detail-progress', '04c-dt-progress.png');
result.dt_preview_shot = await shotEl('#detail-view .ws-grid > section:nth-child(1)', '04d-dt-preview.png');

// 保存设置：状态徽标应变成「已保存」
result.dt_save = await evalJs(`(async () => {
  const g = (s) => document.querySelector(s);
  const before = g('#dt-set-state').textContent;
  window.__origCastPrompt = g('#dt-set-castprompt').value;   // 探针会改它，末尾要还原
  g('#dt-set-castprompt').value = 'PROBE-CAST-PROMPT';
  g('#dt-set-castprompt').dispatchEvent(new Event('input', { bubbles: true }));
  const dirty = g('#dt-set-state').textContent;
  g('#dt-set-save').click();
  await new Promise(r => setTimeout(r, 1800));
  return { before, dirty, after: g('#dt-set-state').textContent,
           toast: (document.querySelector('.toast') || {}).textContent || null,
           savedPromptLen: g('#dt-set-castprompt').value.length };
})()`);

// 读回：确认真的写进了 asr/settings.json
result.dt_cfg_readback = await evalJs(`(async () => {
  const c = await (await fetch('/api/cast/config')).json();
  return { enabled: c.enabled, prompt: c.prompt, llmReady: c.llmReady, defaultPromptLen: (c.defaultPrompt||'').length };
})()`);

// 「管理模型」→ 设置页，返回标签应是「返回详细信息」
result.dt_open_settings = await evalJs(`(async () => {
  document.getElementById('dt-open-settings').click();
  await new Promise(r => setTimeout(r, 900));
  const o = { hash: location.hash, closeLabel: document.getElementById('st-close-label').textContent };
  document.getElementById('st-cancel').click();
  await new Promise(r => setTimeout(r, 900));
  o.backHash = location.hash;
  o.dtTitle = (document.querySelector('#detail-m-title')||{}).textContent || '';
  return o;
})()`);

// 窄屏
await setViewport(820, 1000);
await sleep(500);
result.dt_narrow = await evalJs(GRID_JS('#detail-view'));
result.dt_narrow_shot = await shot('05-details-narrow.png');
await setViewport(430, 900);
await sleep(500);
result.dt_mobile = await evalJs(GRID_JS('#detail-view'));
result.dt_mobile_shot = await shot('06-details-mobile.png');

/* ══════════ 3. 项目列表里没有初稿的项目（进度面板空态） ══════════ */
await setViewport(1440, 1000);
await evalJs(`location.hash = '#/details/p-musonzo2-1agpq'`);
await sleep(1800);
result.dt_nodraft = await evalJs(`(() => {
  const g = (s) => document.querySelector(s);
  return { previewEmptyHidden: g('#detail-preview-empty').hidden,
           thumbHidden: g('#detail-thumb').hidden,
           title: g('#detail-m-title').textContent,
           dpIdleHidden: g('#dp-idle').hidden,
           dpBodyHidden: g('#dp-body').hidden,
           dpMsg: g('#dp-msg').textContent,
           speakersChecked: g('#dt-set-speakers').checked,
           format: g('#detail-format').textContent };
})()`);
result.dt_nodraft_shot = await shot('07-details-nodraft.png');

/* ══════════ 3.5 还原探针写进全局设置的「角色分析提示词」 ══════════ */
result.restore = await evalJs(`(async () => {
  const r = await fetch('/api/cast/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: window.__origCastPrompt || '' }),
  });
  const d = await r.json();
  return { ok: r.ok, prompt: d.prompt };
})()`);

/* ══════════ 4. 项目列表入口 ══════════ */
await evalJs(`location.hash = '#/home'`);
await sleep(900);
result.home = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('#home-list .proj-card')];
  return { cards: cards.length, firstText: cards[0] ? cards[0].textContent.trim().replace(/\\s+/g,' ').slice(0,90) : null,
           detailBtns: [...document.querySelectorAll('#home-list .pc-details')].map(b => b.textContent),
           anyOldLabel: /查看进度|编辑信息/.test(document.body.textContent) };
})()`);

console.log(JSON.stringify(result, null, 1));
console.log('=== 控制台/日志 ===');
console.log(logs.length ? logs.join('\n') : '(无错误)');
console.log('=== 截图目录 ===');
console.log(OUT);

ws.close();
edge.kill();
process.exit(0);
