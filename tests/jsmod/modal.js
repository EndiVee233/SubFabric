/* 可拖动二级窗口的统一交互。窗口仍由各业务模块负责显示/隐藏，这里只管理拖动与视口边界。 */

const EDGE_GAP = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isInteractiveTarget(target) {
  return !!target.closest('button, input, select, textarea, a, [contenteditable="true"]');
}

/**
 * 让一个弹窗通过标题栏拖动。
 * 第一次拖动时把原本的 flex 居中位置转换成 fixed 的 left/top，避免窗口跳动。
 */
export function bindModalDrag(surface, handle) {
  if (!surface || !handle || surface.dataset.modalDragBound === '1') return;
  surface.dataset.modalDragBound = '1';
  handle.classList.add('modal-drag-handle');

  const keepInViewport = () => {
    if (!surface.classList.contains('modal-dragged') || surface.hidden) return;
    const rect = surface.getBoundingClientRect();
    const maxLeft = Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
    const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);
    const left = clamp(parseFloat(surface.style.left) || rect.left, EDGE_GAP, maxLeft);
    const top = clamp(parseFloat(surface.style.top) || rect.top, EDGE_GAP, maxTop);
    surface.style.left = left + 'px';
    surface.style.top = top + 'px';
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;

    const rect = surface.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    surface.classList.add('modal-dragged');
    surface.style.position = 'fixed';
    surface.style.left = rect.left + 'px';
    surface.style.top = rect.top + 'px';
    surface.style.right = 'auto';
    surface.style.bottom = 'auto';
    surface.style.margin = '0';
    surface.style.transform = 'none';

    const move = (ev) => {
      const current = surface.getBoundingClientRect();
      const maxLeft = Math.max(EDGE_GAP, window.innerWidth - current.width - EDGE_GAP);
      const maxTop = Math.max(EDGE_GAP, window.innerHeight - current.height - EDGE_GAP);
      surface.style.left = clamp(ev.clientX - offsetX, EDGE_GAP, maxLeft) + 'px';
      surface.style.top = clamp(ev.clientY - offsetY, EDGE_GAP, maxTop) + 'px';
    };

    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      handle.classList.remove('is-dragging');
      if (handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };

    event.preventDefault();
    handle.classList.add('is-dragging');
    if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  window.addEventListener('resize', keepInViewport);
}

/** 绑定页面上所有标准二级窗口。 */
export function bindModalDrags(root = document) {
  const definitions = [
    ['#fr-overlay', '.fr-box', '.fr-head'],
    ['#confirm-overlay', '.rn-box', '.rn-title'],
    ['#role-new', '.rn-box', '.rn-title'],
    ['#pick-overlay', '.pick-box', '.pick-title'],
    ['#fix-overlay', '.fix-box', '.rn-title']
  ];

  for (const [overlaySelector, surfaceSelector, handleSelector] of definitions) {
    const overlay = root.querySelector(overlaySelector);
    const surface = overlay && overlay.querySelector(surfaceSelector);
    const handle = surface && surface.querySelector(handleSelector);
    bindModalDrag(surface, handle);
  }
}
