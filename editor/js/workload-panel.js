import { WORKLOAD_BANDS, WORKLOAD_STANDARDS, workloadOptions, estimateWorkload } from './workload.js';
import { escapeHtml, fmtTime } from './util.js';
import { t } from './i18n.js';

const KEY = 'sf-workload-v1', PAGE_SIZE = 20;
function copy(template, ...values) {
  let index = 0;
  return t(template).replace(/◇/g, () => String(values[index++] ?? ''));
}
export function initWorkloadPanel({ element, getItems, getDuration, onSeek }) {
  if (!element) return null;
  let options;
  try { options = workloadOptions(JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { options = workloadOptions(); }
  let visible = false, dirty = true, frame = 0, page = 0, model = null;
  const expanded = new Map();
  const controls = {
    minutes: element.querySelector('#workload-minutes'), threshold: element.querySelector('#workload-threshold'),
    mode: element.querySelector('#workload-mode'), weights: element.querySelector('#workload-weights'),
    standard: element.querySelector('#workload-standard'),
    collapse: element.querySelector('#workload-collapse'),
    summary: element.querySelector('#workload-summary'), list: element.querySelector('#workload-list'),
    status: element.querySelector('#workload-status'), pager: element.querySelector('#workload-pager'),
    previous: element.querySelector('#workload-previous'), next: element.querySelector('#workload-next'),
    page: element.querySelector('#workload-page'),
  };
  for (const key of ['minutes', 'threshold', 'mode', 'standard']) controls[key].value = String(options[key]);
  controls.collapse.checked = options.collapseDetails;
  controls.weights.innerHTML = WORKLOAD_BANDS.map(band =>
    `<label class="workload-weight"><span>${escapeHtml(band.label)}</span><select class="select" data-band="${band.id}" aria-label="${escapeHtml(copy('置信度 ◇ 的每句预计修改次数', band.label))}">`
    + `<option value="auto">${escapeHtml(copy('自动（◇ 次）', band.automatic))}</option>`
    + Array.from({ length: 6 }, (_, i) => `<option value="${i + 1}">${escapeHtml(copy('◇ 次', i + 1))}</option>`).join('')
    + '</select></label>').join('');
  const activeWeights = () => options.standard === 'regular' ? options.regularWeights : options.weights;
  function syncWeights() {
    const automatic = WORKLOAD_STANDARDS[options.standard].automatic;
    [...controls.weights.querySelectorAll('select')].forEach((select, i) => {
      select.querySelector('[value="auto"]').textContent = copy('自动（◇ 次）', automatic[i]);
      select.value = String(activeWeights()[select.dataset.band]);
    });
  }
  syncWeights();

  function render() {
    frame = 0;
    if (!visible || !element.getClientRects().length) return;
    if (dirty) {
      try {
        model = estimateWorkload(getItems(), getDuration(), options);
        controls.status.textContent = !model.total ? t('打开字幕后显示分段预测；没有置信度的句子会单独标出。')
          : !model.known ? t('当前字幕没有可用的逐句置信度，无法估算修改次数。')
          : model.unknown ? copy('有 ◇ 句缺少置信度，预计次数仅覆盖已有评分的句子。', model.unknown)
          : t('已按全部句子的现有置信度生成预测。');
        if (model.invalid) controls.status.textContent += ' ' + copy('另有 ◇ 句时间无效，未纳入分段。', model.invalid);
        if (model.known && Object.values(activeWeights()).includes('auto')) {
          controls.status.textContent += ' ' + (options.standard === 'regular'
            ? t('常规标准：同一句的整句和逐词时间调整合计一次，其他操作保留。自动档参考历史日志，样本不足档位沿用原估值。')
            : t('精翻标准：按日志逐次统计时间调整。自动档参考一份视频前两小时的日志与初稿对照，不等于实际点击次数。'));
        }
        if (options.standard === 'precise' && options.legacyWeights) controls.status.textContent += ' ' + t('旧手动权重已迁移；跨档采用较高的手动值，原设置已保留，可在每句预计修改次数中调整。');
        dirty = false;
      } catch (error) {
        controls.status.textContent = t(error.message); controls.summary.textContent = '';
        controls.list.replaceChildren(); controls.pager.hidden = true; return;
      }
    }
    const pageCount = Math.max(1, Math.ceil(model.segments.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pageCount - 1));
    controls.summary.textContent = copy('◇ 句 · ◇ 句纳入预测 · 预计修改 ◇ 次', model.total, model.belowThreshold, model.operations);
    controls.list.innerHTML = model.segments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(segment => {
      const color = segment.heat <= 0.5
        ? `color-mix(in srgb, var(--success) ${Math.round((1 - segment.heat * 2) * 100)}%, var(--warning))`
        : `color-mix(in srgb, var(--warning) ${Math.round((2 - segment.heat * 2) * 100)}%, var(--danger))`;
      const value = segment.operations == null ? t('无法估算')
        : options.mode === 'operations' ? copy('◇ 次', segment.operations)
        : `${Number(segment.relative.toFixed(2))}×`;
      const open = expanded.get(segment.index) ?? !options.collapseDetails;
      return `<details class="workload-card" data-segment="${segment.index}"${open ? ' open' : ''}>`
        + `<summary class="workload-card-summary" title="${escapeHtml(t('点击展开或折叠分段详情'))}">`
        + `<span class="workload-card-head"><button type="button" class="workload-seek" data-start="${segment.start}" title="${escapeHtml(t('跳至此段'))}">${fmtTime(segment.start, 0)} – ${fmtTime(segment.end, 0)}</button>`
        + `<strong class="workload-value">${escapeHtml(value)}</strong></span>`
        + `<span class="workload-meter" role="meter" aria-label="${escapeHtml(t('此段预计修改次数'))}" aria-valuemin="0" aria-valuemax="${model.max || 1}" aria-valuenow="${segment.operations || 0}" aria-valuetext="${escapeHtml(segment.operations == null ? t('无法估算') : copy('◇ 次', segment.operations))}">`
        + `<span style="width:${segment.fraction * 100}%;background:${color}"></span></span></summary>`
        + `<div class="workload-card-meta">${escapeHtml(copy('◇ 句 · ◇ 句纳入预测', segment.total, segment.belowThreshold))}`
        + (segment.unknown ? ` · ${escapeHtml(copy('缺置信度 ◇ 句', segment.unknown))}` : '') + '</div>'
        + '<div class="workload-counts">' + WORKLOAD_BANDS.map((band, i) =>
          `<span><span>${escapeHtml(band.label)}</span><b>${segment.counts[i]}</b></span>`).join('') + '</div></details>';
    }).join('');
    controls.pager.hidden = pageCount <= 1;
    controls.previous.disabled = page === 0; controls.next.disabled = page >= pageCount - 1;
    controls.page.textContent = copy('第 ◇ / ◇ 页', page + 1, pageCount);
  }
  function schedule() { if (visible && !frame) frame = requestAnimationFrame(render); }
  element.addEventListener('change', event => {
    const select = event.target;
    if (select.dataset.band) activeWeights()[select.dataset.band] = select.value === 'auto' ? 'auto' : Number(select.value);
    else if (select === controls.minutes) options.minutes = Number(select.value);
    else if (select === controls.threshold) options.threshold = Number(select.value);
    else if (select === controls.mode) options.mode = select.value;
    else if (select === controls.standard) options.standard = select.value;
    else if (select === controls.collapse) { options.collapseDetails = select.checked; expanded.clear(); }
    else return;
    if (select === controls.minutes) expanded.clear();
    options = workloadOptions(options); page = 0; dirty = true;
    if (select === controls.standard) syncWeights();
    try { localStorage.setItem(KEY, JSON.stringify(options)); } catch { /* Session preferences still work. */ }
    schedule();
  });
  controls.list.addEventListener('click', event => {
    const button = event.target.closest('[data-start]');
    if (button) { event.preventDefault(); onSeek(Number(button.dataset.start)); }
  });
  controls.list.addEventListener('toggle', event => {
    const card = event.target;
    if (visible && card.isConnected && card.matches('.workload-card')) expanded.set(Number(card.dataset.segment), card.open);
  }, true);
  controls.previous.addEventListener('click', () => { page--; schedule(); });
  controls.next.addEventListener('click', () => { page++; schedule(); });
  return {
    invalidate() { dirty = true; schedule(); },
    setVisible(on) {
      if (on && !visible) expanded.clear();
      visible = on;
      if (on) schedule();
    },
  };
}
