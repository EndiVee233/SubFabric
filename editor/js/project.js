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
      const stChip = st ? ` <span class="pc-st st-${p.prepare.status}">${st}</span>` : '';
      card.innerHTML = `
        <span class="pc-badge ${p.format === 'srt' ? 'srt' : ''}">${p.format === 'srt' ? 'SRT' : 'ASS'}</span>
        <div class="pc-main">
          <div class="pc-name">${esc(p.name)}${p.videoExists ? '' : ' <span class="pc-missing">⚠ 视频丢失</span>'}${stChip}</div>
          <div class="pc-meta">${esc(p.video && p.video.name || '无视频')} · ${esc(p.subName || '无字幕')} · 修改于 ${fmtDate(p.modifiedAt)}</div>
        </div>
        <div class="pc-actions">
          <button type="button" class="btn btn-accent pc-open">打开</button>
          <button type="button" class="btn pc-del" title="删除项目(含音频/波形/字幕副本)">🗑</button>
        </div>`;
      card.querySelector('.pc-open').addEventListener('click', () => { location.hash = '#/project/' + p.id; });
      card.addEventListener('click', () => { location.hash = '#/project/' + p.id; });
      card.querySelector('.pc-del').addEventListener('click', (e) => {
        e.stopPropagation();
        panel.showConfirm('删除项目',
          `确定删除项目「${p.name}」？\n项目内的字幕副本、音频与波形数据将一并删除（不影响原始字幕文件与视频文件）。`,
          '删除', '取消', async () => {
            const r = await fetch('/api/projects/' + p.id, { method: 'DELETE' });
            if (r.ok) {
              if (state.project && state.project.id === p.id) detachProject();
              renderList();
              toast('已删除项目「' + p.name + '」');
            } else toast('删除失败', 3000);
          });
      });
      elList.appendChild(card);
    }
  }

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
  function npReset() {
    npVideo.path = npVideo.name = '';
    npSub.name = npSub.text = '';
    $('#np-name').value = '';
    $('#np-video-name').textContent = '未选择';
    $('#np-video-name').classList.remove('filled');
    $('#np-sub-name').textContent = '未选择';
    $('#np-sub-name').classList.remove('filled');
    $('#np-create').disabled = true;
  }
  function npMaybeEnable() { $('#np-create').disabled = !(npVideo.path && npSub.text); }
  function openCreateDialog() { npReset(); npOverlay.hidden = false; $('#np-name').focus(); }

  $('#btn-new-project').addEventListener('click', openCreateDialog);
  $('#np-cancel').addEventListener('click', () => { npOverlay.hidden = true; });
  npOverlay.addEventListener('pointerdown', (e) => { if (e.target === npOverlay) npOverlay.hidden = true; });
  $('#np-mode-draft').addEventListener('click', () => toast('「创建初稿」需要语音识别模型，将在后续版本提供', 3200));

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
    const btn = $('#np-create');
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      const r = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#np-name').value.trim(),
          video: { path: npVideo.path, name: npVideo.name },
          subtitle: { name: npSub.name, text: npSub.text }
        })
      });
      const m = await r.json();
      if (!r.ok) { toast(m.error || '创建失败', 4000); return; }
      npOverlay.hidden = true;
      lastSavedText = npSub.text;
      location.hash = '#/project/' + m.id;
      toast('项目已创建，正在后台提取音频与波形…', 4000);
    } catch (e) {
      toast('创建失败: ' + e.message, 3600);
    } finally {
      btn.textContent = '创建项目';
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
