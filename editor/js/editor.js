/** 右侧编辑面板: 虚拟滚动卡片列表(中英双行) + 列表内行内编辑(无独立编辑框) */
import { fmtTime, escapeHtml, bisectStart } from './util.js';

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
    this.countEl = document.getElementById('cue-count');
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

    // 行内编辑状态
    this.editItem = null;     // 正在编辑的条目
    this.editorEl = null;     // 行内编辑器 DOM

    this.onSelect = null;
    this.onSeek = null;       // 双击非文字区域 → 跳转到该条时间点
    this.onApply = null;
    this.onDelete = null;
    this.onInsert = null;
    this.onModeChange = null;

    this._bind();
  }

  _bind() {
    this.listEl.addEventListener('scroll', () => {
      if (this._progScroll) { this._progScroll = false; return; }
      this._userScrollAt = performance.now();
      this._render();
    });
    // 单击: 文字区域 → 原地进入编辑; 非文字区域 → 仅选中(不跳转)
    this.listEl.addEventListener('click', (e) => {
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      const card = e.target.closest('.cue-card');
      if (!card) return;
      const item = this.filtered[+card.dataset.idx];
      if (!item) return;
      const line = e.target.closest('.cc-l1') ? 1 : (e.target.closest('.cc-l2') ? 2 : 0);
      if (this.onSelect) this.onSelect(item);
      if (line) this.startEdit(item, line);
    });
    // 双击: 非文字区域(时间列/空白/徽标) → 跳转到该条开始时间; 文字区不触发(避免与编辑冲突)
    this.listEl.addEventListener('dblclick', (e) => {
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      const card = e.target.closest('.cue-card');
      if (!card) return;
      if (e.target.closest('.cc-l1, .cc-l2')) return;
      const item = this.filtered[+card.dataset.idx];
      if (item && this.onSeek) this.onSeek(item);
    });
    this.searchBox.addEventListener('input', () => {
      this._filterText = this.searchBox.value.trim().toLowerCase();
      this._applyFilter();
    });
    if (this.searchBtn) {
      this.searchBtn.addEventListener('click', () => this.searchBox.focus());
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
    document.getElementById('btn-delete').addEventListener('click', () => this.onDelete && this.onDelete());
    document.getElementById('btn-insert').addEventListener('click', () => this.onInsert && this.onInsert());
    // 点页面其它任意位置 → 退出编辑并自动保存(pointerdown 比 focusout 更可靠,
    // 覆盖点击非可聚焦区域/滚动条/控件等不会改变焦点的情形)
    document.addEventListener('pointerdown', (e) => {
      if (!this.editItem) return;
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      this.commitEdit();
    });
    // 兜底: 焦点离开编辑器(键盘 Tab 等)
    document.addEventListener('focusin', (e) => {
      if (!this.editItem) return;
      if (this.editorEl && this.editorEl.contains(e.target)) return;
      this.commitEdit();
    });
  }

  get mode() { return this._mode; }

  /** 供快捷键调用: 提交正在进行的行内编辑 */
  applyEdit() { this.commitEdit(); }

  setBadge(text, cls) {
    this.badgeEl.textContent = text;
    this.badgeEl.className = 'badge' + (cls ? ' ' + cls : '');
  }

  /** 面板标题显示当前字幕文件名 */
  setFileName(name) {
    if (!this.phName) return;
    this.phName.textContent = name || '字幕总览';
    this.phName.title = name || '';
  }

  /** 更新坏行计数; 0 时按钮置灰并自动退出"只看坏行"模式 */
  setBadCount(n) {
    if (!this.badBtn) return;
    this.badCountEl.textContent = String(n);
    this.badBtn.disabled = n === 0;
    this.badBtn.title = n
      ? `发现 ${n} 条坏行(时间异常 / 字幕重叠 / 英文行含方括号 / 单中文行 / 单英文行), 点击只显示这些行`
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
    this._applyFilter(keepView ? keepTop : 0);
  }

  _matchMode(it) {
    if (this._badOnly && !it.bad) return false;
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
    const parts = [];
    if (this._badOnly) parts.push('⚠坏行');
    if (this._filterText || this._badOnly || this._mode !== 'bi') {
      parts.push(`${this.filtered.length} / ${this.items.length} 条`);
    } else {
      parts.push(`${this.items.length} 条`);
    }
    this.countEl.textContent = parts.join(' · ');
    this.spacerEl.style.height = (this.filtered.length * ROW_H) + 'px';
    this.listEl.scrollTop = restoreTop;   // 高度先设好, 浏览器按新高度自动夹取
    this._render();
  }

  _render() {
    const scrollTop = this.listEl.scrollTop;
    const viewH = this.listEl.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const end = Math.min(this.filtered.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);
    const showFirst = this._mode !== 'second';
    const showSecond = this._mode !== 'first';

    let html = '';
    for (let i = start; i < end; i++) {
      const it = this.filtered[i];
      const cls = ['cue-card'];
      if (it === this.selected) cls.push('selected');
      if (it === this.playingItem) cls.push('playing');
      if (it === this.editItem) cls.push('editing');

      // 角色(说话人)色: 卡片左标、中文行、两个样式徽标、三个时间值全部跟着它走
      const tone = it.color ? roleTone(it.color) : null;
      const cardStyle = [`top:${i * ROW_H}px`];
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
      const l1 = showFirst && it.l1 ? `<div class="cc-l1"${l1Attr}>${escapeHtml(it.l1)}</div>` : '';
      const l2 = showSecond && it.l2 ? `<div class="cc-l2">${escapeHtml(it.l2)}</div>` : '';
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

  /**
   * 选中条目.
   * scroll=true  — 未完全可见时滚到视野中部;
   * scroll=false — 完全不滚动;
   * scroll='keep'— 仅在**完全不可见**时才滚(重建后恢复选中用, 保持阅读位置稳定)。
   */
  select(item, scroll = true) {
    this.selected = item;
    if (scroll && item) {
      const idx = this.filtered.indexOf(item);
      if (idx !== -1) {
        const top = idx * ROW_H;
        const st = this.listEl.scrollTop, vh = this.listEl.clientHeight;
        const need = scroll === 'keep'
          ? (top + ROW_H <= st || top >= st + vh)   // 完全在视野外
          : (top < st || top > st + vh - ROW_H);    // 部分不可见即居中
        if (need) {
          this._progScroll = true;
          this.listEl.scrollTop = Math.max(0, top - vh / 2);
        }
      }
    }
    this._render();
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
    this.playingItem = found;
    if (found && performance.now() - (this._userScrollAt || 0) > 5000) {
      const idx = this.filtered.indexOf(found);
      if (idx !== -1) {
        const top = idx * ROW_H;
        const st = this.listEl.scrollTop, vh = this.listEl.clientHeight;
        if (top < st || top > st + vh - ROW_H * 2) {
          this._progScroll = true;
          this.listEl.scrollTop = Math.max(0, top - vh / 2);
        }
      }
    }
    this._render();
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
    const div = document.createElement('div');
    div.className = 'inline-editor';
    div.style.top = (idx * ROW_H + 6) + 'px';
    div.innerHTML = `
      <div class="ie-line ie-l1" contenteditable="true" spellcheck="false" data-ph="中文整句…"></div>
      <div class="ie-line ie-l2" contenteditable="true" spellcheck="false" data-ph="英文行…"></div>
      <div class="ie-hint">点击别处自动保存 · Esc 取消 · Enter 换行</div>`;
    div.querySelector('.ie-l1').textContent = item.l1 || '';
    div.querySelector('.ie-l2').textContent = item.l2 || '';
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
    const [l1, l2] = lines;
    // Enter: l1→跳到 l2, l2→提交; Ctrl+Enter 提交; Esc 取消
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeEdit(); this._render(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.commitEdit(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (document.activeElement === l1) l2.focus();
        else this.commitEdit();
      }
    });
    // 粘贴纯文本(避免带入富文本标签)
    div.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text') || '';
      document.execCommand('insertText', false, t.replace(/\r?\n/g, ' ').replace(/\s+/g, ' '));
    });
    // 焦点离开编辑器 → 自动应用
    div.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.editItem && this.editorEl && !this.editorEl.contains(document.activeElement)) this.commitEdit();
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
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 提交行内编辑: 文本有变化才触发 onApply(时间不变, 由主逻辑同步视频区) */
  commitEdit() {
    if (!this.editItem) return;
    const it = this.editItem;
    const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const l1 = norm(this.editorEl && this.editorEl.querySelector('.ie-l1') ? this.editorEl.querySelector('.ie-l1').textContent : it.l1);
    const l2 = norm(this.editorEl && this.editorEl.querySelector('.ie-l2') ? this.editorEl.querySelector('.ie-l2').textContent : it.l2);
    this.closeEdit();
    this._render();
    const newText = l1 + '\n' + l2;
    const origText = norm(it.l1) + '\n' + norm(it.l2);
    if (newText === origText) return;          // 没改 → 不动原始数据(保留 SRT 标签等)
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
  }

  /** 关闭行内编辑器(不提交) */
  closeEdit() {
    this.editItem = null;
    if (this.editorEl) { this.editorEl.remove(); this.editorEl = null; }
  }
}
