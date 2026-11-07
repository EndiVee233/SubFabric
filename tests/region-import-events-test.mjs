import assert from 'node:assert/strict';
import { AssDoc } from '../editor/js/ass.js';
import { groupAssRows } from '../editor/ass-group.js';
import { attachImportEvents, stageAssLogMerge } from '../editor/js/log-import.js';
import { planRegionMerge, resolveReplace, eventsForReplacement } from '../editor/region-merge.js';
import { makeSyntheticAss } from './ass-fixture.mjs';

const doc=new AssDoc(makeSyntheticAss());doc.deleteEvents(doc.events.slice());
for(const spec of [
  {start:0,end:2,style:'中文字幕',text:'[A] 多行内容'},
  {start:0,end:2,style:'Default',text:'First line.'},
  {start:0,end:2,style:'Default',text:'Second line.'},
  {start:4,end:5,style:'Default',text:'{\\c&H00FF00&}嗯okay{\\c}'},
  {start:4,end:5,style:'中文字幕',text:'[A] 好的'},
])doc.appendEvent(spec);
const grouped=groupAssRows(doc.events),cues=attachImportEvents(grouped.lines,doc);
assert.equal(cues.length,2);assert.ok(cues.every(c=>c.importEvents.length));
assert.equal(cues[0].importEvents.length,3,'a grouped multi-line cue keeps both source English events and its anchor');
const existing=new AssDoc(makeSyntheticAss()),outside=existing.events.filter(e=>e.start>5).map(e=>existing.lines[e.lineIdx]);
const plan=planRegionMerge(cues,[{start:0,end:.3},{start:.3,end:2},{start:4,end:5}],0,5),result=resolveReplace(plan);
assert.ok(result.add.every(c=>c.importEvents?.length),'planning retains original event associations');
const replacement=eventsForReplacement(existing.events,result.replace);
const next=stageAssLogMerge(existing,replacement,result.add,{zh:'中文字幕',en:'Default'});
for(const line of outside)assert.ok(next.lines.includes(line),'outside source lines are preserved');
assert.ok(next.events.some(e=>e.text==='First line.'));assert.ok(next.events.some(e=>e.text==='Second line.'));
assert.equal(eventsForReplacement([{start:1,end:2}],[]).length,0);
const a={start:0,end:.5},orphan={start:.5,end:1},b={start:1,end:2},keep={start:3,end:4};
assert.deepEqual(eventsForReplacement([a,orphan,b,keep],[{start:0,end:2}]),[a,orphan,b]);
assert.deepEqual(eventsForReplacement([a,orphan,b,keep],[{start:1,end:2},{start:0,end:1}]),[a,orphan,b]);
assert.deepEqual(eventsForReplacement([keep],[{start:0,end:3}]),[],'touching a boundary is not overlap');
console.log('Region import events: stable source associations, multi-line groups, complete collision replacement and outside-event preservation passed');
