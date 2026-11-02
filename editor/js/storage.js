/**
 * 存储空间页：扫描结果渲染、选择状态、清理预览与确认。
 *
 * 数据来源：
 *  · 文件类条目全部来自 GET /api/storage（服务端白名单扫描，客户端只回传 id）；
 *  · 主题残留是纯浏览器状态（隐藏主题的偏好与导入包），在本地清理并立即写回偏好。
 *
 * 这个模块不碰文件系统，也不拼路径；删除请求只携带 id。
 */
import { STUDIO_KEY } from './studio-state.js';
import { ico } from './icons.js';

const CATEGORY_META = {
  project: { name: '项目中间文件', icon: 'folder', note: '音频、波形与识别原始结果' },
  model: { name: '语音模型', icon: 'mic', note: '删除后需要重新下载' },
  runtime: { name: 'ASR 运行时', icon: 'wrench', note: '未启用的后端环境' },
  cache: { name: '缓存', icon: 'activity', note: '字节码缓存会自动重建' },
  log: { name: '日志', icon: 'file', note: '仅列出保留期之外的记录' },
  theme: { name: '主题残留', icon: 'palette', note: '已下线主题留下的配置' },
};
const FILTERS = ['all', 'project', 'model', 'runtime', 'cache', 'log', 'theme'];
const RECOMMENDED = new Set(['model', 'runtime', 'cache', 'log']);

const $ = id => document.getElementById(id);
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return text + ' ' + units[index];
}

/**
 * 已下线主题在浏览器里留下的东西：偏好里的 themePack、以及用同设计导入的主题包。
 * 只读取原始存储，不信任内存里已被归一化的 prefs。
 */
export function themeResidue(themes, prefs) {
  const hiddenIds = new Set(themes.hiddenThemes.map(pack => pack.id));
  const hiddenDesigns = new Set(themes.hiddenThemes.map(pack => pack.design));
  const out = [];
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STUDIO_KEY) || '{}') || {}; } catch { raw = {}; }
  if (hiddenIds.has(raw.themePack)) {
    const name = themes.hiddenThemes.find(pack => pack.id === raw.themePack)?.name || raw.themePack;
    out.push({
      id: 'theme:prefs', category: 'theme', client: true, removable: true,
      name: '偏好指向已下线主题',
      detail: `${name}（${raw.themePack}）· 启动时已回退到 Windows 10`,
      size: byteLength(JSON.stringify({ themePack: raw.themePack })), files: 1, mtime: null,
    });
  }
  for (const pack of prefs.custom || []) {
    if (!pack || !hiddenDesigns.has(pack.design)) continue;
    out.push({
      id: 'theme:pack:' + pack.id, category: 'theme', client: true, removable: true,
      name: pack.name || pack.id,
      detail: `导入主题包 · ${pack.design} 设计已停用`,
      size: byteLength(JSON.stringify(pack)), files: 1, mtime: null, packId: pack.id,
    });
  }
  return out;
}
function byteLength(text) {
  try { return new TextEncoder().encode(String(text || '')).length; } catch { return String(text || '').length; }
}

export function createStoragePage({ themes, getPrefs, applyPrefs, notify }) {
  const state = {
    scan: null, items: [], residue: [], filter: 'all', selected: new Set(),
    loading: false, error: '', note: '', open: false, busy: false,
  };
  let wired = false;

  function allItems() { return [...state.items, ...state.residue]; }
  function visibleItems() {
    return allItems().filter(item => state.filter === 'all' || item.category === state.filter);
  }
  function selectedItems() { return allItems().filter(item => state.selected.has(item.id)); }
  function selectedSize() { return selectedItems().reduce((sum, item) => sum + (Number(item.size) || 0), 0); }

  function setNote(text, tone = '') {
    state.note = text;
    const node = $('stg-note');
    if (!node) return;
    node.textContent = text;
    node.dataset.tone = tone;
    node.hidden = !text;
  }

  function syncResidue() {
    state.residue = themeResidue(themes, getPrefs());
    const valid = new Set(allItems().map(item => item.id));
    state.selected.forEach(id => { if (!valid.has(id)) state.selected.delete(id); });
  }

  function categories() {
    const list = [];
    for (const [id, meta] of Object.entries(CATEGORY_META)) {
      const items = allItems().filter(item => item.category === id);
      if (!items.length) continue;
      list.push({
        id, ...meta,
        count: items.length,
        size: items.reduce((sum, item) => sum + (Number(item.size) || 0), 0),
        cleanable: items.filter(item => item.removable).reduce((sum, item) => sum + (Number(item.size) || 0), 0),
      });
    }
    return list;
  }

  function renderOverview() {
    const disk = state.scan?.disk || { total: 0, used: 0, free: 0 };
    const used = disk.used, total = disk.total;
    const pct = total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0;
    $('stg-used').textContent = total > 0 ? formatBytes(used) : '—';
    $('stg-disk-note').textContent = total > 0
      ? `共 ${formatBytes(total)} · 可用 ${formatBytes(disk.free)}`
      : '未能读取磁盘容量';
    const cleanable = allItems().filter(item => item.removable).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    $('stg-cleanable').textContent = formatBytes(cleanable);
    const ring = $('stg-ring-value');
    const radius = 50, c = 2 * Math.PI * radius;
    ring.setAttribute('stroke-dasharray', `${(pct / 100 * c).toFixed(2)} ${c.toFixed(2)}`);
    ring.setAttribute('stroke-dashoffset', '0');
    ring.dataset.percent = String(Math.round(pct));
    $('stg-ring').setAttribute('aria-label', `磁盘已用 ${Math.round(pct)}%`);

    const cats = categories();
    const bar = $('stg-bar'), legend = $('stg-legend');
    if (!cats.length) { bar.innerHTML = ''; legend.innerHTML = ''; return; }
    const totalCat = cats.reduce((sum, category) => sum + category.size, 0) || 1;
    bar.innerHTML = cats.map(category => `<i data-cat="${category.id}" style="width:${(category.size / totalCat * 100).toFixed(2)}%"></i>`).join('');
    legend.innerHTML = cats.map(category =>
      `<span class="stg-legend-item"><i data-cat="${category.id}"></i>${esc(category.name)} <b>${formatBytes(category.size)}</b></span>`).join('');
  }

  function renderCategories() {
    const cats = categories();
    $('stg-categories').innerHTML = cats.map(category => `
      <button class="stg-tile" type="button" data-cat-tile="${category.id}" aria-pressed="${state.filter === category.id}">
        <span class="stg-tile-top"><span>${esc(category.name)}</span><span class="stg-tile-ico">${ico(category.icon)}</span></span>
        <strong>${formatBytes(category.size)}</strong>
        <small>${category.count} 项 · 可清理 ${formatBytes(category.cleanable)}</small>
      </button>`).join('');
    $('stg-categories').querySelectorAll('[data-cat-tile]').forEach(button => {
      button.addEventListener('click', () => { state.filter = button.dataset.catTile; render(); });
    });
  }

  function renderChips() {
    const cats = categories();
    const counts = Object.fromEntries(cats.map(category => [category.id, category.count]));
    const total = cats.reduce((sum, category) => sum + category.count, 0);
    const chips = FILTERS.filter(id => id === 'all' || counts[id]).map(id => {
      const name = id === 'all' ? '全部' : CATEGORY_META[id].name;
      const count = id === 'all' ? total : counts[id];
      return `<button class="stg-chip" type="button" role="tab" data-filter="${id}" aria-selected="${state.filter === id}">${esc(name)} <em>${count}</em></button>`;
    }).join('');
    $('stg-chips').innerHTML = chips;
    $('stg-chips').querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => { state.filter = button.dataset.filter; render(); });
    });
  }

  function renderList() {
    const visible = visibleItems();
    $('stg-visible-count').textContent = visible.length + ' 项';
    const list = $('stg-list');
    if (state.loading && !allItems().length) {
      list.innerHTML = '<div class="stg-empty"><b>正在扫描…</b><span>统计项目、模型与运行时的占用，第一次可能需要几秒。</span></div>';
    } else if (state.error) {
      list.innerHTML = `<div class="stg-empty is-error"><b>扫描失败</b><span>${esc(state.error)}</span><button class="btn" type="button" data-retry>重试</button></div>`;
      list.querySelector('[data-retry]')?.addEventListener('click', () => load(true));
    } else if (!visible.length) {
      list.innerHTML = '<div class="stg-empty"><b>这一类没有可清理内容</b><span>切换其它分类，或重新扫描查看最新占用。</span></div>';
    } else {
      list.innerHTML = visible.map(item => {
        const meta = CATEGORY_META[item.category];
        const checked = state.selected.has(item.id);
        return `<label class="stg-row${item.removable ? '' : ' is-protected'}${checked ? ' is-checked' : ''}" data-id="${esc(item.id)}">
          <span class="stg-check"><input type="checkbox" data-select="${esc(item.id)}" ${checked ? 'checked' : ''} ${item.removable ? '' : 'disabled'}><span class="stg-box"></span></span>
          <span class="stg-row-ico">${ico(meta.icon)}</span>
          <span class="stg-row-copy"><b>${esc(item.name)}</b><span>${esc(item.detail || '')}</span></span>
          ${item.removable ? '' : `<span class="stg-badge">受保护</span>`}
          <span class="stg-row-size">${formatBytes(item.size)}</span>
        </label>`;
      }).join('');
      list.querySelectorAll('[data-select]').forEach(input => {
        input.addEventListener('change', () => {
          if (input.checked) state.selected.add(input.dataset.select);
          else state.selected.delete(input.dataset.select);
          render();
        });
      });
    }
    const visibleRemovable = visible.filter(item => item.removable);
    const selectedVisible = visibleRemovable.filter(item => state.selected.has(item.id)).length;
    const all = $('stg-select-all');
    all.checked = visibleRemovable.length > 0 && selectedVisible === visibleRemovable.length;
    all.indeterminate = selectedVisible > 0 && selectedVisible < visibleRemovable.length;
    all.disabled = visibleRemovable.length === 0;
    $('stg-toolbar-note').textContent = visibleRemovable.length
      ? `${visibleRemovable.length} 项可清理` : '当前分类全部受保护';
    $('stg-recommend').disabled = !allItems().some(item => item.removable && RECOMMENDED.has(item.category));
  }

  function renderFoot() {
    const selected = selectedItems();
    $('stg-selected-count').textContent = String(selected.length);
    $('stg-selected-size').textContent = formatBytes(selectedSize());
    $('stg-preview').disabled = selected.length === 0 || state.busy;
    $('stg-preview').textContent = state.busy ? '正在清理…' : '查看清理预览';
  }

  function renderResidue() {
    const card = $('stg-residue');
    const residue = state.residue;
    if (!residue.length) { card.hidden = true; return; }
    card.hidden = false;
    const packs = residue.filter(item => item.packId);
    $('stg-residue-copy').textContent = [
      'Claude 与 SubFabric Classic 已从主题选择器下线。',
      residue.some(item => item.id === 'theme:prefs') ? '偏好里仍指向已下线主题，会被回退到 Windows 10。' : '',
      packs.length ? `还有 ${packs.length} 个用旧设计导入的主题包，已不在设置里显示。` : '',
    ].filter(Boolean).join(' ');
    $('stg-residue-clean').textContent = `清理 ${residue.length} 项残留`;
  }

  function render() {
    renderOverview();
    renderCategories();
    renderChips();
    renderList();
    renderFoot();
    renderResidue();
    $('stg-scan-state').textContent = state.loading ? '正在扫描…'
      : state.scan ? `上次扫描 ${new Date(state.scan.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未扫描';
  }

  function wire() {
    if (wired) return;
    wired = true;
    $('stg-rescan').addEventListener('click', () => load(true));
    $('stg-select-all').addEventListener('change', event => {
      const visible = visibleItems().filter(item => item.removable);
      if (event.target.checked) visible.forEach(item => state.selected.add(item.id));
      else visible.forEach(item => state.selected.delete(item.id));
      render();
    });
    $('stg-recommend').addEventListener('click', () => {
      state.selected.clear();
      allItems().filter(item => item.removable && RECOMMENDED.has(item.category)).forEach(item => state.selected.add(item.id));
      render();
    });
    $('stg-preview').addEventListener('click', openDialog);
    $('stg-residue-clean').addEventListener('click', () => {
      state.selected.clear();
      state.residue.forEach(item => state.selected.add(item.id));
      render();
      openDialog();
    });
    $('stg-dialog').addEventListener('click', event => {
      if (event.target === $('stg-dialog')) $('stg-dialog').close();
    });
    $('stg-dialog').querySelector('[data-close]')?.addEventListener('click', () => $('stg-dialog').close());
    $('stg-confirm').addEventListener('click', confirmClean);
  }

  function openDialog() {
    const selected = selectedItems();
    if (!selected.length) return;
    const groups = new Map();
    for (const item of selected) {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item);
    }
    $('stg-dialog-list').innerHTML = [...groups].map(([category, items]) => `
      <li><b>${esc(CATEGORY_META[category].name)}</b><span>${items.length} 项 · ${formatBytes(items.reduce((sum, item) => sum + (Number(item.size) || 0), 0))}</span>
        <em>${items.map(item => esc(item.name)).join('、')}</em></li>`).join('');
    const hasProject = selected.some(item => item.category === 'project');
    const warn = $('stg-dialog-warn');
    warn.hidden = !hasProject;
    warn.textContent = hasProject
      ? '项目中间文件删除后，需要原视频仍可访问才能重新提取；字幕、项目信息与原始视频不会被删除。'
      : '';
    $('stg-dialog').showModal();
  }

  async function confirmClean() {
    const dialog = $('stg-dialog');
    if ($('stg-confirm').dataset.busy === '1') return;
    const selected = selectedItems();
    if (!selected.length) { dialog.close(); return; }
    $('stg-confirm').dataset.busy = '1';
    $('stg-confirm').disabled = true;
    state.busy = true; renderFoot();
    const fsIds = selected.filter(item => !item.client).map(item => item.id);
    const themeItems = selected.filter(item => item.client);
    let freed = 0, failed = [];
    let themeDone = 0;
    try {
      if (fsIds.length) {
        const response = await fetch('/api/storage/clean', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: fsIds }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(result.error || ('清理失败（HTTP ' + response.status + '）'));
        freed += Number(result.freed) || 0;
        failed = failed.concat(result.failed || []);
      }
      if (themeItems.length) {
        themeDone = cleanThemeResidue(themeItems);
      }
      state.selected.clear();
      dialog.close();
      const pieces = [];
      if (freed) pieces.push(`已释放 ${formatBytes(freed)}`);
      if (themeDone) pieces.push(`已清理 ${themeDone} 项主题残留`);
      if (failed.length) pieces.push(`${failed.length} 项失败：` + failed.map(item => item.name || item.id).join('、'));
      setNote(pieces.length ? pieces.join('；') : '没有删除任何文件', failed.length ? 'warn' : 'ok');
      notify?.(pieces.join('；'), failed.length ? 'warn' : 'ok');
    } catch (error) {
      setNote(error.message, 'warn');
      notify?.(error.message, 'warn');
    } finally {
      state.busy = false;
      delete $('stg-confirm').dataset.busy;
      $('stg-confirm').disabled = false;
      await load(false);
    }
  }

  function cleanThemeResidue(items) {
    const prefs = getPrefs();
    let next = prefs.custom;
    let removedPacks = 0;
    for (const item of items) {
      if (item.packId) {
        next = next.filter(pack => pack.id !== item.packId);
        removedPacks++;
      }
    }
    /* 无论清理的是偏好还是导入包，都完整落盘一次：normalizeStudio 会把旧 themePack
       归一化成当前可见主题，导入包则从 custom 里真正移除。 */
    applyPrefs({ custom: next, themePack: prefs.themePack });
    return removedPacks + (items.some(item => item.id === 'theme:prefs') ? 1 : 0);
  }

  async function load(force) {
    if (state.loading && !force) return;
    state.loading = true; state.error = '';
    syncResidue();
    render();
    try {
      const response = await fetch('/api/storage', { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || ('扫描失败（HTTP ' + response.status + '）'));
      state.scan = result;
      state.items = Array.isArray(result.items) ? result.items : [];
      state.selected.clear();
      if (result.truncated) setNote('目录过大，部分条目只做了不完全统计；清理前建议重新扫描。', 'warn');
      else if (force) setNote('已重新扫描', 'ok');
    } catch (error) {
      state.error = error.message || String(error);
      state.scan = null; state.items = [];
    } finally {
      state.loading = false;
      syncResidue();
      render();
    }
  }

  return {
    /** 路由进入时调用：首次进入才扫描，之后复用结果。 */
    open() {
      wire();
      state.open = true;
      syncResidue();
      if (!state.scan && !state.loading && !state.error) load(false);
      else render();
    },
    refreshResidue() {
      if (!state.open) return;
      syncResidue();
      render();
    },
    _state: state,
  };
}
