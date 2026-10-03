// 复现音频问题: 「音频源」下拉切换后播放音轨是否真的跟着变。
//
// 用法: node tools/probe_audio.mjs <projectId>
import { launch, sleep, report } from './lib/cdp.mjs';

const PID = process.argv[2];
const BASE = 'http://127.0.0.1:8321';
const br = await launch({ url: `${BASE}/#/project/${PID}` });

await br.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__calls = []; const of = window.fetch;
    window.fetch = async (...a) => { const u = String(a[0] && a[0].url ? a[0].url : a[0]);
      const e = { url: u, method: (a[1]&&a[1].method)||'GET' }; window.__calls.push(e);
      try { const r = await of.apply(window, a); e.status = r.status; return r; }
      catch (x) { e.status = 'ERR'; throw x; } };`,
});

await br.goto(`${BASE}/#/project/${PID}`);
await br.waitFor(`document.querySelectorAll('.cue-card').length > 0`, { timeout: 20000, label: '字幕列表' });
await sleep(1500);

/** 页面上的播放状态快照 */
const snap = () => br.eval(`(() => {
  const v = document.querySelector('video');
  const sel = document.getElementById('audio-mode');
  const regen = document.getElementById('btn-regen-audio');
  return {
    dropdown: sel ? sel.value : null,
    selectHidden: document.getElementById('audio-src') ? document.getElementById('audio-src').hidden : null,
    regenBtnDisabled: regen ? regen.disabled : null,
    videoMuted: v ? v.muted : null,
    videoVolume: v ? v.volume : null,
    videoPaused: v ? v.paused : null,
    videoSrc: v ? (v.currentSrc || '').slice(-40) : null,
    videoReadyState: v ? v.readyState : null,
    videoError: v && v.error ? v.error.code : null,
  };
})()`);

report('打开项目后', await snap());

/* 让视频开始播放, 再观察音频归属 */
await br.eval(`(async () => { const v = document.querySelector('video'); v.muted = false; try { await v.play(); } catch (e) { window.__playErr = e.message; } return true; })()`);
await sleep(1200);
report('尝试播放后', { ...(await snap()), playErr: await br.eval('window.__playErr || null') });

/* ── 切到「原视频」并真实点击「重新生成音频」 ── */
async function selectAndRegen(value) {
  await br.eval(`(() => {
    const sel = document.getElementById('audio-mode');
    sel.value = ${JSON.stringify(value)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);
  await sleep(300);
  const before = await snap();
  const r = await br.eval(`(() => {
    const b = document.getElementById('btn-regen-audio');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
  })()`);
  await br.click(Math.round(r.x), Math.round(r.y));
  await sleep(600);
  return { before, clicked: r };
}

report('切「原视频」+ 重新生成', await selectAndRegen('raw'));
await sleep(5000);
report('原视频 生成后', { ...(await snap()), regenCalls: await br.eval(`window.__calls.filter(c=>/prepare/.test(c.url))`) });
await br.shot('tmp-test/shot-audio-raw.png');

/* ── 再切回「降噪后」 ── */
report('切回「降噪后」+ 重新生成', await selectAndRegen('denoise'));
await sleep(5000);
report('降噪后 生成后', await snap());

/* ── 关键: 只切下拉(不点重新生成) —— 播放音轨应立刻可切回原声 ── */
await br.eval(`(() => { const s = document.getElementById('audio-mode'); s.value='raw'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await sleep(800);
report('只切下拉到「原视频」(未点重新生成)', {
  ...(await snap()),
  canHearOriginal: await br.eval(`(() => { const v = document.querySelector('video'); return v ? (!v.muted) : null; })()`),
});

/* ── 验证 /api/media 与 /api/projects/<id>/audio 是否可取 ── */
report('音频接口', await br.eval(`(async () => {
  const out = {};
  for (const u of ['/api/projects/${PID}/audio', '/api/media?path=' + encodeURIComponent(document.querySelector('video')?.dataset?.path || '')]) {
    try { const r = await fetch(u, { headers: { Range: 'bytes=0-100' } }); out[u.slice(0,40)] = r.status + ' len=' + (await r.arrayBuffer()).byteLength; }
    catch (e) { out[u.slice(0,40)] = 'ERR ' + e.message; }
  }
  return out;
})()`));

report('控制台', br.logs.slice(-25).join('\n') || '(无)');
br.close();
process.exit(0);
