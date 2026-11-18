import { cloneConfig, normalizeEffectScheme } from './postprocess.js';
import { cleanPresetName, newPresetId, makeStylePreset, normalizeStylePreset, loadPresetLibrary, PRESET_STORE_KEY,
  parsePresetFile, serializePresetFile, presetSummary, uniquePresetName } from './style-preset.js';
import { initSubtitleSchemePreview } from './subtitle-scheme-preview.js';
import { t } from './i18n.js';

const STORAGE_KEY = 'subfabric_subtitle_schemes';
const LEGACY_KEY = 'subfabric_effect_schemes';
const ASS_SCHEME_COMMENT = 'SubFabricSubtitleScheme';

function loadSchemes() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved != null) {
      const rows = JSON.parse(saved);
      return Array.isArray(rows) ? rows.map(raw => normalizeStylePreset(raw).preset).filter(Boolean) : [];
    }
    const schemes = loadPresetLibrary();
    let effects;
    try { effects = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); } catch { return schemes; }
    if (Array.isArray(effects)) for (const raw of effects) {
      const row = normalizeEffectScheme(raw);
      if (!row?.id || !row.name || schemes.some(item => item.id === row.id)) continue;
      schemes.push(makeStylePreset({ id: row.id, name: uniquePresetName(schemes, row.name), fx: row.config }));
    }
    return schemes;
  } catch { return []; }
}

export function initEffectSchemes({ getProject, getDocument, getFormat, capturePreset, legacyConfig, applyConfig,
  applyStyle, saveSubtitle, syncControls, confirmDelete, download, ensureFont, enhanceFontInput, rememberFont, toast }) {
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
  el('ass-style-group').hidden = true;
  el('sf-preset-group').hidden = true;
  el('sf-editor-display').hidden = true;

  const list = el('st-effect-list'), form = el('st-effect-form'), name = el('st-effect-name');
  const add = el('st-effect-new'), status = el('sf-effect-status'), listStatus = el('st-effect-status');
  const file = el('st-effect-file'), exportButton = el('st-effect-export');
  const preview = initSubtitleSchemePreview({ ensureFont, enhanceFontInput, rememberFont, toast });
  let selection = null;
  let pending = null;
  let editId = '';
  let draftConfig = null;

  function renderPicker() {
    const schemes = loadSchemes();
    const current = schemes.find(scheme => scheme.id === selection?.id);
    const sameConfig = current && JSON.stringify(current.fx) === JSON.stringify(selection.config)
      && (selection.revision ? current.updatedAt === selection.revision : !current.style);
    const localSnapshot = selection?.name || selection?.config.enabled;
    const value = sameConfig ? 'scheme:' + current.id
      : localSnapshot || (!selection && legacyConfig.enabled) ? 'snapshot' : 'off';
    const option = (label, key) => {
      const row = document.createElement('option');
      row.textContent = label;
      row.value = key;
      row.defaultSelected = row.selected = value === key;
      return row;
    };
    const choices = [option(t('保留稿件样式 · 关闭特效'), 'off')];
    if (value === 'snapshot') {
      const label = selection ? (selection.name || t('稿件字幕方案')) + ' · ' + t('已保存参数') : t('沿用原有特效');
      choices.push(option(label, 'snapshot'));
    }
    choices.push(...schemes.map(scheme => option(scheme.name, 'scheme:' + scheme.id)));
    select.replaceChildren(...choices);
    select.disabled = !!pending || !getFormat();
    status.textContent = pending ? t('正在保存字幕方案…')
      : value === 'snapshot' && current ? t('当前稿件保留已保存的参数。重新选择同名方案可套用新版。')
      : getFormat() === 'srt' ? t('SRT 仅应用预览字号缩放。')
      : t('用于 ASS 字幕的预览与导出。');
  }

  function loadSelection(doc) {
    let embedded;
    try { embedded = JSON.parse(doc?.getScriptInfoComment(ASS_SCHEME_COMMENT) || 'null'); } catch { /* 兼容旧稿 */ }
    selection = normalizeEffectScheme(embedded) || normalizeEffectScheme(getProject()?.meta?.effectScheme);
    applyConfig(cloneConfig(selection?.config || legacyConfig), false, selection?.overlayFontScale ?? 1);
    renderPicker();
  }

  async function applyScheme(scheme) {
    if (pending) return false;
    const doc = getDocument();
    const snapshot = scheme ? normalizeEffectScheme({
      id: scheme.id, name: scheme.name, config: scheme.fx,
      revision: scheme.style || scheme.overlayFontScale != null ? scheme.updatedAt : undefined,
      overlayFontScale: scheme.overlayFontScale,
    }) : normalizeEffectScheme({ config: cloneConfig(), overlayFontScale: selection?.overlayFontScale });
    if (doc) {
      if (scheme?.style) {
        const result = applyStyle(scheme);
        if (!result.ok) { toast(t(result.error), 4500); renderPicker(); return false; }
      }
      // 将样式行与特效快照作为同一份 ASS 自动保存。原有项目级快照仍可读取。
      doc.setScriptInfoComment(ASS_SCHEME_COMMENT, JSON.stringify(snapshot));
      selection = snapshot;
      applyConfig(cloneConfig(snapshot.config), true, snapshot.overlayFontScale);
      saveSubtitle();
      renderPicker();
      return true;
    }
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
        toast(t('字幕方案保存失败') + '：' + error.message, 4500);
        return false;
      }
      if (getProject() === project) {
        selection = saved;
        applyConfig(cloneConfig(saved.config), true, saved.overlayFontScale);
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
    if (value === 'snapshot' || pending || !getFormat()) { renderPicker(); return; }
    const scheme = loadSchemes().find(row => 'scheme:' + row.id === value);
    if (scheme || value === 'off') void applyScheme(scheme);
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
    exportButton.disabled = !schemes.length;
    if (!schemes.length && !draftConfig) {
      const empty = document.createElement('p');
      empty.className = 'sf-scheme-empty';
      empty.textContent = t('还没有字幕方案');
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
      summary.textContent = t(presetSummary(scheme));
      open.replaceChildren(title, summary);
      const remove = button('删除', 'btn btn-mini', () => confirmDelete(() => {
        if (storeSchemes(loadSchemes().filter(row => row.id !== scheme.id))) {
          if (editId === scheme.id) closeForm();
          add.focus();
        }
      }));
      const exportOne = button('导出', 'btn btn-mini', () => exportSchemes([scheme]));
      card.append(open, exportOne, remove);
      list.append(card);
    }
  }

  function storeSchemes(schemes) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(schemes)); }
    catch {
      toast(t('无法写入本机字幕方案'), 4000);
      return false;
    }
    listStatus.hidden = true;
    renderList(schemes);
    renderPicker();
    return true;
  }

  function startEdit(scheme) {
    const preset = scheme || capturePreset();
    editId = scheme?.id || '';
    draftConfig = cloneConfig(preset.fx);
    name.value = scheme?.name || '';
    name.setCustomValidity('');
    el('st-effect-title').textContent = t(scheme ? '编辑方案' : '添加方案');
    form.hidden = false;
    form.classList.add('open');
    syncControls(draftConfig);
    preview.configure({ ...preset, style: scheme ? preset.style : preset.style || preview.defaultStyle });
    renderList();
    form.scrollIntoView({ block: 'start' });
    name.focus({ preventScroll: true });
  }

  function closeForm(id = editId) {
    draftConfig = null;
    editId = '';
    form.hidden = true;
    form.classList.remove('open');
    renderList();
    const previous = [...list.querySelectorAll('[data-effect-edit]')].find(row => row.dataset.effectEdit === id);
    (previous || add).focus({ preventScroll: true });
  }

  function exportSchemes(schemes) {
    if (!schemes.length) return;
    const title = schemes.length === 1 ? schemes[0].name : t('字幕方案');
    const safeName = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    download(safeName + '.style-preset.json', serializePresetFile(schemes), 'application/json;charset=utf-8');
  }

  function announce(message) {
    listStatus.textContent = t(message);
    listStatus.hidden = false;
  }

  exportButton.addEventListener('click', () => exportSchemes(loadSchemes()));
  el('st-effect-import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    if (picked.size > 1024 * 1024) { announce('方案文件超过 1 MB'); return; }
    try {
      const parsed = parsePresetFile(await picked.text());
      if (!parsed.ok) { announce(parsed.error); return; }
      const schemes = loadSchemes();
      for (const row of parsed.presets) {
        const title = uniquePresetName(schemes, row.name);
        schemes.push({ ...row, id: newPresetId(), name: title });
      }
      if (storeSchemes(schemes)) announce(parsed.skipped
        ? `已导入 ${parsed.presets.length} 条方案，跳过 ${parsed.skipped} 条无效记录`
        : `已导入 ${parsed.presets.length} 条方案`);
    } catch (error) { announce(t('方案导入失败') + '：' + error.message); }
  });

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
    const existing = schemes.find(row => row.id === editId);
    const result = normalizeStylePreset(makeStylePreset({
      id: editId || newPresetId(), name: title, createdAt: existing?.createdAt, fx: draftConfig, ...preview.read(),
    }));
    if (!result.ok) { toast(t(result.error), 4500); return; }
    const scheme = result.preset;
    const index = schemes.findIndex(row => row.id === editId);
    if (index >= 0) schemes[index] = scheme;
    else schemes.push(scheme);
    if (storeSchemes(schemes)) {
      closeForm(scheme.id);
      announce('方案已保存');
    }
  });
  window.addEventListener('storage', event => {
    if (![STORAGE_KEY, LEGACY_KEY, PRESET_STORE_KEY, null].includes(event.key)) return;
    renderList();
    renderPicker();
  });

  renderList();
  renderPicker();
  return {
    loadSelection,
    waitForSave: () => pending,
    editConfig(mutate) {
      if (!draftConfig) return;
      mutate(draftConfig);
      syncControls(draftConfig);
      preview.queue(draftConfig);
    },
  };
}
