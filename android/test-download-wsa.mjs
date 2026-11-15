import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {connect,shell} from './cdp.mjs';
const out=path.resolve('android/out/download-wsa');await fs.mkdir(out,{recursive:true});
const ffmpeg=process.env.SUBFABRIC_FFMPEG||'C:/Program Files/ffmpeg/bin/ffmpeg.exe';
const ffprobe=process.env.SUBFABRIC_FFPROBE||'C:/Program Files/ffmpeg/bin/ffprobe.exe';
const clip=path.join(out,'fixture.mp4');
execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=426x240:rate=15','-f','lavfi','-i','sine=frequency=660:sample_rate=44100','-t','8','-c:v','libx264','-preset','ultrafast','-c:a','aac','-movflags','+faststart',clip]);
execFileSync(ffmpeg,['-v','error','-y','-i',clip,'-vn','-c:a','copy',path.join(out,'fixture.m4a')]);
execFileSync(ffmpeg,['-v','error','-y','-i',clip,'-c','copy','-f','dash','-seg_duration','2',path.join(out,'fixture.mpd')],{cwd:out});
const data=await fs.readFile(clip),results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));let slow=false;
const server=http.createServer(async(req,res)=>{
 try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
  if(!/^[a-zA-Z0-9_.-]+$/.test(name)){res.writeHead(404).end();return;}
  const body=name==='slow.mp4'?data:await fs.readFile(path.join(out,name));
  const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||''),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;
  res.writeHead(range?206:200,{'Content-Type':name.endsWith('.mpd')?'application/dash+xml':name.endsWith('.mp4')?'video/mp4':'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${body.length}`}:{})});
  if(req.method==='HEAD'){res.end();return;}
  if(name==='slow.mp4'&&slow){for(let i=start;i<=end&&!res.destroyed;i+=8192){res.write(body.subarray(i,Math.min(end+1,i+8192)));await wait(70);}res.end();}else res.end(body.subarray(start,end+1));
 }catch{res.writeHead(404).end();}
});await new Promise(r=>server.listen(19488,'127.0.0.1',r));shell('reverse','tcp:19488','tcp:19488');
let c=await connect();const ev=expression=>c.evaluate(expression),rpc=(action,arg={})=>ev(`androidRpc(${JSON.stringify(action)},${JSON.stringify(arg)})`);
async function until(fn,timeout=35000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await wait(150);}throw new Error('Timed out');}
async function done(id){return until(async()=>{const j=await rpc('downloadStatus',{id});return j.status==='running'?false:j;},60000);}
async function start(url,kind='download'){await wait(400);return rpc('downloadStart',{kind,url:'http://127.0.0.1:19488/'+url,quality:'360'});}
async function reconnect(){await until(async()=>{try{c=await connect();return await ev('window.androidReady');}catch{return false;}},25000);}
const originalConfig=await rpc('downloadSettings');
try{
 await rpc('downloadSettings',{patch:{proxy:''}});
 const rt=await rpc('downloadStart',{kind:'runtime'});const runtime=await done(rt.id);assert.equal(runtime.status,'done',runtime.error);assert.equal(runtime.result.quickjs,true);results.push({check:'Embedded yt-dlp, EJS, QuickJS and TLS CA bundle',runtime:runtime.result});
 const probe=await start('fixture.mp4','probe'),parsed=await done(probe.id);assert.equal(parsed.status,'done',parsed.error);assert.ok(parsed.result.source.title);results.push({check:'Real HTTP media probe',source:parsed.result.source});
 const audio=await done((await start('fixture.m4a')).id);assert.equal(audio.status,'done',audio.error);assert.equal(audio.result.hasVideo,false);assert.equal(audio.result.hasAudio,true);results.push({check:'Audio-only native import is playable media without a false video track'});
 const downloaded=await done((await start('fixture.mp4')).id);assert.equal(downloaded.status,'done',downloaded.error);const id=downloaded.result.mediaId;
 const raw=execFileSync(process.env.SUBFABRIC_ADB||'adb',['-s',process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526','exec-out','run-as','com.subfabric.android','cat','files/media/'+id+'.media'],{maxBuffer:8*1024*1024});assert.equal(crypto.hash('sha256',raw),crypto.hash('sha256',data));results.push({check:'Progressive download publishes exactly the actual source bytes',bytes:raw.length});
 const dash=await done((await start('fixture.mpd')).id);assert.equal(dash.status,'done',dash.error);
 const merged=execFileSync(process.env.SUBFABRIC_ADB||'adb',['-s',process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526','exec-out','run-as','com.subfabric.android','cat','files/media/'+dash.result.mediaId+'.media'],{maxBuffer:8*1024*1024});const mergedFile=path.join(out,'merged.mp4');await fs.writeFile(mergedFile,merged);
 const metadata=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',mergedFile],{encoding:'utf8'}));assert.ok(metadata.streams.some(s=>s.codec_type==='video'));assert.ok(metadata.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(metadata.format.duration)-8)<.3);execFileSync(ffmpeg,['-v','error','-i',mergedFile,'-f','null','-']);results.push({check:'DASH video/audio downloaded separately, native FFmpeg merge fully decodes',duration:metadata.format.duration});
 await ev(`import('/studio/android-download.js').then(m=>m.showDownload({flush:()=>__subfabricFlushSave(),open:async id=>{location.hash='#/project/'+id},status:()=>{}}))`);
 for(const width of [320,390,1024]){await c.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:true});await wait(200);const bounds=await ev(`(()=>{const d=document.querySelector('.android-download-dialog'),r=d.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,scroll:d.scrollWidth,client:d.clientWidth,buttons:[...d.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height)}})()`);assert.ok(bounds.left>=0&&bounds.right<=width+1);assert.ok(bounds.scroll<=bounds.client+1);assert.ok(bounds.buttons.filter(x=>x>0).every(x=>x>=44));await fs.writeFile(path.join(out,'layout-'+width+'.png'),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
 await ev(`document.querySelector('[data-job="${downloaded.id}"] button:last-child').click()`);await until(()=>ev(`__dbg.state.project?.meta?.mediaId==='${id}'&&__dbg.assPlayer.ready`));const project=await ev('__dbg.state.project');await wait(1500);await ev('__subfabricFlushSave()');const before=await rpc('studioLoad',{id:project.id});assert.match(before.text,/\[Events\]/);assert.equal(before.mediaId,id);assert.ok((await rpc('studioList')).some(p=>p.id===project.id));results.push({check:'Production download dialog at phone/tablet widths creates a native ASS project, associates media and remains listed beside existing .export.json records',projectId:project.id});
 slow=true;
 const cancelled=await start('slow.mp4');await until(async()=>Number((await rpc('downloadStatus',{id:cancelled.id})).bytes)>0);await rpc('downloadCancel',{id:cancelled.id});assert.equal((await done(cancelled.id)).status,'cancelled');
 slow=false;await wait(600);await rpc('downloadRetry',{id:cancelled.id});const retry=await done(cancelled.id);assert.equal(retry.status,'done',retry.error);results.push({check:'Cancel during bytes transfer, retry same job safely publishes complete media'});
 slow=true;const crash=await start('slow.mp4');await until(async()=>Number((await rpc('downloadStatus',{id:crash.id})).bytes)>0);const mainPid=shell('shell','pidof','com.subfabric.android');await rpc('downloadDebugCrash',{id:crash.id});assert.equal((await done(crash.id)).status,'interrupted');assert.equal(shell('shell','pidof','com.subfabric.android'),mainPid);assert.equal((await rpc('studioLoad',{id:project.id})).text,before.text);results.push({check:'Downloader process death leaves editor and source ASS intact'});
 const background=await start('slow.mp4');await until(async()=>Number((await rpc('downloadStatus',{id:background.id})).bytes)>0);await rpc('close');c.close();const bg=await until(async()=>{const j=JSON.parse(shell('exec-out','run-as','com.subfabric.android','cat','files/download-jobs/'+background.id+'/job.json'));return j.status==='running'?false:j;},60000);assert.equal(bg.status,'done',bg.error);shell('shell','am','start','-n','com.subfabric.android/.MainActivity');await reconnect();results.push({check:'Actual foreground download completes after Activity/WebView destruction'});
 const cold=await start('slow.mp4');await until(async()=>Number((await rpc('downloadStatus',{id:cold.id})).bytes)>0);c.close();shell('shell','am','force-stop','com.subfabric.android');shell('shell','am','start','-n','com.subfabric.android/.MainActivity');await reconnect();assert.equal((await rpc('downloadStatus',{id:cold.id})).status,'interrupted');assert.equal((await rpc('studioLoad',{id:project.id})).text,before.text);results.push({check:'Cold interruption is recorded on reopen without damaging saved ASS or publishing partial media'});
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({results},null,2));console.log(JSON.stringify(results,null,2));
}catch(error){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{try{await rpc('downloadSettings',{patch:{proxy:originalConfig.proxy||''}});}catch{}c.close();shell('reverse','--remove','tcp:19488');server.closeAllConnections();server.close();}
