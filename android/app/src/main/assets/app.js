import { parseSRT, serializeSRT } from './shared/srt.js';
import { fmtTime, parseTime } from './shared/util.js';
import { validateCues, exampleCues, timelineEnd } from './core.js';
import { initCopy, t } from './copy.js';

const $ = id => document.getElementById(id);
const pending = new Map();
let sequence = 0, project = null, projects = [], view = 'home', status = {}, activeJob = false;
let saveTimer, toastTimer, dirty = false, revision = 0, savedRevision = 0, saving = Promise.resolve();
let video = $('video');

function rpc(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    if (!window.SubFabric) { reject(new Error('此界面需要在安卓应用中运行')); return; }
    pending.set(id, { resolve, reject });
    window.SubFabric.call(id, action, JSON.stringify(payload));
  });
}
window.nativeEvent = (type, data) => {
  if (type === 'response') {
    const promise = pending.get(data.id);
    if (!promise) return;
    pending.delete(data.id);
    if (data.ok) promise.resolve(data.data); else promise.reject(new Error(data.data));
  } else if (type === 'progress') {
    $('job-label').textContent = data.message;
    if (data.percent < 0) $('progress').removeAttribute('value');
    else $('progress').value = data.percent;
  }
};
function toast(message) { $('toast').textContent = t(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function setJob(value, label = '正在处理') {
  activeJob = value; $('job').hidden = !value; $('job-label').textContent = label;
  document.querySelectorAll('button:not(#cancel)').forEach(button => button.disabled = value);
  document.querySelectorAll('#editor input,#editor textarea').forEach(input => input.disabled = value);
  if (value) $('progress').removeAttribute('value');
}
async function task(label, operation) {
  if (activeJob) return;
  await flushSave();
  setJob(true, label);
  try { return await operation(); } finally { setJob(false); }
}
function action(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(error => toast(error.message))); }
function changed() {
  dirty = true; revision++; $('save-state').textContent = '待保存';
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flushSave().catch(error => toast(error.message)), 600);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!project || !dirty) return saving;
  validateCues(project.cues);
  const snapshot = { id: project.id, title: project.title, cues: structuredClone(project.cues) };
  const version = revision;
  // Serialize saves, and never let an old response replace the editor's current contents.
  saving = saving.catch(() => {}).then(async () => {
    $('save-state').textContent = '保存中';
    try {
      await rpc('save', snapshot);
      savedRevision = Math.max(savedRevision, version);
      dirty = savedRevision < revision;
      $('save-state').textContent = dirty ? '待保存' : '已保存';
    } catch (error) { dirty = true; $('save-state').textContent = '保存失败'; throw error; }
  });
  return saving;
}
async function navigate(next) {
  if (activeJob) return;
  await flushSave();
  if (next !== 'editor') video.pause();
  view = next;
  for (const id of ['home', 'editor', 'settings']) $(id).hidden = id !== next;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === next));
  $('page-title').textContent = { home: '工作台', editor: '字幕编辑', settings: '识别设置' }[next];
  if (next === 'home') await refreshProjects();
  if (next === 'settings') await refreshStatus();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view).catch(error => toast(error.message))));
async function refreshStatus() {
  status = await rpc('status');
  $('home-model').textContent = status.modelReady ? 'Parakeet 已就绪 · 英文' : '首次使用请到识别设置导入模型';
  $('model-state').textContent = status.modelReady ? '模型已就绪 · 本地 CPU' : '尚未导入模型';
  $('abi').textContent = status.abi;
}
async function refreshProjects() {
  projects = await rpc('list');
  $('project-count').textContent = projects.length;
  $('empty').hidden = projects.length > 0;
  $('project-list').replaceChildren();
  for (const item of projects) {
    const button = document.createElement('button'); button.className = 'project-card';
    const icon = document.createElement('span'); icon.className = 'project-icon'; icon.textContent = item.media ? '▷' : '▤';
    const title = document.createElement('strong'); title.textContent = item.title;
    const subtitle = document.createElement('small'); subtitle.textContent = `${item.media ? '媒体稿件' : '字幕稿件'} · ${new Date(item.updated).toLocaleDateString()}`;
    button.append(icon, title, subtitle);
    button.addEventListener('click', () => openProject(item.id).catch(error => toast(error.message)));
    $('project-list').append(button);
  }
}
async function openProject(id) {
  await flushSave();
  video.pause();
  project = await rpc('load', { id }); dirty = false; revision = 0; savedRevision = 0;
  $('save-state').textContent = '已保存'; $('project-title').value = project.title;
  $('no-project').hidden = true; $('workspace').hidden = false;
  for (const player of [$('video'), $('audio')]) { player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true; }
  const audioOnly = project.mime?.startsWith('audio/');
  video = audioOnly ? $('audio') : $('video');
  if (project.media) { video.src = `https://subfabric.local/media/${project.id}`; video.hidden = false; }
  $('preview-empty').hidden = project.media && !audioOnly;
  $('preview-label').textContent = audioOnly ? '音频预览' : '字幕预览';
  $('preview-description').textContent = audioOnly ? '音频素材 · 同步字幕预览' : '未关联媒体 · 可直接编辑字幕';
  $('recognize').disabled = !project.media;
  renderCues(); await navigate('editor');
}
function updateTimeline() {
  if (!project) return;
  const duration = timelineEnd(project.cues, video.duration);
  $('seek').max = duration;
  $('timeline').replaceChildren();
  for (const cue of project.cues) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(cue.start / duration * 600)); rect.setAttribute('width', String(Math.max(1, (cue.end - cue.start) / duration * 600)));
    rect.setAttribute('y', '7'); rect.setAttribute('height', '38'); rect.setAttribute('rx', '3'); rect.setAttribute('fill', '#86baa2');
    $('timeline').append(rect);
  }
  $('cue-total').textContent = `${project.cues.length} 条字幕`;
}
function renderCues() {
  $('cue-list').replaceChildren(); $('cue-empty').hidden = project.cues.length > 0;
  project.cues.forEach((cue, index) => {
    const card = document.createElement('article'); card.className = 'cue'; card.dataset.index = index;
    const top = document.createElement('div'); top.className = 'cue-top';
    const number = document.createElement('span'); number.className = 'cue-index'; number.textContent = String(index + 1).padStart(2, '0'); top.append(number);
    for (const key of ['start', 'end']) {
      const input = document.createElement('input'); input.value = fmtTime(cue[key], 3); input.setAttribute('aria-label', `${index + 1} ${key === 'start' ? '开始时间' : '结束时间'}`); input.inputMode = 'decimal';
      input.addEventListener('change', () => {
        const value = parseTime(input.value);
        if (!Number.isFinite(value) || value < 0 || (key === 'start' ? value >= cue.end : value <= cue.start)) { input.value = fmtTime(cue[key], 3); toast('时间无效，结束时间须晚于开始时间'); return; }
        cue[key] = value; input.value = fmtTime(value, 3); changed(); updateTimeline();
      }); top.append(input);
    }
    const seek = document.createElement('button'); seek.textContent = '▷'; seek.setAttribute('aria-label', `预览字幕 ${index + 1}`);
    seek.addEventListener('click', () => { if (project.media) video.currentTime = cue.start; else showTime(cue.start); }); top.append(seek);
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `删除字幕 ${index + 1}`);
    remove.addEventListener('click', () => { if (!confirm('删除这条字幕？')) return; project.cues.splice(index, 1); changed(); renderCues(); }); top.append(remove);
    const text = document.createElement('textarea'); text.value = cue.lines.join('\n'); text.setAttribute('aria-label', `字幕 ${index + 1} 内容`); text.spellcheck = false;
    text.addEventListener('input', () => { cue.lines = text.value.split('\n'); changed(); showTime(video.currentTime || cue.start); });
    card.append(top, text); $('cue-list').append(card);
  });
  updateTimeline(); showTime(0);
}
function showTime(time) {
  $('clock').textContent = fmtTime(time, 3).slice(3); $('seek').value = time;
  const current = project?.cues.filter(cue => time >= cue.start && time < cue.end) || [];
  $('subtitle-overlay').textContent = current.map(cue => cue.lines.join('\n')).join('\n');
  document.querySelectorAll('.cue').forEach(card => card.classList.toggle('playing', current.includes(project.cues[Number(card.dataset.index)])));
}
for (const player of [$('video'), $('audio')]) {
  player.addEventListener('timeupdate', () => { if (player === video) showTime(video.currentTime); });
  player.addEventListener('loadedmetadata', () => { if (player === video) updateTimeline(); });
  player.addEventListener('error', () => { if (player === video && player.hasAttribute('src')) toast('此媒体无法预览；可尝试 WAV 音频或 H.264 / AAC MP4'); });
}
$('seek').addEventListener('input', event => { const time = Number(event.target.value); if (project?.media) video.currentTime = time; showTime(time); });
$('project-title').addEventListener('input', () => { if (project) { project.title = $('project-title').value || '未命名稿件'; changed(); } });
action('go-home', () => navigate('home'));
action('import-media', async () => {
  const result = await task('选择音频或视频', () => rpc('pickMedia'));
  if (result) await openProject(result.id);
});
action('new-project', async () => { await flushSave(); const result = await rpc('new'); await openProject(result.id); });
action('demo', async () => {
  await flushSave(); const result = await rpc('new'); result.title = '编辑示例 · 每一句都恰到好处'; result.cues = exampleCues(); await rpc('save', result); await openProject(result.id);
});
action('import-subtitle', async () => {
  if (!project) { const result = await rpc('new'); await openProject(result.id); }
  if (project.cues.length && !confirm('用导入的 SRT 替换当前字幕？')) return;
  const result = await task('选择 SRT 字幕', () => rpc('pickSubtitle'));
  if (!result) return;
  const cues = parseSRT(result.text); validateCues(cues);
  if (!cues.length) throw new Error('文件中没有有效的 SRT 字幕');
  project.cues = cues; changed(); renderCues(); await flushSave(); toast('字幕已导入');
});
action('export', async () => {
  if (!project || !project.cues.length) throw new Error('请先添加字幕');
  validateCues(project.cues); await flushSave();
  const result = await task('选择导出位置', () => rpc('export', { text: serializeSRT([...project.cues].sort((a, b) => a.start - b.start || a.end - b.end)) }));
  if (result) toast('SRT 字幕已导出');
});
action('add-cue', () => {
  if (!project) return;
  const start = Math.max(0, video.currentTime || project.cues.at(-1)?.end || 0);
  project.cues.push({ id: Date.now(), start, end: start + 3, lines: [''] }); changed(); renderCues();
  $('cue-list').lastElementChild?.querySelector('textarea')?.focus();
});
action('recognize', async () => {
  if (!project?.media) throw new Error('请从工作台导入音频或视频');
  await refreshStatus();
  if (!status.modelReady) { await navigate('settings'); toast('请先导入 Parakeet 模型'); return; }
  if (project.cues.length && !confirm('识别成功后将替换当前字幕，是否继续？')) return;
  video.pause();
  const result = await task('加载 Parakeet', () => rpc('recognize', { id: project.id }));
  if (result) { await openProject(result.id); toast(`已生成 ${result.cues.length} 条字幕`); }
});
action('import-model', async () => { const result = await task('选择模型文件夹', () => rpc('pickModel')); if (result) { await refreshStatus(); toast('Parakeet 模型已就绪'); } });
action('cancel', () => rpc('cancel'));
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty && !activeJob) flushSave().catch(() => {}); });
function layoutLabel() { $('layout-label').textContent = matchMedia('(max-width:740px)').matches ? 'PHONE · 单栏' : 'TABLET · 双栏'; }
window.addEventListener('resize', layoutLabel); layoutLabel();
initCopy().then(() => Promise.all([refreshStatus(), refreshProjects()])).catch(error => toast(error.message));
