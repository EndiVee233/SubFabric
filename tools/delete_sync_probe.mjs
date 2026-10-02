/* 删除字幕 → 视频区(libass)是否即时刷新 探针(无头 Edge + CDP)
 *
 * 复现用户报的问题: 在字幕列表/时间轴删掉一条字幕, 列表立刻少了,
 * 但视频播放区的 libass 画面还留着那条字幕, 要过一会儿(或拖动进度条)才消失。
 *
 * 做法与 ass_style_preview_probe.mjs 一致:
 *   合成视频源 → 导入 ASS → 暂停在字幕可见时刻 → 取 canvas 指纹
 *   → 调 window.__dbg.deleteItem() → 高频采样 canvas 指纹, 记录"多久才变"
 *
 * 关键判据(用来区分根因):
 *   - lastRenderTime: 主线程 _doUpdate 之后的 renderCanvas 有没有被门禁丢掉
 *   - canvas 指纹:    画面到底有没有重绘
 *
 * 用法: node tools/delete_sync_probe.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PROBE_PORT || 8401);
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9401);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 一条中文字幕铺满整段 —— 暂停时画面上必然有它。
 * 删掉之后画面应当**变空**(不透明像素归零), 这是最干净的判据。
 *
 * PROBE_EVENTS=N 时再塞 N 条无关事件(排在 200s 之后, 不与目标重叠),
 * 用来验证"延迟是不是随稿件体积增长"(真实稿件动辄上万条事件)。 */
const FILLERS = Number(process.env.PROBE_EVENTS || 0);
const pad = (n) => String(n).padStart(2, '0');
const ts = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${pad(m)}:${pad(Math.floor(s))}.${pad(Math.round((s % 1) * 100))}`;
};
const fillerLines = [];
for (let i = 0; i < FILLERS; i++) {
  const a = 200 + i, b = 200 + i + 1;
  fillerLines.push(`Dialogue: 0,${ts(a)},${ts(b)},Default,,0,0,0,,filler event ${i}`);
}

const ASS = [
  '[Script Info]',
  'Title: delete sync probe',
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
  'Dialogue: 0,0:00:00.00,0:02:00.00,中文字幕,,0,0,0,,待删除的字幕 请立即消失',
  ...fillerLines,
  ''
].join('\n');

const ASS_PATH = join(ROOT, '__probe_delete.ass');

async function pageProbe(cfg) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { steps: [] };

  const cvOf = () => document.querySelector('canvas.libassjs-canvas');

  const hashCanvas = () => {
    const cv = cvOf();
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

  const opaqueOf = () => {
    const h = hashCanvas();
    return typeof h === 'string' && h.includes(':') ? Number(h.split(':')[1]) : -1;
  };

  const dbg = window.__dbg;
  const inst = () => dbg && dbg.assPlayer && dbg.assPlayer.instance;

  const snap = (label) => ({
    label,
    hash: hashCanvas(),
    opaque: opaqueOf(),
    lastRenderTime: inst() ? inst().lastRenderTime : null,
    rafId: inst() ? inst().rafId : null,
    workerActive: !!(inst() && inst().workerActive),
    ready: !!(dbg && dbg.assPlayer && dbg.assPlayer.ready),
    pendingTextNull: dbg && dbg.assPlayer ? (dbg.assPlayer._pendingText == null) : null,
    items: (dbg && dbg.state.items) ? dbg.state.items.length : null,
    events: (dbg && dbg.state.assDoc) ? dbg.state.assDoc.events.length : null,
    serLen: (dbg && dbg.state.assDoc) ? dbg.state.assDoc.serialize().length : null
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
    cx.fillStyle = '#ffffff'; cx.font = '24px sans-serif';
    cx.fillText('frame ' + frame, 30, 60);
  }, 40);
  video.srcObject = c.captureStream(25);
  video.muted = true;
  await video.play().catch(() => {});
  for (let i = 0; i < 60 && !video.videoWidth; i++) await sleep(100);
  out.videoSize = video.videoWidth + 'x' + video.videoHeight;
  if (!video.videoWidth) { clearInterval(timer); out.error = 'no video size'; return out; }

  /* 2) 导入 ASS */
  const text = await (await fetch('/__probe_delete.ass')).text();
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

  await waitReady(true);
  out.assReady = !!(dbg && dbg.assPlayer && dbg.assPlayer.ready);
  if (!out.assReady) { out.error = (dbg && dbg.assPlayer && dbg.assPlayer.error) || 'not ready'; clearInterval(timer); return out; }

  /* 3) 定位到字幕可见的时刻(默认暂停; PROBE_PLAYING=1 时保持播放) */
  const PLAYING = !!(cfg && cfg.playing);
  if (!PLAYING) {
    video.pause();
    video.currentTime = 1.0;
    await sleep(1800);
    dbg.assPlayer.updateNow(dbg.state.assDoc.serialize());   // 保证暂停画面已画
    await sleep(800);
  } else {
    video.currentTime = 1.0;
    await video.play().catch(() => {});
    await sleep(1500);
  }

  out.steps.push(snap('暂停后(删除前)'));

  /* 挂一个独立监听: 数 worker 到底有没有把 renderCanvas 发回来(以及 time 值)。
   * 这能区分「worker 没画」与「画了但被主线程门禁丢掉」。 */
  out.workerMsgs = { renderCanvas: 0, lastFrameTime: null, other: {}, errors: [], dbg: [] };
  {
    const w = inst() && inst().worker;
    if (w && typeof w.addEventListener === 'function') {
      w.addEventListener('message', (ev) => {
        const d = (ev && ev.data) || {};
        if (d.target === 'canvas' && (d.op === 'renderCanvas' || d.op === 'renderFastCanvas')) {
          out.workerMsgs.renderCanvas++;
          out.workerMsgs.lastFrameTime = d.time;
        } else {
          const k = String(d.target) + ':' + String(d.op || d.method || '');
          out.workerMsgs.other[k] = (out.workerMsgs.other[k] || 0) + 1;
          if (d.target === 'stdout' || d.target === 'stderr') {
            const txt = String(d.content || '');
            if (txt.includes('[dbg]')) out.workerMsgs.dbg.push(txt.slice(0, 200));
          }
        }
      });
      // worker 里抛出的未捕获异常走 error 事件, 不是 message
      w.addEventListener('error', (ev) => {
        out.workerMsgs.errors.push(String((ev && (ev.message || ev.error)) || ev).slice(0, 300));
      });
      w.addEventListener('messageerror', (ev) => {
        out.workerMsgs.errors.push('messageerror: ' + String((ev && ev.data) || '').slice(0, 200));
      });
    }
  }

  /* ── 场景 A: 程序化删除(与列表/时间轴删除走同一个 deleteItem) ── */
  const item = dbg.state.items[0];
  out.itemFound = !!item;
  out.itemInfo = item ? { kind: item.kind, no: item.no, l1: item.l1, start: item.start, end: item.end } : null;

  /* 量一下主线程到底被谁占住: 给 timeline.draw 计时 + 收集 longtask */
  {
    window.__drawMax = 0; window.__drawTotal = 0; window.__drawCount = 0; window.__longTasks = [];
    window.__hot = {};
    const time = (name, obj, fn) => {
      const orig = obj[fn].bind(obj);
      obj[fn] = function (...a) {
        const s = performance.now();
        const r = orig(...a);
        const d = performance.now() - s;
        const h = window.__hot[name] || (window.__hot[name] = { n: 0, max: 0, total: 0 });
        h.n++; h.total += d; if (d > h.max) h.max = d;
        return r;
      };
    };
    time('timeline.draw', dbg.timeline, 'draw');
    time('panel.setPlayingByTime', dbg.panel, 'setPlayingByTime');
    time('panel.setItems', dbg.panel, 'setItems');
    time('panel._render', dbg.panel, '_render');
    time('panel._applyFilter', dbg.panel, '_applyFilter');
    time('overlay.update', dbg.overlay, 'update');
    time('panel.selectByTime', dbg.panel, 'selectByTime');
    try {
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__longTasks.push(Math.round(e.duration));
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch { /* 不支持就算了 */ }
  }

  const t0 = Date.now();
  dbg.deleteItem(item);
  out.deleteCallMs = Date.now() - t0;      // deleteItem 同步耗时(含一次 updateNow)

  /* 主线程什么时候才重新空出来? 若这里很大, 说明"慢"不在渲染器, 而在主线程被占住 */
  {
    const p0 = performance.now();
    await new Promise(r => setTimeout(r, 0));
    out.threadFreeMs = Math.round(performance.now() - p0);
    const p1 = performance.now();
    await new Promise(r => requestAnimationFrame(() => r()));
    out.nextRafMs = Math.round(performance.now() - p1);
  }
  out.perf = { longTasks: (window.__longTasks || []).slice(0, 10), hot: window.__hot };

  /* 高频采样: 看画面到底多久才变 */
  const after = [];
  let changedAt = -1;
  const beforeHash = out.steps[0].hash;
  for (let i = 0; i < 160; i++) {          // 最多 8s(大稿件重建轨要好几秒)
    await sleep(50);
    const h = hashCanvas();
    after.push({ ms: Date.now() - t0, hash: h, lastRenderTime: inst() ? inst().lastRenderTime : null });
    if (h !== beforeHash && changedAt < 0) changedAt = Date.now() - t0;
    if (i === 0 || i === 1 || i === 4 || i === 19 || i === 39 || i === 79 || i === 159) out.steps.push(snap('删除后 +' + (Date.now() - t0) + 'ms'));
  }
  out.changedAtMs = changedAt;
  out.sampleTimeline = after.filter((_, i) => i < 8 || i === 19 || i === 59);

  /* 3.5) worker 还活着吗? getStyles 会回一条消息 —— 有回=活着(只是没画), 没回=卡死/崩了 */
  out.alive = await new Promise((resolve) => {
    const i2 = inst();
    if (!i2 || typeof i2.getStyles !== 'function') return resolve('no-getStyles');
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 6000);
    try {
      i2.getStyles(() => { if (!done) { done = true; clearTimeout(t); resolve(true); } },
                   () => { if (!done) { done = true; clearTimeout(t); resolve('err'); } });
    } catch (e) { resolve('throw ' + e.message); }
  });

  /* 4) 再显式刷新一次, 看"补一次 updateNow"能不能立刻修正 ——
   *    这能区分「数据没删掉」与「删掉了但画面没重绘」 */
  const beforeForced = hashCanvas();
  dbg.assPlayer.updateNow(dbg.state.assDoc.serialize());
  await sleep(700);
  out.forcedFix = { before: beforeForced, after: hashCanvas(), fixed: hashCanvas() !== beforeForced };

  out.final = snap('结束');
  out.statusText = (document.getElementById('ass-status') || {}).textContent || '';
  clearInterval(timer);
  video.pause();
  return out;
}

writeFileSync(ASS_PATH, ASS, 'utf8');
const cleanupFiles = () => { try { unlinkSync(ASS_PATH); } catch {} };

const server = spawn(process.execPath, [join(ROOT, 'editor', 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});
let serverUp = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) { serverUp = true; break; } } catch {}
}
if (!serverUp) { console.error('服务未起来'); server.kill(); cleanupFiles(); process.exit(1); }

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + join(process.env.TEMP || '.', 'edge-delete-probe-' + Date.now()),
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
    logs.push('[console.' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await sleep(3000);

const cfg = { playing: !!process.env.PROBE_PLAYING };
const res = await send('Runtime.evaluate', {
  expression: '(' + pageProbe.toString() + ')(' + JSON.stringify(cfg) + ')', awaitPromise: true, returnByValue: true
});
const out = res && res.result && res.result.value;
const err = res && res.exceptionDetails;

console.log('=== 删除字幕 → 视频区刷新 探针 ===');
if (err) console.log('页面异常:', err.exception?.description || err.text);
if (out) {
  console.log('视频源:', out.videoSize, '| libass 就绪:', out.assReady, out.error ? ('错误=' + out.error) : '',
    '| 播放中:', cfg.playing, '| 填充事件:', FILLERS);
  console.log('deleteItem 同步耗时:', out.deleteCallMs, 'ms',
    '| 主线程重新空闲:', out.threadFreeMs, 'ms', '| 下一帧 rAF:', out.nextRafMs, 'ms');
  console.log('主线程剖析:', JSON.stringify(out.perf));
  console.log('条目:', out.itemFound ? JSON.stringify(out.itemInfo) : '未找到');
  for (const s of out.steps || []) {
    console.log(`  [${String(s.label).padEnd(20)}] 画布=${s.hash}  不透明=${s.opaque}  lastRenderTime=${s.lastRenderTime}  items=${s.items} events=${s.events} serLen=${s.serLen}`);
  }
  console.log('\n采样时间线(删除后):');
  for (const s of out.sampleTimeline || []) {
    console.log(`  +${String(s.ms).padStart(4)}ms  画布=${s.hash}  lastRenderTime=${s.lastRenderTime}`);
  }
  console.log('\n画面首次变化于: ', out.changedAtMs >= 0 ? out.changedAtMs + 'ms' : '8s 内没有变化!');
  console.log('worker 回传:', JSON.stringify(out.workerMsgs && { ...out.workerMsgs, dbg: undefined }));
  console.log('worker 内部轨迹:');
  for (const l of (out.workerMsgs && out.workerMsgs.dbg) || []) console.log('   ', l);
  for (const l of (out.workerMsgs && out.workerMsgs.errors) || []) console.log('    [error]', l);
  console.log('worker 存活(getStyles 有回音):', out.alive);
  console.log('补一次 updateNow:', JSON.stringify(out.forcedFix));
  console.log('最终:', JSON.stringify(out.final));
  console.log('状态栏:', out.statusText);
} else {
  console.log('未取到结果:', JSON.stringify(res).slice(0, 800));
}
if (logs.length) console.log('\n页面日志:\n' + logs.slice(0, 15).join('\n'));
cleanup();
