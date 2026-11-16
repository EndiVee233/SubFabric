import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {connect} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';

const c=await connect(),wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];
const adb=process.env.SUBFABRIC_ADB||'adb',device=process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526';
const fixture=JSON.parse(await fs.readFile('android/out/export-fixture.json','utf8')),name='Android gallery '+Date.now();
const ev=s=>c.evaluate(s),rpc=(action,arg)=>ev(`androidRpc(${JSON.stringify(action)},${JSON.stringify(arg)})`);
const hash=b=>createHash('sha256').update(b).digest('hex');
async function until(expression,timeout=90000){for(const end=Date.now()+timeout;Date.now()<end;){const v=await ev(expression);if(v)return v;await wait(150);}throw Error('Timed out: '+expression);}
async function finish(id){const job=await until(`androidRpc('videoStatus',{id:'${id}'}).then(j=>['done','error','cancelled'].includes(j.status)&&j)`);await wait(450);return job;}
function read(uri){assert.match(uri,/^content:\/\/media\/external_primary\/video\/media\/\d+$/);return execFileSync(adb,['-s',device,'exec-out','content','read','--uri',uri],{maxBuffer:32*1024*1024});}
function info(uri){return execFileSync(adb,['-s',device,'shell','content','query','--uri',uri,'--projection','_display_name:relative_path:is_pending:_size'],{encoding:'utf8',maxBuffer:50000});}
let project;
try{
  await until('window.androidReady');await ev('__subfabricFlushSave()');
  project=await ev(`androidStudio.create(${JSON.stringify(name)},${JSON.stringify(assFixture)},'gallery.ass')`);await ev(`androidStudio.update('${project.id}',{mediaId:'${fixture.mediaId}',mediaName:'gallery-source.mp4'}).then(()=>{location.hash='#/project/${project.id}'})`);await until(`__dbg.state.project?.id==='${project.id}'&&__dbg.assPlayer.ready&&__dbg.video.videoWidth>0`);
  await ev('__subfabricFlushSave()');const before=await ev(`androidStudio.load('${project.id}')`);
  const source=execFileSync(adb,['-s',device,'exec-out','run-as','com.subfabric.android','cat',`files/media/${fixture.mediaId}.media`],{maxBuffer:32*1024*1024}),sourceHash=hash(source);
  await ev(`document.getElementById('btn-export').click()`);await until(`document.getElementById('android-mobile-sheet')?.open`);assert.deepEqual(await ev(`[...document.querySelectorAll('#android-mobile-sheet .android-mobile-sheet-body button')].map(b=>b.textContent)`),['导出字幕','导出视频']);
  await ev(`[...document.querySelectorAll('#android-mobile-sheet button')].find(b=>b.textContent==='导出视频').click()`);await until(`document.getElementById('sf-ev-dir')?.value==='相册 / SubFabric'&&!document.getElementById('sf-ev-start').disabled`);
  assert.equal(await ev(`document.getElementById('sf-ev-browse').hidden`),true);assert.equal(await ev(`document.getElementById('sf-ev-k-subtitle').closest('label').hidden`),true);
  for(const width of [320,390,1024]){await c.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});await wait(200);assert.ok(await ev(`['sf-ev-dir','sf-ev-start','sf-ev-close'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0&&r.x>=0&&r.right<=innerWidth+1})`));}results.push('Export opens a two-choice submenu and reuses the original responsive video dialog with the system album destination');
  await ev(`document.getElementById('sf-ev-k-bilingual').checked=true;document.getElementById('sf-ev-k-raw').checked=false;document.getElementById('sf-ev-codec').value='h264';document.getElementById('sf-ev-accel').value='cpu';document.getElementById('sf-ev-threads').value='2';document.getElementById('sf-ev-start').click()`);
  await until(`androidRpc('videoStatus',{id:'${project.id}'}).then(j=>j.status==='running'||j.status==='done')`);const encoded=await finish(project.id);assert.equal(encoded.status,'done',encoded.error);const output=encoded.outputs[0];assert.equal(output.gallery,true);const metadata=info(output.uri);assert.match(metadata,/relative_path=Movies\/SubFabric\//);assert.match(metadata,/is_pending=0/);
  const bytes=read(output.uri);assert.equal(bytes.length,output.bytes);const file='android/out/gallery-encoded.mp4';await fs.writeFile(file,bytes);const probe=JSON.parse(execFileSync(process.env.SUBFABRIC_TEST_FFPROBE||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));assert.ok(probe.streams.some(s=>s.codec_name==='h264'&&s.codec_type==='video'));assert.ok(Number(probe.format.duration)>1);results.push('Actual ASS H.264 encoding publishes a complete, readable, non-pending MediaStore video in Movies/SubFabric');
  await ev('androidBack()');let firstRaw;
  for(let n=0;n<2;n++){
    await ev(`fetch('/api/projects/${project.id}/export-video',{method:'POST',body:JSON.stringify({kinds:['raw'],outDir:'相册 / SubFabric',overwrite:true})}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error)})`);const job=await finish(project.id);assert.equal(job.status,'done',job.error);const raw=job.outputs[0];assert.equal(hash(read(raw.uri)),sourceHash);assert.match(info(raw.uri),/is_pending=0/);if(firstRaw){assert.notEqual(raw.uri,firstRaw.uri);assert.equal(hash(read(firstRaw.uri)),sourceHash);}else firstRaw=raw;
  }results.push('Raw video copy reaches the album byte-for-byte; exporting the same name again creates a new item and preserves the first');
  const invalid=await rpc('videoStart',{id:project.id,options:{kinds:['subtitle'],destination:'gallery',outDir:'相册 / SubFabric'}}).then(()=>false,e=>/字幕/.test(e.message));assert.equal(invalid,true);results.push('Native album publication rejects subtitle files; subtitles remain a system file-save workflow');
  const long=await ev(`androidStudio.create('Android gallery cancel '+Date.now(),${JSON.stringify(assFixture)},'cancel.ass')`);await ev(`androidStudio.update('${long.id}',{mediaId:'${fixture.longMediaId}',mediaName:'cancel.mp4'})`);
  await ev(`fetch('/api/projects/${long.id}/export-video',{method:'POST',body:JSON.stringify({kinds:['bilingual'],outDir:'相册 / SubFabric',codec:'h264',accel:'cpu',threads:1})}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error)})`);await until(`androidRpc('videoStatus',{id:'${long.id}'}).then(j=>j.steps?.some(s=>s.status==='running'&&s.pct<90))`);await rpc('videoCancel',{id:long.id});const stopped=await finish(long.id);assert.equal(stopped.status,'cancelled',stopped.error);assert.equal(stopped.outputs.length,0);results.push('Cancelling a video task before publication leaves no completed album output');
  assert.equal((await ev(`androidStudio.load('${project.id}')`)).text,before.text);assert.equal(sourceHash,hash(execFileSync(adb,['-s',device,'exec-out','run-as','com.subfabric.android','cat',`files/media/${fixture.mediaId}.media`],{maxBuffer:32*1024*1024})));results.push('Export and cancellation retain exact source media and the original saved ASS');
  await fs.writeFile('android/out/gallery-wsa-results.json',JSON.stringify({projectId:project.id,output,firstRaw,results},null,2));console.log(JSON.stringify(results,null,2));
}catch(error){await fs.writeFile('android/out/gallery-wsa-failure.json',JSON.stringify({projectId:project?.id,error:error.stack,results},null,2));throw error;}
finally{await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();}
