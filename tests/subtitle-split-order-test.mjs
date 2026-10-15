import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AssDoc, assPlainText } from '../editor/js/ass.js';
import * as karaoke from '../editor/js/karaoke.js';

// Execute the actual editor functions and actual ASS/karaoke writers. UI/API edges
// are inert; no project, filesystem save or media service is touched.
const source = fs.readFileSync(new URL('../editor/js/main.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
; SubFabricWordStyle: Default
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,53,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,3,2,20,20,120,1
Style: 中文字幕,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,2,2,10,10,125,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.00,中文字幕,Speaker,0,0,0,,甲乙丙丁戊己
Dialogue: 0,0:00:00.00,0:00:04.00,Default,Speaker,0,0,0,,One two three four five six.
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Next sentence.
Dialogue: 0,0:00:04.00,0:00:06.00,中文字幕,,0,0,0,,下一句
`;
for (const order of ['zh-top', 'en-top']) {
  const doc = new AssDoc(header);
  const english = doc.events.find(e => e.style === 'Default');
  const en = karaoke.sentenceFromEvent('Default', english, doc.format, 0, 4, english.text);
  en.words = [{w:'One',s:0,e:.2},{w:'two',s:.4,e:.6},{w:'three',s:1,e:1.3},{w:'four',s:1.7,e:2},{w:'five',s:2.3,e:2.8},{w:'six',s:3.2,e:4}];
  en.events = doc.replaceEvents(en.events, karaoke.buildWordSpecs(en));
  const chinese = doc.events.find(e => e.style === '中文字幕');
  const zh = karaoke.sentenceFromEvent('中文字幕', chinese, doc.format, 0, 4, chinese.text);
  const row = {zh,en,start:0,end:4};
  const words = JSON.parse(JSON.stringify(en.words));
  const identities = new Set(doc.events);
  const state = {format:'ass',assDoc:doc,assStyleTargets:{zh:'中文字幕',en:'Default'},kar:{wordStyle:'Default',sentences:[zh,en],rows:[row]},newRows:new Set(),itemByRef:new Map()};
  const context = vm.createContext({...karaoke,assPlainText,state,panel:{commitEdit(){},_splitPoint(){return {k:3,sp:14};}},
    assPlayer:{updateNow(){}},timeline:{touch(){}},Projects:null,toast(){},fmtTime:String,logOp(){},reconcileKaraoke(){},rebuildItemsAndLanes(){},selectItem(){}});
  vm.runInContext(['currentOrderInfo','applyZhEnOrder','applyAnchorSentence','applyWordSentence','appendSentence','stripLeadSpeakerTag','splitZhText','splitRowAt'].map(fn).join('\n'),context);
  doc.setStyleFields('中文字幕',{fontname:'User font',fontsize:61});
  vm.runInContext(`applyZhEnOrder('${order}')`,context);
  assert.ok(doc.events.every(e=>identities.has(e)), 'reorder preserves all object identities');
  context.item = {ref:row};
  vm.runInContext("splitRowAt(item, 'One two three four five six.', 14)",context);
  assert.equal(state.kar.rows.length,2);
  assert.equal(state.kar.rows[0].end,1.5);
  assert.equal(state.kar.rows[1].start,1.5);
  assert.deepEqual(state.kar.rows.flatMap(r=>r.en.words).map(w=>({...w})),words,'original uneven word times survive');
  function verifyOrder() {
    for (const r of state.kar.rows) {
      assert.equal(r.zh.events.length,1);
      assert.ok(r.en.events.every(ev=>order==='zh-top' ? ev.lineIdx<r.zh.events[0].lineIdx : ev.lineIdx>r.zh.events[0].lineIdx));
    }
  }
  verifyOrder();
  vm.runInContext(`applyZhEnOrder('${order}')`,context);
  verifyOrder();
  context.sent = state.kar.rows[1].zh;
  vm.runInContext("applyAnchorSentence(sent, 1.5, 4, '手工中文')",context);
  const serialized=doc.serialize(), reload=new AssDoc(serialized);
  assert.equal(reload.getStyle('中文字幕').fontname,'User font');
  assert.equal(reload.getStyle('中文字幕').fontsize,'61');
  assert.equal(reload.events.length,doc.events.length,'no orphan duplicate Dialogue lines');
  assert.equal(reload.events.filter(e=>e.style==='中文字幕').length,3);
  assert.ok(reload.events.some(e=>e.text==='手工中文'));
  assert.ok(reload.events.every(e=>e.start<e.end));
  const stale={...doc.events[0],lineIdx:0};
  for (const mutate of [()=>doc.setEventText(stale,'bad'),()=>doc.setEventTime(stale,0,2),()=>doc.setEventName(stale,'bad'),()=>doc.replaceEvents([doc.events[0],stale],[]),()=>doc.deleteEvents([doc.events[0],stale]),()=>doc.insertAfterEvent(stale)]) {
    assert.throws(mutate,/字幕事件已失效/);
    assert.equal(doc.serialize(),serialized,'rejected stale writes are atomic');
  }
}
// First overlapping pair is already correct; a later mixed pair must still fix.
const mixed=new AssDoc(header); mixed.orderDialoguesByStyle('Default');
const latter=mixed.events.filter(e=>e.start===4); const a=latter[0].lineIdx,b=latter[1].lineIdx;
[mixed.lines[a],mixed.lines[b]]=[mixed.lines[b],mixed.lines[a]];
const context=vm.createContext({state:{format:'ass',assDoc:new AssDoc(mixed.serialize()),assStyleTargets:{zh:'中文字幕',en:'Default'}},assPlayer:{updateNow(){}},timeline:null,Projects:null});
vm.runInContext(fn('currentOrderInfo')+'\n'+fn('applyZhEnOrder'),context);
assert.equal(vm.runInContext("applyZhEnOrder('zh-top')",context),true);
console.log('subtitle-split-order: real font/order/split/reorder/edit/reload, word times and stale-write protection passed');
