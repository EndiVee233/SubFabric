import { STUDIO_KEY, normalizeStudio, projectPhase, matchesProject, imageData } from './studio-state.js';
import { escapeHtml as esc, fmtTime } from './util.js';
import { t } from './i18n.js';
import { ico } from './icons.js';
import { shortcuts, comboFromEvent } from './shortcuts.js';

// 所有编辑、导出、识别与保存仍由 main/project.js 负责。此层只接导航和外观。
const $ = id => document.getElementById(id);
const themes = window.SF_THEMES;
let saved;
try { saved = JSON.parse(localStorage.getItem(STUDIO_KEY) || '{}'); } catch { saved = {}; }
let prefs = normalizeStudio(saved, themes);
let projects = [], filter = 'all', folder = '', route = location.hash || '#/home';
let applying = false, pendingSetting = '';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let noticeTimer;
function notice(message) {
  $('sf-notice').textContent = t(message); $('sf-notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('sf-notice').hidden = true; }, 4500);
}
function commit(change) {
  const next = normalizeStudio({ ...prefs, ...change }, themes);
  try { localStorage.setItem(STUDIO_KEY, JSON.stringify(next)); }
  catch { notice('外观或文件夹保存失败，浏览器存储空间可能不足。'); return false; }
  prefs = next; return true;
}
function applyTheme() {
  applying = true;
  const dark = prefs.mode === 'dark' || prefs.mode === 'system' && systemDark.matches;
  const pack = themes.get(prefs.themePack, prefs.custom);
  document.body.dataset.theme = dark ? 'dark' : 'light';
  document.body.dataset.design = pack.design;
  document.body.dataset.themePack = pack.id;
  document.body.dataset.bg = prefs.background;
  document.body.dataset.motion = prefs.motion;
  const tokens = pack.design === 'material' ? themes.palette(prefs.accent, dark) : {
    ...themes.palette(prefs.accent, dark), '--bg': dark ? '#1c221e' : '#f6f7f2', '--surface': dark ? '#252d27' : '#fffefa',
    '--surface-2': dark ? '#2c352e' : '#eef1e8', '--text': dark ? '#e0e6da' : '#28372b', '--muted': dark ? '#b2bdae' : '#647161', '--line': dark ? '#465244' : '#dce2d5'
  };
  // 原控件和 canvas 都从 root 读变量，统一映射为原程序的令牌名。
  window.SSAccent.apply(tokens['--accent']);
  const st = document.documentElement.style;
  Object.entries(tokens).forEach(([k, v]) => st.setProperty(k, v));
  for (const [k, v] of Object.entries({ '--bg-0': tokens['--bg'], '--bg-1': tokens['--surface'], '--bg-2': tokens['--surface-2'], '--bg-3': tokens['--accent-soft'], '--border': tokens['--line'], '--text-0': tokens['--text'], '--text-1': tokens['--muted'], '--text-2': tokens['--muted'], '--zh': tokens['--text'], '--en': tokens['--muted'], '--accent-ink': tokens['--on-accent'] })) st.setProperty(k, v);
  st.colorScheme = dark ? 'dark' : 'light';
  $('sf-background').value = prefs.background; $('sf-mode').value = prefs.mode; $('sf-motion').value = prefs.motion; $('sf-color').value = prefs.accent;
  $('sf-image-pick').disabled = prefs.background !== 'image';
  $('sf-image-clear').disabled = !prefs.image;
  for (const input of document.querySelectorAll('#sf-color, #theme-color, [data-theme-color]')) {
    input.value = prefs.accent;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.querySelectorAll('.theme-sw[data-hex]').forEach(b => b.classList.toggle('active', b.dataset.hex === prefs.accent));
  document.querySelector('.sf-backdrop').style.backgroundImage = prefs.background === 'image' && imageData(prefs.image) ? `url("${prefs.image}")` : 'none';
  window.SF_PROGRESS.sync();
  window.dispatchEvent(new CustomEvent('ss-accent', { detail: { hex: prefs.accent } }));
  window.dispatchEvent(new Event('sf-studio-theme'));
  applying = false;
  renderPacks();
}
// 侧栏取色控件写入新界面独立偏好，不改变旧界面配置。
window.SSAccent.current = () => prefs.accent;
window.SSAccent.set = hex => {
  if (applying) return false;
  if (!themes.hex(hex) || !commit({ accent: hex })) return false;
  applyTheme(); return true;
};
window.SSAccent.reset = () => { const seed = themes.get(prefs.themePack, prefs.custom).seed; if (commit({ accent: seed })) applyTheme(); return seed; };
function renderPacks() {
  $('sf-theme-packs').innerHTML = themes.list(prefs.custom).map(pack => `<button type="button" class="sf-pack" data-pack="${esc(pack.id)}" aria-pressed="${prefs.themePack === pack.id}"><span class="sf-pack-art ${pack.design}" style="--pack-seed:${pack.seed}"><i></i><i></i><i></i></span><b>${esc(pack.name)}</b><small>${esc(pack.description)}</small></button>`).join('');
}
$('sf-theme-packs').addEventListener('click', e => {
  const b = e.target.closest('[data-pack]'); if (!b) return;
  const pack = themes.get(b.dataset.pack, prefs.custom);
  if (commit({ themePack: pack.id, accent: pack.seed })) { applyTheme(); themeStatus(); }
});
function themeStatus() { $('sf-theme-status').textContent = t('外观已保存，刷新后保留。'); }
for (const [id, key] of [['sf-mode', 'mode'], ['sf-background', 'background'], ['sf-motion', 'motion']]) $(id).addEventListener('change', () => {
  if (commit({ [key]: $(id).value })) { applyTheme(); themeStatus(); }
});
$('sf-color').addEventListener('change', () => {
  if (!themes.hex($('sf-color').value)) { notice('主题色需要使用 #RRGGBB 格式。'); return; }
  if (commit({ accent: $('sf-color').value })) { applyTheme(); themeStatus(); }
});
// 同步原有取色控件；不让主题初始化产生递归事件或污染旧 UI 的偏好。
window.addEventListener('ss-accent', e => {
  if (applying || !themes.hex(e.detail?.hex)) return;
  if (commit({ accent: e.detail.hex })) applyTheme();
});
systemDark.addEventListener('change', () => { if (prefs.mode === 'system') applyTheme(); });
window.addEventListener('storage', e => {
  if (e.key !== STUDIO_KEY) return;
  try { prefs = normalizeStudio(JSON.parse(e.newValue || '{}'), themes); applyTheme(); renderFolders(); refreshLibrary(); } catch { /* 保持当前可用界面。 */ }
});
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('sf-theme-export').addEventListener('click', () => download(`${prefs.themePack}.theme.json`, { ...themes.get(prefs.themePack, prefs.custom), seed: prefs.accent }));
$('sf-theme-import').addEventListener('click', () => $('sf-theme-file').click());
$('sf-theme-file').addEventListener('change', async () => {
  const f = $('sf-theme-file').files[0]; $('sf-theme-file').value = ''; if (!f) return;
  try {
    if (f.size > 131072) throw Error('主题包过大。');
    const pack = JSON.parse(await f.text()); if (!themes.valid(pack)) throw Error('主题包格式无效，只支持声明式主题 JSON。');
    let custom = prefs.custom;
    if (!themes.builtins.some(p => p.id === pack.id)) custom = [...custom.filter(p => p.id !== pack.id), pack];
    if (!themes.validList(custom)) throw Error('主题包数量已达上限。');
    if (commit({ custom, themePack: pack.id, accent: pack.seed })) { applyTheme(); themeStatus(); }
  } catch (e) { notice(e.message); }
});
$('sf-image-pick').addEventListener('click', () => $('sf-image-file').click());
$('sf-image-clear').addEventListener('click', () => { if (commit({ image: '', background: 'solid' })) applyTheme(); });
$('sf-image-file').addEventListener('change', async () => {
  const f = $('sf-image-file').files[0]; $('sf-image-file').value = ''; if (!f) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > 2000000) { notice('请选择 2MB 以内的 PNG、JPEG 或 WebP 图片。'); return; }
  try {
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); });
    if (!imageData(data)) throw Error('图片格式无效。');
    if (commit({ image: data, background: 'image' })) applyTheme();
  } catch { notice('图片读取失败。'); }
});

// 常驻真实样式控件在全局设置与编辑器之间移动，监听器和未提交输入原样保留。
// 旧 HTML 的特效组少一个闭合层，浏览器将后续五张卡解析进特效组；
// 新界面先恢复同级关系，否则移动特效卡会把音频、导出设置一起搬走。
const fx = $('ass-fx-group');
let afterFx = fx;
for (const child of [...fx.children].filter(el => el.classList.contains('set-group') || el.classList.contains('setting-note'))) { afterFx.after(child); afterFx = child; }
if ($('fx-status-note').parentElement !== fx) fx.appendChild($('fx-status-note'));
const styleGroups = ['ass-style-group', 'ass-fx-group', 'word-convert-group'].map(id => $(id));
const anchors = styleGroups.map(el => { const a = document.createComment('studio-style-anchor'); el.before(a); return a; });
function moveStyles(global) {
  styleGroups.forEach((el, i) => { if (global) $('sf-ass-mount').appendChild(el); else anchors[i].after(el); });
}
function setting(name, resource = false) {
  pendingSetting = name;
  const next = resource ? '#/resources' : '#/settings';
  if (location.hash === next) selectSetting(name); else location.hash = next;
}
function selectSetting(name) {
  document.querySelector(`.st-tab[data-stp="${name === 'llm' ? 'models' : name}"]`)?.click();
  if (name === 'llm') $('st-entry-llm').click();
  pendingSetting = '';
}
document.querySelectorAll('[data-setting]').forEach(b => b.addEventListener('click', () => setting(b.dataset.setting, route === '#/resources')));
document.querySelectorAll('[data-resource]').forEach(b => b.addEventListener('click', () => setting(b.dataset.resource, true)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.go; }));
for (const id of ['sf-create', 'sf-hero-create']) $(id).addEventListener('click', () => $('btn-new-project').click());
$('sf-direct-editor').addEventListener('click', () => { location.hash = '#/editor'; });
$('sf-ass-open').textContent = t('选择稿件');
$('sf-ass-open').addEventListener('click', () => { filter = 'all'; folder = ''; location.hash = '#/home'; refreshLibrary(); });
$('sf-show-ready').addEventListener('click', () => { filter = 'ready'; folder = ''; refreshLibrary(); });
$('sf-resume-open').addEventListener('click', () => {
  const p = projects.find(p => p.id === prefs.recent && p.format);
  if (p) location.hash = '#/project/' + p.id; else $('btn-new-project').click();
});
// 真实快捷键目前固定；帮助页准确显示当前映射，不承诺不存在的自定义能力。
$('sf-shortcuts').addEventListener('click', () => {
  const box = $('sf-help').querySelector('.sf-help-grid article:nth-child(3)');
  if (box.querySelector('dl')) return;
  const dl = document.createElement('dl');
  const list = [['Space / K', '播放 / 暂停'], ['← / →', '前后跳转 2 秒'], ['Shift + ← / →', '前后跳转 5 秒'], [', / .', '逐帧移动'], ['Home / End', '开头 / 末尾'], ['= / − / 0', '放大 / 缩小 / 适应全片'], ['F', '跟随播放'], ['Alt + ↑ / ↓', '上一句 / 下一句'], ['Alt + P', '选中播放句'], ['Ctrl + Enter', '提交编辑'], ['Ctrl + F', '搜索字幕'], ['Ctrl + S', '导出字幕'], ['F8', '逐词 JSON 导出入口']];
  dl.innerHTML = list.map(([key, value]) => `<div><dt><kbd>${key}</kbd></dt><dd>${t(value)}</dd></div>`).join(''); box.appendChild(dl);
});

function renderFolders() {
  $('sf-folders').innerHTML = prefs.folders.map(f => `<div class="sf-folder"><button type="button" class="${folder === f.id ? 'active' : ''}" data-folder="${f.id}">${ico('folder')}<span>${esc(f.name)}</span><small>${projects.filter(p => prefs.assignments[p.id] === f.id).length}</small></button><button type="button" data-remove-folder="${f.id}" aria-label="移除文件夹">×</button></div>`).join('');
}
$('sf-folder-add').addEventListener('click', () => {
  const name = prompt(t('文件夹名称')); if (!name?.trim()) return;
  if (name.trim().length > 60 || prefs.folders.length >= 40) { notice('文件夹名称最多 60 字，最多 40 个文件夹。'); return; }
  if (commit({ folders: [...prefs.folders, { id: 'f-' + crypto.randomUUID(), name: name.trim() }] })) renderFolders();
});
$('sf-folders').addEventListener('click', e => {
  const f = e.target.closest('[data-folder]'), del = e.target.closest('[data-remove-folder]');
  if (f) { folder = f.dataset.folder; filter = 'all'; location.hash = '#/home'; renderFolders(); refreshLibrary(); }
  if (del && confirm(t('移除文件夹？稿件会回到全部稿件，文件不会删除。'))) {
    const id = del.dataset.removeFolder;
    if (commit({ folders: prefs.folders.filter(f => f.id !== id) })) { if (folder === id) folder = ''; renderFolders(); refreshLibrary(); }
  }
});
$('sf-folders').addEventListener('dragover', e => { if (e.target.closest('[data-folder]')) e.preventDefault(); });
$('sf-folders').addEventListener('drop', e => {
  const f = e.target.closest('[data-folder]'); if (!f) return; e.preventDefault();
  const id = e.dataTransfer.getData('application/x-subfabric-project'); if (!projects.some(p => p.id === id)) return;
  if (commit({ assignments: { ...prefs.assignments, [id]: f.dataset.folder } })) { renderFolders(); refreshLibrary(); notice('稿件已移入文件夹。'); }
});
$('sf-nav').querySelector('[data-route="home"]').addEventListener('click', () => { folder = ''; filter = 'all'; renderFolders(); refreshLibrary(); });
$('sf-filters').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) { filter = b.dataset.filter; refreshLibrary(); } });
$('sf-search').addEventListener('input', refreshLibrary);
$('sf-list-mode').addEventListener('click', () => { if (commit({ view: prefs.view === 'grid' ? 'list' : 'grid' })) refreshLibrary(); });
$('sf-clear-filter').addEventListener('click', () => { filter = 'all'; folder = ''; $('sf-search').value = ''; renderFolders(); refreshLibrary(); });
function refreshLibrary() {
  let visible = 0;
  const current = prefs.folders.find(f => f.id === folder);
  $('sf-library-title').textContent = t(route === '#/tasks' ? '任务中心' : current?.name || '稿件库');
  $('home-view').dataset.list = route === '#/tasks' ? 'list' : prefs.view;
  $('sf-list-mode').setAttribute('aria-pressed', String(prefs.view === 'list'));
  $('sf-list-mode').textContent = t(prefs.view === 'list' ? '卡片视图' : '列表视图');
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  for (const card of $('home-list').querySelectorAll('.proj-card')) {
    const p = projects.find(p => p.id === card.dataset.id); if (!p) continue;
    card.hidden = !matchesProject(p, { route, filter, folder, search: $('sf-search').value }, prefs.assignments);
    if (!card.hidden) visible++;
    card.dataset.phase = projectPhase(p);
    if (!card.querySelector('.sf-cover')) {
      const cover = document.createElement('div'); cover.className = 'sf-cover'; cover.innerHTML = ico('film') + '<span>SUBFABRIC</span>';
      // 在线来源有封面才使用真实封面；本地媒体用图标，不伪造视频画面。
      if (/^https?:\/\//.test(p.source?.thumbnail || '')) { const img = document.createElement('img'); img.src = p.source.thumbnail; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.addEventListener('error', () => img.remove()); cover.prepend(img); }
      card.prepend(cover);
      card.draggable = true; card.addEventListener('dragstart', e => { if (e.target.closest('button,select,input')) { e.preventDefault(); return; } e.dataTransfer.setData('application/x-subfabric-project', p.id); });
      const assign = document.createElement('select'); assign.className = 'sf-assign'; assign.setAttribute('aria-label', t('移动到文件夹'));
      assign.addEventListener('click', e => e.stopPropagation());
      assign.addEventListener('change', e => { e.stopPropagation(); if (commit({ assignments: { ...prefs.assignments, [p.id]: assign.value } })) { renderFolders(); refreshLibrary(); } });
      card.querySelector('.pc-actions').appendChild(assign);
    }
    const assign = card.querySelector('.sf-assign');
    const options = `<option value="">${t('全部稿件')}</option>` + prefs.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    if (assign.innerHTML !== options) assign.innerHTML = options;
    assign.value = prefs.assignments[p.id] || '';
    const bar = card.querySelector('.pc-draft-bar');
    if (bar) {
      if (!bar.classList.contains('sf-progress')) {
        bar.classList.add('sf-progress'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', t('任务进度')); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
        bar.innerHTML = window.SF_PROGRESS.visual(p.draft?.progress); bar.querySelector('.sf-progress-fill').classList.add('pc-draft-bar-in');
      }
      window.SF_PROGRESS.set(bar, p.draft?.progress, p.draft?.status);
    }
  }
  $('home-empty').hidden = projects.length > 0 || route === '#/tasks';
  $('sf-filter-empty').hidden = visible > 0 || projects.length === 0 && route !== '#/tasks';
  $('sf-hero').hidden = route === '#/tasks' || !!folder;
  $('sf-ready-count').textContent = projects.filter(p => projectPhase(p) === 'ready').length;
  $('sf-task-count').textContent = projects.filter(p => projectPhase(p) === 'active').length || '';
  const recent = projects.find(p => p.id === prefs.recent && p.format);
  $('sf-resume-name').textContent = recent?.name || t('为每一句话，留出呼吸的空间。');
  $('sf-resume-meta').textContent = recent ? `${String(recent.format).toUpperCase()} · ${recent.subName || ''}` : t('从视频开始，把灵感变成字幕。');
  $('sf-resume-open').textContent = t(recent ? '继续编辑' : '新建稿件');
  window.SF_PROGRESS.mount($('home-list'));
}

// 真实播放器波浪控件按媒体事件更新，暂停时没有额外的 JS 动画循环。
const video = $('video');
const player = document.createElement('div'); player.id = 'sf-player';
player.innerHTML = `<button type="button" class="btn" id="sf-play" aria-label="播放 / 暂停">${ico('play')}</button><span id="sf-play-time">00:00</span><div id="sf-seek" class="sf-progress" data-progress-state="paused">${window.SF_PROGRESS.visual(0)}<input id="sf-seek-range" type="range" min="0" max="100" step="0.01" value="0" aria-label="播放进度"></div><span id="sf-play-duration">00:00</span>`;
$('stage-wrap').appendChild(player);
function syncPlayer() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const value = duration ? video.currentTime / duration * 100 : 0;
  const active = !video.paused && !video.ended;
  $('sf-seek-range').value = value;
  $('sf-seek-range').disabled = !duration;
  $('sf-play').disabled = !video.currentSrc;
  $('sf-play').innerHTML = active ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>' : ico('play');
  $('sf-play').setAttribute('aria-label', t(active ? '暂停' : '播放'));
  $('sf-play-time').textContent = fmtTime(video.currentTime || 0).slice(0, 8);
  $('sf-play-duration').textContent = fmtTime(duration).slice(0, 8);
  window.SF_PROGRESS.set($('sf-seek'), value, active ? 'running' : 'paused');
}
for (const event of ['timeupdate', 'play', 'pause', 'ended', 'durationchange', 'emptied', 'loadedmetadata']) video.addEventListener(event, syncPlayer);
$('sf-play').addEventListener('click', () => { if (video.paused) video.play().catch(() => notice('视频暂时无法播放。')); else video.pause(); });
$('sf-seek-range').addEventListener('input', () => { if (Number.isFinite(video.duration)) video.currentTime = Number($('sf-seek-range').value) / 100 * video.duration; });

window.__sfStudio = {
  projects(snapshot) { projects = snapshot; renderFolders(); refreshLibrary(); },
  route(h, project, format) {
    const previous = route; route = h;
    const editor = h === '#/editor' || h.startsWith('#/project/');
    document.body.dataset.workspace = editor ? 'editor' : h.slice(2).split('/')[0];
    $('sf-nav').hidden = editor; $('sf-topbar').hidden = editor; $('sf-help').hidden = h !== '#/help'; $('sf-help').inert = h !== '#/help';
    const global = h === '#/settings' || h === '#/resources';
    moveStyles(global);
    // detachProject 保留预览文档供旧直开编辑器使用，全局页不能修改这份无保存目标的文档。
    const hasAssProject = !!project && format === 'ass';
    for (const group of [$('ass-style-group'), $('word-convert-group')]) {
      group.inert = global && !hasAssProject;
      group.classList.toggle('sf-unavailable', global && !hasAssProject);
    }
    $('sf-ass-open').hidden = !!project && format === 'ass';
    $('sf-ass-context').textContent = hasAssProject ? `${t('当前稿件')}：${project.meta?.name || project.id} · ${t('字体、颜色与逐词样式立即预览并自动保存到稿件；后处理特效保存为本机偏好，导出时应用。')}` : t('请先打开 ASS 稿件以修改或导入导出样式。后处理特效仍可设置，保存为本机偏好，导出时应用。');
    $('sf-resource-links').hidden = h !== '#/resources';
    const titles = { home: '稿件库', tasks: '任务中心', resources: '资源管理', settings: '设置', help: '帮助与快捷键', new: '新建稿件', details: '稿件详情' };
    $('sf-breadcrumb').textContent = t(titles[h.slice(2).split('/')[0]] || '字幕工作台');
    document.querySelectorAll('[data-route]').forEach(a => { const active = h === '#/' + a.dataset.route; a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (global) {
      $('st-view').querySelector('.page-intro h1').textContent = t(h === '#/resources' ? '资源管理' : '设置');
      if (pendingSetting) selectSetting(pendingSetting);
      else if (h === '#/resources' && previous !== h) selectSetting('models');
    }
    if (editor && h.startsWith('#/project/') && prefs.recent !== h.slice(10)) commit({ recent: h.slice(10) });
    if (h === '#/tasks' && previous !== h) { filter = 'all'; folder = ''; $('sf-search').value = ''; }
    refreshLibrary();
  }
};
// 编辑快捷键只在工作台生效，其他页面保留按钮的原生键盘行为。
for (const event of ['keydown', 'keyup']) document.addEventListener(event, e => {
  const typing = e.target.closest?.('input,textarea,select,[contenteditable=true]');
  if (!typing && document.body.dataset.workspace !== 'editor' && shortcuts.actionForCombo(comboFromEvent(e))) e.stopImmediatePropagation();
}, true);
applyTheme(); renderFolders(); syncPlayer(); window.SF_PROGRESS.mount();
// #/editor 的旧直开 boot 不经过项目路由，也须初始化独立工作台可见性。
window.__sfStudio.route(route, null, '');
