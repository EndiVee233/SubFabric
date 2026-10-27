/* ═══════════ 项目系统 ═══════════
 * 主界面(项目列表 + 新建) / 打开项目 / 字幕实时自动保存 / 波形与音频的项目内缓存。
 * 存储(服务端 projects/<id>/):
 *   project.json   元数据(名称/视频路径/字幕文件/prepare 状态)
 *   subtitle.ass|srt  字幕权威内容(自动保存写这里)
 *   audio.wav      16kHz 单声道(给后续"重新识别"铺路)
 *   peaks.bin      波形包络(打开时直接读, 不再重新生成)
 * 路由: #/dashboard 主页 · #/home 项目列表 · #/new 新建项目 · #/settings 全局设置
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
// ⚠ 原来这里漏了 import：perfRenderApplied / perfRenderResult 直接调 escapeHtml，
//   而它只从 util.js 导出给 editor.js —— 结果是每次渲染"双引擎/性能测试"结果都抛
//   ReferenceError（被外层 catch 吞掉，界面只显示"读不到设置"）。2026-10-11 由 eslint no-undef 发现。
import { escapeHtml } from './util.js';
import { visibleModels, extraModels, pickVisibleModel, backendOf, BACKEND_LABEL,
  welcomeRecommendations, welcomeRequirements, gpuMemoryText } from './welcome-model.js';

export function initProjects(ctx) {
  const { state, video, timeline, panel, toast, toastAfterCueIntro = toast, routeSub, loadVideoUrl, setPlaybackAudioMode, resumeRerecog, logOp } = ctx;
  const $ = (s) => document.querySelector(s);
  const studioUI = document.body?.classList?.contains('sf-studio') === true;

  let lastSavedText = '';      // 上次保存成功的字幕内容(脏检查用)
  let saveTimer = 0;
  let saving = false;
  let savePromise = null;
  let saveRevision = '', saveSequence = 0, saveConflict = false;
  const saveClient = crypto.randomUUID();
  let pollTimer = 0;
  let nemoPollTimer = 0;       // 盯 NeMo 预检（要导入 PyTorch，30 秒起步）
  let pythonPollTimer = 0;     // 盯 Python 预检（import sherpa/openvino 可能几秒，首帧会先回空）

  const elHome = $('#home-view');
  const dashboardView = $('#dashboard-view');
  const elList = $('#home-list');
  const elEmpty = $('#home-empty');
  const detailView = $('#detail-view');
  const pageTimers = new WeakMap();
  let previousRoute = '';
  let welcomeBlocking = false;      // 欢迎界面打开时拦截路由，App 不可交互
  let welcomeReturnHash = '';       // 从设置手动打开时，保存后回到这里
  let welcomeFirstRun = false;
  let welcomeHardware = null;
  let welcomeBusy = false;
  let settingsReturnRoute = '#/home';
  let settingsVisit = 0;
  let settingsOpenedFromApp = false;
  let newOpenedFromApp = false;
  let detailReturnRoute = '#/home';
  let detailsOpenedFromApp = false;
  let detailLoadToken = 0;

  // 播放进度按项目隔离，保存在浏览器本地；视频文件本身仍由项目元数据管理。
  // 这样关闭编辑器、切换到设置或视频暂时失联时，都不会把进度写进字幕或覆盖用户文件。
  const playbackKey = (id) => `subfabric-playback-v1:${id}`;
  let pendingPlayback = null;
  let lastPlaybackWrite = 0;
  function readPlayback(id) {
    try {
      const n = Number(localStorage.getItem(playbackKey(id)));
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }
  }
  function savePlaybackPosition() {
    const p = state.project;
    const t = Number(video.currentTime);
    if (!p || !Number.isFinite(t) || t < 0) return;
    try { localStorage.setItem(playbackKey(p.id), String(Math.max(0, t))); } catch {}
    lastPlaybackWrite = Date.now();
  }
  function restorePlaybackPosition() {
    const p = state.project, target = pendingPlayback;
    if (!p || !target || target.id !== p.id) return;
    const duration = Number(video.duration);
    const t = Number(target.time);
    if (!(t > 0) || !(duration > 0)) return;
    try { video.currentTime = Math.min(t, Math.max(0, duration - 0.05)); } catch {}
    pendingPlayback = null;
  }
  if (video && typeof video.addEventListener === 'function') {
    video.addEventListener('loadedmetadata', restorePlaybackPosition);
    video.addEventListener('timeupdate', () => {
      // 写入节流到约 1 秒一次，暂停/离开时再立即补写一次。
      if (Date.now() - lastPlaybackWrite >= 900) savePlaybackPosition();
    });
    video.addEventListener('pause', savePlaybackPosition);
  }

  // 离场立即隐藏。旧版保留 200ms 做淡出，但首页/稿件库都是透明浮层，
  // 离场页会在新页背后透出来，形成切换 Tab 的短暂残影；只保留新页的入场动画即可。
  function setPageVisible(page, visible) {
    clearTimeout(pageTimers.get(page));
    page.inert = !visible;
    page.classList.remove('is-leaving');
    page.hidden = !visible;
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
    if (studioUI) replaceRoute(settingsReturnRoute);
    else if (settingsOpenedFromApp) history.back();
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
   * 语音识别模型 / 翻译参数 / 分角色开关都是**全局设置**（asr/settings.json），
   * 点「保存设置」才写回；「自动区分说话人」是项目级参数：新建时选定，详细信息里只读回显。 */
  const GEN_IDS = {
    np: { asr: '#np-model-sel', provider: '#np-set-provider', model: '#np-set-model',
          cast: '#np-set-cast',
          prompt: '#np-set-prompt', castPrompt: '#np-set-castprompt',
          save: '#np-set-save', state: '#np-set-state' },
    dt: { asr: '#dt-model-sel', provider: '#dt-set-provider', model: '#dt-set-model',
          cast: '#dt-set-cast',
          prompt: '#dt-set-prompt', castPrompt: '#dt-set-castprompt',
          save: '#dt-set-save', state: '#dt-set-state' },
  };
  const genEls = (scope) => {
    const src = GEN_IDS[scope] || {}, out = {};
    for (const k of Object.keys(src)) out[k] = $(src[k]);
    return out;
  };
  let genAsr = null, genTr = null, genCast = null;    // 三份缓存，两个面板共用

  /* ── 加速后端（欢迎界面写入）──
   * 服务端 asr/settings.json 的 backends 是准绳；浏览器 localStorage 只负责“是否已看过欢迎页”
   * 与上次勾选。status 里带 backends/hardware，渲染前统一过滤模型。 */
  const WELCOME_KEY = 'sf-welcome-v1';
  function storedWelcome() {
    try {
      const v = JSON.parse(localStorage.getItem(WELCOME_KEY) || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch { return null; }
  }
  function activeBackends(d) {
    if (d && d.backends && typeof d.backends === 'object') return d.backends;
    const s = storedWelcome();
    if (s && s.done) return { cuda: !!s.cuda, vulkan: !!s.vulkan };
    return null;
  }
  function statusContext(d) {
    return { backends: activeBackends(d), hardware: (d && d.hardware) || null };
  }
  /** `/api/asr/status` 首次返回时 hardware 可能还没探测完（服务端先回缓存）；
   *  在筛模型前补一次 `/api/asr/hardware`（有 5 分钟缓存，通常几毫秒），
   *  避免没有 NPU 的机器先闪一下 NPU 模型。 */
  async function ensureHardware(d) {
    if (d && !d.hardware) {
      try {
        const r = await fetch('/api/asr/hardware', { signal: AbortSignal.timeout(15000) });
        if (r.ok) d.hardware = await r.json();
      } catch { /* 探测失败就按未知处理，不阻塞模型列表 */ }
    }
    return d;
  }
  /** 过滤 status.models：隐藏当前勾选/硬件不支持的模型，并把隐藏的默认模型换成可见的。 */
  function filterStatusModels(d) {
    if (!d || !Array.isArray(d.models)) return d;
    const ctx = statusContext(d);
    const all = d.models;
    /* 正常列表严格按勾选：只勾 Vulkan 就只有 Vulkan（NPU 按硬件）。
     * 旧版本下错后端的已下载模型不能丢掉，单独放进 extraModels →「其它模型」。 */
    d.models = visibleModels(all, ctx);
    d.extraModels = extraModels(all, ctx);
    d.selectedModel = pickVisibleModel(all, d.selectedModel, ctx);
    return d;
  }

  function genSetState(scope, text) {
    const el = $(GEN_IDS[scope].state);
    if (el) el.textContent = text;
  }
  /** 「语音识别」下拉：新建页与详情页都是**扁平列表**（Whisper / Qwen / Parakeet 直接可见）。
   *
   *  以前还有一个「识别来源」下拉按引擎过滤模型，于是同一块设置里出现两个都是"选识别模型"
   *  的控件（用户截图反馈「这两个也重复了」），而且详情页的模型不会跟随项目实际使用的模型。
   *  现在只保留模型下拉这一个事实来源：选哪个模型，识别来源就是它的引擎。 */
  function genFillModels(scope, preferred) {
    const e = genEls(scope);
    if (!e.asr) return;
    const pool = ((genAsr && genAsr.models) || []).filter(m => m.ready && m.draftAllowed !== false);
    const keep = e.asr.value;
    e.asr.innerHTML = pool.length
      ? pool.map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('')
      : '<option value="">（没有可用模型，去设置里下载）</option>';
    const want = [preferred, keep, genAsr && genAsr.selectedModel].filter(Boolean);
    const hit = want.find(id => pool.some(m => m.id === id));
    if (hit) e.asr.value = hit;
    if (scope === 'np') npSyncVibeVoice();
  }
  /** 把三份配置铺到某个面板上。preferredModel：详情页用它回显项目当初实际用的模型。 */
  function genRender(scope, preferredModel) {
    const e = genEls(scope);
    if (genAsr) genFillModels(scope, preferredModel);
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
  /** 拉三份配置；有缓存就不重复拉（force=true 时强制刷新）。
   *  preferredModel：详情页传入项目当初实际使用的模型（跟随已选模型，而不是全局默认）。 */
  async function genLoad(scope, force, preferredModel) {
    try {
      if (force || !genAsr) genAsr = filterStatusModels(await ensureHardware(await (await fetch('/api/asr/status')).json()));
      if (force || !genTr) genTr = await (await fetch('/api/translate/config')).json();
      if (force || !genCast) genCast = await (await fetch('/api/cast/config')).json();
    } catch { /* 拉不到就保持旧值，别打断页面 */ }
    genRender(scope, preferredModel);
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
    if (scope === 'np' && e.asr) e.asr.addEventListener('change', () => npSyncVibeVoice());
    if (e.save) e.save.addEventListener('click', () => genSave(scope));
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
    // 详情页的识别模型跟随这个项目**实际用的**模型（draft.modelId），不是全局默认
    genLoad('dt', false, project.draft && project.draft.modelId);
    // 详情页的「翻译方案」与新建页共用缓存；首次进来会一并拉取
    loadNpSchemes().then(renderDtSchemes).catch(() => renderDtSchemes());
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
      const meta = $('#dp-meta');
      if (meta) meta.hidden = true;
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
  /* 待保存的文本快照。为什么要存它：
   *   scheduleSave() 会**无条件**把状态标成「有未保存更改」，而 saveNow() 发现
   *   内容没变时直接 return —— 于是状态永远停在"未保存"。
   *   实测：只要 scheduleSave() 被调用的间隔 < 1200ms（重建条目时会触发），
   *   倒计时被反复重置、saveNow() 一次都不跑，顶栏就**一直**显示「● 有未保存更改」，
   *   而文件其实早就是最新的（哈希比对过，内容没变）。用户就会以为没保存上。
   *   现在：saveNow() 无论保存与否都给状态一个明确结论。 */
  let pendingText = null;
  function scheduleSave() {
    if (!state.project || saveConflict) return;
    pendingText = currentText();
    setSaveState('', '● 有未保存更改');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1200);
  }
  async function saveNow() {
    if (savePromise) return savePromise;
    savePromise = saveOnce();
    try { return await savePromise; } finally { savePromise = null; }
  }
  async function flushSave() {
    const project = state.project;
    clearTimeout(saveTimer);
    if (!project) return;
    if (savePromise) await savePromise;
    if (state.project !== project) return;
    if (currentText() !== lastSavedText) await saveNow();
    clearTimeout(saveTimer);
    if (state.project === project && currentText() !== lastSavedText) throw new Error('旧项目尚未保存成功，请先保留当前稿件');
  }
  async function saveOnce() {
    if (!state.project || saveConflict) return;
    if (saving) { scheduleSave(); return; }       // 上一轮未完成, 稍后再存
    const text = currentText();
    /* 内容与已存盘的一致 → 没什么可存，但**必须把状态改回"已保存"**，
     * 否则 scheduleSave 刚才标的"有未保存更改"会永远留着（这就是那个 bug）。 */
    if (!text || text === lastSavedText) {
      if (text) setSaveState('saved', '已保存 ' + new Date().toTimeString().slice(0, 5));
      return;
    }
    saving = true;
    const project = state.project;
    const revision = saveRevision, sequence = ++saveSequence;
    setSaveState('saving', '保存中…');
    try {
      const r = await fetch(`/api/projects/${project.id}/subtitle?revision=${revision}&client=${saveClient}&seq=${sequence}`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        if (state.project !== project) return;
        lastSavedText = text;
        saveRevision = d.revision;
        if (project.meta) project.meta.modifiedAt = d.savedAt;
        setSaveState('saved', '已保存 ' + new Date().toTimeString().slice(0, 5));
      } else if (state.project === project) {
        saveConflict = r.status === 409 || r.status === 428;
        setSaveState('', saveConflict ? t('⚠ 稿件已在其他窗口更新；请备份当前内容并重新打开项目') : '⚠ 保存失败(稍后自动重试)');
      }
    } catch {
      if (state.project === project) setSaveState('', '⚠ 保存失败(稍后自动重试)');
    } finally { saving = false; }
    /* 保存期间又改了（pendingText 与刚存的不一致）→ 立刻再存一轮，别等下一次触发 */
    if (state.project === project && pendingText && pendingText !== lastSavedText) scheduleSave();
  }
  // 页面关闭/刷新兜底: 未保存的改动用 sendBeacon 补一刀(服务端 PUT/POST 都收)
  window.addEventListener('beforeunload', () => {
    savePlaybackPosition();
    if (!state.project || saveConflict) return;
    clearTimeout(saveTimer);
    const text = currentText();
    if (text && text !== lastSavedText) {
      navigator.sendBeacon(`/api/projects/${state.project.id}/subtitle?revision=${saveRevision}&client=${saveClient}&seq=${++saveSequence}`, new Blob([text], { type: 'text/plain' }));
    }
  });

  /* ─────────── 波形(项目缓存) ─────────── */
  let peaksInFlight = null, peaksTarget = null;
  async function loadPeaks() {
    const project = state.project;
    const gen = _openGen;
    if (!project) return false;
    /* 打开项目时 video 与 prepare 两条路径都会要 peaks；合并同一次请求，
     * 免得同一个 500KB+ 的 peaks.bin 并发下载两遍（旧实现确实会下两次）。 */
    if (peaksInFlight && peaksTarget === project) return peaksInFlight;
    peaksTarget = project;
    const p = (async () => {
      try {
        const r = await fetch(`/api/projects/${project.id}/peaks`);
        if (!r.ok) return false;                     // 未就绪: prepare 轮询完成后会再调
        const data = new Uint8Array(await r.arrayBuffer());
        if (state.project !== project || gen !== _openGen) return false;
        timeline.setPeaks({ data, rate: parseFloat(r.headers.get('X-Peak-Rate') || '100'), ch: +(r.headers.get('X-Peak-Ch') || 2) });
        toastAfterCueIntro('波形已就绪(来自项目缓存)', 2000);
        return true;
      } catch { return false; }
    })();
    peaksInFlight = p;
    try { return await p; }
    finally {
      if (peaksInFlight === p) { peaksInFlight = null; peaksTarget = null; }
    }
  }

  /** prepare 状态处理: running→轮询 / done→直接读 / 缺失→自动补跑一次(无音轨的不重试) */
  function handlePrepare(m) {
    clearInterval(pollTimer); pollTimer = 0;
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
    const project = state.project;
    if (!project) return;
    try {
      const r = await fetch(`/api/projects/${project.id}/prepare`, { method: 'POST' });
      const m2 = await r.json();
      if (state.project !== project) return;
      if (r.ok) { state.project.meta = m2; pollPrepare(); }
      else toast(m2.error || '波形提取启动失败', 3600);
    } catch { toast('波形提取启动失败', 3600); }
  }
  function pollPrepare(onDone) {
    if (pollTimer) return;
    const project = state.project;
    if (!project) return;
    toast('正在提取音频与波形…(完成后自动显示)', 4200);
    pollTimer = setInterval(async () => {
      let m;
      try { m = await (await fetch(`/api/projects/${project.id}`)).json(); } catch { return; }
      if (state.project !== project) return;
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
    const project = state.project;
    const btn = $('#btn-regen-audio');
    const mode = ($('#audio-mode') && $('#audio-mode').value) || 'raw';
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '提取中…';
    try {
      const r = await fetch(`/api/projects/${project.id}/prepare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, force: true })
      });
      const m2 = await r.json();
      if (state.project !== project) return;
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
  // openProject 竞态守卫代次: applyHash 快速切换项目(A→B)会并发进入, 每次进入自增;
  // 旧的响应晚回来时代次不符 → 直接丢弃, 避免旧数据覆盖新项目状态。
  let _openGen = 0;
  async function openProject(pid) {
    const gen = ++_openGen;
    clearInterval(pollTimer); pollTimer = 0;
    let m, rSub;
    try {
      await flushSave();
      if (gen !== _openGen) return;
      /* 项目元信息与字幕并行取：两者互不依赖，少一次来回等待。 */
      const [r, rs] = await Promise.all([
        fetch('/api/projects/' + pid),
        fetch(`/api/projects/${pid}/subtitle`),
      ]);
      m = await r.json();
      rSub = rs;
      if (gen !== _openGen) return;
      if (!r.ok || m.error) throw new Error(m.error || 'HTTP ' + r.status);
    } catch (e) {
      if (gen !== _openGen) return;
      toast('项目加载失败: ' + e.message, 3600);
      location.hash = '#/home';
      return;
    }
    // 1) 字幕: 读项目内权威内容, 走与"打开字幕文件"完全相同的解析入口
    try {
      // ⚠ 必须检查 ok: 服务端 500/404 时响应体是错误页, 不挡的话会被当字幕解析成空/坏文档,
      // 且 lastSavedText 被污染 —— 用户随后任何一次编辑触发 saveNow() 都会把坏内容写回。
      if (!rSub.ok) throw new Error(`HTTP ${rSub.status}`);
      const text = await rSub.text();
      if (gen !== _openGen) return;
      const name = (m.subtitle && (m.subtitle.name || m.subtitle.file)) || 'subtitle.ass';
      /* 只做**轻量**校验，不再为"有没有事件"把整份 ASS 解析一遍 ——
       * 后面 routeSub→setAss 本来就要构造 AssDoc；旧实现 `new AssDoc(text).events`
       * 让 3~4MB 的稿件在打开时白解析两遍（主要启动开销之一）。 */
      const isAss = /\.(ass|ssa)$/i.test(name);
      const hasEvents = isAss
        ? /(^|\n)\s*Dialogue\s*:/i.test(text)
        : parseSRT(text).length > 0;
      if (!hasEvents) throw new Error('字幕没有有效事件');
      /* 旧稿件的后台长任务先收掉，再换项目身份；之后 setAss 用到的
       * realignSkip / meta 已经是新项目，因此不再需要"先建一遍再重建一遍"。 */
      if (typeof window.__realignReset === 'function') window.__realignReset();
      /* 先把项目身份、保存基线和视频/波形请求装上，再跑同步的字幕解析：
       *  · 解析/自愈通常占打开耗时的大头，视频与 peaks 的网络请求可以同时开始；
       *  · 第一次 rebuildItemsAndLanes 就能读到新项目的 realignSkip（旧实现要重建两次）。
       * 中间没有 await / 用户事件，stale 文档不会有机会写进新项目。 */
      state.project = { id: pid, meta: m, loadPeaks };
      window.__sfCurrentProjectId = () => pid;
      lastSavedText = text;
      saveRevision = (rSub.headers.get('ETag') || '').replace(/^"|"$/g, '');
      saveConflict = false;
      pendingText = null;
      // 2) 视频: 按保存的路径经服务端 Range 流式播放; 失效则要求重选
      pendingPlayback = { id: pid, time: readPlayback(pid) };
      if (m.videoExists && m.video && m.video.path) {
        loadVideoUrl('/api/media?path=' + encodeURIComponent(m.video.path), m.video.name);
      } else {
        promptRelink(m);
      }
      // 3) 波形/音频: 就绪直接读, 没就绪轮询
      handlePrepare(m);
      /* 时间轴的逐块浮现要等波形画上去再开始；这里告诉它"这个稿件有没有波形可等"，
       * 无音轨/无视频的项目就不白等 2.5 秒（见 Timeline._armBlockEntrance）。 */
      const noAudio = /没有音轨/.test(String((m.prepare && m.prepare.error) || ''));
      timeline.setBlockEntranceWaveExpected?.(!noAudio && (!!m.hasPeaks || !!m.videoExists));
      syncAudioModeUI(m);          // 音频源下拉回显 + 播放音轨(降噪后→audio.wav 接管发声)
      // 4) 同步解析 + 首次构建（只此一次）
      routeSub(text, name);
      setSaveState('', '自动保存已开启');
    } catch (e) {
      if (gen !== _openGen) return;
      if (state.project && state.project.id === pid) {
        state.project = null;    // 解析失败：不要留下指向新项目却没有完整文档的半状态
        location.hash = '#/home';
      }
      toast('项目字幕读取失败: ' + e.message, 3600);
      return;
    }
    if (typeof window.__notesReload === 'function') window.__notesReload();
    if (resumeRerecog) resumeRerecog(pid);   // 接回后台还在跑的「选区重新识别」任务(刷新后也能看到进度/拿到结果)
  }

  function promptRelink(m) {
    panel.showConfirm('找不到视频文件',
      `项目「${m.name}」的视频不在原来的位置了：\n${(m.video && m.video.path) || ''}\n\n重新选一次视频就能继续，字幕和波形不受影响。`,
      '重新选择视频', '暂不', () => pickVideoForProject());
  }
  async function pickVideoForProject() {
    const project = state.project;
    if (!project) return;
    /* 视频统一走**浏览器自己的文件选择框**（与选择字幕/导入项目包同一个窗口）：
       系统原生 PowerShell 对话框是另一个进程的窗口，只压在本应用之上/抢前台都做不稳，
       层级也不属于浏览器。代价是视频要复制一份进程序目录（下面的 upload-video）。 */
    const f = await browserPickVideo();
    if (!f) return;
    toast('正在上传视频…', 6000);
    const up = await fetch('/api/upload-video?name=' + encodeURIComponent(f.name), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f
    });
    const um = await up.json().catch(() => ({}));
    if (!up.ok || !um.path) { toast('视频上传失败: ' + (um.error || up.status), 5000); return; }
    const pick = { path: um.path, name: um.name };
    if (state.project !== project) return;
    const r = await fetch(`/api/projects/${project.id}/relink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: pick.path })
    });
    const m2 = await r.json();
    if (state.project !== project) return;
    if (!r.ok) { toast(m2.error || '重新关联失败', 3600); return; }
    state.project.meta = m2;
    loadVideoUrl('/api/media?path=' + encodeURIComponent(pick.path), pick.name || 'video');
    handlePrepare(m2);
    toast('视频已重新关联: ' + (pick.name || ''), 3000);
  }

  /* ─────────── 主界面(项目列表) ─────────── */
  async function showHome() {
    const gen = ++_openGen;
    clearInterval(pollTimer); pollTimer = 0;
    if (typeof window.__projectAsyncReset === 'function') window.__projectAsyncReset();
    video.pause();
    if (state.project) {
      try { await flushSave(); } catch (e) { toast(e.message, 5000); }
      if (gen !== _openGen) return;
      detachProject();
    }
    listAnim = true;                                // 只在"进入首页"这一帧播放卡片入场动画
    renderList();
  }
  let listPoll = 0;
  let listAnim = false;                             // 入场动画开关(轮询刷新时不重播, 否则每 1.5s 抖一次)
  const lastSig = new Map();                        // 项目 id → 上次渲染内容的签名(定点更新用)
  const pctAnimations = new WeakMap();              // 新进度使旧动画失效，避免快速轮询时两个动画互相写数字
  /** 结构字段变化才重建卡片；进度、消息与修改时间就地更新，避免每次 touchMeta 重建动画。 */
  function cardSig(p) {
    const dr = p.draft || null;
    return [p.name, p.format, p.videoExists ? 1 : 0, p.fetching ? 1 : 0,
      (p.prepare && p.prepare.status) || '', p.video && p.video.name, p.subName || '',
      dr ? [dr.status, dr.stage, dr.pendingTranslate, dr.lines,
        dr.translated ? 1 : 0, dr.skippedTranslate ? 1 : 0].join('|') : '',
    ].join('\u0001');
  }
  function cardMeta(p) {
    return `${p.fetching ? '正在下载…' : (p.video && p.video.name || '无视频')} · ${p.subName || (p.draft ? '初稿处理中…' : '还没字幕')} · 修改于 ${fmtDate(p.modifiedAt)}`;
  }
  /** 下载、提取、识别等真实活动置顶；失败/暂停的无字幕稿件不能一直占据活动区。 */
  function isCreating(p) {
    const dr = p.draft || null;
    if (p.fetching || (p.prepare && p.prepare.status === 'running') || (dr && dr.status === 'running')) return true;
    // 新建项目在 prepare / draft 建立前的短暂空窗期仍视为活动。
    return !p.format && !(dr && dr.status)
      && (!p.prepare || !p.prepare.status || p.prepare.status === 'none');
  }
  /** 进度、消息与显示时间就地更新；任务进度会 touchMeta，时间不属于卡片结构签名。 */
  function syncCardProgress(card, p) {
    const metaEl = card.querySelector('.pc-meta');
    const meta = cardMeta(p);
    if (metaEl && metaEl.textContent !== meta) metaEl.textContent = meta;
    const dr = (p && p.draft) || null;
    const bar = card.querySelector('.pc-draft-bar-in');
    const pctEl = card.querySelector('.pc-draft-txt .pct');
    const msgEl = card.querySelector('.pc-draft-txt span');
    if (!dr || !bar || !pctEl) return;
    const pct = Math.max(0, Math.min(100, dr.progress || 0));
    // 目标值没变时只核对消息，不改进度 DOM，也不重启仍在进行的数字动画。
    const shown = Number(pctEl.dataset.pct);
    if (Number.isFinite(shown) && shown === pct) {
      if (msgEl) {
        const txt = String(dr.message || '');
        if (msgEl.textContent !== txt) msgEl.textContent = txt;
      }
      return;
    }
    const displayed = Number.parseFloat(pctEl.textContent);
    const from = Number.isFinite(displayed) ? displayed : pct;
    bar.style.width = pct + '%';
    pctEl.dataset.pct = String(pct);
    // 只在活动稿件的目标值改变时启动动画；已完成/暂停/失败的百分比直接显示最终值。
    countTo(pctEl, dr.status === 'running' ? from : pct, pct, 420);
    if (msgEl) {
      const txt = String(dr.message || '');
      if (msgEl.textContent !== txt) msgEl.textContent = txt;
    }
    const cls = dr.status === 'done' ? 'done'
      : dr.status === 'error' ? 'error' : dr.status === 'paused' ? 'paused' : 'running';
    if (card.querySelector('.pc-draft') && !card.querySelector('.pc-draft').classList.contains(cls)) {
      card.querySelector('.pc-draft').className = 'pc-draft ' + cls;
    }
  }
  async function renderList() {
    // 骨架屏（只在**首绘**时铺）：形状和真实卡片一致, 比"读取中…"那行字少一次布局跳动
    const firstPaint = !elList.querySelector('.proj-card');
    if (firstPaint) {
      elList.innerHTML = Array.from({ length: 3 }, () =>
        '<div class="skel-row"><div class="skel-b b1"></div><div class="skel-b b2"></div><div class="skel-b b3"></div><div class="skel-b b4"></div></div>').join('');
    }
    elEmpty.hidden = true;
    elList.classList.toggle('anim-in', listAnim);      // 只有"进入首页"那一帧播放入场动画
    listAnim = false;
    let data;
    try { data = await (await fetch('/api/projects')).json(); }
    catch { elList.innerHTML = '<div class="home-loading">读取失败，本地服务可能没启动</div>'; return; }
    const ps = data.projects || [];
    if (firstPaint) { elList.innerHTML = ''; lastSig.clear(); }
    elEmpty.hidden = ps.length > 0;
    // 稳定排序保留服务端的组内顺序，不在响应对象上写临时索引。
    ps.sort((a, b) => Number(isCreating(b)) - Number(isCreating(a)));
    const seenIds = new Set();
    const cards = [];
    const ST = { running: '提取中', none: '待提取', error: '提取失败' };
    let cardIdx = 0;
    for (const p of ps) {
      seenIds.add(p.id);
      /* 定点更新：签名没变 → 连 innerHTML 都不碰（这是"不闪"的关键） */
      const sig = cardSig(p);
      /* 找已有卡片**用遍历而不是选择器**：项目 id 里可能有需要转义的字符，
       * 而 CSS.escape 在 lint 里是未声明的全局（本项目跑 ESLint 的 no-undef）。
       * 卡片数量是"几十"量级，遍历比拼选择器更稳也更省心。 */
      let card = null;
      for (const el of elList.querySelectorAll('.proj-card')) {
        if (el.dataset.id === p.id) { card = el; break; }
      }
      // 内容复用与顺序同步分开：未重建的卡片同样必须参加最后的排序。
      if (card && lastSig.get(p.id) === sig) {
        cards.push(card);
        syncCardProgress(card, p);
        continue;
      }
      if (!card) { card = document.createElement('div'); card.dataset.id = p.id; }
      cards.push(card);
      card.className = 'proj-card' + (p.videoExists || p.fetching ? '' : ' proj-missing');
      card.tabIndex = 0; card.setAttribute('role', 'link'); card.setAttribute('aria-label', p.name);
      // 入场错峰: CSS 用 --i 算 animation-delay（上限 12 档, 项目多了也不会等太久）
      card.style.setProperty('--i', String(Math.min(cardIdx++, 12)));
      /* 事件绑定：重建过的卡片要重新绑（innerHTML 换代会把监听一起清掉）。
       * ⚠ 不能只绑一次就依赖复用 —— 内容变化的卡片是**真的重建**的。 */
      card.replaceChildren();
      const st = p.prepare && ST[p.prepare.status];
      const dr = p.draft || null;
      const hasSub = !!p.format;

      // 有初稿任务时以初稿进度为准(它是 prepare 之后的后半段)
      let stChip = '', draftBar = '', progBtn = '<button type="button" class="btn pc-details">更多</button>';
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
        // 首次显示或结构变更直接展示当前值；只有活动稿件后续进度变化才平滑过渡。
        draftBar = `
          <div class="pc-draft ${esc(dr.status)}">
            <div class="pc-draft-bar"><div class="pc-draft-bar-in" style="width:${pct}%"></div></div>
            <div class="pc-draft-txt"><span>${esc(dr.message || label)}</span><span class="pct" data-pct="${pct}">${pct}%</span></div>
          </div>`;
        // 可重试/可开始翻译：彻底失败、等待翻译、或翻译只完成了一部分（已跳过的不算）
        const canRetry = (failed || paused
          || (dr.status === 'done' && !dr.translated && !!dr.needTranslate)) && !dr.skippedTranslate;
        const retryLabel = paused ? (dr.pendingTranslate ? '重试' : '开始翻译') : '重试';
        progBtn = '<button type="button" class="btn pc-details">更多</button>';
        if (canRetry) progBtn += `<button type="button" class="btn btn-accent pc-retry">${esc(retryLabel)}</button>`;
        else if (dr.skippedTranslate) progBtn += '<button type="button" class="btn pc-trans">翻译</button>';
      } else if (st) {
        stChip = ` <span class="pc-st st-${p.prepare.status}">${st}</span>`;
      }

      const fmt = p.format;
      const badge = fmt === 'srt' ? 'SRT' : (fmt === 'ass' ? 'ASS' : (dr ? '初稿' : 'ASS'));
      const locked = !!dr && !hasSub;           // 还没有字幕文件时进去也没内容可读（失败在识别阶段就是这种）
      const missingTag = (p.videoExists || p.fetching) ? '' : ` <span class="pc-missing">${ico('alert')}找不到这个视频</span>`;
      /* UWP 设计稿的 cover/body/badges/actions：状态与“可编辑”放在独立 badges 行，
         标题只保留项目名，避免徽标挤进标题造成换行。 */
      const badges = `${stChip}${hasSub && !locked ? `<span class="pc-st st-done">${t('可编辑')}</span>` : ''}`;
      card.innerHTML = `
        <span class="pc-badge ${fmt === 'srt' ? 'srt' : ''}">${badge}</span>
        <div class="pc-main">
          <div class="pc-name">${esc(p.name)}${missingTag}</div>
          <div class="pc-meta">${esc(cardMeta(p))}</div>
          <div class="pc-badges">${badges}</div>
          ${draftBar}
        </div>
        <div class="pc-actions">
          ${progBtn}
          <button type="button" class="btn btn-accent pc-open" ${locked ? 'disabled' : ''}>打开</button>
          <button type="button" class="btn pc-del ico-only" title="删除项目（音频、波形、字幕副本一起删）" aria-label="删除项目">${ico('trash')}</button>
        </div>`;
      /* 处理中（提取/识别/翻译还没跑完）点卡片进**详情页**看进度；完成后再进编辑器。
       * 以前只有"还没字幕"时才拦，识别中已有部分字幕的卡片会直接跳编辑器，
       * 用户看不到进度、也容易在写入过程中编辑。 */
      const processing = isCreating(p);
      const openCard = () => {
        if (processing) { openProjectDetails(p); return; }
        if (locked) return;
        location.hash = '#/project/' + p.id;
      };
      card.querySelector('.pc-details').addEventListener('click', (e) => {
        e.stopPropagation();
        openProjectDetails(p);
      });
      card.querySelector('.pc-open').addEventListener('click', (e) => {
        e.stopPropagation();
        openCard();
      });
      card.addEventListener('click', openCard);
      card.onkeydown = (e) => {
        if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        openCard();
      };
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
      lastSig.set(p.id, sig);
    }
    /* 列表里已经不存在（被删掉）的卡片：连签名记录一起清掉 ——
     * 不清的话，同名 id 复用时会被误判成"内容没变"，卡片就再也不更新了。 */
    for (const el of [...elList.querySelectorAll('.proj-card')]) {
      if (!seenIds.has(el.dataset.id)) { el.remove(); lastSig.delete(el.dataset.id); }
    }
    // 仅移动位置不对的节点；顺序不变时不产生插入/移除操作，也不会重播旧卡片动画。
    for (let i = 0; i < cards.length; i++) {
      if (elList.children[i] !== cards[i]) elList.insertBefore(cards[i], elList.children[i] || null);
    }
    // 新界面只消费服务端快照和现有卡片，不接管项目状态、按钮和保存协议。
    if (studioUI) window.__sfStudio?.projects(ps);

    // 有任务在跑就自动刷新, 让列表上的进度自己往前走
    /* ⚠ 只在**主页真的可见**时轮询。
     * 原来无条件 setTimeout 下去：用户离开主页（去详情/编辑器）后仍在后台每 1.5 秒
     * 重渲染一遍列表 —— 白烧 CPU，而且只要那页还挂在那儿，任何列表刷新都可能在屏幕上
     * 表现为"卡片在动"。回到主页时 applyHash() 会重新 renderList()，不会漏更新。 */
    clearTimeout(listPoll);
    const active = ps.some(isCreating);
    if (active && elHome && !elHome.hidden) {
      listPoll = setTimeout(() => renderList(), 1500);
    }
  }

  /** 数字滚动：把 el 的文本从 a 数到 b（含 % 后缀），rAF 驱动, 只用于很短的过渡 */
  function countTo(el, a, b, ms) {
    if (!el) return;
    const animation = {};
    pctAnimations.set(el, animation);
    if (a === b || Math.abs(b - a) < 1) { el.textContent = b + '%'; return; }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = b + '%'; return; }
    const t0 = performance.now();
    const step = (now) => {
      if (!el.isConnected || pctAnimations.get(el) !== animation) return;
      const k = Math.min(1, (now - t0) / ms);
      // 必须与 Studio CSS 的 width transition 同时长(420ms)、同缓动(线性): 两边不一致时,
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
   *  新建项目页传 '#np-steps' 画一条全灰的静态预览（curIdx = -1）。
   *  opts.sub：当前步骤的小字（下载 4% / 第 3/10 片），opts.err：当前步失败标红。 */
  function renderDpSteps(curIdx, target, opts) {
    const box = $(target || '#dp-steps');
    if (!box) return;
    const o = opts || {};
    box.innerHTML = DP_STEPS.map((s, i) => {
      let cls = !s.enabled ? 'off' : (i < curIdx ? 'done' : (i === curIdx ? 'current' : ''));
      if (i === curIdx && o.err) cls += ' is-err';
      const tip = s.enabled ? s.name : (s.name + '（尚未实现）');
      const sub = (i === curIdx && o.sub) ? `<span class="dp-step-sub">${esc(o.sub)}</span>` : '';
      return `<span class="dp-step ${cls}" title="${esc(tip)}"><span class="n">${i + 1}</span>${esc(s.name)}${sub}</span>`;
    }).join('');
  }
  /** 当前步骤的一句话细进度：从服务端 message 里取「下载 4% / 第 3/10 片 / 72%」这类片段。 */
  function dpStepSub(d) {
    const msg = String((d && d.message) || '');
    const m = /(下载中?\s*\d+%|第\s*\d+\s*\/\s*\d+\s*[片段]|\d+%)/.exec(msg);
    return m ? m[1].replace(/\s+/g, ' ') : '';
  }
  /** 秒 → 1:23 / 1:02:03 */
  function dpClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }
  /** 从「下载中 4% 19.6/480.5 MB 0.4 MB/s 剩 1211s」里拆出大小/速度/预计。 */
  function dpParseTransfer(msg) {
    const text = String(msg || '');
    const size = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*MB/i.exec(text);
    const speed = /(\d+(?:\.\d+)?)\s*MB\/s/i.exec(text);
    const eta = /剩\s*(\d+)\s*s/i.exec(text);
    return {
      got: size ? Number(size[1]) : null,
      total: size ? Number(size[2]) : null,
      speed: speed ? Number(speed[1]) : null,
      eta: eta ? Number(eta[1]) : null,
    };
  }
  /** 进度详情行 + 已用/预计：详情页与新建页共用。
   *  预计优先用服务端消息里的「剩 Ns」，没有就按已用时间与百分比估算。 */
  function dpRenderDetail(prefix, d) {
    const map = {
      pct: $('#' + prefix + '-pct'),
      msg: $('#' + prefix + '-msg'),
      meta: $('#' + prefix + '-meta'),
      stage: $('#' + prefix + '-stage'),
      elapsed: $('#' + prefix + '-elapsed'),
      eta: $('#' + prefix + '-eta'),
      transfer: $('#' + prefix + '-transfer'),
    };
    const t = dpParseTransfer(d.message || '');
    const t0 = Date.parse(d.startedAt || '');
    const t1 = d.status === 'running' ? Date.now() : (Date.parse(d.updatedAt || d.finishedAt || '') || Date.now());
    const elapsed = (Number.isFinite(t0) && t0 > 0) ? Math.max(0, (t1 - t0) / 1000) : 0;
    let eta = t.eta;
    if (eta == null && d.status === 'running' && d.progress >= 3 && elapsed > 3) {
      eta = elapsed * (100 - d.progress) / d.progress;
    }
    const running = d.status === 'running';
    if (map.stage) map.stage.textContent = d.status === 'done' ? '阶段：完成'
      : `阶段：${dpStepName(d.failedStage || d.stage)}${d.status === 'error' ? '（失败）' : ''}`;
    if (map.elapsed) map.elapsed.textContent = elapsed > 0 ? `已用 ${dpClock(elapsed)}` : '';
    if (map.eta) map.eta.textContent = running && eta != null && eta > 0 ? `剩余约 ${dpClock(eta)}` : '';
    if (map.transfer) {
      const parts = [];
      if (t.got != null && t.total) parts.push(`下载 ${t.got.toFixed(1)}/${t.total.toFixed(1)} MB`);
      if (t.speed) parts.push(`${t.speed.toFixed(1)} MB/s`);
      map.transfer.textContent = parts.join(' · ');
    }
    if (map.meta) {
      const has = !!(map.stage && map.stage.textContent) || !!(map.elapsed && map.elapsed.textContent)
        || !!(map.eta && map.eta.textContent) || !!(map.transfer && map.transfer.textContent);
      map.meta.hidden = !has;
    }
    if (map.pct) map.pct.textContent = Math.max(0, Math.min(100, Number(d.progress) || 0)) + '%';
    if (map.msg) {
      map.msg.textContent = d.error ? ('✗ ' + d.error) : (d.message || '');
      map.msg.classList.toggle('dp-err', !!d.error);
    }
  }
  function dpStepName(stage) {
    const i = DP_STEPS.findIndex(s => s.stages.indexOf(stage) >= 0);
    if (i >= 0) return DP_STEPS[i].name;
    return String(stage || '').replace(/[中…]+$/, '') || '准备中';
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
    const meta = $('#dp-meta');
    if (meta) meta.hidden = true;
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
    renderDpSteps(curIdx, null, { sub: dpStepSub(d), err: d.status === 'error' });
    applyDpButtons(curIdx, d.retries || 0);

    const pct = Math.max(0, Math.min(100, d.progress || 0));
    $('#dp-bar-in').style.width = pct + '%';
    $('#dp-bar-in').classList.toggle('err', d.status === 'error');
    $('#dp-bar-in').classList.toggle('ok', d.status === 'done' && !!d.translated);
    dpRenderDetail('dp', d);
    // 还一行都没翻 → 「开始翻译」；翻了一部分或失败 → 「重试」
    $('#dp-retry').textContent = (d.status === 'paused' && !d.pendingTranslate) ? '开始翻译' : '重试';

    const logEl = $('#dp-log');
    if (typeof m.log === 'string' && logEl.textContent !== m.log) {
      // 日志是多行文本：逐行剥掉时间戳前缀后过词典（服务端文案也能改）
      logEl.textContent = m.log.split('\n').map(l =>
        l.replace(/^(\[\d{2}:\d{2}:\d{2}\]\s*)([\s\S]*)$/, (all, pre, rest) => pre + t(rest))).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
    /* 任务结束收尾时才刷新主页列表 —— 而且**只在主页真的可见时**刷。
     * 这个 tick 每 1.2 秒跑一次（详情页/进度浮层在用），原来无条件调 renderList()：
     * 用户在详情页盯着进度时，下面的主页列表被反复重渲染（配合 countTo 的数字动画，
     * 观感就是"所有稿件的进度条都在动"）。列表数据本来就由它自己的轮询管。 */
    if (!dpRunning) {
      stopDp();
      if (elHome && !elHome.hidden) renderList();
    }
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
    /* selectSetting('llm') 会先点 translate 再点 LLM 入口，已激活时直接跳过，
       避免同一面板重复 dispatch 重启动画。 */
    if (tab.classList.contains('active')) return;
    document.querySelectorAll('.st-tab').forEach(t => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.st-panel').forEach(p => {
      const active = p.dataset.stp === tab.dataset.stp;
      p.classList.toggle('active', active);
      p.hidden = !active;
      if (active) window.dispatchEvent(new CustomEvent('sf-settings-panel-shown', { detail: { panel: p } }));
    });
    /* 长面板滚到底再切短面板会停在空白处，看起来像没切换；统一回到顶部。 */
    stView.scrollTop = 0;
    const stBody = $('#st-body');
    if (stBody) stBody.scrollTop = 0;
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
    /* ⚠ initPerfPanel / initDualRatio 必须**无条件**调用。
     *   2026-10-11 无头浏览器实测发现：这两个以前只写在下面 catch 分支里
     *   （翻译配置读失败时才跑），于是**正常启动时从不执行** ——
     *   「性能测试」面板的按钮全没接线（点了没反应）、#perf-applied 永远停在"读取中…"、
     *   双引擎分工下拉 change 也不发请求。
     *   它们只依赖 DOM id（且各自有 dataset.bound 幂等保护），
     *   与下面那次 /api/translate/config 无关，所以提到 try 之前无条件跑。 */
    initPerfPanel();        // 性能测试页（独立于模型列表，自己管自己的状态）
    // 停用：双引擎分工下拉
    // initDualRatio();
    initAsrParams();        // 模型参数面板（事件委托，下载轮询重渲染不失效）
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
      return;                 // initPerfPanel / initDualRatio 已在上面无条件调用过
    }
    stPresets = data.presets || [];
    if (studioUI) { acceptSchemes(data); defaultSchemePrompt = data.defaultPrompt || ''; }
    $('#st-provider').innerHTML = (studioUI ? '<option value="">选择服务商</option>' : '') + stPresets
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
    if ($('#st-temp')) $('#st-temp').value = (c.temperature == null ? 0.3 : c.temperature);   // 采样温度
    if ($('#st-ctx')) $('#st-ctx').value = c.contextRows || 0;                                 // 上下文行数
    $('#st-prompt').value = c.prompt || data.defaultPrompt || '';
    // 方案列表/胶囊用的是刚拿到的 stPresets 与当前 provider，必须在这之后画
    if (typeof renderSchemes === 'function') renderSchemes();
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
let perfPollFails = 0;

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
  try {
    s = await (await fetch('/api/asr/perf/state')).json();
    perfPollFails = 0;
  } catch {
    /* 服务重启/断网时不能永久停在“测试中…”：连续 3 次失败就收掉轮询和按钮。 */
    if (++perfPollFails >= 3) {
      clearInterval(perfTimer); perfTimer = null;
      perfSetBusy(false, '无法读取测试状态，请重试');
    }
    return;
  }
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
  perfPollFails = 0;
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
    /* 选到音频后清掉上一次“先选一份测试音频”的残留提示。 */
    if (audioPath) { const note = $('#perf-note'); if (note) note.textContent = ''; }
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
    if (!audioPath) {
      if (note) note.textContent = '先选一份测试音频';
      if (typeof toast === 'function') toast('先选择测试音频，或点「自动找一份」', 3200);
      return;
    }
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
  initBenchPanel();
}

/* ── 全模型速度测试 ───────────────────────────────────────────────
 * 性能页的第二个页签：勾选已安装模型 → 同一段音频逐个跑 → 按倍率排序。
 * 与双引擎测试完全独立（状态、轮询、结果），互不覆盖。 */
let benchModelsLoaded = false;
let benchLoading = false;
let benchTimer = null;
let benchStateLoaded = false;
let benchAudio = '';

function benchSetBusy(on, msg) {
  const start = $('#bench-start');
  const cancel = $('#bench-cancel');
  if (start) { start.disabled = !!on; start.textContent = on ? '测试中…' : '开始测试'; }
  if (cancel) cancel.hidden = !on;
  document.querySelectorAll('#bench-conditions input, #bench-conditions select').forEach(el => {
    el.disabled = !!on;
  });
  const note = $('#bench-note');
  if (note && msg !== undefined) note.textContent = msg || '';
}

function selectPerfTab(name) {
  const dual = $('#perf-dual-view'), models = $('#perf-models-view');
  if (!dual || !models) return;
  const isModels = name === 'models';
  dual.hidden = isModels;
  models.hidden = !isModels;
  document.querySelectorAll('[data-perf-tab]').forEach((b) => {
    const active = b.dataset.perfTab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  if (isModels) {
    if (!benchModelsLoaded) benchLoadModels();
    benchRestoreState();
  }
}

function benchApplyConditions(c) {
  if (!c) return;
  const set = (id, prop, value) => { const el = $(id); if (el) el[prop] = value; };
  set('#bench-word', 'checked', c.word !== false);
  set('#bench-confidence', 'value', c.confidence || 'full');
  set('#bench-cast', 'checked', c.cast === true);
  set('#bench-speakers', 'checked', c.speakers === true || c.cast === true);
  set('#bench-speaker-count', 'value', c.speakerCount ? String(c.speakerCount) : '');
  const conf = $('#bench-confidence');
  if (conf) conf.dataset.init = '1';
}

function benchRestoreState() {
  if (benchStateLoaded) return;
  benchStateLoaded = true;
  fetch('/api/asr/bench/state').then(r => r.json()).then((s) => {
    if (s && s.conditions) benchApplyConditions(s.conditions);
    if (s && s.running) {
      selectPerfTab('models');
      const progress = $('#bench-progress');
      if (progress) progress.hidden = false;
      benchStartPolling();
    } else if (s && s.results?.length) benchRenderResult(s);
  }).catch(() => {});
}

function benchSetAudio(p) {
  benchAudio = p || '';
  const el = $('#bench-audio-path');
  if (el) el.textContent = benchAudio || '（未选择）';
}

async function benchLoadModels(force) {
  const box = $('#bench-models');
  if (!box) return;
  if (benchLoading && !force) return;
  benchLoading = true;
  const previous = new Set([...box.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value));
  const firstLoad = !benchModelsLoaded;
  if (firstLoad) box.innerHTML = '<span class="spin"></span>读取模型…';
  try {
    const d = await (await fetch('/api/asr/status')).json();
    // 置信度默认跟随全局设置（与创建稿件页一致），只在首次加载时写一次，别覆盖用户选择。
    const confEl = $('#bench-confidence');
    if (confEl && !confEl.dataset.init) {
      confEl.value = (d.confidence && d.confidence.mode) || 'full';
      confEl.dataset.init = '1';
    }
    const models = (d.models || []).filter(m => m && m.ready && !m.cloud
      && m.engine !== 'dual' && ['openvino', 'faster-whisper', 'crispasr', 'qwen'].includes(m.engine));
    benchModelsLoaded = true;
    if (!models.length) {
      box.innerHTML = '<div class="bench-empty">没有已安装完成的本地模型。先在「语音识别」里下载模型和运行时。</div>';
      return;
    }
    const checked = firstLoad ? new Set(models.filter(m => m.usable).map(m => m.id)) : previous;
    box.innerHTML = models.map((m) => {
      const label = BACKEND_LABEL[m.backend] || m.backend || '';
      const state = m.usable ? '' : '当前后端未启用或硬件不满足，测试可能失败';
      return `<label class="bench-model${m.usable ? '' : ' is-unavailable'}">
        <input type="checkbox" value="${esc(m.id)}"${checked.has(m.id) ? ' checked' : ''}>
        <span><b>${esc(m.name)}</b><small>${esc(m.engine)}${label ? ' · ' + esc(label) : ''}${state ? ' · <span class="warn">' + esc(state) + '</span>' : ''}</small></span>
      </label>`;
    }).join('');
    const note = $('#bench-models-note');
    if (note) note.textContent = models.length + ' 个已安装模型';
  } catch (e) {
    if (firstLoad) box.innerHTML = '<div class="bench-empty">模型读取失败：' + esc(String((e && e.message) || e)) + '</div>';
    const note = $('#bench-models-note');
    if (note) note.textContent = '读取失败';
  } finally {
    benchLoading = false;
  }
}

/** 速度测试失败时的就地修复入口：只有确实需要安装/修复运行时的情况才给按钮。
 *  VibeVoice 的「No module named bitsandbytes」正是典型：运行时目录存在，但依赖没装全。 */
function benchFixButton(r) {
  const err = String(r.error || '');
  if (!err) return '';
  // 停用：VibeVoice 修复入口
  // if (r.engine === 'vibevoice' && /bitsandbytes|VibeVoice|CUDA|运行时|module/i.test(err)) {
  //   return '<div class="bench-fix-row"><span class="bench-fix-status" data-status></span><button type="button" class="btn btn-mini bench-fix" data-fix="runtime:vibevoice" data-force="1">安装 / 修复 VibeVoice 运行时</button></div>';
  // }
  if (r.engine === 'faster-whisper' && /faster-whisper-xxl|运行时/i.test(err)
    && /没装|缺失|未就绪|not found|Unable to launch|没有找到/i.test(err)) {
    return '<div class="bench-fix-row"><span class="bench-fix-status" data-status></span><button type="button" class="btn btn-mini bench-fix" data-fix="runtime:faster-whisper">安装 Faster-Whisper 运行时</button></div>';
  }
  return '';
}

/** 安装运行时后，在失败行里持续显示真实进度；装好/失败都给出明确下一步。
 *  旧版只 toast 一下就结束，用户站在「全模型速度」页签上根本看不到安装进展。 */
async function benchInstallRuntime(btn) {
  const row = btn.closest('.bench-fix-row');
  const status = row && row.querySelector('.bench-fix-status');
  const label = btn.textContent;
  const setStatus = (text) => { if (status) status.textContent = text || ''; };
  btn.disabled = true;
  btn.textContent = '正在启动…';
  try {
    const r = await (await fetch('/api/asr/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: btn.dataset.fix, force: btn.dataset.force === '1' }),
    })).json();
    if (r.error) throw new Error(r.error);
    if (r.ready) {
      btn.textContent = '运行时已就绪';
      setStatus('✓ 运行时已就绪，点「开始测试」重新跑一次');
      return;
    }
    btn.textContent = '安装中…';
    setStatus('正在安装运行时…');
    toast('已开始安装运行时，进度会显示在这一行', 4200);
    // 在页面上看进度，而不是让用户去别的页签猜：2 秒一轮，最多 40 分钟。
    const fix = String(btn.dataset.fix || '');
    const dlKey = fix.includes('vibevoice') ? 'vibevoice' : 'runtime:faster-whisper';
    const deadline = Date.now() + 40 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!btn.isConnected) return;   // 行被重绘/切页后停止轮询，别更新已脱离文档的节点
      let d = null;
      try { d = await (await fetch('/api/asr/status')).json(); } catch { continue; }
      const dl = (d.downloads || []).find(x => x && x.key === dlKey);
      const ready = fix.includes('vibevoice')
        ? !!(d.vibevoice && d.vibevoice.ok && d.vibevoice.cuda && d.vibevoice.bitsandbytes
          && d.vibevoice.bnbCudaKernel)
        : !!(d.fasterWhisperRuntime && d.fasterWhisperRuntime.ok);
      if (ready) {
        setStatus('✓ 运行时已就绪，点「开始测试」重新跑一次');
        btn.textContent = '已就绪';
        toast('运行时已就绪，重新开始测试即可', 4200);
        return;
      }
      if (dl && dl.error) {
        setStatus('安装失败：' + String(dl.error).slice(0, 160));
        btn.disabled = false;
        btn.textContent = '重试修复';
        return;
      }
      if (dl && dl.running) {
        setStatus('安装中 ' + (Number(dl.pct) || 0) + '%' + (dl.msg ? ' · ' + String(dl.msg).slice(0, 60) : ''));
      }
    }
    setStatus('安装仍未完成，可到「语音识别」页查看进度');
    btn.disabled = false;
    btn.textContent = label;
  } catch (e) {
    setStatus('启动安装失败：' + String((e && e.message) || e).slice(0, 160));
    toast('启动安装失败：' + String((e && e.message) || e), 5000);
    btn.disabled = false;
    btn.textContent = label;
  }
}

function benchRenderResult(s) {
  const box = $('#bench-result');
  if (!box) return;
  const results = Array.isArray(s && s.results) ? s.results.slice() : [];
  if (!results.length) { box.innerHTML = ''; return; }
  results.sort((a, b) => {
    if (!!a.error !== !!b.error) return a.error ? 1 : -1;
    return (b.speed || 0) - (a.speed || 0);
  });
  const audioSec = results.find(r => r.audioSec != null)?.audioSec;
  const rows = results.map((r) => {
    if (r.error) {
      return `<tr><td>${esc(r.name)}<br><small>${esc(r.engine || '')}</small></td><td colspan="5" class="err">${esc(r.error)}${benchFixButton(r)}</td></tr>`;
    }
    const asrSec = Number(r.elapsedSec) || 0;
    const postSec = Number(r.postSec) || 0;
    const totalSec = r.totalSec != null ? Number(r.totalSec) : asrSec + postSec;
    const speed = r.speed != null ? Number(r.speed) : (Number(r.audioSec) || 0) / Math.max(0.001, totalSec);
    return `<tr><td>${esc(r.name)}<br><small>${esc(r.engine || '')}</small></td>`
      + `<td>${asrSec.toFixed(2)}s</td>`
      + `<td>${postSec > 0 ? postSec.toFixed(2) + 's' : '—'}</td>`
      + `<td>${totalSec.toFixed(2)}s</td>`
      + `<td class="speed">${speed.toFixed(2)}×</td>`
      + `<td class="conf" title="${r.confidence?.lowRate != null ? '低置信度占比 ' + Math.round(Number(r.confidence.lowRate) * 100) + '%' : '该引擎不提供逐句置信度'}">${r.confidence?.avg != null ? Number(r.confidence.avg).toFixed(2) : '—'}</td></tr>`;
  }).join('');
  const post = s && s.post;
  const postParts = [];
  if (post) {
    if (post.diarizeSec > 0) postParts.push('说话人分离 ' + Number(post.diarizeSec).toFixed(2) + 's');
    if (post.castSec > 0) postParts.push('分角色识别 ' + Number(post.castSec).toFixed(2) + 's');
    if (post.note) postParts.push(String(post.note));
  }
  box.innerHTML = `<div class="st-section-title" style="margin-top:4px">测试结果</div>
    <table class="bench-table"><thead><tr><th>模型</th><th>识别</th><th>后处理</th><th>总耗时</th><th>倍率</th><th>置信度</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="bench-result-note">倍率 = 音频秒数 / 实际总耗时（识别 + 已开启的后处理，含模型加载），越高越快${audioSec ? '；本次音频 ' + Number(audioSec).toFixed(1) + 's' : ''}。置信度是模型逐句自评的平均值（VibeVoice 不提供），不代表准确率。</div>
    ${postParts.length ? `<div class="bench-result-note">后处理：${esc(postParts.join(' · '))}</div>` : ''}`;
  box.querySelectorAll('.bench-fix').forEach(btn => btn.addEventListener('click', () => benchInstallRuntime(btn)));
}

function benchStopPolling() {
  if (benchTimer) { clearInterval(benchTimer); benchTimer = null; }
}

function benchPoll() {
  fetch('/api/asr/bench/state').then(r => r.json()).then((s) => {
    if (!s) return;
    const bar = $('#bench-bar');
    const stage = $('#bench-stage');
    if (bar) bar.style.width = Math.max(0, Math.min(100, Number(s.pct) || 0)) + '%';
    if (stage) stage.textContent = s.msg || '';
    const progress = $('#bench-progress');
    if (progress) progress.hidden = !s.running;
    if (s.running) {
      benchSetBusy(true);
      return;
    }
    benchStopPolling();
    benchSetBusy(false, s.cancelled ? '已取消测试' : (s.error ? '失败：' + s.error : '测试完成'));
    benchRenderResult(s);
  }).catch(() => {}).finally(() => {});
}

function benchStartPolling() {
  benchStopPolling();
  benchPoll();
  benchTimer = setInterval(benchPoll, 1200);
}

async function benchStart() {
  const ids = [...document.querySelectorAll('#bench-models input[type=checkbox]:checked')].map(c => c.value);
  if (!ids.length) { benchSetBusy(false, '请至少选择一个已安装模型'); return; }
  if (!benchAudio) { benchSetBusy(false, '请先选择测试音频'); return; }
  const seconds = Math.max(5, Math.min(600, Number(($('#bench-seconds') || {}).value) || 20));
  const conditions = {
    word: $('#bench-word') ? !!$('#bench-word').checked : true,
    confidence: ($('#bench-confidence') && $('#bench-confidence').value) || 'full',
    cast: !!($('#bench-cast') && $('#bench-cast').checked),
    speakers: !!($('#bench-speakers') && $('#bench-speakers').checked),
    speakerCount: Number(($('#bench-speaker-count') || {}).value) || 0,
  };
  const box = $('#bench-result');
  if (box) box.innerHTML = '';
  const progress = $('#bench-progress');
  if (progress) progress.hidden = false;
  benchSetBusy(true, '启动中…');
  try {
    const r = await (await fetch('/api/asr/bench/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: benchAudio, models: ids, seconds, conditions }),
    })).json();
    if (r && r.error) { benchSetBusy(false, '失败：' + r.error); return; }
    benchStartPolling();
  } catch (e) {
    benchSetBusy(false, '失败：' + ((e && e.message) || e));
  }
}

function initBenchPanel() {
  const modelsView = $('#perf-models-view');
  if (!modelsView || modelsView.dataset.bound) return;
  modelsView.dataset.bound = '1';
  document.querySelectorAll('[data-perf-tab]').forEach((b) => {
    b.addEventListener('click', () => selectPerfTab(b.dataset.perfTab));
  });
  const pick = $('#bench-audio-pick');
  if (pick) pick.addEventListener('click', async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 40000);
      const r = await fetch('/api/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'audio' }), signal: ctl.signal });
      clearTimeout(timer);
      const d = await r.json();
      if (d && d.path) benchSetAudio(d.path);
    } catch (e) { benchSetBusy(false, '选择音频失败：' + ((e && e.message) || e)); }
  });
  const auto = $('#bench-audio-auto');
  if (auto) auto.addEventListener('click', async () => {
    try {
      const d = await (await fetch('/api/asr/perf/auto-audio')).json();
      if (d && d.path) benchSetAudio(d.path);
      else benchSetBusy(false, (d && d.error) || '没找到现成音频');
    } catch (e) { benchSetBusy(false, '查找失败：' + ((e && e.message) || e)); }
  });
  const refresh = $('#bench-refresh');
  if (refresh) refresh.addEventListener('click', () => benchLoadModels(true));
  const all = $('#bench-all');
  if (all) all.addEventListener('click', () => {
    document.querySelectorAll('#bench-models input[type=checkbox]').forEach(c => { c.checked = true; });
  });
  const none = $('#bench-none');
  if (none) none.addEventListener('click', () => {
    document.querySelectorAll('#bench-models input[type=checkbox]').forEach(c => { c.checked = false; });
  });
  const start = $('#bench-start');
  if (start) start.addEventListener('click', benchStart);
  const cancel = $('#bench-cancel');
  if (cancel) cancel.addEventListener('click', async () => {
    try { await fetch('/api/asr/bench/cancel', { method: 'POST' }); } catch {}
  });
  // 与创建页一致：分角色识别以说话人区分为前提；关掉说话人时一并关掉分角色。
  const cast = $('#bench-cast'), speakers = $('#bench-speakers');
  if (cast && speakers) {
    cast.addEventListener('change', () => { if (cast.checked) speakers.checked = true; });
    speakers.addEventListener('change', () => { if (!speakers.checked) cast.checked = false; });
  }
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
    /* 复用 renderAsrModels 刚拿到的 latestAsrStatus，避免每次刷新再打一遍 status；
       显示条件必须和这里一致：dual 模型 ready 才显示。 */
    const anyDual = !!(latestAsrStatus && (latestAsrStatus.models || [])
      .some((m) => m.engine === 'dual' && m.ready));
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
  /* ⚠ 委托容器必须是 **#st-panel-models**，不能是 #st-models。
   *   HTML 里 #st-models 与 #dual-ratio-row 是**在 #st-panel-models 下的兄弟节点**，
   *   change 事件从 #dual-ratio 冒泡**根本到不了** #st-models。
   *   2026-10-11 无头浏览器实测：改下拉既不发 /api/asr/dual、note 也不变（等于整个交互死掉）。
   *   #st-panel-models 才是同时包含两者的稳定容器 —— renderAsrModels 只重建
   *   #st-models 的 innerHTML，不动本容器，所以"重渲染不失效"的初衷依然成立。 */
  const box = $('#st-panel-models');
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

/* ── ASR 模型参数面板 ───────────────────────────────────────────────
 * 模型行每秒随下载进度重渲染，参数编辑不能放进行内（输入框会丢焦点，折叠状态也会重置）。
 * 所以做成独立的模态面板：行上只留「参数」入口和当前值摘要，编辑时 DOM 不受轮询影响。
 * 参数 schema 由服务端 editor/asr-params.js 给出；这里只负责展示、校验和提交。 */
let asrParamDialog = null;
let asrParamLastFocus = null;
let asrParamState = { model: null, schema: [], values: {}, defaults: {}, isDefault: true };
let asrParamClosing = false;
let asrParamCloseTimer = 0;
let asrParamCloseHandler = null;
const ASR_PARAM_ENGINE_LABEL = {
  'faster-whisper': 'Faster-Whisper-XXL',
  'whisper.cpp': 'whisper.cpp',
  'crispasr': 'CrispASR',
  'crispasr-whisper': 'CrispASR · Whisper Vulkan',
  'crispasr-qwen': 'CrispASR · Qwen3 Vulkan',
  'qwen': 'Qwen3-ASR',
  'sherpa-onnx': 'sherpa-onnx · CUDA',
  'vibevoice': 'VibeVoice 4bit · CUDA',
};

function ensureAsrParamsDialog() {
  if (asrParamDialog) return asrParamDialog;
  const el = document.createElement('div');
  el.id = 'sf-asr-params';
  el.className = 'sf-ap-backdrop';
  el.hidden = true;
  el.innerHTML = `
    <div class="sf-ap-panel" role="dialog" aria-modal="true" aria-labelledby="sf-ap-title">
      <div class="sf-ap-head">
        <div class="sf-ap-heading">
          <h2 id="sf-ap-title">识别参数</h2>
          <p class="sf-ap-model" id="sf-ap-model"></p>
        </div>
        <button type="button" class="sf-ap-x" id="sf-ap-close" aria-label="关闭">×</button>
      </div>
      <div class="sf-ap-body">
        <div class="sf-ap-state" id="sf-ap-state"></div>
        <p class="sf-ap-note">保存后对下一次识别任务生效；正在运行的任务不会改变。</p>
        <div class="sf-ap-fields" id="sf-ap-fields"></div>
      </div>
      <div class="sf-ap-foot">
        <button type="button" class="btn btn-mini" id="sf-ap-reset">恢复默认</button>
        <span class="sf-ap-msg" id="sf-ap-msg" role="status"></span>
        <button type="button" class="btn" id="sf-ap-cancel">取消</button>
        <button type="button" class="btn btn-accent" id="sf-ap-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  // 用 el.querySelector 而不是全局 $：模态是刚 append 的子树，按子树取最稳，
  // 也避免页面上存在同名旧节点时拿到别的元素。
  const q = (s) => el.querySelector(s);
  q('#sf-ap-close').addEventListener('click', closeAsrParamsDialog);
  q('#sf-ap-cancel').addEventListener('click', closeAsrParamsDialog);
  q('#sf-ap-save').addEventListener('click', saveAsrParams);
  q('#sf-ap-reset').addEventListener('click', resetAsrParams);
  el.addEventListener('click', (e) => { if (e.target === el) closeAsrParamsDialog(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && asrParamDialog && !asrParamDialog.hidden) closeAsrParamsDialog();
  });
  return (asrParamDialog = el);
}

function asrParamDefaultText(field) {
  if (field.type === 'bool') return field.default ? '开' : '关';
  if (field.type === 'select') {
    const opt = (field.options || []).find(o => o.value === field.default);
    return opt ? opt.label : String(field.default);
  }
  if (field.type === 'number') return String(field.default);
  return String(field.default || '') || '留空';
}

function asrParamFieldHtml(field, value) {
  const id = 'sf-ap-f-' + field.key;
  const key = esc(field.key);
  let control = '';
  if (field.type === 'bool') {
    control = `<label class="sf-ap-switch" for="${id}"><input type="checkbox" id="${id}" data-param="${key}"${value ? ' checked' : ''}><span>${esc(field.label)}</span><span class="sf-ap-default">默认 ${esc(asrParamDefaultText(field))}</span></label>`;
  } else if (field.type === 'select') {
    control = `<select id="${id}" data-param="${key}">${(field.options || []).map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (field.type === 'number') {
    control = `<input type="number" id="${id}" data-param="${key}" value="${esc(value)}" min="${esc(field.min)}" max="${esc(field.max)}" step="${esc(field.step || 1)}" inputmode="decimal" required>`;
  } else {
    control = `<textarea id="${id}" data-param="${key}" rows="3" maxlength="${esc(field.maxLength || 300)}" placeholder="留空使用自动提示词">${esc(value || '')}</textarea>`;
  }
  return `<div class="sf-ap-field" data-field="${key}">
    ${field.type === 'bool' ? '' : `<div class="sf-ap-fieldhead"><label for="${id}">${esc(field.label)}</label><span class="sf-ap-default">默认 ${esc(asrParamDefaultText(field))}</span></div>`}
    ${control}
    ${field.help ? `<p class="sf-ap-help">${esc(field.help)}</p>` : ''}
  </div>`;
}

function renderAsrParams() {
  const box = $('#sf-ap-fields');
  if (!box) return;
  box.innerHTML = asrParamState.schema.map(f => asrParamFieldHtml(f, asrParamState.values[f.key])).join('');
  const stateEl = $('#sf-ap-state');
  if (stateEl) {
    stateEl.textContent = asrParamState.isDefault ? '当前使用默认参数' : '已自定义参数';
    stateEl.classList.toggle('custom', !asrParamState.isDefault);
  }
  const msg = $('#sf-ap-msg');
  if (msg) msg.textContent = '';
  const reset = $('#sf-ap-reset');
  if (reset) reset.disabled = asrParamState.isDefault;
  for (const f of asrParamState.schema) {
    const ctl = $(`#sf-ap-f-${f.key}`);
    if (!ctl) continue;
    const dirty = () => {
      if (msg) msg.textContent = '';
      $('#sf-ap-reset').disabled = false;
      const stateEl = $('#sf-ap-state');
      if (stateEl) { stateEl.textContent = '已修改（未保存）'; stateEl.classList.add('custom'); }
    };
    ctl.addEventListener('input', dirty);
    ctl.addEventListener('change', dirty);
  }
}

async function openAsrParamsDialog(modelId) {
  const el = ensureAsrParamsDialog();
  // 关闭动画还没播完就再次打开：取消退场并直接回到打开状态，不要让旧定时器把新面板收起。
  cancelAsrParamsClose();
  if (el.hidden) asrParamLastFocus = document.activeElement;
  el.hidden = false;
  document.body.classList.add('sf-ap-open');
  $('#sf-ap-model').textContent = '读取中…';
  $('#sf-ap-state').textContent = '';
  $('#sf-ap-fields').innerHTML = '<p class="sf-ap-loading">正在读取当前参数…</p>';
  $('#sf-ap-msg').textContent = '';
  $('#sf-ap-save').disabled = true;
  $('#sf-ap-reset').disabled = true;
  try {
    const r = await fetch('/api/asr/params?model=' + encodeURIComponent(modelId), { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    asrParamState = { model: d.model, schema: d.schema || [], values: d.values || {}, defaults: d.defaults || {}, isDefault: !!d.isDefault };
    $('#sf-ap-model').textContent = d.model.name + (d.model.engine
      ? ' · ' + (ASR_PARAM_ENGINE_LABEL[d.model.engine] || d.model.engine) : '');
    $('#sf-ap-save').disabled = false;
    renderAsrParams();
    requestAnimationFrame(() => {
      const first = $('#sf-ap-fields').querySelector('input,select,textarea');
      if (first) first.focus({ preventScroll: true });
    });
  } catch (e) {
    $('#sf-ap-model').textContent = '参数读取失败';
    $('#sf-ap-fields').innerHTML = `<p class="sf-ap-error">${esc(String((e && e.message) || e))}</p>`;
  }
}

function cancelAsrParamsClose() {
  if (asrParamCloseTimer) { clearTimeout(asrParamCloseTimer); asrParamCloseTimer = 0; }
  if (asrParamCloseHandler && asrParamDialog) {
    const panel = asrParamDialog.querySelector('.sf-ap-panel');
    if (panel) panel.removeEventListener('animationend', asrParamCloseHandler);
  }
  asrParamCloseHandler = null;
  asrParamClosing = false;
  if (asrParamDialog) asrParamDialog.classList.remove('is-closing');
}

function closeAsrParamsDialog() {
  if (!asrParamDialog || asrParamDialog.hidden || asrParamClosing) return;
  asrParamClosing = true;
  const dialog = asrParamDialog;
  const panel = dialog.querySelector('.sf-ap-panel');
  const finish = () => {
    if (!asrParamClosing) return;
    asrParamClosing = false;
    if (asrParamCloseTimer) { clearTimeout(asrParamCloseTimer); asrParamCloseTimer = 0; }
    if (asrParamCloseHandler && panel) panel.removeEventListener('animationend', asrParamCloseHandler);
    asrParamCloseHandler = null;
    dialog.classList.remove('is-closing');
    dialog.hidden = true;
    document.body.classList.remove('sf-ap-open');
    if (asrParamLastFocus && typeof asrParamLastFocus.focus === 'function') asrParamLastFocus.focus({ preventScroll: true });
    asrParamLastFocus = null;
  };
  const noMotion = (typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    || document.body.dataset.motion === 'off';
  if (!panel || noMotion) { finish(); return; }
  dialog.classList.add('is-closing');
  asrParamCloseHandler = (e) => { if (e.animationName === 'sf-ap-panel-out') finish(); };
  panel.addEventListener('animationend', asrParamCloseHandler);
  // animationend 在后台标签页/极端情况下可能不派发，留一个略大于动画时长的兜底。
  asrParamCloseTimer = setTimeout(finish, 260);
}

function collectAsrParamValues() {
  const out = {};
  for (const f of asrParamState.schema) {
    const el = $(`#sf-ap-f-${f.key}`);
    if (!el) continue;
    if (f.type === 'bool') out[f.key] = !!el.checked;
    else if (f.type === 'number') {
      if (el.value.trim() === '' || !el.checkValidity()) {
        $('#sf-ap-msg').textContent = '请检查「' + f.label + '」的数值范围';
        el.focus({ preventScroll: true });
        return null;
      }
      out[f.key] = Number(el.value);
    } else out[f.key] = el.value;
  }
  return out;
}

async function saveAsrParams() {
  if (!asrParamState.model) return;
  const values = collectAsrParamValues();
  if (!values) return;
  const save = $('#sf-ap-save');
  save.disabled = true;
  $('#sf-ap-msg').textContent = '保存中…';
  try {
    const r = await fetch('/api/asr/params', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: asrParamState.model.id, values }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    asrParamState.values = d.values || values;
    asrParamState.isDefault = !!d.isDefault;
    renderAsrParams();
    $('#sf-ap-msg').textContent = '已保存';
    if (typeof toast === 'function') toast('识别参数已保存');
    renderAsrModels();
  } catch (e) {
    $('#sf-ap-msg').textContent = '保存失败：' + String((e && e.message) || e);
  } finally {
    save.disabled = false;
  }
}

async function resetAsrParams() {
  if (!asrParamState.model) return;
  const reset = $('#sf-ap-reset');
  reset.disabled = true;
  $('#sf-ap-msg').textContent = '恢复中…';
  try {
    const r = await fetch('/api/asr/params', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: asrParamState.model.id, reset: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    asrParamState.values = d.values || {};
    asrParamState.isDefault = true;
    renderAsrParams();
    $('#sf-ap-msg').textContent = '已恢复默认参数';
    if (typeof toast === 'function') toast('已恢复默认识别参数');
    renderAsrModels();
  } catch (e) {
    $('#sf-ap-msg').textContent = '恢复失败：' + String((e && e.message) || e);
  } finally {
    reset.disabled = asrParamState.isDefault;
  }
}

function initAsrParams() {
  const box = $('#st-panel-models');
  if (!box || box.dataset.asrParamsBound) return;
  box.dataset.asrParamsBound = '1';
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.sm-params');
    if (!btn || !btn.dataset.id) return;
    e.preventDefault();
    openAsrParamsDialog(btn.dataset.id);
  });
}

/* ── 设置页新增的两块（设计稿 ①）：入口卡的进度/胶囊 + 运行时环境卡 ──
 * 都从 /api/asr/status 的**真实**数据算，不写死数字。renderAsrModels() 里已经拿到
 * 同一份 d，所以由它调用，避免同一个接口请求两次。 */

/** 引擎 → 胶囊标签（设计稿里 Parakeet×3 / Whisper×1 / 云端×2 那种） */
const ENTRY_CHIP = {
  'sherpa-onnx': { label: 'Parakeet', cls: 'ok' },
  'openvino': { label: 'Parakeet', cls: 'ok' },
  'crispasr': { label: 'Parakeet', cls: 'ok' },
  'crispasr-whisper': { label: 'Whisper', cls: 'blue' },
  'crispasr-qwen': { label: 'Qwen3', cls: 'violet' },
  'dual': { label: 'Parakeet', cls: 'ok' },
  'whisper.cpp': { label: 'Whisper', cls: 'blue' },
  'faster-whisper': { label: 'Whisper', cls: 'blue' },
  'qwen': { label: 'Qwen3', cls: 'violet' },
  'vibevoice': { label: 'VibeVoice', cls: 'violet' },
  'nemo': { label: 'NeMo', cls: 'violet' },
  'bcut': { label: '云端', cls: 'warn' },
  'capcut': { label: '云端', cls: 'warn' },
};

function renderModelEntries(d) {
  const models = (d && d.models) || [];
  // ── ASR 卡：N/M 已安装 + 按系列聚合的胶囊 ──
  const installed = models.filter(m => m.ready).length;
  const barA = document.getElementById('st-entry-asr-bar');
  const subA = document.getElementById('st-entry-asr-sub');
  const chipsA = document.getElementById('st-entry-asr-chips');
  if (subA) subA.textContent = '语音识别 · ' + models.length + ' 个模型';
  if (barA) barA.style.width = (models.length ? Math.round(installed / models.length * 100) : 0) + '%';
  if (chipsA) {
    const byLabel = {};
    for (const m of models) {
      const c = ENTRY_CHIP[m.engine] || { label: m.cloud ? '云端' : m.engine, cls: '' };
      const k = c.label + '|' + c.cls;
      byLabel[k] = (byLabel[k] || 0) + 1;
    }
    const chips = Object.entries(byLabel).map(([k, n]) => {
      const [label, cls] = k.split('|');
      return '<span class="' + cls + '">' + esc(label) + ' ×' + n + '</span>';
    });
    // 进度文案放在胶囊后面（设计稿是"N / M 已安装"挨着进度条，这里并在同一行更省地方）
    chips.unshift('<span>' + installed + ' / ' + models.length + ' 已安装</span>');
    chipsA.innerHTML = chips.join('');
  }
  // ── LLM 卡：预设方案数（服务端 /api/translate/config 的 presets）──
  // stPresets 由设置页自己加载过；为空时按 0 显示，不谎报数字。
  const presets = (typeof stPresets !== 'undefined' && stPresets) || [];
  const subL = document.getElementById('st-entry-llm-sub');
  const barL = document.getElementById('st-entry-llm-bar');
  const chipsL = document.getElementById('st-entry-llm-chips');
  if (presets.length) {
    // 「已配置」= 该服务商有 baseUrl 或本地地址（本地模型不需要 Key）
    const conf = presets.filter(p => p && (p.baseUrl || p.local)).length;
    if (subL) subL.textContent = '翻译方案 · ' + presets.length + ' 套配置';
    if (barL) barL.style.width = Math.round(conf / presets.length * 100) + '%';
    if (chipsL) {
      chipsL.innerHTML = '<span>' + conf + ' / ' + presets.length + ' 已配置</span>'
        + presets.slice(0, 4).map(p => '<span class="' + (p.baseUrl || p.local ? 'ok' : '') + '">'
          + esc(p.name || p.id || '未命名') + '</span>').join('');
    }
  } else {
    if (subL) subL.textContent = '翻译方案';
    if (chipsL) chipsL.innerHTML = '<span>读取中…</span>';
  }
}

/** 运行时环境三卡（Python / NeMo / 说话人分离），照设计稿 ① 的第三块。
 *  状态全部来自 d 里的真实探测：pythonProbe / nemo / diarize。 */
function renderRuntimeEnv(d) {
  const box = document.getElementById('st-runtime-env');
  if (!box) return;
  const py = d && d.pythonProbeFlat ? d.pythonProbeFlat : (d && d.pythonProbe ? (d.pythonProbe.openvino || null) : null);
  const pyOk = !!(py && py.ok);
  const pyState = !py ? { cls: 'warn', txt: '检测中…' }
    : pyOk ? { cls: 'ok', txt: '✓ 可用' }
      : { cls: 'bad', txt: '不可用' };
  const nemo = (d && d.nemo) || {};
  const diar = (d && d.diarize) || {};
  const card = (dot, name, line, state, action) => `
    <div class="st-env">
      <div class="st-env-head"><i class="st-env-dot ${dot}"></i><span class="st-env-name">${esc(name)}</span></div>
      <p class="st-env-line">${esc(line)}</p>
      <p class="st-env-state ${state.cls}">${esc(state.txt)}</p>
      ${action || ''}
    </div>`;
  const pyLine = pyOk
    ? (py.msg || '') + (d.provider === 'cuda' && d.gpu ? ' · CUDA · ' + d.gpu : '')
    : (py && py.msg ? py.msg : '未检测到 Python 环境');
  const nemoCard = nemo.ok
    ? card('ok', 'NeMo', nemo.msg || ('NeMo ' + (nemo.nemoVer || '')), { cls: 'ok', txt: '✓ 可用' })
    : card('bad', 'NeMo', '未安装 · 约 5 GB（多说话人模型需要它）', { cls: 'bad', txt: '未安装' },
      '<button type="button" class="st-env-act" id="st-env-nemo">安装</button>');
  const diarN = Array.isArray(diar.models) ? diar.models.length : 0;
  const diarLine = diar.ready
    ? '已就绪 · ' + diarN + ' 个模型'
    : '未下载 · ' + diarN + ' 个模型';
  box.innerHTML = card(pyOk ? 'ok' : 'bad', 'Python', pyLine, pyState)
    + nemoCard
    + card(diar.ready ? 'ok' : 'bad', '说话人分离', diarLine,
      diar.ready ? { cls: 'ok', txt: '✓ 可用' } : { cls: 'bad', txt: '未就绪' });
  if (window.__applyIcons) window.__applyIcons(box);
  const nb = document.getElementById('st-env-nemo');
  if (nb) nb.addEventListener('click', () => { nb.disabled = true; nb.textContent = '安装中…'; startNemoInstallFromEnv(); });
}

/** 运行时环境卡里的「安装」按钮：与模型列表里那个 NeMo 安装按钮走同一个接口，
 *  同样把进度交给 pollModelDownload()（进度显示在设置页浮动状态 #st-msg 上）。 */
async function startNemoInstallFromEnv() {
  const msgEl = $('#st-msg');
  try {
    const r = await (await fetch('/api/asr/install-nemo', { method: 'POST' })).json();
    if (msgEl) {
      if (r.error) { msgEl.textContent = '✗ ' + r.error; msgEl.classList.add('err'); }
      else if (r.started || r.already) { msgEl.textContent = '正在安装 NeMo 运行时（约 5GB，进度见上方）…装完会自动测一次 CUDA'; msgEl.classList.remove('err'); pollModelDownload(); }
    }
  } catch (e) {
    if (msgEl) { msgEl.textContent = '✗ 安装启动失败: ' + String((e && e.message) || e); msgEl.classList.add('err'); }
  }
  renderAsrModels();
}

/** 本机硬件条（设计稿 ②）：只显示**探测到**的硬件，一条都不显示时给一句说明。
 *  数据来源与模型可用性判定同源（d.gpu / d.provider / d.runtime / d.crispasrRuntime /
 *  d.pythonProbe），所以"条上说有 N 卡、列表却说没有 N 卡"这种自相矛盾不会出现。 */
function renderHardwareBar(d) {
  const box = document.getElementById('st-hardware');
  if (!box) return;
  const chips = [];
  // N 卡：硬件探测优先；旧服务端没有 hardware 时退回 provider/gpu 文案
  if (d.gpu) chips.push(`<span class="hw-chip ok">N 卡 ${esc(d.gpu)}</span>`);
  // Intel NPU：有硬件才显示；OpenVINO 没装时仍显示硬件（模型行会提示安装环境）
  const hw = d.hardware || null;
  const ov = d.pythonProbe && d.pythonProbe.openvino;
  if (hw?.npu?.available === true) {
    chips.push(`<span class="hw-chip ok">NPU ${esc((hw.npu.devices || [])[0] || '')}</span>`);
  } else if (!hw && ov && ov.ok) chips.push('<span class="hw-chip ok">Intel NPU</span>');
  // Vulkan：硬件探测优先（运行时装没装是模型行的事）
  if (hw?.vulkan?.available === true) chips.push('<span class="hw-chip ok">Vulkan</span>');
  else if (!hw && ((d.runtime && d.runtime.ok) || (d.crispasrRuntime && d.crispasrRuntime.ok))) {
    chips.push('<span class="hw-chip ok">Vulkan</span>');
  }
  const models = d.models || [];
  const installed = models.filter(m => m.ready).length;
  const extraCount = (d.extraModels || []).length;
  const right = (models.length ? `已安装 ${installed} / ${models.length}` : '')
    + (extraCount ? ` · 其它模型 ${extraCount}` : '');
  box.innerHTML = '<span class="hw-cap" data-ico="gear">本机硬件：</span>'
    + (chips.length ? chips.join('') : '<span class="hw-chip none">未检测到可用加速硬件（云端识别仍可用）</span>')
    + (right ? `<span class="hw-right">${right}</span>` : '');
  if (window.__applyIcons) window.__applyIcons(box);
}

/** 单个模型一行（设计稿 ② 的模型卡片：名称 + 状态 + 下载/删除按钮）。
 *  从 renderAsrModels() 里抽出来，以便**按系列分组**逐组拼装 —— 判断逻辑一行没改，
 *  只是把"映射一个模型 → 一段 HTML"变成具名函数，供分组循环调用。 */
function modelRowHtml(m, d, dlOf) {
  const st = dlOf('model:' + m.id);
  const rtSt = m.needRuntime ? dlOf(m.runtimeKey || 'runtime') : {};
  const dlThis = st.running || (m.needRuntime && rtSt.running);
  /* 无对应 GPU 环境连下载都拦: Parakeet 要 CUDA 版 sherpa-onnx; NeMo 多说话人模型只给 N 卡用户。
   * ⚠ `d.gpu` 为空还有第三种可能：**后台探测还没跑完**（服务端已改成等探测完再回，
   *   但旧实例/极端慢的 nvidia-smi 仍可能给空）。那种情况下不能说"没检测到 N 卡" —— 是误报。 */
  const gpuUnknown = !d.gpu && !!d.gpuPending;
  const pyBlocked = (m.engine === 'sherpa-onnx' && d.provider !== 'cuda')
    || (m.engine === 'nemo' && !d.gpu && !gpuUnknown);
  const vibeBlocked = m.engine === 'vibevoice' && !d.gpu && !gpuUnknown;
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
  } else if (gpuUnknown && m.engine === 'vibevoice') {
    state = '<span class="sm-state">检测中…（正在查 CUDA GPU）</span>';
  } else if (vibeBlocked) {
    state = d.vibevoice && d.vibevoice.cuda
      ? '<span class="sm-state" style="color:var(--danger)">CUDA GPU 已检测到，但 VibeVoice 运行时未就绪；不支持 CPU 或 NPU</span>'
      : '<span class="sm-state" style="color:var(--danger)">只支持 NVIDIA CUDA GPU；不支持 CPU 或 NPU，无法下载</span>';
  } else if (pyBlocked) {
    state = m.engine === 'nemo'
      ? '<span class="sm-state" style="color:var(--danger)">只支持 N 卡（NVIDIA 显卡）。当前没检测到 N 卡，不支持 CPU 推理，无法下载</span>'
      : '<span class="sm-state" style="color:var(--danger)">需要 CUDA GPU（N 卡）才能下载使用，不支持 CPU。先在上面把 Python 环境装好</span>';
  } else if (m.engine === 'vibevoice' && m.needRuntime) {
    state = `<span class="sm-state">${m.filesOk ? '模型已下载 · ' : ''}${esc(d.vibevoice?.msg || '需要安装独立 CUDA 4bit 运行时')}</span>`;
  } else if (m.needNemo) {
    state = '<span class="sm-state ok">✓ 已下载</span> <span class="sm-state" style="color:var(--danger)">还差 NeMo 运行时（见下方「NeMo 运行时」）</span>';
  } else if (m.needRuntime && m.filesOk) {
    state = '<span class="sm-state">模型已下载 · 还差 ' + esc(m.runtimeName || '运行时') + '</span>';
  } else if (m.partial) {
    // 有文件但完整性校验没过（中断的下载 / 被改动的大文件）：下载可续传，删除给一条退路。
    state = `<span class="sm-state" style="color:var(--danger)">模型文件不完整 · ${m.sizeMB} MB · 可下载续传，或删除后重下</span>`;
  } else if (m.ready) state = '<span class="sm-state ok">✓ 已就绪</span>';
  else state = `<span class="sm-state">未下载 · ${m.sizeMB} MB</span>`;
  if (dlThis) btn = '';
  else if (m.cloud) btn = '';       // 云端模型没有本地文件: 不给「下载/删除」按钮(服务端也拦了删除接口)
  else if (m.partial) {
    btn = `<button type="button" class="btn btn-mini sm-del" data-id="${esc(m.id)}" title="删除模型文件（释放磁盘）">删除</button>`;
    if (!pyBlocked && !vibeBlocked) btn += `<button type="button" class="btn btn-mini sm-dl" data-id="${esc(m.id)}">下载</button>`;
  } else if (m.ready || m.filesOk) btn = `<button type="button" class="btn btn-mini sm-del" data-id="${esc(m.id)}" title="删除模型文件（释放磁盘）">删除</button>`;
  else if (!pyBlocked && !vibeBlocked) btn = `<button type="button" class="btn btn-mini sm-dl" data-id="${esc(m.id)}">下载</button>`;
  if ((studioUI || m.engine === 'vibevoice' || m.engine === 'faster-whisper') && m.needRuntime && !dlThis && !vibeBlocked) {
    // 已经装了一部分（例如 torch/transformers 在、bitsandbytes 缺）时叫「修复运行时」，
    // 点进去仍然是同一个安装接口：已满足的包 pip 会跳过，只补缺的。
    const partialVibe = m.engine === 'vibevoice' && d.vibevoice
      && (d.vibevoice.cuda || d.vibevoice.transformers || d.vibevoice.bitsandbytes);
    btn += `<button type="button" class="btn btn-mini sf-runtime-download" data-runtime="${esc(m.runtimeKey || 'runtime')}">${partialVibe ? '修复运行时' : '安装运行时'}</button>`;
  }
  const paramBtn = m.params
    ? `<button type="button" class="btn btn-mini sm-params" data-id="${esc(m.id)}" title="调整 ${esc(m.params.summary || '识别参数')}">参数</button>`
    : '';
  const paramSummary = m.params
    ? `<div class="sm-params-summary">${esc(m.params.summary || '')}${m.params.isDefault ? ' · 默认' : ' · 已自定义'}</div>`
    : '';
  let rtText = '';
  if (m.needRuntime && !dlThis) {
    if (m.engine === 'vibevoice') rtText = '独立 CUDA 4bit 运行时 · 通过“安装运行时”获取 · 不支持 CPU/NPU';
    else if (m.engine === 'qwen') rtText = '需要 Qwen3 CUDA 运行时（Transformers 5.20 + Accelerate，复用 CUDA Python 环境）';
    else if (m.engine && m.engine.indexOf('crispasr') === 0) rtText = `需要 CrispASR 运行时（约 ${m.runtimeSizeMB || 34}MB，含 Vulkan；无 N 卡时使用）`;
    else if (m.engine === 'faster-whisper') rtText = `需要 ${esc(m.runtimeName || 'Faster-Whisper-XXL')} 运行时（下载约 ${m.runtimeSizeMB || 1450}MB / 解压约 4.4GB，含 CUDA/cuDNN）`;
    else rtText = `需要 ${esc(m.runtimeName || 'whisper.cpp')} 运行时（约 ${m.runtimeSizeMB || 18}MB，含 Vulkan GPU 加速）`;
  }
  const rt = rtText ? `<div class="sm-runtime">${rtText}</div>` : '';
  return `<div class="sm-model">
    <div class="sm-head"><span class="sm-name">${esc(m.name)}${m.draftAllowed === false ? ' <span class="sm-badge">仅重新识别</span>' : ''}</span><span class="sm-actions">${paramBtn}${btn}</span></div>
    <div class="sm-desc">${esc(m.desc || '')}</div>
    ${paramSummary}
    ${state}${rt}
  </div>`;
}

/** 已下载但当前后端未勾选/硬件不可用的模型（「其它模型」）。
 *  只保留“删除”，不提供下载/安装运行时/参与默认选择，避免绕过后端门禁。 */
function extraModelRowHtml(m, d, dlOf) {
  const st = dlOf('model:' + m.id);
  const rtSt = m.needRuntime ? dlOf(m.runtimeKey || 'runtime') : {};
  const dlThis = st.running || (m.needRuntime && rtSt.running);
  const kind = m.backend || backendOf(m);
  const label = BACKEND_LABEL[kind] || String(kind || 'CUDA').toUpperCase();
  const hw = d.hardware || {};
  const b = activeBackends(d);
  let reason = '当前未启用';
  if (kind === 'cuda' && hw.cuda && hw.cuda.available === false) {
    reason = '未检测到 NVIDIA 显卡，勾选 CUDA 也无法启用';
  } else if (kind === 'vulkan' && hw.vulkan && hw.vulkan.available === false) {
    reason = '未检测到 Vulkan 显卡/驱动，勾选 Vulkan 也无法启用';
  } else if (kind === 'dual' && ((hw.cuda && hw.cuda.available === false) || (hw.npu && hw.npu.available === false))) {
    reason = '当前缺少 CUDA 或 NPU 硬件';
  } else if (b && kind === 'cuda' && !b.cuda) {
    reason = '未勾选 CUDA；勾选后会回到正常列表';
  } else if (b && kind === 'vulkan' && !b.vulkan) {
    reason = '未勾选 Vulkan；勾选后会回到正常列表';
  } else if (b && kind === 'dual' && !b.cuda) {
    reason = '未勾选 CUDA；勾选后会回到正常列表';
  }
  let state;
  if (dlThis) {
    state = `<span class="sm-state running">${esc((st.running ? st.msg : rtSt.msg) || '下载中…')} ${(st.running ? st.pct : rtSt.pct) || 0}%</span>`;
  } else if (st.error) {
    state = `<span class="sm-state" style="color:var(--danger)">${esc(st.msg || st.error)}</span>`;
  } else if (m.ready) {
    state = '<span class="sm-state extra">✓ 已下载，运行时也齐 · 当前未启用</span>';
  } else {
    state = '<span class="sm-state extra">✓ 已下载，运行时未就绪 · 当前未启用</span>';
  }
  const btn = dlThis ? '' : `<button type="button" class="btn btn-mini sm-del" data-id="${esc(m.id)}" title="删除模型文件（释放磁盘）">删除</button>`;
  return `<div class="sm-model sf-asr-extra">
    <div class="sm-head"><span class="sm-name">${esc(m.name)}</span>${btn}</div>
    <div class="sm-desc">${esc(m.desc || '')}</div>
    ${state} <span class="sm-state extra">属于 ${esc(label)}：${esc(reason)}</span>
  </div>`;
}

/** 模型 → 系列名（设计稿 ② 的分组口径）：Parakeet / Whisper / NeMo 多说话人 / 云端识别。
 *  按 engine 分而不是按名字猜 —— 名字里带什么字都会变，engine 是服务端给的稳定字段。 */
const MODEL_FAMILY = (m) => {
  if (m.cloud || m.engine === 'bcut' || m.engine === 'capcut') return '云端识别';
  if (m.engine === 'whisper.cpp' || m.engine === 'faster-whisper' || m.engine === 'crispasr-whisper') return 'Whisper 系列';
  if (m.engine === 'qwen' || m.engine === 'crispasr-qwen') return 'Qwen 系列';
  if (m.engine === 'vibevoice') return 'VibeVoice 系列';
  if (m.engine === 'nemo') return 'NeMo 多说话人';
  return 'Parakeet 系列';
};
/** 分组的展开/收起状态：按系列名记。renderAsrModels() 会整个重建 innerHTML，
 *  而下载进度轮询**每秒**重画一次 —— 不记住状态的话用户刚折叠的组立刻又被展开。 */
const GROUP_OPEN = new Map();
let selectedAsrFamily = '';
let latestAsrStatus = null;
let modelEnterTimer = 0;
function showAsrFamily(family) {
  const changedFamily = selectedAsrFamily !== family;
  selectedAsrFamily = family;
  const box = $('#st-models');
  box.dataset.family = family;
  box.querySelectorAll('.sf-asr-model').forEach(row => { row.hidden = row.dataset.family !== family; });
  box.querySelectorAll('.sf-asr-setup').forEach(row => { row.hidden = family !== '前置'; });
  $('#sf-asr-families').hidden = !!family;
  $('#sf-asr-detail').hidden = !family;
  $('#sf-asr-detail-title').textContent = family;
  $('#st-models').closest('.st-card').hidden = !family;
  $('#st-model-dir').closest('.st-card').hidden = family !== '前置';
  $('#st-runtime-env').closest('.st-card').hidden = true;
  $('#sf-asr-rerecog-mount').hidden = !!family;
  $('#dual-ratio-row').hidden = family !== 'Parakeet 系列' || !latestAsrStatus?.models?.some(model => model.engine === 'dual' && model.ready);
  /* 入场动画只在用户切换系列时播一次。下载进度每秒重建 #st-models，若把动画挂在
   * .sf-asr-model 自身，每次重画都会从头播一遍；这里改用父级的一次性 class。 */
  if (changedFamily) {
    clearTimeout(modelEnterTimer);
    box.classList.remove('is-model-entering');
    if (family) {
      void box.offsetWidth;
      box.classList.add('is-model-entering');
      modelEnterTimer = setTimeout(() => box.classList.remove('is-model-entering'), 260);
    }
  }
  /* 进入 Parakeet 时真正读一次 /api/asr/dual 回填已保存比例；轮询重绘同一家族时不重复请求。 */
  // 停用：双引擎配置刷新
  // if (changedFamily && family === 'Parakeet 系列') refreshDualRatio();
}


function alignerRowHtml(a, dlOf) {
  const st = dlOf('model:' + a.id);
  const rtKey = a.runtimeKey || '';
  const rtSt = rtKey ? dlOf(rtKey) : {};
  const running = st.running || (a.needRuntime && rtSt.running);
  // 旧服务端/旧状态没有 filesOk：ready 为真时按“已下载”处理，别退化成下载按钮。
  const filesOk = a.filesOk !== undefined ? a.filesOk : !!a.ready;
  const partial = a.partial === true;
  const backend = a.backend === 'vulkan' ? 'Vulkan' : (a.backend === 'cuda' ? 'CUDA' : '');
  const blocked = a.blockedReason || '';
  /* ⚠ 状态必须按「文件 / 运行时」两层显示：
   *   ready=false 可能是「没下载」也可能是「已下载但运行时缺失」—— 以前统一写「未下载」并给下载按钮，
   *   点下去服务端发现文件已齐只回 ready:true，界面毫无变化，看起来就是按钮点不动（用户实测）。 */
  let state;
  if (running) {
    state = `<span class="sm-state running">${esc((st.running ? st.msg : rtSt.msg) || '下载中…')} ${(st.running ? st.pct : rtSt.pct) || 0}%</span>`;
  } else if (st.error) {
    state = `<span class="sm-state" style="color:var(--danger)">${esc(st.msg || st.error)}</span>`;
  } else if (blocked) {
    // 硬件不可用优先于“还差运行时”：没 N 卡时装了运行时也用不了。
    state = `<span class="sm-state" style="color:var(--danger)">${esc(blocked)}</span>`;
  } else if (a.needRuntime && rtSt.error) {
    // 运行时安装失败（例如缺 CUDA Python）：显示原因，同时保留下面的“重新安装”入口。
    state = `<span class="sm-state" style="color:var(--danger)">${esc(rtSt.msg || rtSt.error)}</span>`;
  } else if (filesOk && a.needRuntime) {
    state = `<span class="sm-state">模型已下载 · 还差 ${esc(a.runtimeName || '运行时')}</span>`;
  } else if (partial) {
    state = `<span class="sm-state" style="color:var(--danger)">模型文件不完整 · ${Number(a.sizeMB || 0)} MB · 可下载续传，或删除后重下</span>`;
  } else if (a.ready) {
    state = '<span class="sm-state ok">✓ 已就绪</span>';
  } else {
    state = `<span class="sm-state">未下载 · ${Number(a.sizeMB || 0)} MB</span>`;
  }
  let btn = '';
  if (!running) {
    if (filesOk || partial) btn = `<button type="button" class="btn btn-mini sm-del" data-id="${esc(a.id)}" title="删除对齐模型文件">删除</button>`;
    if (!filesOk && !blocked) {
      btn += `<button type="button" class="btn btn-mini sm-dl" data-id="${esc(a.id)}">下载 · ${Number(a.sizeMB || 0)} MB</button>`;
    }
    // 运行时缺失时给安装入口：以前只有 ASR 模型行能装，用户在「对齐模型」里找不到按钮，模型永远不可用。
    if (filesOk && a.needRuntime && rtKey && !blocked) {
      btn += `<button type="button" class="btn btn-mini sf-runtime-download" data-runtime="${esc(rtKey)}">安装运行时</button>`;
    }
  }
  return `<div class="sm-model sf-aligner">
    <div class="sm-head"><span class="sm-name">${esc(a.name || 'Qwen3-ForcedAligner')}</span>
      <span class="sm-state${a.ready ? ' ok' : ''}">${a.ready ? '✓ 已就绪' : '未就绪'}</span>${btn}</div>
    <div class="sm-desc">${esc(a.desc || '')}</div>
    <div class="sm-params-summary">${backend ? backend + ' · ' : ''}${esc(a.source || '独立对齐模型')} · 自动匹配，无需手动选择</div>
    ${state}
  </div>`;
}

/** 给 <details> 做高度+透明度动画；原生 details 只能瞬间切换。
 *  只绑定带 .sf-details-anim 的 details，且要求内容在 .sf-details-body 里。
 *  非线性：展开 cubic-bezier(.16,1,.3,1)（先快后慢），收起 cubic-bezier(.4,0,.2,1)。 */
function enhanceDetailsAnimations(root) {
  const host = root || document;
  const doc = host.ownerDocument || document;
  const win = doc.defaultView || window;
  const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb => setTimeout(cb, 16));
  const reduced = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  host.querySelectorAll('details.sf-details-anim').forEach(details => {
    if (details.dataset.animBound) return;
    const summary = details.querySelector(':scope > summary');
    const body = details.querySelector(':scope > .sf-details-body');
    if (!summary || !body) return;
    details.dataset.animBound = '1';
    let animating = false;
    let timer = 0;
    let targetOpen = false;
    const finish = (opening) => {
      clearTimeout(timer);
      if (opening) {
        body.style.height = 'auto';
        body.style.opacity = '';
      } else {
        details.open = false;
        details.classList.remove('is-closing');
        body.style.height = '';
        body.style.opacity = '';
      }
      animating = false;
    };
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      if (animating) return;
      if (reduced) { details.open = !details.open; return; }
      const opening = !details.open;
      targetOpen = opening;
      body.style.transition = '';
      if (opening) {
        details.open = true;
        body.style.height = '0px';
        body.style.opacity = '0';
        details.classList.remove('is-closing');
        void body.offsetHeight;
        animating = true;
        raf(() => { body.style.height = body.scrollHeight + 'px'; body.style.opacity = '1'; });
        timer = setTimeout(() => finish(targetOpen), 420);
      } else {
        body.style.height = body.scrollHeight + 'px';
        body.style.opacity = '1';
        details.classList.add('is-closing');
        void body.offsetHeight;
        animating = true;
        raf(() => { body.style.height = '0px'; body.style.opacity = '0'; });
        timer = setTimeout(() => finish(targetOpen), 420);
      }
    });
    body.addEventListener('transitionend', (event) => {
      if (event.target !== body || event.propertyName !== 'height' || !animating) return;
      finish(targetOpen);
    });
  });
}

async function renderAsrModels() {
    const box = $('#st-models');
    if (!box) return;
    let d;
    try {
      // 加超时: 服务端异常时请求可能一直不返回, 不能让界面永远停在「读取中…」
      const resp = await fetch('/api/asr/status', { signal: AbortSignal.timeout(15000) });
      d = filterStatusModels(await ensureHardware(await resp.json()));
      if (!resp.ok) throw new Error(d.error || ('HTTP ' + resp.status));
    } catch (e) {
      const why = String((e && e.message) || e);
      box.innerHTML = '<div class="st-row">读取失败：' + esc(why)
        + ' <button type="button" class="btn btn-mini" id="st-models-retry">重试</button></div>';
      const rb = document.getElementById('st-models-retry');
      if (rb) rb.addEventListener('click', () => renderAsrModels());
      return;
    }
    // 同一份状态顺便喂给设计稿新增的两块：入口卡（进度/胶囊）与运行时环境卡。
    // 放在这里而不是各请求一次，是为了避免重复打 /api/asr/status（它要探测 Python/NeMo，不便宜）。
    renderModelEntries(d);
    renderAccelCard(d);
    if (!studioUI) renderRuntimeEnv(d);
    latestAsrStatus = d;
    if (studioUI && !$('#sf-asr-families').dataset.bound) {
      $('#sf-asr-families').dataset.bound = '1';
      $('#sf-asr-families').querySelectorAll('[data-asr-family]').forEach(button => button.addEventListener('click', () => { showAsrFamily(button.dataset.asrFamily); $('#sf-asr-back').focus(); }));
      $('#sf-asr-back').addEventListener('click', () => { const family = selectedAsrFamily; showAsrFamily(''); $('#sf-asr-families').querySelector(`[data-asr-family="${family}"]`)?.focus(); });
    }
    const dlMap = {};                    // key → 下载状态(服务端并行下载, 每个 key 独立)
    (d.downloads || []).forEach(x => { dlMap[x.key] = x; });
    const dlOf = (key) => dlMap[key] || {};
    // 注: 下面各模型的下载状态提示都是就地手写的(见 pyState / state / nemoState 等),
    // 没有走统一模板 —— 各自要拼的按钮和文案差别太大, 抽象反而更绕。
    // Python 环境(Parakeet 需要; whisper.cpp 与 Vulkan 版 Parakeet/CrispASR 不需要): 预检状态 + 一键安装
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
    /* ⚠ Python 预检是后台异步跑的：首次查询 /api/asr/status 时 probe 往往还没结束，
     *   pythonProbe/pythonProbeFlat 都是 null，卡片就停在「检测中…」。而这个页面只在
     *   下载轮询/切页时重画，没有下载时永远不会自己刷新 —— 用户会以为卡死（实测截图）。
     *   所以这里盯一小会儿，出结果就重画一次；失败/超时也算出结果（ok:false）。 */
    if (!py && !pySt.running && !pythonPollTimer) {
      let tries = 0;
      const tick = async () => {
        if (++tries > 30 || !document.getElementById('st-models')) {
          pythonPollTimer = 0; return;
        }
        try {
          const r = await fetch('/api/asr/status', { signal: AbortSignal.timeout(8000) });
          const dd = await r.json();
          if (dd.pythonProbe || dd.pythonProbeFlat) {
            pythonPollTimer = 0;
            renderAsrModels();
            return;
          }
        } catch { /* 下一轮再试 */ }
        pythonPollTimer = setTimeout(tick, 1500);
      };
      pythonPollTimer = setTimeout(tick, 1500);
    }
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
      <div class="sm-desc">Parakeet NPU 识别要 Python 和 OpenVINO；说话人分离只要基础 Python，没有 N 卡也能用。CUDA/sherpa 版 Parakeet 与 whisper.cpp 已停用；Vulkan 版 Parakeet（CrispASR）和云端识别不需要 Python。点「下载」会装好 Python 和基础依赖。不写注册表，删掉 asr/runtime-python 目录就算卸载</div>
      ${pyState}
      <div class="sm-desc" style="margin-top:6px">当前解释器：<code>${esc(pyExe || '(未定)')}</code>
        <button type="button" class="btn btn-mini sm-pyset">指定其他 Python…</button>
        <button type="button" class="btn btn-mini sm-pyreset">用回默认</button>
      </div>
      <div class="sm-pymsg" style="font-size:12px;margin-top:4px"></div>
    </div>`;
    if (studioUI) {
      const pyStatus = pySt.running ? (pySt.msg || '安装中…') + ' ' + (pySt.pct || 0) + '%' : pySt.error ? (pySt.msg || '安装失败') : !py ? '检测中…' : py.ok ? (d.provider === 'cuda' ? '可用 · CUDA' : '可用 · 基础环境') : '未安装';
      const pyButton = pySt.running || !py ? '' : !py.ok ? '<button type="button" class="btn btn-mini sm-pyinstall">下载</button>' : '';
      /* ffmpeg 前置：波形、抽音频、视频压制都依赖它。
       * 找不到时给「下载」按钮，服务端会装到项目自带的 tools/ffmpeg/（不动系统 PATH）。 */
      const ff = d.ffmpeg || null;
      let ffState, ffBtn = '', ffDesc = '';
      if (ff) {
        const dl = ff.download || {};
        if (dl.running) {
          ffState = `<span class="sm-state running">下载中 ${dl.pct || 0}%${dl.message ? ' · ' + esc(dl.message) : ''}</span>`;
        } else if (dl.error) {
          ffState = `<span class="sm-state" style="color:var(--danger)">下载失败：${esc(dl.error)}</span>`;
          ffBtn = '<button type="button" class="btn btn-mini sm-ffinstall">重试</button>';
        } else if (ff.ok) {
          const src = { env: '环境变量', bundled: '程序自带', common: '常见路径', path: 'PATH' }[ff.ffmpeg.source] || ff.ffmpeg.source;
          ffState = `<span class="sm-state ok">✓ 可用 · ${esc(src)}</span>`;
        } else {
          ffState = '<span class="sm-state" style="color:var(--danger)">未安装</span>';
          if (ff.canAutoDownload) ffBtn = '<button type="button" class="btn btn-mini sm-ffinstall">下载</button>';
          ffDesc = '<div class="sm-desc" style="margin-top:6px">视频压制、波形与抽音频都用它。<b>下载后放在项目自带的 tools/ffmpeg/</b>，不改系统 PATH；若你已装过，也可以用环境变量 FFMPEG_PATH / FFPROBE_PATH 指定路径</div>';
        }
      } else {
        ffState = '<span class="sm-state">检测中…</span>';
      }
      const ffmpegCard = ff ? `<div class="sm-model sf-prerequisite"><div class="sm-head"><span class="sm-name">ffmpeg</span>${ffState}${ffBtn}</div>${ffDesc}</div>` : '';
      rows = ffmpegCard + `<div class="sm-model sf-prerequisite"><div class="sm-head"><span class="sm-name">Python</span><span class="sm-state${py?.ok ? ' ok' : ''}">${esc(pyStatus)}</span>${pyButton}</div><details class="sf-settings-details sf-details-anim"${GROUP_OPEN.get('python-options') ? ' open' : ''}><summary>Python 路径设置</summary><div class="sf-details-body"><code>${esc(pyExe || '(未定)')}</code><div class="sf-prerequisite-actions"><button type="button" class="btn btn-mini sm-pyset">指定其他 Python…</button><button type="button" class="btn btn-mini sm-pyreset">用回默认</button></div><div class="sm-pymsg" role="status"></div></div></details></div>`;
    }
    // 各任务 key: model:<id> / runtime / runtime:crispasr / diarize（运行时按 runtimeKey 取，服务端给）
    /* ── 按系列分组（设计稿 ②「可折叠 + 硬件感知」）──
     * 每个系列一个可折叠块：标题行给「系列名 · N 个模型 · M 就绪」，点标题折叠/展开。
     * ⚠ 折叠状态记在 GROUP_OPEN 里（模块级 Map，按系列名），因为 renderAsrModels() 会
     *   整个重建 innerHTML —— 不记住的话每次重画（下载进度轮询 1 秒一次！）折叠状态都会被重置。 */
    const groups = new Map();                     // 系列名 → { rows: [], ready: 0 }
    for (const m of (d.models || [])) {
      const fam = studioUI && m.engine === 'nemo' ? 'Parakeet 系列' : MODEL_FAMILY(m);
      if (!groups.has(fam)) groups.set(fam, { rows: [], extra: [], ready: 0 });
      const g = groups.get(fam);
      if (m.ready) g.ready++;
      if (studioUI && ['nemo', 'dual'].includes(m.engine)) g.extra.push(modelRowHtml(m, d, dlOf));
      else g.rows.push(modelRowHtml(m, d, dlOf));
    }
    for (const [fam, g] of groups) {
      const open = GROUP_OPEN.get(fam) !== false;              // 默认展开
      if (studioUI) { rows += `<section class="sf-asr-model" data-family="${esc(fam)}">${g.rows.join('')}${g.extra.length ? `<details class="sf-settings-details"${GROUP_OPEN.get('extra:' + fam) ? ' open' : ''}><summary>其他识别模式 · ${g.extra.length}</summary>${g.extra.join('')}</details>` : ''}</section>`; continue; }
      rows += `<div class="sm-group" data-family="${esc(fam)}">
        <button type="button" class="sm-group-head" data-family="${esc(fam)}" aria-expanded="${open}">
          <span class="sm-caret${open ? ' open' : ''}" data-ico="chevronDown"></span>
          <span class="sm-group-name">${esc(fam)}</span>
          <span class="sm-group-count">${g.rows.length} 个模型</span>
          <span class="sm-group-ready${g.ready ? '' : ' none'}">${g.ready ? g.ready + ' 就绪' : '未就绪'}</span>
        </button>
        <div class="sm-group-body"${open ? '' : ' hidden'}>${g.rows.join('')}</div>
      </div>`;
    }
    // 对齐模型单独一个系列：不混在 Qwen ASR 的标题/描述里。
    const aligners = d.aligners || [];
    if (studioUI && aligners.length) {
      rows += `<section class="sf-asr-model sf-aligner-section" data-family="对齐模型">${aligners.map(a => alignerRowHtml(a, dlOf)).join('')}</section>`;
    }
    /* 旧版本下错后端、或先下载后取消勾选的模型：不混进正常列表，收进「其它模型」。
     * 只有文件和运行时都不再被选中时才来这里；删除按钮复用 .sm-del 的确认链路。 */
    const extras = d.extraModels || [];
    if (extras.length) {
      const extraRows = extras.map(m => extraModelRowHtml(m, d, dlOf)).join('');
      if (studioUI) {
        rows += `<section class="sf-asr-model" data-family="其它模型">${extraRows}</section>`;
      } else {
        const open = GROUP_OPEN.get('其它模型') !== false;
        rows += `<div class="sm-group" data-family="其它模型">
          <button type="button" class="sm-group-head" data-family="其它模型" aria-expanded="${open}">
            <span class="sm-caret${open ? ' open' : ''}" data-ico="chevronDown"></span>
            <span class="sm-group-name">其它模型</span>
            <span class="sm-group-count">${extras.length} 个模型</span>
            <span class="sm-group-ready">已下载</span>
          </button>
          <div class="sm-group-body"${open ? '' : ' hidden'}>${extraRows}</div>
        </div>`;
      }
    }
    // 说话人分离模型(两个文件一组, ~32MB): 初稿勾选「区分说话人」时需要
    const dz = d.diarize || {};
    const dzSt = dlOf('diarize');
    const dzBtn = dzSt.running ? '' : (dz.ready
      ? '<button type="button" class="btn btn-mini sm-del" data-id="diarize" title="删除分离模型文件">删除</button>'
      : '<button type="button" class="btn btn-mini sm-dl" data-id="diarize">下载</button>');
    const dzState = dzSt.running ? `<span class="sm-state running">${esc(dzSt.msg || '下载中…')} ${dzSt.pct || 0}%</span>`
      : (dzSt.error ? `<span class="sm-state" style="color:var(--danger)">${esc(dzSt.msg || dzSt.error)}</span>`
      : (dz.ready ? '<span class="sm-state ok">✓ 已就绪</span>' : '<span class="sm-state">未下载 · 32 MB</span>'));
    /* 停用：NeMo 运行时入口（Multitalker Parakeet 已从模型列表移除）。
     * 保留整段实现以便随时恢复；常量条件是有意为之，故对本行关掉规则。 */
    // eslint-disable-next-line no-constant-condition
    if (false) {
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
    rows += studioUI ? `<div class="sm-model sf-prerequisite"><div class="sm-head"><span class="sm-name">NeMo</span><span class="sm-state${nemo.ok && nemo.cuda ? ' ok' : ''}">${esc(nemoSt.running ? (nemoSt.msg || '安装中…') + ' ' + (nemoSt.pct || 0) + '%' : nemoSt.error ? (nemoSt.msg || '安装失败') : nemoPending ? '检测中…' : nemo.ok && nemo.cuda ? '可用 · CUDA' : nemo.ok ? '需要 CUDA 版' : '未安装 · 约 5 GB')}</span>${nemoBtn.replace('>安装<', '>下载<')}</div></div>` : `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">NeMo 运行时（多说话人）</span>${nemoBtn}</div>
      <div class="sm-desc">「Multitalker Parakeet Streaming 0.6B v1」专用：PyTorch + NeMo（约 5GB）。与上面的 Python 环境是两套依赖，装在本项目的 Python 环境里；<b>只有 N 卡可用</b>（该模型不支持 CPU 推理）。装完会自动实测「加载 + CUDA」才算成功</div>
      ${nemoState}
    </div>`;
    }
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
      <select class="btn" id="st-rerecog-sel" aria-label="重新识别模型">${rrOpts}</select>
    </div>`;
    rows += studioUI ? `<div class="sm-model sf-prerequisite"><div class="sm-head"><span class="sm-name">说话人分离</span>${dzState}${dzBtn}</div></div>` : `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">说话人分离</span>${dzBtn}</div>
      <div class="sm-desc">说话人分段 + 说话人嵌入（约 32MB）。初稿勾选「区分说话人」时需要</div>
      ${dzState}
    </div>`;
    box.innerHTML = rows || '<div class="st-row">无可用模型</div>';
    const rrSel = box.querySelector('#st-rerecog-sel');
    if (studioUI) {
      // 顶层设置保持真实 select/change 链路，不再混入前置依赖。
      const rrCard = rrSel.closest('.sm-model');
      rrCard.className = 'sf-rerecog-card';
      rrCard.querySelector('.sm-desc').textContent = '选区重新识别默认沿用稿件模型，也可在此指定。';
      $('#sf-asr-rerecog-mount').replaceChildren(rrCard);
      box.querySelector('.sf-prerequisite details')?.addEventListener('toggle', e => GROUP_OPEN.set('python-options', e.target.open));
      [...box.children].filter(row => !row.classList.contains('sf-asr-model')).forEach(row => row.classList.add('sf-asr-setup'));
      for (const button of $('#sf-asr-families').querySelectorAll('[data-asr-family]')) {
        const family = button.dataset.asrFamily;
        if (family === '其它模型') {
          const n = (d.extraModels || []).length;
          const count = button.querySelector('.sf-asr-count');
          if (count) count.textContent = n ? `${n} 个已下载 · 当前未启用` : '';
          button.hidden = n === 0;
          continue;
        }
        const models = (d.models || []).filter(model => (model.engine === 'nemo' ? 'Parakeet 系列' : MODEL_FAMILY(model)) === family);
        const count = button.querySelector('.sf-asr-count');
        if (family === '对齐模型') {
          const list = d.aligners || [];
          const readyN = list.filter(a => a.ready).length;
          const waiting = list.some(a => a.filesOk && !a.ready);
          if (count) count.textContent = `${list.length} 个对齐器 · ${readyN} 就绪`
            + (waiting ? ' · 有已下载但缺运行时' : '');
          button.hidden = list.length === 0;
          continue;
        }
        if (count && family !== '前置') count.textContent = `${models.length} 个模型 · ${models.filter(model => model.ready || model.cloud).length} 就绪`;
        // 当前加速方式下整个系列都没有模型 → 隐藏入口，避免点进去空白
        if (family !== '前置') button.hidden = models.length === 0;
      }
      if (selectedAsrFamily) {
        const cur = $('#sf-asr-families').querySelector(`[data-asr-family="${selectedAsrFamily}"]`);
        if (!cur || cur.hidden) showAsrFamily('');
      }
      box.querySelectorAll('.sf-asr-model details').forEach(details => details.addEventListener('toggle', () => GROUP_OPEN.set('extra:' + details.closest('.sf-asr-model').dataset.family, details.open)));
      showAsrFamily(selectedAsrFamily);
    }
    // 分组标题里的折叠箭头是 data-ico 声明的，图标注入只作用于 applyIcons() 跑过的节点 ——
    // 这段 HTML 是刚拼出来的，得自己补一次（否则箭头位置是空的）。
    if (window.__applyIcons) window.__applyIcons(box);
    enhanceDetailsAnimations(box);
    /* 折叠/展开：**事件委托**绑在 box 上（不给每个标题单独绑）。
     * 为什么必须委托：renderAsrModels() 在下载进度轮询时可能每秒重画一次，
     * 逐个绑会在重画后全部失效。 */
    if (!box.dataset.groupBound) {
      box.dataset.groupBound = '1';
      box.addEventListener('click', (e) => {
        const head = e.target.closest && e.target.closest('.sm-group-head');
        if (!head) return;
        const fam = head.dataset.family || '';
        const open = !(GROUP_OPEN.get(fam) !== false);      // 取反当前状态
        GROUP_OPEN.set(fam, open);
        const body = head.nextElementSibling;
        if (body) body.hidden = !open;
        head.setAttribute('aria-expanded', String(open));
        const caret = head.querySelector('.sm-caret');
        if (caret) caret.classList.toggle('open', open);
      });
    }
    renderHardwareBar(d);
    box.querySelectorAll('.sm-ffinstall').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '开始…';
      try {
        const r = await (await fetch('/api/asr/ffmpeg/download', { method: 'POST' })).json();
        const msgEl = $('#st-msg');
        if (r.error) { msgEl.textContent = '✗ ' + r.error; msgEl.classList.add('err'); }
        else {
          msgEl.textContent = '正在下载 ffmpeg（约 30MB），装到项目自带的 tools/ffmpeg/；进度见上方';
          msgEl.classList.remove('err');
          pollModelDownload();
        }
      } catch (e) {
        const msgEl = $('#st-msg'); msgEl.textContent = '✗ 下载启动失败: ' + String((e && e.message) || e); msgEl.classList.add('err');
      }
      // 轮询靠 renderAsrModels 的既有循环（它每秒重画一次，会读到新的 ffmpeg.download 状态）
      renderAsrModels();
    }));
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
    box.querySelectorAll('.sf-runtime-download').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/asr/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: button.dataset.runtime }) });
        const data = await response.json(); if (!response.ok || data.error) throw Error(data.error || '运行时下载失败');
        pollModelDownload();
      } catch (error) { toast(error.message, 4500); button.disabled = false; }
    }));
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
          const response = await fetch('/api/asr/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: b.dataset.id })
          });
          const result = await response.json();
          if (!response.ok) toast(result.error || t('删除模型失败'), 4500);
          else if (!result.deleted) toast(t('已解除模型关联；原目录及用户文件保留'), 4500);
          renderAsrModels();
        });
    }));
    // 引擎运行时(whisper.cpp / CrispASR): 需要 ggml 模型但运行时缺失时自动开始下载(与其它下载并行, 不互斥)。
    // 运行时可能有多个 —— 按服务端给的 runtimeKey 逐个补（各自独立下载任务, 互不阻塞）。
    const note = $('#st-model-note');
    const rtKeys = [...new Set((d.models || []).filter(m => m.needRuntime).map(m => m.runtimeKey || 'runtime'))];
    let rtStarted = false;
    for (const key of studioUI ? [] : rtKeys) {
      if (dlOf(key).running) continue;                       // 已在下载: 交给既有轮询
      const r = await (await fetch('/api/asr/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: key })
      })).json().catch(() => ({}));
      if (r.started) {
        const mm = (d.models || []).find(x => (x.runtimeKey || 'runtime') === key);
        note.textContent = '正在下载 ' + ((mm && mm.runtimeName) || key) + ' 运行时…';
        rtStarted = true;
      }
    }
    if (rtStarted) pollModelDownload();
    else if (note && !rtKeys.length) note.textContent = '';
  }
  // 下载轮询闸门: 多个下载/安装入口都会调用 pollModelDownload, 不加闸门会叠加多个
  // 900 次循环、每秒重复 renderAsrModels。同一时刻只允许一个轮询在跑。
  let _modelPolling = false;
  async function pollModelDownload() {
    if (_modelPolling) return;
    _modelPolling = true;
    try {
      for (let i = 0; i < 900; i++) {
        let d;
        try { d = await (await fetch('/api/asr/status')).json(); } catch { break; }
        const anyRunning = (d.downloads || []).some(x => x.running)
          || !!(d.ffmpeg && d.ffmpeg.download && d.ffmpeg.download.running);
        renderAsrModels();
        if (!anyRunning) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    } finally { _modelPolling = false; }
  }
  async function downloadModel(id) {
    // 点下载立刻有反馈(按钮变「排队…」), 再发请求 —— 旧版静默发请求, 服务端忙时用户以为没点上
    const body = id === 'diarize' ? { kind: 'diarize' } : { modelId: id };
    const btn = document.querySelector('.sm-dl[data-id="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '开始…'; }
    try {
      const r = await fetch('/api/asr/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const m = await r.json().catch(() => ({}));
      if (!r.ok && m.error) { toast(m.error, 5000); if (btn) { btn.disabled = false; btn.textContent = '下载'; } return; }
      pollModelDownload();
    } catch (e) {
      // fetch reject(服务中断): 恢复按钮以便重试, 并提示失败原因(成功路径不在此处理)
      if (btn) { btn.disabled = false; btn.textContent = '下载'; }
      toast('下载失败：' + (e && e.message ? e.message : e));
    }
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
      try {
        const r = await fetch('/api/asr/open-dir', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'models' })
        });
        const m = await r.json().catch(() => ({}));
        if (!r.ok) toast(m.error || '打开目录失败', 4200);
      } catch (e) {
        toast('打开目录失败：' + e.message, 4200);
      }
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

  /* 模型设置页的两个入口卡（设计稿 ①）：
   *   ASR 卡的"管理"就在本面板里（模型管理卡片紧随其后），所以点击只把内容滚到模型列表；
   *   LLM 卡的设置就是二级 Tab 的「LLM 语言模型」子视图。 */
  const entryAsr = document.getElementById('st-entry-asr');
  if (entryAsr) entryAsr.addEventListener('click', () => { showSubView('asr'); });
  const entryLlm = document.getElementById('st-entry-llm');
  if (entryLlm) entryLlm.addEventListener('click', () => { showSubView('llm'); });

  /* ── 二级 Tab（设计稿 ②：ASR 识别模型 / LLM 语言模型）── */
  function showSubView(name) {
    document.querySelectorAll('.st-subtab').forEach(t => {
      const on = t.dataset.stsub === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.st-subview').forEach(v => { v.hidden = v.dataset.stsub !== name; });
    // LLM 子视图里的方案列表要按最新的 stPresets 重画（首次进入时 stPresets 可能已就绪）
    if (name === 'llm') renderSchemes();
  }
  document.querySelectorAll('.st-subtab').forEach(t => {
    t.addEventListener('click', () => showSubView(t.dataset.stsub));
  });

  /* ── LLM 翻译方案（设计稿 ③）──
   * ── 与后端的关系：/api/translate/config 只有**一套** cfg + 一份 presets（服务商预置表）。
   *    所以这里列出的是"服务商方案"：点某行的「设置」= 把表单切到该服务商并打开滑入面板，
   *    保存走原路（POST /api/translate/config）→ 即"当前使用的那一套"。
   *    「新建方案」= 清空表单、指向第一个未配置的服务商，让用户填新的一套。
   *    以上为旧 UI 的兼容路径；Studio 使用下方命名方案及 /api/translate/schemes。 */
  const schemeEls = {
    list: document.getElementById('st-scheme-list'),
    picks: document.getElementById('st-scheme-picks'),
    drawer: document.getElementById('st-scheme-drawer'),
    drawerPicks: document.getElementById('st-drawer-picks'),
    drawerTitle: document.getElementById('st-scheme-title'),
    drawerCur: document.getElementById('st-scheme-cur'),
  };

  // Studio 使用独立命名方案；旧入口继续使用原来的单套配置。
  let savedSchemes = [], activeSchemeId = '', editingSchemeId = '', schemeKeyClear = false;
  let schemeSaving = false, defaultSchemePrompt = '';
  function acceptSchemes(data) {
    savedSchemes = data.schemes || []; activeSchemeId = data.activeSchemeId || '';
  }
  function schemeForm() {
    const payload = {
      name: $('#st-scheme-name').value.trim(), provider: $('#st-provider').value,
      baseUrl: $('#st-baseurl').value.trim(), model: $('#st-model').value.trim(),
      prompt: $('#st-prompt').value, glossary: glSerialize(), glossaryLang: glState.lang,
      batchSize: Number($('#st-batch').value), temperature: Number($('#st-temp').value),
      contextRows: Number($('#st-ctx').value), activate: $('#st-scheme-activate').checked,
      autoTranslate: $('#st-scheme-auto').checked,
    };
    if ($('#st-key').value.trim()) payload.apiKey = $('#st-key').value.trim();
    if (schemeKeyClear) payload.apiKeyClear = true;
    return payload;
  }
  async function schemeRequest(url, method, payload) {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(url.endsWith('/test') ? 90000 : 12000) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '操作失败');
    return data;
  }
  function renderSavedSchemes() {
    const list = schemeEls.list, drawer = schemeEls.drawer;
    if (!list) return;
    /* 删除/替换后编辑态不能再指向不存在的方案；强制关闭残留抽屉。 */
    if (editingSchemeId && !savedSchemes.some(item => item.id === editingSchemeId)) {
      schemeSaving = false;
      closeDrawer();
    }
    list.hidden = !savedSchemes.length && !drawer.hidden && !drawer.inert;
    if (drawer?.parentElement === list) list.after(drawer);
    list.innerHTML = savedSchemes.length ? savedSchemes.map(item => `<div class="st-scheme${item.id === activeSchemeId ? ' cur' : ''}" data-scheme="${esc(item.id)}">
      <button type="button" class="sf-scheme-open" data-id="${esc(item.id)}" aria-expanded="${!drawer.hidden && editingSchemeId === item.id}" aria-controls="st-scheme-drawer">
        <span class="st-scheme-name">${esc(item.name)}${item.id === activeSchemeId ? '<span class="st-tag-cur">当前使用</span>' : ''}</span>
        <span class="st-scheme-desc">${esc((stPresets.find(p => p.id === item.provider)?.name || item.provider) + ' · ' + item.model)}</span>
      </button>
      <button type="button" class="btn btn-mini sf-scheme-use" data-id="${esc(item.id)}"${item.id === activeSchemeId ? ' disabled' : ''}>使用</button>
      <button type="button" class="btn btn-mini sf-scheme-delete" data-id="${esc(item.id)}">删除</button>
    </div>`).join('') : '<div class="sf-scheme-empty">还没有保存的方案</div>';
    list.querySelectorAll('.sf-scheme-open').forEach(button => button.addEventListener('click', () => {
      if (schemeSaving) return;
      if (!drawer.hidden && editingSchemeId === button.dataset.id) { closeDrawer(); return; }
      editSavedScheme(savedSchemes.find(item => item.id === button.dataset.id));
    }));
    list.querySelectorAll('.sf-scheme-use').forEach(button => button.addEventListener('click', async () => {
      if (schemeSaving) return; schemeSaving = true; button.disabled = true;
      try {
        acceptSchemes(await schemeRequest('/api/translate/schemes/' + button.dataset.id + '/activate', 'POST', {}));
        /* closeDrawer() 会因 schemeSaving 直接 return；成功后先解锁，再关闭/重绘。 */
        schemeSaving = false;
        closeDrawer(); renderSavedSchemes(); toast('已切换翻译方案', 2400);
      } catch (error) { $('#st-msg').textContent = error.message; }
      finally { schemeSaving = false; button.disabled = false; }
    }));
    list.querySelectorAll('.sf-scheme-delete').forEach(button => button.addEventListener('click', () => {
      if (schemeSaving) return;
      const item = savedSchemes.find(item => item.id === button.dataset.id);
      if (!item) return;
      panel.showConfirm('删除翻译方案', '删除方案“' + item.name + '”？', '删除', '取消', async () => {
        schemeSaving = true; button.disabled = true;
        try {
          acceptSchemes(await schemeRequest('/api/translate/schemes/' + item.id, 'DELETE'));
          /* 同上：删除成功后必须解锁，否则抽屉会停在已删除的方案上。 */
          schemeSaving = false;
          if (editingSchemeId === item.id) closeDrawer();
          renderSavedSchemes(); toast('方案已删除', 2400);
        } catch (error) { $('#st-msg').textContent = error.message; }
        finally { schemeSaving = false; button.disabled = false; }
      });
    }));
    if (editingSchemeId && !drawer.hidden) {
      const card = [...list.querySelectorAll('[data-scheme]')].find(card => card.dataset.scheme === editingSchemeId);
      if (card) card.after(drawer);
    }
  }
  function editSavedScheme(item) {
    editingSchemeId = item?.id || ''; schemeKeyClear = false;
    $('#st-scheme-name').value = item?.name || '';
    $('#st-provider').value = item?.provider || '';
    $('#st-baseurl').value = item?.baseUrl || ''; $('#st-model').value = item?.model || '';
    $('#st-key').value = ''; $('#st-key').type = 'password'; $('#st-key-eye').textContent = '显示';
    $('#st-key').placeholder = item?.hasKey ? '已保存（留空不修改）' : 'sk-…'; refreshKeyHint(item);
    $('#st-temp').value = item?.temperature ?? 0.3; $('#st-ctx').value = item?.contextRows ?? 0;
    $('#st-batch').value = item?.batchSize ?? 25; $('#st-prompt').value = item?.prompt || defaultSchemePrompt;
    $('#st-scheme-activate').checked = !item || item.id === activeSchemeId;
    $('#st-scheme-auto').checked = item?.autoTranslate !== false;
    $('#st-drawer-msg').textContent = ''; $('#st-msg').textContent = '';
    glLoad(item?.glossary || '', item?.glossaryLang || '简体');
    schemeEls.list.after(schemeEls.drawer);
    openDrawer(item?.name || '添加方案', item?.id === activeSchemeId);
    renderSavedSchemes(); $('#st-scheme-name').focus();
  }
  async function saveNamedScheme() {
    if (schemeSaving) return;
    const payload = schemeForm(), message = $('#st-drawer-msg');
    if (!payload.name) {
      const nameInput = $('#st-scheme-name');
      nameInput.classList.add('is-invalid');
      nameInput.setAttribute('aria-invalid', 'true');
      const nameError = $('#st-scheme-name-error');
      if (nameError) nameError.textContent = '名称不能为空。';
      message.textContent = '请填写方案名称';
      nameInput.focus();
      return;
    }
    if (!payload.provider) { message.textContent = '请选择服务商'; $('#st-provider').focus(); return; }
    schemeSaving = true; drawerSave.disabled = true;
    try {
      const data = await schemeRequest('/api/translate/schemes' + (editingSchemeId ? '/' + editingSchemeId : ''), editingSchemeId ? 'PUT' : 'POST', payload);
      acceptSchemes(data); schemeSaving = false; closeDrawer(); renderSavedSchemes(); toast('方案已保存', 2400);
    } catch (error) { message.textContent = error.message; }
    finally { schemeSaving = false; drawerSave.disabled = false; }
  }
  async function testNamedScheme() {
    if (schemeSaving) return;
    schemeSaving = true; drawerTest.disabled = true;
    $('#st-drawer-msg').textContent = '正在测试连接…';
    try {
      const data = await schemeRequest('/api/translate/schemes/test', 'POST', { ...schemeForm(), id: editingSchemeId });
      $('#st-drawer-msg').textContent = data.ok ? '连接成功' : data.error || '连接失败';
    } catch (error) { $('#st-drawer-msg').textContent = error.message; }
    finally { schemeSaving = false; drawerTest.disabled = false; }
  }

  /** 方案是否"已配置"：当前 provider 且已有 Key，或本地地址（本地模型不需要 Key） */
  function schemeConfigured(p) {
    const cur = $('#st-provider') ? $('#st-provider').value : '';
    const hasKey = $('#st-key') && $('#st-key').placeholder && /已保存/.test($('#st-key').placeholder);
    const local = /127\.0\.0\.1|localhost/.test(p.baseUrl || '');
    return p.id === cur && (hasKey || local);
  }

  function renderSchemes() {
    if (studioUI) { renderSavedSchemes(); return; }
    if (!schemeEls.list) return;
    const cur = $('#st-provider') ? $('#st-provider').value : '';
    const keySaved = $('#st-key') && $('#st-key').placeholder && /已保存/.test($('#st-key').placeholder);
    // 服务选择胶囊：两个地方共用同一套（列表上方 + 滑入面板里）
    const picksHtml = stPresets.map(p =>
      `<button type="button" class="st-pick${p.id === cur ? ' on' : ''}" data-provider="${esc(p.id)}">${esc(p.name)}</button>`).join('');
    if (schemeEls.picks) schemeEls.picks.innerHTML = picksHtml;
    if (schemeEls.drawerPicks) schemeEls.drawerPicks.innerHTML = picksHtml;
    for (const box of [schemeEls.picks, schemeEls.drawerPicks]) {
      if (!box) continue;
      box.querySelectorAll('.st-pick').forEach(b => b.addEventListener('click', () => {
        const p = stPresets.find(x => x.id === b.dataset.provider);
        if (!p) return;
        // 与旧的 select 联动：改 select 的值会触发它自己的 change（那里会填 baseUrl/model）
        const sel = $('#st-provider');
        if (sel) { sel.value = p.id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        else { if ($('#st-baseurl')) $('#st-baseurl').value = p.baseUrl || ''; if ($('#st-model')) $('#st-model').value = p.model || ''; }
        openDrawer(p.name, p.id === cur);
        renderSchemes();
      }));
    }
    // 方案列表
    schemeEls.list.innerHTML = stPresets.map(p => {
      const isCur = p.id === cur;
      const conf = isCur && (keySaved || /127\.0\.0\.1|localhost/.test(p.baseUrl || ''));
      const dot = conf ? 'ok' : (isCur ? 'warn' : '');
      const local = /127\.0\.0\.1|localhost/.test(p.baseUrl || '');
      const bits = [p.model || '', local ? '本地地址' : '', isCur && keySaved ? '已保存 Key' : ''].filter(Boolean);
      return `<div class="st-scheme${isCur ? ' cur' : ''}${conf ? '' : ' off'}" data-provider="${esc(p.id)}">
        <i class="st-scheme-dot ${dot}"></i>
        <div class="st-scheme-main">
          <div class="st-scheme-name">${esc(p.name)}${isCur ? '<span class="st-tag-cur">当前使用</span>' : ''}</div>
          <p class="st-scheme-desc">${esc(bits.join(' · ') || p.baseUrl || '未配置')}</p>
        </div>
        <button type="button" class="btn btn-mini st-scheme-set" data-provider="${esc(p.id)}">设置</button>
      </div>`;
    }).join('');
    schemeEls.list.querySelectorAll('.st-scheme-set').forEach(b => b.addEventListener('click', () => {
      const p = stPresets.find(x => x.id === b.dataset.provider);
      if (!p) return;
      const sel = $('#st-provider');
      if (sel) { sel.value = p.id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      openDrawer(p.name, p.id === cur);
      renderSchemes();
    }));
  }

  let drawerGeneration = 0;
  function openDrawer(title, isCur) {
    const generation = ++drawerGeneration;
    if (!schemeEls.drawer) return;
    if (schemeEls.drawerTitle) schemeEls.drawerTitle.textContent = title || '翻译方案';
    if (schemeEls.drawerCur) schemeEls.drawerCur.hidden = !isCur;
    if (studioUI) schemeEls.drawer.inert = false;
    schemeEls.drawer.hidden = false;
    schemeEls.drawer.setAttribute('aria-hidden', 'false');
    // 下一帧再加 .open，让 transition 真的跑起来（同一帧加会直接跳到终态）
    requestAnimationFrame(() => { if (generation === drawerGeneration && schemeEls.drawer) schemeEls.drawer.classList.add('open'); });
  }
  function closeDrawer() {
    if (!schemeEls.drawer || studioUI && schemeSaving) return;
    ++drawerGeneration;
    if (studioUI) {
      editingSchemeId = ''; schemeEls.list.hidden = false;
      schemeEls.drawer.inert = true; $('#st-key').value = ''; $('#st-key').type = 'password';
      schemeEls.list.querySelectorAll('.sf-scheme-open').forEach(button => button.setAttribute('aria-expanded', 'false'));
      if (schemeEls.drawer.contains(document.activeElement)) $('#st-scheme-new').focus();
    }
    schemeEls.drawer.classList.remove('open');
    schemeEls.drawer.setAttribute('aria-hidden', 'true');
    // 等动画结束再 hidden，否则"滑出"看不见
    const closedGeneration = drawerGeneration;
    setTimeout(() => { if (closedGeneration === drawerGeneration && schemeEls.drawer && !schemeEls.drawer.classList.contains('open')) schemeEls.drawer.hidden = true; }, 320);
  }
  const drawerClose = document.getElementById('st-scheme-close');
  if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
  const drawerCancel = document.getElementById('st-drawer-cancel');
  if (drawerCancel) drawerCancel.addEventListener('click', closeDrawer);
  const drawerSave = document.getElementById('st-drawer-save');
  if (drawerSave) drawerSave.addEventListener('click', () => {
    if (studioUI) return saveNamedScheme();
    const sb = document.getElementById('st-save');       // 复用既有的"保存设置"链路，不另写一份保存
    if (sb) sb.click();
    closeDrawer();
  });
  const schemeNew = document.getElementById('st-scheme-new');
  if (schemeNew) schemeNew.addEventListener('click', () => {
    if (studioUI) { if (!schemeSaving) editSavedScheme(null); return; }
    // 找一个还没配的服务商作为起点（都没有就退回第一个）
    const cur = $('#st-provider') ? $('#st-provider').value : '';
    const target = stPresets.find(p => p.id !== cur) || stPresets[0];
    if (!target) return;
    const sel = $('#st-provider');
    if (sel) { sel.value = target.id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    if ($('#st-key')) $('#st-key').value = '';
    openDrawer(target.name, false);
    renderSchemes();
  });
  const drawerTest = document.getElementById('st-scheme-test');
  if (drawerTest) drawerTest.addEventListener('click', () => {
    if (studioUI) return testNamedScheme();
    const tb = document.getElementById('st-test');       // 复用既有的"测试连接"
    if (tb) tb.click();
  });
  const drawerReset = document.getElementById('st-scheme-reset');
  if (drawerReset) drawerReset.addEventListener('click', () => {
    const cur = $('#st-provider') ? $('#st-provider').value : '';
    const p = stPresets.find(x => x.id === cur);
    if (!p) return;
    if ($('#st-baseurl')) $('#st-baseurl').value = p.baseUrl || '';
    if ($('#st-model')) $('#st-model').value = p.model || '';
    if ($('#st-key')) $('#st-key').value = '';
    const msg = document.getElementById('st-drawer-msg');
    if (msg) msg.textContent = '已恢复该服务商的默认接口地址与模型名（Key 未改动）';
  });
  const keyEye = document.getElementById('st-key-eye');
  if (keyEye) keyEye.addEventListener('click', () => {
    const k = $('#st-key');
    if (!k) return;
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    keyEye.textContent = show ? '隐藏' : '显示';
  });
  if (window.__applyIcons) window.__applyIcons(document.getElementById('st-view') || document);

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
  $('#st-cancel').addEventListener('click', returnFromSettings);

  $('#st-provider').addEventListener('change', () => {
    const p = stPresets.find(x => x.id === $('#st-provider').value);
    if (p) { $('#st-baseurl').value = p.baseUrl || ''; $('#st-model').value = p.model || ''; }
    if (studioUI) { schemeKeyClear = true; $('#st-key').value = ''; $('#st-key').placeholder = 'sk-…'; refreshKeyHint(null); }
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
      if (!l) continue;
      const sec = /^##\s*(.+)$/.exec(l);
      if (sec) {
        const name = sec[1].trim();
        cur = GL_LANGS.includes(name) ? name : (GL_LANGS.find(x => x.toLowerCase() === name.toLowerCase()) || '简体');
        continue;
      }
      if (l.startsWith('#')) continue;
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
      // 采样温度 / 上下文行数（设计稿 ③ 的两项，服务端同样会夹范围；解析失败时用默认值）
      temperature: Number.isFinite(parseFloat(($('#st-temp') || {}).value)) ? parseFloat($('#st-temp').value) : 0.3,
      contextRows: parseInt(($('#st-ctx') || {}).value, 10) || 0,
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
    if (studioUI) {
      const response = await fetch('/api/asr/hint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: collectHotwords(), hotwordsScore: parseFloat($('#ah-score').value) || 3 }) });
      if (!response.ok) throw Error('热词保存失败');
      return { ready: true };
    }
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
    const msgEl = $('#st-msg'), btn = $('#st-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const m = await postSettings();
      /* Studio 的保存只写热词与强度；旧入口仍会写翻译配置。 */
      msgEl.textContent = studioUI ? '✓ 已保存' : (m.ready ? '✓ 已保存，翻译可用' : '已保存，但接口地址、API Key、模型名没填全，暂时不能翻译');
      msgEl.classList.remove('err');
      /* 保存后留在设置页；返回由侧边栏负责，不再重复一个“保存并返回”。 */
    } catch (e) {
      msgEl.textContent = '✗ ' + e.message;
      msgEl.classList.add('err');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });
  /* 「清除已存 Key」: 立即生效(独立于普通保存), 避免"留空=不修改"之后没有办法删 Key */
  const stKeyClearLink = $('#st-key-clear');
  if (stKeyClearLink) stKeyClearLink.addEventListener('click', async (e) => {
    e.preventDefault();
    if (studioUI) { schemeKeyClear = true; $('#st-key').value = ''; $('#st-key').placeholder = 'sk-…'; refreshKeyHint(null); $('#st-drawer-msg').textContent = '保存方案后清除 Key'; return; }
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
    savePlaybackPosition();
    pendingPlayback = null;
    ++_openGen;
    clearTimeout(saveTimer);
    clearInterval(pollTimer); pollTimer = 0;
    state.project = null;
    /* 离开项目时把仍在跑的重校对/说话人分离停掉。以前只断轮询，服务端 worker
     * 会继续占 GPU（用户实测退出/切走后还有 Python 在跑）。 */
    if (typeof window.__realignReset === 'function') window.__realignReset();
    window.__sfCurrentProjectId = null;   // 脱离项目后「导出视频」没有可导出的对象
    pendingText = null; saveRevision = ''; saveConflict = false;
    if (typeof window.__notesReload === 'function') window.__notesReload();
    if (typeof window.__projectAsyncReset === 'function') window.__projectAsyncReset();
    setPlaybackAudioMode(null, false);          // 脱离项目: 播放恢复视频原声
    const el = $('#save-state');
    if (el) el.hidden = true;
  }

  /* ─────────── 新建项目页面 ─────────── */
  const npView = $('#np-view');
  let npSubmitting = false;
  let npSchemesLoaded = false, npSchemeBusy = false;
  let npProviders = new Map();
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
  // 新建页的实时处理进度（创建初稿后在本页轮询；见 startNpDraftProgress）
  let npDraftId = '', npDraftTimer = 0, npDraftDone = false, npDraftFailed = false, npDraftErrors = 0;
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

  function npApplyLayout(mode) {
    npMode = mode;
    npView.classList.toggle('is-draft', mode === 'draft');
    $('#np-mode-import').classList.toggle('active', mode === 'import');
    $('#np-mode-import').setAttribute('aria-pressed', String(mode === 'import'));
    $('#np-mode-draft').classList.toggle('active', mode === 'draft');
    $('#np-mode-draft').setAttribute('aria-pressed', String(mode === 'draft'));
  }

  function npFieldPlan(mode) {
    const draft = mode === 'draft';
    const word = $('#np-word');
    const align = $('#np-align');
    const entries = [];
    const add = (sel, hidden) => { const el = $(sel); if (el) entries.push({ el, hidden }); };
    add('#np-row-sub', draft);
    // 项目包导入也是"导入模式"的事（初稿模式是从视频识别，用不上包）
    add('#np-row-pack', draft);
    // 区域裁剪两种模式都可能有意义：导入模式裁字幕/包；初稿模式暂时用不上（识别本来就全片）
    add('#np-row-region', draft);
    add('#np-row-url', !draft);
    add('#np-row-part', !draft);
    add('#np-row-word', !draft);
    add('#np-row-align', !draft || !!(word && word.checked));
    add('#np-row-kstyle', !draft || !((word && word.checked) || (align && align.checked)));
    add('#np-row-conf', !draft);
    add('#np-row-spk', !draft);
    add('#np-auto-wrap', !draft);
    for (const sel of ['#np-voice-group', '#np-cast-group']) add(sel, !draft);
    return entries;
  }

  function npApplyFields(mode) {
    const draft = mode === 'draft';
    for (const { el, hidden } of npFieldPlan(mode)) el.hidden = hidden;
    if (draft) { npSyncVibeVoice(); npSyncKStyle(); }
    // 切进初稿模式时，把开关同步成**全局默认**（用户没动过就跟随；动过则以他刚选的为准）。
    // 只在第一次进入时拉一次，避免每次切模式都把用户的改动冲掉。
    if (draft && !npConfSynced) { npConfSynced = true; syncConfidenceFromGlobal(); }
    $('#np-hint').textContent = draft
      ? '创建后在左侧「处理进度」里显示下载与识别进度'
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

  function npApplyMode(mode) {
    npApplyLayout(mode);
    npApplyFields(mode);
  }

  /** 模式切换入口：四张卡在同一个 View Transition 里整体移动/缩放。 */
  function npSetMode(mode) {
    const draft = mode === 'draft';
    const layoutChanges = npView.classList.contains('is-draft') !== draft;
    if (!layoutChanges) { npApplyMode(mode); return; }
    const reduceQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    const reduced = reduceQuery || (!!document.body && document.body.dataset.motion === 'off');
    if (reduced || typeof document.startViewTransition !== 'function') {
      npApplyMode(mode);
      return;
    }
    const root = document.documentElement;
    root.dataset.npTransition = 'layout';
    let transition = null;
    try {
      transition = document.startViewTransition(() => npApplyMode(mode));
    } catch {
      delete root.dataset.npTransition;
      npApplyMode(mode);
      return;
    }
    const clear = () => { delete root.dataset.npTransition; };
    if (transition.finished && typeof transition.finished.finally === 'function') {
      transition.finished.finally(clear);
    } else {
      clear();
    }
  }

  /** 拉取识别模型状态: 填「语音识别」下拉（来源就是模型的引擎）
   *  —— 走 genRender 的统一通道，避免和生成设置面板抢同一个 select。 */
  async function refreshAsrStatus(force) {
    if (force || !genAsr) {
      try { genAsr = filterStatusModels(await ensureHardware(await (await fetch('/api/asr/status')).json())); }
      catch { genAsr = { ready: false, models: [] }; }
    }
    asrStatus = genAsr;
    genRender('np');
    if (npSchemesLoaded) setNpSchemeBadge();
    else genSetState('np', (genTr && genTr.ready) ? '已配置' : '读取方案…');
    // Python 环境预检失败 → 提前提醒(不拦按钮: whisper.cpp 引擎不需要 Python, 由服务端预检按引擎分流)
    const hint = $('#np-hint');
    if (hint) delete hint.dataset.warn;
    const probeForUi = (() => {
      const pp = asrStatus.pythonProbe;
      if (!pp) return null;
      if (typeof pp.ok === 'boolean') return pp;                 // 旧扁平形状
      return asrStatus.pythonProbeFlat || null;                  // 服务端按当前引擎挑好的
    })();
    if (hint && probeForUi && !probeForUi.ok) {
      hint.textContent = '⚠ Python 环境不可用：' + probeForUi.msg + '。Parakeet NPU 需要 Python + OpenVINO（修复方法见创建后的日志）；Vulkan 版 Parakeet（CrispASR）和「必剪 ASR」云端识别都不需要 Python';
      hint.style.color = '#ff9a5c';
      hint.dataset.warn = '1';
    }
    npMaybeEnable();
  }

  /** 新建项目页的「处理进度」实时预览：创建初稿后不再立刻跳走，
   *  就在这张卡里显示下载/识别/分句/翻译的细进度（步骤、百分比、已用/剩余、最近记录），
   *  完成后按钮变成「打开项目」。
   *
   *  以前这里只是一张全灰的静态预览，创建后直接跳主页，用户看不到"下载到多少、
   *  识别到第几片、还剩多久"（截图反馈「在这里多加一些进度」）。 */
  function stopNpDraft() {
    clearTimeout(npDraftTimer);
    npDraftTimer = 0;
  }
  function npProgressReset() {
    stopNpDraft();
    npDraftId = '';
    npDraftDone = false;
    npDraftFailed = false;
    npDraftErrors = 0;
    const logEl = $('#np-log');
    if (logEl) { logEl.hidden = true; logEl.textContent = ''; }
    const meta = $('#np-meta');
    if (meta) meta.hidden = true;
    const note = $('#np-progress-note');
    if (note) { note.hidden = false; note.textContent = '创建项目后，这里会显示每一步的处理状态和记录。'; }
    const bar = $('#np-bar-in');
    if (bar) { bar.style.width = '0%'; bar.classList.remove('ok', 'err'); }
    const pct = $('#np-pct');
    if (pct) pct.textContent = '0%';
    const msg = $('#np-msg');
    if (msg) { msg.textContent = '尚未开始'; msg.classList.remove('dp-err'); }
    renderDpSteps(-1, '#np-steps');
  }
  function npSetDraftButton() {
    const btn = $('#np-create');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = npDraftDone ? '打开项目' : (npDraftFailed ? '查看详情' : '处理中…');
  }
  function npShowDraftLog(log) {
    const el = $('#np-log');
    if (!el) return;
    const lines = String(log || '').split('\n').filter(Boolean).slice(-8)
      .map(l => l.replace(/^(\[\d{2}:\d{2}:\d{2}\]\s*)([\s\S]*)$/, (all, pre, rest) => pre + t(rest)));
    if (!lines.length) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = lines.join('\n');
    el.scrollTop = el.scrollHeight;
  }
  async function npDraftTick() {
    if (!npDraftId) return;
    let m;
    try { m = await (await fetch('/api/projects/' + npDraftId + '/draft')).json(); }
    catch {
      /* 服务重启/项目被删时轮询会一直失败：连续 5 次就收手，别无限重试。 */
      npDraftErrors++;
      if (npDraftErrors >= 5) {
        stopNpDraft();
        npDraftFailed = true;
        npSetDraftButton();
        const note = $('#np-progress-note');
        if (note) { note.hidden = false; note.textContent = '读不到处理进度（服务可能刚重启或项目已删除）。点「查看详情」核对。'; }
        return;
      }
      npDraftTimer = setTimeout(npDraftTick, 2400); return;
    }
    npDraftErrors = 0;
    const d = m.draft || {};
    const curIdx = d.status === 'done' ? DP_STEPS.length - 1 : stepIndexOf(d.failedStage || d.stage);
    renderDpSteps(curIdx, '#np-steps', { sub: dpStepSub(d), err: d.status === 'error' });
    dpRenderDetail('np', d);
    const bar = $('#np-bar-in');
    if (bar) {
      bar.style.width = Math.max(0, Math.min(100, d.progress || 0)) + '%';
      bar.classList.toggle('ok', d.status === 'done');
      bar.classList.toggle('err', d.status === 'error');
    }
    const note = $('#np-progress-note');
    if (note) {
      note.hidden = d.status === 'running';
      if (d.status === 'done') note.textContent = '初稿已生成。点「打开项目」进入编辑器复核逐词与翻译。';
      else if (d.status === 'error') note.textContent = '处理中断：' + (d.error || '未知错误') + '。可点「查看详情」重试。';
      else if (d.status === 'paused') note.textContent = '已出稿，翻译还没完成。点「查看详情」继续翻译。';
    }
    npShowDraftLog(m.log);
    if (d.status === 'running') {
      npDraftTimer = setTimeout(npDraftTick, 1200);
      return;
    }
    stopNpDraft();
    npDraftDone = d.status === 'done';
    npDraftFailed = !npDraftDone;      // 失败 / 等待翻译 / 已取消 → 都走「查看详情」
    npSetDraftButton();
    if (npDraftDone) toast('初稿已生成，可以点「打开项目」开始校对', 6000);
    else if (npDraftFailed) toast('处理失败：' + (d.error || '未知错误'), 8000);
  }
  function startNpDraftProgress(id) {
    stopNpDraft();
    npDraftId = id;
    npDraftDone = false;
    npDraftFailed = false;
    npDraftErrors = 0;
    const note = $('#np-progress-note');
    if (note) { note.hidden = true; note.textContent = ''; }
    npSetDraftButton();
    npDraftTick();
  }
  /** 新建项目页复位：清空表单、停掉上一轮进度预览。 */
  function npReset() {
    npProgressReset();
    npVideo.path = npVideo.name = '';
    npSub.name = npSub.text = '';
    npVideoFile = null;
    npProbeSource = null;
    $('#np-name').value = '';
    $('#np-word').checked = true;
    $('#np-word-desc').textContent = '开启 → 生成 ASS 逐词字幕';
    if ($('#np-align')) { $('#np-align').checked = false; delete $('#np-align').dataset.touched; }
    delete $('#np-word').dataset.touched;
    const kSel = $('#np-kstyle');
    if (kSel) { delete kSel.dataset.touched; npSyncKStyle(); }   // 逐词样式回到记住的选择
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
    renderDpSteps(-1, '#np-steps');     // 处理进度：创建前是全灰预览；创建后由 npDraftTick 实时更新
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
  /** 初稿模式按钮被禁用的具体原因（给用户看，而不是只把按钮变灰）。 */
  function npModelBlockReason() {
    const sel = $('#np-model-sel');
    const mid = sel && sel.value;
    const list = (asrStatus && asrStatus.models) || [];
    const m = mid ? list.find(x => x.id === mid) : null;
    if (m && m.ready === false) {
      return '识别模型「' + (m.name || mid) + '」还没就绪'
        + (m.blockedReason ? '：' + m.blockedReason : '（到「设置 → 识别模型」下载/检查）');
    }
    if (!mid) return '先在「语音识别」里选一个模型';
    if (!asrStatus.ready) return '没有已就绪的识别模型：到「设置 → 识别模型」下载一个，或换用云端识别';
    return '识别模型还没就绪';
  }
  function npDefaultHint() {
    return npMode === 'draft'
      ? '创建后在左侧「处理进度」里显示下载与识别进度'
      : '音频和波形会自动存进项目，下次打开就不用重新生成；字幕边改边存';
  }
  function npMaybeEnable() {
    /* 初稿已经在跑：按钮是「打开项目 / 查看详情」，不要被表单变化改回禁用/改文案。 */
    if (npDraftId) { npSetDraftButton(); return; }
    const npUrlNow = (($('#np-url') || {}).value || '').trim();
    const hasSource = !!npVideo.path || (npMode === 'draft' && !!npUrlNow);
    // 初稿模式不需要字幕文件, 但必须有可用的识别模型
    const hasModel = npMode !== 'draft' || !!($('#np-model-sel') && $('#np-model-sel').value);
    // 导入模式：字幕文件**或**项目包，二选一即可
    const hasSubOrPack = npMode === 'draft' ? true : (!!npSub.text || !!npPack.file);
    // 填了非法区间就别让点（提示已经在 npRegionFeedback 里给了）
    const regionOk = npReadRegion().ok;
    // 初稿模式必须有可用的识别模型（导入模式不需要）
    const draftReady = npMode !== 'draft' || !!asrStatus.ready;
    let why = '';
    if (!hasSource) why = npMode === 'draft' ? '先粘贴视频链接（或选择视频文件）' : '先选择要导入的字幕文件或项目包';
    else if (!hasSubOrPack) why = '先选择字幕文件或项目包';
    else if (!hasModel) why = '先在「语音识别」里选一个模型';
    else if (!regionOk) why = '时间区间无效：结束时间要晚于开始时间';
    else if (!draftReady) why = npModelBlockReason();
    $('#np-create').disabled = !!why;
    $('#np-create').title = why || '开始创建/识别';
    const hint = $('#np-hint');
    /* 不要盖掉 refreshAsrStatus 写的 Python 环境警告（那条更具体）。 */
    if (hint && !hint.dataset.warn) {
      if (why) {
        hint.textContent = '还不能开始：' + why;
        hint.style.color = '#ff9a5c';
      } else {
        hint.textContent = npDefaultHint();
        hint.style.color = '';
      }
    }
  }
  /** 自定义方案选择：读取全局命名方案，激活后新稿件沿用同一套翻译配置。 */
  function npSchemeProviderName(id) {
    return npProviders.get(id) || (id ? String(id) : '未设置服务商');
  }
  function setNpSchemeBadge() {
    const el = $('#np-set-state');
    if (!el) return;
    const active = savedSchemes.find(item => item.id === activeSchemeId);
    el.textContent = active ? '方案 · ' + active.name : (savedSchemes.length ? '未选择方案' : '未创建方案');
    el.classList.toggle('is-muted', !active);
    el.classList.toggle('is-ok', !!active);
  }
  function renderNpSchemes() {
    const list = $('#np-scheme-list');
    if (!list) return;
    setNpSchemeBadge();
    if (!savedSchemes.length) {
      list.innerHTML = `<div class="np-scheme-empty"><b>还没有保存的翻译方案</b><p>创建一套方案后，新稿件会自动使用它翻译。</p><button type="button" class="btn btn-accent" id="np-scheme-create">创建方案</button></div>`;
      return;
    }
    list.innerHTML = savedSchemes.map(item => {
      const active = item.id === activeSchemeId;
      let host = '';
      try { host = new URL(item.baseUrl).host; } catch { /* 本地/空地址 */ }
      return `<div class="np-scheme-card${active ? ' is-active' : ''}">
        <div class="np-scheme-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(npSchemeProviderName(item.provider))}${item.model ? ' · ' + escapeHtml(item.model) : ''}${host ? ' · ' + escapeHtml(host) : ''}</small></div>
        <span class="np-scheme-state">${active ? '当前使用' : '可用'}</span>
        <button type="button" class="btn btn-mini${active ? '' : ' btn-accent'}" data-np-scheme="${escapeHtml(item.id)}"${active ? ' disabled' : ''}>${active ? '已选择' : '使用'}</button>
      </div>`;
    }).join('');
  }
  /** 详情页的翻译方案列表：与新建页同一份数据、同一种卡片，只换容器。
   *  详情页以前直接摊开「翻译模型 / 模型名称 / 提示词」，同一个 2×2 骨架在两处长得不一样，
   *  用户会以为详情页是旧版界面 —— 这里把两处统一成「方案 + 高级折叠」。 */
  function renderDtSchemes() {
    const list = $('#dt-scheme-list');
    if (!list) return;
    if (!savedSchemes.length) {
      list.innerHTML = '<div class="np-scheme-empty"><b>还没有保存的翻译方案</b><p>到「全局设置 → 翻译」里创建一套，项目会沿用它翻译。</p></div>';
      return;
    }
    list.innerHTML = savedSchemes.map(item => {
      const active = item.id === activeSchemeId;
      let host = '';
      try { host = new URL(item.baseUrl).host; } catch { /* 本地/空地址 */ }
      return `<div class="np-scheme-card${active ? ' is-active' : ''}">
        <div class="np-scheme-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(npSchemeProviderName(item.provider))}${item.model ? ' · ' + escapeHtml(item.model) : ''}${host ? ' · ' + escapeHtml(host) : ''}</small></div>
        <span class="np-scheme-state">${active ? '当前使用' : '可用'}</span>
        <button type="button" class="btn btn-mini${active ? '' : ' btn-accent'}" data-dt-scheme="${escapeHtml(item.id)}"${active ? ' disabled' : ''}>${active ? '已选择' : '使用'}</button>
      </div>`;
    }).join('');
  }
  async function loadNpSchemes(force = false) {
    if (npSchemeBusy || (npSchemesLoaded && !force)) { renderNpSchemes(); return; }
    npSchemeBusy = true;
    try {
      const [sr, cr] = await Promise.all([fetch('/api/translate/schemes'), fetch('/api/translate/config')]);
      const sd = await sr.json();
      if (!sr.ok) throw new Error(sd.error || '读取方案失败');
      const cd = await cr.json().catch(() => ({}));
      savedSchemes = Array.isArray(sd.schemes) ? sd.schemes : [];
      activeSchemeId = sd.activeSchemeId || '';
      npProviders = new Map((cd.presets || []).map(p => [p.id, p.name]));
      npSchemesLoaded = true;
      renderNpSchemes();
      genTr = await (await fetch('/api/translate/config')).json();
      genRender('np');
      setNpSchemeBadge();
    } catch (e) {
      const list = $('#np-scheme-list');
      if (list) list.innerHTML = `<div class="np-scheme-empty">读取翻译方案失败：${escapeHtml((e && e.message) || e)}<br><button type="button" class="btn btn-mini" id="np-scheme-retry">重试</button></div>`;
      setNpSchemeBadge();
    } finally {
      npSchemeBusy = false;
    }
  }
  async function useNpScheme(id) {
    if (npSchemeBusy) return;
    npSchemeBusy = true;
    try {
      const r = await fetch('/api/translate/schemes/' + encodeURIComponent(id) + '/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '切换失败');
      savedSchemes = d.schemes || savedSchemes;
      activeSchemeId = d.activeSchemeId || '';
      renderNpSchemes();
      genTr = await (await fetch('/api/translate/config')).json();
      genRender('np');
      toast('已选择翻译方案', 2400);
    } catch (e) {
      toast('切换翻译方案失败：' + ((e && e.message) || e), 4200);
    } finally {
      npSchemeBusy = false;
    }
  }
  function openSchemeSettings() {
    settingsReturnRoute = '#/new';
    settingsOpenedFromApp = true;
    location.hash = '#/settings';
    setTimeout(() => {
      document.querySelector('.st-tab[data-stp="translate"]')?.click();
      document.querySelector('.st-subtab[data-stsub="llm"]')?.click();
      document.querySelector('#st-scheme-new')?.click();
    }, 140);
  }

  $('#np-scheme-refresh').addEventListener('click', () => loadNpSchemes(true));
  $('#np-scheme-manage').addEventListener('click', openSchemeSettings);
  $('#dt-scheme-refresh').addEventListener('click', () => loadNpSchemes(true).then(renderDtSchemes));
  $('#dt-scheme-manage').addEventListener('click', openSchemeSettings);
  $('#dt-scheme-list').addEventListener('click', (e) => {
    const use = e.target.closest('[data-dt-scheme]');
    if (use && !use.disabled) useNpScheme(use.dataset.dtScheme).then(renderDtSchemes);
  });
  $('#np-scheme-list').addEventListener('click', (e) => {
    if (e.target.closest('#np-scheme-create')) { openSchemeSettings(); return; }
    if (e.target.closest('#np-scheme-retry')) { loadNpSchemes(true); return; }
    const use = e.target.closest('[data-np-scheme]');
    if (use && !use.disabled) useNpScheme(use.dataset.npScheme);
  });
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
    if ($('#np-model-sel')?.value === 'vibevoice-asr-4bit') {
      $('#np-speakers').checked = true;
      $('#np-speakers').disabled = true;
      $('#np-spk-count').disabled = true;
      $('#np-row-spk').title = t('VibeVoice 自动识别说话人，无需额外的说话人分离模型');
      return;
    }
    const wordOn = !!($('#np-word') && $('#np-word').checked)
      || !!($('#np-align') && $('#np-align').checked);
    const root = $('#np-row-spk');
    const box = $('#np-speakers');
    const cnt = $('#np-spk-count');
    if (!root || !box) return;
    box.disabled = !wordOn;
    if (cnt) cnt.disabled = !wordOn || !box.checked;
    if (!wordOn && box.checked) box.checked = false;      // SRT 用不上 → 自动取消
    root.classList.toggle('disabled', !wordOn);
    root.title = wordOn ? '' : 'SRT 模式没有角色（说话人）概念，需要逐词或对齐（生成 ASS）才能区分说话人';
  }
  function npSelectedModel() {
    const id = $('#np-model-sel') ? $('#np-model-sel').value : '';
    return (genAsr && genAsr.models || []).find(m => m.id === id) || null;
  }
  /** 当前模型/后端可用的对齐器（对齐模型独立下载，不再跟 ASR 混在一起）。 */
  function npAlignerReady(m) {
    const list = (genAsr && genAsr.aligners) || [];
    // Qwen3-ASR 的内部对齐把 CUDA 对齐器目录交给 worker；Vulkan GGUF 不能兜底。
    if (m && m.engine === 'qwen') return list.some(a => a.ready && a.backend === 'cuda');
    const backend = m && m.backend;
    return list.some(a => a.ready && (!backend || a.backend === backend))
      || list.some(a => a.ready);
  }
  /** 对齐不可用时的原因：区分「没下载」与「已下载但运行时缺失」，
   *  否则用户明明已经下好模型却被告知“去下载”（用户实测反馈）。 */
  function npAlignerHint(m) {
    const list = (genAsr && genAsr.aligners) || [];
    // Qwen3-ASR 只认 CUDA 对齐器：不要把用户引去装 CrispASR / 下载 Vulkan GGUF。
    if (m && m.engine === 'qwen') {
      const cuda = list.find(a => a.backend === 'cuda');
      if (cuda && cuda.filesOk) {
        if (cuda.needRuntime) return `对齐模型已下载，但还差 ${cuda.runtimeName || '运行时'}；到「设置 → 语音识别 → 对齐模型」点「安装运行时」`;
        if (cuda.blockedReason) return cuda.blockedReason;
      }
      return 'Qwen3-ASR 的「对齐」只使用 CUDA 对齐器；到「设置 → 语音识别 → 对齐模型」下载 Qwen3-ForcedAligner 0.6B（CUDA）';
    }
    const held = list.filter(a => a.filesOk);
    // 没 N 卡的 CUDA 对齐器即使补运行时也用不了，不能把用户引去装运行时。
    const noRuntime = held.find(a => a.needRuntime && !a.blockedReason);
    if (noRuntime) return `对齐模型已下载，但还差 ${noRuntime.runtimeName || '运行时'}；到「设置 → 语音识别 → 对齐模型」点「安装运行时」`;
    const blocked = list.find(a => a.blockedReason);
    if (blocked) return blocked.blockedReason;
    return '没有可用的对齐模型；先到「设置 → 语音识别 → 对齐模型」下载并安装对应运行时';
  }
  function npSyncVibeVoice() {
    const word = $('#np-word');
    const align = $('#np-align');
    const rowAlign = $('#np-row-align');
    if (!word) return;
    const m = npSelectedModel();
    const vibe = (m && m.id === 'vibevoice-asr-4bit') || $('#np-model-sel')?.value === 'vibevoice-asr-4bit';
    const native = !m || m.nativeWordLevel !== false;
    if (vibe) {
      word.disabled = true; word.checked = false;
    } else if (!native) {
      /* Qwen ASR 这类没有原生逐词的模型：禁止勾「逐词」，只能勾「对齐」。 */
      word.disabled = true; word.checked = false;
    } else {
      word.disabled = false;
    }
    const canAlign = !vibe && npAlignerReady(m);
    if (!canAlign) {
      align.checked = false;
      align.disabled = true;
    } else {
      align.disabled = false;
      if (!native && !align.dataset.touched) align.checked = true;
    }
    if (word.checked) { align.checked = false; rowAlign.hidden = true; }
    else rowAlign.hidden = false;
    $('#np-word-desc').textContent = vibe
      ? t('VibeVoice 生成带角色的 ASS 句级字幕，不提供逐词时间戳')
      : (!native
        ? t('该模型没有原生逐词，已禁用；请勾「对齐」用对齐模型生成逐词')
        : (word.checked ? '开启 → 生成 ASS 逐词字幕' : '关闭 → 生成 SRT 纯文本字幕'));
    $('#np-align-desc').textContent = !canAlign
      ? t(npAlignerHint(m))
      : (align.checked
        ? t('勾选 → 不跑原生逐词，改用对齐模型生成逐词 ASS')
        : t('不勾选 → 输出 SRT；勾选 → 用对齐模型生成逐词 ASS'));
    $('#np-row-kstyle').hidden = vibe || !(word.checked || align.checked);
    npSyncSpeakers();
  }
  /** 逐词样式（颜色高亮 / \k 卡拉OK）：记住上次选择（main.js 的设置面板用同一组 localStorage 键）。
   *  \kf 扫过 / 未唱默认色属于"打开稿件后"的设置（设置面板），这里只带默认值过去。 */
  function npSyncKStyle() {
    const sel = $('#np-kstyle');
    if (!sel) return;
    if (!sel.dataset.touched) {
      let saved = '';
      try { saved = localStorage.getItem('sf-k-style') || ''; } catch (e) {}
      if (saved === 'k' || saved === 'color') sel.value = saved;   // 默认 color = 升级前行为
    }
  }
  $('#np-kstyle') && $('#np-kstyle').addEventListener('change', () => {
    const sel = $('#np-kstyle');
    sel.dataset.touched = '1';
    try { localStorage.setItem('sf-k-style', sel.value); } catch (e) {}
  });
  $('#np-word').addEventListener('change', () => {
    $('#np-word').dataset.touched = '1';
    $('#np-align').dataset.touched = '1';
    npSyncVibeVoice();
  });
  $('#np-align') && $('#np-align').addEventListener('change', () => {
    $('#np-align').dataset.touched = '1';
    npSyncVibeVoice();
  });
  const npSpk = $('#np-speakers');
  if (npSpk) npSpk.addEventListener('change', npSyncSpeakers);

  /** 视频选择：统一用浏览器 <input type=file>（与选择字幕/导入项目包同一个窗口）。
   *  File 先暂存，创建项目时经 /api/upload-video 落盘成服务端持久文件，
   *  之后与本地路径完全同构；代价是视频会复制一份进程序目录。 */
  let npPicking = false;
  $('#np-pick-video').addEventListener('click', async () => {
    if (npPicking) return;                       // 防双击重复触发
    npPicking = true;
    const btn = $('#np-pick-video');
    const oldLabel = btn.textContent;
    btn.textContent = '打开选择框…';
    try {
      /* 与「选择字幕 / 导入项目包」同一个浏览器文件选择框（原生对话框是另一个进程的窗口，
         层级/置顶都做不稳）。File 暂存，创建项目时经 /api/upload-video 落盘。 */
      const f = await browserPickVideo();
      if (!f) return;
      npVideoFile = f;
      npVideo.path = 'upload:' + f.name;
      npVideo.name = f.name;
      const el = $('#np-video-name');
      el.textContent = npVideo.name + '（浏览器选择）';
      el.classList.add('filled');
      if (!$('#np-name').value.trim()) $('#np-name').value = npVideo.name.replace(/\.[^.]+$/, '');
      npMaybeEnable();
    } finally {
      btn.textContent = oldLabel;
      npPicking = false;
    }
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
    /* 正在创建初稿时按钮变成「处理中… / 打开项目 / 查看详情」：
     * 点它直接去对应页面，不要重复提交一次创建请求。 */
    if (npDraftId) {
      location.hash = npDraftDone ? '#/project/' + npDraftId : '#/details/' + npDraftId;
      return;
    }
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
          align: !!($('#np-align') && $('#np-align').checked),
          modelId: $('#np-model-sel') ? $('#np-model-sel').value : '',
          speakers: !!($('#np-speakers') && $('#np-speakers').checked),
          speakerCount: parseInt($('#np-spk-count') ? $('#np-spk-count').value : '', 10) || 6,
          confidence: ($('#np-confidence') || {}).value || 'full',
          // 「创建后自动处理」：出稿后自动跑 反思纠错 + 全片逐词重校对
          autoPost: !!($('#np-autopost') && $('#np-autopost').checked),
          fetch: { url: npUrl, part: Math.max(1, parseInt((npPartEl || {}).value, 10) || 1) },
        };
        // 逐词样式与"本地视频初稿"同款(见下方 payload 的注释)
        if (payload0.wordLevel || payload0.align) {
          payload0.karaokeStyle = ($('#np-kstyle') && $('#np-kstyle').value) === 'k' ? 'k' : 'color';
          if (payload0.karaokeStyle === 'k') {
            let sweep = '', base = '';
            try { sweep = localStorage.getItem('sf-k-sweep') || ''; base = localStorage.getItem('sf-k-base') || ''; } catch (e) {}
            payload0.karaokeSweep = sweep === '1';
            if (/^#[0-9a-fA-F]{6}$/.test(base)) payload0.karaokeBase = base;
          }
        }
        if (payload0.speakers) localStorage.setItem('ss-role-annot', '1');
        const r0 = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload0) });
        const m0 = await r0.json();
        if (!r0.ok) { toast(m0.error || '创建失败', 4200); return; }
        /* 不跳走：留在新建页，把下载/识别/分句/翻译的细进度直接铺在「处理进度」卡里。 */
        if (m0.id) startNpDraftProgress(m0.id);
        toast('已开始下载并识别，进度就在左侧「处理进度」里', 5600);
      } catch (e) {
        toast('创建失败: ' + e.message, 3600);
      } finally {
        npSubmitting = false;
        $('#np-open-settings').disabled = false;
        if (npDraftId) npSetDraftButton();
        else { btn0.textContent = '开始识别'; npMaybeEnable(); }
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
        payload.align = !!($('#np-align') && $('#np-align').checked);
        payload.modelId = $('#np-model-sel') ? $('#np-model-sel').value : '';
        payload.speakers = !!($('#np-speakers') && $('#np-speakers').checked);
        payload.speakerCount = parseInt($('#np-spk-count') ? $('#np-spk-count').value : '', 10) || 6;
        // 逐词样式: 颜色高亮(默认) / \k 卡拉OK。扫过(\kf)与未唱默认色跟随设置面板记住的偏好。
        if (payload.wordLevel || payload.align) {
          payload.karaokeStyle = ($('#np-kstyle') && $('#np-kstyle').value) === 'k' ? 'k' : 'color';
          if (payload.karaokeStyle === 'k') {
            let sweep = '', base = '';
            try { sweep = localStorage.getItem('sf-k-sweep') || ''; base = localStorage.getItem('sf-k-base') || ''; } catch (e) {}
            payload.karaokeSweep = sweep === '1';
            if (/^#[0-9a-fA-F]{6}$/.test(base)) payload.karaokeBase = base;
          }
        }
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
        /* 同上：留在本页看实时进度（下载/识别/分句/翻译），完成后按钮变「打开项目」。 */
        if (m.id) startNpDraftProgress(m.id);
        toast('已开始识别，进度就在左侧「处理进度」里', 5200);
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
      if (npDraftId) npSetDraftButton();
      else {
        btn.textContent = npMode === 'draft' ? '开始识别' : '创建项目';
        npMaybeEnable();
      }
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
    /* 首次启动 / 手动重开欢迎界面：不让底下的路由跑起来，也不让 App 可交互。
     * 保存后 hideWelcome() 会把 welcomeBlocking 置回 false 并重新调用 applyHash()。 */
    if (welcomeBlocking) {
      document.body.dataset.workspace = 'welcome';
      const appEl = $('#app'); if (appEl) appEl.inert = true;
      return;
    }
    let h = location.hash || '#/dashboard';
    // 新侧栏及浏览器后退也要遵守创建互斥；上传期间离场会重置仍在使用的材料。
    if (studioUI && npSubmitting && h !== '#/new') {
      history.replaceState(null, '', '#/new');
      toast('正在提交稿件，请等待上传完成。', 3200);
      return;
    }
    // 资源管理曾是设置的重复别名；保留旧书签可用，但统一落到设置页。
    if (studioUI && h === '#/resources') { h = '#/settings'; history.replaceState(null, '', h); }
    // 任务中心已移除，旧书签统一回稿件库；任务视图与稿件库本就是同一组项目卡。
    if (studioUI && h === '#/tasks') { h = '#/home'; history.replaceState(null, '', h); }
    const studioPages = studioUI ? ['#/help'] : [];
    if (studioUI && h === '#/settings' && previousRoute !== '#/settings') {
      settingsReturnRoute = previousRoute || '#/home';
      settingsOpenedFromApp = !!previousRoute;
    }
    const detailsMatch = /^#\/details\/([A-Za-z0-9_-]{1,64})$/.exec(h);
    if (!location.hash || !['#/dashboard', '#/home', '#/new', '#/settings', '#/editor', ...studioPages].includes(h) && !h.startsWith('#/project/') && !detailsMatch) {
      h = '#/dashboard';
      history.replaceState(null, '', h);
    }
    $('#app').inert = h === '#/dashboard' || h === '#/home' || h === '#/new' || h === '#/settings' || studioPages.includes(h) || !!detailsMatch;
    setPageVisible(dashboardView, h === '#/dashboard');
    setPageVisible(elHome, h === '#/home');
    setPageVisible(npView, h === '#/new');
    setPageVisible(stView, h === '#/settings');
    setPageVisible(detailView, !!detailsMatch);
    if (!detailsMatch && previousRoute.startsWith('#/details/')) {
      stopDp(); dpId = ''; detailLoadToken++;
    }
    /* 离开新建页就停掉它的进度轮询；回到 #/new 时若作业还在，用户可以从项目列表/详情页继续看。 */
    if (h !== '#/new') stopNpDraft();
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
    } else if (h === '#/dashboard') {
      setAudioControlsVisible(false);
      if (previousRoute !== h) showHome();
      if (previousRoute !== h) focusPage(dashboardView);
    } else if (h === '#/home') {
      setAudioControlsVisible(false);
      if (previousRoute !== h) showHome();
      if (previousRoute === '#/new' || previousRoute === '#/settings')
        requestAnimationFrame(() => $('#btn-new-project').focus({ preventScroll: true }));
    } else if (h === '#/new') {
      const fromSettings = previousRoute === '#/settings';
      if (!fromSettings && previousRoute !== '#/new') npReset();
      // 生成设置面板：从设置页回来时强制刷新（模型/接口/Key 刚改过），其余情况走缓存
      genLoad('np', fromSettings).then(() => { if (fromSettings) refreshAsrStatus(); if (npSchemesLoaded) setNpSchemeBadge(); });
      loadNpSchemes(true);
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
        $('#st-cancel').textContent = label;
        loadSettings();
        focusPage(stView);
      }
    } else if (h === '#/help') {
      video.pause();
      if (state.project) saveNow();
    }
    if (studioUI) window.__sfStudio?.route(h, state.project, state.format);
    previousRoute = h;
  }
  window.addEventListener('hashchange', applyHash);
  $('#btn-home').addEventListener('click', () => { location.hash = '#/home'; });

  /* ═══════════════════════════════════════════════════════════════
     欢迎界面 / 加速方式
     ---------------------------------------------------------------
     · 首次打开（localStorage 没有 sf-welcome-v1）先显示，App inert。
     · CUDA / Vulkan 两个勾选；NPU 不在欢迎页出现，设置里按硬件显示。
     · 至少勾一个才能进入；不提供 CPU 推理。
     · 设置 → 性能与调度 → 「重新进入欢迎界面」可再次打开。
     ═══════════════════════════════════════════════════════════════ */
  const welcomeView = $('#welcome-view');
  const welcomeCuda = $('#welcome-cuda');
  const welcomeVulkan = $('#welcome-vulkan');
  const welcomeCudaCard = $('#welcome-cuda-card');
  const welcomeVulkanCard = $('#welcome-vulkan-card');
  const welcomeCudaState = $('#welcome-cuda-state');
  const welcomeVulkanState = $('#welcome-vulkan-state');
  const welcomeGo = $('#welcome-go');
  const welcomeRetry = $('#welcome-retry');
  const welcomeCancel = $('#welcome-cancel');
  const welcomeAlert = $('#welcome-alert');
  const welcomeAlertSlot = $('#welcome-alert-slot');
  let welcomeError = '';
  let welcomeAlertClearTimer = 0;
  let welcomePrepStatus = null;
  let welcomePrepError = '';
  let welcomePrepTimer = 0;
  let welcomePrepGeneration = 0;
  let welcomeLoadGeneration = 0;
  let welcomePrepLayout = '';
  const welcomePrepChoices = {};
  const welcomePrepPending = new Set();

  function welcomePrepItems() {
    const common = welcomePrepStatus?.ffmpeg;
    const groups = welcomeRecommendations(welcomePrepStatus, welcomeHardware, welcomeSelected());
    const items = common ? [{ key: 'ffmpeg', label: 'FFmpeg / FFprobe', ready: !!common.ok,
      blockedReason: !common.ok && !common.canAutoDownload ? '当前系统不支持自动安装，请到设置中指定 FFmpeg。' : '',
      url: '/api/asr/ffmpeg/download' }] : [];
    for (const group of groups) {
      const choice = group.models.find(m => m.id === welcomePrepChoices[group.backend])
        || group.models.find(m => m.id === group.preferred) || group.models[0];
      group.choice = choice;
      group.requirements = welcomeRequirements(welcomePrepStatus, choice);
      items.push(...group.requirements);
    }
    return { groups, items };
  }
  function welcomePrepRow(item) {
    const dl = item.key === 'ffmpeg' ? welcomePrepStatus?.ffmpeg?.download
      : welcomePrepStatus?.downloads?.find(d => d.key === item.key);
    const pending = welcomePrepPending.has(item.key);
    const running = pending || dl?.running;
    const detail = item.ready ? '已就绪' : item.blockedReason || (running
      ? (dl?.msg || '正在启动…') + (Number.isFinite(dl?.pct) ? ' · ' + Math.round(dl.pct) + '%' : '')
      : dl?.error || '尚未准备');
    const size = item.sizeMB > 0 ? ' · 下载约 ' + (item.sizeMB >= 1024
      ? (item.sizeMB / 1024).toFixed(1) + ' GB' : item.sizeMB + ' MB') : '';
    return '<div class="welcome-prep-row"><span>' + escapeHtml(item.label || item.key)
      + '<small class="' + (item.ready ? 'welcome-prep-ready' : dl?.error ? 'welcome-prep-warning' : '')
      + '">' + escapeHtml(detail + size) + '</small></span>'
      + (item.ready ? '' : '<button type="button" class="btn" data-prep-key="' + escapeHtml(item.key)
        + '"' + (running || item.blockedReason || !item.body && !item.url ? ' disabled' : '') + '>'
        + (running ? '准备中…' : dl?.error ? '重试' : '下载 / 安装') + '</button>') + '</div>';
  }
  function welcomeRenderPrep() {
    const box = $('#welcome-prep-models');
    const common = $('#welcome-prep-common');
    const message = $('#welcome-prep-status');
    if (!box || !common || !message) return;
    message.textContent = welcomePrepError || (!welcomePrepStatus ? '正在读取模型与前置状态…'
      : !welcomeHardware ? '等待显卡检测完成…' : !welcomeSelected().cuda && !welcomeSelected().vulkan
        ? '选择 GPU 后端后显示对应推荐。' : '选择适合素材的模型，然后按需下载前置与权重。');
    const { groups, items } = welcomePrepItems();
    const commonHtml = items.filter(i => i.key === 'ffmpeg').map(welcomePrepRow).join('');
    if (common.innerHTML !== commonHtml) common.innerHTML = commonHtml;
    // 下载轮询不重建下拉控件，避免打断已打开的菜单与键盘焦点。
    const layout = JSON.stringify(groups.map(g => ({ backend: g.backend, devices: g.devices,
      vramMB: g.vramMB, preferred: g.preferred, models: g.models.map(m => [m.id, m.model.name, m.fits]) })));
    if (layout !== welcomePrepLayout) {
      welcomePrepLayout = layout;
      box.innerHTML = groups.map(group => {
        const choice = group.choice;
        return '<article class="welcome-prep-card"><h3>' + group.backend.toUpperCase() + '</h3>'
          + group.devices.map(g => '<p>' + escapeHtml(gpuMemoryText(g)) + '</p>').join('')
          + '<p class="welcome-prep-note">' + escapeHtml(group.note) + '</p>'
          + (group.backend === 'cuda' ? '<p>使用 NVIDIA 驱动；Faster-Whisper-XXL 自带 CUDA/cuDNN。Qwen CUDA 另需 CUDA 版 PyTorch，安装运行时后会验证。</p>'
            : '<p>需安装显卡厂商的 Vulkan 驱动，无需 CUDA 或 Python；驱动能力仍需实际识别验证。</p>')
          + (group.multiGpu ? '<p>多张显卡的显存不能相加；Vulkan 自动选卡，建议按最保守单卡容量展示。</p>' : '')
          + (group.backend === 'cuda' && group.devices.length > 1 ? '<p>CUDA 建议按默认第 0 张显卡计算。</p>' : '')
          + (group.lowMemory ? '<p class="welcome-prep-warning">当前显存低于 CUDA 建议档位，可改选 Vulkan 轻量模型，或使用云端识别。</p>' : '')
          + (!choice ? '<p>当前没有可推荐的模型，请刷新准备状态。</p>' : '<label>要准备的模型<select data-prep-backend="' + group.backend + '">'
            + group.models.map(m => '<option value="' + m.id + '"' + (m.id === choice.id ? ' selected' : '') + '>'
              + escapeHtml(m.model.name + (m.id === group.preferred && m.fits ? ' · 推荐' : '')) + '</option>').join('')
            + '</select></label><div data-prep-detail="' + group.backend + '"></div>') + '</article>';
      }).join('');
    }
    for (const group of groups) {
      const choice = group.choice;
      const detail = box.querySelector('[data-prep-detail="' + group.backend + '"]');
      if (!choice || !detail) continue;
      const html = '<p>' + escapeHtml(choice.reason) + '</p><p class="' + (choice.fits ? 'welcome-prep-note' : 'welcome-prep-warning')
        + '">' + escapeHtml('建议专用显存至少 ' + (choice.memory / 1024) + ' GiB'
          + (choice.fits ? '；请同时留意当前空闲显存。' : '；当前容量未知、偏低或显卡代际需核对，建议先试短片。')) + '</p>'
        + group.requirements.map(welcomePrepRow).join('');
      if (detail.innerHTML !== html) detail.innerHTML = html;
    }
  }
  async function welcomeRefreshPrep() {
    clearTimeout(welcomePrepTimer);
    const generation = ++welcomePrepGeneration;
    try {
      const r = await fetch('/api/asr/status', { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (!r.ok || j.error) throw Error(j.error || 'HTTP ' + r.status);
      if (generation !== welcomePrepGeneration || !welcomeBlocking) return;
      welcomePrepStatus = j;
      welcomePrepError = '';
      welcomeRenderPrep();
      if (j.downloads?.some(d => d.running) || j.ffmpeg?.download?.running) {
        welcomePrepTimer = setTimeout(welcomeRefreshPrep, 2000);
      }
    } catch (e) {
      if (generation !== welcomePrepGeneration || !welcomeBlocking) return;
      welcomePrepError = '准备状态读取失败：' + (e.message || e) + '。请刷新准备状态。';
      welcomeRenderPrep();
    }
  }
  async function welcomePrepare(key) {
    const item = welcomePrepItems().items.find(i => i.key === key);
    if (!item || item.ready || item.blockedReason || welcomePrepPending.has(key)) return;
    welcomePrepPending.add(key);
    welcomeRenderPrep();
    try {
      const r = await fetch(item.url || '/api/asr/download', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body || {}),
        signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (!r.ok || j.error) throw Error(j.error || 'HTTP ' + r.status);
      welcomePrepError = '';
    } catch (e) {
      welcomePrepError = '准备失败：' + (e.message || e);
    } finally {
      welcomePrepPending.delete(key);
      if (welcomeBlocking) {
        welcomeRenderPrep();
        if (!welcomePrepError) welcomeRefreshPrep();
      }
    }
  }

  function clearWelcomePending() {
    try { document.documentElement?.classList?.remove('sf-welcome-pending'); } catch { /* 旧测试 DOM 没有 documentElement */ }
  }

  const welcomeSelected = () => ({
    cuda: !!(welcomeCuda && welcomeCuda.checked && welcomeCuda.disabled === false),
    vulkan: !!(welcomeVulkan && welcomeVulkan.checked && welcomeVulkan.disabled === false),
  });
  function welcomeAlertText(msg) {
    if (!welcomeAlert) return;
    clearTimeout(welcomeAlertClearTimer);
    const text = msg || '';
    if (!welcomeAlertSlot) {
      // 旧模板没有 slot 时退回原来的 display:none 切换。
      welcomeAlert.textContent = text;
      welcomeAlert.hidden = !text;
      return;
    }
    if (text) {
      welcomeAlert.textContent = text;
      welcomeAlert.hidden = false;
      welcomeAlertSlot.classList.add('is-open');
      welcomeAlertSlot.setAttribute('aria-hidden', 'false');
      return;
    }
    welcomeAlertSlot.classList.remove('is-open');
    welcomeAlertSlot.setAttribute('aria-hidden', 'true');
    // 先收起再清文字：高度动画期间内容不突然消失；480ms 与 CSS 的 .44s 对齐。
    welcomeAlertClearTimer = setTimeout(() => {
      if (!welcomeAlertSlot.classList.contains('is-open')) welcomeAlert.textContent = '';
    }, 480);
  }
  function welcomePaintCard(card, input, stateEl, available, detail) {
    if (!card || !input) return;
    input.disabled = !available;
    card.classList.toggle('is-disabled', !available);
    card.setAttribute('aria-disabled', String(!available));
    if (!available) input.checked = false;
    if (stateEl) stateEl.textContent = available ? (detail || '可用') : (detail || '未检测到');
  }
  function welcomeSyncSelection() {
    const sel = welcomeSelected();
    if (welcomeCudaCard) welcomeCudaCard.classList.toggle('is-checked', sel.cuda);
    if (welcomeVulkanCard) welcomeVulkanCard.classList.toggle('is-checked', sel.vulkan);
    if (welcomeGo) welcomeGo.disabled = welcomeBusy || !welcomeHardware || (!sel.cuda && !sel.vulkan);
    welcomeRenderPrep();
    if (!welcomeHardware) {
      welcomeAlertText(welcomeError || '');
      return;
    }
    const anyGpu = !!(welcomeHardware.cuda?.available || welcomeHardware.vulkan?.available);
    if (!anyGpu) {
      welcomeAlertText('未检测到可用的 CUDA / Vulkan 显卡或驱动。本工具不支持 CPU 推理，请安装显卡驱动后点「重新检测」。');
    } else if (!sel.cuda && !sel.vulkan) {
      welcomeAlertText('至少选择 CUDA 或 Vulkan 其中一种。本工具不支持 CPU 推理。');
    } else {
      welcomeAlertText(welcomeError || '');
    }
  }
  function welcomeRender() {
    const hw = welcomeHardware;
    if (!hw) {
      const wait = welcomeError ? '检测失败' : '检测中…';
      welcomePaintCard(welcomeCudaCard, welcomeCuda, welcomeCudaState, false, wait);
      welcomePaintCard(welcomeVulkanCard, welcomeVulkan, welcomeVulkanState, false, wait);
      welcomeSyncSelection();
      return;
    }
    const cudaOk = !!(hw.cuda && hw.cuda.available);
    const vulkanOk = !!(hw.vulkan && hw.vulkan.available);
    welcomePaintCard(welcomeCudaCard, welcomeCuda, welcomeCudaState, cudaOk,
      cudaOk ? gpuMemoryText({ ...hw.cuda, name: hw.cuda.device }) : '未检测到 NVIDIA 显卡');
    const vkDevices = (hw.vulkan && hw.vulkan.devices) || [];
    welcomePaintCard(welcomeVulkanCard, welcomeVulkan, welcomeVulkanState, vulkanOk,
      vulkanOk ? (vkDevices[0] || 'Vulkan 可用') : '未检测到 Vulkan 显卡/驱动');
    welcomeSyncSelection();
  }
  function welcomePreselect() {
    const hw = welcomeHardware;
    if (!hw) return;
    const saved = storedWelcome();
    const server = hw.backends || null;
    const source = (server && (server.cuda || server.vulkan)) ? server : (saved && saved.done ? saved : null);
    const cudaOk = !!(hw.cuda && hw.cuda.available);
    const vulkanOk = !!(hw.vulkan && hw.vulkan.available);
    if (welcomeCuda) welcomeCuda.checked = cudaOk && (source ? !!source.cuda : cudaOk);
    if (welcomeVulkan) welcomeVulkan.checked = vulkanOk && (source ? !!source.vulkan : vulkanOk);
  }
  async function welcomeLoad(force) {
    if (!welcomeView) return;
    const generation = ++welcomeLoadGeneration;
    welcomeHardware = null;
    welcomeError = '';
    welcomeBusy = true;
    if (welcomeGo) welcomeGo.disabled = true;
    if (welcomeRetry) welcomeRetry.disabled = true;
    if (welcomeCudaState) welcomeCudaState.textContent = '检测中…';
    if (welcomeVulkanState) welcomeVulkanState.textContent = '检测中…';
    welcomeAlertText('');
    welcomeRenderPrep();
    try {
      const r = await fetch('/api/asr/hardware' + (force ? '?refresh=1' : ''), { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (generation !== welcomeLoadGeneration || !welcomeBlocking) return;
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
      welcomeHardware = j;
      welcomePreselect();
    } catch (e) {
      if (generation !== welcomeLoadGeneration || !welcomeBlocking) return;
      welcomeError = '硬件检测失败：' + ((e && e.message) || e) + '。请点「重新检测」再试。';
    } finally {
      if (generation === welcomeLoadGeneration && welcomeBlocking) {
        welcomeBusy = false;
        if (welcomeRetry) welcomeRetry.disabled = false;
        welcomeRender();
        if (welcomeError) welcomeAlertText(welcomeError);
      }
    }
  }
  function welcomeShow(opts) {
    if (!welcomeView) return;
    clearWelcomePending();
    const o = opts || {};
    welcomeFirstRun = !!o.firstRun;
    welcomeReturnHash = o.returnHash || '';
    welcomeBlocking = true;
    document.body.classList.add('sf-welcome-open');
    document.body.dataset.workspace = 'welcome';
    const app = $('#app'); if (app) app.inert = true;
    welcomeView.hidden = false;
    welcomeView.classList.remove('is-open');
    void welcomeView.offsetWidth;
    welcomeView.classList.add('is-open');
    if (welcomeCancel) welcomeCancel.hidden = welcomeFirstRun;
    const step = $('#welcome-step');
    if (step) step.textContent = welcomeFirstRun ? '首次设置' : '加速方式';
    welcomeCuda.checked = false; welcomeVulkan.checked = false;
    welcomeHardware = null;
    welcomeRender();
    welcomePrepStatus = null;
    welcomePrepError = '';
    welcomeRefreshPrep();
    welcomeLoad(true).then(() => {
      if (!welcomeBlocking) return;
      const target = welcomeCuda && !welcomeCuda.disabled ? welcomeCuda
        : welcomeVulkan && !welcomeVulkan.disabled ? welcomeVulkan
        : (welcomeRetry || welcomeGo);
      if (target) target.focus({ preventScroll: true });
    });
  }
  function welcomeHide() {
    if (!welcomeView) return;
    clearWelcomePending();
    welcomeBlocking = false;
    clearTimeout(welcomePrepTimer);
    welcomePrepGeneration++;
    welcomeLoadGeneration++;
    document.body.classList.remove('sf-welcome-open');
    const app = $('#app'); if (app) app.inert = false;
    welcomeView.hidden = true;
    welcomeView.classList.remove('is-open');
    welcomeAlertText('');
  }
  async function welcomeContinue() {
    const sel = welcomeSelected();
    if (welcomeBusy || !welcomeHardware || (!sel.cuda && !sel.vulkan)) return;
    const label = welcomeGo ? welcomeGo.textContent : '';
    welcomeBusy = true;
    if (welcomeGo) { welcomeGo.disabled = true; welcomeGo.textContent = '保存中…'; }
    const target = welcomeReturnHash || (['#/dashboard', '#/home', '#/settings', '#/new'].includes(location.hash) ? location.hash : '#/dashboard');
    try {
      const r = await fetch('/api/asr/backends', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cuda: sel.cuda, vulkan: sel.vulkan }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      try {
        localStorage.setItem(WELCOME_KEY, JSON.stringify({ done: true, cuda: sel.cuda, vulkan: sel.vulkan, at: Date.now() }));
        localStorage.setItem('sf-welcome-synced', '1');
      } catch { /* 隐私模式/禁用存储：服务端已保存，本次照常进入 */ }
      welcomeHide();
      genAsr = null;
      latestAsrStatus = null;
      welcomeReturnHash = '';
      if (location.hash === target) applyHash();
      else location.hash = target;
      // 设置页原地打开欢迎界面时，previousRoute 已经是 #/settings，applyHash 不会重载；
      // 这里显式刷新一次模型/加速卡，保证返回后立刻看到过滤结果。
      if (target === '#/settings') { loadSettings(); renderAsrModels(); }
      else refreshAsrStatus(true);
      if (typeof toast === 'function') toast(sel.cuda && sel.vulkan ? '已启用 CUDA + Vulkan' : sel.cuda ? '已启用 CUDA' : '已启用 Vulkan', 2600);
    } catch (e) {
      welcomeError = '保存失败：' + ((e && e.message) || e);
      welcomeAlertText(welcomeError);
    } finally {
      welcomeBusy = false;
      if (welcomeGo) { welcomeGo.textContent = label; welcomeSyncSelection(); }
    }
  }

  /** 设置页的「加速方式」卡：显示当前勾选 / 硬件，并提供回到欢迎界面的入口。 */
  function renderAccelCard(d) {
    const box = $('#st-accel-chips');
    if (!box) return;
    const hw = (d && d.hardware) || welcomeHardware;
    const b = activeBackends(d);
    if (!hw) {
      box.innerHTML = '<span class="spin"></span>检测中…';
      const note = $('#st-accel-note');
      if (note) note.textContent = '';
      return;
    }
    const chips = [];
    const chip = (label, on, detail, warn) => `<span class="sf-accel-chip ${warn ? 'warn' : on ? 'on' : 'off'}"><b>${esc(label)}</b>${detail ? ' · ' + esc(detail) : ''}</span>`;
    const cudaHw = !!(hw.cuda && hw.cuda.available);
    const vkHw = !!(hw.vulkan && hw.vulkan.available);
    const npuHw = !!(hw.npu && hw.npu.available);
    chips.push(chip('CUDA', !!(b && b.cuda) && cudaHw,
      b && b.cuda && !cudaHw ? '已勾选，未检测到 N 卡' : (cudaHw ? (hw.cuda.device || '可用') : '未检测到'),
      !!(b && b.cuda) && !cudaHw));
    chips.push(chip('Vulkan', !!(b && b.vulkan) && vkHw,
      b && b.vulkan && !vkHw ? '已勾选，未检测到 Vulkan' : (vkHw ? ((hw.vulkan.devices || [])[0] || '可用') : '未检测到'),
      !!(b && b.vulkan) && !vkHw));
    if (npuHw) chips.push(chip('NPU', true, (hw.npu.devices || [])[0] || '可用'));
    box.innerHTML = chips.join('');
    const note = $('#st-accel-note');
    if (note) {
      if (!b) note.textContent = '还没完成首次设置，点右侧重新进入欢迎界面。';
      else if ((b.cuda && !cudaHw) || (b.vulkan && !vkHw)) note.textContent = '当前勾选与硬件不一致，请重新配置。';
      else note.textContent = '只显示已勾选的后端；NPU 按硬件显示；旧版本下错的模型收进「其它模型」。';
    }
  }

  function initWelcome() {
    if (!welcomeView) { clearWelcomePending(); return; }
    const st = storedWelcome();
    if (st && st.done && (st.cuda || st.vulkan)) {
      clearWelcomePending();
      // 旧版本 localStorage 里已有勾选、服务端还没有 backends：静默同步一次。
      let synced = true;
      try { synced = !!localStorage.getItem('sf-welcome-synced'); } catch {}
      if (!synced) {
        fetch('/api/asr/backends', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cuda: !!st.cuda, vulkan: !!st.vulkan }),
        }).then((r) => { if (r.ok) { try { localStorage.setItem('sf-welcome-synced', '1'); } catch {} } }).catch(() => {});
      }
    } else {
      welcomeShow({ firstRun: true });
    }
    welcomeCuda?.addEventListener('change', welcomeSyncSelection);
    welcomeVulkan?.addEventListener('change', welcomeSyncSelection);
    $('#welcome-prep-refresh')?.addEventListener('click', welcomeRefreshPrep);
    $('#welcome-prep')?.addEventListener('change', e => {
      if (!e.target.dataset.prepBackend) return;
      welcomePrepChoices[e.target.dataset.prepBackend] = e.target.value;
      welcomeRenderPrep();
    });
    $('#welcome-prep')?.addEventListener('click', e => {
      const button = e.target.closest('[data-prep-key]');
      if (button && !button.disabled) welcomePrepare(button.dataset.prepKey);
    });
    welcomeGo?.addEventListener('click', welcomeContinue);
    welcomeRetry?.addEventListener('click', () => welcomeLoad(true));
    welcomeCancel?.addEventListener('click', () => { welcomeHide(); applyHash(); renderAsrModels(); });
    document.addEventListener('keydown', (e) => {
      if (!welcomeBlocking) return;
      if (e.key === 'Escape' && !welcomeFirstRun) { e.preventDefault(); welcomeHide(); applyHash(); }
      if (e.key === 'Enter' && e.target === welcomeView) { e.preventDefault(); if (!welcomeGo?.disabled) welcomeContinue(); }
    });
    $('#st-accel-open')?.addEventListener('click', () => welcomeShow({ returnHash: location.hash || '#/settings' }));
    window.__sfWelcome = {
      open: (opts) => welcomeShow(opts || {}),
      state: () => ({ blocking: welcomeBlocking, hardware: welcomeHardware, selected: welcomeSelected() }),
      close: () => { welcomeHide(); applyHash(); },
    };
  }
  initWelcome();

  return {
    openProject, detachProject, flushSave, saveNow,
    applyHash,
    scheduleSave,                                    // main.js 在数据变化后调
    getProject: () => state.project
  };
}
