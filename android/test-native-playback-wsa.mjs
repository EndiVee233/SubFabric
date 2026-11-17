import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect,shell} from './cdp.mjs';

const c=await connect(),wait=ms=>new Promise(r=>setTimeout(r,ms));
let original;
try{
  for(let i=0;i<100&&!await c.evaluate('!!window.androidNative');i++)await wait(100);
  original=await c.evaluate('({route:location.hash,time:__dbg.video.currentTime})');
  const fixture=JSON.parse(await fs.readFile('android/out/native-ui-wsa-results.json','utf8'));
  await c.evaluate(`androidNative.command({kind:'route',route:'#/project/${fixture.fixtureId}'})`);
  for(let i=0;i<100;i++){if(await c.evaluate(`__dbg.state.project?.id==='${fixture.fixtureId}'&&__dbg.video.readyState>=2`))break;await wait(100);}
  await c.evaluate('__dbg.video.pause();__dbg.video.currentTime=1');await wait(200);
  const before=await c.evaluate('({time:__dbg.video.currentTime,userActivation:navigator.userActivation.hasBeenActive})');
  let buttonBounds;
  async function tapPlayer(){
    if(!buttonBounds){
      shell('shell','uiautomator','dump','/sdcard/native-player-test.xml');const xml=shell('shell','cat','/sdcard/native-player-test.xml');
      const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>m[0]).find(s=>s.includes('content-desc="播放或暂停"'));
      assert.ok(node,'Actual Android playback Button');buttonBounds=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
    }
    // Dump waits for accessibility idle; doing that during an 8s clip can wait until it ends.
    const b=buttonBounds;shell('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));
  }
  await tapPlayer();await wait(900);const during=await c.evaluate('({time:__dbg.video.currentTime,paused:__dbg.video.paused,width:__dbg.video.videoWidth,frames:__dbg.video.webkitDecodedFrameCount,audio:__dbg.video.webkitAudioDecodedByteCount,error:__dbg.video.error?.message})');
  assert.equal(during.paused,false,JSON.stringify(during));assert.ok(during.time>before.time+.4);assert.equal(during.width,640);assert.ok(during.frames>0);assert.ok(during.audio>0);
  await tapPlayer();await wait(150);assert.equal(await c.evaluate('__dbg.video.paused'),true);
  await fs.writeFile('android/out/native-playback-wsa-results.json',JSON.stringify({before,during,nativePlayAndPause:true},null,2));console.log('Native Play/Pause advances real video/audio without a DOM gesture');
}finally{
  if(original){await c.evaluate(`__dbg.video.pause();location.hash=${JSON.stringify(original.route)}`).catch(()=>{});await wait(400);await c.evaluate(`__dbg.video.currentTime=${Number(original.time)||0}`).catch(()=>{});}
  c.close();
}
