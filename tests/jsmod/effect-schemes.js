import { cloneConfig, normalizeEffectScheme } from './postprocess.js';
import { cleanPresetName, newPresetId } from './style-preset.js';
import { t } from './i18n.js';

const STORAGE_KEY = 'subfabric_effect_schemes';

function loadSchemes() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.map(normalizeEffectScheme).filter(scheme => scheme?.id && scheme.name) : [];
  } catch { return []; }
}

function describe(config) {
  if (!config.enabled) return t('关闭特效');
  const effects = [];
  if (config.glow.enabled && (config.glow.zh.enabled || config.glow.en.enabled)) effects.push(t('微光'));
  if (config.fadein.enabled) effects.push(t('柔和淡入'));
  if (config.grow.enabled) effects.push(t('词生长'));
  return effects.join(' · ') || t('未启用任何效果');
}

export function initEffectSchemes({ getProject, getConfig, legacyConfig, applyConfig, syncControls, confirmDelete, toast }) {
  const el = id => document.getElementById(id);
  const controls = el('ass-fx-group');
  const select = el('sf-effect-select');
  if (!select || window.androidRpc) {
    if (controls) controls.hidden = false;
    return null;
  }

  el('st-effect-controls').append(controls);
  controls.hidden = false;
  el('sf-effect-picker').hidden = false;
  el('sf-settings-tab-effects').hidden = false;

  const list = el('st-effect-list'), form = el('st-effect-form'), name = el('st-effect-name');
  const add = el('st-effect-new'), status = el('sf-effect-status'), listStatus = el('st-effect-status');
  let selection = null;
  let pending = null;
  let editId = '';
  let draftConfig = null;

  function renderPicker() {
    const schemes = loadSchemes();
    const current = schemes.find(scheme => scheme.id === selection?.id);
    const sameConfig = current && JSON.stringify(current.config) === JSON.stringify(selection.config);
    const localSnapshot = selection?.name || selection?.config.enabled;
    const value = sameConfig ? 'scheme:' + current.id
      : localSnapshot || (!selection && legacyConfig.enabled) ? 'snapshot' : 'off';
    const option = (label, key) => new Option(label, key, value === key, value === key);
    const choices = [option(t('关闭特效'), 'off')];
    if (value === 'snapshot') {
      const label = selection ? (selection.name || t('稿件特效')) + ' · ' + t('已保存参数') : t('沿用原有特效');
      choices.push(option(label, 'snapshot'));
    }
    choices.push(...schemes.map(scheme => option(scheme.name, 'scheme:' + scheme.id)));
    select.replaceChildren(...choices);
    select.disabled = !!pending;
    status.textContent = pending ? t('正在保存特效方案…')
      : value === 'snapshot' && current ? t('当前稿件保留已保存的参数。重新选择同名方案可套用新版。')
      : t('用于 ASS 字幕的预览与导出。');
  }

  function projectChanged() {
    selection = normalizeEffectScheme(getProject()?.meta?.effectScheme);
    applyConfig(cloneConfig(selection?.config || legacyConfig), false);
    renderPicker();
  }

  async function applySnapshot(snapshot) {
    if (pending) return false;
    const project = getProject();
    const work = async () => {
      let saved = snapshot;
      try {
        if (project) {
          const response = await fetch(`/api/projects/${project.id}/effect-scheme`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot), signal: AbortSignal.timeout(8000),
          });
          const data = await response.json();
          saved = normalizeEffectScheme(data.effectScheme);
          if (!response.ok || !saved) throw new Error(data.error || response.status);
          project.meta.effectScheme = saved;
        }
      } catch (error) {
        toast(t('特效方案保存失败') + '：' + error.message, 4500);
        return false;
      }
      if (getProject() === project) {
        selection = saved;
        applyConfig(cloneConfig(saved.config), true);
      }
      return true;
    };
    pending = work();
    renderPicker();
    try { return await pending; }
    finally {
      pending = null;
      renderPicker();
    }
  }

  select.addEventListener('change', () => {
    const value = select.value;
    if (value === 'snapshot' || pending) return;
    const scheme = value === 'off'
      ? { id: '', name: '', config: cloneConfig() }
      : loadSchemes().find(row => 'scheme:' + row.id === value);
    if (scheme) void applySnapshot(scheme);
    else renderPicker();
  });

  function button(label, className, click) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = t(label);
    node.addEventListener('click', click);
    return node;
  }

  function renderList(schemes = loadSchemes()) {
    list.replaceChildren();
    if (!schemes.length && !draftConfig) {
      const empty = document.createElement('p');
      empty.className = 'sf-scheme-empty';
      empty.textContent = t('还没有特效方案');
      list.append(empty);
    }
    for (const scheme of schemes) {
      const card = document.createElement('div');
      card.className = 'st-scheme';
      card.classList.toggle('cur', editId === scheme.id);
      const open = button('编辑方案', 'sf-scheme-open', () => startEdit(scheme));
      open.dataset.effectEdit = scheme.id;
      open.setAttribute('aria-controls', form.id);
      open.setAttribute('aria-expanded', String(editId === scheme.id));
      const title = document.createElement('span'), summary = document.createElement('span');
      title.className = 'st-scheme-name';
      title.textContent = scheme.name;
      summary.className = 'st-scheme-desc';
      summary.textContent = describe(scheme.config);
      open.replaceChildren(title, summary);
      const remove = button('删除', 'btn btn-mini', () => confirmDelete(() => {
        if (storeSchemes(loadSchemes().filter(row => row.id !== scheme.id))) {
          if (editId === scheme.id) closeForm();
          add.focus();
        }
      }));
      card.append(open, remove);
      list.append(card);
    }
  }

  function storeSchemes(schemes) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(schemes)); }
    catch {
      toast(t('无法写入本机特效方案'), 4000);
      return false;
    }
    listStatus.hidden = true;
    renderList(schemes);
    renderPicker();
    return true;
  }

  function startEdit(scheme) {
    editId = scheme?.id || '';
    draftConfig = cloneConfig(scheme?.config || getConfig());
    if (!scheme) draftConfig.enabled = true;
    name.value = scheme?.name || '';
    name.setCustomValidity('');
    el('st-effect-title').textContent = t(scheme ? '编辑方案' : '添加方案');
    form.hidden = false;
    form.classList.add('open');
    syncControls(draftConfig);
    renderList();
    name.focus();
  }

  function closeForm(id = editId) {
    draftConfig = null;
    editId = '';
    form.hidden = true;
    form.classList.remove('open');
    renderList();
    (id && list.querySelector(`[data-effect-edit="${id}"]`) || add).focus({ preventScroll: true });
  }

  add.addEventListener('click', () => startEdit());
  el('st-effect-cancel').addEventListener('click', () => closeForm());
  name.addEventListener('input', () => name.setCustomValidity(''));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!draftConfig) return;
    const schemes = loadSchemes();
    const title = name.value.trim() ? cleanPresetName(name.value) : '';
    if (!title || schemes.some(row => row.id !== editId && row.name.toLowerCase() === title.toLowerCase())) {
      name.setCustomValidity(t(title ? '已有同名方案' : '请填写方案名称'));
      name.reportValidity();
      return;
    }
    const scheme = normalizeEffectScheme({ id: editId || newPresetId(), name: title, config: draftConfig });
    const index = schemes.findIndex(row => row.id === editId);
    if (index >= 0) schemes[index] = scheme;
    else schemes.push(scheme);
    if (storeSchemes(schemes)) {
      closeForm(scheme.id);
      listStatus.textContent = t('方案已保存');
      listStatus.hidden = false;
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    renderList();
    renderPicker();
  });

  renderList();
  renderPicker();
  return {
    projectChanged,
    applySnapshot,
    waitForSave: () => pending,
    editConfig(mutate) {
      if (!draftConfig) return;
      mutate(draftConfig);
      syncControls(draftConfig);
    },
  };
}
