import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AssDoc } from '../editor/js/ass.js';
import { groupAssRows } from '../editor/ass-group.js';
import { parseChangeLog, changedCues, captureLogScope, localProtection, planLogImport,
  resolveLogImport, attachImportEvents, stageAssLogMerge } from '../editor/js/log-import.js';

const cue = (start, end, text = '字幕') => ({ start, end, lines: [text] });
const cutoff = Date.parse('2026-10-01T00:00:00Z');
const record = (sec, ops) => JSON.stringify({ created_ts: cutoff / 1000 + sec, ops });
const rows = [cue(1, 3, '第一句'), cue(5, 7, '第二句'), cue(10, 12, '[甲] 第三句')];
{
  const source = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
  const row = { start: 1, end: 3 }, item = { no: 1, start: 1, end: 3 }, timeline = {}, logs = [];
  const context = vm.createContext({ timeline, state: { format: 'srt', itemByRef: new Map([[row, item]]) },
    logOp: (...args) => logs.push(args), reconcileKaraoke: () => 0, rebuildItemsAndLanes() {}, toast() {} });
  vm.runInContext(source.slice(source.indexOf('const opRetimeOrigins ='), source.indexOf('/** 整句样式', source.indexOf('const opRetimeOrigins ='))), context);
  timeline.onRetime(row, 2, 4, false, false); assert.equal(logs.length, 0);
  timeline.onRetime(row, 5, 7, true, false);
  assert.deepEqual(JSON.parse(JSON.stringify(logs[0][4].ranges)), [{ start: 1, end: 3 }, { start: 5, end: 7 }]);
  timeline.onRetime(row, 6, 8, true, false);
  assert.deepEqual(JSON.parse(JSON.stringify(logs[1][4].ranges)), [{ start: 5, end: 7 }, { start: 6, end: 8 }]);
}
{
  const log = parseChangeLog([record(0, [{ op: 'text_set', old_start: 1, old_end: 3 }]),
    record(1, [{ op: 'text_set', old_start: 5, old_end: 7 }])].join('\n'));
  assert.deepEqual(changedCues(rows, log, cutoff).items.map(c => c.start), [5], 'cutoff is modification date, strictly after');
  assert.deepEqual(changedCues(rows, log, cutoff + 2000).items, []);
  const moved = parseChangeLog(record(1, [{ op: 'subtitle_time_adjust', group_uuid: 'g', old_start: 1, old_end: 3, new_start: 5, new_end: 7 }])
    + '\n' + record(2, [{ op: 'text_set', group_uuid: 'g', old_start: 5, old_end: 7 }]));
  assert.deepEqual(changedCues(rows, moved, cutoff).items.map(c => c.start), [5], 'historical positions do not select untouched nearby rows');
  const movedPlan = planLogImport(changedCues(rows, moved, cutoff).items, [cue(1, 3, '本稿也改过')],
    { ranges: [{ start: 1, end: 3 }], unknown: 0 });
  assert.equal(movedPlan[0].current.length, 1, 'keep original locations through later edits of the same stable group');
  assert.equal(movedPlan[0].protected, true, 'a moved sentence cannot bypass a local edit at its old location');
  assert.equal(resolveLogImport(movedPlan).add.length, 0);
  const role = parseChangeLog(record(2, [{ op: 'role_color_replace', role: '甲' }]));
  assert.deepEqual(changedCues(rows, role, cutoff).items.map(c => c.start), [10]);
  const truncated = parseChangeLog(record(1, [{ op: 'text_set', old_start: 5, old_end: 7 }])
    + '\n' + JSON.stringify({ created_ts: cutoff / 1000 + 2, ops_truncated: true }));
  assert.equal(changedCues(rows, truncated, cutoff).unresolved, 1);
  assert.equal(changedCues(rows, truncated, cutoff).items[0].uncertain, true);
  const partialBatch = parseChangeLog(JSON.stringify({ created_ts: cutoff / 1000 + 2, ops_truncated: true,
    ops: [{ op: 'text_set', old_start: 5, old_end: 7 }] }));
  assert.equal(changedCues(rows, partialBatch, cutoff).unresolved, 1, 'a partially retained truncated batch is still incomplete');
  assert.throws(() => parseChangeLog(record(1, []) + '\ninvalid'), /第 2 行/);
  assert.throws(() => parseChangeLog('{"ops":[]}'), /修改时间/);
  assert.equal(parseChangeLog(record(1, [])).ops, 0, 'empty batches contain no edits');
}
{
  const scope = captureLogScope('第 2 条', '', '', [{ no: 2, start: 5, end: 7 }]);
  assert.deepEqual(scope, { version: 1, global: false, ranges: [{ start: 5, end: 7 }] });
  assert.equal(captureLogScope('全片重校对', '', '', []).global, true);
  assert.equal(localProtection([{ target: '第 2 条' }]).unknown, 1, 'mutable legacy row numbers do not authorize overwrite');
  assert.deepEqual(localProtection([{ target: '第 2 条 00:05.000~00:07.000' }]).ranges, [{ start: 5, end: 7 }]);
  const groups = planLogImport(rows, rows, localProtection([{ scope }]));
  assert.deepEqual(resolveLogImport(groups).add.map(c => c.start), [1, 10]);
  assert.deepEqual(resolveLogImport(groups).remove.map(c => c.start), [1, 10]);
  const conflict = groups.find(g => g.protected);
  conflict.keepIncoming.add(conflict.incoming[0].key);
  assert.equal(resolveLogImport(groups).remove.length, 2, 'keeping both never deletes protected text');
  conflict.keepCurrent.clear();
  assert.equal(resolveLogImport(groups).remove.length, 3, 'explicit per-side deletion is applied');
  const partial = planLogImport([cue(1, 2)], [cue(1, 3)], { ranges: [], unknown: 0 });
  assert.equal(partial[0].partial, true); assert.equal(resolveLogImport(partial).remove.length, 0);
  const many = planLogImport([cue(1, 2), cue(2, 3)], [cue(1, 3)], { ranges: [{ start: 1, end: 3 }], unknown: 0 });
  assert.equal(many.length, 1, 'split/merge overlaps are reviewed as one connected group');
  assert.equal(many[0].incoming.length, 2);
  assert.equal(resolveLogImport(planLogImport(rows, rows, { ranges: [], unknown: 1 })).add.length, 0);
}
{
  const header = '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: ZH,Arial,48\nStyle: EN,Arial,48\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const doc = new AssDoc(header + 'Dialogue: 0,0:00:01.00,0:00:03.00,ZH,Old,0,0,0,,旧字幕\n');
  const source = new AssDoc(header + 'Dialogue: 0,0:00:01.00,0:00:03.00,ZH,A,2,3,4,,{\\c&HFF8000&}[甲] 新字幕\n'
    + 'Dialogue: 1,0:00:01.00,0:00:01.70,EN,A,5,6,7,,{\\c&H00FF00&}one{\\c} two\n'
    + 'Dialogue: 1,0:00:01.70,0:00:02.20,EN,A,5,6,7,,one two\n'
    + 'Dialogue: 1,0:00:02.20,0:00:03.00,EN,A,5,6,7,,one {\\c&H00FF00&}two{\\c}\n');
  const grouped = groupAssRows(source.events), incoming = attachImportEvents(grouped.lines, source);
  assert.equal(incoming.length, 1); assert.equal(incoming[0].importEvents.length, 4);
  const before = doc.serialize();
  const next = stageAssLogMerge(doc, doc.events, incoming, { zh: 'ZH', en: 'EN' });
  assert.equal(doc.serialize(), before, 'staging is read-only until a complete document passes validation');
  assert.equal(next.events.length, 4); assert.equal(next.events[0].name, 'A');
  assert.equal(next.events[1].end, 1.7); assert.equal(next.events[2].start, 1.7, 'word gaps are copied without estimated timing');
  assert.equal(next.events[1]._rawParts[5], '5', 'source margins survive');
  assert.equal(next.events[0].text, source.events[0].text, 'role color survives');
  assert.throws(() => stageAssLogMerge(doc, doc.events, [cue(1, 3)], {}), /原始 ASS/);
  assert.equal(doc.serialize(), before, 'failed import does not delete any original events');
  const k = new AssDoc(header + 'Dialogue: 0,0:00:01.00,0:00:03.00,EN,A,0,0,0,,{\\kf70}one {\\k130}two\n');
  const kc = attachImportEvents([cue(1, 3, 'one two')], k);
  assert.equal(stageAssLogMerge(doc, [], kc, { en: 'EN' }).events.at(-1).text, k.events[0].text, 'k/kf remain original tags');
}
console.log('log-import: modification cutoff, moved identities, truncated logs, local protection, conflict choices and atomic ASS/word preservation passed');
