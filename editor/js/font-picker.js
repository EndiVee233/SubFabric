/* ═══════════ 字体选择器（带预览的下拉）═══════════
 *
 * 为什么不用 <datalist>：原生补全只能显示**纯文字**，字体多的时候分不清
 * 「微软雅黑」和「Microsoft YaHei」长什么样。这个组件把每个字体名用它**自己的字形**
 * 画出来（像 Word 的字体框），选之前就能看到效果。
 *
 * 保留能力（不能因为换成下拉就丢掉）：
 *   · **仍可手打任意字体名** —— 输入框还在，`<datalist>` 只是被去掉；
 *     ASS 的字体名允许本机没装（渲染时回退），所以输入框不能变成纯 select。
 *   · 「载入字体」（手动选 .ttf）那个按钮不受影响。
 *
 * 实测前提（2026-10-10，无头 Edge）：
 *   · /api/fonts 返回 390 个系统字体，`document.fonts.check()` 对**全部** 390 个都返回 true
 *     —— 也就是说浏览器能给它们渲染预览（不只是服务端能读文件）。
 *   · 不同字体确实渲染出不同宽度（Arial 220.5 / Courier New 256 / Impact 194.9），
 *     预览有区分度，不是都在用同一个回退字体。
 *
 * 390 个 <li> 一次性插进 DOM 会明显卡顿，所以：
 *   · 首屏只建前 CHUNK 个，滚动到底再续建（渐进渲染）
 *   · 过滤时先只建前 CHUNK 个匹配项
 */

const CHUNK = 80;          // 一次建多少个 <li>

let fsCache = null;        // 系统字体名数组（同一个 promise 复用）

/** 拿系统字体名清单；失败返回空数组（此时组件静默不装，输入框照旧可用） */
function loadFontNames() {
  if (fsCache) return fsCache;
  fsCache = (async () => {
    try {
      const r = await fetch('/api/fonts');
      if (!r.ok) return [];
      const j = await r.json();
      const list = Array.isArray(j.fonts) ? j.fonts : [];
      return list.map(x => String(x == null ? '' : x).trim()).filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'zh'));
    } catch { return []; }
  })();
  return fsCache;
}

/** 字体名 → 安全的 CSS font-family 值（去掉引号、反斜杠、换行，防止注入/串行） */
function safeFamily(name) {
  return String(name == null ? '' : name).replace(/["\\\r\n]/g, '').trim();
}

/**
 * 把「字体名输入框」升级成带预览的下拉。
 * 会**保留原 input 元素**（值/事件/下游逻辑都不变），只在它旁边加一个下拉按钮，
 * 并去掉 list 属性（不再用原生 datalist）。
 *
 * @param {HTMLInputElement} input 字体名输入框
 * @param {object} [opts] { onPick(name) } 选中后额外回调（可选）
 * @returns {{open:Function, close:Function, pick:Function, destroy:Function}|null}
 */
export function enhanceFontInput(input, opts) {
  if (!input || input.__fontPicker) return null;
  const o = opts || {};

  /* 去掉 datalist：原生补全会盖住我们的面板，两套同时弹很乱。
   * 用 cloneNode 换掉原元素是没必要的 —— 只删属性即可，监听器都还在。 */
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');

  // 外层容器：承载 [输入框][下拉按钮]
  const wrap = document.createElement('div');
  wrap.className = 'fp-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fp-btn';
  btn.title = '从系统字体里选（带预览）';
  btn.setAttribute('aria-label', '选择字体');
  btn.textContent = '▾';
  wrap.appendChild(btn);

  // 浮层：过滤框 + 列表
  const panel = document.createElement('div');
  panel.className = 'fp-panel';
  panel.hidden = true;
  panel.innerHTML = '<input type="text" class="fp-filter" placeholder="搜索字体…" spellcheck="false">'
    + '<div class="fp-list" role="listbox"></div>';
  document.body.appendChild(panel);
  const filterEl = panel.querySelector('.fp-filter');
  const listEl = panel.querySelector('.fp-list');

  let names = [];
  let shown = [];          // 当前过滤后的结果
  let built = 0;           // 已建了多少个 <li>
  let active = -1;         // 键盘高亮项
  let opened = false;

  function buildMore() {
    const end = Math.min(shown.length, built + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = built; i < end; i++) {
      const n = shown[i];
      const li = document.createElement('div');
      li.className = 'fp-item';
      li.setAttribute('role', 'option');
      li.dataset.name = n;
      li.dataset.idx = String(i);
      li.textContent = n;
      // 关键：用**它自己的字形**渲染这一行
      li.style.fontFamily = '"' + safeFamily(n) + '", sans-serif';
      frag.appendChild(li);
    }
    listEl.appendChild(frag);
    built = end;
  }

  function ensureActiveVisible() {
    const el = listEl.querySelector('.fp-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function setActive(i) {
    const items = listEl.querySelectorAll('.fp-item');
    if (!items.length) return;
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((el, k) => el.classList.toggle('active', k === active));
    // 高亮项若还没建出来，先续建
    if (active >= built - 1 && built < shown.length) { buildMore(); setActive(active); return; }
    ensureActiveVisible();
  }

  function applyFilter(q) {
    const key = String(q || '').trim().toLowerCase();
    shown = key ? names.filter(n => n.toLowerCase().includes(key)) : names.slice();
    listEl.innerHTML = '';
    built = 0;
    active = -1;
    if (!shown.length) {
      listEl.innerHTML = '<div class="fp-empty">没有匹配的字体</div>';
      return;
    }
    buildMore();
    setActive(0);
  }

  function place() {
    // 面板贴着输入框下方；下方空间不够就翻到上方
    const r = wrap.getBoundingClientRect();
    const h = 320;
    const below = window.innerHeight - r.bottom;
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 340)) + 'px';
    panel.style.width = Math.max(260, Math.min(340, window.innerWidth - 24)) + 'px';
    if (below < h + 12 && r.top > h + 12) {
      panel.style.top = (r.top - h - 6) + 'px';
    } else {
      panel.style.top = (r.bottom + 4) + 'px';
    }
  }

  function pick(name) {
    const n = String(name || '').trim();
    if (!n) return;
    // ⚠ 只设 value + 派发 change：下游（ensureSystemFont → 载入进 libass → 重建预览）
    //    全都挂在 change 上，不要在这里重复调用，否则会重复重建预览。
    input.value = n;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof o.onPick === 'function') { try { o.onPick(n); } catch {} }
    close();
  }

  async function open() {
    if (opened) return;
    opened = true;
    panel.hidden = false;
    btn.classList.add('on');
    filterEl.value = '';
    listEl.innerHTML = '<div class="fp-empty">读取系统字体…</div>';
    place();
    names = await loadFontNames();
    if (!opened) return;                       // 期间被关掉了
    if (!names.length) {
      listEl.innerHTML = '<div class="fp-empty">没读到系统字体（服务端的字体库不可用）</div>';
      return;
    }
    applyFilter('');
    filterEl.focus();
  }

  function close() {
    if (!opened) return;
    opened = false;
    panel.hidden = true;
    btn.classList.remove('on');
  }

  /* ── 事件 ─────────────────────────────────────────── */
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (opened) close(); else open();
  });
  filterEl.addEventListener('input', () => applyFilter(filterEl.value));
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = listEl.querySelector('.fp-item.active');
      if (cur) pick(cur.dataset.name);
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  listEl.addEventListener('click', (e) => {
    const it = e.target.closest && e.target.closest('.fp-item');
    if (it) pick(it.dataset.name);
  });
  // 滚动到底自动续建
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 40) buildMore();
  });
  // 点面板外关闭（capture：避免被内部 stopPropagation 吃掉）
  const onDocDown = (e) => {
    if (!opened) return;
    if (panel.contains(e.target) || wrap.contains(e.target)) return;
    close();
  };
  document.addEventListener('mousedown', onDocDown, true);
  window.addEventListener('resize', () => { if (opened) place(); });

  const api = { open, close, pick, get names() { return names; } };
  api.destroy = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    panel.remove();
    btn.remove();
    if (wrap.parentNode) { wrap.parentNode.insertBefore(input, wrap); wrap.remove(); }
    delete input.__fontPicker;
  };
  input.__fontPicker = api;
  return api;
}
