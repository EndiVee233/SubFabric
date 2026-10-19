/* 共享进度外观：固定波形只由 CSS 位移，可见性观察器不参与每帧渲染。 */
(function () {
  'use strict';
  const values = new Set(['running', 'queued', 'paused', 'error', 'canceled', 'done', 'ready']);
  const amount = value => Math.min(100, Math.max(0, Number(value) || 0));
  /* null/undefined/空串/NaN = 进度未知；UWP 用 32% 块循环，其它主题保留原样。 */
  const unknown = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value));
  const phase = value => values.has(value) ? value : 'paused';
  const tracked = new Map();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) if (tracked.has(entry.target)) {
      tracked.set(entry.target, entry.isIntersecting); syncOne(entry.target);
    }
  }) : null;
  function visual(value, attributes = '') {
    return `<span class="sf-progress-rest"></span><i class="sf-progress-fill" ${attributes} style="width:${amount(value)}%"><span class="sf-progress-line"></span><span class="sf-progress-wave"><span class="sf-wave-shift"></span></span></i><span class="sf-progress-thumb"></span>`;
  }
  function html(value, status, attributes = '') {
    const indet = unknown(value);
    const n = indet ? 0 : amount(value);
    return `<div class="progress sf-progress" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(n)}" data-indeterminate="${indet}" data-progress-state="${phase(status)}" style="--sf-progress:${n}%">${visual(n, attributes)}</div>`;
  }
  function syncOne(el) {
    const n = Number(el.dataset.progressValue ?? parseFloat(el.style.getPropertyValue('--sf-progress')));
    const animate = tracked.get(el) === true && el.isConnected && !document.hidden &&
      document.body.dataset.design === 'material' && document.body.dataset.motion !== 'off' &&
      !reduced.matches && el.dataset.progressState === 'running' && n > 0 && n < 100;
    const next = String(animate);
    if (el.dataset.waveAnimated !== next) el.dataset.waveAnimated = next;
  }
  function sync() { for (const el of tracked.keys()) syncOne(el); }
  function mount(root = document) {
    // 重建/筛选后释放旧节点；观察器只保留当前页面，不累积卡片引用。
    for (const el of tracked.keys()) if (!el.isConnected) { observer?.unobserve(el); tracked.delete(el); }
    for (const el of root.querySelectorAll('.sf-progress')) if (!tracked.has(el)) {
      tracked.set(el, !observer); syncOne(el); observer?.observe(el);
    }
    sync();
  }
  function unmount(root) {
    for (const el of tracked.keys()) if (!root || root.contains(el)) {
      el.dataset.waveAnimated = 'false'; observer?.unobserve(el); tracked.delete(el);
    }
  }
  function set(el, value, status) {
    const root = el?.classList?.contains('sf-progress') ? el : el?.closest('.sf-progress');
    if (!root) return;
    const indet = unknown(value);
    if (root.dataset.indeterminate !== String(indet)) root.dataset.indeterminate = String(indet);
    const n = indet ? 0 : amount(value), text = String(n);
    if (root.dataset.progressValue !== text) {
      root.dataset.progressValue = text;
      root.style.setProperty('--sf-progress', `${n}%`);
      const fill = root.querySelector('.sf-progress-fill');
      if (fill) fill.style.width = `${n}%`;
      if (root.getAttribute('role') === 'progressbar') root.setAttribute('aria-valuenow', Math.floor(n));
    }
    if (status !== undefined && root.dataset.progressState !== phase(status)) root.dataset.progressState = phase(status);
    syncOne(root);
  }
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  window.addEventListener('pagehide', () => unmount());
  window.addEventListener('pageshow', () => mount());
  window.SF_PROGRESS = { html, visual, set, mount, unmount, sync };
})();
