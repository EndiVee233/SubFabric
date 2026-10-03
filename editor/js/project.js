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
import { t } from './i18n.js';
import { ico } from './icons.js';

export function initProjects(ctx) {
  const { state, video, timeline, panel, toast, routeSub, loadVideoUrl, setPlaybackAudioMode, resumeRerecog } = ctx;
  const $ = (s) => document.querySelector(s);

  let lastSavedText = '';      // 上次保存成功的字幕内容(脏检查用)
  let saveTimer = 0;
  let saving = false;
  let pollTimer = 0;

  const elHome = $('#home-view');
  const elList = $('#home-list');
  const elEmpty = $('#home-empty');
  const pageTimers = new WeakMap();
  let previousRoute = '';
  let settingsReturnRoute = '#/home';
  let settingsVisit = 0;
  let settingsOpenedFromApp = false;
  let newOpenedFromApp = false;

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
    if (settingsOpenedFromApp) history.back();
    else replaceRoute(settingsReturnRoute === '#/settings' ? '#/home' : settingsReturnRoute);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let infoProjectId = '';
  const infoOverlay = $('#info-overlay');
  const infoForm = $('#info-form');
  const infoName = $('#info-name');
  const infoError = $('#info-error');
  const infoSave = $('#info-save');
  function openInfoEditor(project) {
    infoProjectId = project.id;
    infoName.value = project.name || '';
    infoError.textContent = '';
    infoError.hidden = true;
    infoOverlay.hidden = false;
    requestAnimationFrame(() => { infoName.focus(); infoName.select(); });
  }
  function closeInfoEditor() {
    infoOverlay.hidden = true;
    infoProjectId = '';
    infoError.textContent = '';
    infoError.hidden = true;
  }
  $('#info-cancel').addEventListener('click', closeInfoEditor);
  infoOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === infoOverlay && !infoSave.disabled) closeInfoEditor();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !infoOverlay.hidden && !infoSave.disabled) closeInfoEditor();
  });
  infoForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = infoProjectId;
    const name = infoName.value.trim();
    if (!id || !name) {
      infoError.textContent = '项目名称不能为空';
      infoError.hidden = false;
      infoName.focus();
      return;
    }
    const oldLabel = infoSave.textContent;
    infoSave.disabled = true;
    infoSave.textContent = '保存中…';
    infoError.textContent = '';
    infoError.hidden = true;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/info`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        infoError.textContent = result.error || '保存失败，请重试';
        infoError.hidden = false;
        return;
      }
      if (state.project && state.project.id === id && state.project.meta) {
        state.project.meta.name = result.name || name;
        state.project.meta.nameCustomized = true;
        state.project.meta.modifiedAt = result.modifiedAt || state.project.meta.modifiedAt;
      }
      closeInfoEditor();
      renderList();
      toast('项目信息已更新');
    } catch {
      infoError.textContent = '保存失败，请检查本地服务后重试';
      infoError.hidden = false;
    } finally {
      infoSave.disabled = false;
      infoSave.textContent = oldLabel;
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
      const busyPrep = !!(p.prepare && p.prepare.status === 'running');
      const busyDraft = !!(dr && dr.status === 'running');
      const hasSub = !!p.format;

      // 有初稿任务时以初稿进度为准(它是 prepare 之后的后半段)
      let stChip = '', draftBar = '', progBtn = '';
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
        progBtn = '<button type="button" class="btn pc-prog">查看进度</button>';
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
          <button type="button" class="btn pc-edit" title="编辑项目名称">编辑信息</button>
          <button type="button" class="btn btn-accent pc-open" ${locked ? 'disabled' : ''}>打开</button>
          <button type="button" class="btn pc-del ico-only" title="删除项目（音频、波形、字幕副本一起删）">${ico('trash')}</button>
        </div>`;
      card.querySelector('.pc-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        openInfoEditor(p);
      });
      card.querySelector('.pc-open').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!locked) location.hash = '#/project/' + p.id;
      });
      card.addEventListener('click', () => { if (!locked) location.hash = '#/project/' + p.id; });
      const pb = card.querySelector('.pc-prog');
      if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); openProgress(p.id); });
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

  const dpOverlay = $('#dp-overlay');
  let dpTimer = 0, dpId = '', dpRunning = false, dpRetryable = false;
  function stopDp() { clearInterval(dpTimer); dpTimer = 0; }
  function closeDp() { stopDp(); dpOverlay.hidden = true; }
  $('#dp-close').addEventListener('click', closeDp);
  dpOverlay.addEventListener('pointerdown', (e) => { if (e.target === dpOverlay) closeDp(); });

  function renderDpSteps(curIdx) {
    $('#dp-steps').innerHTML = DP_STEPS.map((s, i) => {
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
    dpOverlay.hidden = false;
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
    openProgress(id);
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

  async function loadSettings() {
    loadFetchSettings();
    loadCastSettings();
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
      return;
    }
    stPresets = data.presets || [];
    $('#st-provider').innerHTML = stPresets
      .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const c = data.cfg || {};
    $('#st-provider').value = c.provider || 'custom';
    $('#st-baseurl').value = c.baseUrl || '';
    $('#st-key').value = c.apiKey || '';
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
  }
  /** 模型管理: 列出所有识别模型(状态/下载/删除) + whisper.cpp 运行时 */
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
    const stateHtml = (st, okText) => st.running
      ? `<span class="sm-state running">${esc(st.msg || '下载中…')} ${st.pct || 0}%</span>`
      : (st.error ? `<span class="sm-state" style="color:var(--danger)">${esc(st.msg || st.error)}</span>`
                  : `<span class="sm-state ok">${okText}</span>`);
    // Python 环境(Parakeet 需要; whisper.cpp 不需要): 预检状态 + 一键安装
    const py = d.pythonProbe || null;
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
    </div>`;
    // 各任务 key: model:<id> / runtime / diarize
    rows += (d.models || []).map((m) => {
      const st = dlOf('model:' + m.id);
      const rtSt = m.needRuntime ? dlOf('runtime') : {};
      const dlThis = st.running || (m.needRuntime && rtSt.running);
      // 无对应 GPU 环境连下载都拦: Parakeet 要 CUDA 版 sherpa-onnx; NeMo 多说话人模型只给 N 卡用户
      const pyBlocked = (m.engine === 'sherpa-onnx' && d.provider !== 'cuda')
        || (m.engine === 'nemo' && !d.gpu);
      let state, btn = '';
      if (m.cloud) {
        // 云端模型没有本地文件: 不给"下载/删除"按钮, 只说清代价(要联网 + 音频会传出去)
        state = '<span class="sm-state ok">✓ 云端识别（免下载 · 免显卡 · 需要联网）</span>';
      } else if (st.running || (m.needRuntime && rtSt.running)) {
        state = `<span class="sm-state running">${esc((st.running ? st.msg : rtSt.msg) || '下载中…')} ${(st.running ? st.pct : rtSt.pct) || 0}%</span>`;
      } else if (st.error) {
        state = `<span class="sm-state" style="color:var(--danger)">${esc(st.msg || st.error)}</span>`;
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
    let nemoState;
    if (nemoSt.running) nemoState = `<span class="sm-state running">${esc(nemoSt.msg || '安装中…')} ${nemoSt.pct || 0}%</span>`;
    else if (nemoSt.error) nemoState = `<span class="sm-state" style="color:var(--danger)">${esc(nemoSt.msg || nemoSt.error)}</span>`;
    else if (nemo.ok && nemo.cuda) nemoState = `<span class="sm-state ok">✓ 可用（${esc(nemo.msg || '')}${nemo.gpu ? ' · ' + esc(nemo.gpu) : ''}）</span>`;
    else if (nemo.ok) nemoState = '<span class="sm-state" style="color:var(--danger)">装到的是 CPU 版 PyTorch，多说话人模型在 CPU 上跑不了。点「重新安装」换 CUDA 版</span>';
    else nemoState = `<span class="sm-state">未安装 · 约 5GB（PyTorch + NeMo）${nemo.msg ? ' · ' + esc(nemo.msg) : ''}</span>`;
    const nemoBtn = (nemoSt.running || (nemo.ok && nemo.cuda)) ? ''
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
    settingsReturnRoute = location.hash === '#/new' ? '#/new'
      : location.hash.startsWith('#/project/') || location.hash === '#/editor' ? location.hash : '#/home';
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
  function glRowCount() {
    return GL_LANGS.reduce((n, l) => n + glState.terms[l].filter(([a, b]) => a && b).length, 0);
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
    return {
      provider: $('#st-provider').value,
      baseUrl: $('#st-baseurl').value.trim(),
      apiKey: $('#st-key').value.trim(),
      model: $('#st-model').value.trim(),
      batchSize: parseInt(($('#st-batch') || {}).value, 10) || 25,     // 每批行数(服务端还会夹到 5~100)
      prompt: $('#st-prompt').value,
      glossary: glSerialize(),
      glossaryLang: glState.lang,
    };
  }
  async function postSettings() {
    const payload = await collectSettings();     // collectSettings 会顺带保存识别提示词(异步)
    const r = await fetch('/api/translate/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const m = await r.json();
    if (!r.ok) throw new Error(m.error || '保存失败');
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
  let npMode = 'import';                 // 'import' | 'draft'
  let asrStatus = { ready: false, modelDir: '', missing: [], pythonOk: false };
  // 浏览器选的视频: File 对象暂存(npMode 提交时经 /api/upload-video 落盘),
  // path 置为 'upload:<name>' 占位 —— npMaybeEnable 只判断 path 非空, 不关心来源
  let npVideoFile = null;

  function npSetMode(mode) {
    npMode = mode;
    $('#np-mode-import').classList.toggle('active', mode === 'import');
    $('#np-mode-import').setAttribute('aria-pressed', String(mode === 'import'));
    $('#np-mode-draft').classList.toggle('active', mode === 'draft');
    $('#np-mode-draft').setAttribute('aria-pressed', String(mode === 'draft'));
    const draft = mode === 'draft';
    $('#np-row-sub').hidden = draft;
  $('#np-row-url').hidden = !draft;      // 链接只在初稿模式有意义（导入模式是本地文件）
    $('#np-row-word').hidden = !draft;
    $('#np-row-spk').hidden = !draft;
    $('#np-model').hidden = !draft;
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

  /** 拉取识别模型状态: 把就绪的模型填进初稿对话框的下拉 */
  async function refreshAsrStatus() {
    try { asrStatus = await (await fetch('/api/asr/status')).json(); }
    catch { asrStatus = { ready: false, models: [] }; }
    const sel = $('#np-model-sel');
    if (sel) {
      // 只能重新识别的模型(如 multitalker)不进创建初稿的下拉 —— 它由「设置 → 重新识别模型」使用
      const ready = (asrStatus.models || []).filter(m => m.ready && m.draftAllowed !== false);
      sel.innerHTML = ready.length
        ? ready.map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('')
        : '<option value="">（没有可用模型，去设置里下载）</option>';
      if (asrStatus.selectedModel && ready.some(m => m.id === asrStatus.selectedModel)) sel.value = asrStatus.selectedModel;
    }
    // Python 环境预检失败 → 提前提醒(不拦按钮: whisper.cpp 引擎不需要 Python, 由服务端预检按引擎分流)
    const hint = $('#np-hint');
    if (hint && asrStatus.pythonProbe && !asrStatus.pythonProbe.ok) {
      hint.textContent = '⚠ Python 环境不可用：' + asrStatus.pythonProbe.msg + '。Parakeet 模型需要 Python（修复方法见创建后的日志）；whisper.cpp 和「必剪 ASR」云端识别都不需要 Python';
      hint.style.color = '#ff9a5c';
    }
    npMaybeEnable();
  }

  function npReset() {
    npVideo.path = npVideo.name = '';
    npSub.name = npSub.text = '';
    npVideoFile = null;
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
    npSetMode('import');
    npSyncSpeakers();       // 逐词默认开 → 说话人可勾; 切到 SRT 时自动取消并禁用
  }
  function npMaybeEnable() {
    const npUrlNow = (($('#np-url') || {}).value || '').trim();
    const hasSource = !!npVideo.path || (npMode === 'draft' && !!npUrlNow);
    if (!hasSource) { $('#np-create').disabled = true; return; }
    // 初稿模式不需要字幕文件, 但必须有可用的识别模型
    const hasModel = npMode !== 'draft' || !!($('#np-model-sel') && $('#np-model-sel').value);
    $('#np-create').disabled = (npMode === 'draft' ? !asrStatus.ready : !npSub.text) || !hasModel;
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
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !$('#confirm-overlay').hidden) return;
    if (location.hash === '#/new') leaveNew();
    else if (location.hash === '#/settings' && !$('#st-save').disabled) returnFromSettings();
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
  $('#np-pick-sub').addEventListener('click', () => $('#np-file-sub').click());
  $('#np-file-sub').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    npSub.name = f.name; npSub.text = await f.text();
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
  $('#np-create').addEventListener('click', async () => {
    const isDraft = npMode === 'draft';
    const npUrl = (($('#np-url') || {}).value || '').trim();
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
      const payload = { name: $('#np-name').value.trim(), video: { path: npVideo.path, name: npVideo.name } };
      if (isDraft) {
        payload.draft = true;
        payload.wordLevel = !!$('#np-word').checked;
        payload.modelId = $('#np-model-sel') ? $('#np-model-sel').value : '';
        payload.speakers = !!($('#np-speakers') && $('#np-speakers').checked);
        payload.speakerCount = parseInt($('#np-spk-count') ? $('#np-spk-count').value : '', 10) || 6;
        // 勾了「区分说话人」→ 编辑器的「启用角色标注」帮用户打开(字幕里会带 [SPKn] 标签, 禁着没意义)
        if (payload.speakers) localStorage.setItem('ss-role-annot', '1');
      } else {
        payload.subtitle = { name: npSub.name, text: npSub.text };
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
    if (!location.hash || !['#/home', '#/new', '#/settings', '#/editor'].includes(h) && !h.startsWith('#/project/')) {
      h = '#/home';
      history.replaceState(null, '', h);
    }
    $('#app').inert = h === '#/home' || h === '#/new' || h === '#/settings';
    setPageVisible(elHome, h === '#/home');
    setPageVisible(npView, h === '#/new');
    setPageVisible(stView, h === '#/settings');
    if (h.startsWith('#/project/')) {
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
      if (previousRoute !== '#/settings' && previousRoute !== '#/new') npReset();
      if (previousRoute === '#/settings') refreshAsrStatus();
      if (previousRoute !== h) focusPage(npView);
    } else if (h === '#/settings') {
      if (previousRoute !== h) {
        settingsVisit++;
        if (previousRoute.startsWith('#/project/') || previousRoute === '#/editor') {
          video.pause();
          if (state.project) saveNow();
        }
        const label = settingsReturnRoute === '#/new' ? '返回新建项目'
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
