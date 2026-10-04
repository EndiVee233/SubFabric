/* 字幕后处理特效（微光 Glow）UI 与管线端到端探针（无头 Edge + CDP）
 *
 * 验证：
 *   1) 设置面板里的控件齐全、默认折叠；
 *   2) 总开关展开/折叠 + 回显；
 *   3) 生效范围四态（仅逐词 / 中文 / 英文 / 全部）与中英两组参数可独立调、回显同步；
 *   4) 调参真的写进 localStorage，并且真的作用到后处理输出；
 *   5) 预览通道（assPlayer.postProcessor）与导出通道共用同一份结果；
 *   6) 关闭后还原。
 *
 * 用法：PORT=8366 node editor/server.js  然后  node tools/postprocess_ui_probe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PROBE_PORT || 8366);
const TARGET_URL = `http://127.0.0.1:${PORT}/editor/index.html`;
const CDP_PORT = Number(process.env.PROBE_CDP_PORT || 9422);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('--- 启动无头 Edge 探针 ---');
  const edgeBin = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile = mkdtempSync(join(tmpdir(), 'edge-fx-'));

  const cleanEnv = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete cleanEnv[k];
  cleanEnv.NO_PROXY = '127.0.0.1,localhost';
  cleanEnv.no_proxy = '127.0.0.1,localhost';

  const edge = spawn(edgeBin, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1280,900',
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
    TARGET_URL
  ], { stdio: 'ignore', env: cleanEnv });

  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page' && t.url.includes(String(PORT)))
              || list.find(t => t.type === 'page');
        if (target && target.webSocketDebuggerUrl) break;
      } catch { /* 继续等 */ }
    }
    if (!target) throw new Error('未找到 Edge CDP 页面目标');
    console.log('已连接目标页面:', target.url);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      const onMsg = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(msg.error); else resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression, awaitPromise = false) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception));
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await sleep(2000);

    // 1. 控件齐全 + 默认折叠
    const initCheck = await evaluate(`(() => {
      const ids = ['fx-enable','fx-enable-val','fx-controls','fx-glow-enable','fx-glow-target'];
      const langIds = [];
      for (const l of ['zh','en']) for (const s of ['group','head','state','enable','enable-val','channel','color','color-val','radius','radius-val','intensity','intensity-val']) langIds.push('fx-' + l + '-' + s);
      const missing = ids.concat(langIds).filter(id => !document.getElementById(id));
      const target = document.getElementById('fx-glow-target');
      const ch = document.getElementById('fx-zh-channel');
      return {
        missing,
        targetOptions: target ? Array.from(target.options).map(o => o.value) : [],
        channelOptions: ch ? Array.from(ch.options).map(o => o.value) : [],
        controlsHidden: document.getElementById('fx-controls').hidden,
        enableChecked: document.getElementById('fx-enable').checked
      };
    })()`);
    console.log('控件核对:', initCheck);
    if (initCheck.missing.length) throw new Error('缺少控件: ' + initCheck.missing.join(', '));
    for (const opt of ['active_word', 'zh', 'en', 'all']) {
      if (!initCheck.targetOptions.includes(opt)) throw new Error('生效范围缺少选项: ' + opt);
    }
    for (const opt of ['shadow', 'outline', 'both']) {
      if (!initCheck.channelOptions.includes(opt)) throw new Error('发光通道缺少选项: ' + opt);
    }
    if (!initCheck.controlsHidden && !initCheck.enableChecked) throw new Error('默认关闭时 controls 必须 hidden！');

    // 2. 开启总开关
    const toggleOn = await evaluate(`(() => {
      const enable = document.getElementById('fx-enable');
      enable.checked = true;
      enable.dispatchEvent(new Event('change'));
      return {
        enableValText: document.getElementById('fx-enable-val').textContent,
        controlsHidden: document.getElementById('fx-controls').hidden
      };
    })()`);
    console.log('开启开关结果:', toggleOn);
    if (toggleOn.controlsHidden !== false) throw new Error('开启后控件区未展开显示！');
    if (toggleOn.enableValText !== '开') throw new Error('开启后提示文本未变为 开！');

    // 3. 调参：生效范围 = 中英文全部，中英两组参数分别设置
    const tuned = await evaluate(`(() => {
      const set = (id, v, ev) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event(ev, { bubbles: true })); };
      set('fx-glow-target', 'all', 'change');
      set('fx-zh-channel', 'outline', 'change');
      set('fx-zh-color', '#ff0000', 'input');
      set('fx-zh-radius', '9.0', 'input');
      set('fx-zh-intensity', '80', 'input');
      set('fx-en-channel', 'both', 'change');
      set('fx-en-color', '#38bdf8', 'input');
      set('fx-en-radius', '2.5', 'input');
      set('fx-en-intensity', '45', 'input');
      const txt = (id) => document.getElementById(id).textContent;
      return {
        target: document.getElementById('fx-glow-target').value,
        zh: { channel: document.getElementById('fx-zh-channel').value, color: txt('fx-zh-color-val'), radius: txt('fx-zh-radius-val'), intensity: txt('fx-zh-intensity-val'), state: txt('fx-zh-state') },
        en: { channel: document.getElementById('fx-en-channel').value, color: txt('fx-en-color-val'), radius: txt('fx-en-radius-val'), intensity: txt('fx-en-intensity-val'), state: txt('fx-en-state') },
        zhOutOfScope: document.getElementById('fx-zh-group').classList.contains('is-out-of-scope'),
        enOutOfScope: document.getElementById('fx-en-group').classList.contains('is-out-of-scope')
      };
    })()`);
    console.log('调参即时联动:', tuned);
    if (tuned.target !== 'all') throw new Error('生效范围未同步');
    if (tuned.zh.channel !== 'outline' || tuned.en.channel !== 'both') throw new Error('发光通道未同步');
    if (tuned.zh.color !== '#FF0000' || tuned.en.color !== '#38BDF8') throw new Error('颜色回显未同步');
    if (tuned.zh.radius !== '9.0 px' || tuned.en.radius !== '2.5 px') throw new Error('光晕半径回显未同步');
    if (tuned.zh.intensity !== '80%' || tuned.en.intensity !== '45%') throw new Error('发光强度回显未同步');
    if (tuned.zh.state !== '生效中' || tuned.en.state !== '生效中') throw new Error('全部范围下两组都应标记生效中');
    if (tuned.zhOutOfScope || tuned.enOutOfScope) throw new Error('全部范围下两组都不该被压暗');

    // 3b. 切到「仅逐词」→ 中文组应变成「当前范围用不到」
    const scopeSwitch = await evaluate(`(() => {
      const set = (id, v, ev) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event(ev, { bubbles: true })); };
      set('fx-glow-target', 'active_word', 'change');
      const txt = (id) => document.getElementById(id).textContent;
      return {
        zhState: txt('fx-zh-state'), enState: txt('fx-en-state'),
        zhOut: document.getElementById('fx-zh-group').classList.contains('is-out-of-scope'),
        enOut: document.getElementById('fx-en-group').classList.contains('is-out-of-scope')
      };
    })()`);
    console.log('切到「仅逐词」:', scopeSwitch);
    if (!scopeSwitch.zhOut || scopeSwitch.enOut) throw new Error('仅逐词模式下应当只保留英文组生效');
    if (scopeSwitch.zhState !== '当前范围用不到' || scopeSwitch.enState !== '生效中') throw new Error('生效状态标注不正确');

    // 4. 配置落盘 + 真的作用到后处理输出
    const pipeline = await evaluate(`(async () => {
      const mod = await import('/editor/js/postprocess.js');
      const saved = JSON.parse(localStorage.getItem('subfabric_postprocess_config') || 'null');
      const head = '[V4+ Styles]\\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\\n'
        + 'Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1\\n'
        + 'Style: 中文字幕,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1\\n'
        + '[Events]\\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\\n';
      const sample = head
        + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a {\\\\c&H00FF00&}b{\\\\c} c\\n'
        + 'Dialogue: 0,0:00:02.00,0:00:03.00,中文字幕,,0,0,0,,{\\\\c&HFF33FF&}中文行\\n';
      return { saved, out: mod.applyPostProcess(sample, saved) };
    })()`, true);
    console.log('落盘配置:', JSON.stringify(pipeline.saved));
    if (pipeline.saved.glow.target !== 'active_word') throw new Error('生效范围未写入 localStorage');
    if (pipeline.saved.glow.zh.channel !== 'outline' || pipeline.saved.glow.en.channel !== 'both') throw new Error('中英通道未分别写入');
    if (pipeline.saved.glow.zh.intensity !== 80 || pipeline.saved.glow.en.intensity !== 45) throw new Error('中英强度未分别写入');
    const outLines = pipeline.out.split('\n').filter(l => l.startsWith('Dialogue:'));
    if (outLines.length !== 2) throw new Error('后处理不应新增事件！');
    // 仅逐词 → 用英文参数块（#38bdf8 → BGR F8BD38，强度 45% → alpha 8C）
    if (!outLines[0].includes('\\4c&HF8BD38&') || !outLines[0].includes('\\4a&H8C&')) throw new Error('逐词发光未用英文参数块');
    if (!outLines[0].includes('\\3c&HF8BD38&')) throw new Error('英文组选了双通道，应同时染描边');
    if (outLines[1].includes('\\blur')) throw new Error('仅逐词模式下中文整句行不该发光');

    // 5. 预览通道与导出通道同源
    const wiring = await evaluate(`(async () => {
      const mod = await import('/editor/js/postprocess.js');
      const dbg = window.__dbg;
      const sample = '[Events]\\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\\n'
        + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a {\\\\c&H00FF00&}b{\\\\c} c';
      const viaPlayer = typeof dbg.assPlayer.postProcessor === 'function' ? dbg.assPlayer.postProcessor(sample) : null;
      const viaExport = mod.applyPostProcess(sample, dbg.state.postProcessConfig, dbg.state.assStyleTargets);
      return { hasHook: typeof dbg.assPlayer.postProcessor === 'function', same: viaPlayer === viaExport, viaPlayer };
    })()`, true);
    if (!wiring.hasHook) throw new Error('播放器未挂载后处理钩子，预览不会带特效！');
    if (!wiring.same) throw new Error('预览与导出的后处理结果不一致！');

    // 6. 关闭还原
    const toggleOff = await evaluate(`(() => {
      const enable = document.getElementById('fx-enable');
      enable.checked = false;
      enable.dispatchEvent(new Event('change'));
      return {
        enableValText: document.getElementById('fx-enable-val').textContent,
        controlsHidden: document.getElementById('fx-controls').hidden
      };
    })()`);
    console.log('关闭开关还原结果:', toggleOff);
    if (toggleOff.controlsHidden !== true) throw new Error('关闭后控件区未折叠隐藏！');
    if (toggleOff.enableValText !== '关') throw new Error('关闭后提示文本未变回 关！');

    ws.close();
    console.log('🎉 UI / 分语言参数 / 管线同源 端到端探针全部通过！');
  } finally {
    edge.kill();
  }
}

main().catch(e => {
  console.error('探针测试失败:', e.message || e);
  process.exit(1);
});
