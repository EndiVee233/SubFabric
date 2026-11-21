// Exercise the actual editor timing methods without loading ArkUI.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require(path.join(process.env.DEVECO_HOME || 'D:/HarmonyOS/DevEcoStudio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript/lib/typescript.js'));
const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/ui/editor/EditorPage.ets'), 'utf8');
const names = ['adjustTimelineCue', 'finishTimelineDrag', 'selectTimingWord', 'updateTimingWord'];
const methods = names.map(name => {
  const start = source.indexOf(`  private ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf('\n  }', start) + 4;
  return source.slice(start, end);
}).join('\n');
class WordTiming {
  constructor(text, start, end, confidence = 0) { Object.assign(this, { text, start, end, confidence }); }
  clone() { return new WordTiming(this.text, this.start, this.end, this.confidence); }
}
const js = ts.transpile(`class Harness { ${methods} }`, { target: ts.ScriptTarget.ES2020 });
const Harness = new Function('WordTiming', `${js}; return Harness;`)(WordTiming);
const editor = new Harness();
const cue = { start: 2, end: 4, words: [new WordTiming('a', 2.1, 2.5)] };
editor.store = { cues: [cue, { start: 8, end: 9 }], saveCurrent: () => Promise.resolve() };
editor.playDuration = () => 10;
editor.cueSource = { setCues() {} };
editor.buildPreviewLines = () => {};
editor.refreshActiveCue = () => {};
editor.timelineDragCueIndex = 0;
editor.timelineDragOriginStart = 2;
editor.timelineDragOriginEnd = 4;
editor.adjustTimelineCue(cue, 0, -9);
assert.equal(editor.timelineDragLastDelta, -2);
assert.equal(cue.start, 2, 'drag preview must not mutate persisted cue');
editor.finishTimelineDrag(0);
assert.equal(cue.start, 0);
assert.equal(cue.end, 2);
assert(Math.abs(cue.words[0].start - 0.1) < 1e-9, 'shift word times with cue');
assert.equal(editor.timelineDragCueIndex, -1);
editor.timingWords = [new WordTiming('a', 0, 0.5), new WordTiming('b', 0.6, 1)];
editor.selectTimingWord(1);
editor.updateTimingWord(cue, true, 0.1);
assert.equal(editor.timingStart, 0.5, 'start cannot cross previous word');
editor.updateTimingWord(cue, false, 9);
assert.equal(editor.timingEnd, 2, 'end cannot leave cue');
assert.equal(cue.words.length, 1, 'word edits stay in draft until save');
editor.timelineDragCueIndex = 0;
editor.timelineDragOriginStart = 0;
editor.timelineDragOriginEnd = 2;
editor.adjustTimelineCue(cue, 0, 99);
assert.equal(editor.timelineDragLastDelta, 8, 'drag cannot leave media or cross next cue start');
console.log('Timeline timing: preview, bounds, duration, word shifting and draft isolation passed.');
