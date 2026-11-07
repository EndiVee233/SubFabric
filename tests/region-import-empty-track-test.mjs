import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../editor/js/main.js',import.meta.url),'utf8');
const start=source.indexOf('function addRecognizedRow('),end=source.indexOf('\n}',start)+2;
const created=[];
const context=vm.createContext({
  state:{format:'ass',kar:{wordStyle:'Default',sentences:[{style:'中文字幕'}]},assDoc:{replaceEvents:(events,specs)=>specs}},
  hexToAss:()=> '123456',escAss:t=>t,
  appendSentence(style,start,end,text){created.push({style,start,end,text});return{text,events:[{}],words:[]};},
  buildWordSpecs:s=>s.words.map(w=>({...w})),recalcWords:()=>[],registerRecognizedRow:r=>r,
});
vm.runInContext(source.slice(start,end)+';globalThis.add=addRecognizedRow;',context);
let row=context.add({start:1,end:3,text:'Okay.',words:[{word:'Okay.',start:1.2,end:2.7}]});
assert.deepEqual(created.map(x=>x.style),['Default'],'an English-only import must not add a blank Chinese anchor');
assert.equal(row.zh,null);assert.equal(row.en.words[0].s,1.2);assert.equal(row.en.words[0].e,2.7);
created.length=0;row=context.add({start:4,end:5,zh:'你好'});
assert.deepEqual(created.map(x=>x.style),['中文字幕'],'a Chinese-only import must not add a blank English event');assert.equal(row.en,null);
created.length=0;row=context.add({start:6,end:8,zh:'你好',text:'Hello.'});
assert.deepEqual(created.map(x=>x.style),['中文字幕','Default']);assert.ok(row.zh&&row.en);
console.log('Region import: missing language stays absent; real word timings remain unchanged');

const removed=[],a={events:[{id:1},{id:2}]},b={events:[{id:3}]},keep={events:[{id:4}]};
const rowA={zh:a,en:b},rowB={zh:a},rowKeep={en:keep};
context.state.assDoc.deleteEvents=events=>removed.push(events);
context.state.kar.sentences=[a,b,keep];context.state.kar.rows=[rowA,rowB,rowKeep];context.state.newRows=new Set([rowA,rowKeep]);
const batchStart=source.indexOf('function removeAssItemsData('),batchEnd=source.indexOf('\n}',batchStart)+2;
vm.runInContext(source.slice(batchStart,batchEnd)+';globalThis.removeBatch=removeAssItemsData;',context);
context.removeBatch([{ref:rowA},{ref:rowB},{ref:rowA}]);
assert.equal(removed.length,1,'bulk removal calls document deletion/sorting once');
assert.equal(removed[0].length,3,'shared events are only deleted once');
assert.equal(context.state.kar.rows.length,1);assert.equal(context.state.kar.rows[0],rowKeep);
assert.equal(context.state.kar.sentences.length,1);assert.equal(context.state.kar.sentences[0],keep);
assert.equal(context.state.newRows.has(rowKeep),true);assert.equal(context.state.newRows.has(rowA),false);
console.log('Region import: large replacements batch event removal and preserve unrelated rows');
