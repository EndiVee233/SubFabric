import { STUDIO_KEY, normalizeStudio, projectPhase, matchesProject, imageData } from './studio-state.js';
import { escapeHtml as esc, fmtTime, popOrigin } from './util.js';
import { t } from './i18n.js';
import { ico } from './icons.js';
import { shortcuts, comboFromEvent } from './shortcuts.js';

// 所有编辑、导出、识别与保存仍由 main/project.js 负责。此层只接导航和外观。
const $ = id => document.getElementById(id);
const themes = window.SF_THEMES;
// 移动唯一版本节点，保留 main 的服务端更新；各列表标题不再重复版本号。
document.querySelector('.sf-brand-title').appendChild($('app-version'));
let saved;
try { saved = JSON.parse(localStorage.getItem(STUDIO_KEY) || '{}'); } catch { saved = {}; }
let prefs = normalizeStudio(saved, themes);
let projects = [], filter = 'all', folder = '', route = location.hash || '#/home';
let applying = false, pendingSetting = '';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const auroraPalettes = { sage: ['#90b99c', '#bacb91', '#9ac2b8'], ocean: ['#74adc8', '#9eaccf', '#95c5be'], sunset: ['#d69caa', '#cfb693', '#aca3cf'] };
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
  document.body.dataset.auroraMotion = prefs.auroraMotion;
  document.body.dataset.pageVisible = String(!document.hidden);
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
  st.setProperty('--sf-glass-dim', prefs.glassDim + '%');
  st.setProperty('--sf-glass-blur', prefs.glassBlur + 'px');
  st.setProperty('--sf-glass-opacity', prefs.glassOpacity + '%');
  // 纯黑基底配浅色正文，即使背后是纯白图片也保留足够对比度。
  // 压暗控制黑色基底强度，透明度单独控制实际 alpha；默认 80/100 保持此前视觉。
  const glassAlpha = prefs.glassDim * prefs.glassOpacity / 10000;
  st.setProperty('--sf-glass-surface', `rgb(8 11 10 / ${glassAlpha})`);
  st.setProperty('--sf-glass-raised', `rgb(12 16 14 / ${Math.min(.96, glassAlpha + .06)})`);
  $('sf-glass-dim').value = String(prefs.glassDim);
  $('sf-glass-blur').value = String(prefs.glassBlur);
  $('sf-glass-opacity').value = String(prefs.glassOpacity);
  $('sf-glass-dim-value').textContent = prefs.glassDim + '%';
  $('sf-glass-blur-value').textContent = prefs.glassBlur + 'px';
  $('sf-glass-opacity-value').textContent = prefs.glassOpacity + '%';
  const auroraColors = prefs.auroraColors.length ? prefs.auroraColors : [tokens['--accent-soft'], tokens['--secondary-container'], tokens['--tertiary-container']];
  auroraColors.forEach((color, i) => {
    st.setProperty('--sf-aurora-' + (i + 1), color);
    const input = $('sf-aurora-color-' + (i + 1));
    input.value = color; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('sf-aurora-options').hidden = prefs.background !== 'aurora';
  $('sf-aurora-motion').value = prefs.auroraMotion;
  $('sf-aurora-palette').value = !prefs.auroraColors.length ? 'theme' : Object.keys(auroraPalettes).find(key => auroraPalettes[key].every((color, i) => color === prefs.auroraColors[i])) || 'custom';
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
  syncAppearanceChoices();
}
function syncAppearanceChoices() {
  for (const kind of ['background', 'mode']) {
    document.querySelectorAll(`[data-appearance-${kind}]`).forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset[kind === 'mode' ? 'appearanceMode' : 'appearanceBackground'] === prefs[kind]));
    });
  }
  const imageThumb = document.querySelector('.sf-background-thumb.image');
  if (imageThumb) imageThumb.style.backgroundImage = imageData(prefs.image) ? `url("${prefs.image}")` : '';
}
for (const kind of ['background', 'mode']) {
  document.querySelectorAll(`[data-appearance-${kind}]`).forEach(button => button.addEventListener('click', () => {
    const select = $('sf-' + kind);
    select.value = button.dataset[kind === 'mode' ? 'appearanceMode' : 'appearanceBackground'];
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }));
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
  $('sf-theme-packs').innerHTML = themes.list(prefs.custom).map(pack => {
    // 示意卡片的工作区预览跟随当前明暗模式，避免深色设置页内仍显示浅色工作区。
    const dark = document.body.dataset.theme === 'dark';
    const palette = themes.palette(pack.seed, dark);
    const glyph = pack.design === 'material'
      ? '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3ZM20 2v4m-2-2h4M4 18v4m-2-2h4"/>'
      : '<path d="M4 6.5 12 3l8 3.5v11L12 21l-8-3.5z"/><path d="m4 6.5 8 3.5 8-3.5M12 10v11M8 4.8l8 3.5"/>';
    const selected = prefs.themePack === pack.id;
    return `<button type="button" class="sf-pack" data-pack="${esc(pack.id)}" aria-pressed="${selected}"><span class="sf-pack-art ${pack.design}" aria-hidden="true" style="--preview-bg:${palette['--bg']};--preview-accent:${palette['--accent']};--preview-ink:${palette['--on-accent']}"><span class="sf-pack-symbol"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span><span class="sf-pack-lines"><i></i><i></i><i></i></span></span><b>${esc(pack.name)}${selected ? ico('checkCircle') : ''}</b><small>${esc(pack.description)}</small></button>`;
  }).join('');
}
$('sf-theme-packs').addEventListener('click', e => {
  const b = e.target.closest('[data-pack]'); if (!b) return;
  const pack = themes.get(b.dataset.pack, prefs.custom);
  if (commit({ themePack: pack.id, accent: pack.seed })) { applyTheme(); themeStatus(); }
});
function themeStatus() { $('sf-theme-status').textContent = t('外观已保存，刷新后保留。'); }
for (const [id, key] of [['sf-glass-dim', 'glassDim'], ['sf-glass-blur', 'glassBlur'], ['sf-glass-opacity', 'glassOpacity']]) $(id).addEventListener('input', () => {
  if (commit({ [key]: Number($(id).value) })) { applyTheme(); themeStatus(); }
});
for (const [id, key] of [['sf-mode', 'mode'], ['sf-background', 'background'], ['sf-motion', 'motion'], ['sf-aurora-motion', 'auroraMotion']]) $(id).addEventListener('change', () => {
  if (commit({ [key]: $(id).value })) { applyTheme(); themeStatus(); }
});
// 只有可见的动态背景运行动画；静态/后台/减少动效不启动 JS 时钟。
document.addEventListener('visibilitychange', () => { document.body.dataset.pageVisible = String(!document.hidden); });
$('sf-aurora-palette').addEventListener('change', () => {
  const choice = $('sf-aurora-palette').value;
  const colors = choice === 'theme' ? [] : auroraPalettes[choice] || [1, 2, 3].map(i => $('sf-aurora-color-' + i).value);
  if (commit({ auroraColors: colors })) { applyTheme(); themeStatus(); }
});
for (let i = 1; i <= 3; i++) $('sf-aurora-color-' + i).addEventListener('change', () => {
  const colors = [1, 2, 3].map(n => $('sf-aurora-color-' + n).value);
  if (!colors.every(color => themes.hex(color))) { notice('主题色需要使用 #RRGGBB 格式。'); applyTheme(); return; }
  if (commit({ auroraColors: colors })) { applyTheme(); themeStatus(); }
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

// 工作台偏好在全局设置与编辑器之间移动；ASS 样式始终留在编辑器。
// 旧 HTML 的特效组少一个闭合层，浏览器将后续五张卡解析进特效组；
// 新界面先恢复同级关系，否则移动特效卡会把音频、导出设置一起搬走。
const fx = $('ass-fx-group');
let afterFx = fx;
for (const child of [...fx.children].filter(el => el.classList.contains('set-group') || el.classList.contains('setting-note'))) { afterFx.after(child); afterFx = child; }
if ($('fx-status-note').parentElement !== fx) fx.appendChild($('fx-status-note'));
// 分组沿用常驻真实节点；重新分类不重建表单，离开后恢复编辑器原位置。
const styleGroups = ['sf-editor-timeline', 'sf-editor-display', 'sf-editor-roles', 'sf-editor-media', 'sf-editor-export'].map(id => $(id));
function moveStyles() {}

// 增强配置按使用顺序组织，控件的 ID、值、事件及模型委托祖先不变。
const enhance = $('st-panel-enhance');
const cardOf = id => $(id).closest('.st-card');
const heal = cardOf('cb-heal-words');
$('tab-settings').appendChild(heal);
for (const [title, ids] of [
  ['识别结果', ['st-conf-mode', 'st-cast-enabled']],
  ['热词与专有名词', ['ah-terms-list', 'ah-score', 'an-use-translate']],
  ['纠错与逐词时间', ['st-correct-mode', 'st-realign-minratio']]
]) {
  const group = document.createElement('section'); group.className = 'sf-settings-cluster';
  const heading = document.createElement('h3'); heading.className = 'sf-settings-group-title'; heading.textContent = t(title);
  group.appendChild(heading);
  ids.forEach(id => group.appendChild(cardOf(id))); enhance.appendChild(group);
}
function explain(card, summary, nodes) {
  if (!nodes.length) return;
  const details = document.createElement('details'); details.className = 'sf-settings-details';
  const label = document.createElement('summary'); label.textContent = t(summary); details.appendChild(label);
  nodes.forEach(node => details.appendChild(node)); card.appendChild(details);
}
for (const id of ['st-realign-minratio', 'an-use-translate', 'ass-style-group']) {
  const card = id === 'ass-style-group' ? $(id) : cardOf(id);
  const notes = [...card.children].filter(el => el.tagName === 'P' && !el.id);
  explain(card, '工作方式与使用说明', notes);
}
const correctCard = cardOf('st-correct-mode');
explain(correctCard, '重识别范围与批量参数', [$('st-correct-pad').closest('.st-row')]);
const performanceCard = $('perf-start').closest('.st-section');
explain(performanceCard, '测试方法与硬件要求', [performanceCard.querySelector('.st-help')]);
// 老版 setting-name 只是 span；重排后补上可访问名称，键盘和读屏仍能辨认每个参数。
for (const group of [...styleGroups, $('ass-style-group'), $('ass-fx-group'), $('word-convert-group'), heal]) {
  group.querySelectorAll('.setting-row').forEach(row => {
    const label = row.querySelector('.setting-name')?.textContent.trim();
    if (!label) return;
    row.querySelectorAll('input,select').forEach(input => {
      if (!input.getAttribute('aria-label') && !input.labels?.length) input.setAttribute('aria-label', label);
    });
  });
}
for (const [id, label] of Object.entries({
  'st-conf-mode': '置信度模式', 'st-correct-mode': '自动纠错', 'ah-score': '热词强度',
  'st-correct-provider': '纠错服务商', 'st-correct-pad': '前后上下文秒数',
  'st-correct-max': '单段时长上限', 'st-correct-batch': '每批字幕行数',
  'st-realign-minratio': '最低锚点率', 'st-realign-minconf': '重校对置信度门槛'
})) $(id).setAttribute('aria-label', t(label));
document.querySelectorAll('#st-view .st-grid').forEach(grid => {
  let label = '';
  for (const child of grid.children) {
    if (child.classList.contains('st-lbl')) label = child.textContent.trim();
    else if (label && ['INPUT', 'SELECT', 'TEXTAREA'].includes(child.tagName) && !child.getAttribute('aria-label')) child.setAttribute('aria-label', label);
  }
});

const settingTabs = [...document.querySelectorAll('#st-view .st-tab')];
const footerNotes = {
  theme: '外观更改即时保存。',
  models: '模型操作、目录与分工设置即时保存。',
  translate: '',
  enhance: '热词列表与强度需保存，其余选项即时保存。',
  fetch: '下载偏好即时保存；Cookie 请使用卡片内的保存按钮。',
  perf: '测试需手动启动；此页显示本机结果。'
};
function settingPresentation(name) {
  $('sf-settings-footer-note').textContent = t(footerNotes[name] || '');
  $('st-test').hidden = true;
  $('st-save').hidden = name !== 'enhance';
  for (const tab of settingTabs) {
    tab.setAttribute('tabindex', tab.dataset.stp === name ? '0' : '-1');
    const panel = $('st-panel-' + tab.dataset.stp);
    panel.setAttribute('aria-labelledby', tab.id);
  }
}
settingTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.stp; settingPresentation(name);
    if (name !== 'translate' && !$('st-scheme-drawer').hidden) $('st-scheme-close').click();
    // 原二级入口仍管理服务商列表刷新，一级分类只委托给它。
    if (name === 'translate' || name === 'models') document.querySelector(`.st-subtab[data-stsub="${name === 'translate' ? 'llm' : 'asr'}"]`)?.click();
    $('st-view').scrollTop = 0;
  });
  tab.addEventListener('keydown', event => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!delta && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = settingTabs[event.key === 'Home' ? 0 : event.key === 'End' ? settingTabs.length - 1 : (index + delta + settingTabs.length) % settingTabs.length];
    next.click(); next.focus();
  });
});
$('st-entry-asr').addEventListener('click', () => document.querySelector('.st-tab[data-stp="models"]').click());
$('st-entry-llm').addEventListener('click', () => document.querySelector('.st-tab[data-stp="translate"]').click());
for (const id of ['btn-open-video', 'btn-open-sub']) $(id).addEventListener('click', () => {
  if (route === '#/settings' || route === '#/resources') location.hash = '#/editor';
});
settingPresentation('theme');
function setting(name, resource = false) {
  pendingSetting = name;
  const next = resource ? '#/resources' : '#/settings';
  if (location.hash === next) selectSetting(name); else location.hash = next;
}
function selectSetting(name) {
  document.querySelector(`.st-tab[data-stp="${name === 'llm' ? 'translate' : name}"]`)?.click();
  if (name === 'llm') $('st-entry-llm').click();
  pendingSetting = '';
}
document.querySelectorAll('[data-setting]').forEach(b => b.addEventListener('click', () => setting(b.dataset.setting, route === '#/resources')));
document.querySelectorAll('[data-resource]').forEach(b => b.addEventListener('click', () => setting(b.dataset.resource, true)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.go; }));
for (const id of ['sf-create', 'sf-hero-create']) $(id).addEventListener('click', () => $('btn-new-project').click());
$('sf-direct-editor').addEventListener('click', () => { location.hash = '#/editor'; });
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
// 只显示这套控件，并补齐原生条上的音量和倍速能力。
video.controls = false;
const player = document.createElement('div'); player.id = 'sf-player';
player.innerHTML = `<button type="button" class="btn" id="sf-play" aria-label="${t('播放 / 暂停')}">${ico('play')}</button><span id="sf-play-time">00:00</span><div id="sf-seek" class="sf-progress" data-progress-state="paused">${window.SF_PROGRESS.visual(0)}<input id="sf-seek-range" type="range" min="0" max="100" step="0.01" value="0" aria-label="${t('播放进度')}"></div><span id="sf-play-duration">00:00</span><button type="button" class="btn" id="sf-mute" aria-label="${t('静音')}" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="sf-sound-waves" d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sf-sound-muted" d="m16 9 6 6m0-6-6 6" hidden/></svg></button><input id="sf-volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="${t('音量')}"><select id="sf-rate" aria-label="${t('播放速度')}">${[0.25,0.5,0.75,1,1.25,1.5,1.75,2].map(rate => `<option value="${rate}">${rate}×</option>`).join('')}</select>`;
$('stage-wrap').appendChild(player);
// Material 主题的前后按钮只负责十秒定位；主题切换不重建播放器或丢失焦点。
for (const [id, label, path, before] of [
  ['sf-back-ten', '后退 10 秒', 'M6 5v14M19 5l-9 7 9 7', $('sf-play')],
  ['sf-forward-ten', '前进 10 秒', 'M18 5v14M5 5l9 7-9 7', $('sf-play-time')]
]) {
  const button = document.createElement('button');
  button.type = 'button'; button.id = id; button.className = 'btn sf-skip-ten';
  button.setAttribute('aria-label', t(label)); button.title = t(label);
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  player.insertBefore(button, before);
}
const transport = document.createElement('span'); transport.className = 'sf-transport';
player.insertBefore(transport, $('sf-back-ten'));
for (const id of ['sf-back-ten', 'sf-play', 'sf-forward-ten']) transport.appendChild($(id));
// 图标按钮不带文字，清除通用图标留白；音量图形的可见墨迹横向中心为 13.5。
player.querySelector('#sf-mute svg').setAttribute('viewBox', '1.5 0 24 24');
const rateShell = document.createElement('span'); rateShell.className = 'sf-rate-shell';
player.insertBefore(rateShell, $('sf-rate')); rateShell.appendChild($('sf-rate'));
const rateToggle = document.createElement('button'); rateToggle.id = 'sf-rate-toggle'; rateToggle.type = 'button';
rateToggle.setAttribute('aria-label', t('播放速度')); rateToggle.setAttribute('aria-haspopup', 'menu');
rateToggle.setAttribute('aria-expanded', 'false'); rateToggle.setAttribute('aria-controls', 'sf-rate-menu');
rateToggle.innerHTML = `<span id="sf-rate-label">1×</span>${ico('chevronDown')}`;
const rateMenu = document.createElement('div'); rateMenu.id = 'sf-rate-menu'; rateMenu.className = 'sf-rate-menu';
rateMenu.setAttribute('role', 'menu'); rateMenu.setAttribute('aria-label', t('播放速度')); rateMenu.hidden = true;
rateMenu.innerHTML = [0.25,0.5,0.75,1,1.25,1.5,1.75,2].map(rate => `<button type="button" role="menuitemradio" data-rate="${rate}" aria-checked="${rate === 1}" tabindex="-1"><span>${rate}×</span>${ico('check')}</button>`).join('');
rateShell.append(rateToggle, rateMenu);
function closeRateMenu(restoreFocus = false) {
  rateMenu.hidden = true; rateToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) rateToggle.focus();
}
function openRateMenu(edge = '') {
  rateMenu.hidden = false; rateToggle.setAttribute('aria-expanded', 'true');
  const triggerRect = rateToggle.getBoundingClientRect(), menuRect = rateMenu.getBoundingClientRect();
  popOrigin(rateMenu, triggerRect.left + triggerRect.width / 2, triggerRect.top, menuRect.left, menuRect.top);
  const options = [...rateMenu.querySelectorAll('[data-rate]')];
  const selected = options.find(option => Number(option.dataset.rate) === video.playbackRate);
  (edge === 'first' ? options[0] : edge === 'last' ? options.at(-1) : selected || options[0]).focus();
}
rateToggle.addEventListener('click', () => { if (rateMenu.hidden) openRateMenu(); else closeRateMenu(true); });
function chooseRate(option) {
  $('sf-rate').value = option.dataset.rate;
  $('sf-rate').dispatchEvent(new Event('change', { bubbles: true }));
  closeRateMenu(true);
}
rateMenu.addEventListener('click', e => {
  const option = e.target.closest('[data-rate]'); if (option) chooseRate(option);
});
rateShell.addEventListener('keydown', e => {
  if (e.target === $('sf-rate')) return;
  e.stopPropagation();
  // 主播放器在捕获阶段取消空格默认动作，菜单显式处理以保留按钮键盘操作。
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault(); if (e.repeat) return;
    const option = e.target.closest('[data-rate]');
    if (option) chooseRate(option); else if (e.target === rateToggle) rateToggle.click();
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeRateMenu(true); return; }
  if (e.key === 'Tab') { closeRateMenu(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  if (rateMenu.hidden) { openRateMenu(e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : ''); return; }
  const options = [...rateMenu.querySelectorAll('[data-rate]')], current = options.indexOf(document.activeElement);
  const index = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
    : (current + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[index].focus();
});
rateShell.addEventListener('keyup', e => { if (e.target !== $('sf-rate')) e.stopPropagation(); });
rateShell.addEventListener('focusout', e => { if (!rateShell.contains(e.relatedTarget)) closeRateMenu(); });
document.addEventListener('pointerdown', e => { if (!rateShell.contains(e.target)) closeRateMenu(); }, true);
for (const event of ['hashchange', 'resize', 'sf-studio-theme']) window.addEventListener(event, () => closeRateMenu());
const seekRange = $('sf-seek-range'), seekBar = $('sf-seek'), seekTip = $('video-hover-tip');
// 旧原生控件的提示模块不在 Studio 加载；沿用同一提示节点，命中范围改为真实播放条。
seekBar.appendChild(seekTip);
seekTip.hidden = true;
let scrubbing = false, requestedTime = null;
function syncPlayer() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const time = requestedTime ?? video.currentTime;
  const value = duration ? Math.max(0, Math.min(100, time / duration * 100)) : 0;
  const active = !video.paused && !video.ended;
  if (!scrubbing) seekRange.value = value;
  seekRange.disabled = !duration;
  $('sf-play').disabled = !video.currentSrc;
  $('sf-play').dataset.playing = String(active);
  for (const id of ['sf-back-ten', 'sf-forward-ten']) $(id).disabled = !duration || !video.currentSrc;
  $('sf-play').innerHTML = active ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>' : ico('play');
  $('sf-play').setAttribute('aria-label', t(active ? '暂停' : '播放'));
  $('sf-play-time').textContent = fmtTime(time || 0).slice(0, 8);
  $('sf-play-duration').textContent = fmtTime(duration).slice(0, 8);
  window.SF_PROGRESS.set(seekBar, value, active ? 'running' : 'paused');
}
for (const event of ['timeupdate', 'play', 'pause', 'ended', 'durationchange', 'emptied', 'loadedmetadata']) video.addEventListener(event, syncPlayer);
$('sf-play').addEventListener('click', () => { if (video.paused) video.play().catch(() => notice('视频暂时无法播放。')); else video.pause(); });
function skipTen(delta) {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.currentSrc) return;
  requestedTime = Math.max(0, Math.min(video.duration, (requestedTime ?? video.currentTime) + delta));
  scrubbing = false; hideSeekTip(); syncPlayer();
  if (video.currentTime !== requestedTime) video.currentTime = requestedTime;
  else if (!video.seeking) requestedTime = null;
}
$('sf-back-ten').addEventListener('click', () => skipTen(-10));
$('sf-forward-ten').addEventListener('click', () => skipTen(10));
seekRange.addEventListener('pointerdown', () => { scrubbing = true; hideSeekTip(); });
function finishScrub() { scrubbing = false; syncPlayer(); }
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'change', 'blur']) seekRange.addEventListener(event, finishScrub);
seekRange.addEventListener('input', () => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  requestedTime = Math.max(0, Math.min(100, Number(seekRange.value) || 0)) / 100 * video.duration;
  // 先显示拖动目标，不能等长视频解码触发 timeupdate，也不能被迟到的旧进度拉回。
  syncPlayer(); hideSeekTip();
  if (video.currentTime !== requestedTime) video.currentTime = requestedTime;
  else if (!video.seeking) requestedTime = null;
});
video.addEventListener('seeked', () => { if (!video.seeking) { requestedTime = null; syncPlayer(); } });
for (const event of ['emptied', 'loadstart', 'loadedmetadata']) video.addEventListener(event, () => {
  scrubbing = false; requestedTime = null; hideSeekTip(); syncPlayer();
});
function hideSeekTip() { seekTip.hidden = true; }
seekRange.addEventListener('pointermove', e => {
  if (scrubbing || seekRange.disabled || !Number.isFinite(video.duration) || video.duration <= 0) { hideSeekTip(); return; }
  const rect = seekRange.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
  const time = ratio * video.duration;
  seekTip.textContent = fmtTime(time).slice(0, 8);
  seekTip.title = fmtTime(time);
  seekTip.style.left = `clamp(36px,${ratio * 100}%,calc(100% - 36px))`;
  seekTip.hidden = false;
});
for (const event of ['pointerleave', 'pointercancel', 'blur']) seekRange.addEventListener(event, hideSeekTip);
video.addEventListener('seeking', hideSeekTip);
window.addEventListener('resize', hideSeekTip);
window.addEventListener('hashchange', hideSeekTip);
function syncPlayerSound() {
  const muted = video.muted || video.volume === 0;
  $('sf-volume').value = video.muted ? 0 : video.volume;
  $('sf-volume').style.setProperty('--sf-volume', `${Math.max(0, Math.min(1, Number($('sf-volume').value) || 0)) * 100}%`);
  $('sf-mute').setAttribute('aria-pressed', String(muted));
  $('sf-mute').setAttribute('aria-label', t(muted ? '取消静音' : '静音'));
  player.querySelector('.sf-sound-waves').toggleAttribute('hidden', muted);
  player.querySelector('.sf-sound-muted').toggleAttribute('hidden', !muted);
  $('sf-rate').value = String(video.playbackRate);
  $('sf-rate-label').textContent = `${video.playbackRate}×`;
  for (const option of rateMenu.querySelectorAll('[data-rate]')) option.setAttribute('aria-checked', String(Number(option.dataset.rate) === video.playbackRate));
}
video.addEventListener('volumechange', syncPlayerSound);
video.addEventListener('ratechange', syncPlayerSound);
$('sf-mute').addEventListener('click', () => {
  if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 1; }
  else video.muted = true;
});
$('sf-volume').addEventListener('input', () => { video.volume = Number($('sf-volume').value); video.muted = video.volume === 0; });
$('sf-rate').addEventListener('change', () => { video.playbackRate = Number($('sf-rate').value); syncPlayerSound(); });
syncPlayerSound();

window.__sfStudio = {
  projects(snapshot) { projects = snapshot; renderFolders(); refreshLibrary(); },
  route(h, project, format) {
    const previous = route; route = h;
    const editor = h === '#/editor' || h.startsWith('#/project/');
    document.body.dataset.workspace = editor ? 'editor' : h.slice(2).split('/')[0];
    $('sf-nav').hidden = editor; $('sf-topbar').hidden = editor; $('sf-help').hidden = h !== '#/help'; $('sf-help').inert = h !== '#/help';
    const global = h === '#/settings' || h === '#/resources';
    moveStyles(global);
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
// 两个主题共用菜单行为，各自用 CSS 定义材质；原 select 保留业务链路。
function installThemeChoices() {
  // 覆盖动态稿件卡片、新建与资源页；倍速已有独立菜单，避免重复接管。
  const selector = 'select';
  let controlId = 0;
  const records = new Map();
  const menu = document.createElement('div'); menu.id = 'sf-choice-menu'; menu.className = 'sf-choice-menu';
  menu.setAttribute('role', 'listbox'); menu.setAttribute('data-sf-choice-control', ''); menu.hidden = true;
  document.body.appendChild(menu);
  let active = null, cursor = -1, fingerprint = '', typed = '', typedAt = 0;
  const themed = () => ['studio', 'material'].includes(document.body.dataset.design);
  const options = record => [...record.select.options];
  const unavailable = option => option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled;
  function name(select) {
    if (select.id === 'sel-display-mode') return t('显示模式');
    return (select.getAttribute('aria-label') || select.title || select.labels?.[0]?.textContent ||
      select.closest('.setting-row,.st-row,.set-row,.field,.st-grid,.sm-model')?.querySelector('label,.setting-name,.st-lbl,.st-label,.sm-name')?.textContent || select.id || '').trim();
  }
  function index(record) {
    return Number.isInteger(record.select.selectedIndex) ? record.select.selectedIndex : options(record).findIndex(option => option.value === record.select.value);
  }
  function close(restoreFocus = false) {
    if (!active) return;
    const record = active; active = null; menu.hidden = true;
    record.toggle.setAttribute('aria-expanded', 'false'); record.toggle.removeAttribute('aria-activedescendant');
    if (restoreFocus) (themed() ? record.toggle : record.select).focus();
  }
  function setCursor(next) {
    cursor = next;
    for (const row of menu.querySelectorAll('[data-choice-index]')) row.classList.toggle('is-active', Number(row.dataset.choiceIndex) === cursor);
    const row = menu.querySelector(`[data-choice-index="${cursor}"]`);
    if (row) { active.toggle.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
  }
  function position() {
    const r = active.toggle.getBoundingClientRect(), viewport = document.documentElement.getBoundingClientRect();
    const width = Math.max(0, Math.min(Math.max(r.width, 200), viewport.width - 24));
    const below = viewport.height - r.bottom - 12, above = r.top - 12;
    const down = below >= Math.min(280, menu.scrollHeight) || below >= above;
    const maxHeight = Math.max(0, Math.min(320, down ? below : above));
    menu.style.width = width + 'px'; menu.style.maxHeight = maxHeight + 'px';
    const left = Math.max(12, Math.min(r.left, viewport.width - width - 12));
    const top = down ? r.bottom + 6 : Math.max(12, r.top - menu.getBoundingClientRect().height - 6);
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    popOrigin(menu, r.left + r.width / 2, down ? r.bottom : r.top, left, top);
  }
  function signature(record) {
    return JSON.stringify([index(record), record.select.disabled, options(record).map(option => [option.textContent, option.value, !!unavailable(option), option.parentElement?.label])]);
  }
  function render() {
    const record = active, selected = index(record); menu.replaceChildren();
    menu.setAttribute('aria-label', name(record.select));
    let group = null;
    options(record).forEach((option, i) => {
      const parent = option.parentElement;
      if (parent?.tagName === 'OPTGROUP' && parent !== group) {
        group = parent; const heading = document.createElement('div'); heading.className = 'sf-choice-group';
        heading.textContent = parent.label; heading.setAttribute('role', 'presentation'); menu.appendChild(heading);
      }
      const row = document.createElement('button'); row.type = 'button'; row.className = 'sf-choice-option';
      row.id = 'sf-choice-option-' + i; row.dataset.choiceIndex = String(i); row.tabIndex = -1;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === selected));
      row.disabled = !!unavailable(option); row.setAttribute('aria-disabled', String(row.disabled));
      const text = document.createElement('span'); text.textContent = option.textContent;
      row.appendChild(text); const check = document.createElement('span'); check.innerHTML = ico('check');
      check.className = 'sf-choice-check'; check.setAttribute('aria-hidden', 'true'); row.appendChild(check); menu.appendChild(row);
    });
    fingerprint = signature(record);
    const enabled = options(record).map((option, i) => unavailable(option) ? -1 : i).filter(i => i >= 0);
    setCursor(enabled.includes(cursor) ? cursor : enabled.includes(selected) ? selected : enabled[0] ?? -1);
    position();
  }
  function sync(record) {
    const select = record.select, selected = options(record)[index(record)];
    const label = selected?.textContent || '—';
    if (record.label.textContent !== label) record.label.textContent = label;
    record.toggle.setAttribute('aria-label', name(select)); record.toggle.title = name(select);
    record.toggle.disabled = select.disabled || !!select.closest('[inert]')?.inert || !options(record).some(option => !unavailable(option));
    if (record.shell.hidden !== select.hidden) record.shell.hidden = select.hidden;
    record.shell.style.maxWidth = select.style.maxWidth || '100%';
    record.shell.style.width = select.style.width || '';
    record.shell.classList.toggle('sf-choice-wide', select.matches('.st-select,.st-input,.ws-fld,.sf-assign'));
    record.shell.classList.toggle('sf-choice-assignment', select.matches('.sf-assign'));
    if (active === record) {
      if (record.toggle.disabled || !themed()) close();
      else if (fingerprint !== signature(record)) render();
    }
  }
  function open(record, edge = '') {
    sync(record); if (!themed() || record.toggle.disabled) return;
    close(); active = record; cursor = index(record); typed = ''; typedAt = 0;
    menu.hidden = false; record.toggle.setAttribute('aria-expanded', 'true'); render();
    if (edge) {
      const enabled = options(record).map((option, i) => unavailable(option) ? -1 : i).filter(i => i >= 0);
      setCursor(edge === 'last' ? enabled.at(-1) ?? -1 : enabled[0] ?? -1);
    }
    record.toggle.focus();
  }
  function choose(i) {
    const record = active, option = options(record)[i];
    if (!option || unavailable(option) || record.toggle.disabled) return;
    const previous = index(record);
    record.select.selectedIndex = i;
    if (previous !== i) {
      record.select.dispatchEvent(new Event('input', { bubbles: true }));
      record.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync(record); close(true); (themed() ? record.toggle : record.select).focus();
  }
  function key(e, record = active) {
    if (!record) return; e.stopPropagation();
    if (e.key === 'Tab') { close(); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault(); if (e.repeat) return;
      if (active === record) choose(cursor); else open(record); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      if (active !== record) { open(record, e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : ''); return; }
      const enabled = options(record).map((option, i) => unavailable(option) ? -1 : i).filter(i => i >= 0);
      const current = enabled.indexOf(cursor);
      setCursor(e.key === 'Home' ? enabled[0] : e.key === 'End' ? enabled.at(-1) : enabled[(current + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
      return;
    }
    if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault(); if (active !== record) open(record);
      const now = Date.now(); typed = now - typedAt < 700 ? typed + e.key.toLocaleLowerCase() : e.key.toLocaleLowerCase(); typedAt = now;
      const list = options(record), start = cursor + 1;
      for (let offset = 0; offset < list.length; offset++) {
        const i = (start + offset) % list.length;
        if (!unavailable(list[i]) && list[i].textContent.trim().toLocaleLowerCase().startsWith(typed)) { setCursor(i); break; }
      }
    }
  }
  function enhance(select) {
    if (records.has(select) || select.id === 'sf-rate' || select.multiple || select.size > 1) return;
    const shell = document.createElement('span'); shell.className = 'sf-choice-shell';
    select.before(shell); shell.appendChild(select); select.classList.add('sf-choice-native');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.id = select.id ? select.id + '-choice' : 'sf-choice-control-' + ++controlId; toggle.className = 'sf-choice-toggle';
    toggle.setAttribute('role', 'combobox'); toggle.setAttribute('data-sf-choice-control', '');
    toggle.setAttribute('aria-haspopup', 'listbox'); toggle.setAttribute('aria-controls', menu.id); toggle.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); label.className = 'sf-choice-value'; toggle.appendChild(label);
    const arrow = document.createElement('span'); arrow.className = 'sf-choice-arrow'; arrow.innerHTML = ico('chevronDown'); arrow.setAttribute('aria-hidden', 'true'); toggle.appendChild(arrow); shell.appendChild(toggle);
    const record = { select, shell, toggle, label, hooks: [] }; records.set(select, record);
    toggle.addEventListener('click', e => { e.stopPropagation(); if (active === record) close(true); else open(record); });
    toggle.addEventListener('keydown', e => key(e, record)); toggle.addEventListener('keyup', e => e.stopPropagation());
    toggle.addEventListener('focusout', e => { if (active === record && !menu.contains(e.relatedTarget) && e.relatedTarget !== toggle) close(); });
    select.addEventListener('change', () => sync(record));
    // 业务代码经常直接写 value/selectedIndex/disabled，不会发 change 或属性变更。
    // 在该实例上透传原生访问器，避免轮询和重复刷新整页。
    const prototype = typeof HTMLSelectElement === 'function' ? HTMLSelectElement.prototype : null;
    for (const property of ['value', 'selectedIndex', 'disabled']) {
      const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor?.get || !descriptor.set || Object.hasOwn(select, property)) continue;
      Object.defineProperty(select, property, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); sync(record); } });
      record.hooks.push(property);
    }
    if (typeof MutationObserver === 'function') {
      record.observer = new MutationObserver(() => sync(record));
      record.observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    sync(record);
  }
  function scan() {
    for (const [select, record] of records) {
      if (!select.isConnected || !record.shell.isConnected) {
        if (active === record) close(); record.observer?.disconnect();
        record.hooks.forEach(property => { delete select[property]; }); records.delete(select);
      }
    }
    document.querySelectorAll(selector).forEach(enhance); records.forEach(sync);
  }
  menu.addEventListener('click', e => { const row = e.target.closest('[data-choice-index]'); if (active && row) choose(Number(row.dataset.choiceIndex)); });
  menu.addEventListener('keydown', e => key(e)); menu.addEventListener('keyup', e => e.stopPropagation());
  menu.addEventListener('pointermove', e => { const row = e.target.closest('[data-choice-index]'); if (active && row && !row.disabled) setCursor(Number(row.dataset.choiceIndex)); });
  document.addEventListener('pointerdown', e => { if (active && !menu.contains(e.target) && !active.toggle.contains(e.target)) close(); }, true);
  document.addEventListener('scroll', e => { if (active && !menu.contains(e.target)) close(); }, true);
  document.addEventListener('click', e => {
    const label = e.target.closest('label[for]'); const record = label && records.get($(label.getAttribute('for')));
    if (themed() && record) record.toggle.focus();
  });
  for (const event of ['resize', 'hashchange']) window.addEventListener(event, () => close());
  window.addEventListener('sf-studio-theme', () => { close(); scan(); });
  if (typeof MutationObserver === 'function') {
    // 忽略播放读数、字幕虚拟列表和菜单自己的文字更新，避免每帧扫描所有设置。
    const hasSelect = node => node.nodeType === 1 && (node.matches('select,.sf-choice-shell') || node.querySelector('select,.sf-choice-shell'));
    const observer = new MutationObserver(changes => {
      if (changes.some(change => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some(hasSelect))) scan();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] });
  }
  scan();
}
installThemeChoices();
// 编辑快捷键只在工作台生效，其他页面保留按钮的原生键盘行为。
for (const event of ['keydown', 'keyup']) document.addEventListener(event, e => {
  const typing = e.target.closest?.('input,textarea,select,[contenteditable=true],[data-sf-choice-control]');
  if (!typing && document.body.dataset.workspace !== 'editor' && shortcuts.actionForCombo(comboFromEvent(e))) e.stopImmediatePropagation();
}, true);
applyTheme(); renderFolders(); syncPlayer(); window.SF_PROGRESS.mount();
// #/editor 的旧直开 boot 不经过项目路由，也须初始化独立工作台可见性。
window.__sfStudio.route(route, null, '');
