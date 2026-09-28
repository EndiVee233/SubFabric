/** 右侧编辑面板: 虚拟滚动卡片列表(中英双行) + 列表内行内编辑(无独立编辑框) */
import { fmtTime, escapeHtml, bisectStart } from './util.js';
import { t } from './i18n.js';

const ROW_H = 92;

/* ─────────── 角色(说话人)配色 ─────────── */

/** '#rrggbb' → {r,g,b} | null */
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const h = m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/**
 * 角色色在深色卡片底(#1a1a21)上的可读化。
 * 纯红 #e50b0b 这类低亮度颜色直接当文字色会糊进背景, 按亮度缺口混白提亮。
 */
function roleTone(hex) {
  const c = hexRgb(hex);
  if (!c) return null;
  let { r, g, b } = c;
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (L < 0.55) {
    const k = ((0.55 - L) / 0.55) * 0.55;
    r = Math.round(r + (255 - r) * k);
    g = Math.round(g + (255 - g) * k);
    b = Math.round(b + (255 - b) * k);
  }
  return { r, g, b, css: `rgb(${r},${g},${b})` };
}

export class EditorPanel {
  constructor() {
    this.listEl = document.getElementById('cue-list');
    this.spacerEl = document.getElementById('cue-spacer');
    this.searchBox = document.getElementById('search-box');
    this.searchBtn = document.getElementById('btn-search');
    this.phName = document.getElementById('ph-name');
    this.badBtn = document.getElementById('btn-bad-rows');
    this.badCountEl = document.getElementById('bad-count');
    this.badgeEl = document.getElementById('badge-format');
    this.modeSel = document.getElementById('sel-display-mode');
    this.items = [];          // 全量
    this.filtered = [];       // 过滤后
    this.selected = null;
    this.playingItem = null;
    this._filterText = '';
    this._badOnly = false;    // 只看异常行
    this._mode = 'bi';        // bi(双行) | first(仅主) | second(仅副)
    this._progScroll = false;
    this.followPlayback = true;   // 播放时字幕列表自动滚到对应行(可在设置面板关闭)

    // 行内编辑状态
    this.editItem = null;     // 正在编辑的条目
    this.editorEl = null;     // 行内编辑器 DOM
    this._editTag = '';       // 编辑框里被隐藏的角色标签(如 '[Spoke] '), 提交时补回

    this.onSelect = null;
    this.onSeek = null;       // 双击非文字区域 → 跳转到该条时间点
    this.onApply = null;
    this.onModeChange = null;

    // Tab / 角色状态
    this._tab = 'subs';
    this._roles = [];
    this._speaker = '';       // 角色(说话人)筛选: 非空时只显示该角色字幕
    this._tabBtns = [];
    this.onAssignRole = null; // 单击角色 → 设为播放头所在字幕块的说话人
    this.onRenameRole = null; // 右键菜单·修改名称 → (oldName, newName) 全局
    this.onRecolorRole = null;// 右键菜单·修改颜色 → (name, '#rrggbb') 全局
    this.onDeleteCard = null; // 字幕卡片右键 → 删除该条(与时间轴右键删除同一套逻辑)
    this.onFixCard = null;    // 字幕卡片右键 → 修复该条字幕(与时间轴右键修复同一套逻辑)
    this.onAddRole = null;    // 角色列表里的"＋ 添加角色"
    this.cardMenu = null;
    this._cardMenuItem = null;
    this.roleMenu = null;
    this.renameBox = null;
    this._menuRole = null;
    this._menuPos = { x: 0, y: 0 };
    this._renameRole = null;
    this._colorRole = null;

    this._bind();
  }

  _bind() {
    this.listEl.addEventListener('scroll', () => {
      if (this._progScroll) { this._progScroll = false; return; }
      this._userScrollAt = performance.now();
      this._render();
    });
    // 单击: 文字区域 → 原地进入编辑; 非文字区域 → 仅选中(不跳转)
    // 双击(非文字区域) → 跳转: 手动判定, 因为单击会触发重渲染换掉 DOM 节点,
    // 浏览器之后就不再派发 dblclick 事件了(所以不能依赖 dblclick 监听)。
    this.listEl.addEventListener('click', (e) => {
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      const card = e.target.closest('.cue-card');
      if (!card) return;
      const item = this.filtered[+card.dataset.idx];
      if (!item) return;
      const line = e.target.closest('.cc-l1') ? 1 : (e.target.closest('.cc-l2') ? 2 : 0);
      const now = performance.now();
      if (!line) {
        const last = this._lastClick;
        if (last && last.item === item && now - last.t < 400) {
          this._lastClick = null;
          if (this.onSelect) this.onSelect(item);
          if (this.onSeek) this.onSeek(item);      // 双击非文字区域 → 跳转到该条开始时间
          return;
        }
        this._lastClick = { item, t: now };
      } else {
        this._lastClick = null;                     // 点文字区域只进入编辑, 不算双击
      }
      if (this.onSelect) this.onSelect(item);
      if (line) this.startEdit(item, line);
    });
    this.searchBox.addEventListener('input', () => {
      this._filterText = this.searchBox.value.trim().toLowerCase();
      this._applyFilter();
    });
    if (this.searchBtn) {
      // 实时过滤已由输入框承担; 按钮本身打开「查找与批量替换」(main.js 注册 onFindReplace)
      this.searchBtn.addEventListener('click', () => {
        if (this.onFindReplace) { this.onFindReplace(); return; }
        this.searchBox.focus();
      });
    }
    // 角色筛选: 选了某角色 → 只显示该角色说的字幕
    this.roleFilterSel = document.getElementById('sel-role-filter');
    if (this.roleFilterSel) {
      this.roleFilterSel.addEventListener('change', () => {
        const v = this.roleFilterSel.value;
        this.setSpeakerFilter(v === '__all__' ? '' : v);
      });
    }
    if (this.modeSel) {
      this.modeSel.addEventListener('change', () => {
        this._mode = this.modeSel.value;
        this._applyFilter();
        this.onModeChange && this.onModeChange(this._mode);
      });
    }
    if (this.badBtn) {
      this.badBtn.addEventListener('click', () => {
        this._badOnly = !this._badOnly;
        this.badBtn.classList.toggle('active', this._badOnly);
        this._applyFilter();
      });
    }
    // Tab 切换: 字幕 / 角色 / 设置
    this._tabBtns = Array.from(document.querySelectorAll('#panel-tabs .ptab'));
    this._tabBtns.forEach(btn => {
      btn.addEventListener('click', () => this.showTab(btn.dataset.tab));
    });
    this._bindRoleMenu();   // 角色右键菜单 / 重命名浮层 / 取色器
    this._bindCardMenu();   // 字幕卡片右键菜单(删除)
    // 点页面其它任意位置 → 退出编辑并自动保存(pointerdown 比 focusout 更可靠,
    // 覆盖点击非可聚焦区域/滚动条/控件等不会改变焦点的情形)
    // **必须延后收敛**: pointerdown 早于 click, 若在此同步移除编辑框并重建列表, 鼠标下的
    // 节点就被换掉了, 浏览器会因 mousedown/mouseup 目标不同而**不派发 click**。
    // 另外行内编辑框是浮层, 点"另一条字幕的文字行"时 pointerdown 可能落在编辑框的边缘上,
    // 于是 mousedown 与 mouseup 的目标也不是同一个节点 —— 两种情形都收不到 click。
    // 所以**换行在 pointerdown 里直接做**(不等 click), 与主流编辑器一致:
    // 点了另一条的文字行 → 立刻把编辑转移到那一条(只裁掉 `.editing` 类; 编辑框由
    // startEdit 自己重挂, 所以不会打断后续的 mousedown/click 派发)。
    document.addEventListener('pointerdown', (e) => {
      if (!this.editItem || this._switching) return;
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      const card = e.target.closest ? e.target.closest('.cue-card') : null;
      const item = card ? this.filtered[+card.dataset.idx] : null;
      const line = item ? (e.target.closest('.cc-l1') ? 1 : (e.target.closest('.cc-l2') ? 2 : 0)) : 0;
      // 点了**另一条**的文字行 → 立刻把编辑转移过去(pointerdown 做, 不等 click):
      // 行内编辑框是浮层, 换行时 mousedown 与 mouseup 的目标往往不是同一节点, 浏览器就
      // 不派发 click, 靠 click 换行会变成"要点两次"。
      // 转移期间(到 pointerup 为止)挂起兜底提交 —— 否则焦点变化触发的**旧行**提交会在
      // 稍后跑完并把刚建好的新编辑框一起收掉。
      if (item && item !== this.editItem && line && (!this.isEditable || this.isEditable(item.ref))) {
        // 整个换行过程收在一个"切换窗口"里(约一次点击的时长): 期间任何兜底提交 / 焦点收尾
        // 都跳过。换行时旧编辑框被移除、新编辑框刚挂上, 两者的 focusout 都会在同一个 tick
        // 内触发; 不屏蔽的话它们会接连跑完, 把刚建好的新编辑框连同编辑状态一起收掉
        // —— 表现就是"点另一条字幕要两次才进编辑"。
        this._switching = true;
        clearTimeout(this._switchTimer);
        this._switchTimer = setTimeout(() => { this._switching = false; }, 60);
        this.closeEdit();
        this._render();
        if (this.onSelect) this.onSelect(item);
        this.startEdit(item, line);
        return;
      }
      this._deferCommit = true;
      try { this.commitEdit(); } finally { this._deferCommit = false; }
    });
    // 兜底: 焦点离开编辑器(键盘 Tab 等)
    document.addEventListener('focusin', (e) => {
      if (!this.editItem || this._switching) return;
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      if (this._justMovedFocus()) return;
      this._deferCommit = true;
      try { this.commitEdit(); } finally { this._deferCommit = false; }
    });
  }

  /** 同一轮点击里刚把焦点/编辑转移到编辑框 → 不该被后续的 pointerdown/focusout 当成"点了别处"。
   *  浏览器把焦点交给 contenteditable 的时刻晚于 pointerdown, 而焦点落在编辑器内部同样会
   *  触发 document 上的兜底监听, 这里用一个很短的时间窗把这些后续事件让过去。 */
  _justMovedFocus() { return performance.now() - (this._focusMovesAt || 0) < 400; }

  get mode() { return this._mode; }

  /** 供快捷键调用: 提交正在进行的行内编辑 */
  applyEdit() { this.commitEdit(); }

  setBadge(text, cls) {
    this.badgeEl.textContent = t(text);
    this.badgeEl.className = 'badge' + (cls ? ' ' + cls : '');
  }

  /** 面板标题显示当前字幕文件名 */
  setFileName(name) {
    if (!this.phName) return;
    this.phName.textContent = name || '字幕总览';
    this.phName.title = name || '';
  }

  /** 更新坏行计数; 0 时按钮置灰并自动退出"只看坏行"模式; hint = 坏行类别说明(随格式变化) */
  setBadCount(n, hint) {
    if (!this.badBtn) return;
    this.badCountEl.textContent = String(n);
    this.badBtn.disabled = n === 0;
    this.badBtn.title = n
      ? `发现 ${n} 条坏行(${hint || '字幕重叠'}), 点击只显示这些行`
      : '没有坏行';
    if (n === 0 && this._badOnly) {
      this._badOnly = false;
      this.badBtn.classList.remove('active');
      this._applyFilter();
    }
  }

  setModeOptions(opts, current) {
    if (!this.modeSel) return;
    this.modeSel.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join('');
    this.modeSel.value = current || 'bi';
    this._mode = this.modeSel.value;
  }

  /**
   * 替换条目集.
   * keepView=true 时保留当前滚动位置(改时间/改文本/增删后不跳回顶部),
   * 载入新文件时用默认 false 重置到顶部。
   */
  setItems(items, keepView = false) {
    this.closeEdit();
    const keepTop = this.listEl ? this.listEl.scrollTop : 0;
    this.items = items;
    this.selected = null;
    this.playingItem = null;
    this._speaker = '';       // 新数据 → 重置角色筛选(避免跨文件残留)
    if (this.roleFilterSel) this.roleFilterSel.value = '__all__';
    this._applyFilter(keepView ? keepTop : 0);
  }

  /* ─────────── Tab 切换(字幕 / 角色 / 设置) ─────────── */
  /** SRT 等格式没有角色概念 → 隐藏角色 Tab 与搜索框旁的角色筛选 */
  setRolesEnabled(on) {
    this._rolesEnabled = !!on;
    const btn = this._tabBtns.find(b => b.dataset.tab === 'roles');
    if (btn) btn.hidden = !on;
    if (this.roleFilterSel) this.roleFilterSel.hidden = !on;
    if (!on && this._tab === 'roles') this.showTab('subs');
  }

  showTab(name) {
    if (!['subs', 'roles', 'settings', 'logs'].includes(name)) name = 'subs';
    if (name === 'roles' && !this._rolesEnabled) name = 'subs';
    this._tab = name;
    const bodies = { subs: 'tab-subs', roles: 'tab-roles', settings: 'tab-settings', logs: 'tab-logs' };
    for (const [k, id] of Object.entries(bodies)) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', k === name);
    }
    for (const btn of this._tabBtns) btn.classList.toggle('active', btn.dataset.tab === name);
    if (this.onTabChange) this.onTabChange(name);      // 离开角色栏 → 主逻辑会清掉没用过的新角色
    if (name === 'subs') this._render();
    else if (name === 'roles') this._renderRoles();
  }

  /** 角色(说话人)列表, 由主逻辑解析后灌入; 仅在角色 Tab 可见时渲染 */
  setRoles(roles) {
    this._roles = roles || [];
    const sel = this.roleFilterSel;
    if (sel) {
      const cur = sel.value || '__all__';
      sel.innerHTML = '<option value="__all__">全部角色</option>' +
        this._roles.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}（${r.count}）</option>`).join('');
      sel.value = [...sel.options].some(o => o.value === cur) ? cur : '__all__';
      if (sel.value !== cur) this._speaker = '';       // 角色不存在了(换了文件) → 取消筛选
    }
    if (this._tab === 'roles') this._renderRoles();
  }

  /** 按角色(说话人)筛选字幕列表 */
  setSpeakerFilter(name) {
    this._speaker = name || '';
    if (this.roleFilterSel) this.roleFilterSel.value = this._speaker || '__all__';
    this._applyFilter();
  }
  getSpeakerFilter() { return this._speaker; }

  /** 该条字幕的说话人是否匹配筛选(条目上是 '[Wemmbu]', 下拉里是 'Wemmbu', 需归一化比较) */
  _speakerMatch(it) {
    const raw = String(it.speaker || '');
    const segs = raw.match(/\[[^\]]+\]/g);
    const names = segs && segs.length ? segs.map(s => s.slice(1, -1).trim().toLowerCase()) : [raw.trim().toLowerCase()];
    return names.includes(this._speaker.toLowerCase());
  }

  _renderRoles() {
    const el = document.getElementById('role-list');
    if (!el) return;
    const cards = this._roles.map(r => {
      const c = r.color ? hexRgb(r.color) : null;
      const dot = c ? `style="background:rgb(${c.r},${c.g},${c.b})"` : 'style="background:#5b6472"';
      return `<div class="role-card" data-name="${escapeHtml(r.name)}" title="单击=设为播放头所在字幕块的说话人 · 右键=重命名 / 改色">
        <span class="role-dot" ${dot}></span>
        <span class="role-name">${escapeHtml(r.name)}</span>
        <span class="role-count">${r.count} 条</span>
      </div>`;
    });
    cards.push(`<div class="role-card role-add" data-act="add" title="添加一个新角色(如 译者注)">＋ 添加角色</div>`);
    el.innerHTML = cards.join('');
    el.querySelectorAll('.role-card').forEach(card => {
      if (card.dataset.act === 'add') {
        card.addEventListener('click', () => { if (this.onAddRole) this.onAddRole(); });
        return;
      }
      card.addEventListener('click', () => {
        if (this.onAssignRole) this.onAssignRole(card.dataset.name);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const role = this._roles.find(r => r.name === card.dataset.name);
        if (role) this._showRoleMenu(e.clientX, e.clientY, role);
      });
    });
  }

  /* ─────────── 通用确认弹窗 ─────────── */
  /** title / msg / yesText / noText / onYes: 点"是"回调 */
  showConfirm(title, msg, yesText, noText, onYes) {
    const ov = document.getElementById('confirm-overlay');
    if (!ov) return;
    document.getElementById('confirm-title').textContent = t(title || '请确认');
    document.getElementById('confirm-msg').textContent = t(msg || '');
    const yesBtn = document.getElementById('confirm-yes');
    const noBtn = document.getElementById('confirm-no');
    yesBtn.textContent = t(yesText || '确定');
    noBtn.textContent = t(noText || '取消');
    ov.hidden = false;
    const done = (ok) => {
      ov.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (ok && onYes) onYes();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    yesBtn.onclick = () => done(true);
    noBtn.onclick = () => done(false);
    setTimeout(() => yesBtn.focus(), 0);
  }

  /* ─────────── 添加角色弹窗 ─────────── */
  /** 弹窗填写名称+颜色, 确定后回调 onSubmit({name, color}) */
  showAddRoleDialog(onSubmit) {
    const ov = document.getElementById('role-new');
    const nameEl = document.getElementById('role-new-name');
    const colorWrap = document.getElementById('role-new-colors');
    const customEl = document.getElementById('role-new-color');
    if (!ov || !nameEl) return;
    const PALETTE = ['#e50b0b', '#ff7a45', '#ffd54a', '#4fd1a5', '#00aaff', '#8b7cf6', '#ff00d0', '#ffffff', '#c2c2c2', '#5b6472'];
    let picked = PALETTE[0];
    colorWrap.innerHTML = PALETTE.map((c, i) =>
      `<span class="rn-swatch${i === 0 ? ' active' : ''}" data-c="${c}" style="background:${c}"></span>`).join('');
    customEl.value = picked;
    nameEl.value = '';
    ov.hidden = false;
    const syncSwatches = () => {
      colorWrap.querySelectorAll('.rn-swatch').forEach(s => s.classList.toggle('active', s.dataset.c === picked));
      customEl.value = picked;
    };
    colorWrap.querySelectorAll('.rn-swatch').forEach(s => {
      s.onclick = () => { picked = s.dataset.c; syncSwatches(); };
    });
    customEl.oninput = () => { picked = customEl.value; syncSwatches(); };
    const finish = (ok) => {
      const name = (nameEl.value || '').trim();
      if (ok && !name) { nameEl.focus(); return; }     // 名称必填: 不关闭弹窗
      // 回调返回 false(如重名) → 保持弹窗打开, 让用户改名字
      if (ok && onSubmit && onSubmit({ name, color: picked }) === false) return;
      ov.hidden = true;
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);
    document.getElementById('role-new-cancel').onclick = () => finish(false);
    document.getElementById('role-new-ok').onclick = () => finish(true);
    setTimeout(() => nameEl.focus(), 0);
  }

  /* ─────────── 通用选择弹窗(重叠台词选行等) ─────────── */
  /** rows: [{label, name, color, row}]；用户选中后回调 onPick(row)，取消不回调 */
  showRowPicker(title, rows, onPick) {
    const ov = document.getElementById('pick-overlay');
    const list = document.getElementById('pick-list');
    const titleEl = document.getElementById('pick-title');
    const cancelBtn = document.getElementById('pick-cancel');
    if (!ov || !list) return;
    titleEl.textContent = title;
    list.innerHTML = rows.map((r, i) => {
      const tone = r.color ? roleTone(r.color) : null;
      const cs = tone ? ` style="color:${tone.css}"` : '';
      const dot = `<span class="pick-dot" style="background:${r.color || '#5b6472'}"></span>`;
      return `<button type="button" class="pick-row" data-i="${i}">
        <span class="pick-text"${cs}>${escapeHtml(r.label)}</span>
        <span class="pick-meta">${dot}<span${cs}>${escapeHtml(r.name || '(无角色)')}</span></span>
      </button>`;
    }).join('');
    ov.hidden = false;
    const finish = (idx) => {
      ov.hidden = true;
      list.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      if (idx !== null && rows[idx] && onPick) onPick(rows[idx].row);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    document.addEventListener('keydown', onKey, true);
    list.querySelectorAll('.pick-row').forEach(btn => {
      btn.addEventListener('click', () => finish(parseInt(btn.dataset.i, 10)));
    });
    if (cancelBtn) cancelBtn.onclick = () => finish(null);
  }

  /* ─────────── 修复字幕弹窗 ─────────── */
  /** 展示该字幕检测到的问题; needConfirm=true 时让用户确认原句(预填 prefill);
   *  点「一键修复」回调 onFix(confirmedText| null) */
  showFix(no, issues, needConfirm, prefill, onFix) {
    const ov = document.getElementById('fix-overlay');
    if (!ov) return;
    const titleEl = document.getElementById('fix-title');
    const listEl = document.getElementById('fix-list');
    const inputWrap = document.getElementById('fix-input-wrap');
    const inputEl = document.getElementById('fix-input');
    const okBtn = document.getElementById('fix-ok');
    titleEl.textContent = `修复字幕 #${no}`;
    const labels = {
      karaokeMissing: '没有逐词效果，且不与其他字幕重叠 → 将自动添加逐词（均匀铺满该句时长）',
      overlapNoKaraoke: '该句与其它字幕重叠，重叠时不加逐词（避免两句话高亮糊在一起）',
      roleName: '英文行含有角色名 [..]，将删除角色名并确保逐词颜色仍是绿色',
      wordsMismatch: '英文行逐词与文本不一致（缺词或多词）',
      enOverlap: '英文行内部有重叠/重复的字幕（同一段时间里有两条英文）'
    };
    const keys = Object.keys(issues);
    listEl.innerHTML = keys.map(k => {
      let extra = '';
      if (k === 'wordsMismatch') extra = `（当前 ${issues[k].have} 切片 / 文本 ${issues[k].need} 词）`;
      return `<div class="fix-issue"><span class="fix-ico">🔧</span><span>${labels[k] || k}${extra}</span></div>`;
    }).join('');
    // 逐词与文本不一致 / 英文行重复 → 必须让用户确认这句话到底是什么
    if (needConfirm) {
      inputWrap.hidden = false;
      inputEl.value = prefill || '';
    } else {
      inputWrap.hidden = true;
    }
    ov.hidden = false;
    const finish = (ok) => {
      if (ok && needConfirm && !inputEl.value.trim()) {
        inputEl.focus();   // 需要确认原句, 不允许空着修复
        return;
      }
      ov.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (ok) {
        const txt = needConfirm ? inputEl.value.trim() : null;
        onFix(txt);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && !needConfirm) { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);
    document.getElementById('fix-cancel').onclick = () => finish(false);
    okBtn.onclick = () => finish(true);
    if (needConfirm) setTimeout(() => inputEl.focus(), 0);
    else setTimeout(() => okBtn.focus(), 0);
  }

  /* ─────────── 字幕卡片右键菜单(目前只有删除) ─────────── */
  _bindCardMenu() {
    this.cardMenu = document.getElementById('card-menu');
    if (this.cardMenu) {
      this.cardMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const item = this._cardMenuItem;
        this._hideCardMenu();
        if (btn.dataset.act === 'delete' && item && this.onDeleteCard) this.onDeleteCard(item);
        else if (btn.dataset.act === 'fix' && item && this.onFixCard) this.onFixCard(item);
        else if (btn.dataset.act === 'retranslate' && item && this.onRetranslateCard) this.onRetranslateCard(item);
      });
    }
    this.listEl.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.cue-card');
      if (!card) return;
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      e.preventDefault();
      const item = this.filtered[+card.dataset.idx];
      if (!item) return;
      if (this.onSelect) this.onSelect(item);
      this._showCardMenu(e.clientX, e.clientY, item);
    });
    this.listEl.addEventListener('scroll', () => this._hideCardMenu());
    document.addEventListener('pointerdown', (e) => {
      if (this.cardMenu && !this.cardMenu.hidden && !this.cardMenu.contains(e.target)) this._hideCardMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._hideCardMenu(); });
  }
  _showCardMenu(cx, cy, item) {
    if (!this.cardMenu) return;
    this._cardMenuItem = item;
    this.cardMenu.hidden = false;
    const w = this.cardMenu.offsetWidth, h = this.cardMenu.offsetHeight;
    this.cardMenu.style.left = Math.max(4, Math.min(cx, window.innerWidth - w - 6)) + 'px';
    this.cardMenu.style.top = Math.max(4, Math.min(cy, window.innerHeight - h - 6)) + 'px';
  }
  _hideCardMenu() {
    if (this.cardMenu && !this.cardMenu.hidden) this.cardMenu.hidden = true;
    this._cardMenuItem = null;
  }

  /* ─────────── 角色右键菜单 / 重命名 / 换色 ─────────── */
  _bindRoleMenu() {
    this.roleMenu = document.getElementById('role-menu');
    this.renameBox = document.getElementById('role-rename');
    this.renameInput = document.getElementById('role-rename-input');
    this.colorInput = document.getElementById('role-color-input');

    if (this.roleMenu) {
      this.roleMenu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-act]');
        if (!item) return;
        const role = this._menuRole;
        const act = item.dataset.act;
        const pos = { x: this._menuPos.x, y: this._menuPos.y };
        this._hideRoleMenu();
        if (!role) return;
        if (act === 'rename') this._showRenameBox(role, pos.x, pos.y);
        else if (act === 'recolor') this._openColorPicker(role);
      });
    }
    if (this.renameBox) {
      const okBtn = document.getElementById('role-rename-ok');
      const commit = () => {
        const role = this._renameRole;
        const name = (this.renameInput.value || '').trim();
        this._hideRenameBox();
        if (role && name && name !== role.name && this.onRenameRole) this.onRenameRole(role.name, name);
      };
      if (okBtn) okBtn.addEventListener('click', commit);
      this.renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); this._hideRenameBox(); }
      });
    }
    if (this.colorInput) {
      this.colorInput.addEventListener('change', () => {
        const role = this._colorRole;
        this._colorRole = null;
        if (role && this.onRecolorRole) this.onRecolorRole(role.name, this.colorInput.value);
      });
    }
    // 点菜单/浮层以外的地方 → 收起
    document.addEventListener('pointerdown', (e) => {
      if (this.roleMenu && !this.roleMenu.hidden && !this.roleMenu.contains(e.target)) this._hideRoleMenu();
      if (this.renameBox && !this.renameBox.hidden && !this.renameBox.contains(e.target)) this._hideRenameBox();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._hideRoleMenu(); });
  }

  _showRoleMenu(cx, cy, role) {
    if (!this.roleMenu) return;
    this._menuRole = role;
    this._menuPos = { x: cx, y: cy };
    this.roleMenu.hidden = false;
    const w = this.roleMenu.offsetWidth, h = this.roleMenu.offsetHeight;
    this.roleMenu.style.left = Math.max(4, Math.min(cx, window.innerWidth - w - 6)) + 'px';
    this.roleMenu.style.top = Math.max(4, Math.min(cy, window.innerHeight - h - 6)) + 'px';
  }
  _hideRoleMenu() {
    if (this.roleMenu && !this.roleMenu.hidden) this.roleMenu.hidden = true;
    this._menuRole = null;
  }

  _showRenameBox(role, x, y) {
    if (!this.renameBox) return;
    this._renameRole = role;
    this.renameBox.hidden = false;
    const w = this.renameBox.offsetWidth, h = this.renameBox.offsetHeight;
    this.renameBox.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
    this.renameBox.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
    this.renameInput.value = role.name;
    setTimeout(() => { this.renameInput.focus(); this.renameInput.select(); }, 0);
  }
  _hideRenameBox() {
    if (this.renameBox && !this.renameBox.hidden) this.renameBox.hidden = true;
    this._renameRole = null;
  }

  _openColorPicker(role) {
    if (!this.colorInput) return;
    this._colorRole = role;
    this.colorInput.value = role.color || '#ff7a45';
    this.colorInput.click();
  }

  _matchMode(it) {
    if (this._badOnly && !it.bad) return false;
    if (this._speaker && !this._speakerMatch(it)) return false;
    if (this._mode === 'first') return !!it.l1;
    if (this._mode === 'second') return !!it.l2;
    return true;
  }

  /** 重算过滤结果; restoreTop 为重建后要恢复的滚动位置(默认回到顶部) */
  _applyFilter(restoreTop = 0) {
    const q = this._filterText;
    this.filtered = this.items.filter(it => {
      if (!this._matchMode(it)) return false;
      if (!q) return true;
      return ((it.l1 || '').toLowerCase().includes(q)) || ((it.l2 || '').toLowerCase().includes(q));
    });
    // 条数提示已按需求移除(工具栏不再显示 "17 / 658 条")
    this.listEl.scrollTop = restoreTop;
    this._render();
  }

  _render() {
    // 动态行高: 渲染全部 filtered, 每行高度由内容决定(spacerEl 自然撑开滚动区)
    const showFirst = this._mode !== 'second';
    const showSecond = this._mode !== 'first';

    let html = '';
    for (let i = 0; i < this.filtered.length; i++) {
      const it = this.filtered[i];
      const cls = ['cue-card'];
      if (it === this.selected) cls.push('selected');
      if (it === this.playingItem) cls.push('playing');
      if (it === this.editItem) cls.push('editing');

      // 角色(说话人)色: 卡片左标、中文行、两个样式徽标、三个时间值全部跟着它走
      const tone = it.color ? roleTone(it.color) : null;
      const cardStyle = [];
      let chipAttr = '', timeAttr = '', l1Attr = '';
      if (tone) {
        const { r, g, b, css } = tone;
        cardStyle.push(`border-left-color:rgba(${r},${g},${b},.85)`);
        chipAttr = ` style="color:${css};border-color:rgba(${r},${g},${b},.45);background:rgba(${r},${g},${b},.12)"`;
        timeAttr = ` style="color:${css}"`;
        l1Attr = ` style="color:${css}"`;
      }

      const chips = [];
      if (it.bad) chips.push(`<span class="cc-chip chip-bad" title="坏行: ${escapeHtml(it.badReason || '')}">⚠ 坏行</span>`);
      if (it.badge1) chips.push(`<span class="cc-chip chip-l1"${chipAttr}>${escapeHtml(it.badge1)}</span>`);
      if (it.badge2 && showSecond) chips.push(`<span class="cc-chip chip-l2"${chipAttr}>${escapeHtml(it.badge2)}</span>`);
      const head = chips.length ? `<div class="cc-head">${chips.join('')}</div>` : '';
      // 新建但还没输入的字幕 → 显示占位提示(用户不输入就离开则这条会被撤销)
      const l1 = showFirst && it.l1 ? `<div class="cc-l1"${l1Attr}>${escapeHtml(it.l1)}</div>`
        : (showFirst && it.isNew ? `<div class="cc-l1 cc-ph1">（输入中文）</div>` : '');
      const l2 = showSecond && it.l2 ? `<div class="cc-l2">${escapeHtml(it.l2)}</div>`
        : (showSecond && it.isNew ? `<div class="cc-l2 cc-ph2">（输入英文）</div>` : '');
      html += `<div class="${cls.join(' ')}" data-idx="${i}" style="${cardStyle.join(';')}">
        <div class="cc-times">
          <div class="cc-t"><span>开始</span><b${timeAttr}>${fmtTime(it.start)}</b></div>
          <div class="cc-t"><span>结束</span><b${timeAttr}>${fmtTime(it.end)}</b></div>
          <div class="cc-t"><span>时长</span><b${timeAttr}>${(it.end - it.start).toFixed(3)}s</b></div>
        </div>
        <div class="cc-body">
          ${head}
          ${l1}${l2}
        </div>
      </div>`;
    }
    this.spacerEl.innerHTML = html;
  }

  refreshItem() { this._render(); }

  /** 按播放时间定位到对应条目: 二分找 start<=t<end 的 item, 仅在**完全不可见**时滚到视野 */
  selectByTime(t) {
    const arr = this.items;
    if (!arr || !arr.length) return;
    let lo = 0, hi = arr.length - 1, idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].start <= t) { idx = m; lo = m + 1; } else hi = m - 1;
    }
    if (idx < 0) return;
    const it = arr[idx];
    if (t >= it.start && t < it.end) this.select(it, 'keep');
  }

  /**
   * 选中条目.
   * scroll=true  — 未完全可见时滚到视野中部;
   * scroll=false — 完全不滚动;
   * scroll='keep'— 仅在**完全不可见**时才滚(重建后恢复选中用, 保持阅读位置稳定)。
   */
  select(item, scroll = true) {
    const prev = this.selected;
    this.selected = item;
    // 轻量高亮: 只切 class, 不全量重建(全量重建 658 行会拖死主循环 → 时间轴黑屏/页面卡死)
    if (prev && prev !== item) {
      const pi = this.filtered.indexOf(prev);
      const pe = pi >= 0 ? this.spacerEl.children[pi] : null;
      if (pe) pe.classList.remove('selected');
    }
    if (scroll && item) {
      const idx = this.filtered.indexOf(item);
      const el = idx >= 0 ? this.spacerEl.children[idx] : null;
      if (el) {
        el.classList.add('selected');
        const top = el.offsetTop, h = el.offsetHeight;
        const st = this.listEl.scrollTop, vh = this.listEl.clientHeight;
        const need = scroll === 'keep'
          ? (top + h <= st || top >= st + vh)
          : (top < st || top > st + vh);
        if (need) {
          this._progScroll = true;
          this.listEl.scrollTop = Math.max(0, top + h / 2 - vh / 2);
        }
      }
    }
  }

  /** 播放高亮: 由主循环以当前时间驱动 */
  setPlayingByTime(t) {
    if (!this.items.length) return;
    const arr = this._filterText || this._mode !== 'bi' ? this.filtered : this.items;
    let found = null;
    const i = bisectStart(arr, t);
    for (let k = i; k >= 0 && arr[k].end > t; k--) {
      if (arr[k].start <= t) { found = arr[k]; break; }
    }
    if (found === this.playingItem) return;
    const prevPlaying = this.playingItem;
    this.playingItem = found;
    // 轻量高亮: 只切 class(全量重建 658 行会拖死主循环)
    const pi = prevPlaying ? this.filtered.indexOf(prevPlaying) : -1;
    const pe = pi >= 0 ? this.spacerEl.children[pi] : null;
    if (pe) pe.classList.remove('playing');
    if (found) {
      const idx = this.filtered.indexOf(found);
      const el = idx >= 0 ? this.spacerEl.children[idx] : null;
      if (el) {
        el.classList.add('playing');
        if (performance.now() - (this._userScrollAt || 0) > 5000) {
          const top = el.offsetTop, h = el.offsetHeight;
          const st = this.listEl.scrollTop, vh = this.listEl.clientHeight;
          if (top < st || top > st + vh - h) {
            this._progScroll = true;
            this.listEl.scrollTop = Math.max(0, top + h / 2 - vh / 2);
          }
        }
      }
    }
  }

  /* ─────────── 行内编辑 ─────────── */

  /** 单击文字条 → 在卡片文本位置原位编辑(中英双行) */
  startEdit(item, focusLine = 0) {
    if (this.editItem === item) {          // 已在编辑同一条 → 仅切换焦点行
      if (this.editorEl) this._focusLine(focusLine === 2 ? 2 : 1);
      return;
    }
    if (this.editItem) this.commitEdit();
    const idx = this.filtered.indexOf(item);
    if (idx === -1) return;

    this.editItem = item;
    // 正在把编辑转移到这一条(或刚开): 随后到达的 pointerdown/focusout 是**同一轮点击**的
    // 后续阶段, 不能当成"点了别处"再提交一次 —— 否则刚开好的编辑框会被立刻收掉。
    this._focusMovesAt = performance.now();
    this._render();   // 先渲染, 编辑器才能贴到对应卡片的位置
    const div = document.createElement('div');
    this._editGen = (this._editGen || 0) + 1;      // 新编辑代次: 旧代次的延后收尾会自行作废
    const myGen = this._editGen;                   // 本编辑框自己的代次(focusout 里用它判别归属)
    div.className = 'inline-editor';
    const cardEl = this.spacerEl.children[idx];
    div.style.top = ((cardEl ? cardEl.offsetTop : 0) + 6) + 'px';
    div.innerHTML = `
      <div class="ie-line ie-l1" contenteditable="true" spellcheck="false" data-ph="（输入中文）"></div>
      <div class="ie-line ie-l2" contenteditable="true" spellcheck="false" data-ph="（输入英文）"></div>
      <div class="ie-hint">点击别处保存 · Tab 中英互切 · 回车提交 · Ctrl+回车 分句 · Ctrl+退格 并上一条</div>`;
    div.querySelector('.ie-line.ie-l2').textContent = item.l2 || '';
    // 编辑框里不显示角色名 [Spoke](它由角色栏管理, 混在正文里既碍眼又容易改坏): 只显示正文, 提交时补回
    const tagM = /^\s*\[[^\]]+\]\s*/.exec(item.l1 || '');
    this._editTag = tagM ? tagM[0] : '';
    div.querySelector('.ie-line.ie-l1').textContent = tagM ? (item.l1 || '').slice(tagM[0].length) : (item.l1 || '');
    // 编辑器沿用卡片的口角色, 避免"卡片是红的、点开变橙的"割裂感
    const editTone = item.color ? roleTone(item.color) : null;
    if (editTone) {
      const { r, g, b, css } = editTone;
      div.style.borderColor = css;
      div.style.boxShadow = `0 0 0 1px rgba(${r},${g},${b},.4), 0 4px 16px rgba(0,0,0,.5)`;
      const el1 = div.querySelector('.ie-l1');
      if (el1) el1.style.color = css;
    }

    const lines = div.querySelectorAll('.ie-line');
    const [l1, l2] = lines;          // l1 = 中文行(.ie-l1) · l2 = 英文行(.ie-l2)
    // 回车 = 直接提交; Tab = 中英两行互切; Esc = 取消。
    // 两个**只在英文行**生效的编辑动作(光标位置决定, 见下):
    //   Ctrl+回车    → 在光标处把这一条切成两条(分句)
    //   Ctrl+退格    → 光标在英文行最前面时, 与上一个字幕块合并
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeEdit(); this._render(); return; }
      // 英文行限定: 光标处的切分/合并(必须在 Enter 分支之前判断 Ctrl+Enter)
      if (document.activeElement === l2) {
        const plain = (el) => (el.textContent || '').replace(/\u00a0/g, ' ');
        // Ctrl+退格 在英文行最前面 → 与上一条合并
        if (e.key === 'Backspace' && (e.ctrlKey || e.metaKey) && !e.altKey) {
          if (this._caretOffset() === 0) {
            e.preventDefault();
            if (this.onMergePrev) this.onMergePrev(this.editItem);
            return;
          }
        }
        // Ctrl+回车 在英文单词**中间** → 从这里分句(切成两条); 在首/尾 → 交给下面的提交
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          const txt = plain(l2);
          const at = this._caretOffset();
          if (this.onSplitRow && this._splitPoint(txt, at) != null) {
            e.preventDefault();
            this.onSplitRow(this.editItem, txt, at);
            return;
          }
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.commitEdit(); return; }
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // 两行之间来回切: 英文区按 Tab → 回中文区(新字幕刚拖出来时焦点在英文区, 这样能直接写中文);
        // 中文区按 Tab → 去英文区。必须 preventDefault: 否则浏览器把焦点移到编辑器外,
        // 会触发 focusout → 误提交(还在打字就被保存/撤销)。
        e.preventDefault();
        if (document.activeElement === l2) this._focusLine(1);
        else if (document.activeElement === l1) this._focusLine(2);
        else this._focusLine(1);      // 焦点不在两行上: 回到中文行
        return;
      }
      // 上下方向键 = 模拟多行文本导航: 未到行边界先移到边界(↓→行尾 / ↑→行首), 已在边界才切另一行
      if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement === l1) {
        e.preventDefault();
        if (this._caretOffset() < (l1.textContent || '').length) this._caretLine(l1, false);  // 不在行尾 → 先到行尾
        else this._focusLine(2);                                                             // 已在行尾 → 切英文行
        return;
      }
      if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement === l2) {
        e.preventDefault();
        if (this._caretOffset() > 0) this._caretLine(l2, true);   // 不在行首 → 先到行首
        else this._focusLine(1);                                  // 已在行首 → 切中文行
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.commitEdit();            // 回车 = 直接提交
      }
    });
    // 粘贴纯文本(避免带入富文本标签)
    div.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text') || '';
      document.execCommand('insertText', false, t.replace(/\r?\n/g, ' ').replace(/\s+/g, ' '));
    });
    // 焦点离开编辑器 → 自动应用。
    // 换行时(见 pointerdown 的"切换窗口")整段跳过: 那一刻编辑正在转移到另一条,
    // 这个编辑框的 focusout 只是"被移交"的副产物, 不能当成用户点了别处去提交。
    div.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this._switching) return;
        // 归属判别: 只有**本编辑框**仍是当前编辑框、且它真的拿到过焦点时, 这次 focusout
        // 才代表"用户离开了编辑"。换行时被替换掉的旧编辑框(代次已过期)一律跳过 ——
        // 否则它会在新编辑框建好之后跑完, 把新编辑框一起收掉(要点两次才能换行的根因)。
        if (this._editGen !== myGen) return;
        if (this._focusedGen !== myGen) return;
        if (this.editItem && this.editorEl && !this.editorEl.contains(document.activeElement)) {
          // 走鼠标路径: 延后收敛, 别让本次点击被 DOM 变动吃掉
          this._deferCommit = true;
          try { this.commitEdit(); } finally { this._deferCommit = false; }
        }
      }, 0);
    });

    this.editorEl = div;
    this.listEl.appendChild(div);
    this._render();
    this._focusLine(focusLine === 2 ? 2 : 1);
  }

  /** 聚焦编辑器的指定行并把光标移到行尾 */
  _focusLine(which) {
    if (!this.editorEl) return;
    const el = this.editorEl.querySelector(which === 2 ? '.ie-l2' : '.ie-l1');
    if (!el) return;
    el.focus();
    // 记下"这个编辑框真的拿到过焦点"的代次 —— 只有拿到过焦点的编辑框, 它的 focusout
    // 才代表"用户离开了编辑"; 刚建好、焦点还在路上就被换掉的那个不该触发提交。
    this._focusedGen = this._editGen;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 聚焦指定行并把光标放到行首(atStart=true)或行尾(false); 供上下键的行内边界导航用 */
  _caretLine(el, atStart) {
    if (!el) return;
    el.focus();
    this._focusedGen = this._editGen;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(atStart);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 当前光标在**聚焦那一行**里的字符偏移(行内只有纯文本, 直接按文本节点算)。
   *  取不到(没选区/多节点) → -1, 调用方据此保守处理(不切分、不合并)。 */
  _caretOffset() {
    const el = document.activeElement;
    if (!el || !el.classList || !el.classList.contains('ie-line')) return -1;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const n = el.firstChild;
    if (!n || n.nodeType !== Node.TEXT_NODE) return el.textContent ? -1 : 0;   // 空行 → 偏移 0
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return -1;
    return r.startOffset;
  }

  /** 计算「在光标处分句」的切点: 返回 {k, sp} =
   *  k  = 前半的英文词数(1..词数-1)
   *  sp = 文本里的切分字符位置
   *  光标落在哪一半就切在哪一半的**词边界**上(光标在词中间时, 该词归前半)。
   *  切点落在首/尾(会切出一个空半句) → 返回 null, 调用方改为普通提交。 */
  _splitPoint(text, caret) {
    const toks = String(text || '').split(/\s+/).filter(Boolean);
    if (toks.length < 2) return null;
    const at = (caret == null || caret < 0) ? text.length : caret;
    // 词尾字符位置表
    const ends = [];
    let pos = 0;
    for (const t of toks) {
      pos += t.length;
      ends.push(pos);
      const sp = text.slice(pos).match(/^\s+/);
      pos += sp ? sp[0].length : 0;
    }
    let k = ends.findIndex(en => en >= at) + 1;      // 光标所在词(含)归前半
    if (k < 1) k = 1;
    if (k > toks.length - 1) k = toks.length - 1;    // 不能切出空白的后半
    if (k < 1) return null;
    // 切分点: 第 k 个词的结束位置(其后空白留给后半, 两半各自 trim)
    let sp = ends[k - 1];
    const m = text.slice(sp).match(/^\s+/);
    if (m) sp += m[0].length;
    return { k, sp };
  }

  /** 提交行内编辑: 文本有变化才触发 onApply(时间不变, 由主逻辑同步视频区) */
  commitEdit() {
    if (!this.editItem) return;
    const it = this.editItem;
    const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const el = this.editorEl;
    let l1 = norm(el && el.querySelector('.ie-l1') ? el.querySelector('.ie-l1').textContent : it.l1);
    const l2 = norm(el && el.querySelector('.ie-l2') ? el.querySelector('.ie-l2').textContent : it.l2);
    // 编辑框里没有角色名 → 提交时把原来的 [Spoke] 补回(用户自己写了 [xxx] 则以用户的为准)
    if (this._editTag && !/^\[/.test(l1)) l1 = this._editTag + l1;

    // **没改动就只收编辑器, 不重建列表**(保留 SRT 标签等原始数据):
    //   以前无论如何都走 _render() → 重建列表 DOM。于是"编辑器开着时点另一张卡片"会
    //   先把节点换掉(commitEdit 由 focusout 触发, 早于 click), 浏览器的 click 落到一个
    //   已脱离文档的元素上 → 第一次点击被吞, 要点两次才进编辑。
    //   **渲染必须延后到本次点击派发完**(setTimeout 0): 立刻 _render() 同样会换掉节点。
    const newText = l1 + '\n' + l2;
    const origText = norm(it.l1) + '\n' + norm(it.l2);
    const unchanged = (newText === origText);
    const emptyNew = !!(it.isNew && !l1 && !l2);
    const gen = this._editGen;         // 本次编辑的代次(开编辑/关编辑都会 +1)

    // 合并后的动作统一延后一次事件循环再执行 —— 编辑器被移出 DOM 会让浏览器取消本次点击:
    //   focusout 在 pointerdown 与 click 之间触发, 若此刻同步移除编辑框, 鼠标下的节点就变了,
    //   浏览器不再派发 click → "编辑器开着时点另一张卡片要点两次才进编辑"。
    //   延后到 setTimeout(0)(此时 click 已派发完) 再动 DOM, 一次点击即可切行。
    const finish = () => {
      // **只收自己那一条 / 只提交自己那一条**: 延后执行期间用户可能已经点到另一条并把编辑
      // 转移过去了(focusout 触发的旧行提交会晚一步跑完)。此时:
      //   · 绝不能 closeEdit() —— 那会收掉**新**编辑框;
      //   · 也不能再 onApply 旧行的文本 —— 否则会把界面上正显示的新行内容写回旧行。
      // 判据: 编辑已经换到别的条目 / 换到别的代次 → 本次提交作废(用户的改动由新行的编辑器承载)。
      if (this.editItem !== it || this._editGen !== gen) {
        if (el && el.parentNode) el.remove();     // 只清掉自己这个已脱离的编辑框
        return;
      }
      this.closeEdit();
      if (emptyNew) { this._render(); if (this.onEmptyNew) this.onEmptyNew(it); return; }
      this._render();
      if (unchanged) return;
      if (this.onApply) {
        // 必须把"正在编辑的那一条"显式带出去: 编辑期间用户可能已点了别处,
        // 此刻 state.selected 可能已经换成另一条, 用选中项会写错行。
        this.onApply({
          item: it,
          start: fmtTime(it.start),
          end: fmtTime(it.end),
          dur: (it.end - it.start).toFixed(3),
          text: newText
        });
      }
    };
    if (this._deferCommit) setTimeout(finish, 0);
    else finish();
  }

  /** 关闭行内编辑器(不提交) */
  closeEdit() {
    this._editGen = (this._editGen || 0) + 1;
    this.editItem = null;
    this._editTag = '';
    if (this.editorEl) { this.editorEl.remove(); this.editorEl = null; }
  }
}
