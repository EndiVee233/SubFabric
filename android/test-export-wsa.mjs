import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {connect} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';
import {AssDoc} from '../editor/js/ass.js';

// Requires a synthetic media import and a system-picked SubFabric-WSA-* Movies directory.
// No direct writes into the Android project store and no broad storage grants.
const fixture=JSON.parse(await fs.readFile(process.argv[2]||'android/out/export-fixture.json','utf8'));
assert.match(fixture.dir,/^SubFabric-WSA-/);
const adb=process.env.SUBFABRIC_ADB||'adb',device=process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526';
const ffmpeg=process.env.SUBFABRIC_TEST_FFMPEG||'ffmpeg',ffprobe=process.env.SUBFABRIC_TEST_FFPROBE||'ffprobe';
const out=path.resolve('android/out/export-acceptance-'+Date.now());await fs.mkdir(out,{recursive:true});
const shell=(...args)=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',maxBuffer:4*1024*1024}).trim();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let c=await connect();const results=[];
async function until(expression,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await c.evaluate(expression);if(value)return value;await wait(80);}throw new Error('Timed out: '+expression);}
async function reopen(){await wait(800);for(let n=0;;n++){try{c=await connect();break;}catch(error){if(n>20)throw error;await wait(200);}}await until('window.androidReady&&!!window.__dbg');}
async function create(name,subtitle=assFixture,mediaId=fixture.mediaId){
  const p=await c.evaluate(`androidStudio.create(${JSON.stringify(name)},${JSON.stringify(subtitle)},'export.ass')`);
  await c.evaluate(`androidStudio.update('${p.id}',{mediaId:'${mediaId}',mediaName:'SubFabric-export-source.mp4'})`);
  await c.evaluate(`location.hash='#/project/${p.id}'`);await until(`__dbg.state.project?.id==='${p.id}'&&__dbg.assPlayer.ready&&__dbg.video.videoWidth>0`);
  await c.evaluate('__subfabricFlushSave()');return p;
}
async function state(id){return c.evaluate(`androidRpc('videoStatus',{id:'${id}'})`);}
async function finish(id){return until(`androidRpc('videoStatus',{id:'${id}'}).then(j=>j.status!=='running'&&j.status!=='idle'&&j)`,90000);}
async function start(id,options){
  return c.evaluate(`fetch('/api/projects/${id}/export-video',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({kinds:['bilingual'],outDir:fixture.dir,codec:'h264',accel:'auto',quality:23,threads:2,...options}))}}).then(async r=>({status:r.status,job:await r.json()}))`);
}
async function pull(output,label){
  const doc=decodeURIComponent(new URL(output.uri).pathname.split('/document/')[1]);
  assert.ok(doc.startsWith('primary:Movies/'+fixture.dir+'/'));
  const file=path.join(out,label||output.path);shell('pull','/sdcard/'+doc.slice('primary:'.length),file);return file;
}
const hash=data=>createHash('sha256').update(data).digest('hex');
function probe(file){return JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));}
function frame(file,time){return execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxBuffer:4*1024*1024});}
function colors(bytes,upper=false){let white=0,green=0,sum=0;for(let y=upper?0:180;y<(upper?180:360);y++)for(let x=0;x<640;x++){const i=(y*640+x)*3,r=bytes[i],g=bytes[i+1],b=bytes[i+2];if(r>170&&g>170&&b>170)white++;if(g>100&&g>r*1.5&&g>b*1.5){green++;sum+=x;}}return {white,green,center:green?sum/green:0};}
try{
  await until('window.androidReady&&!!window.__dbg');
  if(!await c.evaluate(`__dbg.assPlayer.isFontAvailable('Roboto')`)){
    const font=execFileSync(adb,['-s',device,'exec-out','cat','/system/fonts/Roboto-Regular.ttf'],{maxBuffer:4*1024*1024});
    await c.evaluate(`__dbg.assPlayer.cacheFont('Roboto',new Blob([Uint8Array.from(atob('${font.toString('base64')}'),c=>c.charCodeAt(0))]),true)`);
  }
  assert.ok(assFixture.includes('Style: Default,Noto Sans CJK SC'));
  const p=await create('Android export '+Date.now(),assFixture.replace('Style: Default,Noto Sans CJK SC','Style: Default,Roboto'));
  const before=await c.evaluate(`androidStudio.load('${p.id}')`);
  // Use the production Android More action and shared export dialog.
  await c.evaluate(`[...document.querySelectorAll('#android-more>button')].find(b=>b.textContent==='导出视频').click()`);
  await until(`document.getElementById('sf-export-video')?.hidden===false&&document.getElementById('sf-ev-dir').value===${JSON.stringify(fixture.dir)}&&!document.getElementById('sf-ev-start').disabled`);
  assert.equal(await c.evaluate(`document.getElementById('sf-ev-dir').value`),fixture.dir);
  await c.evaluate(`document.getElementById('sf-ev-adv').open=true`);
  for(const width of [320,390,1024]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:705,deviceScaleFactor:1,mobile:false});await wait(180);
    const bounds=await c.evaluate(`['sf-ev-dir','sf-ev-start','sf-ev-quality','sf-ev-close'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,right:r.right,width:r.width}})`);
    assert.ok(bounds.every(b=>b.width>0&&b.x>=0&&b.right<=width+1),JSON.stringify({width,bounds}));
  }
  await c.send('Emulation.clearDeviceMetricsOverride');
  await c.evaluate(`['bilingual','raw','subtitle'].forEach(k=>{const el=document.getElementById('sf-ev-k-'+k);el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}))});document.getElementById('sf-ev-overwrite').checked=false;document.getElementById('sf-ev-start').click()`);
  const completed=await finish(p.id);assert.equal(completed.status,'done',completed.error);assert.equal(completed.outputs.length,3);
  const video=await pull(completed.outputs.find(o=>o.kind==='bilingual'),'bilingual.mp4'),raw=await pull(completed.outputs.find(o=>o.kind==='raw'),'raw.mp4'),sub=await pull(completed.outputs.find(o=>o.kind==='subtitle'),'subtitle.ass');
  const meta=probe(video);assert.equal(meta.streams.find(s=>s.codec_type==='video').width,640);assert.equal(meta.streams.find(s=>s.codec_type==='video').height,360);assert.ok(meta.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(meta.format.duration)-8)<.2);
  execFileSync(ffmpeg,['-v','error','-i',video,'-f','null','-']);
  const originalMedia=execFileSync(adb,['-s',device,'exec-out','run-as','com.subfabric.android','cat','files/media/'+fixture.mediaId+'.media'],{maxBuffer:16*1024*1024});assert.equal(hash(await fs.readFile(raw)),hash(originalMedia));
  const exportedDoc=new AssDoc(await fs.readFile(sub,'utf8'));assert.equal(exportedDoc.events.length,new AssDoc(before.text).events.length,'ASS download must not contain a sacrificial rendering-only event');
  const a=colors(frame(video,1.5)),b=colors(frame(video,2.7)),title=colors(frame(video,5.5),true);assert.ok(a.white>30&&a.green>10);assert.ok(b.green>10&&b.center>a.center+5);assert.ok(title.white>20);
  assert.equal((await c.evaluate(`androidStudio.load('${p.id}')`)).text,before.text);
  const nativeFonts=shell('shell','run-as','com.subfabric.android','ls','files/export-fonts');assert.match(nativeFonts,/[a-f0-9]{64}\.font/);
  results.push({check:'Production dialog at 320/390/1024px; MP4 fully decodes, audio and 8s duration preserved, Chinese/word highlight/positioned title are burned into actual frames, raw hash exact, ASS sentinel excluded',encoder:completed.encoder,frame1:a,frame2:b,title});
  await c.evaluate(`document.getElementById('sf-ev-dismiss').click()`);
  const previousHash=hash(await fs.readFile(sub));await start(p.id,{kinds:['subtitle']});const collision=await finish(p.id);assert.equal(collision.status,'error');assert.match(collision.error,/同名/);assert.equal(hash(await fs.readFile(await pull(completed.outputs.find(o=>o.kind==='subtitle'),'collision-preserved.ass'))),previousHash);
  const replacement=before.text+'\n; isolated export overwrite';await start(p.id,{kinds:['subtitle'],overwrite:true,subtitleText:replacement});const replaced=await finish(p.id);assert.equal(replaced.status,'done',replaced.error);assert.equal(await fs.readFile(await pull(replaced.outputs[0],'overwritten.ass'),'utf8'),replacement);
  results.push({check:'Existing file is preserved by default; explicit overwrite publishes the complete replacement'});
  const hevc=await create('Android HEVC export '+Date.now());const hevcCaps=await c.evaluate(`androidRpc('videoCapabilities',{id:'${hevc.id}'})`);
  if(hevcCaps.codecs.h265.software){await start(hevc.id,{codec:'h265',accel:'cpu'});const hevcDone=await finish(hevc.id);assert.equal(hevcDone.status,'done',hevcDone.error);assert.equal(probe(await pull(hevcDone.outputs[0],'hevc.mp4')).streams.find(s=>s.codec_type==='video').codec_name,'hevc');results.push({check:'Platform HEVC software encoding produces an actual decodable video'});}
  else{const unsupported=await start(hevc.id,{codec:'h265',accel:'cpu'});assert.equal(unsupported.status,500);assert.match(unsupported.job.error,/不支持/);results.push({check:'Unsupported HEVC software is explicitly rejected instead of invoking the crashing kvazaar encoder',skipped:'No platform HEVC software encoder in this WSA build'});}
  const cancel=await create('Android export cancel '+Date.now());await start(cancel.id,{codec:'av1',accel:'cpu'});
  await until(`androidRpc('videoStatus',{id:'${cancel.id}'}).then(j=>j.steps?.some(s=>/正在软件编码|正在编码/.test(s.message)))`);await c.evaluate(`androidRpc('videoCancel',{id:'${cancel.id}'})`);const stopped=await finish(cancel.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.outputs.length,0);results.push({check:'Cancellation during actual encoding publishes no partial file'});
  assert.ok(fixture.longMediaId,'Import the synthetic 40s clip for deterministic process-failure testing');
  const isolated=await create('Android isolated encoder failure '+Date.now(),assFixture,fixture.longMediaId);await start(isolated.id,{codec:'av1',accel:'cpu',threads:1});
  await until(`androidRpc('videoStatus',{id:'${isolated.id}'}).then(j=>j.steps?.some(s=>/正在软件编码|正在编码/.test(s.message)))`);
  const owner=await state(isolated.id);assert.ok(Number.isInteger(owner.pid)&&owner.pid>0);assert.notEqual(String(owner.pid),shell('shell','pidof','com.subfabric.android'));
  assert.ok(shell('shell','ps','-p',String(owner.pid),'-o','NAME').includes('com.subfabric.android:export'));
  await c.evaluate(`androidRpc('videoDebugCrash',{id:'${isolated.id}'})`);
  const isolatedFailure=await finish(isolated.id);assert.equal(isolatedFailure.status,'error');assert.match(isolatedFailure.error,/中断/);assert.equal(await c.evaluate('__dbg.state.project.id'),isolated.id);results.push({check:'Killing only the encoder process leaves the live editor and saved project intact'});
  const background=await create('Android background export '+Date.now());await start(background.id,{codec:'av1',accel:'cpu'});
  await until(`androidRpc('videoStatus',{id:'${background.id}'}).then(j=>j.steps?.some(s=>/正在软件编码|正在编码/.test(s.message)))`);
  await c.evaluate(`androidRpc('close',{})`);c.close();
  let bg;for(let i=0;i<300;i++){bg=JSON.parse(shell('exec-out','run-as','com.subfabric.android','cat','files/studio/'+background.id+'.export.json'));if(bg.status!=='running')break;await wait(150);}assert.equal(bg.status,'done',bg.error);
  shell('shell','am','start','-n','com.subfabric.android/.MainActivity');await reopen();const bgFile=await pull(bg.outputs[0],'background-av1.mp4');assert.equal(probe(bgFile).streams.find(s=>s.codec_type==='video').codec_name,'av1');results.push({check:'Foreground service completes AV1 encoding after the editor Activity and WebView are destroyed'});
  const killed=await create('Android interrupted export '+Date.now());await start(killed.id,{codec:'av1',accel:'cpu'});
  await until(`androidRpc('videoStatus',{id:'${killed.id}'}).then(j=>j.steps?.some(s=>/正在软件编码|正在编码/.test(s.message)))`);
  c.close();shell('shell','am','force-stop','com.subfabric.android');shell('shell','am','start','-n','com.subfabric.android/.MainActivity');await reopen();const interrupted=await state(killed.id);assert.equal(interrupted.status,'error');assert.match(interrupted.error,/中断/);assert.equal(interrupted.outputs.length,0);results.push({check:'Force-stop is reported as interrupted on cold reopen, never as completed'});
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify({projectId:p.id,completed,results},null,2));console.log(JSON.stringify({out,results},null,2));
}finally{await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();}
