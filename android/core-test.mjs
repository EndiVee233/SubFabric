import assert from 'node:assert/strict';
import { validateCues, exampleCues, timelineEnd } from './app/src/main/assets/core.js';
import { parseSRT, serializeSRT } from '../editor/js/srt.js';

const original = exampleCues();
assert.equal(validateCues(original).length, 3);
const roundtrip = parseSRT(serializeSRT(original));
assert.deepEqual(roundtrip.map(({ start, end, lines }) => ({ start, end, lines })), original.map(({ start, end, lines }) => ({ start, end, lines })));
assert.equal(timelineEnd(original, NaN), 11.5);
assert.equal(timelineEnd([], Infinity), 1);
assert.throws(() => validateCues([{ start: 3, end: 2, lines: ['bad'] }]));
assert.throws(() => validateCues([{ start: NaN, end: 2, lines: [] }]));
assert.throws(() => validateCues([{ start: 0, end: 2, lines: [null] }]));
assert.throws(() => validateCues(Array(20001).fill(original[0])));
assert.equal(parseSRT('garbage').length, 0);
assert.equal(parseSRT('1\n00:00:01,999 --> 00:00:02,001\n中文 <script>not markup</script>\n')[0].lines[0], '中文 <script>not markup</script>');
console.log('Android subtitle guards + upstream SRT roundtrip: passed');
