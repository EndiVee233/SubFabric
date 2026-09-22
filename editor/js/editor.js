/** 右侧编辑面板: 虚拟滚动卡片列表(中英双行) + 编辑表单 */
import { fmtTime, escapeHtml, bisectStart } from './util.js';

const ROW_H = 92;

export class EditorPanel {
  constructor() {
    this.listEl = document.getElementById('cue-list');
    this.spacerEl = document.getElementById('cue-spacer');
    this.elIndex = document.getElementById('ef-index');
    this.elStyle = document.getElementById('ef-style');
    this.inpStart = document.getElementById('inp-start');
    this.inpEnd = document.getElementById('inp-end');
    this.inpDur = document.getElementById('inp-dur');
    this.inpText = document.getElementById('inp-text');
    this.searchBox = document.getElementById('search-box');
    this.countEl = document.getElementById('cue-count');
    this.badgeEl = document.getElementById('badge-format');
    this.modeSel = document.getElementById('sel-display-mode');

    this.items = [];          // 全量
    this.filtered = [];       // 过滤后
    this.selected = null;
    this.playingItem = null;
    this._filterText = '';
    this._mode = 'bi';        // bi(双行) | first(仅主) | second(仅副)
    this._progScroll = false;

    this.onSelect = null;
    this.onApply = null;
    this.onDelete = null;
    this.onInsert = null;
    this.onPlayCue = null;
    this.onModeChange = null;

    this._bind();
  }

  _bind() {
    this.listEl.addEventListener('scroll', () => {
      if (this._progScroll) { this._progScroll = false; return; }
      this._userScrollAt = performance.now();
      this._render();
    });
    this.listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.cue-card');
      if (!card) return;
      const item = this.filtered[+card.dataset.idx];
      if (item && this.onSelect) this.onSelect(item);
    });
    this.searchBox.addEventListener('input', () => {
      this._filterText = this.searchBox.value.trim().toLowerCase();
      this._applyFilter();
    });
    if (this.modeSel) {
      this.modeSel.addEventListener('change', () => {
        this._mode = this.modeSel.value;
        this._applyFilter();
        this.onModeChange && this.onModeChange(this._mode);
      });
    }
    document.getElementById('btn-apply').addEventListener('click', () => this._emitApply());
    document.getElementById('btn-delete').addEventListener('click', () => this.onDelete && this.onDelete());
    document.getElementById('btn-insert').addEventListener('click', () => this.onInsert && this.onInsert());
    document.getElementById('btn-play-cue').addEventListener('click', () => this.onPlayCue && this.onPlayCue());
    this.inpText.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this._emitApply(); }
    });
  }

  get mode() { return this._mode; }

  /** 供快捷键调用: 应用当前表单内容 */
  applyEdit() { this._emitApply(); }

  _emitApply() {
    if (!this.selected || !this.onApply) return;
    this.onApply({
      start: this.inpStart.value,
      end: this.inpEnd.value,
      dur: this.inpDur.value,
      text: this.inpText.value
    });
  }

  setBadge(text, cls) {
    this.badgeEl.textContent = text;
    this.badgeEl.className = 'badge' + (cls ? ' ' + cls : '');
  }

  setModeOptions(opts, current) {
    if (!this.modeSel) return;
    this.modeSel.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join('');
    this.modeSel.value = current || 'bi';
    this._mode = this.modeSel.value;
  }

  setItems(items) {
    this.items = items;
    this.selected = null;
    this.playingItem = null;
    this._applyFilter();
    this._fillForm(null);
  }

  _matchMode(it) {
    if (this._mode === 'first') return !!it.l1;
    if (this._mode === 'second') return !!it.l2;
    return true;
  }

  _applyFilter() {
    const q = this._filterText;
    this.filtered = this.items.filter(it => {
      if (!this._matchMode(it)) return false;
      if (!q) return true;
      return ((it.l1 || '').toLowerCase().includes(q)) || ((it.l2 || '').toLowerCase().includes(q));
    });
    this.countEl.textContent = (this._filterText || this._mode !== 'bi')
      ? `${this.filtered.length} / ${this.items.length} 条`
      : `${this.items.length} 条`;
    this.spacerEl.style.height = (this.filtered.length * ROW_H) + 'px';
    this.listEl.scrollTop = 0;
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
      const chips = [];
      if (it.badge1) chips.push(`<span class="cc-chip chip-l1">${escapeHtml(it.badge1)}</span>`);
      if (it.badge2 && showSecond) chips.push(`<span class="cc-chip chip-l2">${escapeHtml(it.badge2)}</span>`);
      const l1 = showFirst && it.l1 ? `<div class="cc-l1">${escapeHtml(it.l1)}</div>` : '';
      const l2 = showSecond && it.l2 ? `<div class="cc-l2">${escapeHtml(it.l2)}</div>` : '';
      html += `<div class="${cls.join(' ')}" data-idx="${i}" style="top:${i * ROW_H}px">
        <div class="cc-times">
          <div class="cc-t"><span>开始</span><b>${fmtTime(it.start)}</b></div>
          <div class="cc-t"><span>结束</span><b>${fmtTime(it.end)}</b></div>
          <div class="cc-t"><span>时长</span><b>${(it.end - it.start).toFixed(3)}s</b></div>
        </div>
        <div class="cc-body">
          <div class="cc-head"><span class="cc-no">#${it.no}</span>${chips.join('')}</div>
          ${l1}${l2}
        </div>
      </div>`;
    }
    this.spacerEl.innerHTML = html;
  }

  refreshItem() { this._render(); }

  select(item, scroll = true) {
    this.selected = item;
    this._fillForm(item);
    if (scroll && item) {
      const idx = this.filtered.indexOf(item);
      if (idx !== -1) {
        const top = idx * ROW_H;
        const st = this.listEl.scrollTop, vh = this.listEl.clientHeight;
        if (top < st || top > st + vh - ROW_H) {
          this._progScroll = true;
          this.listEl.scrollTop = Math.max(0, top - vh / 2);
        }
      }
    }
    this._render();
  }

  _fillForm(item) {
    if (!item) {
      this.elIndex.textContent = '—';
      this.elStyle.textContent = '';
      this.inpStart.value = this.inpEnd.value = this.inpDur.value = this.inpText.value = '';
      return;
    }
    this.elIndex.textContent = '#' + item.no;
    this.elStyle.textContent = [item.badge1, item.badge2].filter(Boolean).join(' + ');
    this.inpStart.value = fmtTime(item.start);
    this.inpEnd.value = fmtTime(item.end);
    this.inpDur.value = (item.end - item.start).toFixed(3);
    this.inpText.value = item.textRaw || '';
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
}
