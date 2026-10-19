/**
 * 「导出视频」对话框：选导出目录 + 勾选导出内容（双语硬字幕 / 生肉原片 / ASS 字幕）。
 *
 * 设计取舍：
 *   · **样式不在这里配** —— 压制直接烧项目里的 subtitle.ass，用户在设置里调过的
 *     字体/字号/颜色/特效都写在那份文件里，这里再放一套样式控件只会和稿件打架。
 *     所以对话框只问"编码怎么压"，不问"长什么样"（压制效果默认继承稿件设置）。
 *   · 目录选择走服务端原生对话框（/api/pick kind=folder），浏览器拿不到绝对路径；
 *     原生对话框超时/不可用时退回手输路径（服务端会校验并允许新建）。
 *   · 进度靠轮询 /export-video/status（1 秒一次），比 SSE 简单且够用。
 */

const CHECK_KEY = 'subfabric.exportVideo.prefs';

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** 记住用户上次的选择（目录与编码参数），下次打开不用重配。 */
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(CHECK_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(CHECK_KEY, JSON.stringify(p)); } catch { /* 隐私模式 */ }
}

/* 后处理特效（微光/淡入）的配置存在浏览器 localStorage 里，服务端读不到。
 * 但"压制效果要和编辑器里看到的一致"是硬要求 —— 所以把**已经应用过特效的字幕正文**
 * 随导出请求一起送过去。取不到（没开项目/还没加载字幕）就留空，服务端回退到磁盘上的稿件。
 *
 * ⚠ 必须在**调用时**才去读 window.__sfExportContext：本模块的顶层代码先于 main.js 末尾的
 *   赋值执行，顶层缓存下来会永远是 undefined（这句是踩过的坑，别"优化"回模块级常量）。 */
function exportCtx() { return window.__sfExportContext || null; }

function currentSubtitle() {
  const ctx = exportCtx();
  if (!ctx || typeof ctx.getAssDoc !== 'function') return null;
  try {
    const doc = ctx.getAssDoc();
    if (!doc) return null;
    const raw = doc.serialize();
    if (typeof ctx.applyPostProcess !== 'function') return raw;
    const cfg = typeof ctx.getPostProcessConfig === 'function' ? ctx.getPostProcessConfig() : null;
    const targets = typeof ctx.getStyleTargets === 'function' ? ctx.getStyleTargets() : null;
    return ctx.applyPostProcess(raw, cfg, targets);
  } catch { return null; }
}

function toast(msg, ms) {
  if (typeof window.__sfToast === 'function') return window.__sfToast(msg, ms);
  // 退化：没有全局 toast 时用编辑器自己的（main.js 里那个不导出）
  const el = $('toast');
  if (!el) { console.log('[export-video]', msg); return; }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms || 2600);
}

const ACCEL_LABEL = {
  auto: '自动（优先独显）', nvidia: 'NVIDIA NVENC', amd: 'AMD AMF', intel: 'Intel QSV', cpu: 'CPU 软编码',
};
const CODEC_LABEL = { h264: 'H.264', h265: 'H.265', av1: 'AV1' };

let dialogEl = null;
let pollTimer = null;
let currentProjectId = null;
/** 最近一次能力探测的结果（toolsOk 用于在没 ffmpeg 时禁用"开始导出"）。 */
const capabilities = { toolsOk: true, loaded: false };

function ensureDialog() {
  if (dialogEl) return dialogEl;
  const el = document.createElement('div');
  el.id = 'sf-export-video';
  el.className = 'sf-ev-backdrop';
  el.hidden = true;
  el.innerHTML = `
    <div class="sf-ev-panel" role="dialog" aria-modal="true" aria-labelledby="sf-ev-title">
      <div class="sf-ev-head">
        <h2 id="sf-ev-title">导出视频</h2>
        <button type="button" class="sf-ev-x" id="sf-ev-close" aria-label="关闭">×</button>
      </div>
      <div class="sf-ev-body">
        <div class="sf-ev-row">
          <label class="sf-ev-label" for="sf-ev-dir">导出目录</label>
          <div class="sf-ev-dirrow">
            <input type="text" id="sf-ev-dir" class="sf-ev-input" placeholder="选择或输入一个绝对路径" spellcheck="false">
            <button type="button" class="btn btn-mini" id="sf-ev-browse">浏览…</button>
          </div>
        </div>

        <fieldset class="sf-ev-kinds">
          <legend class="sf-ev-label">导出内容</legend>
          <label class="sf-ev-kind"><input type="checkbox" id="sf-ev-k-bilingual" value="bilingual">
            <span><b>双语言硬字幕视频</b><em>把稿件字幕永久烧进画面，效果与编辑器里看到的一致</em></span></label>
          <label class="sf-ev-kind"><input type="checkbox" id="sf-ev-k-raw" value="raw">
            <span><b>生肉（原视频）</b><em>复制一份原片；链接下载的视频就在项目目录里</em></span></label>
          <label class="sf-ev-kind"><input type="checkbox" id="sf-ev-k-subtitle" value="subtitle">
            <span><b>字幕文件</b><em>当前稿件的 ASS，含你在设置里调好的样式</em></span></label>
        </fieldset>

        <details class="sf-ev-adv" id="sf-ev-adv">
          <summary>压制参数（可选，不改字幕样式）</summary>
          <div class="sf-ev-grid">
            <label class="sf-ev-field"><span>编码</span>
              <select id="sf-ev-codec"><option value="h264">H.264</option><option value="h265">H.265</option><option value="av1">AV1</option></select>
            </label>
            <label class="sf-ev-field"><span>加速</span>
              <select id="sf-ev-accel"><option value="auto">自动</option></select>
            </label>
            <label class="sf-ev-field"><span>画质（越小越清晰）</span>
              <input type="number" id="sf-ev-quality" min="0" max="63" step="1">
            </label>
            <label class="sf-ev-field"><span>线程（0=自动）</span>
              <input type="number" id="sf-ev-threads" min="0" max="64" step="1" value="0">
            </label>
          </div>
          <label class="sf-ev-check"><input type="checkbox" id="sf-ev-overwrite"> 覆盖同名文件</label>
          <p class="sf-ev-hint" id="sf-ev-cap"></p>
        </details>

        <div class="sf-ev-progress" id="sf-ev-progress" hidden>
          <div class="sf-ev-step" data-kind="bilingual" hidden>
            <div class="sf-ev-stephead"><span>双语硬字幕</span><span class="sf-ev-stepmsg"></span></div>
            <div class="sf-ev-bar"><i></i></div>
          </div>
          <div class="sf-ev-step" data-kind="raw" hidden>
            <div class="sf-ev-stephead"><span>生肉</span><span class="sf-ev-stepmsg"></span></div>
            <div class="sf-ev-bar"><i></i></div>
          </div>
          <div class="sf-ev-step" data-kind="subtitle" hidden>
            <div class="sf-ev-stephead"><span>字幕</span><span class="sf-ev-stepmsg"></span></div>
            <div class="sf-ev-bar"><i></i></div>
          </div>
          <ul class="sf-ev-notes" id="sf-ev-notes" hidden></ul>
        </div>
      </div>
      <div class="sf-ev-foot">
        <span class="sf-ev-status" id="sf-ev-status"></span>
        <button type="button" class="btn" id="sf-ev-cancel" hidden>取消压制</button>
        <button type="button" class="btn" id="sf-ev-dismiss">关闭</button>
        <button type="button" class="btn btn-accent" id="sf-ev-start">开始导出</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  return (dialogEl = el);
}

/** 拉一次能力探测，填充加速选项并说明这台机器能跑什么。 */
async function loadCapabilities(pid) {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/export-video/capabilities`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);

    /* ffmpeg/ffprobe 根本跑不起来：整块禁用，并说清楚要装什么。
     * 这种情形下 accelerators 全是 false、cpu 全是 null —— 若照常拼提示会变成
     * "未检测到可用硬件编码，将用 CPU"，让人以为只是慢，实际点下去必然失败。 */
    const toolsOk = !(d.tools && d.tools.ok === false);
    capabilities.toolsOk = toolsOk;
    if (!toolsOk) {
      const miss = (d.tools && d.tools.missing) || ['ffmpeg', 'ffprobe'];
      $('sf-ev-cap').textContent =
        `找不到 ${miss.join(' 与 ')}：压制字幕需要它。请安装 ffmpeg 并加入 PATH，`
        + '或用环境变量 FFMPEG_PATH / FFPROBE_PATH 指定完整路径（装好后重开本窗口）。';
      $('sf-ev-accel').innerHTML = '<option value="auto">自动</option>';
      $('sf-ev-accel').disabled = true;
      const b = $('sf-ev-k-bilingual');
      b.disabled = true; b.checked = false;
      return d;
    }

    const sel = $('sf-ev-accel');
    const keep = sel.value;
    sel.innerHTML = '';
    const order = ['auto'];
    for (const k of ['nvidia', 'amd', 'intel']) if (d.accelerators && d.accelerators[k]) order.push(k);
    order.push('cpu');
    for (const k of order) {
      const o = document.createElement('option');
      o.value = k; o.textContent = ACCEL_LABEL[k] || k;
      sel.appendChild(o);
    }
    // 记住的选择在新探测里不存在时退回 auto
    sel.value = order.includes(keep) ? keep : 'auto';

    const bits = [];
    bits.push(d.ffmpeg ? `ffmpeg ${d.ffmpeg}` : 'ffmpeg 版本未知');
    if (d.gpus && d.gpus.length) bits.push(d.gpus.join(' / '));
    const accels = ['nvidia', 'amd', 'intel'].filter(k => d.accelerators && d.accelerators[k]);
    // GPU 优先：直接把"这个格式会用哪个方案"讲明白
    if (accels.length) {
      const auto = d.autoChoice || {};
      const perCodec = ['h264', 'h265', 'av1']
        .filter(c => auto[c] && auto[c].usable)
        .map(c => `${CODEC_LABEL[c]}→${ACCEL_LABEL[auto[c].accel] || auto[c].accel}`)
        .join('、');
      bits.push('GPU 优先：' + accels.map(k => ACCEL_LABEL[k] || k).join('、') + (perCodec ? `（${perCodec}）` : ''));
    } else {
      bits.push('未检测到可用的 GPU 编码器，将用 CPU');
    }
    if (d.cpu) {
      const cpuOk = Object.entries(d.cpu).filter(([, v]) => v && v.usable).map(([k]) => CODEC_LABEL[k] || k);
      if (cpuOk.length) bits.push('CPU 可用：' + cpuOk.join('、'));
    }
    $('sf-ev-cap').textContent = bits.join(' · ');
    return d;
  } catch (e) {
    $('sf-ev-cap').textContent = '能力探测失败：' + e.message;
    return null;
  }
}

function setQualityDefault() {
  const codec = $('sf-ev-codec').value;
  const accel = $('sf-ev-accel').value;
  // 与后端 defaultQualityFor 保持一致：AV1 的合理 CRF 明显更大
  const q = codec === 'av1' ? (accel === 'cpu' ? 35 : 30) : 23;
  $('sf-ev-quality').value = String(q);
}

function collectKinds() {
  return [...document.querySelectorAll('#sf-export-video input[type=checkbox][id^=sf-ev-k-]')]
    .filter(cb => cb.checked).map(cb => cb.value);
}

function updateStartState(job) {
  const kinds = collectKinds();
  const dir = $('sf-ev-dir').value.trim();
  const running = job && job.status === 'running';
  // 没装 ffmpeg 时只有"双语硬字幕"压不了；生肉/字幕是纯文件操作，仍可用
  const blockedByTools = !capabilities.toolsOk && kinds.includes('bilingual');
  let why = '';
  if (!kinds.length) why = '请至少选择一种导出内容';
  else if (!dir) why = '请先选择导出目录';
  else if (blockedByTools) why = '压制字幕需要 ffmpeg，当前不可用（生肉与字幕仍可导出）';
  $('sf-ev-start').disabled = running || !kinds.length || !dir || blockedByTools;
  $('sf-ev-status').textContent = running ? '正在导出…' : why;
  $('sf-ev-start').textContent = running ? '导出中…' : (job && job.status === 'done' ? '再次导出' : '开始导出');
  $('sf-ev-cancel').hidden = !running;
  $('sf-ev-dismiss').hidden = running;
}

function renderSteps(job) {
  const box = $('sf-ev-progress');
  if (!job || !job.steps) { box.hidden = true; return; }
  box.hidden = false;
  for (const step of job.steps) {
    const el = box.querySelector(`.sf-ev-step[data-kind="${step.kind}"]`);
    if (!el) continue;
    el.hidden = false;
    const msg = el.querySelector('.sf-ev-stepmsg');
    const bar = el.querySelector('.sf-ev-bar > i');
    const pct = step.status === 'done' ? 100 : (step.pct || 0);
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    el.dataset.status = step.status;
    const label = step.status === 'done' ? '✓ ' : (step.status === 'error' ? '✗ ' : '');
    msg.textContent = label + (step.message || '');
  }
  const notes = $('sf-ev-notes');
  const list = (job.notes || []).filter(Boolean);
  notes.hidden = !list.length;
  notes.innerHTML = list.map(n => `<li>${esc(n)}</li>`).join('');
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling(pid) {
  stopPolling();
  const tick = async () => {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/export-video/status`);
      const job = await r.json();
      renderSteps(job);
      updateStartState(job);
      if (job.status !== 'running') {
        stopPolling();
        if (job.status === 'done') {
          toast('导出完成：' + (job.outputs || []).map(o => o.path.split(/[\\/]/).pop()).join('、'), 6000);
        } else if (job.status === 'error') {
          toast('导出失败：' + (job.error || '未知错误'), 7000);
        } else if (job.status === 'cancelled') {
          toast('已取消导出', 3000);
        }
        $('sf-ev-status').textContent = job.status === 'done' ? '已完成' : (job.error || '');
      }
    } catch { stopPolling(); }
  };
  tick();
  pollTimer = setInterval(tick, 1000);
}

/** 打开对话框。pid 为空时按钮全禁用（没打开项目就没有可导出的东西）。 */
export async function openExportVideoDialog(projectId) {
  currentProjectId = projectId || null;
  const el = ensureDialog();
  el.hidden = false;
  document.body.classList.add('sf-ev-open');

  const prefs = loadPrefs();
  if (prefs.outDir) $('sf-ev-dir').value = prefs.outDir;
  if (prefs.codec) $('sf-ev-codec').value = prefs.codec;
  $('sf-ev-threads').value = String(prefs.threads || 0);
  $('sf-ev-overwrite').checked = !!prefs.overwrite;
  const savedKinds = Array.isArray(prefs.kinds) && prefs.kinds.length ? prefs.kinds : ['bilingual'];
  for (const k of ['bilingual', 'raw', 'subtitle']) {
    const cb = $(`sf-ev-k-${k}`);
    if (cb) cb.checked = savedKinds.includes(k);
  }
  $('sf-ev-progress').hidden = true;
  $('sf-ev-notes').hidden = true;
  $('sf-ev-status').textContent = '';

  if (!currentProjectId) {
    $('sf-ev-start').disabled = true;
    $('sf-ev-status').textContent = '请先在编辑器里打开一个项目';
    return;
  }

  const cap = await loadCapabilities(currentProjectId);
  if (cap) {
    $('sf-ev-k-bilingual').dataset.hasVideo = cap.hasVideo ? '1' : '';
    $('sf-ev-k-raw').dataset.hasVideo = cap.hasVideo ? '1' : '';
    const kbd = $('sf-ev-k-bilingual'), kr = $('sf-ev-k-raw');
    kbd.disabled = !cap.hasVideo; kr.disabled = !cap.hasVideo;
    if (!cap.hasVideo) {
      kbd.checked = false; kr.checked = false;
      const note = document.createElement('li');
      note.textContent = '这个项目没有关联视频，只能导出字幕文件。';
      $('sf-ev-notes').innerHTML = '';
      $('sf-ev-notes').appendChild(note);
      $('sf-ev-notes').hidden = false;
      $('sf-ev-progress').hidden = false;
    }
    $('sf-ev-k-subtitle').checked = $('sf-ev-k-subtitle').checked || !cap.hasVideo;
  }
  setQualityDefault();
  updateStartState(null);

  // 有正在跑的任务就直接接上进度
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/export-video/status`);
    const job = await r.json();
    if (job && job.status === 'running') { renderSteps(job); updateStartState(job); startPolling(currentProjectId); }
  } catch { /* 忽略 */ }
}

function closeDialog() {
  if (!dialogEl) return;
  dialogEl.hidden = true;
  document.body.classList.remove('sf-ev-open');
  stopPolling();
}

async function browseFolder() {
  const btn = $('sf-ev-browse');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '打开选择框…';
  try {
    const ctl = new AbortController();
    // 服务端原生对话框 35s 超时，这里多留一点余量
    const killer = setTimeout(() => ctl.abort(), 40000);
    const r = await fetch('/api/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'folder' }),
      signal: ctl.signal,
    });
    clearTimeout(killer);
    const d = await r.json();
    if (d && d.path) {
      $('sf-ev-dir').value = d.path;
      updateStartState(null);
    } else if (d && d.error) {
      toast(d.error + '（可以直接在输入框里粘贴路径）', 4200);
    }
  } catch {
    toast('系统对话框不可用，请直接在输入框里粘贴路径', 4200);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

async function startExport() {
  const pid = currentProjectId;
  if (!pid) return;
  const kinds = collectKinds();
  const outDir = $('sf-ev-dir').value.trim();
  const body = {
    kinds, outDir,
    codec: $('sf-ev-codec').value,
    accel: $('sf-ev-accel').value,
    quality: Number($('sf-ev-quality').value),
    threads: Number($('sf-ev-threads').value) || 0,
    overwrite: $('sf-ev-overwrite').checked,
  };
  // 只在真的要压/要导字幕时带上正文（几 MB 的字幕没必要为"只导生肉"传一遍）
  if (kinds.includes('bilingual') || kinds.includes('subtitle')) {
    const text = currentSubtitle();
    if (text) body.subtitleText = text;
  }
  savePrefs({
    outDir, codec: body.codec, threads: body.threads,
    overwrite: body.overwrite, kinds,
  });

  $('sf-ev-start').disabled = true;
  $('sf-ev-status').textContent = '启动中…';
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/export-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      $('sf-ev-start').disabled = false;
      $('sf-ev-status').textContent = '';
      toast(d.error || ('导出失败：' + r.status), 6000);
      return;
    }
    startPolling(pid);
  } catch (e) {
    $('sf-ev-start').disabled = false;
    toast('导出请求失败：' + e.message, 5000);
  }
}

async function cancelExport() {
  const pid = currentProjectId;
  if (!pid) return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(pid)}/export-video/cancel`, { method: 'POST' });
    $('sf-ev-status').textContent = '正在取消…';
  } catch { /* 轮询会把最终状态带回来 */ }
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  const el = ensureDialog();
  el.addEventListener('click', (e) => {
    const t = e.target;
    if (t === el) return closeDialog();               // 点遮罩关闭
    if (t.id === 'sf-ev-close' || t.id === 'sf-ev-dismiss') return closeDialog();
    if (t.id === 'sf-ev-browse') return browseFolder();
    if (t.id === 'sf-ev-start') return startExport();
    if (t.id === 'sf-ev-cancel') return cancelExport();
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('input[type=checkbox][id^=sf-ev-k-]')) return updateStartState(null);
    if (e.target.id === 'sf-ev-codec') { setQualityDefault(); return; }
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'sf-ev-dir') updateStartState(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialogEl && !dialogEl.hidden) closeDialog();
  });
}

/** main.js 在项目打开时调用它把按钮点亮。 */
export function initExportVideoButton() {
  const btn = document.getElementById('btn-export-video');
  if (!btn) return;
  bindOnce();
  btn.addEventListener('click', () => {
    const pid = (window.__sfCurrentProjectId && window.__sfCurrentProjectId()) || null;
    openExportVideoDialog(pid);
  });
}
