import assert from 'node:assert/strict';
import { speakerColorOf } from '../editor/js/karaoke.js';
import { groupAssRows } from '../editor/ass-group.js';
import { planRegionMerge } from '../editor/region-merge.js';

const sentence = (text, extra = {}) => ({ events: [{ text }], words: [], ...extra });
assert.equal(speakerColorOf(sentence('{\\c&H00FF00&}[Boosfer] 好')), '#00ff00', 'green is a valid explicit speaker color');
assert.equal(speakerColorOf(sentence('{\\an8}{\\1c&H00FF00&}[Boosfer] 好')), '#00ff00', 'geometry and primary-color aliases retain role metadata');
assert.equal(speakerColorOf(sentence('{\\c&H112233&}{\\1c&H00ABCDEF&}[Role] 好')), '#efcdab', 'last leading primary color wins and alpha does not change RGB');
assert.equal(speakerColorOf(sentence('{\\c&H112233&}{\\c}[Role] 好')), null, 'reset primary color is not stale role evidence');
assert.equal(speakerColorOf(sentence('{\\c&H00FF00&}hello')), null, 'untagged default highlight green is not assigned to a character');
for (const text of ['{\\c&H00FF00&}Okay{\\c}.', '{\\an8}{\\1c&H00FF00&}Okay{\\1c}.', '{\\c&H123456&}Okay{\\c}.']) {
  assert.equal(speakerColorOf(sentence(text, { words: [{ w: 'Okay', s: 0, e: 1 }] })), null, 'word highlight is excluded by span structure');
}
assert.equal(speakerColorOf(sentence('{\\1c&H123456&\\2c&H00FF00&}{\\k100}[Boosfer] Okay', { karStyle: 'k' })), '#00ff00', 'k speaker color comes from the base channel');
assert.equal(speakerColorOf(sentence('{\\1c&H00FF00&\\2c&HABCDEF&}{\\k100}Okay', { karStyle: 'k' })), null, 'untagged k base color is not a character');
const row = (start, end, style, text) => ({ start, end, style, text });
const grouped = groupAssRows([
  row(0, 2, 'Chinese', '{\\an8}{\\c&H123456&}{\\1c&H00FF00&}[Boosfer] 好'),
  row(0, 1, 'Default', '{\\c&H00FF00&}Okay{\\c}. now'),
  row(1, 2, 'Default', 'Okay. {\\c&H00FF00&}now{\\c}'),
]);
assert.equal(grouped.lines[0].color.toLowerCase(), '#00ff00', 'grouping carries the original role color without substituting a palette');
assert.deepEqual(grouped.lines[0].words.map(w => w.word), ['Okay', 'now']);
assert.equal(planRegionMerge(grouped.lines, [], 0, 3).items[0].color.toLowerCase(), '#00ff00');
const solo = groupAssRows([row(4, 5, 'Default', '{\\an8}{\\1c&H00FF00&}[Boosfer] Okay.')]);
const planned = planRegionMerge(solo.lines, [], 3, 6).items[0];
assert.equal(planned.zh, '');
assert.equal(planned.en, '[Boosfer] Okay.');
assert.equal(planned.color.toLowerCase(), '#00ff00', 'English-only speaker color survives planning');
const highlightedRole = groupAssRows([row(7, 8, 'Default', '{\\c&H00FF00&}[Role]{\\c} Okay')]);
assert.equal(highlightedRole.lines[0].color, '', 'highlighting the visible name is not whole-line speaker-color evidence');
console.log('Role import color: green roles, primary aliases/overrides/reset, word-highlight exclusion, k base and monolingual planning passed');
