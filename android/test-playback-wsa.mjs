import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {connect,shell} from './cdp.mjs';

// Open an associated-media project first. All probes are read-only and bounded;
// in particular, an open-ended HTTP range must never become a full-file JS array.
const c=await connect(),checks=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rpc=(action,args={})=>c.evaluate(`androidRpc(${JSON.stringify(action)},${JSON.stringify(args)})`);
const baseline=await rpc('studioList');
let original;
async function until(expression,timeout=20000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await c.evaluate(expression);if(value)return value;await wait(100);}
 throw Error('Playback condition timed out: '+expression);
}
try{
 await until('!!__dbg.state.project?.id && !!__dbg.video.currentSrc');
 const project=await rpc('studioLoad',{id:await c.evaluate('__dbg.state.project.id')});
 assert.match(project.mediaId,/^[0-9a-f-]{36}$/);
 const size=Number(shell('shell','run-as','com.subfabric.android','stat','-c','%s','files/media/'+project.mediaId+'.media'));
 assert.ok(size>1024);
 original=await c.evaluate('({time:__dbg.video.currentTime,paused:__dbg.video.paused,muted:__dbg.video.muted})');
 await c.evaluate('__dbg.video.pause()');
 await c.evaluate(`window.__androidPlaybackProbe=async(range,limit,whole,path)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const url=path||('/api/media?path='+${JSON.stringify(project.mediaId)});
   const response=await fetch(url+(url.includes('?')?'&':'?')+'probe='+encodeURIComponent(range),{headers:range?{range}:{},cache:'no-store',signal:controller.signal});
   const reader=response.body.getReader(),parts=[];let length=0;
   try{for(;;){const chunk=await reader.read();if(chunk.done)break;
    if(whole&&length+chunk.value.length>limit)throw Error('Response exceeds requested byte range');
    const part=chunk.value.slice(0,limit-length);parts.push(part);length+=part.length;if(length>=limit&&!whole)break;
   }}finally{await reader.cancel();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
   return {status:response.status,length,headers:Object.fromEntries(response.headers),base64:btoa(String.fromCharCode(...bytes))};
  }finally{clearTimeout(timer);controller.abort();}
 }`);
 const raw=(start,count,file='files/media/'+project.mediaId+'.media')=>execFileSync(process.env.SUBFABRIC_ADB||'adb',['-s',process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526','exec-out','run-as','com.subfabric.android','dd','if='+file,'bs=1','skip='+start,'count='+count,'status=none'],{maxBuffer:128*1024,stdio:['ignore','pipe','ignore']});
 const offsets=[0,128,Math.floor(size/2),size-1024];
 for(const start of offsets){
  const count=Math.min(128,size-start),range=`bytes=${start}-${start+count-1}`;
  const response=await c.evaluate(`__androidPlaybackProbe(${JSON.stringify(range)},${count},true)`);
  assert.equal(response.status,206);assert.equal(response.length,count);
  assert.equal(response.headers['content-range'],`bytes ${start}-${start+count-1}/${size}`);
  assert.equal(response.headers['content-length'],String(count));
  assert.deepEqual(Buffer.from(response.base64,'base64'),raw(start,count));
  checks.push({check:'Exact closed range bytes, length and total size',start,count});
 }
 for(const [range,start,count,whole]of [[`bytes=${size-1024}-`,size-1024,1024,true],['bytes=-128',size-128,128,true],['bytes=128-',128,128,false]]){
  const response=await c.evaluate(`__androidPlaybackProbe(${JSON.stringify(range)},${count},${whole})`);
  assert.equal(response.status,206);assert.equal(response.length,count);
  assert.equal(response.headers['content-length'],String(size-start));
  assert.deepEqual(Buffer.from(response.base64,'base64'),raw(start,count));
  checks.push({check:whole?'Exact suffix or tail range':'Open-ended range prefix read and immediately cancelled',range});
 }
 const full=await c.evaluate('__androidPlaybackProbe(null,128,false)');assert.equal(full.status,200);assert.equal(full.headers['content-length'],String(size));assert.deepEqual(Buffer.from(full.base64,'base64'),raw(0,128));checks.push({check:'Full-file response has one correct total length; probe cancels after its prefix'});
 const alias=await c.evaluate(`__androidPlaybackProbe('bytes=128-255',128,true,${JSON.stringify('/media/'+project.mediaId)})`);assert.equal(alias.status,206);assert.deepEqual(Buffer.from(alias.base64,'base64'),raw(128,128));checks.push({check:'Legacy media URL shares correct nonzero byte-range transport'});
 if(project.hasAudio){
  const file='files/studio/'+project.id+'.audio.wav',audioSize=Number(shell('shell','run-as','com.subfabric.android','stat','-c','%s',file));
  for(const start of [0,audioSize-128]){const count=128,range=`bytes=${start}-${start+count-1}`,response=await c.evaluate(`__androidPlaybackProbe(${JSON.stringify(range)},${count},true,${JSON.stringify('/api/projects/'+project.id+'/audio')})`);
   assert.equal(response.status,206);assert.equal(response.headers['content-length'],String(count));assert.deepEqual(Buffer.from(response.base64,'base64'),raw(start,count,file));checks.push({check:'Generated WAV audio uses the same exact bounded range transport',start});
  }
 }
 await until('__dbg.video.readyState>=2 && !__dbg.video.error && __dbg.video.videoWidth>0');
 const media=await c.evaluate('({duration:__dbg.video.duration,width:__dbg.video.videoWidth,height:__dbg.video.videoHeight})');
 assert.ok(Number.isFinite(media.duration)&&media.duration>0);checks.push({check:'Original editor loads metadata and a decoded frame',...media});
 for(const target of [10,Math.min(180,media.duration*.5),media.duration*.72,media.duration-4]){
  await c.evaluate(`window.__sfSeek(${target})`);
  await until(`!__dbg.video.seeking && Math.abs(__dbg.video.currentTime-${target})<.2 && __dbg.video.readyState>=2`);
  assert.equal(await c.evaluate('__dbg.video.error'),null);
  checks.push({check:'Shared editor seek reaches a decoded frame',target});
 }
 await c.evaluate('window.__sfSeek(1)');await until('!__dbg.video.seeking && Math.abs(__dbg.video.currentTime-1)<.2');
 const before=await c.evaluate('({time:__dbg.video.currentTime,frames:__dbg.video.getVideoPlaybackQuality().totalVideoFrames,audio:__dbg.video.webkitAudioDecodedByteCount||0})');
 const play=await c.send('Runtime.evaluate',{expression:'document.getElementById("sf-play").click();true',awaitPromise:true,userGesture:true,returnByValue:true});
 assert.equal(play.exceptionDetails,undefined,JSON.stringify(play.exceptionDetails));
 await until('!__dbg.video.paused && !__dbg.video.error');
 await wait(1300);
 const after=await c.evaluate('({time:__dbg.video.currentTime,frames:__dbg.video.getVideoPlaybackQuality().totalVideoFrames,audio:__dbg.video.webkitAudioDecodedByteCount||0,paused:__dbg.video.paused,error:__dbg.video.error})');
 assert.equal(after.error,null);assert.equal(after.paused,false);assert.ok(after.time>before.time+.3);assert.ok(after.frames>before.frames);
 if(project.hasAudio)assert.ok(after.audio>before.audio,'Audio decoding must advance during playback');
 await c.evaluate('__dbg.video.pause()');checks.push({check:'Original play button advances the media clock and video/audio decoding',before,after});
 const sync=await c.evaluate('({video:__dbg.video.currentTime,list:__dbg.panel._playingT,duration:__dbg.timeline.duration,cursor:document.getElementById("tl-cursor-time").textContent})');
 assert.ok(Math.abs(sync.video-sync.list)<.2);assert.equal(sync.duration,media.duration);checks.push({check:'Subtitle list and timeline follow the real media clock and duration',...sync});
 if(/\.(ass|ssa)$/i.test(project.subtitleName||'')){
  await until('__dbg.assPlayer.ready');const cue=await c.evaluate('__dbg.state.items.find(s=>s.end>s.start+.1 && s.start<__dbg.video.duration)');
  if(cue){const target=cue.start+Math.min(.1,(cue.end-cue.start)/2);await c.evaluate(`window.__sfSeek(${target})`);await until(`!__dbg.video.seeking && Math.abs(__dbg.video.currentTime-${target})<.2`);
   const rendered=await until(`(()=>{const canvas=__dbg.assPlayer.instance?.canvas;if(!canvas)return false;const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let alpha=0;for(let i=3;i<data.length;i+=4)if(data[i])alpha++;return alpha>100?{alpha,time:__dbg.video.currentTime}:false;})()`);checks.push({check:'Real ASS subtitle pixels remain rendered after video seek',...rendered});
  }
 }

 const latest=await rpc('studioList');for(const prior of baseline){const current=latest.find(p=>p.id===prior.id);assert.equal(current?.revision,prior.revision,prior.id);assert.equal(current?.mediaId,prior.mediaId,prior.id);}
 checks.push({check:'All existing subtitle revisions and media associations preserved',projects:baseline.length});
 await fs.writeFile('android/out/playback-wsa-results.json',JSON.stringify({checks,projectId:project.id,mediaId:project.mediaId,bytes:size,preserved:baseline.length},null,2));
 console.log(JSON.stringify({passed:checks.length,bytes:size,duration:media.duration,preserved:baseline.length,checks},null,2));
}finally{
 if(original){await c.evaluate(`__dbg.video.pause();__dbg.video.muted=${original.muted};window.__sfSeek(${original.time});delete window.__androidPlaybackProbe`).catch(()=>{});if(!original.paused)await c.send('Runtime.evaluate',{expression:'__dbg.video.play().catch(()=>{})',awaitPromise:true,userGesture:true}).catch(()=>{});}
 c.close();
}
