// 只保存界面偏好/文件夹关系；字幕、任务、模型、凭据不进入浏览器演示状态。
export const STUDIO_KEY = 'subfabric-studio-v1';
export const defaults = Object.freeze({ themePack: 'studio', accent: '#5c7560', mode: 'light', background: 'solid', image: '', motion: 'on', auroraColors: [], auroraMotion: 'dynamic', glassDim: 80, glassBlur: 18, glassOpacity: 100, custom: [], folders: [], assignments: {}, recent: '', view: 'grid' });
const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
export function imageData(s) {
  return typeof s === 'string' && s.length <= 2800000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(s);
}
export function normalizeStudio(value, themes) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const custom = themes.validList(v.custom) ? v.custom.map(pack => themes.asCustom(pack)).filter(Boolean) : [];
  const folders = Array.isArray(v.folders) ? v.folders.filter(f => f && id(f.id) && typeof f.name === 'string' && f.name.trim() && f.name.length <= 60).slice(0, 40).map(f => ({ id: f.id, name: f.name.trim() })) : [];
  const unique = folders.filter((f, i) => folders.findIndex(x => x.id === f.id) === i);
  const assignments = Object.fromEntries(Object.entries(v.assignments && typeof v.assignments === 'object' ? v.assignments : {}).filter(([p, f]) => id(p) && unique.some(x => x.id === f)).slice(0, 5000));
  return { ...defaults, themePack: themes.get(v.themePack, custom).id, accent: themes.hex(v.accent) ? v.accent : defaults.accent,
    mode: ['light', 'dark', 'system'].includes(v.mode) ? v.mode : 'light', background: ['solid', 'aurora', 'image'].includes(v.background) ? v.background : 'solid',
    auroraColors: Array.isArray(v.auroraColors) && v.auroraColors.length === 3 && v.auroraColors.every(color => themes.hex(color)) ? [...v.auroraColors] : [],
    auroraMotion: v.auroraMotion === 'static' ? 'static' : 'dynamic',
    glassDim: typeof v.glassDim === 'number' && Number.isFinite(v.glassDim) ? Math.max(72, Math.min(92, Math.round(v.glassDim))) : defaults.glassDim,
    glassBlur: typeof v.glassBlur === 'number' && Number.isFinite(v.glassBlur) ? Math.max(0, Math.min(32, Math.round(v.glassBlur))) : defaults.glassBlur,
    glassOpacity: typeof v.glassOpacity === 'number' && Number.isFinite(v.glassOpacity) ? Math.max(20, Math.min(100, Math.round(v.glassOpacity))) : defaults.glassOpacity,
    image: imageData(v.image) ? v.image : '', motion: v.motion === 'off' ? 'off' : 'on', custom, folders: unique, assignments, recent: id(v.recent) ? v.recent : '', view: v.view === 'list' ? 'list' : 'grid' };
}
export function projectPhase(project) {
  if (project.fetching || project.prepare?.status === 'running' || project.draft?.status === 'running') return 'active';
  if (['error', 'paused'].includes(project.draft?.status) || project.prepare?.status === 'error' || project.videoExists === false) return 'attention';
  if (project.format) return 'ready';
  return project.draft?.status ? 'attention' : 'active';
}
export function matchesProject(project, { route = '#/home', filter = 'all', search = '', folder = '' } = {}, assignments = {}) {
  if (route === '#/tasks' && !project.draft && projectPhase(project) !== 'active' && !project.fetching && project.prepare?.status !== 'error') return false;
  if (folder && assignments[project.id] !== folder) return false;
  if (filter !== 'all' && projectPhase(project) !== filter) return false;
  return `${project.name || ''} ${project.video?.name || ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}
