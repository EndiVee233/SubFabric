/* 微光（Glow）后处理 → 真实视频区预览渲染 探针（无头 Edge + CDP）
 *
 * 目的：验证「预览」这条链路在**真正的 libass WASM 渲染器**里也成立 ——
 *   · 开启微光后画面确实变了（发光可见）；
 *   · 差异**只覆盖活动词**，其余文字（含另一条中文字幕行）逐像素不动 → 零偏位；
 *   · 发光颜色正确落到画面上。
 *
 * 做法（不依赖外部素材）：
 *   1) 起本地服务：PORT=83xx node editor/server.js
 *   2) 无头 Edge 打开编辑器页
 *   3) 页面内 canvas.captureStream() 合成视频源（libass 建 canvas 需要 videoWidth）
 *   4) DataTransfer 把内联 ASS 塞进 #file-sub，走真实导入路径
 *   5) 暂停后取 libass canvas 像素 → 开启微光 → 再取 → 比对差异包围盒
 *
 * 用法：PROBE_PORT=8367 node tools/postprocess_preview_probe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PROBE_PORT || 8367);
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9423);
const TARGET_URL = `http://127.0.0.1:${PORT}/editor/index.html`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 两条字幕都铺满整段：中文整句 + 英文逐词。活动词是行首的 ALWAYS。 */
const ASS = [
  '[Script Info]',
  'Title: glow preview probe',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  'PlayResY: 720',
  'WrapStyle: 3',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,54,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,3,2,20,20,60,1',
  'Style: 中文字幕,Arial,60,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,20,20,80,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:02:00.00,中文字幕,,0,0,0,,{\\c&HFF33FF&}这是中文字幕整句预览行',
  'Dialogue: 0,0:00:00.00,0:02:00.00,Default,,0,0,0,,{\\c&H00FF00&}ALWAYS{\\c} visible highlighted word here',
  ''
].join('\n');

const GLOW_ON = {
  enabled: true,
  glow: { enabled: true, channel: 'shadow', color: '#ff00ff', radius: 6.0, intensity: 100, target: 'active_word' }
};

async function main() {
  const edgeBin = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile = mkdtempSync(join(tmpdir(), 'edge-glow-'));

  const cleanEnv = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete cleanEnv[k];
  cleanEnv.NO_PROXY = '127.0.0.1,localhost';
  cleanEnv.no_proxy = '127.0.0.1,localhost';

  const edge = spawn(edgeBin, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions',
    '--window-size=1280,800',
    '--proxy-server=direct://', '--proxy-bypass-list=*',
    TARGET_URL
  ], { stdio: 'ignore', env: cleanEnv });

  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page' && t.url.includes(String(PORT))) || list.find(t => t.type === 'page');
        if (target && target.webSocketDebuggerUrl) break;
      } catch { /* 继续等 */ }
    }
    if (!target) throw new Error('未找到 Edge CDP 页面目标');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(msg.error); else resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await sleep(2000);

    const evaluate = async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
      return r.result.value;
    };

    const setup = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const dbg = window.__dbg;
      if (!dbg) return { error: 'no __dbg' };

      /* 合成视频源 */
      const video = document.getElementById('video');
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const cx = c.getContext('2d');
      let frame = 0;
      setInterval(() => {
        frame++;
        cx.fillStyle = '#101820'; cx.fillRect(0, 0, 640, 360);
        cx.fillStyle = '#26343f'; cx.fillRect(20, 240, 600, 90);
        cx.fillStyle = '#ffffff'; cx.font = '20px sans-serif';
        cx.fillText('frame ' + frame, 20, 40);
      }, 40);
      video.srcObject = c.captureStream(25);
      video.muted = true;
      await video.play().catch(() => {});
      for (let i = 0; i < 60 && !video.videoWidth; i++) await sleep(100);
      if (!video.videoWidth) return { error: 'no video size' };

      /* 真实导入路径 */
      const text = ${JSON.stringify(ASS)};
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'glow-probe.ass', { type: 'text/plain' }));
      const input = document.getElementById('file-sub');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        if (dbg.assPlayer && dbg.assPlayer.ready) break;
        await sleep(150);
      }
      if (!(dbg.assPlayer && dbg.assPlayer.ready)) return { error: 'ass not ready: ' + (dbg.assPlayer && dbg.assPlayer.error) };

      video.pause();
      await sleep(1500);

      /* 切到编辑器页，好让视频区（libass canvas）真的可见、能截图 */
      if (!/editor/.test(location.hash)) {
        location.hash = '#/editor';
        await sleep(2000);
      }
      video.pause();
      await sleep(800);

      const cv = document.querySelector('canvas.libassjs-canvas');
      if (!cv) return { error: 'no libass canvas' };
      const ctx = cv.getContext('2d');
      const grab = () => ctx.getImageData(0, 0, cv.width, cv.height);

      window.__glowProbe = {
        cv, ctx,
        snap: () => { const d = grab().data; return Array.from(d); },
        dims: () => ({ w: cv.width, h: cv.height })
      };
      return { ok: true, canvas: cv.width + 'x' + cv.height };
    })()`);

    console.log('预览渲染器就绪:', setup);
    if (!setup || setup.error) throw new Error('预览渲染失败: ' + JSON.stringify(setup));

    const before = await evaluate('window.__glowProbe.snap()');
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return;
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(process.env.SHOT_DIR, { recursive: true });
      // 1) 整页截图
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.SHOT_DIR, name), Buffer.from(r.data, 'base64'));
      // 2) libass 画布本体（对比最干净，不受页面布局影响）
      const dataUrl = await evaluate("window.__glowProbe.cv.toDataURL('image/png')");
      writeFileSync(join(process.env.SHOT_DIR, name.replace(/\.png$/, '_canvas.png')),
        Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    };
    await shot('glow_off.png');

    // 走真实 UI 控件开启微光（逐词模式用英文字幕那一组参数）
    const toggled = await evaluate(`(() => {
      const set = (id, v, ev) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event(ev, { bubbles: true })); };
      const en = document.getElementById('fx-enable');
      en.checked = true; en.dispatchEvent(new Event('change', { bubbles: true }));
      set('fx-glow-target', 'active_word', 'change');
      set('fx-en-channel', 'shadow', 'change');
      set('fx-en-color', '#ff00ff', 'input');
      set('fx-en-radius', '6.0', 'input');
      set('fx-en-intensity', '100', 'input');
      return { cfg: window.__dbg.state.postProcessConfig };
    })()`);
    console.log('已通过 UI 开启微光:', JSON.stringify(toggled.cfg));

    await sleep(2500);   // 等 libass worker 重绘
    const after = await evaluate('window.__glowProbe.snap()');
    await shot('glow_on.png');

    const dims = await evaluate('window.__glowProbe.dims()');
    const W = dims.w, H = dims.h;

    /** 与基准帧逐像素比对；colorTest 用于统计「发光色」像素 */
    const diffAgainst = (base, cur, colorTest, y0 = 0, y1 = H) => {
      let diff = 0, minX = W, maxX = -1, minY = H, maxY = -1, colored = 0;
      for (let y = y0; y < Math.min(y1, H); y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const d = Math.abs(base[i] - cur[i]) + Math.abs(base[i + 1] - cur[i + 1])
                  + Math.abs(base[i + 2] - cur[i + 2]) + Math.abs(base[i + 3] - cur[i + 3]);
          if (d > 24) {
            diff++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          if (colorTest(cur, i)) colored++;
        }
      }
      return { diff, minX, maxX, minY, maxY, colored, w: maxX - minX + 1, h: maxY - minY + 1 };
    };
    const isMagenta = (px, i) => px[i + 3] > 40 && px[i] > 150 && px[i + 1] < 120 && px[i + 2] > 150;
    const isGreen = (px, i) => px[i + 3] > 40 && px[i + 1] > 150 && px[i] < 130 && px[i + 2] < 130;

    // ── 场景 A：生效范围 = 仅逐词高亮词（用英文字幕参数）──
    const A = diffAgainst(before, after, isMagenta);
    console.log(`[A 仅逐词] 画布 ${W}x${H}`);
    console.log(`[A 仅逐词] 差异像素 ${A.diff}，包围盒 x[${A.minX},${A.maxX}] y[${A.minY},${A.maxY}]（${A.w}x${A.h}）`);
    console.log(`[A 仅逐词] 画面中的洋红发光像素 ${A.colored}`);

    if (A.diff === 0) throw new Error('开启微光后预览画面没有任何变化 —— 预览没吃到后处理！');
    if (A.colored === 0) throw new Error('预览画面里找不到发光色，颜色没落到画面上！');
    // 零偏位判据：差异必须局限在活动词一带，不能铺满整行/跨到中文字幕行
    if (A.w > W * 0.5) throw new Error(`差异横向铺开 ${A.w}px（画布宽 ${W}）—— 疑似整行位移`);
    if (A.h > H * 0.35) throw new Error(`差异纵向铺开 ${A.h}px（画布高 ${H}）—— 疑似跨行位移`);

    // ── 场景 B：生效范围 = 中文字幕（整行），英文字幕那一带必须一像素不动 ──
    const zhToggled = await evaluate(`(() => {
      const set = (id, v, ev) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event(ev, { bubbles: true })); };
      set('fx-glow-target', 'zh', 'change');
      set('fx-zh-channel', 'shadow', 'change');
      set('fx-zh-color', '#00ff00', 'input');
      set('fx-zh-radius', '5.0', 'input');
      set('fx-zh-intensity', '100', 'input');
      return window.__dbg.state.postProcessConfig.glow.target;
    })()`);
    console.log('切换生效范围 →', zhToggled);
    await sleep(2500);
    const zhAfter = await evaluate('window.__glowProbe.snap()');
    await shot('glow_zh.png');

    const B = diffAgainst(before, zhAfter, isGreen);
    const inEnglishBand = diffAgainst(before, zhAfter, () => false, 0, A.minY);
    console.log(`[B 中文整行] 差异像素 ${B.diff}，包围盒 x[${B.minX},${B.maxX}] y[${B.minY},${B.maxY}]（${B.w}x${B.h}）`);
    console.log(`[B 中文整行] 绿色发光像素 ${B.colored}；英文字幕上方区域差异 ${inEnglishBand.diff}px`);

    if (B.diff === 0) throw new Error('切到「中文字幕」后画面没变 —— 生效范围没生效！');
    if (B.colored === 0) throw new Error('中文字幕的绿色发光没落到画面上！');
    if (B.minY <= A.minY) throw new Error(`中文字幕的发光出现在 y=${B.minY}，不比英文字幕活动词(y=${A.minY})更靠下 —— 疑似作用到了错误的行`);
    if (inEnglishBand.diff > 0) throw new Error(`英文字幕所在区域被改动了 ${inEnglishBand.diff}px —— 生效范围串轨！`);

    // 关闭后必须完全还原
    await evaluate(`(() => {
      const en = document.getElementById('fx-enable');
      en.checked = false; en.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(2500);
    const restored = await evaluate('window.__glowProbe.snap()');
    let back = 0;
    for (let i = 0; i < before.length; i += 4) {
      const d = Math.abs(before[i] - restored[i]) + Math.abs(before[i + 1] - restored[i + 1])
              + Math.abs(before[i + 2] - restored[i + 2]) + Math.abs(before[i + 3] - restored[i + 3]);
      if (d > 24) back++;
    }
    console.log(`关闭微光后与开启前不一致的像素：${back}`);
    if (back > 0) throw new Error('关闭微光后画面未完全还原！');

    ws.close();
    console.log('🎉 真实 libass WASM 预览渲染探针全部通过（发光可见 / 零偏位 / 颜色正确 / 分轨不串 / 关闭可还原）！');
  } finally {
    edge.kill();
  }
}

main().catch(e => {
  console.error('探针失败:', e.message || e);
  process.exit(1);
});
