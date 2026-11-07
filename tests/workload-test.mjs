import assert from 'node:assert/strict';
import { confidenceBand, workloadOptions, estimateWorkload } from '../editor/js/workload.js';

const cue = (start, score, end = start + 2) => ({ start, end, confidence: score === undefined ? null : { score } });
const items = [cue(0, .49), cue(60, .5), cue(120, .6), cue(180, .75), cue(240, .9), cue(299, .999, 301),
  cue(300, 1), cue(350), cue(600, .5), cue(601, .7), cue(605, .8), cue(900, 1)];
const before = JSON.stringify(items);
let result = estimateWorkload(items, 1200, { minutes: 5 });
assert.equal(result.segments.length, 4);
assert.equal(result.total, 12); assert.equal(result.known, 11); assert.equal(result.unknown, 1);
assert.deepEqual(result.segments.map(s => s.operations), [17, 0, 11, 0]);
assert.deepEqual(result.segments[0].counts, [1, 1, 1, 1, 2, 0]);
assert.equal(result.segments[0].total, 6, 'cross-boundary sentence is counted in its starting segment once');
assert.equal(result.segments[1].total, 2, 'a start at exactly five minutes goes in the next segment');
assert.equal(result.baseline, 11); assert.equal(result.segments[2].relative, 1);
assert.equal(result.segments[0].relative, 17 / 11); assert.equal(result.segments[1].relative, 0);
assert.equal(result.belowThreshold, 7);

assert.deepEqual(estimateWorkload(items, 1200, { minutes: 5, threshold: 75 }).segments.map(s => s.operations), [15, 0, 9, 0]);
assert.deepEqual(estimateWorkload(items, 1200, { minutes: 5, threshold: 100 }).segments.map(s => s.operations), [19, 0, 11, 0]);
assert.equal(estimateWorkload(items, 1200, { minutes: 10 }).segments.length, 2);
result = estimateWorkload(items, 1200, { minutes: 20 });
assert.equal(result.segments.length, 1); assert.equal(result.segments[0].relative, 1);

result = estimateWorkload(items, 1200, { minutes: 5, weights: { under50: 1, '50to60': 6, '60to75': 2, '75to90': 1 } });
assert.deepEqual(result.segments.map(s => s.operations), [10, 0, 9, 0]);
assert.equal(JSON.stringify(items), before, 'forecasting never changes subtitle/confidence data');

const defaults = workloadOptions(null);
assert.equal(defaults.mode, 'relative'); assert.equal(defaults.minutes, 10); assert.equal(defaults.threshold, 90);
const invalid = workloadOptions({ minutes: 0, threshold: '90', mode: 'invalid', weights: { under50: 0, '50to60': 7, '60to75': 1.5 } });
assert.deepEqual(invalid, defaults);
assert.equal(workloadOptions({ mode: 'operations' }).mode, 'operations');
for (const score of [null, undefined, NaN, Infinity, -.01, 1.01, '.5']) assert.equal(confidenceBand(score), -1);
assert.equal(confidenceBand(0), 0); assert.equal(confidenceBand(.5), 1);
assert.equal(confidenceBand(.6), 2); assert.equal(confidenceBand(.75), 3);
assert.equal(confidenceBand(.9), 4); assert.equal(confidenceBand(1), 5);

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
