/* 回归：字幕块首词不再显示多余的灰色逐词标记。 */
import assert from 'node:assert/strict';
import { hasVisibleWordMark } from './jsmod/timeline.js';

assert.equal(hasVisibleWordMark(0), false, '首词没有灰色逐词标记');
assert.equal(hasVisibleWordMark(1), true, '第二词保留逐词标记');
assert.equal(hasVisibleWordMark(2), true, '后续词保留逐词标记');
assert.equal(hasVisibleWordMark(-1), false, '非法负索引不显示标记');
assert.equal(hasVisibleWordMark('0'), false, '字符串首索引不显示标记');
assert.equal(hasVisibleWordMark('1'), true, '字符串后续索引保留标记');
console.log('6 passed, 0 failed');
