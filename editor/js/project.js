/* ═══════════ 项目系统 ═══════════
 * 主界面(项目列表 + 新建) / 打开项目 / 字幕实时自动保存 / 波形与音频的项目内缓存。
 * 存储(服务端 projects/<id>/):
 *   project.json   元数据(名称/视频路径/字幕文件/prepare 状态)
 *   subtitle.ass|srt  字幕权威内容(自动保存写这里)
 *   audio.wav      16kHz 单声道(给后续"重新识别"铺路)
 *   peaks.bin      波形包络(打开时直接读, 不再重新生成)
 * 路由: #/home 主界面 · #/project/<id> 编辑器 · #/editor 无项目直开(兼容旧用法/测试)
 */
import { serializeSRT } from './srt.js';

export function initProjects(ctx) {
  const { state, video, timeline, panel, toast, routeSub, loadVideoUrl } = ctx;
  const $ = (s) => document.querySelector(s);

  let lastSavedText = '';      // 上次保存成功的字幕内容(脏检查用)
  let saveTimer = 0;
  let saving = false;
  let pollTimer = 0;

  const elHome = $('#home-view');
  const elList = $('#home-list');
  const elEmpty = $('#home-empty');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      timeline.setPeaks({ data, rate: parseFloat(r.headers.get('X-Peak-Rate') || '100') });
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
  function pollPrepare() {
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
        toast('音频与波形已就绪', 2600);
      } else if (st === 'error') {
        clearInterval(pollTimer); pollTimer = 0;
        toast('音频/波形提取失败: ' + ((m.prepare && m.prepare.error) || ''), 4200);
      }
    }, 1500);
  }

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
  }

  function promptRelink(m) {
    panel.showConfirm('找不到视频文件',
      `项目「${m.name}」关联的视频已不在原位置：\n${(m.video && m.video.path) || ''}\n\n重新选择视频即可继续（字幕与波形数据不受影响）。`,
      '重新选择视频', '暂不', () => pickVideoForProject());
  }
  async function pickVideoForProject() {
    let pick;
    try {
      pick = await (await fetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'video' })
      })).json();
    } catch { toast('无法打开系统文件对话框', 3200); return; }
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
    elHome.hidden = false;
    video.pause();
    if (state.project) { saveNow(); }               // 离开编辑器: 把未保存的立刻写掉
    renderList();
  }
  let listPoll = 0;
  async function renderList() {
    elList.innerHTML = '<div class="home-loading">读取中…</div>';
    elEmpty.hidden = true;
    let data;
    try { data = await (await fetch('/api/projects')).json(); }
    catch { elList.innerHTML = '<div class="home-loading">读取失败（本地服务未启动？）</div>'; return; }
    const ps = data.projects || [];
    elList.innerHTML = '';
    elEmpty.hidden = ps.length > 0;
    const ST = { running: '提取中', none: '待提取', error: '提取失败' };
    for (const p of ps) {
      const card = document.createElement('div');
      card.className = 'proj-card' + (p.videoExists ? '' : ' proj-missing');
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
        draftBar = `
          <div class="pc-draft ${esc(dr.status)}">
            <div class="pc-draft-bar"><div class="pc-draft-bar-in" style="width:${pct}%"></div></div>
            <div class="pc-draft-txt"><span>${esc(dr.message || label)}</span><span class="pct">${pct}%</span></div>
          </div>`;
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
      card.innerHTML = `
        <span class="pc-badge ${fmt === 'srt' ? 'srt' : ''}">${badge}</span>
        <div class="pc-main">
          <div class="pc-name">${esc(p.name)}${p.videoExists ? '' : ' <span class="pc-missing">⚠ 视频丢失</span>'}${stChip}</div>
          <div class="pc-meta">${esc(p.video && p.video.name || '无视频')} · ${esc(p.subName || (dr ? '初稿处理中…' : '无字幕'))} · 修改于 ${fmtDate(p.modifiedAt)}</div>
          ${draftBar}
        </div>
        <div class="pc-actions">
          ${progBtn}
          <button type="button" class="btn btn-accent pc-open" ${locked ? 'disabled' : ''}>打开</button>
          <button type="button" class="btn pc-del" title="删除项目(含音频/波形/字幕副本)">🗑</button>
        </div>`;
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
          `确定删除项目「${p.name}」？\n项目内的字幕副本、音频与波形数据将一并删除（不影响原始字幕文件与视频文件）。`,
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

    // 有任务在跑就自动刷新, 让列表上的进度自己往前走
    clearTimeout(listPoll);
    if (ps.some(p => (p.prepare && p.prepare.status === 'running') || (p.draft && p.draft.status === 'running'))) {
      listPoll = setTimeout(() => renderList(), 1500);
    }
  }

  /* ─────────── 初稿进度浮层 ─────────── */
  // 步骤条：与 server.js 的 STAGE 文案一一对应。
  // enabled=false 的是尚未实现的步骤（灰显）；skippable 只对可选步骤为真 ——
  // **语音识别与 LLM 翻译不可跳过**。
  // 与 server.js 的 SKIP_AFTER_RETRIES 保持一致：手动续跑满这次数仍不成功就放开「跳过此步」
  const SKIP_AFTER_RETRIES = 3;
  const DP_STEPS = [
    // skipAfterRetries = 重试满 N 次仍失败后允许跳过；语音识别永远不可跳
    { name: '语音识别', enabled: true, skippable: false, skipAfterRetries: false, stages: ['提取音频中', 'ASR识别中'] },
    { name: '说话人分离', enabled: true, skippable: true, skipAfterRetries: true, stages: ['区分说话人中'] },
    { name: 'LLM语义分句', enabled: true, skippable: true, skipAfterRetries: true, stages: ['语义分句中'] },
    { name: 'LLM翻译', enabled: true, skippable: false, skipAfterRetries: true, stages: ['翻译中'] },
    { name: '完毕', enabled: true, skippable: false, skipAfterRetries: false, stages: ['完毕'] },
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
          : `重试满 ${SKIP_AFTER_RETRIES} 次仍失败后才放开（已重试 ${retries} 次）`);
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
      toast(d2.resegSkipped ? '已跳过语义分句：按标点/停顿兜底切句，流水线继续'
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
      logEl.textContent = m.log;
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
  const stOverlay = $('#st-overlay');
  let stPresets = [];

  async function openSettings() {
    stOverlay.hidden = false;
    const msgEl = $('#st-msg');
    msgEl.textContent = '';
    msgEl.classList.remove('err');
    let data;
    try { data = await (await fetch('/api/translate/config')).json(); }
    catch { toast('读取设置失败（本地服务未启动？）', 3200); return; }
    stPresets = data.presets || [];
    $('#st-provider').innerHTML = stPresets
      .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const c = data.cfg || {};
    $('#st-provider').value = c.provider || 'custom';
    $('#st-baseurl').value = c.baseUrl || '';
    $('#st-key').value = c.apiKey || '';
    $('#st-model').value = c.model || '';
    $('#st-prompt').value = c.prompt || data.defaultPrompt || '';
    $('#st-auto').checked = !!c.autoTranslate;
    renderAsrModels();
  }
  /** 模型管理: 列出所有识别模型(状态/下载/删除) + whisper.cpp 运行时 */
  async function renderAsrModels() {
    const box = $('#st-models');
    if (!box) return;
    let d;
    try { d = await (await fetch('/api/asr/status')).json(); }
    catch { box.innerHTML = '<div class="st-row">读取失败</div>'; return; }
    const dl = d.download || {};
    const rows = (d.models || []).map((m) => {
      const dlThis = dl.running && (dl.modelId === m.id || (dl.kind === 'runtime' && m.needRuntime));
      let state, btn = '';
      if (dlThis) state = `<span class="sm-state running">${esc(dl.msg || '下载中…')} ${dl.pct || 0}%</span>`;
      else if (m.ready) state = '<span class="sm-state ok">✓ 已就绪</span>';
      else state = `<span class="sm-state">未下载 · ${m.sizeMB} MB</span>`;
      if (dlThis) btn = '';
      else if (m.ready) btn = `<button type="button" class="btn btn-mini sm-del" data-id="${esc(m.id)}" title="删除模型文件（释放磁盘）">删除</button>`;
      else btn = `<button type="button" class="btn btn-mini sm-dl" data-id="${esc(m.id)}">下载</button>`;
      const rt = (m.needRuntime && !dlThis) ? '<div class="sm-runtime">需要 whisper.cpp 运行时（约 12MB，首次自动下载）</div>' : '';
      return `<div class="sm-model">
        <div class="sm-head"><span class="sm-name">${esc(m.name)}</span>${btn}</div>
        <div class="sm-desc">${esc(m.desc || '')}</div>
        ${state}${rt}
      </div>`;
    }).join('');
    // 说话人分离模型(两个文件一组, ~32MB): 初稿勾选「区分说话人」时需要
    const dz = d.diarize || {};
    const dzDl = dl.running && dl.kind === 'diarize';
    const dzBtn = dzDl ? '' : (dz.ready
      ? '<button type="button" class="btn btn-mini sm-del" data-id="diarize" title="删除分离模型文件">删除</button>'
      : '<button type="button" class="btn btn-mini sm-dl" data-id="diarize">下载</button>');
    const dzState = dz.ready ? '<span class="sm-state ok">✓ 已就绪</span>'
      : (dzDl ? `<span class="sm-state running">${esc(dl.msg || '下载中…')} ${dl.pct || 0}%</span>`
              : '<span class="sm-state">未下载 · 32 MB</span>');
    rows += `<div class="sm-model">
      <div class="sm-head"><span class="sm-name">说话人分离</span>${dzBtn}</div>
      <div class="sm-desc">说话人分段 + 说话人嵌入（约 32MB）。初稿勾选「区分说话人」时需要</div>
      ${dzState}
    </div>`;
    box.innerHTML = rows || '<div class="st-row">无可用模型</div>';
    box.querySelectorAll('.sm-dl').forEach(b => b.addEventListener('click', () => downloadModel(b.dataset.id)));
    box.querySelectorAll('.sm-del').forEach(b => b.addEventListener('click', () => {
      panel.showConfirm('删除模型',
        '确定删除该模型的文件吗？（不影响已生成的字幕；之后可重新下载）',
        '删除', '取消', async () => {
          await fetch('/api/asr/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: b.dataset.id })
          });
          renderAsrModels();
        });
    }));
    // whisper.cpp 运行时: 需要 ggml 模型但运行时缺失时显示下载按钮
    const note = $('#st-model-note');
    const needRt = (d.models || []).some(m => m.needRuntime);
    if (needRt && !dl.running) {
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
      const dl = d.download || {};
      renderAsrModels();
      if (!dl.running) { renderAsrModels(); break; }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  async function downloadModel(id) {
    const body = id === 'diarize' ? { kind: 'diarize' } : { modelId: id };
    await fetch('/api/asr/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    pollModelDownload();
  }
  function closeSettings() { stOverlay.hidden = true; }
  $('#btn-settings').addEventListener('click', openSettings);
  // 编辑器工具栏也有一个设置入口(同一套面板)
  const edSettingsBtn = document.getElementById('btn-settings-ed');
  if (edSettingsBtn) edSettingsBtn.addEventListener('click', openSettings);
  $('#st-close').addEventListener('click', closeSettings);
  $('#st-cancel').addEventListener('click', closeSettings);
  stOverlay.addEventListener('pointerdown', (e) => { if (e.target === stOverlay) closeSettings(); });

  $('#st-provider').addEventListener('change', () => {
    const p = stPresets.find(x => x.id === $('#st-provider').value);
    if (p && p.baseUrl) { $('#st-baseurl').value = p.baseUrl; $('#st-model').value = p.model; }
  });

  function collectSettings() {
    return {
      provider: $('#st-provider').value,
      baseUrl: $('#st-baseurl').value.trim(),
      apiKey: $('#st-key').value.trim(),
      model: $('#st-model').value.trim(),
      prompt: $('#st-prompt').value,
      autoTranslate: $('#st-auto').checked,
    };
  }
  async function postSettings() {
    const r = await fetch('/api/translate/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectSettings())
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
    try {
      const m = await postSettings();
      msgEl.textContent = m.ready ? '✓ 已保存，翻译可用' : '已保存（地址 / Key / 模型名不全，翻译暂不可用）';
      msgEl.classList.remove('err');
      renderList();
      setTimeout(closeSettings, 600);
    } catch (e) {
      msgEl.textContent = '✗ ' + e.message;
      msgEl.classList.add('err');
    }
  });

  function detachProject() {
    clearTimeout(saveTimer);
    clearInterval(pollTimer); pollTimer = 0;
    state.project = null;
    const el = $('#save-state');
    if (el) el.hidden = true;
  }

  /* ─────────── 新建项目对话框 ─────────── */
  const npOverlay = $('#np-overlay');
  const npVideo = { path: '', name: '' };
  const npSub = { name: '', text: '' };
  let npMode = 'import';                 // 'import' | 'draft'
  let asrStatus = { ready: false, modelDir: '', missing: [], pythonOk: false };

  function npSetMode(mode) {
    npMode = mode;
    $('#np-mode-import').classList.toggle('active', mode === 'import');
    $('#np-mode-draft').classList.toggle('active', mode === 'draft');
    const draft = mode === 'draft';
    $('#np-row-sub').hidden = draft;
    $('#np-row-word').hidden = !draft;
    $('#np-row-spk').hidden = !draft;
    $('#np-model').hidden = !draft;
    $('#np-hint').textContent = draft
      ? '创建后会在后台识别语音并生成字幕；进度可在项目列表上查看，不用守着这个窗口'
      : '创建时会自动提取音频与波形存入项目（下次打开免生成）；字幕在编辑过程中实时保存';
    $('#np-create').textContent = draft ? '开始识别' : '创建项目';
    if (draft) refreshAsrStatus();
    npMaybeEnable();
  }

  /** 拉取识别模型状态: 把就绪的模型填进初稿对话框的下拉 */
  async function refreshAsrStatus() {
    try { asrStatus = await (await fetch('/api/asr/status')).json(); }
    catch { asrStatus = { ready: false, models: [] }; }
    const sel = $('#np-model-sel');
    if (sel) {
      const ready = (asrStatus.models || []).filter(m => m.ready);
      sel.innerHTML = ready.length
        ? ready.map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('')
        : '<option value="">（无可用模型，请到设置里下载）</option>';
      if (asrStatus.selectedModel && ready.some(m => m.id === asrStatus.selectedModel)) sel.value = asrStatus.selectedModel;
    }
    npMaybeEnable();
  }

  function npReset() {
    npVideo.path = npVideo.name = '';
    npSub.name = npSub.text = '';
    $('#np-name').value = '';
    $('#np-video-name').textContent = '未选择';
    $('#np-video-name').classList.remove('filled');
    $('#np-sub-name').textContent = '未选择';
    $('#np-sub-name').classList.remove('filled');
    $('#np-create').disabled = true;
    npSetMode('import');
  }
  function npMaybeEnable() {
    if (!npVideo.path) { $('#np-create').disabled = true; return; }
    // 初稿模式不需要字幕文件, 但必须有可用的识别模型
    const hasModel = npMode !== 'draft' || !!($('#np-model-sel') && $('#np-model-sel').value);
    $('#np-create').disabled = (npMode === 'draft' ? !asrStatus.ready : !npSub.text) || !hasModel;
  }
  function openCreateDialog() { npReset(); npOverlay.hidden = false; $('#np-name').focus(); }

  $('#btn-new-project').addEventListener('click', openCreateDialog);
  $('#np-cancel').addEventListener('click', () => { npOverlay.hidden = true; });
  npOverlay.addEventListener('pointerdown', (e) => { if (e.target === npOverlay) npOverlay.hidden = true; });

  $('#np-mode-import').addEventListener('click', () => npSetMode('import'));
  $('#np-mode-draft').addEventListener('click', () => npSetMode('draft'));
  $('#np-word').addEventListener('change', () => {
    $('#np-word-desc').textContent = $('#np-word').checked
      ? '开启 → 生成 ASS 逐词字幕' : '关闭 → 生成 SRT 纯文本字幕';
  });

  $('#np-pick-video').addEventListener('click', async () => {
    let pick;
    try {
      pick = await (await fetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'video' })
      })).json();
    } catch { toast('无法打开系统文件对话框', 3200); return; }
    if (!pick.path) { if (pick.error) toast(pick.error, 3200); return; }
    npVideo.path = pick.path; npVideo.name = pick.name;
    const el = $('#np-video-name');
    el.textContent = pick.name; el.classList.add('filled');
    if (!$('#np-name').value.trim()) $('#np-name').value = pick.name.replace(/\.[^.]+$/, '');
    npMaybeEnable();
  });
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
  $('#np-create').addEventListener('click', async () => {
    const isDraft = npMode === 'draft';
    const btn = $('#np-create');
    btn.disabled = true; btn.textContent = isDraft ? '提交中…' : '创建中…';
    try {
      const payload = { name: $('#np-name').value.trim(), video: { path: npVideo.path, name: npVideo.name } };
      if (isDraft) {
        payload.draft = true;
        payload.wordLevel = !!$('#np-word').checked;
        payload.modelId = $('#np-model-sel') ? $('#np-model-sel').value : '';
        payload.speakers = !!($('#np-speakers') && $('#np-speakers').checked);
        payload.speakerCount = parseInt($('#np-spk-count') ? $('#np-spk-count').value : '', 10) || 6;
      } else {
        payload.subtitle = { name: npSub.name, text: npSub.text };
      }
      const r = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const m = await r.json();
      if (!r.ok) { toast(m.error || '创建失败', 4000); return; }
      npOverlay.hidden = true;
      if (isDraft) {
        renderList();                     // 项目立刻进列表, 进度在卡片上
        toast('已提交，正在后台识别语音 —— 可以先去做别的，进度见项目列表', 5200);
      } else {
        lastSavedText = npSub.text;
        location.hash = '#/project/' + m.id;
        toast('项目已创建，正在后台提取音频与波形…', 4000);
      }
    } catch (e) {
      toast('创建失败: ' + e.message, 3600);
    } finally {
      btn.textContent = npMode === 'draft' ? '开始识别' : '创建项目';
      npMaybeEnable();
    }
  });

  /* ─────────── 路由 ─────────── */
  function applyHash() {
    const h = location.hash || '#/home';
    if (h.startsWith('#/project/')) {
      const pid = h.slice('#/project/'.length);
      elHome.hidden = true;
      if (!state.project || state.project.id !== pid) openProject(pid);
    } else if (h === '#/editor') {
      elHome.hidden = true;                          // 无项目直开编辑器(兼容旧用法)
      if (state.project) { saveNow(); detachProject(); }
    } else {
      if (!location.hash) history.replaceState(null, '', '#/home');   // 归一化地址栏
      showHome();
    }
  }
  window.addEventListener('hashchange', applyHash);
  $('#btn-home').addEventListener('click', () => { location.hash = '#/home'; });

  return {
    applyHash,
    scheduleSave,                                    // main.js 在数据变化后调
    getProject: () => state.project
  };
}
