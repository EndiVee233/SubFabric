import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {connect} from './cdp.mjs';import {AssDoc} from '../editor/js/ass.js';import {analyzeKaraoke} from '../editor/js/karaoke.js';
const c=await connect(),results=[],created=[];
const ev=s=>c.evaluate(s),rpc=(a,p={})=>ev(`androidRpc(${JSON.stringify(a)},${JSON.stringify(p)})`);
const call=(p,method='GET',input={})=>ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},${method==='GET'?'':`body:${JSON.stringify(JSON.stringify(input))}`}}).then(async r=>({status:r.status,data:await r.json()}))`);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await wait(500);}throw Error('Timed out waiting for Parakeet');}
async function draft(media,extra={}){const r=await call('/api/projects','POST',{name:'Android Parakeet acceptance '+Date.now(),video:{path:media.id,name:media.title},draft:true,modelId:'parakeet-tdt-0.6b-v2-android',wordLevel:true,...extra});assert.equal(r.status,200,JSON.stringify(r));created.push(r.data.id);return r.data;}
async function finish(p){return until(async()=>{const r=await call('/api/projects/'+p.id+'/draft');assert.equal(r.status,200);if(r.data.draft.status==='running')return null;assert.equal(r.data.draft.status,'done',JSON.stringify(r.data.draft));return rpc('studioLoad',{id:p.id});});}
try{
 const baseline=(await rpc('studioList')).map(p=>({id:p.id,revision:p.revision}));
 const models=await call('/api/asr/status');assert.equal(models.data.models.length,2);assert.equal(models.data.aligners.length,1);assert.equal(models.data.ready,true,"Vulkan inference acceptance requires a compatible GPU; this WSA Dozen driver is blocked and CPU fallback is disabled");
 const verification=await rpc('asrStart',{kind:'model'});await assert.rejects(rpc('asrStart',{kind:'model'}),/已有/);await assert.rejects(rpc('pickModel'),/停止/);
 await until(async()=>{const job=await rpc('asrStatus',{id:verification.id});if(job.status==='running')return null;assert.equal(job.status,'done',JSON.stringify(job));return job;});results.push({check:'Existing model SHA verification, single task guard and import protection'});
 const samples=await rpc('list'),wav=samples.find(p=>p.title==='SubFabric-sample.wav'),mp4=samples.find(p=>p.title==='SubFabric-sample-multichunk.mp4');assert.ok(wav&&mp4,'Use the official isolated sample fixtures');
 for(const [media,style,engine]of [[wav,'color','parakeet'],[mp4,'k','parakeet'],[wav,'k','qwen']]){
  const p=await draft(media,{karaokeStyle:style,...(engine==='qwen'?{modelId:'qwen3-asr-0.6b-android',wordLevel:false,align:true}:{})});if(media===wav){await c.send('Page.reload');await wait(500);await until(()=>ev('window.androidReady'));}const done=await finish(p),task=await rpc('asrStatus',{id:done.draft.taskId});
  const text=task.result.cues.map(x=>x.text).join(' ');assert.match(text,/don't wish to see it any more/i);
  const doc=new AssDoc(done.text),kar=analyzeKaraoke(doc);assert.ok(kar.sentences.some(s=>s.words.length>2));
  assert.ok(task.result.cues.every(s=>s.end>s.start&&s.words.every(w=>w.end>w.start&&w.start>=s.start-.015&&w.end<=s.end+.015)));
  if(media===mp4)assert.ok(Math.max(...task.result.cues.map(s=>s.end))>20);
  results.push({check:engine==='qwen'?'Real Qwen Vulkan ASR + forced alignment → measured word ASS':media===wav?'Real Parakeet Vulkan WAV → color word ASS':'Real stereo MP4 → Parakeet Vulkan → k ASS',project:p.id,lines:task.result.cues.length,words:task.result.cues.reduce((n,s)=>n+s.words.length,0)});
 }
 const cancelled=await draft(mp4),original=await rpc('studioLoad',{id:cancelled.id});await call('/api/projects/'+cancelled.id+'/asr-cancel','POST');
 const cancelledState=await until(async()=>{const p=(await call('/api/projects/'+cancelled.id+'/draft')).data;return p.draft.status!=='running'&&p;});assert.equal(cancelledState.draft.status,'error');
 assert.equal((await rpc('studioLoad',{id:cancelled.id})).text,original.text);results.push({check:'Cancel preserves the unmodified draft and terminates the ASR service'});
 const guarded=await draft(wav),edited='1\n00:00:00,000 --> 00:00:01,000\nUser edit must survive\n';await rpc('studioUpdate',{id:guarded.id,patch:{text:edited}});
 await until(async()=>{const r=await call('/api/projects/'+guarded.id+'/draft');return r.data.draft.status!=='running'&&r.data;});assert.equal((await rpc('studioLoad',{id:guarded.id})).text,edited);results.push({check:'A concurrent document edit prevents completed recognition from replacing user text'});
 const base=created[0],range=await call('/api/projects/'+base+'/rerecognize','POST',{start:0,end:5});assert.equal(range.status,200,JSON.stringify(range));
 const recognized=await until(async()=>{const r=await call('/api/projects/'+base+'/reidentify');if(r.data.job?.status==='running')return null;assert.equal(r.data.job?.status,'done',JSON.stringify(r));return r.data.job;});assert.ok(recognized.segments.length);assert.ok(recognized.segments.every(s=>s.start>=0&&s.end<=5.015));results.push({check:'Editor interval rerecognition returns actual timed segments within the requested range'});
 const current=await rpc('studioList');for(const p of baseline)assert.equal(current.find(n=>n.id===p.id)?.revision,p.revision,p.id);
 await fs.writeFile('android/out/asr-wsa-results.json',JSON.stringify({results,created,preserved:baseline.length},null,2));console.log(JSON.stringify({results,preserved:baseline.length},null,2));
}finally{c.close();}
