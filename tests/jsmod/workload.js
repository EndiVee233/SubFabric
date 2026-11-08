/** Read-only estimates from sentence confidence; never rescore or mutate subtitles. */
export const WORKLOAD_CALIBRATION = Object.freeze({
  // Historical log transactions attributed to a new draft; not edits replayed against that draft.
  version: 'log-transactions-20261108', method: 'time-attributed-log-transactions', videos: 1, engine: 'whisperx',
  durationSeconds: 7200, sourceRows: 2200, referenceRows: 3163, matchedRows: 1993, draftSpeakers: false,
  logRecords: 15521, attributedTransactions: 9659, unmatchedTransactions: 794, truncatedRecords: 3,
  confidenceRange: Object.freeze([0.49, 0.93]),
  calibratedBands: Object.freeze(['60to70', '70to80', '80to90']),
  samples: Object.freeze({ under60: 9, '60to70': 84, '70to80': 1698, '80to90': 403, '90to100': 6 }),
  regular: Object.freeze({ method: 'per-draft-sentence-timeline-once', timingSentences: 1454,
    timingTransactions: 4774.887, operations: 6333.336,
    timingKinds: Object.freeze(['time_adjust', 'english_boundary_adjust', 'subtitle_time_adjust']) }),
});
export const WORKLOAD_STANDARDS = Object.freeze({
  precise: Object.freeze({ label: '精翻标准', automatic: Object.freeze([6, 5, 4, 3, 1]) }),
  regular: Object.freeze({ label: '常规标准', automatic: Object.freeze([6, 3, 3, 2, 1]) }),
});
export const WORKLOAD_BANDS = Object.freeze([
  { id: 'under60', label: '<60%', upper: 0.6, automatic: 6 },
  { id: '60to70', label: '60–<70%', upper: 0.7, automatic: 5 },
  { id: '70to80', label: '70–<80%', upper: 0.8, automatic: 4 },
  { id: '80to90', label: '80–<90%', upper: 0.9, automatic: 3 },
  { id: '90to100', label: '90–100%', upper: Infinity, automatic: 1 },
].map(Object.freeze));

export function workloadOptions(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const valid = n => Number.isInteger(n) && n >= 1 && n <= 6;
  const raw = value.weights && typeof value.weights === 'object' ? value.weights : {};
  const oldKeys = ['under50', '50to60', '60to75', '75to90', '90to100'];
  const sanitizeLegacy = source => Object.fromEntries(oldKeys.filter(key => source
    && (valid(source[key]) || source[key] === 'auto')).map(key => [key, source[key]]));
  const migrating = value.bandsVersion !== 2 && oldKeys.slice(0, -1).some(key => valid(raw[key]));
  const backup = sanitizeLegacy(migrating ? raw : value.legacyWeights);
  const legacyWeights = Object.keys(backup).length ? backup : null;
  const sources = { under60: ['under50', '50to60'], '60to70': ['60to75'],
    '70to80': ['60to75', '75to90'], '80to90': ['75to90'] };
  const weights = {};
  const regularWeights = {};
  for (const band of WORKLOAD_BANDS) {
    const previous = migrating ? (sources[band.id] || []).map(key => raw[key]).filter(valid) : [];
    const n = raw[band.id];
    weights[band.id] = valid(n) ? n : previous.length ? Math.max(...previous) : 'auto';
    const regular = value.regularWeights?.[band.id];
    regularWeights[band.id] = valid(regular) ? regular : 'auto';
  }
  return {
    bandsVersion: 2, collapseDetails: value.collapseDetails !== false, legacyWeights,
    minutes: [5, 10, 20].includes(value.minutes) ? value.minutes : 10,
    threshold: [75, 90, 100].includes(value.threshold) ? value.threshold : 90,
    mode: value.mode === 'operations' ? 'operations' : 'relative',
    standard: value.standard === 'regular' ? 'regular' : 'precise', weights, regularWeights,
  };
}

export function confidenceBand(score) {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1
    ? WORKLOAD_BANDS.findIndex(band => score < band.upper) : -1;
}

export function estimateWorkload(items, duration, preferences) {
  const options = workloadOptions(preferences), seconds = options.minutes * 60;
  const automatic = WORKLOAD_STANDARDS[options.standard].automatic;
  const weights = options.standard === 'regular' ? options.regularWeights : options.weights;
  let endTime = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const valid = [];
  let invalid = 0;
  for (const item of items || []) {
    if (!item || !Number.isFinite(item.start) || item.start < 0 || !Number.isFinite(item.end) || item.end <= item.start) {
      invalid++; continue;
    }
    valid.push(item); endTime = Math.max(endTime, item.end);
  }
  // Malformed imported times must not allocate an unbounded array or freeze the editor.
  const count = valid.length ? Math.ceil(endTime / seconds) : 0;
  if (count > 10000) throw new RangeError('字幕时间范围过大，无法生成分段预测');
  const segments = Array.from({ length: count }, (_, index) => ({
    index, start: index * seconds, end: Math.min((index + 1) * seconds, endTime),
    total: 0, known: 0, unknown: 0, belowThreshold: 0,
    counts: WORKLOAD_BANDS.map(() => 0), operations: 0, relative: null,
  }));
  for (const item of valid) {
    // A sentence crossing a boundary belongs to its start segment exactly once.
    const segment = segments[Math.floor(item.start / seconds)];
    segment.total++;
    const bandIndex = confidenceBand(item.confidence?.score);
    if (bandIndex < 0) { segment.unknown++; continue; }
    segment.known++; segment.counts[bandIndex]++;
    if (options.threshold === 100 || item.confidence.score < options.threshold / 100) {
      segment.belowThreshold++;
      const band = WORKLOAD_BANDS[bandIndex];
      segment.operations += weights[band.id] === 'auto' ? automatic[bandIndex] : weights[band.id];
    }
  }
  let baseline = Infinity, max = 0;
  for (const segment of segments) {
    // An unknown-only segment has no numerical estimate; an empty segment has zero work.
    if (segment.total && !segment.known) segment.operations = null;
    if (segment.operations > 0) baseline = Math.min(baseline, segment.operations);
    max = Math.max(max, segment.operations || 0);
  }
  if (!Number.isFinite(baseline)) baseline = null;
  for (const segment of segments) {
    segment.relative = segment.operations == null ? null : segment.operations === 0 ? 0 : segment.operations / baseline;
    segment.fraction = max ? (segment.operations || 0) / max : 0;
    segment.heat = max > baseline && segment.operations > 0 ? (segment.operations - baseline) / (max - baseline) : 0;
  }
  return { options, segments, baseline, max, invalid, total: valid.length,
    known: segments.reduce((n, s) => n + s.known, 0), unknown: segments.reduce((n, s) => n + s.unknown, 0),
    operations: segments.reduce((n, s) => n + (s.operations || 0), 0),
    belowThreshold: segments.reduce((n, s) => n + s.belowThreshold, 0) };
}
