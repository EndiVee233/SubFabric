import assert from 'node:assert/strict';
import { WORKLOAD_BANDS, WORKLOAD_CALIBRATION, confidenceBand, workloadOptions, estimateWorkload } from '../editor/js/workload.js';

assert.deepEqual(WORKLOAD_BANDS.map(band => band.automatic), [6, 4, 3, 3, 1]);
assert.deepEqual(WORKLOAD_CALIBRATION.calibratedBands, ['60to70', '70to80', '80to90']);
assert.equal(WORKLOAD_CALIBRATION.samples['60to70'], 39);
assert.equal(WORKLOAD_CALIBRATION.samples['70to80'], 625);
assert.equal(WORKLOAD_CALIBRATION.samples['80to90'], 332);
assert.equal(WORKLOAD_CALIBRATION.samples['90to100'], 0, 'unobserved scores retain their prior rather than inventing evidence');
assert.equal(estimateWorkload([{ start: 0, end: 1, confidence: { score: .7 } }], 1).operations, 3);
assert.equal(estimateWorkload([{ start: 0, end: 1, confidence: { score: .8 } }], 1).operations, 3);

const cue = (start, score, end = start + 2) => ({ start, end, confidence: score === undefined ? null : { score } });
const items = [cue(0, .49), cue(60, .5), cue(120, .6), cue(180, .75), cue(240, .9), cue(299, .999, 301),
  cue(300, 1), cue(350), cue(600, .5), cue(601, .7), cue(605, .8), cue(900, 1)];
const before = JSON.stringify(items);
let result = estimateWorkload(items, 1200, { minutes: 5 });
assert.equal(result.segments.length, 4);
assert.equal(result.total, 12); assert.equal(result.known, 11); assert.equal(result.unknown, 1);
assert.deepEqual(result.segments.map(s => s.operations), [19, 0, 12, 0]);
assert.deepEqual(result.segments[0].counts, [2, 1, 1, 0, 2]);
assert.equal(result.segments[0].total, 6, 'cross-boundary sentence is counted in its starting segment once');
assert.equal(result.segments[1].total, 2, 'a start at exactly five minutes goes in the next segment');
assert.equal(result.baseline, 12); assert.equal(result.segments[2].relative, 1);
assert.equal(result.segments[0].relative, 19 / 12); assert.equal(result.segments[1].relative, 0);
assert.equal(result.belowThreshold, 7);

assert.deepEqual(estimateWorkload(items, 1200, { minutes: 5, threshold: 75 }).segments.map(s => s.operations), [16, 0, 9, 0]);
assert.deepEqual(estimateWorkload(items, 1200, { minutes: 5, threshold: 100 }).segments.map(s => s.operations), [21, 1, 12, 1]);
assert.equal(estimateWorkload(items, 1200, { minutes: 10 }).segments.length, 2);
result = estimateWorkload(items, 1200, { minutes: 20 });
assert.equal(result.segments.length, 1); assert.equal(result.segments[0].relative, 1);

result = estimateWorkload(items, 1200, { minutes: 5, weights: { under60: 1, '60to70': 6, '70to80': 2, '80to90': 1, '90to100': 4 } });
assert.deepEqual(result.segments.map(s => s.operations), [10, 0, 4, 0]);
assert.equal(JSON.stringify(items), before, 'forecasting never changes subtitle/confidence data');

const defaults = workloadOptions(null);
assert.equal(defaults.mode, 'relative'); assert.equal(defaults.minutes, 10); assert.equal(defaults.threshold, 90);
assert.equal(defaults.collapseDetails, true); assert.equal(defaults.bandsVersion, 2);
assert.equal(workloadOptions({collapseDetails:false}).collapseDetails, false);
const invalid = workloadOptions({ minutes: 0, threshold: '90', mode: 'invalid', weights: { under50: 0, '50to60': 7, '60to75': 1.5 } });
assert.deepEqual(invalid, defaults);
assert.equal(workloadOptions({ mode: 'operations' }).mode, 'operations');
for (const score of [null, undefined, NaN, Infinity, -.01, 1.01, '.5']) assert.equal(confidenceBand(score), -1);
assert.equal(confidenceBand(0), 0); assert.equal(confidenceBand(.5), 0);
assert.equal(confidenceBand(.6), 1); assert.equal(confidenceBand(.7), 2);
assert.equal(confidenceBand(.8), 3); assert.equal(confidenceBand(.9), 4); assert.equal(confidenceBand(1), 4);
for (const [score, expected] of [[.59999,0],[.69999,1],[.79999,2],[.89999,3],[.99999,4]]) assert.equal(confidenceBand(score),expected);
assert.equal(estimateWorkload([cue(0,1)],1,{threshold:100}).operations,1,'100% uses the shared 90–100% weight when all scores are included');
assert.equal(estimateWorkload([cue(0,1)],1,{threshold:100,weights:{'90to100':4}}).operations,4);
const legacy={minutes:5,mode:'operations',weights:{under50:1,'50to60':6,'60to75':2,'75to90':1,'90to100':5}};
const snapshot=JSON.stringify(legacy),migrated=workloadOptions(legacy);
assert.deepEqual(migrated.weights,{under60:6,'60to70':2,'70to80':2,'80to90':1,'90to100':5});
assert.deepEqual(migrated.legacyWeights,legacy.weights,'original manual values are retained instead of silently discarded');
assert.deepEqual(workloadOptions(migrated),migrated,'migration is idempotent');assert.equal(JSON.stringify(legacy),snapshot);
assert.equal(workloadOptions({weights:{'75to90':2}}).weights['80to90'],2);
assert.equal(workloadOptions({weights:{'60to75':4}}).weights['70to80'],4);

result = estimateWorkload([cue(0), cue(300, null), cue(600, 1)], 1200, { minutes: 5 });
assert.deepEqual(result.segments.map(s => s.operations), [null, null, 0, 0]);
assert.deepEqual(result.segments.map(s => s.relative), [null, null, 0, 0]);
assert.equal(result.baseline, null); assert.equal(result.max, 0);
assert.equal(estimateWorkload([], 1200).segments.length, 0);
result = estimateWorkload([cue(305, .4), { start: -1, end: 2 }, cue(4, .5, 3)], 300, { minutes: 5 });
assert.equal(result.invalid, 2); assert.equal(result.total, 1);
assert.equal(result.segments[1].end, 307, 'subtitle duration is preserved even if media duration is shorter');
assert.throws(() => estimateWorkload([cue(0, .5)], 1e15), RangeError);

result = estimateWorkload([cue(0, .99), cue(300, .8), cue(600, .3)], 900, { minutes: 5, threshold: 100 });
assert.equal(result.segments[0].heat, 0);
assert.equal(result.segments[2].heat, 1);
assert.ok(result.segments[1].fraction > result.segments[0].fraction);
const large = Array.from({ length: 10000 }, (_, i) => cue(i * 2, .5));
assert.equal(estimateWorkload(large, 20000).total, 10000);
console.log('Workload forecast: confidence boundaries, thresholds, weights, normalization, missing data, segmentation, read-only data and large drafts passed');
