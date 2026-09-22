/** 快捷键 / 鼠标手势设置弹窗 */
import { ACTIONS, MOUSE_GESTURES, MOUSE_BEHAVIORS, shortcuts, comboFromEvent, comboLabel } from './shortcuts.js';

let overlay = null;

function ensureDom() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'sc-overlay';
  overlay.innerHTML = `
    <div class="sc-panel">
      <div class="sc-head">
        <span class="sc-title">⌨ 快捷键与鼠标操作设置</span>
        <button class="sc-close" title="关闭">✕</button>
      </div>
      <div class="sc-body">
        <div class="sc-section">
          <div class="sc-sect-title">键盘快捷键 <span class="sc-tip">点击「+ 添加」后按下组合键, Esc 取消; 点击 × 删除</span></div>
          <div class="sc-kb" id="sc-kb"></div>
        </div>
        <div class="sc-section">
          <div class="sc-sect-title">鼠标操作</div>
          <div class="sc-ms" id="sc-ms"></div>
        </div>
        <div class="sc-conflicts" id="sc-conflicts"></div>
      </div>
      <div class="sc-foot">
        <button class="btn" id="sc-reset">恢复默认</button>
        <div class="sc-foot-right">
          <button class="btn" id="sc-cancel">取消</button>
          <button class="btn btn-accent" id="sc-save">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.sc-close').addEventListener('click', closeShortcutDialog);
  overlay.querySelector('#sc-cancel').addEventListener('click', closeShortcutDialog);
  overlay.querySelector('#sc-save').addEventListener('click', () => { shortcuts.save(); closeShortcutDialog(); });
  overlay.querySelector('#sc-reset').addEventListener('click', () => { shortcuts.reset(); renderAll(); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeShortcutDialog(); });
  return overlay;
}

function renderKeyboard() {
  const wrap = overlay.querySelector('#sc-kb');
  const groups = [];
  for (const a of ACTIONS) {
    let g = groups.find(x => x.name === a.group);
    if (!g) { g = { name: a.group, items: [] }; groups.push(g); }
    g.items.push(a);
  }
  let html = '';
  for (const g of groups) {
    html += `<div class="sc-group">${g.name}</div>`;
    for (const a of g.items) {
      const chips = (shortcuts.bindings[a.id] || []).map((c, i) =>
        `<span class="sc-chip">${comboLabel(c)}<b data-act="${a.id}" data-i="${i}" title="删除">×</b></span>`).join('');
      html += `<div class="sc-row">
        <span class="sc-act">${a.name}</span>
        <div class="sc-chips">${chips || '<span class="sc-none">未绑定</span>'}</div>
        <button class="btn btn-mini sc-add" data-act="${a.id}">+ 添加</button>
      </div>`;
    }
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.sc-add').forEach(btn => {
    btn.addEventListener('click', () => startCapture(btn.dataset.act, btn));
  });
  wrap.querySelectorAll('.sc-chip b').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.act, i = +b.dataset.i;
      shortcuts.bindings[id].splice(i, 1);
      renderKeyboard(); renderConflicts();
    });
  });
}

function startCapture(actionId, btn) {
  shortcuts.cancelCapture();
  btn.textContent = '按下组合键…';
  btn.classList.add('capturing');
  shortcuts.beginCapture(actionId, (id, combo) => {
    btn.textContent = '+ 添加';
    btn.classList.remove('capturing');
    if (!combo || combo === 'ESCAPE' || combo.toLowerCase() === 'escape') { renderKeyboard(); return; }
    const list = shortcuts.bindings[id] || (shortcuts.bindings[id] = []);
    if (list.indexOf(combo) === -1) list.push(combo);
    renderKeyboard(); renderConflicts();
  });
}

function renderMouse() {
  const wrap = overlay.querySelector('#sc-ms');
  let html = '';
  for (const g of MOUSE_GESTURES) {
    const cur = shortcuts.mouseBehavior(g.id);
    const opts = MOUSE_BEHAVIORS.map(b =>
      `<option value="${b.id}" ${b.id === cur ? 'selected' : ''}>${b.name}</option>`).join('');
    html += `<div class="sc-row">
      <span class="sc-act">${g.name}</span>
      <select class="select select-dark sc-sel" data-g="${g.id}">${opts}</select>
    </div>`;
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.sc-sel').forEach(sel => {
    sel.addEventListener('change', () => { shortcuts.mouse[sel.dataset.g] = sel.value; renderConflicts(); });
  });
}

function renderConflicts() {
  const el = overlay.querySelector('#sc-conflicts');
  const cs = shortcuts.conflicts();
  if (!cs.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<b>⚠ 冲突:</b> ' + cs.map(c =>
    `${comboLabel(c.combo)} → ${c.actions.map(id => {
      const a = ACTIONS.find(x => x.id === id);
      return a ? a.name : id;
    }).join(' / ')}`).join('；');
}

function renderAll() {
  renderKeyboard();
  renderMouse();
  renderConflicts();
}

export function openShortcutDialog() {
  ensureDom();
  shortcuts.cancelCapture();
  renderAll();
  overlay.style.display = 'flex';
}

export function closeShortcutDialog() {
  if (!overlay) return;
  shortcuts.cancelCapture();
  overlay.style.display = 'none';
}

export function isShortcutDialogOpen() {
  return !!overlay && overlay.style.display === 'flex';
}

/** 供主程序在 document 捕获阶段调用: 录入模式下拦截按键 */
export function handleCaptureKey(e) {
  if (!shortcuts.isCapturing) return false;
  if (e.key === 'Escape') { shortcuts.cancelCapture(); renderKeyboard(); return true; }
  const combo = comboFromEvent(e);
  if (!combo) return true;
  shortcuts._handleCapture(combo);
  return true;
}
