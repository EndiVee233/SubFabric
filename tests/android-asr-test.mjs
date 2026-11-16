import assert from 'node:assert/strict';
import {draftDocument,recognitionSegments} from '../android/asr-doc.mjs';
import {AssDoc} from '../editor/js/ass.js';
import {analyzeKaraoke} from '../editor/js/karaoke.js';
import {parseSRT} from '../editor/js/srt.js';

const result={cues:[{start:1,end:4,text:'Hello world again.',words:[{text:'Hello',start:1,end:1.6},{text:'world',start:1.8,end:2.5},{text:'again.',start:3,end:4}]}]};
for(const karaokeStyle of ['color','k']){
 const output=draftDocument(result,{karaokeStyle}),doc=new AssDoc(output.text),analysis=analyzeKaraoke(doc);
 assert.equal(output.subtitleName,'subtitle.ass');assert.equal(analysis.sentences.length,1);
 const sentence=analysis.sentences[0];assert.equal(sentence.text,'Hello world again.');
 assert.deepEqual(sentence.words.map(w=>[w.s,w.e]),[[1,1.6],[1.8,2.5],[3,4]]);
 assert.equal(doc.getScriptInfoComment('SubFabricWordStyle'),'Default');
}
const srt=draftDocument(result,{wordLevel:false}),cues=parseSRT(srt.text);
assert.equal(srt.subtitleName,'subtitle.srt');assert.equal(cues[0].lines[0],'Hello world again.');assert.equal(cues[0].start,1);
assert.throws(()=>draftDocument({cues:[]}),/没有识别到/);
assert.throws(()=>recognitionSegments({cues:[{start:3,end:1,text:'bad'}]}),/时间/);
assert.throws(()=>recognitionSegments({cues:[{...result.cues[0],words:[{text:'bad',start:2,end:10}]}]}),/词时间/);
const escaped=draftDocument({cues:[{start:0,end:1,text:'{\\pos(1,2)} hello',words:[]}]});
assert.ok(!escaped.text.includes('\\pos(1,2)'));assert.ok(escaped.text.includes('hello'));
console.log('Android Parakeet document: real word timing preserved in color/k ASS and SRT, invalid results rejected');
