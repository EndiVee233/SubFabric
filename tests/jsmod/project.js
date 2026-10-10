/* ═══════════ 项目系统 ═══════════
 * 主界面(项目列表 + 新建) / 打开项目 / 字幕实时自动保存 / 波形与音频的项目内缓存。
 * 存储(服务端 projects/<id>/):
 *   project.json   元数据(名称/视频路径/字幕文件/prepare 状态)
 *   subtitle.ass|srt  字幕权威内容(自动保存写这里)
 *   audio.wav      16kHz 单声道(给后续"重新识别"铺路)
 *   peaks.bin      波形包络(打开时直接读, 不再重新生成)
 * 路由: #/home 项目列表 · #/new 新建项目 · #/settings 全局设置
 *       #/project/<id> 编辑器 · #/editor 无项目直开(兼容旧用法/测试)
 */
import { serializeSRT } from './srt.js';
import { parseSRT } from './srt.js';
import { AssDoc } from './ass.js';
// 区域字幕导入（按时间区间裁剪）：纯逻辑模块，有 tests/region-test.mjs 钉住行为
import { normalizeRegion, filterCues, regionSummary } from '../region.js';
import { t } from './i18n.js';
import { ico } from './icons.js';
import { stripEffectTagsSafe } from './postprocess.js';

export function initProjects(ctx) {
  const { state, video, timeline, panel, toast, routeSub, loadVideoUrl, setPlaybackAudioMode, resumeRerecog } = ctx;
  const $ = (s) => document.querySelector(s);

  let lastSavedText = '';      // 上次保存成功的字幕内容(脏检查用)
  let saveTimer = 0;
  let saving = false;
  let pollTimer = 0;
  let nemoPollTimer = 0;       // 盯 NeMo 预检（要导入 PyTorch，30 秒起步）

  const elHome = $('#home-view');
  const elList = $('#home-list');
  const elEmpty = $('#home-empty');
  const detailView = $('#detail-view');
  const pageTimers = new WeakMap();
  let previousRoute = '';
  let settingsReturnRoute = '#/home';
  let settingsVisit = 0;
  let settingsOpenedFromApp = false;
  let newOpenedFromApp = false;
  let detailReturnRoute = '#/home';
  let detailsOpenedFromApp = false;
  let detailLoadToken = 0;

  // 离场视图短暂保留以完成淡出；快速往返时取消旧定时器，避免误隐藏新页面。
  function setPageVisible(page, visible) {
    clearTimeout(pageTimers.get(page));
    page.inert = !visible;
    if (visible) {
      page.classList.remove('is-leaving');
      page.hidden = false;
    } else if (!page.hidden) {
      page.classList.add('is-leaving');
      pageTimers.set(page, setTimeout(() => {
        page.hidden = true;
        page.classList.remove('is-leaving');
      }, 200));
    }
  }
  function focusPage(page) {
    requestAnimationFrame(() => {
      const heading = page.querySelector('.page-intro h1');
      if (!page.hidden && heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    });
  }
  function replaceRoute(route) {
    history.replaceState(null, '', route);
    applyHash();
  }
  function returnFromSettings() {
    // 设置页里改了什么（翻译配置 / 分角色 / 下载或删了模型）这边都不知道，
    // 所以统一作废生成设置面板的缓存，下次进页面重新拉。
    genAsr = genTr = genCast = null;
    if (settingsOpenedFromApp) history.back();
    else replaceRoute(settingsReturnRoute === '#/settings' ? '#/home' : settingsReturnRoute);
  }
  function returnFromDetails() {
    if (detailsOpenedFromApp && location.hash.startsWith('#/details/')) history.back();
    else replaceRoute(detailReturnRoute.startsWith('#/details/') ? '#/home' : detailReturnRoute);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ─────────── 生成设置面板（新建项目 / 详细信息 共用同一份逻辑） ───────────
   * 两个页面的面板结构一模一样，只有 id 前缀不同（np- / dt-），所以逻辑只写一份。
   * 语音识别 / 翻译模型 / 模型名称 / 翻译提示词 / 角色分析提示词 / 分角色开关
   * 都是**全局设置**（asr/settings.json），点「保存设置」才写回；
   * 「自动区分说话人」是项目级参数：新建时选定，详细信息里只读回显。 */
  const ENGINE_LABEL = {
    'whisper.cpp': '本地 · whisper.cpp',
    'sherpa-onnx': '本地 · Parakeet',
    nemo: '本地 · NeMo（多说话人）',
    bcut: '云端 · 必剪 ASR',
    capcut: '云端 · 剪映 ASR',
  };
  const engineLabel = (e) => ENGINE_LABEL[e] || (e ? String(e) : '未知引擎');

  const GEN_IDS = {
    np: { asr: '#np-model-sel', provider: '#np-set-provider', model: '#np-set-model',
          cast: '#np-set-cast', source: '#np-set-source',
          prompt: '#np-set-prompt', castPrompt: '#np-set-castprompt',
          save: '#np-set-save', state: '#np-set-state' },
    dt: { asr: '#dt-model-sel', provider: '#dt-set-provider', model: '#dt-set-model',
          cast: '#dt-set-cast', source: '#dt-set-source',
          prompt: '#dt-set-prompt', castPrompt: '#dt-set-castprompt',
          save: '#dt-set-save', state: '#dt-set-state' },
  };
  const genEls = (scope) => {
    const src = GEN_IDS[scope] || {}, out = {};
    for (const k of Object.keys(src)) out[k] = $(src[k]);
    return out;
  };
  let genAsr = null, genTr = null, genCast = null;    // 三份缓存，两个面板共用

  function genSetState(scope, text) {
    const el = $(GEN_IDS[scope].state);
    if (el) el.textContent = text;
  }
  /** 按「识别来源」选中的引擎过滤「语音识别」下拉 */
  function genFillModels(scope) {
    const e = genEls(scope);
    if (!e.asr) return;
    const pool = ((genAsr && genAsr.models) || []).filter(m => m.ready && m.draftAllowed !== false);
    const want = e.source ? e.source.value : '';
    const list = want ? pool.filter(m => (m.engine || '') === want) : pool;
    const keep = e.asr.value;
    e.asr.innerHTML = list.length
      ? list.map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('')
      : '<option value="">（该来源下没有可用模型，去设置里下载）</option>';
    if (keep && list.some(m => m.id === keep)) e.asr.value = keep;
    else if (genAsr && genAsr.selectedModel && list.some(m => m.id === genAsr.selectedModel)) e.asr.value = genAsr.selectedModel;
  }
  /** 把三份配置铺到某个面板上 */
  function genRender(scope) {
    const e = genEls(scope);
    if (genAsr) {
      if (e.source) {
        const engines = [];
        let selEngine = '';
        for (const m of genAsr.models || []) {
          if (!(m.ready && m.draftAllowed !== false) || !m.engine) continue;
          if (engines.indexOf(m.engine) < 0) engines.push(m.engine);
          // 记住当前默认模型属于哪个引擎：没得继承时才用它当「识别来源」，免得把默认模型换掉
          if (m.id === genAsr.selectedModel) selEngine = m.engine;
        }
        const keep = e.source.value;
        e.source.innerHTML = engines.length
          ? engines.map(x => '<option value="' + esc(x) + '">' + esc(engineLabel(x)) + '</option>').join('')
          : '<option value="">（没有可用引擎）</option>';
        if (keep && engines.indexOf(keep) >= 0) e.source.value = keep;
        else if (selEngine) e.source.value = selEngine;
      }
      genFillModels(scope);
    }
    if (genTr) {
      const presets = genTr.presets || [];
      const cfg = genTr.cfg || {};
      if (e.provider) {
        e.provider.innerHTML = presets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>').join('');
        if (cfg.provider) e.provider.value = cfg.provider;
      }
      if (e.model) {
        const p = presets.find(x => x.id === cfg.provider) || {};
        e.model.value = cfg.model || p.model || '';
        e.model.placeholder = p.model || 'deepseek-chat';
      }
      if (e.prompt) e.prompt.value = cfg.prompt || '';
    }
    if (genCast) {
      if (e.cast) e.cast.checked = genCast.enabled !== false;
      if (e.castPrompt) e.castPrompt.value = genCast.prompt || '';
    }
  }
  /** 拉三份配置；有缓存就不重复拉（force=true 时强制刷新） */
  async function genLoad(scope, force) {
    try {
      if (force || !genAsr) genAsr = await (await fetch('/api/asr/status')).json();
      if (force || !genTr) genTr = await (await fetch('/api/translate/config')).json();
      if (force || !genCast) genCast = await (await fetch('/api/cast/config')).json();
    } catch { /* 拉不到就保持旧值，别打断页面 */ }
    genRender(scope);
    genSetState(scope, (genTr && genTr.ready) ? '已配置' : '翻译未配置');
  }
  /** 保存：只写全局那几项；项目级的（逐词/说话人）不在这里动 */
  async function genSave(scope) {
    const e = genEls(scope);
    const btn = e.save;
    const oldLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      const jobs = [
        fetch('/api/translate/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: e.provider ? e.provider.value : undefined,
            model: e.model ? e.model.value.trim() : undefined,
            prompt: e.prompt ? e.prompt.value : undefined,
          }),
        }),
        fetch('/api/cast/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !!(e.cast && e.cast.checked), prompt: e.castPrompt ? e.castPrompt.value : '' }),
        }),
      ];
      if (e.asr && e.asr.value) {
        jobs.push(fetch('/api/asr/select', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: e.asr.value }),
        }));
      }
      const rs = await Promise.all(jobs);
      const bad = rs.find(r => !r.ok);
      if (bad) {
        const m = await bad.json().catch(() => ({}));
        toast(m.error || '保存失败', 4600);
        genSetState(scope, '保存失败');
        return;
      }
      genAsr = genTr = genCast = null;      // 让两个面板下次都拿到新值
      genSetState(scope, '已保存');
      toast('生成设置已保存');
    } catch (err) {
      genSetState(scope, '保存失败');
      toast('保存失败: ' + err.message, 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldLabel; }
    }
  }
  for (const scope of ['np', 'dt']) {
    const e = genEls(scope);
    if (e.save) e.save.addEventListener('click', () => genSave(scope));
    if (e.source) e.source.addEventListener('change', () => { genFillModels(scope); genSetState(scope, '未保存'); });
    for (const k of ['provider', 'model', 'prompt', 'castPrompt', 'cast']) {
      const el = e[k];
      if (!el) continue;
      el.addEventListener((el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input',
        () => genSetState(scope, '未保存'));
    }
  }

  /* ─────────── 稿件预览：把视频元数据铺到预览面板 ─────────── */
  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    return (h ? h + ':' : '') + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  /** prefix: 'np' | 'detail' —— 两页预览面板的 id 前缀不同，结构一样 */
  function fillPreview(prefix, source) {
    const s = source || null;
    const has = !!(s && (s.title || s.uploader || s.description));
    const thumb = $('#' + prefix + '-thumb');
    const empty = $('#' + prefix + '-preview-empty');
    if (thumb) {
      if (s && s.thumbnail) {
        // b 站图床有防盗链：带上 localhost 的 Referer 会 403，索性不发
        thumb.referrerPolicy = 'no-referrer';
        if (thumb.getAttribute('src') !== s.thumbnail) thumb.src = s.thumbnail;
        thumb.alt = s.title || '视频缩略图';
        thumb.hidden = false;
      } else {
        thumb.hidden = true;
        thumb.removeAttribute('src');
      }
      if (!thumb.dataset.errBound) {
        thumb.dataset.errBound = '1';
        // 图裂了别留个破图标：收起来，退回空态说明（文字信息还在下面）
        thumb.addEventListener('error', () => {
          thumb.hidden = true;
          const box = $('#' + prefix + '-preview-empty');
          if (box) box.hidden = false;
        });
      }
    }
    if (empty) empty.hidden = !!(s && (s.thumbnail || has));
    const set = (id, v) => { const el = $(id); if (el) el.textContent = (v === undefined || v === null || v === '') ? '—' : String(v); };
    set('#' + prefix + '-m-title', s && s.title);
    set('#' + prefix + '-m-uploader', s && s.uploader);
    const durEl = $('#' + prefix + '-m-duration');
    if (durEl) durEl.textContent = (s && s.duration) ? fmtDuration(s.duration) : '—';
    set('#' + prefix + '-m-desc', s && s.description);
    return has;
  }

  let detailProjectId = '';
  const detailForm = $('#detail-form');
  const detailName = $('#detail-name');
  const detailError = $('#detail-error');
  const detailSave = $('#detail-save');
  function openProjectDetails(project) {
    const id = project && project.id;
    if (!id) return;
    const route = '#/details/' + encodeURIComponent(id);
    detailReturnRoute = location.hash.startsWith('#/details/') ? '#/home' : (location.hash || '#/home');
    detailsOpenedFromApp = true;
    if (location.hash === route) loadDetailsPage(id);
    else location.hash = route;
  }
  async function loadDetailsPage(id) {
    const requestId = ++detailLoadToken;
    detailProjectId = id;
    detailName.value = '';
    detailError.textContent = '';
    detailError.hidden = true;
    $('#detail-video').textContent = '读取中…';
    $('#detail-subtitle').textContent = '—';
    $('#detail-format').textContent = '—';
    $('#detail-created').textContent = '—';
    $('#detail-modified').textContent = '—';
    // 处理进度面板在 2×2 骨架里是常驻的四块之一，不能整块隐藏
    // （有没有初稿任务只决定里面显示日志还是空态说明，见下面 dp-idle / dp-body）
    let project;
    try {
      const response = await fetch('/api/projects/' + encodeURIComponent(id));
      project = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(project.error || '读取项目失败');
    } catch (error) {
      if (requestId !== detailLoadToken || location.hash !== '#/details/' + id) return;
      detailError.textContent = error.message || '读取项目失败';
      detailError.hidden = false;
      $('#detail-video').textContent = '无法读取';
      return;
    }
    if (requestId !== detailLoadToken || location.hash !== '#/details/' + id) return;
    detailName.value = project.name || '';
    $('#detail-video').textContent = project.fetching ? '正在下载…' : (project.video && project.video.name || '未关联视频');
    $('#detail-subtitle').textContent = (project.subtitle && project.subtitle.name) || '尚无字幕';
    $('#detail-format').textContent = String((project.subtitle && project.subtitle.format) || (project.draft ? '初稿' : '—')).toUpperCase();
    $('#detail-created').textContent = fmtDate(project.createdAt) || '—';
    $('#detail-modified').textContent = fmtDate(project.modifiedAt) || '—';
    // 稿件预览：从链接创建的项目带 source（标题/作者/简介/缩略图），本地文件没有
    fillPreview('detail', project.source);
    // 生成设置里的全局项；「自动区分说话人」是项目级参数，这里只回显当时的选择
    const spk = $('#dt-set-speakers');
    if (spk) { spk.checked = !!(project.draft && project.draft.speakers); spk.disabled = true; }
    // 逐句置信度也是项目级：存的是档位 off/fast/full；
    // 空值 = 当初选了"跟随全局"，回显成全局的当前档位
    const cf = $('#dt-set-confidence');
    if (cf) {
      cf.disabled = true;
      const v = project.draft ? project.draft.confidence : undefined;
      if (CONF_MODES.includes(v)) cf.value = v;
      else {
        cf.value = asrConfDefaultCache || 'full';        // 已知的全局值，先填上避免闪一下
        fetch('/api/asr/confidence').then(r => r.json())
          .then(d => { asrConfDefaultCache = d.mode; if (CONF_MODES.includes(d.mode)) cf.value = d.mode; })
          .catch(() => {});
      }
    }
    genLoad('dt');
    // 处理进度：有初稿任务才给日志与操作按钮，否则换成一句空态说明（别留个空洞）
    const live = !!project.draft;
    const idleEl = $('#dp-idle'), bodyEl = $('#dp-body');
    if (idleEl) idleEl.hidden = live;
    if (bodyEl) bodyEl.hidden = !live;
    if (live) {
      openProgress(id);
    } else {
      stopDp();
      dpId = '';
      renderDpSteps(-1);
      $('#dp-bar-in').style.width = '0%';
      $('#dp-bar-in').classList.remove('err', 'ok');
      $('#dp-pct').textContent = '0%';
      $('#dp-msg').textContent = '尚未开始';
    }
  }
  $('#detail-back').addEventListener('click', returnFromDetails);
  $('#detail-cancel').addEventListener('click', returnFromDetails);
  $('#dp-close').addEventListener('click', returnFromDetails);
  detailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = detailProjectId;
    const name = detailName.value.trim();
    if (!id || !name) {
      detailError.textContent = '项目名称不能为空';
      detailError.hidden = false;
      detailName.focus();
      return;
    }
    const oldLabel = detailSave.textContent;
    detailSave.disabled = true;
    detailSave.textContent = '保存中…';
    detailError.textContent = '';
    detailError.hidden = true;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/info`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        detailError.textContent = result.error || '保存失败，请重试';
        detailError.hidden = false;
        return;
      }
      if (state.project && state.project.id === id && state.project.meta) {
        state.project.meta.name = result.name || name;
        state.project.meta.nameCustomized = true;
        state.project.meta.modifiedAt = result.modifiedAt || state.project.meta.modifiedAt;
      }
      $('#detail-modified').textContent = fmtDate(result.modifiedAt) || $('#detail-modified').textContent;
      renderList();
      toast('项目信息已更新');
    } catch {
      detailError.textContent = '保存失败，请检查本地服务后重试';
      detailError.hidden = false;
    } finally {
      detailSave.disabled = false;
      detailSave.textContent = oldLabel;
    }
  });

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  /* ─────────── 字幕序列化与自动保存 ─────────── */
  function currentText() {
    if (state.format === 'ass' && state.assDoc) return state.assDoc.serialize();
    if (state.format === 'srt') return serializeSRT(state.srtCues);
    return '';
  }
  function setSaveState(cls, text) {
    const el = $('#save-state');
    if (!el) return;
    el.hidden = !state.project;
    el.className = 'save-state' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }
  function scheduleSave() {
    if (!state.project) return;
    setSaveState('', '● 有未保存更改');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1200);
  }
  async function saveNow() {
    if (!state.project) return;
    if (saving) { scheduleSave(); return; }       // 上一轮未完成, 稍后再存
    const text = currentText();
    if (!text || text === lastSavedText) return;
    saving = true;
    setSaveState('saving', '保存中…');
    try {
      const r = await fetch(`/api/projects/${state.project.id}/subtitle`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text
      });
      if (r.ok) {
        lastSavedText = text;
        const d = await r.json().catch(() => ({}));
        if (state.project && state.project.meta) state.project.meta.modifiedAt = d.savedAt;
        setSaveState('saved', '已保存 ' + new Date().toTimeString().slice(0, 5));
      } else setSaveState('', '⚠ 保存失败(稍后自动重试)');
    } catch {
      setSaveState('', '⚠ 保存失败(稍后自动重试)');
    }
    saving = false;
  }
  // 页面关闭/刷新兜底: 未保存的改动用 sendBeacon 补一刀(服务端 PUT/POST 都收)
  window.addEventListener('beforeunload', () => {
    if (!state.project) return;
    clearTimeout(saveTimer);
    const text = currentText();
    if (text && text !== lastSavedText) {
      navigator.sendBeacon(`/api/projects/${state.project.id}/subtitle`, new Blob([text], { type: 'text/plain' }));
    }
  });

  /* ─────────── 波形(项目缓存) ─────────── */
  async function loadPeaks() {
    try {
      const r = await fetch(`/api/projects/${state.project.id}/peaks`);
      if (!r.ok) return false;                     // 未就绪: prepare 轮询完成后会再调
      const data = new Uint8Array(await r.arrayBuffer());
      timeline.setPeaks({ data, rate: parseFloat(r.headers.get('X-Peak-Rate') || '100'), ch: +(r.headers.get('X-Peak-Ch') || 2) });
      toast('波形已就绪(来自项目缓存)', 2000);
      return true;
    } catch { return false; }
  }

  /** prepare 状态处理: running→轮询 / done→直接读 / 缺失→自动补跑一次(无音轨的不重试) */
  function handlePrepare(m) {
    clearInterval(pollTimer);
    const st = m.prepare && m.prepare.status;
    if (st === 'running') return pollPrepare();
    if (st === 'done' && m.hasPeaks) return loadPeaks();
    if (st === 'error') {
      const msg = (m.prepare && m.prepare.error) || '';
      toast('音频/波形提取失败: ' + msg, 4200);
      if (/没有音轨/.test(msg)) return;
    }
    if (!m.hasPeaks && m.videoExists) retryPrepare();
  }
  async function retryPrepare() {
    try {
      const r = await fetch(`/api/projects/${state.project.id}/prepare`, { method: 'POST' });
      const m2 = await r.json();
      if (r.ok) { state.project.meta = m2; pollPrepare(); }
      else toast(m2.error || '波形提取启动失败', 3600);
    } catch { toast('波形提取启动失败', 3600); }
  }
  function pollPrepare(onDone) {
    if (pollTimer) return;
    toast('正在提取音频与波形…(完成后自动显示)', 4200);
    pollTimer = setInterval(async () => {
      let m;
      try { m = await (await fetch(`/api/projects/${state.project.id}`)).json(); } catch { return; }
      if (!state.project) return clearInterval(pollTimer), pollTimer = 0;
      state.project.meta = m;
      const st = m.prepare && m.prepare.status;
      if (st === 'done') {
        clearInterval(pollTimer); pollTimer = 0;
        loadPeaks();
        syncAudioModeUI(m);
        if (onDone) onDone(m);
        toast('音频与波形已就绪', 2600);
      } else if (st === 'error') {
        clearInterval(pollTimer); pollTimer = 0;
        toast('音频/波形提取失败: ' + ((m.prepare && m.prepare.error) || ''), 4200);
      }
    }, 1500);
  }

  /* ─────────── 音频源(原视频 / 降噪后)与重新生成 ───────────
   * meta.audio.mode 记录当前 audio.wav 的来源; 播放音轨跟随它:
   * 降噪后 → 视频静音, 播 audio.wav(ASR 听到的就是它, 方便判断降噪过头/不够); 原视频 → 正常视频出声。 */
  function syncAudioModeUI(m, bustCache) {
    const sel = $('#audio-mode');
    // 默认未降噪(原视频); 用户显式切换过则记住其偏好(跨会话)
    const saved = localStorage.getItem('sf-audio-mode');
    const mode = saved || (m.audio && m.audio.mode) || 'raw';
    if (sel) sel.value = mode;
    setPlaybackAudioMode(mode, !!m.hasAudio, bustCache);
  }
  async function regenAudio() {
    if (!state.project) return;
    const btn = $('#btn-regen-audio');
    const mode = ($('#audio-mode') && $('#audio-mode').value) || 'raw';
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '提取中…';
    try {
      const r = await fetch(`/api/projects/${state.project.id}/prepare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, force: true })
      });
      const m2 = await r.json();
      if (!r.ok) { toast(m2.error || '重新生成失败', 3600); return; }
      state.project.meta = m2;
      pollPrepare((m) => syncAudioModeUI(m, true));   // 完成后换新音频(时间戳破缓存)并刷新播放音轨
    } catch { toast('重新生成失败', 3600); }
    finally { btn.disabled = false; btn.textContent = old; }
  }
  const audioModeSel = $('#audio-mode');
  if (audioModeSel) audioModeSel.addEventListener('change', () => {
    // 「音频源」= 播放用哪条音轨, 与"重建 audio.wav"是两回事:
    //   原视频 → 直接放视频自带原声(不必等提取); 降噪后 → 播放项目里降噪过的 audio.wav。
    // 以前这里只弹提示、播放音轨要等点了「↻ 重新生成音频」才变, 于是"切不回原声"。
    const want = audioModeSel.value;
    const cur = (state.project && state.project.meta && state.project.meta.audio && state.project.meta.audio.mode) || 'raw';
    const hasAudio = !!(state.project && state.project.meta && state.project.meta.hasAudio);
    // 播放音轨立刻切: 未提取过的那一侧只能先退回视频原声(无法凭空变出降噪音频)
    const playable = want === 'raw' ? null : (want === cur ? want : null);
    setPlaybackAudioMode(playable, hasAudio);
    localStorage.setItem('sf-audio-mode', want);   // 记住用户显式选择(默认未降噪)
    if (want === cur) toast(t(want === 'denoise' ? '已切换为降噪后音频播放' : '已切换为原视频音频播放'), 3200);
    else toast(t('已切换播放音轨；识别与波形仍是「' + (cur === 'raw' ? '原视频' : '降噪后')
      + '」版本。想按新选择重做识别，点「↻ 重新生成音频」'), 4000);
  });
  const regenBtn = $('#btn-regen-audio');
  if (regenBtn) regenBtn.addEventListener('click', regenAudio);

  /* ─────────── 打开项目 ─────────── */
  async function openProject(pid) {
    let m;
    try {
      const r = await fetch('/api/projects/' + pid);
      m = await r.json();
      if (!r.ok || m.error) throw new Error(m.error || 'HTTP ' + r.status);
    } catch (e) {
      toast('项目加载失败: ' + e.message, 3600);
      location.hash = '#/home';
      return;
    }
    state.project = { id: pid, meta: m, loadPeaks };
    setSaveState('', '自动保存已开启');
    // 备注是按项目存的 —— 切项目要重载（不重载会把上一个项目的备注当弹幕放出来）
    if (typeof window.__notesReload === 'function') window.__notesReload();

    // 1) 字幕: 读项目内权威内容, 走与"打开字幕文件"完全相同的解析入口
    try {
      const text = await (await fetch(`/api/projects/${pid}/subtitle`)).text();
      lastSavedText = text;
      routeSub(text, (m.subtitle && m.subtitle.name) || (m.subtitle && m.subtitle.file) || 'subtitle.ass');
    } catch {
      toast('项目字幕读取失败', 3600);
    }

    // 2) 视频: 按保存的路径经服务端 Range 流式播放; 失效则要求重选
    if (m.videoExists && m.video && m.video.path) {
      loadVideoUrl('/api/media?path=' + encodeURIComponent(m.video.path), m.video.name);
    } else {
      promptRelink(m);
    }

    // 3) 波形/音频: 就绪直接读, 没就绪轮询
    handlePrepare(m);
    syncAudioModeUI(m);          // 音频源下拉回显 + 播放音轨(降噪后→audio.wav 接管发声)
    if (resumeRerecog) resumeRerecog(pid);   // 接回后台还在跑的「选区重新识别」任务(刷新后也能看到进度/拿到结果)
  }

  function promptRelink(m) {
    panel.showConfirm('找不到视频文件',
      `项目「${m.name}」的视频不在原来的位置了：\n${(m.video && m.video.path) || ''}\n\n重新选一次视频就能继续，字幕和波形不受影响。`,
      '重新选择视频', '暂不', () => pickVideoForProject());
  }
  async function pickVideoForProject() {
    // 双通道: 原生对话框优先, 超时/失败自动降级浏览器选择(上传成服务端文件再 relink)
    // 立即提示: 系统对话框开在系统层, 可能被浏览器挡住 —— 用户得知道它已经弹了
    toast('正在打开文件选择窗口…没看到的话看任务栏图标', 2600);
    let pick = null;
    try {
      const ctl = new AbortController();
      const killer = setTimeout(() => ctl.abort(), 38000);
      const r = await fetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'video' }),
        signal: ctl.signal
      });
      clearTimeout(killer);
      pick = await r.json();
    } catch { pick = null; }
    if (!pick || (!pick.path && pick.fallback)) {
      const f = await browserPickVideo();
      if (!f) return;
      toast('正在上传视频…', 4000);
      const up = await fetch('/api/upload-video?name=' + encodeURIComponent(f.name), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f
      });
      const um = await up.json().catch(() => ({}));
      if (!up.ok || !um.path) { toast('视频上传失败: ' + (um.error || up.status), 5000); return; }
      pick = { path: um.path, name: um.name };
    }
    if (!pick.path) {
      if (pick.error) toast(pick.error, 3200);
      return;
    }
    const r = await fetch(`/api/projects/${state.project.id}/relink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: pick.path })
    });
    const m2 = await r.json();
    if (!r.ok) { toast(m2.error || '重新关联失败', 3600); return; }
    state.project.meta = m2;
    loadVideoUrl('/api/media?path=' + encodeURIComponent(pick.path), pick.name || 'video');
    handlePrepare(m2);
    toast('视频已重新关联: ' + (pick.name || ''), 3000);
  }

  /* ─────────── 主界面(项目列表) ─────────── */
  async function showHome() {
    video.pause();
    if (state.project) { saveNow(); }               // 离开编辑器: 把未保存的立刻写掉
    listAnim = true;                                // 只在"进入首页"这一帧播放卡片入场动画
    renderList();
  }
  let listPoll = 0;
  let listAnim = false;                             // 入场动画开关(轮询刷新时不重播, 否则每 1.5s 抖一次)
  const lastPct = new Map();                        // 项目 id → 上次渲染的进度百分比(给平滑增长/数字滚动用)
  async function renderList() {
    // 骨架屏：形状和真实卡片一致, 比"读取中…"那行字少一次布局跳动
    elList.innerHTML = Array.from({ length: 3 }, () =>
      '<div class="skel-row"><div class="skel-b b1"></div><div class="skel-b b2"></div><div class="skel-b b3"></div><div class="skel-b b4"></div></div>').join('');
    elEmpty.hidden = true;
    elList.classList.toggle('anim-in', listAnim);      // 只有"进入首页"那一帧播放入场动画
    listAnim = false;
    let data;
    try { data = await (await fetch('/api/projects')).json(); }
    catch { elList.innerHTML = '<div class="home-loading">读取失败，本地服务可能没启动</div>'; return; }
    const ps = data.projects || [];
    elList.innerHTML = '';
    elEmpty.hidden = ps.length > 0;
    const ST = { running: '提取中', none: '待提取', error: '提取失败' };
    const pctTweens = [];                              // 渲染完统一跑百分比数字滚动
    let cardIdx = 0;
    for (const p of ps) {
      const card = document.createElement('div');
      card.className = 'proj-card' + (p.videoExists || p.fetching ? '' : ' proj-missing');
      // 入场错峰: CSS 用 --i 算 animation-delay（上限 12 档, 项目多了也不会等太久）
      card.style.setProperty('--i', String(Math.min(cardIdx++, 12)));
      const st = p.prepare && ST[p.prepare.status];
      const dr = p.draft || null;
      const hasSub = !!p.format;

      // 有初稿任务时以初稿进度为准(它是 prepare 之后的后半段)
      let stChip = '', draftBar = '', progBtn = '<button type="button" class="btn pc-details">详细信息</button>';
      if (dr && dr.status) {
        const pct = Math.max(0, Math.min(100, dr.progress || 0));
        const running = dr.status === 'running';
        // 阶段文案直接来自服务端(ASR识别中 / 翻译中 / 完毕 …), 跑动时加省略号
        const failed = dr.status === 'error';
        const paused = dr.status === 'paused';   // 初稿已生成、翻译还没做/没做完 —— **不是完毕**
        // 失败时服务端保留了"失败所在阶段"，这里只需要加前缀，避免出现「失败 · 失败」
        const stageTxt = dr.failedStage || dr.stage || '处理中';
        let label;
        if (failed) label = '失败 · ' + stageTxt;
        else if (paused) {
          label = dr.pendingTranslate
            ? `翻译 ${Math.max(0, (dr.lines || 0) - (dr.pendingTranslate || 0))}/${dr.lines || 0} 行`
            : '待翻译';
        } else if (dr.skippedTranslate) label = '已跳过翻译';
        else label = stageTxt;
        const cls = dr.status === 'done' ? 'done' : failed ? 'error' : paused ? 'paused' : 'running';
        stChip = ` <span class="pc-st st-${cls}">${esc(running ? label + '...' : label)}</span>`;
        // 进度条：从"上次渲染到的百分比"平滑长到新值（CSS 用 --from 做起点, 终点就是元素自身 width）
        const from = lastPct.has(p.id) ? lastPct.get(p.id) : 0;
        lastPct.set(p.id, pct);
        draftBar = `
          <div class="pc-draft ${esc(dr.status)}">
            <div class="pc-draft-bar"><div class="pc-draft-bar-in" style="width:${pct}%;--from:${from}%"></div></div>
            <div class="pc-draft-txt"><span>${esc(dr.message || label)}</span><span class="pct" data-pct="${pct}" data-from="${from}">${from}%</span></div>
          </div>`;
        pctTweens.push(pct);
        // 可重试/可开始翻译：彻底失败、等待翻译、或翻译只完成了一部分（已跳过的不算）
        const canRetry = (failed || paused
          || (dr.status === 'done' && !dr.translated && !!dr.needTranslate)) && !dr.skippedTranslate;
        const retryLabel = paused ? (dr.pendingTranslate ? '重试' : '开始翻译') : '重试';
        progBtn = '<button type="button" class="btn pc-details">详细信息</button>';
        if (canRetry) progBtn += `<button type="button" class="btn btn-accent pc-retry">${esc(retryLabel)}</button>`;
        else if (dr.skippedTranslate) progBtn += '<button type="button" class="btn pc-trans">翻译</button>';
      } else if (st) {
        stChip = ` <span class="pc-st st-${p.prepare.status}">${st}</span>`;
      }

      const fmt = p.format;
      const badge = fmt === 'srt' ? 'SRT' : (fmt === 'ass' ? 'ASS' : (dr ? '初稿' : 'ASS'));
      const locked = !!dr && !hasSub;           // 还没有字幕文件时进去也没内容可读（失败在识别阶段就是这种）
      const missingTag = (p.videoExists || p.fetching) ? '' : ` <span class="pc-missing">${ico('alert')}找不到这个视频</span>`;
      card.innerHTML = `
        <span class="pc-badge ${fmt === 'srt' ? 'srt' : ''}">${badge}</span>
        <div class="pc-main">
          <div class="pc-name">${esc(p.name)}${missingTag}${stChip}</div>
          <div class="pc-meta">${esc(p.fetching ? '正在下载…' : (p.video && p.video.name || '无视频'))} · ${esc(p.subName || (dr ? '初稿处理中…' : '还没字幕'))} · 修改于 ${fmtDate(p.modifiedAt)}</div>
          ${draftBar}
        </div>
        <div class="pc-actions">
          ${progBtn}
          <button type="button" class="btn btn-accent pc-open" ${locked ? 'disabled' : ''}>打开</button>
          <button type="button" class="btn pc-del ico-only" title="删除项目（音频、波形、字幕副本一起删）">${ico('trash')}</button>
        </div>`;
      card.querySelector('.pc-details').addEventListener('click', (e) => {
        e.stopPropagation();
        openProjectDetails(p);
      });
      card.querySelector('.pc-open').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!locked) location.hash = '#/project/' + p.id;
      });
      card.addEventListener('click', () => { if (!locked) location.hash = '#/project/' + p.id; });
      const tb = card.querySelector('.pc-trans');
      if (tb) tb.addEventListener('click', (e) => { e.stopPropagation(); requestTranslate(p.id); });
      const rb = card.querySelector('.pc-retry');
      if (rb) rb.addEventListener('click', (e) => { e.stopPropagation(); requestRetry(p.id); });
      card.querySelector('.pc-del').addEventListener('click', (e) => {
        e.stopPropagation();
        panel.showConfirm('删除项目',
          `要删掉项目「${p.name}」吗？\n项目里的字幕副本、音频和波形会一起删掉，原始字幕文件和视频不动。`,
          '删除', '取消', async () => {
            const r = await fetch('/api/projects/' + p.id, { method: 'DELETE' });
            const m = await r.json().catch(() => ({}));
            if (r.ok) {
              if (state.project && state.project.id === p.id) detachProject();
              renderList();
              toast('已删除项目「' + p.name + '」');
            } else toast('删除失败：' + (m.error || '未知原因'), 6000);
          });
      });
      elList.appendChild(card);
    }

    // 进度百分比数字滚动：从上次的值数到新值（列表每 1.5s 重建一次, 这样看起来是"在走"而不是"跳"）
    // 420ms 必须与 ui.css 里 .pc-draft-bar-in 的 bar-from 动画时长一致 —— 否则动画期间
    // "条的百分比"和"这个数字"会对不上（用户报的"进度条不一致"）。改这里就一起改那边。
    for (const el of elList.querySelectorAll('.pct[data-pct]')) {
      countTo(el, Number(el.dataset.from) || 0, Number(el.dataset.pct) || 0, 420);
    }

    // 有任务在跑就自动刷新, 让列表上的进度自己往前走
    clearTimeout(listPoll);
    if (ps.some(p => (p.prepare && p.prepare.status === 'running') || (p.draft && p.draft.status === 'running'))) {
      listPoll = setTimeout(() => renderList(), 1500);
    }
  }

  /** 数字滚动：把 el 的文本从 a 数到 b（含 % 后缀），rAF 驱动, 只用于很短的过渡 */
  function countTo(el, a, b, ms) {
    if (!el) return;
    if (a === b || Math.abs(b - a) < 1) { el.textContent = b + '%'; return; }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = b + '%'; return; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      // 必须与 ui.css 的 bar-from 动画**同时长(420ms)同缓动(线性)**: 两边不一致时,
      // 动画期间"条的百分比"与这个数字会明显对不上（用户报的"进度条不一致"；
      // 旧版条是 cubic-bezier(.16,1,.3,1)、数字是三次缓出, 实测最大差 18~40 个百分点）。
      const e = k;
      el.textContent = Math.round(a + (b - a) * e) + '%';
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ─────────── 初稿进度浮层 ─────────── */
  // 步骤条：与 server.js 的 STAGE 文案一一对应，**顺序与服务端流水线一致**：
  // 识别 → 语义分句 → 说话人分离 → 翻译 → 完毕（分句先把行切开，分离再往这些行上标说话人）。
  // enabled=false 的是尚未实现的步骤（灰显）；skippable 只对可选步骤为真 ——
  // **语音识别与 LLM 翻译不可跳过**。
  // 与 server.js 的 SKIP_AFTER_RETRIES 保持一致：手动续跑满这次数仍不成功就放开「跳过此步」
  const SKIP_AFTER_RETRIES = 3;
  const DP_STEPS = [
    // skipAfterRetries = 重试满 N 次仍失败后允许跳过；语音识别永远不可跳
    { name: '语音识别', enabled: true, skippable: false, skipAfterRetries: false, stages: ['提取音频中', 'ASR识别中'] },
    { name: '语义分句', enabled: true, skippable: true, skipAfterRetries: true, stages: ['语义分句中'] },
    { name: '说话人分离', enabled: true, skippable: true, skipAfterRetries: true, stages: ['区分说话人中'] },
    { name: '翻译', enabled: true, skippable: false, skipAfterRetries: true, stages: ['翻译中'] },
    { name: '完成', enabled: true, skippable: false, skipAfterRetries: false, stages: ['完毕'] },
  ];
  const stepIndexOf = (stage) => {
    const i = DP_STEPS.findIndex(s => s.stages.indexOf(stage) >= 0);
    return i < 0 ? 0 : i;
  };

  let dpTimer = 0, dpId = '', dpRunning = false, dpRetryable = false;
  function stopDp() { clearInterval(dpTimer); dpTimer = 0; }

  /** 步骤条渲染。target 缺省是详细信息页的 #dp-steps；
   *  新建项目页传 '#np-steps' 画一条全灰的静态预览（curIdx = -1）。 */
  function renderDpSteps(curIdx, target) {
    const box = $(target || '#dp-steps');
    if (!box) return;
    box.innerHTML = DP_STEPS.map((s, i) => {
      const cls = !s.enabled ? 'off' : (i < curIdx ? 'done' : (i === curIdx ? 'current' : ''));
      const tip = s.enabled ? s.name : (s.name + '（尚未实现）');
      return `<span class="dp-step ${cls}" title="${esc(tip)}"><span class="n">${i + 1}</span>${esc(s.name)}</span>`;
    }).join('');
  }
  function applyDpButtons(curIdx, retries) {
    const st = DP_STEPS[curIdx] || {};
    const skip = $('#dp-skip');
    // 平时不可跳过；手动续跑满 SKIP_AFTER_RETRIES 次仍不成功才放开（语音识别永远不可跳）
    const canSkip = !dpRunning && retries >= SKIP_AFTER_RETRIES && !!st.skipAfterRetries;
    skip.disabled = !canSkip;
    skip.title = canSkip
      ? '跳过此步：保留已识别/已翻译的内容，不再继续重试'
      : (retries >= SKIP_AFTER_RETRIES
          ? '该步骤不可跳过（语音识别不可跳过）'
          : `连续失败 ${SKIP_AFTER_RETRIES} 次后可以跳过（已重试 ${retries} 次）`);
    $('#dp-retry').hidden = dpRunning || !dpRetryable;
    const hint = $('#dp-retries');
    hint.textContent = (!dpRunning && dpRetryable && retries > 0)
      ? `已重试 ${Math.min(retries, SKIP_AFTER_RETRIES)}/${SKIP_AFTER_RETRIES} 次` + (canSkip ? '，可跳过此步' : '')
      : '';
  }

  function openProgress(id) {
    dpId = id;
    $('#dp-log').textContent = '';
    $('#dp-bar-in').style.width = '0%';
    $('#dp-pct').textContent = '0%';
    stopDp();
    tickDp();
    dpTimer = setInterval(tickDp, 1200);
  }

  $('#dp-retry').addEventListener('click', async () => {
    const btn = $('#dp-retry');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '重试中…';
    try {
      const r = await fetch('/api/projects/' + dpId + '/retry', { method: 'POST' });
      const m = await r.json();
      if (!r.ok) { toast(m.error || '重试失败', 4600); return; }
      const from = m.from === 'translate' ? '翻译' : (m.from === 'asr' ? '语音识别' : (m.from === 'reseg' ? '语义分句' : '音频提取'));
      toast('已从「' + from + '」继续，已完成的进度不会丢', 4200);
      startDp();
    } catch (e) { toast('重试失败: ' + e.message, 3600); }
    finally { btn.disabled = false; btn.textContent = label; }
  });

  $('#dp-skip').addEventListener('click', async () => {
    const btn = $('#dp-skip');
    btn.disabled = true;
    try {
      const r = await fetch('/api/projects/' + dpId + '/skip', { method: 'POST' });
      const m = await r.json();
      if (!r.ok) { toast(m.error || '跳过失败', 4600); return; }
      const d2 = m.draft || {};
      toast(d2.resegSkipped ? '已跳过语义分句：改用标点和停顿切句，继续处理'
        : d2.diarizeSkipped ? '已跳过说话人分离：不写角色标注，流水线继续'
        : '已跳过翻译：保留语音识别结果，之后仍可点「翻译」补中文', 4800);
      startDp();
    } catch (e) { toast('跳过失败: ' + e.message, 3600); }
    finally { btn.disabled = false; }
  });

  function startDp() {
    stopDp();
    tickDp();
    dpTimer = setInterval(tickDp, 1200);
  }

  async function tickDp() {
    let m;
    try { m = await (await fetch('/api/projects/' + dpId + '/draft')).json(); } catch { return; }
    const d = m.draft || {};
    dpRunning = d.status === 'running';
    // 可重试/可开始翻译：彻底失败、等待翻译(paused)、或翻译只完成了一部分
    dpRetryable = (d.status === 'error' || d.status === 'paused'
      || (d.status === 'done' && !d.translated && !!d.needTranslate)) && !d.skippedTranslate;

    const curIdx = d.status === 'done' ? DP_STEPS.length - 1 : stepIndexOf(d.failedStage || d.stage);
    renderDpSteps(curIdx);
    applyDpButtons(curIdx, d.retries || 0);

    const pct = Math.max(0, Math.min(100, d.progress || 0));
    $('#dp-bar-in').style.width = pct + '%';
    $('#dp-bar-in').classList.toggle('err', d.status === 'error');
    $('#dp-bar-in').classList.toggle('ok', d.status === 'done' && !!d.translated);
    $('#dp-pct').textContent = pct + '%';
    // 还一行都没翻 → 「开始翻译」；翻了一部分或失败 → 「重试」
    $('#dp-retry').textContent = (d.status === 'paused' && !d.pendingTranslate) ? '开始翻译' : '重试';
    const msgEl = $('#dp-msg');
    msgEl.textContent = d.error ? ('✗ ' + d.error) : (d.message || '');
    msgEl.classList.toggle('dp-err', !!d.error);

    const logEl = $('#dp-log');
    if (typeof m.log === 'string' && logEl.textContent !== m.log) {
      // 日志是多行文本：逐行剥掉时间戳前缀后过词典（服务端文案也能改）
      logEl.textContent = m.log.split('\n').map(l =>
        l.replace(/^(\[\d{2}:\d{2}:\d{2}\]\s*)([\s\S]*)$/, (all, pre, rest) => pre + t(rest))).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
    if (!dpRunning) { stopDp(); renderList(); }
  }

  /* ─────────── 手动触发翻译 ─────────── */
  async function requestTranslate(id) {
    let r, m;
    try {
      r = await fetch('/api/projects/' + id + '/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      });
      m = await r.json();
    } catch (e) { toast('翻译启动失败: ' + e.message, 3600); return; }
      if (!r.ok) { toast(m.error || '翻译启动失败', 4600); return; }
      renderList();
      toast(m.queued ? '识别仍在进行，翻译已排队，完成后自动开始' : '已开始翻译，进度见项目列表', 4200);
  }

  /* ─────────── 重试：LLM 步骤失败后从这里续跑，已有进度不丢 ─────────── */
  async function requestRetry(id) {
    let r, m;
    try {
      r = await fetch('/api/projects/' + id + '/retry', { method: 'POST' });
      m = await r.json();
    } catch (e) { toast('重试失败: ' + e.message, 3600); return; }
    if (!r.ok) { toast(m.error || '重试失败', 4600); return; }
    const from = m.from === 'translate' ? '翻译' : (m.from === 'asr' ? '语音识别' : '音频提取');
    renderList();
    openProjectDetails({ id });
    toast('已从「' + from + '」继续，已完成的进度不会丢', 4200);
  }

  /* ─────────── 设置(识别模型 / 字幕翻译) ─────────── */
  const stView = $('#st-view');
  let stPresets = [];

  /* ── 全局设置: 页签切换 + 热词块状编辑(一格一个单词) ── */
  document.querySelectorAll('.st-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.st-tab').forEach(t => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.st-panel').forEach(p => {
      const active = p.dataset.stp === tab.dataset.stp;
      p.classList.toggle('active', active);
      p.hidden = !active;
    });
  }));
  function hotwordRow(val) {
    const row = document.createElement('div');
    row.className = 'hotword-row';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'st-input hotword-input'; inp.spellcheck = false;
    inp.placeholder = '一个单词'; inp.value = val || '';
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const add = $('#ah-add'); if (add) add.click(); }
    });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn btn-mini hotword-del'; del.textContent = '−'; del.title = '删除该热词';
    row.append(inp, del);
    return row;
  }
  function renderHotwords(words) {
    const list = $('#ah-terms-list');
    if (!list) return;
    list.innerHTML = '';
    (words && words.length ? words : ['']).forEach(w => list.appendChild(hotwordRow(w)));
  }
  function collectHotwords() {
    const seen = new Set(), out = [];
    document.querySelectorAll('#ah-terms-list .hotword-input').forEach(inp => {
      String(inp.value || '').split(/\s+/).forEach(w => {
        w = w.trim();
        if (!w) return;
        const k = w.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k); out.push(w);
      });
    });
    return out.join(', ');
  }
  const ahAdd = $('#ah-add');
  if (ahAdd) ahAdd.addEventListener('click', () => {
    const list = $('#ah-terms-list');
    if (!list) return;
    const row = hotwordRow('');
    list.appendChild(row);
    row.querySelector('input').focus();
  });
  const ahList = $('#ah-terms-list');
  if (ahList) ahList.addEventListener('click', (e) => {
    const del = e.target.closest('.hotword-del');
    if (del) del.closest('.hotword-row').remove();
  });

  /* ═══════════ 从操作日志挖热词 ═══════════
   * 用户把 A 改成 B（多半是纠正 ASR 听错的专有名词），这条记录就是"B 才是对的词"的弱标注。
   * 把 B 喂回 ASR 当热词，下一份稿子就不会再听错 —— 越用越准的闭环。
   *
   * ⚠ 设计上**只挖不给**：候选一律要用户勾选后才写进热词表，绝不自动加。
   *   理由：改字幕也可能只是改语气/断句，挖出来的词不一定真该进热词表；
   *   而热词加错了是会让 ASR 复读的（实测 score≥6 就开始复读热词）。
   */
  let hwCands = [];

  function hwRender(list) {
    const box = $('#ah-mine-list');
    const foot = $('#ah-mine-foot');
    if (!box) return;
    box.innerHTML = '';
    if (!list || !list.length) {
      const p = document.createElement('div');
      p.className = 'hw-mine-empty';
      p.innerHTML = '没有挖到新的候选。<br>'
        + '这需要你先在字幕里**改对过一些专有名词**（人名 / 地名 / 组织名 / 术语）—— '
        + '改得越多，这里挖出来的越准。';
      box.appendChild(p);
      box.hidden = false;
      if (foot) foot.hidden = true;
      return;
    }
    for (const c of list) {
      const row = document.createElement('label');
      row.className = 'hw-mine-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;                       // 默认全勾：挖出来的通常都该加
      cb.dataset.term = c.term;
      const meta = document.createElement('span');
      meta.className = 'hw-mine-meta';
      const term = document.createElement('span');
      term.className = 'hw-mine-term';
      term.textContent = c.term;
      // 来源标记：规则挖的 / 模型判断的（模型那条带理由，直接显示给用户看，让他能反驳）
      if (c.source === 'llm') {
        const tag = document.createElement('span');
        tag.className = 'hw-mine-tag';
        tag.textContent = '模型';
        term.appendChild(document.createTextNode(' '));
        term.appendChild(tag);
      }
      const bits = [];
      if (c.why) bits.push(c.why);                     // LLM 的理由优先显示
      if (c.count > 1) bits.push(`改过 ${c.count} 次`);
      if (c.heard) bits.push(`原来听成「${c.heard}」`);
      else {
        const sm = (c.samples || [])[0];
        if (sm && sm.replaced) bits.push(`原来听成「${sm.replaced}」`);
      }
      const sm = (c.samples || [])[0];
      if (sm && sm.target) bits.push(sm.target);
      const sub = document.createElement('span');
      sub.className = 'hw-mine-src';
      sub.textContent = bits.join(' · ');
      meta.append(term, document.createTextNode('  '), sub);
      row.append(cb, meta);
      box.appendChild(row);
    }
    box.hidden = false;
    if (foot) foot.hidden = false;
    hwUpdateCount();
  }

  function hwUpdateCount() {
    const cnt = $('#ah-mine-count');
    if (!cnt) return;
    const all = document.querySelectorAll('#ah-mine-list input[type=checkbox]');
    const on = [...all].filter(x => x.checked).length;
    cnt.textContent = all.length ? `已选 ${on} / ${all.length} 个` : '';
    const apply = $('#ah-mine-apply');
    if (apply) apply.disabled = on === 0;
  }

  const ahMine = $('#ah-mine');
  if (ahMine) ahMine.addEventListener('click', async () => {
    const hint = $('#ah-mine-hint');
    const pid = (typeof state !== 'undefined' && state.project) ? state.project.id : null;
    if (!pid) {
      if (hint) hint.textContent = '要先打开一个项目 —— 热词是从「这个项目的操作日志」里挖的。';
      return;
    }
    ahMine.disabled = true;
    const old = hint ? hint.textContent : '';
    const useLlm = !!($('#ah-use-llm') && $('#ah-use-llm').checked);
    if (hint) hint.textContent = useLlm ? '正在读操作日志，并交给模型分析（可能要十几秒）…' : '正在读操作日志…';
    try {
      const r = await fetch(`/api/projects/${pid}/hotword-candidates${useLlm ? '?llm=1' : ''}`,
        { signal: AbortSignal.timeout(useLlm ? 180000 : 20000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));

      /* 两条来源合并呈现：
       *   · 规则挖的（count/samples）—— 有统计依据
       *   · 模型判断的（why）      —— 能看出一词多写法、能覆盖整句重写那些规则跳过的
       * 同名以模型那条为准（它的 term 是"标准形"，正是我们想要的）。 */
      const rule = (j.candidates || []).map(c => Object.assign({ source: 'rule' }, c));
      const llm = (j.llmTerms || []).map(c => Object.assign({ source: 'llm', count: 0, samples: [] }, c));
      const byKey = new Map();
      for (const c of rule) byKey.set(c.term.toLowerCase(), c);
      for (const c of llm) byKey.set(c.term.toLowerCase(), c);
      const merged = [...byKey.values()].sort((a, b) => {
        if ((a.source === 'llm') !== (b.source === 'llm')) return a.source === 'llm' ? -1 : 1;
        return (b.score || 0) - (a.score || 0);
      });
      hwCands = merged;
      hwRender(hwCands);

      const st = j.stats || {};
      const li = j.llm || {};
      const parts = [];
      if (st.editEntries) parts.push(`读了 ${st.editEntries} 条编辑记录`);
      parts.push(`规则挖到 ${rule.length} 个`);
      if (useLlm) {
        if (li.ok) parts.push(`模型（${li.model || '?'}）给出 ${llm.length} 个`);
        else if (li.code === 'not-ready') parts.push('模型没配好 —— 去「全局设置 → 增强 → 用于分析热词的模型」里选一个');
        else parts.push(`模型分析失败：${li.error || '未知原因'}`);
      }
      const total = merged.length;
      if (hint) {
        hint.textContent = st.editEntries
          ? `${parts.join('，')}。合计 ${total} 个候选，勾选后点「加入选中的热词」。`
          : '这个项目的操作日志里还没有「编辑字幕」的记录 —— 先去改几句字幕（把 ASR 听错的专有名词改对），再回来挖。';
      }
    } catch (e) {
      if (hint) hint.textContent = '✗ 挖掘失败：' + String((e && e.message) || e);
    } finally {
      ahMine.disabled = false;
      if (!hint.textContent) hint.textContent = old;
    }
  });

  const ahMineList = $('#ah-mine-list');
  if (ahMineList) ahMineList.addEventListener('change', hwUpdateCount);
  const ahMineAll = $('#ah-mine-all');
  if (ahMineAll) ahMineAll.addEventListener('click', () => {
    document.querySelectorAll('#ah-mine-list input[type=checkbox]').forEach(x => { x.checked = true; });
    hwUpdateCount();
  });
  const ahMineNone = $('#ah-mine-none');
  if (ahMineNone) ahMineNone.addEventListener('click', () => {
    document.querySelectorAll('#ah-mine-list input[type=checkbox]').forEach(x => { x.checked = false; });
    hwUpdateCount();
  });

  const ahMineApply = $('#ah-mine-apply');
  if (ahMineApply) ahMineApply.addEventListener('click', async () => {
    const pid = (typeof state !== 'undefined' && state.project) ? state.project.id : null;
    if (!pid) return;
    const picked = [...document.querySelectorAll('#ah-mine-list input[type=checkbox]')]
      .filter(x => x.checked).map(x => x.dataset.term);
    if (!picked.length) { toast('先勾选要加入的热词', 2600); return; }
    const hint = $('#ah-mine-hint');
    ahMineApply.disabled = true;
    try {
      const r = await fetch(`/api/projects/${pid}/hotword-candidates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: picked }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const added = j.added || [];
      /* 写回界面上的热词输入框 —— 服务端已经把词并进 prompt 了，
       * 但**必须刷新这里**，否则显示的还是旧的，用户会以为没生效。 */
      renderHotwords(String(j.hint && j.hint.prompt || '').split(/[\n,，、;；]/).map(x => x.trim()).filter(Boolean));
      /* 候选区整个收起（不是显示"没有候选"的空状态）—— 加完了就该让它消失，
       * 上面的提示文字已经说清加了什么。 */
      const box = $('#ah-mine-list'), foot = $('#ah-mine-foot');
      if (box) { box.innerHTML = ''; box.hidden = true; }
      if (foot) foot.hidden = true;
      if (hint) {
        hint.textContent = added.length
          ? `已加入 ${added.length} 个热词：${added.join('、')}。下次识别就会用上它们。`
          : (j.note || '选中的词都已经在热词表里了');
      }
      if (typeof toast === 'function') {
        toast(added.length ? `已加入 ${added.length} 个热词（来自你的修改记录）` : '这些词已经在热词表里了', 4200);
      }
      if (typeof logOp === 'function' && added.length) {
        logOp('hotwords', `${added.length} 个词`, `从操作日志挖出的热词已加入：${added.join('、')}`,
          '你在字幕里把这些词改对过，加进热词表后下次识别不会再听错');
      }
    } catch (e) {
      if (hint) hint.textContent = '✗ 加入失败：' + String((e && e.message) || e);
    } finally {
      ahMineApply.disabled = false;
      hwUpdateCount();
    }
  });

  /* ═══════════ 热词分析用的模型（全局设置 → 增强）═══════════
   * 默认跟随字幕翻译那套配置（用户不必配两遍）。想单独用别的模型就取消跟随 ——
   * 典型用法：翻译用在线 API（快、便宜），热词分析用**本地 Qwen**（不联网、不花钱、可反复跑）。
   * 配置落在 asr/settings.json 的 analyze 段（服务端 analyzeCfg 负责解析）。
   */
  let anPresets = [];

  function anSetFieldsEnabled(on) {
    const f = $('#an-fields');
    if (!f) return;
    f.querySelectorAll('input,select').forEach(x => { x.disabled = !on; });
    f.style.opacity = on ? '1' : '.5';
  }

  function anStatus(j) {
    const el = $('#an-status');
    if (!el || !j) return;
    const c = (j.cfg || {});
    if (j.useTranslate) {
      const t = j.translate || {};
      el.innerHTML = t.model
        ? `跟随翻译：实际用 <b>${esc(t.model)}</b>${t.ready ? '' : '（但翻译那套还没配好：缺接口地址或 Key）'}`
        : '跟随翻译，但翻译那套还没配好 —— 先去「翻译」页填接口地址与模型名';
    } else {
      el.innerHTML = j.ready
        ? `用 <b>${esc(c.model || '')}</b>${c.baseUrl ? ' @ ' + esc(c.baseUrl) : ''}`
        : '✗ 还没配好：接口地址与模型名都要填（本地地址 http://127.0.0.1:… 免 Key）';
    }
  }

  async function anLoad() {
    const sel = $('#an-provider');
    if (!sel) return;
    try {
      const r = await fetch('/api/analyze/config', { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      anPresets = j.presets || [];
      sel.innerHTML = anPresets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      const c = j.cfg || {};
      sel.value = c.provider || 'custom';
      $('#an-baseurl').value = c.baseUrl || '';
      $('#an-key').value = '';
      $('#an-key').placeholder = j.hasKey ? '已保存（留空不修改）' : '本地地址免填';
      const kh = $('#an-key-hint');
      if (kh) kh.hidden = !j.hasKey;
      $('#an-model').value = c.model || '';
      if ($('#an-maxedits')) $('#an-maxedits').value = (j.limits && j.limits.maxEdits) || 40;
      const cb = $('#an-use-translate');
      if (cb) cb.checked = j.useTranslate !== false;
      anSetFieldsEnabled(!(cb && cb.checked));
      anStatus(j);
    } catch (e) {
      const el = $('#an-status');
      if (el) el.textContent = '✗ 读不到分析模型配置：' + String((e && e.message) || e);
    }
  }

  async function anSave() {
    const cb = $('#an-use-translate');
    const body = {
      useTranslate: !!(cb && cb.checked),
      provider: $('#an-provider') ? $('#an-provider').value : 'custom',
      baseUrl: $('#an-baseurl') ? $('#an-baseurl').value.trim() : '',
      model: $('#an-model') ? $('#an-model').value.trim() : '',
      maxEdits: $('#an-maxedits') ? (parseInt($('#an-maxedits').value, 10) || 40) : 40,
    };
    const key = $('#an-key') ? $('#an-key').value : '';
    if (key) body.apiKey = key;          // 留空 = 不修改已存的 Key
    try {
      const r = await fetch('/api/analyze/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      if ($('#an-key')) { $('#an-key').value = ''; }
      await anLoad();
      if (typeof toast === 'function') toast('分析模型设置已保存', 2600);
    } catch (e) {
      const el = $('#an-status');
      if (el) el.textContent = '✗ 保存失败：' + String((e && e.message) || e);
    }
  }

  const anCb = $('#an-use-translate');
  if (anCb) anCb.addEventListener('change', () => {
    anSetFieldsEnabled(!anCb.checked);
    anSave();
  });
  const anSel = $('#an-provider');
  if (anSel) anSel.addEventListener('change', () => {
    // 切服务商时把该家的预设地址/模型填上（与「翻译」页同一行为），用户可再手改
    const p = (anPresets || []).find(x => x.id === anSel.value);
    if (p && $('#an-baseurl')) {
      $('#an-baseurl').value = p.baseUrl || '';
      $('#an-model').value = p.model || '';
    }
  });
  for (const id of ['#an-baseurl', '#an-key', '#an-model', '#an-maxedits']) {
    const el = $(id);
    if (el) el.addEventListener('change', anSave);
  }
  const anClear = $('#an-key-clear');
  if (anClear) anClear.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/analyze/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeyClear: true }), signal: AbortSignal.timeout(10000),
      });
      if (r.ok) { if (typeof toast === 'function') toast('已清除分析模型的 API Key', 2600); await anLoad(); }
    } catch { /* 忽略 */ }
  });

  /* ── API Key 字段: 服务端只回 hasKey(明文不回传), 输入框留空 = 不修改已存的 Key;
   * 想删除已存 Key 走「清除已存 Key」链接(显式 apiKeyClear, 与"留空"区分开) ── */
  function refreshKeyHint(c) {
    const hint = $('#st-key-hint');
    if (hint) hint.hidden = !(c && c.hasKey);
  }
  async function loadSettings() {
    loadFetchSettings();
    loadCastSettings();
    loadConfidenceSettings();
    correctLoad();
    realignLoad();
    const msgEl = $('#st-msg');
    msgEl.textContent = '';
    msgEl.classList.remove('err');
    let data;
    try {
      const resp = await fetch('/api/translate/config', { signal: AbortSignal.timeout(8000) });
      data = await resp.json();
      if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    } catch (e) {
      msgEl.textContent = '✗ 读取设置失败：' + String((e && e.message) || e) + '。本地服务可能已退出，重开程序再试';
      msgEl.classList.add('err');
      renderAsrModels();      // 翻译配置读不到也要让模型列表自己报错/自己重试
      initPerfPanel();        // 性能测试页（独立于模型列表，自己管自己的状态）
      initDualRatio();        // 双引擎分工下拉（事件委托，重渲染不失效）
      return;
    }
    stPresets = data.presets || [];
    $('#st-provider').innerHTML = stPresets
      .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const c = data.cfg || {};
    $('#st-provider').value = c.provider || 'custom';
    $('#st-baseurl').value = c.baseUrl || '';
    // 明文 Key 不回传(只回 hasKey): 输入框永远留空起步, 留空 = 不修改已存的 Key
    $('#st-key').value = '';
    $('#st-key').placeholder = c.hasKey ? '已保存（留空不修改）' : 'sk-…';
    refreshKeyHint(c);
    $('#st-model').value = c.model || '';
    if ($('#st-batch')) $('#st-batch').value = c.batchSize || 25;      // 每批行数(用户可调)
    $('#st-prompt').value = c.prompt || data.defaultPrompt || '';
    try {
      const h = await (await fetch('/api/asr/hint')).json();
      const hint = h.hint || {};
      renderHotwords(String(hint.prompt || '').split(/[,\n;，；]+/).map(s => s.trim()).filter(Boolean));
      $('#ah-score').value = hint.hotwordsScore || 3;
    } catch { /* 识别提示词读不到不影响其它设置 */ }
    glLoad(c.glossary, c.glossaryLang);
    renderAsrModels();
    bindModelDirSettings();
    anLoad();            // 热词分析模型（自己拉 /api/analyze/config，与翻译配置分开）
  }
  /** 模型管理: 列出所有识别模型(状态/下载/删除) + whisper.cpp 运行时 */
  /* ──────────────────────────────────────────────────────────────────────────
 * 性能测试页：在本机实测 NPU/GPU 双引擎的最佳分工
 *
 * 为什么是"启动 + 轮询"而不是一个同步请求：一次测试要跑 9 次真实识别
 * （3 种分片 × [GPU 基线 / NPU 基线 / 最优配比验证]），耗时以分钟计，
 * 同步请求会超时，而且看不到中间进度。
 * ────────────────────────────────────────────────────────────────────────── */
let perfTimer = null;

function perfSetBusy(on, msg) {
  const btn = $('#perf-start');
  if (btn) { btn.disabled = !!on; btn.textContent = on ? '测试中…' : '开始测试'; }
  const note = $('#perf-note');
  if (note && msg !== undefined) note.textContent = msg || '';
}

async function perfRenderApplied() {
  const el = $('#perf-applied');
  if (!el) return;
  try {
    const s = await (await fetch('/api/asr/perf/state')).json();
    const d = (s && s.dual) || null;
    if (!d) {
      el.innerHTML = '还没应用过测试结果。<b>双引擎识别目前是独立脚本</b>（asr/asr_dual.py），'
        + '下面的配置就是它的默认参数。';
      return;
    }
    el.innerHTML = `分片 <b>${d.sliceSec}</b> 秒、配比 <b>${escapeHtml(d.ratio)}</b>`
      + `（GPU:NPU 分片数）· 应用时间 ${escapeHtml(String(d.updatedAt || '').replace('T', ' ').slice(0, 19))}`;
  } catch {
    el.textContent = '读不到设置';
  }
}

function perfRenderResult(r) {
  const box = $('#perf-result');
  if (!box) return;
  if (!r || !r.recommend) { box.innerHTML = ''; return; }
  const rec = r.recommend;
  const rows = (r.sliceLengths || []).map((e) => {
    const cells = ['1:0', '0:1', '1:1', '2:1', '1:2'].map((k) => {
      const p = (e.ratios || {})[k];
      if (!p) return '<td>—</td>';
      // 有实测值的（纯单引擎基线与验证过的最优）标粗，其余是推算值
      const val = p.measuredSec != null ? `<b>${p.measuredSec}s</b>` : `${p.predictedSec}s`;
      const mark = (k === e.bestRatio) ? ' style="background:var(--accent-soft,rgba(90,140,255,.14))"' : '';
      return `<td${mark} title="${p.gpuSlices} 片 GPU / ${p.npuSlices} 片 NPU">${val}</td>`;
    }).join('');
    return `<tr><td>${e.sliceSec}s</td><td>${e.slices}</td>${cells}`
      + `<td>${escapeHtml(e.bestRatio)}</td></tr>`;
  }).join('');
  box.innerHTML = `
    <div class="st-section-title">推荐配置</div>
    <div class="st-help" style="font-size:14px">
      分片 <b>${rec.sliceSec}</b> 秒、配比 <b>${escapeHtml(rec.ratio)}</b>
      （GPU:NPU）　实测 <b>${rec.measuredSec != null ? rec.measuredSec + 's' : '—'}</b>
      （预测 ${rec.predictedSec}s）
      ${rec.speedupVsNpu ? `　比只用 NPU 快 <b>${rec.speedupVsNpu}×</b>` : ''}
      ${rec.speedupVsGpu ? `，比只用 GPU 快 <b>${rec.speedupVsGpu}×</b>` : ''}
    </div>
    <div class="st-row" style="margin-top:8px">
      <button type="button" class="btn btn-mini btn-accent" id="perf-apply">应用这组配置</button>
      <button type="button" class="btn btn-mini" id="perf-copy">复制运行命令</button>
      <span class="st-msg" id="perf-apply-note"></span>
    </div>
    <div class="st-section-title" style="margin-top:14px">各分片长度 × 配比（秒，越小越好）</div>
    <table class="perf-table">
      <thead><tr><th>分片</th><th>片数</th><th>仅GPU</th><th>仅NPU</th><th>1:1</th><th>2:1</th><th>1:2</th><th>最优</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="st-help" style="margin-top:8px">
      <b>粗体</b>是实测值，其余是按“墙钟 ≈ 加载 + 片数×每片净耗时”推算的。
      两个引擎并行，所以混合配比的耗时约为两者取大。
      本次测量：GPU 每片 ${r.sliceLengths[0] ? r.sliceLengths[0].gpuPerSlice : '?'}s、
      NPU 每片 ${r.sliceLengths[0] ? r.sliceLengths[0].npuPerSlice : '?'}s（以第一个分片长度为例），
      加载 GPU ${r.sliceLengths[0] ? r.sliceLengths[0].gpuLoadSec : '?'}s / NPU ${r.sliceLengths[0] ? r.sliceLengths[0].npuLoadSec : '?'}s。
      <br><b>注意</b>：分片片数太少时，模型加载会主导耗时，测出的“每片净耗时”是噪声 ——
      所以每个长度至少跑 15 片，测试素材不够长会自动用整段。
    </div>`;

  const apply = $('#perf-apply');
  if (apply) apply.addEventListener('click', async () => {
    const note = $('#perf-apply-note');
    apply.disabled = true;
    try {
      const r2 = await (await fetch('/api/asr/perf/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratio: rec.ratio, sliceSec: rec.sliceSec }),
      })).json();
      if (note) note.textContent = r2 && r2.ok ? '✓ 已写入设置' : ('失败：' + ((r2 && r2.error) || '未知'));
      perfRenderApplied();
    } catch (e) {
      if (note) note.textContent = '失败：' + e.message;
    } finally { apply.disabled = false; }
  });
  const copy = $('#perf-copy');
  if (copy) copy.addEventListener('click', async () => {
    const note = $('#perf-apply-note');
    try {
      await navigator.clipboard.writeText(rec.command);
      if (note) note.textContent = '✓ 命令已复制';
    } catch {
      if (note) note.textContent = rec.command;
    }
  });
}

async function perfPoll() {
  let s = null;
  try { s = await (await fetch('/api/asr/perf/state')).json(); } catch { return; }
  const prog = $('#perf-progress');
  const bar = $('#perf-bar');
  const stage = $('#perf-stage');
  if (s.running && prog) {
    prog.hidden = false;
    if (bar) bar.style.width = (s.pct || 0) + '%';
    if (stage) stage.textContent = `${s.pct || 0}%　${s.msg || ''}`;
  } else if (prog) {
    prog.hidden = true;
  }
  if (!s.running) {
    clearInterval(perfTimer);
    perfTimer = null;
    perfSetBusy(false, s.error ? ('失败：' + s.error) : '');
    if (s.result) perfRenderResult(s.result);
  }
}

function startPerfPolling() {
  if (perfTimer) return;
  perfTimer = setInterval(perfPoll, 1500);
  perfPoll();
}

function initPerfPanel() {
  const btn = $('#perf-start');
  if (!btn || btn.dataset.bound) return;      // 只绑一次
  btn.dataset.bound = '1';

  const pathEl = $('#perf-audio-path');
  let audioPath = '';

  const setAudio = (p) => {
    audioPath = p || '';
    if (pathEl) pathEl.textContent = audioPath || '（未选择）';
  };
  setAudio('');

  const pick = $('#perf-audio-pick');
  if (pick) pick.addEventListener('click', async () => {
    const note = $('#perf-note');
    pick.disabled = true;
    try {
      const r = await (await fetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'audio' }),
      })).json();
      if (r && r.path) setAudio(r.path);
      else if (note) note.textContent = '没选到文件（需要 16kHz 单声道 wav 最稳）';
    } catch {
      if (note) note.textContent = '选择对话框不可用';
    } finally { pick.disabled = false; }
  });

  const auto = $('#perf-audio-auto');
  if (auto) auto.addEventListener('click', async () => {
    const note = $('#perf-note');
    auto.disabled = true;
    try {
      // 从最近的项目里找一份 source16k.wav（就是识别实际用的那份，最贴近真实负载）
      const r = await (await fetch('/api/asr/perf/auto-audio')).json();
      if (r && r.path) { setAudio(r.path); if (note) note.textContent = '已自动选择：' + r.why; }
      else if (note) note.textContent = (r && r.error) || '没找到可用的音频，请手动选择';
    } catch (e) {
      if (note) note.textContent = '失败：' + e.message;
    } finally { auto.disabled = false; }
  });

  btn.addEventListener('click', async () => {
    const note = $('#perf-note');
    if (!audioPath) { if (note) note.textContent = '先选一份测试音频'; return; }
    perfSetBusy(true, '启动中…');
    const box = $('#perf-result');
    if (box) box.innerHTML = '';
    try {
      const r = await (await fetch('/api/asr/perf/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: audioPath,
          slices: ($('#perf-slices') || {}).value || '8,15.01,28',
          audioSec: Number(($('#perf-audio-sec') || {}).value) || 60,
        }),
      })).json();
      if (r && r.error) { perfSetBusy(false, '失败：' + r.error); return; }
      startPerfPolling();
    } catch (e) {
      perfSetBusy(false, '失败：' + e.message);
    }
  });

  // 打开页面时若已有在跑的测试，接管进度
  fetch('/api/asr/perf/state').then(r => r.json()).then((s) => {
    if (s && s.running) { perfSetBusy(true); startPerfPolling(); }
    else if (s && s.result) perfRenderResult(s.result);
    if (s && s.error) perfSetBusy(false, '上次失败：' + s.error);
  }).catch(() => {});
  perfRenderApplied();
}

/* 双引擎分工下拉。为什么挂在 renderAsrModels 之后：那个面板是整体重建的，
 * 所以这里只做"每次渲染后刷新一次状态"，事件用委托挂在容器上（见 initDualRatio）。 */
async function refreshDualRatio() {
  const row = $('#dual-ratio-row');
  const sel = $('#dual-ratio');
  const note = $('#dual-ratio-note');
  if (!row || !sel) return;
  try {
    const s = await (await fetch('/api/asr/dual')).json();
    const anyDual = state.asrStatus && (state.asrStatus.models || [])
      .some((m) => m.engine === 'dual' && m.ready);
    // 只有当机器上确实存在可用的双引擎模型时才显示这一行 —— 否则是噪音
    row.hidden = !anyDual;
    if (!anyDual) return;
    const manual = (s && s.manual) || 'auto';
    if (sel.value !== manual) sel.value = manual;
    const cfg = (s && s.cfg) || {};
    const d = (s && s.measured) || null;
    if (manual === 'auto') {
      note.textContent = d
        ? `实测推荐 ${d.ratio}、分片 ${d.sliceSec}s`
        : '还没测过，暂时用 1:1、分片 15.01s —— 建议先去「性能测试」测一次';
    } else {
      note.textContent = `按 ${manual} 分工、分片 ${cfg.sliceSec}s`;
    }
  } catch { /* 接口不可用就不显示 */ }
}

function initDualRatio() {
  const box = $('#st-models');
  if (!box || box.dataset.dualBound) return;
  box.dataset.dualBound = '1';
  // 事件委托：面板每次重建都不会丢
  box.addEventListener('change', async (e) => {
    const sel = e.target;
    if (!sel || sel.id !== 'dual-ratio') return;
    const note = $('#dual-ratio-note');
    try {
      const r = await (await fetch('/api/asr/dual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratio: sel.value }),
      })).json();
      if (r && r.ok) {
        if (note) note.textContent = sel.value === 'auto'
          ? '已设为自动' : `已设为 ${sel.value}`;
        refreshDualRatio();
      } else if (note) {
        note.textContent = '失败：' + ((r && r.error) || '未知');
      }
    } catch (err) {
      if (note) note.textContent = '失败：' + err.message;
    }
  });
}

async function renderAsrModels() {
    const box = $('#st-models');
    if (!box) return;
    let d;
    try {
      // 加超时: 服务端异常时请求可能一直不返回, 不能让界面永远停在「读取中…」
      const resp = await fetch('/api/asr/status', { signal: AbortSignal.timeout(8000) });
      d = await resp.json();
      if (!resp.ok) throw new Error(d.error || ('HTTP ' + resp.status));
    } catch (e) {
      const why = String((e && e.message) || e);
      box.innerHTML = '<div class="st-row">读取失败：' + esc(why)
        + ' <button type="button" class="btn btn-mini" id="st-models-retry">重试</button></div>';
      const rb = document.getElementById('st-models-retry');
      if (rb) rb.addEventListener('click', () => renderAsrModels());
      return;
    }
    const dlMap = {};                    // key → 下载状态(服务端并行下载, 每个 key 独立)
    (d.downloads || []).forEach(x => { dlMap[x.key] = x; });
    const dlOf = (key) => dlMap[key] || {};
    // 注: 下面各模型的下载状态提示都是就地手写的(见 pyState / state / nemoState 等),
    // 没有走统一模板 —— 各自要拼的按钮和文案差别太大, 抽象反而更绕。
    // Python 环境(Parakeet 需要; whisper.cpp 不需要): 预检状态 + 一键安装
    // pythonProbe 现在按引擎分键（{sherpa, openvino}）—— 直接读 .ok 会得到 undefined，
    // 于是把好环境误判成"不可用"（实测踩过）。这里挑**当前所选模型**对应的那一项；
    // 旧版扁平形状（{ok,msg}）仍然兼容。
    const py = (() => {
      const pp = d.pythonProbe;
      if (!pp) return null;
      if (typeof pp.ok === 'boolean') return pp;                 // 旧形状
      const sel = (d.models || []).find(m => m.id === d.selectedModel)
        || (d.models || []).find(m => m.usable) || null;
      const key = sel && sel.engine === 'openvino' ? 'openvino' : 'sherpa';
      const one = pp[key];
      if (one) return one;
      return d.pythonProbeFlat || null;
    })();
    // 探测里带上用的哪个解释器，界面上能看到（多份安装时这点很重要）
    const pyExe = d.python || '';
    const pySt = dlOf('pyenv');
    let pyState;
    if (pySt.running) {
      pyState = `<span class="sm-state running">${esc(pySt.msg || '安装中…')} ${pySt.pct || 0}%</span>`;
    } else if (pySt.error) {
      pyState = `<span class="sm-state" style="color:var(--danger)">${esc(pySt.msg || pySt.error)} <button type="button" class="btn btn-mini sm-pyinstall">重试安装</button></span>`;
    } else if (!py) {
      pyState = '<span class="sm-state">检测中…</span>';          // 预检还没跑完(后台探测中), 别误报"不可用"
    } else if (py.ok) {
      pyState = d.provider === 'cuda'
        ? `<span class="sm-state ok">✓ 可用（${esc(py.msg || '')} · GPU·CUDA${d.gpu ? ' · ' + esc(d.gpu) : ''}）</span>`
        : `<span class="sm-state" style="color:var(--danger)">基础环境可用，但没启用 GPU·CUDA。说话人分离能用；Parakeet 识别必须 N 卡（不支持 CPU），有 N 卡可以点「安装」换 CUDA 版 <button type="button" class="btn btn-mini sm-pyinstall">安装</button></span>`;
    } else {
      pyState = `<span class="sm-state" style="color:var(--danger)">不可用${py && py.msg ? '：' + esc(py.msg) : ''} <button type="button" class="btn btn-mini sm-pyinstall">安装</button></span>`;
    }
    let rows = `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">Python 环境</span></div>
      <div class="sm-desc">Parakeet 识别要 Python 和 sherpa-onnx，还得有 N 卡（CUDA）。说话人分离只要基础 Python，没有 N 卡也能用；whisper.cpp 不需要 Python。点「安装」会装好 Python 和依赖，有 N 卡时一并换成 CUDA 版。不写注册表，删掉 asr\\runtime-python 目录就算卸载</div>
      ${pyState}
      <div class="sm-desc" style="margin-top:6px">当前解释器：<code>${esc(pyExe || '(未定)')}</code>
        <button type="button" class="btn btn-mini sm-pyset">指定其他 Python…</button>
        <button type="button" class="btn btn-mini sm-pyreset">用回默认</button>
      </div>
      <div class="sm-desc">如果另一份安装里已经装好了 torch + NeMo，用上面「指定其他 Python…」指过去即可，不必重下几 GB</div>
      <div class="sm-pymsg" style="font-size:12px;margin-top:4px"></div>
    </div>`;
    // 各任务 key: model:<id> / runtime / diarize
    rows += (d.models || []).map((m) => {
      const st = dlOf('model:' + m.id);
      const rtSt = m.needRuntime ? dlOf('runtime') : {};
      const dlThis = st.running || (m.needRuntime && rtSt.running);
      /* 无对应 GPU 环境连下载都拦: Parakeet 要 CUDA 版 sherpa-onnx; NeMo 多说话人模型只给 N 卡用户。
       * ⚠ `d.gpu` 为空还有第三种可能：**后台探测还没跑完**（服务端已改成等探测完再回，
       *   但旧实例/极端慢的 nvidia-smi 仍可能给空）。那种情况下不能说"没检测到 N 卡" —— 是误报。 */
      const gpuUnknown = !d.gpu && !!d.gpuPending;
      const pyBlocked = (m.engine === 'sherpa-onnx' && d.provider !== 'cuda')
        || (m.engine === 'nemo' && !d.gpu && !gpuUnknown);
      let state, btn = '';
      if (m.cloud) {
        // 云端模型没有本地文件: 不给"下载/删除"按钮, 只说清代价(要联网 + 音频会传出去)
        state = '<span class="sm-state ok">✓ 云端识别（免下载 · 免显卡 · 需要联网）</span>';
      } else if (st.running || (m.needRuntime && rtSt.running)) {
        state = `<span class="sm-state running">${esc((st.running ? st.msg : rtSt.msg) || '下载中…')} ${(st.running ? st.pct : rtSt.pct) || 0}%</span>`;
      } else if (st.error) {
        state = `<span class="sm-state" style="color:var(--danger)">${esc(st.msg || st.error)}</span>`;
      } else if (gpuUnknown && m.engine === 'nemo') {
        state = '<span class="sm-state">检测中…（正在查显卡）</span>';
      } else if (pyBlocked) {
        state = m.engine === 'nemo'
          ? '<span class="sm-state" style="color:var(--danger)">只支持 N 卡（NVIDIA 显卡）。当前没检测到 N 卡，不支持 CPU 推理，无法下载</span>'
          : '<span class="sm-state" style="color:var(--danger)">需要 CUDA GPU（N 卡）才能下载使用，不支持 CPU。先在上面把 Python 环境装好</span>';
      } else if (m.needNemo) {
        state = '<span class="sm-state ok">✓ 已下载</span> <span class="sm-state" style="color:var(--danger)">还差 NeMo 运行时（见下方「NeMo 运行时」）</span>';
      } else if (m.ready) state = '<span class="sm-state ok">✓ 已就绪</span>';
      else state = `<span class="sm-state">未下载 · ${m.sizeMB} MB</span>`;
      if (dlThis) btn = '';
      else if (m.cloud) btn = '';       // 云端模型没有本地文件: 不给「下载/删除」按钮(服务端也拦了删除接口)
      else if (m.ready) btn = `<button type="button" class="btn btn-mini sm-del" data-id="${esc(m.id)}" title="删除模型文件（释放磁盘）">删除</button>`;
      else if (!pyBlocked) btn = `<button type="button" class="btn btn-mini sm-dl" data-id="${esc(m.id)}">下载</button>`;
      const rt = (m.needRuntime && !dlThis) ? '<div class="sm-runtime">需要 whisper.cpp 运行时（约 18MB，含 Vulkan GPU 加速；点下载自动一并获取）</div>' : '';
      return `<div class="sm-model">
        <div class="sm-head"><span class="sm-name">${esc(m.name)}${m.draftAllowed === false ? ' <span class="sm-badge">仅重新识别</span>' : ''}</span>${btn}</div>
        <div class="sm-desc">${esc(m.desc || '')}</div>
        ${state}${rt}
      </div>`;
    }).join('');
    // 说话人分离模型(两个文件一组, ~32MB): 初稿勾选「区分说话人」时需要
    const dz = d.diarize || {};
    const dzSt = dlOf('diarize');
    const dzBtn = dzSt.running ? '' : (dz.ready
      ? '<button type="button" class="btn btn-mini sm-del" data-id="diarize" title="删除分离模型文件">删除</button>'
      : '<button type="button" class="btn btn-mini sm-dl" data-id="diarize">下载</button>');
    const dzState = dzSt.running ? `<span class="sm-state running">${esc(dzSt.msg || '下载中…')} ${dzSt.pct || 0}%</span>`
      : (dzSt.error ? `<span class="sm-state" style="color:var(--danger)">${esc(dzSt.msg || dzSt.error)}</span>`
      : (dz.ready ? '<span class="sm-state ok">✓ 已就绪</span>' : '<span class="sm-state">未下载 · 32 MB</span>'));
    // NeMo 运行时(只有 multitalker 多说话人模型用得到): PyTorch + NeMo, 约 5GB, 仅 N 卡
    const nemo = d.nemo || {};
    const nemoSt = dlOf('nemo');
    /* ⚠ 预检要 `import torch`（+ 有时 nemo.collections.asr），**首次 30 秒起步**。
     *   这期间后端回的是 { ok:false, msg:'预检中…' } —— 直接落到下面的"未安装"分支
     *   就是**误报**：用户明明装了，界面却写"未安装 · 约 5GB"还给他一个「安装」按钮，
     *   点下去会白下 5GB。Python 环境那张卡早有这个守卫（见 pyState 的 '检测中…'），
     *   NeMo 这张卡当初漏了 —— 用户实测就报在这（截图：未安装 · 约 5GB · 预检中…）。 */
    const nemoPending = !nemo.ok && /预检中|未开始/.test(String(nemo.msg || ''));
    /* 预检要 30 秒起步，界面不能只刷一次就停在"检测中" —— 盯着它，出结果就重画一次。
     * 只在面板还开着、且还没出结果时轮询，避免关掉设置页后还在空转。 */
    if (nemoPending && !nemoPollTimer) {
      let tries = 0;
      nemoPollTimer = setInterval(async () => {
        if (++tries > 30 || !document.getElementById('st-models') || $('#st-models').offsetParent === null) {
          clearInterval(nemoPollTimer); nemoPollTimer = 0; return;
        }
        try {
          const r = await fetch('/api/asr/status', { signal: AbortSignal.timeout(8000) });
          const dd = await r.json();
          const nn = dd.nemo || {};
          if (nn.ok || !/预检中|未开始/.test(String(nn.msg || ''))) {
            clearInterval(nemoPollTimer); nemoPollTimer = 0;
            renderAsrModels();               // 出结果了 → 重画（此时 nemo.ok 已是真值）
          }
        } catch { /* 忽略，下一轮再试 */ }
      }, 3000);
    }
    let nemoState;
    if (nemoSt.running) nemoState = `<span class="sm-state running">${esc(nemoSt.msg || '安装中…')} ${nemoSt.pct || 0}%</span>`;
    else if (nemoSt.error) nemoState = `<span class="sm-state" style="color:var(--danger)">${esc(nemoSt.msg || nemoSt.error)}</span>`;
    else if (nemo.ok && nemo.cuda) nemoState = `<span class="sm-state ok">✓ 可用（${esc(nemo.msg || '')}${nemo.gpu ? ' · ' + esc(nemo.gpu) : ''}）</span>`;
    else if (nemo.ok) nemoState = '<span class="sm-state" style="color:var(--danger)">装到的是 CPU 版 PyTorch，多说话人模型在 CPU 上跑不了。点「重新安装」换 CUDA 版</span>';
    else if (nemoPending) nemoState = '<span class="sm-state">检测中…（要导入 PyTorch，首次约半分钟）</span>';
    else nemoState = `<span class="sm-state" style="color:var(--danger)">不可用${nemo.msg ? '：' + esc(nemo.msg) : ''}</span>`;
    /* 检测中 / 安装中都不给按钮 —— 检测中给了按钮，用户会以为没装、白点一下。 */
    const nemoBtn = (nemoSt.running || nemoPending || (nemo.ok && nemo.cuda)) ? ''
      : `<button type="button" class="btn btn-mini sm-nemoinstall">${nemo.ok ? '重新安装' : '安装'}</button>`;
    rows += `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">NeMo 运行时（多说话人）</span>${nemoBtn}</div>
      <div class="sm-desc">「Multitalker Parakeet Streaming 0.6B v1」专用：PyTorch + NeMo（约 5GB）。与上面的 Python 环境是两套依赖，装在本项目的 Python 环境里；<b>只有 N 卡可用</b>（该模型不支持 CPU 推理）。装完会自动实测「加载 + CUDA」才算成功</div>
      ${nemoState}
    </div>`;
    // 「重新识别模型」: 可指向任意模型(含只能重新识别的 multitalker)
    const rrCur = d.rerecogModel || '';
    const rrOpts = ['<option value="">沿用项目原有模型（默认）</option>'].concat(
      (d.models || []).map(m => {
        const tag = m.usable ? '' : (m.ready ? '（运行时未就绪）' : '（未下载）');
        return `<option value="${esc(m.id)}"${m.id === rrCur ? ' selected' : ''}>${esc(m.name)}${tag}</option>`;
      })).join('');
    rows += `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">重新识别模型</span></div>
      <div class="sm-desc">「选区重新识别」用哪个模型。选了 Multitalker 多说话人模型时：它<b>只能用于重新识别</b>（不能创建初稿），并且必须 N 卡，用 CPU 推理会直接报错</div>
      <select class="btn" id="st-rerecog-sel">${rrOpts}</select>
    </div>`;
    rows += `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">说话人分离</span>${dzBtn}</div>
      <div class="sm-desc">说话人分段 + 说话人嵌入（约 32MB）。初稿勾选「区分说话人」时需要</div>
      ${dzState}
    </div>`;
    box.innerHTML = rows || '<div class="st-row">无可用模型</div>';
    box.querySelectorAll('.sm-nemoinstall').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '开始…';
      try {
        const r = await (await fetch('/api/asr/install-nemo', { method: 'POST' })).json();
        const msgEl = $('#st-msg');
        if (r.error) { msgEl.textContent = '✗ ' + r.error; msgEl.classList.add('err'); }
        else if (r.started || r.already) { msgEl.textContent = '正在安装 NeMo 运行时（约 5GB，进度见上方）…装完会自动测一次 CUDA'; msgEl.classList.remove('err'); pollModelDownload(); }
      } catch (e) { const msgEl = $('#st-msg'); msgEl.textContent = '✗ 安装启动失败: ' + String((e && e.message) || e); msgEl.classList.add('err'); }
      renderAsrModels();
    }));
    const rrSel = box.querySelector('#st-rerecog-sel');
    if (rrSel) rrSel.addEventListener('change', async () => {
      const msgEl = $('#st-msg');
      try {
        const r = await (await fetch('/api/asr/select-rerecog', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: rrSel.value })
        })).json();
        if (r.error) { msgEl.textContent = '✗ ' + r.error; msgEl.classList.add('err'); return; }
        const picked = (d.models || []).find(x => x.id === rrSel.value);
        msgEl.textContent = picked ? ('重新识别将使用：' + picked.name) : '重新识别将沿用项目原有模型';
        msgEl.classList.remove('err');
      } catch (e) { msgEl.textContent = '✗ 保存失败: ' + String((e && e.message) || e); msgEl.classList.add('err'); }
    });
    box.querySelectorAll('.sm-dl').forEach(b => b.addEventListener('click', () => downloadModel(b.dataset.id)));
    box.querySelectorAll('.sm-pyinstall').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '开始…';
      try {
        const r = await (await fetch('/api/asr/download', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'pyenv' })
        })).json();
        if (r.started) pollModelDownload();
      } catch {}
      renderAsrModels();
    }));
    // 指定 / 恢复 Python 解释器（运行时装在别处时用，例如复用另一份安装里的 torch+NeMo）
    box.querySelectorAll('.sm-pyset').forEach(b => b.addEventListener('click', async () => {
      const msg = box.querySelector('.sm-pymsg');
      b.disabled = true;
      const old = b.textContent;
      b.textContent = '选择中…';
      try {
        let pick = null;
        try {
          pick = await (await fetch('/api/pick', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'python' }),
          })).json();
        } catch { pick = null; }
        if (!pick || !pick.path) {
          if (msg) msg.textContent = '没选到文件，已取消';
          return;
        }
        const r = await (await fetch('/api/asr/set-python', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exe: pick.path }),
        })).json();
        if (msg) msg.textContent = r && r.ok ? ('已切换解释器：' + r.python + '，正在重新检测…') : ('切换失败：' + ((r && r.error) || '未知错误'));
      } finally {
        b.disabled = false;
        b.textContent = old;
        renderAsrModels();
      }
    }));
    box.querySelectorAll('.sm-pyreset').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await fetch('/api/asr/set-python', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exe: '' }),
        });
      } catch {}
      b.disabled = false;
      renderAsrModels();
    }));
    box.querySelectorAll('.sm-del').forEach(b => b.addEventListener('click', () => {
      panel.showConfirm('删除模型',
        '删除该模型的文件？已生成的字幕不受影响，之后可以重新下载',
        '删除', '取消', async () => {
          await fetch('/api/asr/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: b.dataset.id })
          });
          renderAsrModels();
        });
    }));
    // whisper.cpp 运行时: 需要 ggml 模型但运行时缺失时自动开始下载(与其它下载并行, 不互斥)
    const note = $('#st-model-note');
    const needRt = (d.models || []).some(m => m.needRuntime);
    if (needRt && !dlOf('runtime').running) {
      const r = await (await fetch('/api/asr/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'runtime' })
      })).json().catch(() => ({}));
      if (r.started) {
        note.textContent = '正在下载 whisper.cpp 运行时…';
        pollModelDownload();
      }
    } else if (note) note.textContent = '';
  }
  async function pollModelDownload() {
    for (let i = 0; i < 900; i++) {
      let d;
      try { d = await (await fetch('/api/asr/status')).json(); } catch { break; }
      const anyRunning = (d.downloads || []).some(x => x.running);
      renderAsrModels();
      if (!anyRunning) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  async function downloadModel(id) {
    // 点下载立刻有反馈(按钮变「排队…」), 再发请求 —— 旧版静默发请求, 服务端忙时用户以为没点上
    const body = id === 'diarize' ? { kind: 'diarize' } : { modelId: id };
    const btn = document.querySelector('.sm-dl[data-id="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '开始…'; }
    const r = await fetch('/api/asr/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const m = await r.json().catch(() => ({}));
    if (!r.ok && m.error) { toast(m.error, 5000); if (btn) { btn.disabled = false; btn.textContent = '下载'; } return; }
    pollModelDownload();
  }
  /** 模型下载位置(设置面板): 指定目录 + 打开目录 */
  async function bindModelDirSettings() {
    const inp = document.getElementById('st-model-dir');
    const openBtn = document.getElementById('st-model-dir-open');
    if (!inp || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    try {
      const d = await (await fetch('/api/asr/status', { signal: AbortSignal.timeout(8000) })).json();
      inp.value = d.modelsRoot || '';
    } catch {}
    const save = async () => {
      const r = await fetch('/api/asr/set-dir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: inp.value.trim() })
      });
      const m = await r.json().catch(() => ({}));
      if (r.ok) { inp.value = m.modelsRoot || inp.value; toast('模型下载位置已保存', 2600); }
      else toast(m.error || '保存失败', 4200);
    };
    inp.addEventListener('change', save);
    if (openBtn) openBtn.addEventListener('click', async () => {
      await fetch('/api/asr/open-dir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'models' })
      });
    });
  }
  function openSettings(tabName) {
    const h = location.hash;
    settingsReturnRoute = h === '#/new' ? '#/new'
      : (h.startsWith('#/project/') || h === '#/editor' || h.startsWith('#/details/')) ? h : '#/home';
    settingsOpenedFromApp = true;
    if (tabName === 'models') $('.st-tab[data-stp="models"]').click();
    location.hash = '#/settings';
  }
  $('#btn-settings').addEventListener('click', openSettings);

  /* ── 下载与登录（设置 → 下载与登录） ── */
  /** Cookie 备注：保存状态 + 登录检测结果（谁登录的、是不是大会员、密文还是明文存） */
  function cookieNote(d, check) {
    const keys = (d && d.biliCookieKeys || []).join('、');
    const enc = d && d.biliCookieEnc
      ? ' · 密文保存（' + ((d.cookieBackend || '').startsWith('dpapi') ? 'DPAPI 系统加密' : '本机加密') + '）'
      : '';
    if (!d || !d.hasBiliCookie) return d && d.ready ? '未设置（只能下到免登录画质）' : '⚠ 下载内核不可用：需要一个 Python 3.8+';
    if (!check) return '已保存（' + keys + '）' + enc + '，正在检测登录 …';
    const v = check.isLogin
      ? '✓ ' + (check.message || '已登录')
      : '✗ ' + (check.message || '未登录');
    return v + ' · ' + (keys || 'Cookie') + enc;
  }
  async function loadFetchSettings() {
    try {
      const d = await (await fetch('/api/fetch/settings', { signal: AbortSignal.timeout(8000) })).json();
      if ($('#st-fetch-quality')) $('#st-fetch-quality').value = d.quality || 'best';
      if ($('#st-fetch-proxy')) $('#st-fetch-proxy').value = d.proxy || '';
      if ($('#st-fetch-browser')) $('#st-fetch-browser').value = d.cookiesFromBrowser || '';
      const note = $('#st-fetch-cookie-note');
      if (note) {
        note.textContent = cookieNote(d, null);
        if (d.hasBiliCookie) {
          // 存了就顺手验一次"到底登录上没有"（网络不通时只是提示，不影响保存状态）
          fetch('/api/fetch/check-cookie', { signal: AbortSignal.timeout(15000) })
            .then((r) => r.json())
            .then((c) => { note.textContent = cookieNote(d, c); })
            .catch(() => { note.textContent = cookieNote(d, { isLogin: false, message: '登录检测失败（网络不通？）' }); });
        }
      }
    } catch {}
  }
  async function loadCastSettings() {
    try {
      const d = await (await fetch('/api/cast/config', { signal: AbortSignal.timeout(8000) })).json();
      const el = document.getElementById('st-cast-enabled');
      if (el) el.checked = d.enabled !== false;
      const note = document.getElementById('st-cast-note');
      if (note && !d.llmReady) note.textContent = '⚠ 还没配模型：到「字幕翻译」里填接口地址、API Key 和模型名，否则这一步会自动跳过。';
    } catch {}
  }
  const castToggle = document.getElementById('st-cast-enabled');
  if (castToggle) castToggle.addEventListener('change', async () => {
    try {
      await fetch('/api/cast/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!castToggle.checked }) });
      toast(castToggle.checked ? '已开启 LLM 分角色' : '已关闭 LLM 分角色', 2600);
    } catch (e) { toast('保存失败: ' + e.message, 3600); }
  });

  /* 逐句置信度（全局默认，三档）。与上面分角色同一模式：改了立刻存，不等「保存并返回」。
     它是**全局默认**；单个项目可以在新建时的生成设置里单独指定档位（存进 project.json）。 */
  async function loadConfidenceSettings() {
    try {
      const d = await (await fetch('/api/asr/confidence', { signal: AbortSignal.timeout(8000) })).json();
      const el = document.getElementById('st-conf-mode');
      if (el && CONF_MODES.includes(d.mode)) el.value = d.mode;
      asrConfDefaultCache = CONF_MODES.includes(d.mode) ? d.mode : 'full';   // 顺手更新缓存
    } catch {}
  }
  const confSel = document.getElementById('st-conf-mode');
  if (confSel) confSel.addEventListener('change', async () => {
    const mode = confSel.value;
    try {
      const r = await fetch('/api/asr/confidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      asrConfDefaultCache = mode;                     // 改了立刻反映到建稿页的默认档位
      toast('逐句置信度：' + ({ off: '已关闭（识别最快）', fast: '快速（不做稳定性重跑）', full: '完整（识别约慢一倍）' }[mode] || mode), 3600);
    } catch (e) { toast('保存失败: ' + e.message, 3600); }
  });

  /* 自动纠错（反思纠错的配置）。与上面两块同一模式：改了立刻存。
     「用字幕翻译的模型」勾上时不填自定义地址；要**本地部署**（Qwen3 等）就取消勾选，
     把地址指向本机的 OpenAI 兼容服务 —— 本机地址免 API Key（见服务端 correctReady）。 */
  function correctFill(v) {
    if (!v) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    set('st-correct-mode', v.mode || 'preview');
    set('st-correct-pad', v.padSec);
    set('st-correct-max', v.maxSec);
    set('st-correct-batch', v.batchLines);
    chk('st-correct-usetranslate', v.useTranslate);
    const box = document.getElementById('st-correct-custom');
    if (box) {
      box.hidden = !!v.useTranslate;
      /* 跟随翻译时把这些输入框**一起 disable**：
       * 只 hidden 不 disable 的话，它们仍参与 Tab 焦点与表单语义，
       * 而且用户会以为"填了就能生效"（其实服务端整段忽略，见 correctCfg 的 `f = follow ? {} : t`）。 */
      box.querySelectorAll('input,select').forEach(el => { el.disabled = !!v.useTranslate; });
    }
    set('st-correct-baseurl', v.baseUrl || '');
    set('st-correct-model', v.model || '');
    const prov = document.getElementById('st-correct-provider');
    if (prov) {
      if (!prov.options.length && v.presets) {
        /* ⚠ 这里必须滤掉**不能做纠错**的本地引擎（NLLB）。
         * NLLB 是翻译专用的编码器-解码器模型：它只会"把一句翻成另一种语言"，
         * 不做自由文本生成，所以「通读全片找语句不通顺」这件事它根本干不了
         * （服务端 correctCfg 也完全没为它分流，选了只会拿到一个空 baseUrl → 永远不可用）。
         * 实测踩过：用户选了它，卡片就卡在"模型还不可用"且提示文案还是错的。 */
        const usable = (v.presets || []).filter(p => !p.local);
        prov.innerHTML = '<option value="">（不指定，用下面的地址）</option>'
          + usable.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
        // 旧配置里存着 local 预设时，下拉里没这个 option → 强制回到"不指定"，别显示成空白
        prov._presets = usable;
      }
      prov.value = v.provider || '';
      if (prov.value !== (v.provider || '')) prov.value = '';
    }
    const eff = document.getElementById('st-correct-eff');
    if (eff) {
      /* 取消勾选后，若地址与模型都还空着，服务端会**回退**到翻译配置
       * （correctCfg 的 pick() 兜底）。这是刻意的容错，但直接显示
       * "实际调用：deepseek-chat" 会让人以为"我明明取消了怎么还在用它" —— 说清楚。 */
      eff.textContent = v.useTranslate
        ? `实际调用：${v.effectiveModel}（跟随字幕翻译）`
        : (v.baseUrl && v.model
          ? `实际调用：${v.effectiveModel} @ ${v.effectiveBaseUrl}`
          : `还没填地址与模型名；在填好之前仍会临时沿用「${v.effectiveModel}」（跟随字幕翻译）`);
    }
    const note = document.getElementById('st-correct-note');
    if (note) {
      /* ⚠ 报错要指向**真正缺的那个东西**。
       * 原来不管什么原因都写"非本机地址必须填 API Key" ——
       * 地址明明是空的时候也这么说，把人往错方向引（实测踩过：
       * 用户以为要补 Key，其实是要么跟翻译、要么填地址）。 */
      if (v.ready) {
        note.innerHTML = '✓ 模型可用。纠错会消耗模型调用（长稿分批多次）；实际重识别的音频量由上面的「上下文」决定。';
      } else if (!v.effectiveBaseUrl || !v.effectiveModel) {
        note.innerHTML = '<span style="color:var(--danger)">模型还不可用：还没填「接口地址」与「模型名」</span>'
          + '<span class="gl-hint"> —— 想省事就勾上「用字幕翻译的模型」（跟着「翻译」页那套走）；'
          + '想单独指定就填一个 OpenAI 兼容服务的地址，本机地址（127.0.0.1）免 Key。</span>';
      } else if (!v.hasKey) {
        note.innerHTML = '<span style="color:var(--danger)">模型还不可用：这是非本机地址，必须填 API Key</span>';
      } else {
        note.innerHTML = `<span style="color:var(--danger)">模型还不可用：${esc(v.effectiveBaseUrl)} 这套配置没通过检查</span>`;
      }
    }
  }
  async function correctLoad() {
    try {
      correctFill(await (await fetch('/api/asr/correct', { signal: AbortSignal.timeout(8000) })).json());
    } catch {}
  }

  /* 重排逐词时间的设置（朗读语音 / 语速 / 最低锚点率）。
     与上面几块同一模式：改了立刻存，存完用服务端返回值回填（服务端会做范围夹取）。 */
  function realignFill(v) {
    if (!v) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    set('st-realign-rate', v.rate);
    set('st-realign-minratio', v.minAnchorRatio);
    set('st-realign-minconf', v.minConfidence);
    const rv = document.getElementById('st-realign-rate-val');
    if (rv) {
      const n = Number(v.rate) || 0;
      rv.textContent = n === 0 ? '0（正常）' : (n > 0 ? `+${n}（快）` : `${n}（慢）`);
    }
    const sel = document.getElementById('st-realign-voice');
    if (sel) {
      const keep = sel.value;
      sel.replaceChildren();
      const mk = (val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; return o; };
      sel.append(mk('', '（系统默认英文语音）'));
      // 只列**英文**语音：TTS 是拿英文台词去念的，中文/日文声音念英文会糊
      for (const vo of (v.voices || [])) {
        if (!/^en/i.test(String(vo.culture || ''))) continue;
        sel.append(mk(vo.name, `${vo.name}（${vo.culture}）`));
      }
      sel.value = (v.voice && [...sel.options].some(o => o.value === v.voice)) ? v.voice
        : (keep && [...sel.options].some(o => o.value === keep) ? keep : '');
    }
    const note = document.getElementById('st-realign-note');
    if (note) {
      const en = (v.voices || []).filter(vo => /^en/i.test(String(vo.culture || '')));
      note.textContent = en.length
        ? `本机可用的英文语音 ${en.length} 个。低于最低锚点率的对齐会被拒绝（不改动字幕），避免给出错的时间。`
        : '本机没找到英文语音 —— 会退回系统默认，识别准确率可能下降。'
          + '（Windows 设置 → 时间和语言 → 语音 里可以添加英文语音包）';
    }
  }
  async function realignLoad() {
    try {
      realignFill(await (await fetch('/api/asr/realign-settings', { signal: AbortSignal.timeout(10000) })).json());
    } catch {}
  }
  async function realignSave(patch) {
    try {
      const r = await fetch('/api/asr/realign-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const v = await r.json().catch(() => null);
      if (!r.ok) throw new Error((v && v.error) || ('HTTP ' + r.status));
      realignFill(v);
    } catch (e) { toast('重排设置保存失败: ' + e.message, 4200); }
  }
  {
    const bind = (id, key, num) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => realignSave({ [key]: num ? Number(el.value) : el.value }));
    };
    bind('st-realign-voice', 'voice');
    bind('st-realign-rate', 'rate', true);
    bind('st-realign-minratio', 'minAnchorRatio', true);
    bind('st-realign-minconf', 'minConfidence', true);
    // 拖动语速时先更新旁边的文字（松手才存）
    const rate = document.getElementById('st-realign-rate');
    if (rate) rate.addEventListener('input', () => {
      const rv = document.getElementById('st-realign-rate-val');
      const n = Number(rate.value) || 0;
      if (rv) rv.textContent = n === 0 ? '0（正常）' : (n > 0 ? `+${n}（快）` : `${n}（慢）`);
    });
  }
  async function correctSave(patch) {
    try {
      const r = await fetch('/api/asr/correct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const v = await r.json().catch(() => null);
      if (!r.ok) throw new Error((v && v.error) || ('HTTP ' + r.status));
      correctFill(v);
    } catch (e) { toast('纠错设置保存失败: ' + e.message, 4200); }
  }
  {
    const bind = (id, key, num) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => correctSave({ [key]: num ? Number(el.value) : el.value }));
    };
    bind('st-correct-mode', 'mode');
    bind('st-correct-pad', 'padSec', true);
    bind('st-correct-max', 'maxSec', true);
    bind('st-correct-batch', 'batchLines', true);
    bind('st-correct-baseurl', 'baseUrl');
    bind('st-correct-model', 'model');
    bind('st-correct-key', 'apiKey');
    /* 选服务商时**把该家的地址与模型名一起填上**（与「翻译」页同一行为）。
     * 原来只发 provider、不填地址 —— 于是选了 DeepSeek 地址栏还是空的，
     * 卡片继续报"还不可用"，用户以为选择没生效（实测踩过）。 */
    {
      const prov = document.getElementById('st-correct-provider');
      if (prov) prov.addEventListener('change', () => {
        const p = (prov._presets || []).find(x => x.id === prov.value);
        const patch = { provider: prov.value };
        if (p) {
          const bu = document.getElementById('st-correct-baseurl');
          const md = document.getElementById('st-correct-model');
          if (bu) bu.value = p.baseUrl || '';
          if (md) md.value = p.model || '';
          patch.baseUrl = p.baseUrl || '';
          patch.model = p.model || '';
        }
        correctSave(patch);
      });
    }
    const ut = document.getElementById('st-correct-usetranslate');
    if (ut) ut.addEventListener('change', async () => {
      const box = document.getElementById('st-correct-custom');
      if (box) {
        box.hidden = ut.checked;
        box.querySelectorAll('input,select').forEach(el => { el.disabled = ut.checked; });
      }
      /* 明确把开关状态发给服务端（两个方向都发）。
       * 早期这里在取消勾选时发的是 `{ baseUrl: 当前值 }`，而服务端靠"地址为空 ⇒ 跟随翻译"
       * 推断 —— 取消勾选那一刻地址还是空的，服务端又算回"跟随翻译"，勾选框被回弹，
       * **用户根本取消不掉**（实测复现）。现在走显式开关。 */
      await correctSave({ useTranslate: ut.checked });
      // 刚切到自定义而地址还空着时，把输入框顶到眼前，别让用户找不到该填什么
      if (!ut.checked) {
        const bu = document.getElementById('st-correct-baseurl');
        if (bu && !bu.value) bu.focus();
      }
    });
  }
  async function saveFetchSettings(patch) {
    try {
      const r = await fetch('/api/fetch/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const d = await r.json().catch(() => null);
      if (d && d.check) {
        const note = $('#st-fetch-cookie-note');
        if (note) note.textContent = cookieNote(d, d.check);
      }
      loadFetchSettings();
      return d;
    } catch (e) { toast('保存失败: ' + e.message, 3600); return null; }
  }
  for (const pair of [['st-fetch-quality', 'quality'], ['st-fetch-proxy', 'proxy'], ['st-fetch-browser', 'cookiesFromBrowser']]) {
    const el = document.getElementById(pair[0]);
    if (el) el.addEventListener('change', () => saveFetchSettings({ [pair[1]]: el.value }));
  }
  const cookieSaveBtn = document.getElementById('st-fetch-cookie-save');
  if (cookieSaveBtn) cookieSaveBtn.addEventListener('click', async () => {
    const v = (document.getElementById('st-fetch-cookie').value || '').trim();
    if (!v) { toast('先把浏览器里的 Cookie 粘进来（至少要有 SESSDATA）', 4200); return; }
    const note = $('#st-fetch-cookie-note');
    if (note) note.textContent = '已保存，正在验证登录 …';
    const d = await saveFetchSettings({ biliCookie: v });
    document.getElementById('st-fetch-cookie').value = '';
    if (d && d.check) {
      toast(d.check.isLogin ? ('✓ ' + d.check.message) : ('✗ ' + d.check.message), d.check.isLogin ? 4200 : 6000);
    } else {
      toast('已保存 bilibili Cookie（密文）', 3000);
    }
    if (d && d.cookieFixed && note) note.title = '你只贴了 SESSDATA 的值，已按 SESSDATA=… 保存';
  });
  const cookieClearBtn = document.getElementById('st-fetch-cookie-clear');
  if (cookieClearBtn) cookieClearBtn.addEventListener('click', () => { saveFetchSettings({ biliCookie: '' }); toast('已清除 bilibili Cookie', 3000); });
  // 编辑器工具栏也有一个设置入口(同一套面板)
  const edSettingsBtn = document.getElementById('btn-settings-ed');
  if (edSettingsBtn) edSettingsBtn.addEventListener('click', openSettings);
  $('#st-close').addEventListener('click', returnFromSettings);
  $('#st-cancel').addEventListener('click', returnFromSettings);

  $('#st-provider').addEventListener('change', () => {
    const p = stPresets.find(x => x.id === $('#st-provider').value);
    if (p && p.baseUrl) { $('#st-baseurl').value = p.baseUrl; $('#st-model').value = p.model; }
  });

  /* ─────────── 术语表词条编辑器 ───────────
   * 按目标语言分组: 每组一张词条表(原文 → 译法), 翻译时只把当前组的词条注入提示词。
   * 存盘格式仍是文本('##组名' 分节 + '原文=译法' 行), 服务端 parseGlossary 按目标语言取组。 */
  const GL_LANGS = ['简体', '繁體', 'English'];
  const glState = { lang: '简体', terms: {} };
  function glReset() { for (const l of GL_LANGS) glState.terms[l] = []; }
  glReset();

  function glParse(text) {
    glReset();
    let cur = '简体';
    for (const raw of String(text || '').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      const sec = /^##\s*(.+)$/.exec(l);
      if (sec) {
        const name = sec[1].trim();
        cur = GL_LANGS.includes(name) ? name : (GL_LANGS.find(x => x.toLowerCase() === name.toLowerCase()) || '简体');
        continue;
      }
      const m = /^(.+?)\s*=\s*(.+)$/.exec(l) || /^(\S+)\s+(.+)$/.exec(l);
      if (m) glState.terms[cur].push([m[1].trim(), m[2].trim()]);
    }
  }
  function glSerialize() {
    const out = [];
    for (const l of GL_LANGS) {
      const rows = glState.terms[l].filter(([a, b]) => a && b);
      if (!rows.length) continue;
      out.push('##' + l);
      for (const [a, b] of rows) out.push(a + '=' + b);
    }
    return out.join('\n');
  }
  function glRender() {
    const tabs = $('#gl-tabs'), box = $('#gl-rows'), name = $('#gl-langname');
    if (!tabs || !box) return;
    tabs.innerHTML = GL_LANGS.map(l => {
      const n = glState.terms[l].filter(([a, b]) => a && b).length;
      return `<button type="button" class="gl-tab${l === glState.lang ? ' active' : ''}" data-lang="${esc(l)}"
        title="${esc(l)}：${n} 条词条">${esc(l)}${n ? ' · ' + n : ''}</button>`;
    }).join('');
    tabs.querySelectorAll('.gl-tab').forEach(b => b.addEventListener('click', () => {
      glState.lang = b.dataset.lang;
      glRender();
    }));
    if (name) name.textContent = glState.lang;
    const rows = glState.terms[glState.lang];
    box.innerHTML = rows.length ? '' : '<div class="gl-empty">' + esc(t('还没有词条，点上面的「＋ 添加词条」')) + '</div>';
    rows.forEach((pair, i) => {
      const row = document.createElement('div');
      row.className = 'gl-row';
      row.innerHTML = `<input type="text" class="gl-input gl-src" spellcheck="false" placeholder="${esc(t('原文词（如 Spike）'))}">
        <input type="text" class="gl-input gl-dst" spellcheck="false" placeholder="${esc(t('译法（如 斯派克）'))}">
        <button type="button" class="gl-del" title="${esc(t('删除该词条'))}">${ico('trash')}</button>`;
      const [srcEl, dstEl] = row.querySelectorAll('.gl-input');
      srcEl.value = pair[0] || '';
      dstEl.value = pair[1] || '';
      srcEl.addEventListener('input', () => { rows[i][0] = srcEl.value; });
      dstEl.addEventListener('input', () => { rows[i][1] = dstEl.value; });
      row.querySelector('.gl-del').addEventListener('click', () => { rows.splice(i, 1); glRender(); });
      box.appendChild(row);
    });
  }
  function glLoad(text, lang) {
    glParse(text);
    if (GL_LANGS.includes(lang)) glState.lang = lang;
    else {
      // 旧配置没有分组标记时, 落在哪组就切到哪组(免得用户以为词条丢了)
      const only = GL_LANGS.filter(l => glState.terms[l].length);
      if (only.length === 1) glState.lang = only[0];
    }
    glRender();
  }
  const glAddBtn = $('#gl-add');
  if (glAddBtn) glAddBtn.addEventListener('click', () => {
    glState.terms[glState.lang].push(['', '']);
    glRender();
    const srcs = $('#gl-rows').querySelectorAll('.gl-src');
    if (srcs.length) srcs[srcs.length - 1].focus();
  });

  async function collectSettings() {
    // 识别提示词是独立的一块(asr/settings.json 的 asr 段), 与翻译配置分开存
    try {
      await fetch('/api/asr/hint', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: collectHotwords(),
          hotwordsScore: parseFloat($('#ah-score').value) || 3,
        })
      });
    } catch { /* 保存失败不阻断翻译配置的保存 */ }
    const payload = {
      provider: $('#st-provider').value,
      baseUrl: $('#st-baseurl').value.trim(),
      model: $('#st-model').value.trim(),
      batchSize: parseInt(($('#st-batch') || {}).value, 10) || 25,     // 每批行数(服务端还会夹到 5~100)
      prompt: $('#st-prompt').value,
      glossary: glSerialize(),
      glossaryLang: glState.lang,
    };
    // API Key: 非空才提交(服务端加密落盘); 留空 = 保持已存 Key 不变 —— 绝不把空串当"清除"
    const newKey = $('#st-key').value.trim();
    if (newKey) payload.apiKey = newKey;
    return payload;
  }
  async function postSettings() {
    const payload = await collectSettings();     // collectSettings 会顺带保存识别提示词(异步)
    const r = await fetch('/api/translate/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const m = await r.json();
    if (!r.ok) throw new Error(m.error || '保存失败');
    if (payload.apiKey) {
      // 保存成功后立刻清掉输入框里的明文(服务端已加密存好), 不让 Key 一直躺在 DOM 里
      $('#st-key').value = '';
      $('#st-key').placeholder = '已保存（留空不修改）';
    }
    refreshKeyHint(m.cfg || {});
    return m;
  }
  $('#st-test').addEventListener('click', async () => {
    const btn = $('#st-test');
    btn.disabled = true; btn.textContent = '测试中…';
    try {
      await postSettings();                    // 先落盘再测, 测的就是要用的那份配置
      const r = await (await fetch('/api/translate/test', { method: 'POST' })).json();
      $('#st-msg').textContent = r.ok ? ('✓ 连接成功：' + (r.reply || '')) : ('✗ ' + (r.error || '连接失败'));
      $('#st-msg').classList.toggle('err', !r.ok);
    } catch (e) {
      $('#st-msg').textContent = '✗ ' + e.message;
      $('#st-msg').classList.add('err');
    } finally { btn.disabled = false; btn.textContent = '测试连接'; }
  });
  $('#st-save').addEventListener('click', async () => {
    const msgEl = $('#st-msg');
    const visit = settingsVisit;
    try {
      const m = await postSettings();
      msgEl.textContent = m.ready ? '✓ 已保存，翻译可用' : '已保存，但接口地址、API Key、模型名没填全，暂时不能翻译';
      msgEl.classList.remove('err');
      if (location.hash === '#/settings' && settingsVisit === visit) setTimeout(() => {
        if (location.hash === '#/settings' && settingsVisit === visit) returnFromSettings();
      }, 600);
    } catch (e) {
      msgEl.textContent = '✗ ' + e.message;
      msgEl.classList.add('err');
    }
  });
  /* 「清除已存 Key」: 立即生效(独立于普通保存), 避免"留空=不修改"之后没有办法删 Key */
  const stKeyClearLink = $('#st-key-clear');
  if (stKeyClearLink) stKeyClearLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const msgEl = $('#st-msg');
    try {
      const r = await fetch('/api/translate/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeyClear: true })
      });
      const m = await r.json();
      if (!r.ok) throw new Error(m.error || ('HTTP ' + r.status));
      $('#st-key').value = '';
      $('#st-key').placeholder = 'sk-…';
      refreshKeyHint(m.cfg || {});
      msgEl.textContent = '✓ 已清除保存的 API Key';
      msgEl.classList.remove('err');
    } catch (err) {
      msgEl.textContent = '✗ 清除失败：' + String((err && err.message) || err);
      msgEl.classList.add('err');
    }
  });

  function detachProject() {
    clearTimeout(saveTimer);
    clearInterval(pollTimer); pollTimer = 0;
    state.project = null;
    setPlaybackAudioMode(null, false);          // 脱离项目: 播放恢复视频原声
    const el = $('#save-state');
    if (el) el.hidden = true;
  }

  /* ─────────── 新建项目页面 ─────────── */
  const npView = $('#np-view');
  let npSubmitting = false;
  const npVideo = { path: '', name: '' };
  const npSub = { name: '', text: '' };
  // 项目压缩包导入：选中包后先只记文件名，点「创建项目」时才上传（几十 MB 不该选完就传）
  const npPack = { file: null, name: '' };
  let npMode = 'import';                 // 'import' | 'draft'
  let asrStatus = { ready: false, modelDir: '', missing: [], pythonOk: false };
  // 浏览器选的视频: File 对象暂存(npMode 提交时经 /api/upload-video 落盘),
  // path 置为 'upload:<name>' 占位 —— npMaybeEnable 只判断 path 非空, 不关心来源
  let npVideoFile = null;
  // 「解析」结果缓存 { url, part, source }：同一链接不重复打远端接口；
  // 只读元数据（服务端 --simulate），不下载视频。
  let npProbeSource = null;
  let npProbing = false;
  let npConfSynced = false;              // 初稿模式的置信度档位是否已按全局默认同步过
  let asrConfDefaultCache = null;         // 全局「逐句置信度」档位（null=还不知道）
  const CONF_MODES = ['off', 'fast', 'full'];
  const CONF_DESC = {
    off: '不生成置信度 —— 识别最快，列表不会显示可信度',
    fast: '只用词级概率与音频质量（解码时白送），不做稳定性重跑 —— 速度与「关闭」相同，但仍有置信度',
    full: '三路信号齐全：额外把音频加噪重跑 2 遍做稳定性判定 —— 实测识别时间约翻倍',
  };
  /** 把档位的说明写到建稿页那一行的提示上 */
  function npConfDesc(mode) {
    const desc = $('#np-confidence-desc');
    if (desc) desc.textContent = CONF_DESC[mode] || CONF_DESC.full;
  }

  /** 取全局的逐句置信度档位（带缓存；拿不到就返回 null，调用方按"完整"处理）。 */
  async function asrConfDefault() {
    if (asrConfDefaultCache !== null) return asrConfDefaultCache;
    try {
      const d = await (await fetch('/api/asr/confidence', { signal: AbortSignal.timeout(8000) })).json();
      asrConfDefaultCache = CONF_MODES.includes(d.mode) ? d.mode : 'full';
    } catch { /* 读不到就沿用默认（完整），不阻断建稿 */ }
    return asrConfDefaultCache;
  }

  /** 把全局档位套到新建页的下拉上（只做一次，别覆盖用户的改动）。 */
  async function syncConfidenceFromGlobal() {
    const mode = (await asrConfDefault()) || 'full';
    if (npConfSyncedByUser) return;                    // 期间用户已经手动改过 → 尊重他的选择
    const sel = $('#np-confidence');
    if (sel) sel.value = mode;
    npConfDesc(mode);
  }
  /** 用户手动动过下拉 → 之后不再被全局默认覆盖 */
  let npConfSyncedByUser = false;
  (() => {
    const sel = document.getElementById('np-confidence');
    if (sel) sel.addEventListener('change', () => {
      npConfSyncedByUser = true;
      npConfDesc(sel.value);
    });
  })();

  function npSetMode(mode) {
    npMode = mode;
    $('#np-mode-import').classList.toggle('active', mode === 'import');
    $('#np-mode-import').setAttribute('aria-pressed', String(mode === 'import'));
    $('#np-mode-draft').classList.toggle('active', mode === 'draft');
    $('#np-mode-draft').setAttribute('aria-pressed', String(mode === 'draft'));
    const draft = mode === 'draft';
    $('#np-row-sub').hidden = draft;
    // 项目包导入也是"导入模式"的事（初稿模式是从视频识别，用不上包）
    const rowPack = $('#np-row-pack');
    if (rowPack) rowPack.hidden = draft;
    // 区域裁剪两种模式都可能有意义：导入模式裁字幕/包；初稿模式暂时用不上（识别本来就全片）
    const rowRegion = $('#np-row-region');
    if (rowRegion) rowRegion.hidden = draft;
    // 从初稿切回导入模式时，若之前选过包，得让"字幕"行也可见（两者互斥但都显示）
    $('#np-row-url').hidden = !draft;      // 链接只在初稿模式有意义（导入模式是本地文件）
    $('#np-row-part').hidden = !draft;     // 分P 跟着链接走
    $('#np-row-word').hidden = !draft;
    $('#np-row-conf').hidden = !draft;
    $('#np-row-spk').hidden = !draft;
    // 切进初稿模式时，把开关同步成**全局默认**（用户没动过就跟随；动过则以他刚选的为准）。
    // 只在第一次进入时拉一次，避免每次切模式都把用户的改动冲掉。
    if (draft && !npConfSynced) { npConfSynced = true; syncConfidenceFromGlobal(); }
    // 语音识别 / 识别来源 / 分角色识别：整组跟着模式收起
    // （这三组只有「创建初稿」用得上；翻译模型/提示词是全局项，两种模式都留着）
    for (const sel of ['#np-voice-group', '#np-cast-group', '#np-source-group']) {
      const g = $(sel);
      if (g) g.hidden = !draft;
    }
    // 「创建后自动处理」只在初稿模式有意义（导入模式的字幕是用户自己的，不该被自动改）
    const autoWrap = $('#np-auto-wrap');
    if (autoWrap) autoWrap.hidden = !draft;
    $('#np-hint').textContent = draft
      ? '创建后在后台识别，进度看项目列表'
      : '音频和波形会自动存进项目，下次打开就不用重新生成；字幕边改边存';
    $('#np-hint').style.color = '';
    $('#np-create').textContent = draft ? '开始识别' : '创建项目';
    if (draft) refreshAsrStatus();
  if (draft) {
    const u = $('#np-url');
    if (u && !u.dataset.bound) { u.dataset.bound = '1'; u.addEventListener('input', npMaybeEnable); u.addEventListener('change', npMaybeEnable); }
  }
    npMaybeEnable();
  }

  /** 拉取识别模型状态: 填「识别来源」+「语音识别」两个下拉
   *  —— 走 genRender 的统一通道，避免和生成设置面板抢同一个 select。 */
  async function refreshAsrStatus(force) {
    if (force || !genAsr) {
      try { genAsr = await (await fetch('/api/asr/status')).json(); }
      catch { genAsr = { ready: false, models: [] }; }
    }
    asrStatus = genAsr;
    genRender('np');
    genSetState('np', (genTr && genTr.ready) ? '已配置' : '翻译未配置');
    // Python 环境预检失败 → 提前提醒(不拦按钮: whisper.cpp 引擎不需要 Python, 由服务端预检按引擎分流)
    const hint = $('#np-hint');
    const probeForUi = (() => {
      const pp = asrStatus.pythonProbe;
      if (!pp) return null;
      if (typeof pp.ok === 'boolean') return pp;                 // 旧扁平形状
      return asrStatus.pythonProbeFlat || null;                  // 服务端按当前引擎挑好的
    })();
    if (hint && probeForUi && !probeForUi.ok) {
      hint.textContent = '⚠ Python 环境不可用：' + probeForUi.msg + '。Parakeet 模型需要 Python（修复方法见创建后的日志）；whisper.cpp 和「必剪 ASR」云端识别都不需要 Python';
      hint.style.color = '#ff9a5c';
    }
    npMaybeEnable();
  }

  function npReset() {
    npVideo.path = npVideo.name = '';
    npSub.name = npSub.text = '';
    npVideoFile = null;
    npProbeSource = null;
    $('#np-name').value = '';
    $('#np-word').checked = true;
    $('#np-word-desc').textContent = '开启 → 生成 ASS 逐词字幕';
    $('#np-speakers').checked = false;
    $('#np-spk-count').value = '';
    $('#np-part').value = '1';
    const npUrlEl = $('#np-url');
    if (npUrlEl) npUrlEl.value = '';
    $('#np-video-name').textContent = '还没选';
    $('#np-video-name').classList.remove('filled');
    $('#np-sub-name').textContent = '还没选';
    $('#np-sub-name').classList.remove('filled');
    $('#np-create').disabled = true;
    // 稿件预览回到空态：解析结果不跨次保留，免得看到上一个链接的标题
    fillPreview('np', null);
    setNpBadge('等待确认', 'muted');
    const probeBtn = $('#np-probe');
    if (probeBtn) { probeBtn.disabled = false; probeBtn.textContent = '解析'; }
    renderDpSteps(-1, '#np-steps');     // 处理进度：全灰的静态预览（真正跑起来在项目列表看）
    npSetMode('import');
    npSyncSpeakers();       // 逐词默认开 → 说话人可勾; 切到 SRT 时自动取消并禁用
  }
  /** 预览面板右上角的状态徽标：tone = '' | 'ok' | 'muted' | 'err' */
  function setNpBadge(text, tone) {
    const el = $('#np-preview-badge');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-muted', tone === 'muted');
    el.classList.toggle('is-err', tone === 'err');
    el.classList.toggle('is-ok', tone === 'ok');
  }
  function npMaybeEnable() {
    const npUrlNow = (($('#np-url') || {}).value || '').trim();
    const hasSource = !!npVideo.path || (npMode === 'draft' && !!npUrlNow);
    if (!hasSource) { $('#np-create').disabled = true; return; }
    // 初稿模式不需要字幕文件, 但必须有可用的识别模型
    const hasModel = npMode !== 'draft' || !!($('#np-model-sel') && $('#np-model-sel').value);
    // 导入模式：字幕文件**或**项目包，二选一即可
    const hasSubOrPack = npMode === 'draft' ? true : (!!npSub.text || !!npPack.file);
    // 填了非法区间就别让点（提示已经在 npRegionFeedback 里给了）
    const regionOk = npReadRegion().ok;
    // 初稿模式必须有可用的识别模型（导入模式不需要）
    const draftReady = npMode !== 'draft' || !!asrStatus.ready;
    $('#np-create').disabled = !hasSubOrPack || !hasModel || !regionOk || !draftReady;
  }
  $('#btn-new-project').addEventListener('click', () => {
    newOpenedFromApp = true;
    location.hash = '#/new';
  });
  const leaveNew = () => {
    if (npSubmitting) return;
    if (newOpenedFromApp) history.back();
    else replaceRoute('#/home');
  };
  $('#np-back').addEventListener('click', leaveNew);
  $('#np-cancel').addEventListener('click', leaveNew);
  $('#np-open-settings').addEventListener('click', () => {
    if (!npSubmitting) openSettings('models');
  });
  // 详细信息页的「管理模型」走同一条路（设置页返回时回到这个项目的详细信息）
  const dtOpenSettings = $('#dt-open-settings');
  if (dtOpenSettings) dtOpenSettings.addEventListener('click', () => openSettings('models'));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !$('#confirm-overlay').hidden) return;
    if (location.hash === '#/new') leaveNew();
    else if (location.hash === '#/settings' && !$('#st-save').disabled) returnFromSettings();
    else if (location.hash.startsWith('#/details/') && !detailSave.disabled) returnFromDetails();
  });

  $('#np-mode-import').addEventListener('click', () => npSetMode('import'));
  $('#np-mode-draft').addEventListener('click', () => npSetMode('draft'));
  /** 逐词开关 → 说话人开关联动: SRT 没有角色概念(编辑器里禁用角色 Tab/筛选),
   *  所以关掉逐词时必须把「区分说话人」一并取消并禁用, 免得用户勾了却拿不到角色。 */
  function npSyncSpeakers() {
    const wordOn = !!($('#np-word') && $('#np-word').checked);
    const root = $('#np-row-spk');
    const box = $('#np-speakers');
    const cnt = $('#np-spk-count');
    if (!root || !box) return;
    box.disabled = !wordOn;
    if (cnt) cnt.disabled = !wordOn || !box.checked;
    if (!wordOn && box.checked) box.checked = false;      // SRT 用不上 → 自动取消
    root.classList.toggle('disabled', !wordOn);
    root.title = wordOn ? '' : 'SRT 模式没有角色（说话人）概念，需要开启逐词（生成 ASS）才能区分说话人';
  }
  $('#np-word').addEventListener('change', () => {
    $('#np-word-desc').textContent = $('#np-word').checked
      ? '开启 → 生成 ASS 逐词字幕' : '关闭 → 生成 SRT 纯文本字幕';
    npSyncSpeakers();
  });
  const npSpk = $('#np-speakers');
  if (npSpk) npSpk.addEventListener('change', npSyncSpeakers);

  /** 视频选择(双通道):
   *  ① 服务端原生对话框(快, 直接返回本地路径, 视频不复制); 35s 超时/失败 → ②
   *  ② 浏览器 <input type=file>(任何环境都能用): File 暂存, 创建项目时经
   *     /api/upload-video 落盘成服务端持久文件, 之后与本地路径完全同构。 */
  let npPicking = false;
  $('#np-pick-video').addEventListener('click', async () => {
    if (npPicking) return;                       // 防双击重复触发
    npPicking = true;
    const btn = $('#np-pick-video');
    const oldLabel = btn.textContent;
    btn.textContent = '打开选择框…';
    toast('正在打开文件选择窗口…没看到的话看任务栏图标', 2600);
    let pick = null, usedBrowser = false;
    try {
      const ctl = new AbortController();
      const killer = setTimeout(() => ctl.abort(), 38000);   // 服务端 35s 超时 + 余量
      const r = await fetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'video' }),
        signal: ctl.signal
      });
      clearTimeout(killer);
      pick = await r.json();
    } catch { pick = null; }
    if (!pick || (!pick.path && pick.fallback)) {
      // 原生对话框没弹出来(超时/出错) → 自动降级浏览器选择
      usedBrowser = true;
      toast('系统对话框不可用，已改用浏览器选择（视频会复制一份进程序目录）', 4200);
      const f = await browserPickVideo();
      btn.textContent = oldLabel; npPicking = false;
      if (!f) return;
      npVideoFile = f;
      npVideo.path = 'upload:' + f.name;
      npVideo.name = f.name;
    } else {
      btn.textContent = oldLabel; npPicking = false;
      npVideoFile = null;
      if (!pick.path) { if (pick.error) toast(pick.error, 3200); return; }
      npVideo.path = pick.path; npVideo.name = pick.name;
    }
    const el = $('#np-video-name');
    el.textContent = npVideo.name + (usedBrowser ? '（浏览器选择）' : '');
    el.classList.add('filled');
    if (!$('#np-name').value.trim()) $('#np-name').value = npVideo.name.replace(/\.[^.]+$/, '');
    npMaybeEnable();
  });
  /** 浏览器选视频: 动态建 input[type=file], 返回 Promise<File> 或 null */
  function browserPickVideo() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'video/*,.mkv,.avi,.mov,.m4v';
      inp.style.display = 'none';
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        resolve(f || null);
      });
      // 用户取消时 change 不触发 —— 兜底: 失焦 60s 后自动 resolve(null)
      document.body.appendChild(inp);
      inp.click();
      setTimeout(() => { if (inp.isConnected) { inp.remove(); resolve(null); } }, 60000);
    });
  }
  /* ── 区域字幕导入（按时间区间裁剪）──
   * 默认整片；勾了「只导入一段」才裁。跨界行**整行保留**（不切文字，见 region.js）。 */

  /** 读当前填的区间。返回 { ok, region, error }；未勾选或都留空 → region.active=false */
  function npReadRegion() {
    const on = !!($('#np-region-on') || {}).checked;
    if (!on) return { ok: true, region: normalizeRegion(null, null), error: '' };
    const r = normalizeRegion(($('#np-region-start') || {}).value, ($('#np-region-end') || {}).value);
    return { ok: r.ok, region: r, error: r.error };
  }

  /** 实时回显区间状态（合法/非法）——输入时就告诉用户，而不是点了创建才报错 */
  function npRegionFeedback() {
    const note = $('#np-region-note');
    if (!note) return;
    const { ok, region, error } = npReadRegion();
    /* ⚠ 顺序要紧：**先判 ok 再判 active**。
     * normalizeRegion 对非法输入的返回值是 { ok:false, active:false }，
     * 所以"先判 active"会把非法输入当成"没填区间"直接清空提示 ——
     * 用户填了 90~30 却什么也看不到，点创建时才发现被拦下。
     * （这个顺序错误真的写错过一次，靠浏览器里的实测才发现。） */
    if (!ok) { note.textContent = error; note.className = 'np-region-note bad'; return; }
    if (!region.active) { note.textContent = ''; note.className = 'np-region-note'; return; }
    // 只显示"只导入 x ~ y"这半句（保留行数要等真读过字幕才知道，这里不猜）
    const head = regionSummary(region, 0, 0);
    note.textContent = head ? head.split('：')[0] : '';
    note.className = 'np-region-note';
  }

  /**
   * 按时间区间裁剪字幕文本。
   * SRT / ASS 各自解析 → 过滤 → 回写**同一种格式**（不擅自改格式）。
   * @returns {{ text:string, kept:number, dropped:number, summary:string, error:string }}
   */
  function npClipSubtitle(text, name, region) {
    if (!region || !region.active) return { text, kept: -1, dropped: 0, summary: '', error: '' };
    const isAss = /\.(ass|ssa)$/i.test(name || '');
    if (isAss) {
      let doc;
      try { doc = new AssDoc(text); } catch (e) { return { text, kept: -1, dropped: 0, summary: '', error: '这个 ASS 解析不了：' + e.message }; }
      const before = doc.events.length;
      const keep = doc.events.filter(ev => filterCues([ev], region.start, region.end, true).kept.length);
      const gone = doc.events.filter(ev => !keep.includes(ev));
      if (gone.length) doc.deleteEvents(gone);
      const r = { text: doc.serialize(), kept: keep.length, dropped: before - keep.length, summary: '', error: '' };
      r.summary = regionSummary(region, r.kept, r.dropped);
      return r;
    }
    let cues;
    try { cues = parseSRT(text); } catch (e) { return { text, kept: -1, dropped: 0, summary: '', error: '这个 SRT 解析不了：' + e.message }; }
    if (!cues.length) return { text, kept: -1, dropped: 0, summary: '', error: '这个文件里没解析出字幕行' };
    const f = filterCues(cues, region.start, region.end, true);
    const r = {
      text: serializeSRT(f.kept), kept: f.kept.length, dropped: f.dropped,
      summary: '', error: '',
      from: f.from, to: f.to,
    };
    r.summary = regionSummary(region, r.kept, r.dropped);
    return r;
  }

  /** 选中项目包（不立刻上传，点创建时才传） */
  $('#np-pick-pack').addEventListener('click', () => $('#np-file-pack').click());
  $('#np-file-pack').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) { toast('项目包是 .zip 文件，这个不是', 3600); return; }
    npPack.file = f;
    npPack.name = f.name;
    // 选了包就把字幕文件让出来（两种取材方式互斥，避免用户以为两个都会用上）
    npSub.name = ''; npSub.text = '';
    const subEl = $('#np-sub-name');
    if (subEl) { subEl.textContent = '还没选'; subEl.classList.remove('filled'); }
    const el = $('#np-pack-name');
    el.textContent = f.name + '（' + (f.size / 1024).toFixed(0) + ' KB）';
    el.classList.add('filled');
    npMaybeEnable();
  });

  $('#np-region-on').addEventListener('change', () => {
    const on = $('#np-region-on').checked;
    $('#np-region-fields').hidden = !on;
    if (on) { const s = $('#np-region-start'); if (s) s.focus(); }
    npRegionFeedback();
    npMaybeEnable();
  });
  for (const sel of ['#np-region-start', '#np-region-end']) {
    const el = $(sel);
    if (el) el.addEventListener('input', npRegionFeedback);
  }

  $('#np-pick-sub').addEventListener('click', () => $('#np-file-sub').click());
  $('#np-file-sub').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    npSub.name = f.name;
    npSub.text = await f.text();
    // 导入前把「带特效的导出文件」转成普通字幕（用户报的 bug：直接导入会字幕块破碎 ——
    // 微光/生长/淡入标签污染了逐词 span, 切片识别失败, 每个词都成了独立的块）。
    // 转换异常/结果可疑时 stripEffectTagsSafe 返回原文（硬塞, 宁可回到旧行为也不丢内容）。
    if (/\.(ass|ssa)$/i.test(f.name)) {
      const { text, cleaned } = stripEffectTagsSafe(npSub.text);
      npSub.text = text;
      if (cleaned) toast('已把带特效的字幕转成普通字幕（微光/生长/淡入标签已剥离），避免导入后字幕块破碎', 6000);
    }
    const el = $('#np-sub-name');
    el.textContent = f.name; el.classList.add('filled');
    npMaybeEnable();
  });
  // 分P: 链接里带 ?p=N 就自动填进分P框（两个入口都认, 用户不用记）
  const npUrlEl = document.getElementById('np-url');
  const npPartEl = document.getElementById('np-part');
  if (npUrlEl && npPartEl) {
    npUrlEl.addEventListener('input', () => {
      const m = /[?&]p=(\d+)/.exec(npUrlEl.value || '');
      if (m) npPartEl.value = String(Math.max(1, parseInt(m[1], 10) || 1));
    });
  }
  /** 只粘 BV 号 / av 号也认（参考图里的「BV 号」入口）→ 补成完整链接再交给下载内核 */
  function normalizeVideoUrl(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^BV[0-9A-Za-z]{10}$/.test(s)) return 'https://www.bilibili.com/video/' + s;
    if (/^av\d{1,12}$/i.test(s)) return 'https://www.bilibili.com/video/' + s.toLowerCase();
    return s;
  }
  /* 「解析」按钮：只读视频元数据（服务端 --simulate，不下载），把标题/作者/简介/缩略图
   * 铺到左侧「稿件预览」—— 下载几百 MB 之前先确认是不是要找的那支视频。
   * 同一链接 + 同一分P 只解析一次，重复点击直接回显缓存。 */
  const npProbeBtn = $('#np-probe');
  if (npProbeBtn) npProbeBtn.addEventListener('click', async () => {
    if (npProbing) return;
    const url = normalizeVideoUrl((npUrlEl || {}).value);
    if (!url) { toast('先把视频链接粘进来', 3000); if (npUrlEl) npUrlEl.focus(); return; }
    const part = Math.max(1, parseInt((npPartEl || {}).value, 10) || 1);
    if (npProbeSource && npProbeSource.url === url && npProbeSource.part === part) {
      fillPreview('np', npProbeSource.source);
      setNpBadge(npProbeSource.source ? '已解析' : '没读到信息', npProbeSource.source ? 'ok' : 'muted');
      return;
    }
    npProbing = true;
    const oldLabel = npProbeBtn.textContent;
    npProbeBtn.disabled = true;
    npProbeBtn.textContent = '解析中…';
    setNpBadge('解析中…', 'muted');
    try {
      const r = await fetch('/api/fetch/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, part }),
      });
      const m = await r.json().catch(() => ({}));
      if (!r.ok || m.error) {
        toast(m.error || '解析失败，检查链接或登录态', 4800);
        setNpBadge('解析失败', 'err');
        return;
      }
      const src = m.source || null;
      npProbeSource = { url, part, source: src };
      const ok = fillPreview('np', src);
      setNpBadge(ok ? '已解析' : '没读到信息', ok ? 'ok' : 'muted');
      // 项目名称空着才用标题自动填，别覆盖用户自己写的
      const nameEl = $('#np-name');
      if (ok && nameEl && !nameEl.value.trim() && src && src.title) {
        nameEl.value = String(src.title).slice(0, 60);
      }
    } catch (e) {
      toast('解析失败: ' + e.message, 4000);
      setNpBadge('解析失败', 'err');
    } finally {
      npProbing = false;
      npProbeBtn.disabled = false;
      npProbeBtn.textContent = oldLabel;
    }
  });
  $('#np-create').addEventListener('click', async () => {
    const isDraft = npMode === 'draft';
    const npUrl = normalizeVideoUrl(($('#np-url') || {}).value);
    // ── 链接模式: 交给服务端下载 + 跑初稿（视频落在项目目录里） ──
    if (isDraft && npUrl) {
      const btn0 = $('#np-create');
      btn0.disabled = true; btn0.textContent = '提交中…';
      npSubmitting = true;
      $('#np-open-settings').disabled = true;
      try {
        const payload0 = {
          name: $('#np-name').value.trim(),
          draft: true,
          wordLevel: !!$('#np-word').checked,
          modelId: $('#np-model-sel') ? $('#np-model-sel').value : '',
          speakers: !!($('#np-speakers') && $('#np-speakers').checked),
          speakerCount: parseInt($('#np-spk-count') ? $('#np-spk-count').value : '', 10) || 6,
          confidence: ($('#np-confidence') || {}).value || 'full',
          // 「创建后自动处理」：出稿后自动跑 反思纠错 + 全片逐词重校对
          autoPost: !!($('#np-autopost') && $('#np-autopost').checked),
          fetch: { url: npUrl, part: Math.max(1, parseInt((npPartEl || {}).value, 10) || 1) },
        };
        if (payload0.speakers) localStorage.setItem('ss-role-annot', '1');
        const r0 = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload0) });
        const m0 = await r0.json();
        if (!r0.ok) { toast(m0.error || '创建失败', 4200); return; }
        location.hash = '#/home';
        toast('开始下载了，不用等着；进度看项目列表', 5200);
      } catch (e) {
        toast('创建失败: ' + e.message, 3600);
      } finally {
        npSubmitting = false;
        $('#np-open-settings').disabled = false;
        btn0.textContent = '开始识别';
        npMaybeEnable();
      }
      return;
    }
    const btn = $('#np-create');
    btn.disabled = true; btn.textContent = isDraft ? '提交中…' : '创建中…';
    npSubmitting = true;
    $('#np-open-settings').disabled = true;
    try {
      // ── 项目包导入：上传 zip → 服务端建新项目 → 再走下面同一条"上传视频 + prepare"链路 ──
      // （包里没有视频与音频，所以导入完成后视频仍要走正常流程生成音频与波形）
      if (!isDraft && npPack.file) {
        btn.textContent = '导入项目包中…';
        const up = await fetch('/api/projects/import-pack', {
          method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: npPack.file,
        });
        const um = await up.json().catch(() => ({}));
        if (!up.ok || !um.id) { toast('导入失败: ' + (um.error || up.status), 6000); return; }
        npPack.file = null; npPack.name = '';
        toast('项目包已导入，正在为它准备视频…', 4200);
        // 继续往下走：上传视频 → PUT 到新项目的 prepare
        const importedId = um.id;
        if (npVideo.path.startsWith('upload:')) {
          if (!npVideoFile) { toast('视频文件找不到了，重新选一个', 3600); return; }
          btn.textContent = '上传视频中…';
          const uv = await fetch('/api/upload-video?name=' + encodeURIComponent(npVideoFile.name), {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: npVideoFile,
          });
          const uvm = await uv.json().catch(() => ({}));
          if (!uv.ok || !uvm.path) { toast('视频上传失败: ' + (uvm.error || uv.status), 5000); return; }
          npVideo.path = uvm.path; npVideo.name = uvm.name; npVideoFile = null;
        }
        const pr = await fetch('/api/projects/' + importedId + '/relink', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: npVideo.path }),
        });
        const prm = await pr.json().catch(() => ({}));
        if (!pr.ok) { toast('视频关联失败: ' + (prm.error || pr.status), 5000); return; }
        location.hash = '#/project/' + importedId;
        toast('项目包已导入；音频与波形正在后台生成', 5200);
        return;
      }
      // 浏览器选的视频: 先把 File 上传成服务端持久文件, 拿到真实路径后走同一条创建链路
      if (npVideo.path.startsWith('upload:')) {
        if (!npVideoFile) { toast('视频文件找不到了，重新选一个', 3600); return; }
        btn.textContent = '上传视频中…';
        const up = await fetch('/api/upload-video?name=' + encodeURIComponent(npVideoFile.name), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: npVideoFile
        });
        const um = await up.json().catch(() => ({}));
        if (!up.ok || !um.path) { toast('视频上传失败: ' + (um.error || up.status), 5000); return; }
        npVideo.path = um.path; npVideo.name = um.name;
        npVideoFile = null;
        btn.textContent = isDraft ? '提交中…' : '创建中…';
      }
      // 区域裁剪：只在勾选「只导入一段」时生效（默认整片）
      let region = normalizeRegion(null, null);
      let clipped = null;
      if (!isDraft) {
        const rr = npReadRegion();
        if (!rr.ok) { toast(rr.error, 5000); return; }
        region = rr.region;
        if (region.active) {
          const c = npClipSubtitle(npSub.text, npSub.name, region);
          if (c.error) { toast(c.error, 5600); return; }
          if (!c.kept) { toast('这个时间段里没有字幕，换个范围试试', 5200); return; }
          clipped = c;
        }
      }
      const payload = { name: $('#np-name').value.trim(), video: { path: npVideo.path, name: npVideo.name } };
      if (isDraft) {
        payload.draft = true;
        payload.wordLevel = !!$('#np-word').checked;
        payload.modelId = $('#np-model-sel') ? $('#np-model-sel').value : '';
        payload.speakers = !!($('#np-speakers') && $('#np-speakers').checked);
        payload.speakerCount = parseInt($('#np-spk-count') ? $('#np-spk-count').value : '', 10) || 6;
        // 逐句置信度档位（off/fast/full）：显式发给服务端，存进 project.json 的
        // draft.confidence。这是个**项目级**选择 —— 建稿时定了，重新识别也沿用。
        payload.confidence = ($('#np-confidence') || {}).value || 'full';
        // 「创建后自动处理」：出稿后自动跑 反思纠错 + 全片逐词重校对
        payload.autoPost = !!($('#np-autopost') && $('#np-autopost').checked);
        // 勾了「区分说话人」→ 编辑器的「启用角色标注」帮用户打开(字幕里会带 [SPKn] 标签, 禁着没意义)
        if (payload.speakers) localStorage.setItem('ss-role-annot', '1');
      } else {
        // 区域裁剪后的文本（没勾选时 clipped 为 null，原样提交）
        payload.subtitle = { name: npSub.name, text: clipped ? clipped.text : npSub.text };
        // 把区间记进项目元信息：事后能看出"这份稿子是裁过的"，而不是像丢了内容
        if (region.active) {
          payload.region = {
            start: region.start === null ? 0 : region.start,
            end: Number.isFinite(region.end) ? region.end : null,
          };
        }
        if (clipped) toast(clipped.summary, 6000);
      }
      const r = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const m = await r.json();
      if (!r.ok) { toast(m.error || '创建失败', 4000); return; }
      if (isDraft) {
        location.hash = '#/home';         // 项目立刻进列表，进度在卡片上
        toast('开始识别了，不用等着；进度看项目列表', 5200);
      } else {
        lastSavedText = npSub.text;
        location.hash = '#/project/' + m.id;
        toast('项目已创建，正在后台提取音频与波形…', 4000);
      }
    } catch (e) {
      toast('创建失败: ' + e.message, 3600);
    } finally {
      npSubmitting = false;
      $('#np-open-settings').disabled = false;
      btn.textContent = npMode === 'draft' ? '开始识别' : '创建项目';
      npMaybeEnable();
    }
  });

  /* ─────────── 路由 ─────────── */
  // 项目模式下显示"音频源 + 重新生成音频"两行（设置页签里）; 主界面/无项目模式下隐藏
  function setAudioControlsVisible(on) {
    const r1 = $('#set-audio-mode-row');
    const r2 = $('#set-regen-audio-row');
    if (r1) r1.hidden = !on;
    if (r2) r2.hidden = !on;
  }
  function applyHash() {
    let h = location.hash || '#/home';
    const detailsMatch = /^#\/details\/([A-Za-z0-9_-]{1,64})$/.exec(h);
    if (!location.hash || !['#/home', '#/new', '#/settings', '#/editor'].includes(h) && !h.startsWith('#/project/') && !detailsMatch) {
      h = '#/home';
      history.replaceState(null, '', h);
    }
    $('#app').inert = h === '#/home' || h === '#/new' || h === '#/settings' || !!detailsMatch;
    setPageVisible(elHome, h === '#/home');
    setPageVisible(npView, h === '#/new');
    setPageVisible(stView, h === '#/settings');
    setPageVisible(detailView, !!detailsMatch);
    if (!detailsMatch && previousRoute.startsWith('#/details/')) {
      stopDp(); dpId = ''; detailLoadToken++;
    }
    if (detailsMatch) {
      const id = detailsMatch[1];
      if (previousRoute !== h) {
        detailsOpenedFromApp = !!previousRoute;
        if (previousRoute.startsWith('#/project/') || previousRoute === '#/editor') {
          video.pause();
          if (state.project) saveNow();
        }
        focusPage(detailView);
      }
      if (previousRoute !== h || detailProjectId !== id) loadDetailsPage(id);
    } else if (h.startsWith('#/project/')) {
      const pid = h.slice('#/project/'.length);
      setAudioControlsVisible(true);
      if (!state.project || state.project.id !== pid) openProject(pid);
      else syncAudioModeUI(state.project.meta);
    } else if (h === '#/editor') {
      setAudioControlsVisible(false);
      setPlaybackAudioMode(null, false);
      if (state.project) { saveNow(); detachProject(); }
    } else if (h === '#/home') {
      setAudioControlsVisible(false);
      if (previousRoute !== h) showHome();
      if (previousRoute === '#/new' || previousRoute === '#/settings')
        requestAnimationFrame(() => $('#btn-new-project').focus({ preventScroll: true }));
    } else if (h === '#/new') {
      const fromSettings = previousRoute === '#/settings';
      if (!fromSettings && previousRoute !== '#/new') npReset();
      // 生成设置面板：从设置页回来时强制刷新（模型/接口/Key 刚改过），其余情况走缓存
      genLoad('np', fromSettings).then(() => { if (fromSettings) refreshAsrStatus(); });
      if (previousRoute !== h) focusPage(npView);
    } else if (h === '#/settings') {
      if (previousRoute !== h) {
        settingsVisit++;
        if (previousRoute.startsWith('#/project/') || previousRoute === '#/editor') {
          video.pause();
          if (state.project) saveNow();
        }
        const label = settingsReturnRoute === '#/new' ? '返回新建项目'
          : settingsReturnRoute.startsWith('#/details/') ? '返回详细信息'
          : settingsReturnRoute.startsWith('#/project/') || settingsReturnRoute === '#/editor' ? '返回编辑器' : '返回项目';
        $('#st-close-label').textContent = label;
        $('#st-cancel').textContent = label;
        loadSettings();
        focusPage(stView);
      }
    }
    previousRoute = h;
  }
  window.addEventListener('hashchange', applyHash);
  $('#btn-home').addEventListener('click', () => { location.hash = '#/home'; });

  return {
    applyHash,
    scheduleSave,                                    // main.js 在数据变化后调
    getProject: () => state.project
  };
}
