import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {emptyAss} from './asr-doc.mjs';
import {connect} from './cdp.mjs';

const c=await connect(),checks=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=(a,p={})=>c.evaluate(`androidRpc(${JSON.stringify(a)},${JSON.stringify(p)})`);
await until('!!window.__dbg?.panel && !!window.androidReady');
const original=await c.evaluate('({hash:location.hash,tab:__dbg.panel._tab,time:__dbg.video.currentTime,paused:__dbg.video.paused,follow:__dbg.panel.followPlayback})');
const baseline=await rpc('studioList');let fixture;
async function until(expression,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const v=await c.evaluate(expression);if(v)return v;await wait(80);}throw Error('Timed out: '+expression);}
async function snapshot(){return c.evaluate(`(()=>{const p=__dbg.panel,i=p.filtered.indexOf(p.playingItem),e=p._cardElAt(i),list=p.listEl.getBoundingClientRect(),card=e?.getBoundingClientRect();return {idx:i,time:__dbg.video.currentTime,phone:document.body.classList.contains('android-phone'),width:p._hW,actualWidth:p.spacerEl.clientWidth,height:p._cardH(i),gap:p._gap||0,card:card?.toJSON(),list:list.toJSON(),scroll:p.listEl.scrollTop,userAgo:p._userScrollAt?performance.now()-p._userScrollAt:null,measurePending:p._measurePending?.size};})()`);}
function checkPosition(s,label){
 assert.ok(s.card,label+' playing card exists');assert.equal(s.width,s.actualWidth,label+' width cache');
 const height=Math.min(s.list.bottom, s.list.top+s.list.height)-s.list.top;
 const inset=Math.min(48,Math.max(8,height*.12),Math.max(0,height-s.card.height));
 assert.ok(s.card.top>=s.list.top-2,label+' top visible '+JSON.stringify(s));
 assert.ok(s.card.top<=s.list.top+inset+3,label+' upper visible anchor '+JSON.stringify(s));
 if(s.card.height<=height)assert.ok(s.card.bottom<=s.list.bottom+2,label+' bottom visible '+JSON.stringify(s));
 assert.ok(Math.abs(s.height-s.card.height-(s.idx===299?0:s.gap))<1,label+' measured card matches DOM '+JSON.stringify(s));
 checks.push({check:label,idx:s.idx,offset:s.card.top-s.list.top,available:height,cardHeight:s.card.height});
}
async function seek(time){await c.evaluate(`window.__sfSeek(${time})`);await until(`!__dbg.video.seeking&&Math.abs(__dbg.video.currentTime-${time})<.2`);await wait(180);}
try{
 const t=n=>`${Math.floor(n/3600)}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${(n%60).toFixed(2).padStart(5,'0')}`;
 let text=emptyAss;
 for(let i=0;i<300;i++){const a=t(i*2),b=t(i*2+1.9),en=`Caption ${i+1}. `+('A varied line to check actual wrapping and touch controls. '.repeat(i%37===0?25:i%9===0?5:1));text+=`Dialogue: 0,${a},${b},中文字幕,,0,0,0,,字幕跟随测试第 ${i+1} 句\nDialogue: 0,${a},${b},Default,,0,0,0,,${en}\n`;}
 fixture=await rpc('studioCreate',{project:{name:'Android phone follow fixture '+Date.now(),subtitleName:'follow.ass',text,originalText:text,mediaId:'',notes:[],oplog:[],createdAt:Date.now()}});
 await c.evaluate(`location.hash='#/project/${fixture.id}'`);await until(`__dbg.state.project?.id==='${fixture.id}'&&__dbg.state.items.length===300`);
 await c.evaluate(`document.querySelector('.ptab[data-tab=subs]').click();__dbg.panel.followPlayback=true;__dbg.panel._userScrollAt=0`);
 for(const [width,height]of [[1024,768],[626,998],[390,844],[320,650],[900,420],[626,998]]){
  await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await wait(250);
  for(const time of [0.5,296.5,302.5,310.5,598.5]){
   await seek(time);const s=await snapshot();
   if(width===1024){assert.equal(s.phone,false);assert.equal(s.width,s.actualWidth);assert.equal(await c.evaluate("document.getElementById('android-follow-tail').style.height"),'0px');checks.push({check:'Tablet keeps the shared follow layout',time});}
   else checkPosition(s,`${width}x${height} seek ${time}`);
  }
 }
 // Production subtitle-only preview clock isolates list following from media/network codecs.
 await seek(302.5);await c.evaluate('__dbg.panel._userScrollAt=0');
 await c.send('Runtime.evaluate',{expression:'__dbg.video.play()',awaitPromise:true,userGesture:true});
 const seen=new Set(),end=Date.now()+8500;
 while(Date.now()<end){await wait(180);const s=await snapshot();if(s.idx<0||seen.has(s.idx))continue;seen.add(s.idx);checkPosition(s,'Continuous preview-clock follow');}
 await c.evaluate('__dbg.video.pause()');assert.ok(seen.size>=4,'Playback must cross several captions');
 const position=await snapshot();await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:position.list.left+position.list.width/2,y:position.list.top+position.list.height/2,deltaX:0,deltaY:220});await wait(200);
 const manual=await snapshot();assert.ok(manual.userAgo!=null&&manual.userAgo<1000);
 await c.send('Runtime.evaluate',{expression:'__dbg.video.play()',awaitPromise:true,userGesture:true});await wait(2200);const held=await snapshot();assert.notEqual(held.idx,manual.idx);assert.equal(held.scroll,manual.scroll);checks.push({check:'Manual wheel scroll holds the reading position across caption changes during grace'});
 await wait(5100);checkPosition(await snapshot(),'Automatic follow resumes after the manual grace period');await c.evaluate('__dbg.video.pause()');
 await c.evaluate('__dbg.panel.followPlayback=false');const off=(await snapshot()).scroll;await seek(400.5);assert.equal((await snapshot()).scroll,off);checks.push({check:'Disabling auto-follow preserves the reading position during seek'});
 await c.evaluate('__dbg.panel.followPlayback=true;__dbg.panel.syncPlaying()');await wait(160);checkPosition(await snapshot(),'Re-enabled follow returns to upper visible anchor');
 await c.evaluate(`document.querySelector('.ptab[data-tab=settings]').click()`);await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await wait(150);await c.evaluate(`document.querySelector('.ptab[data-tab=subs]').click()`);await wait(250);checkPosition(await snapshot(),'Hidden-tab resize remeasures when returning to subtitles');
 await c.evaluate('__dbg.panel.startEdit(__dbg.panel.playingItem,0)');const edit=await c.evaluate('({text:__dbg.panel.editorEl.textContent,scroll:__dbg.panel.listEl.scrollTop})');await c.evaluate('__androidFollowPlaying(__dbg.panel,__dbg.panel.filtered.indexOf(__dbg.panel.playingItem),true)');assert.deepEqual(await c.evaluate('({text:__dbg.panel.editorEl.textContent,scroll:__dbg.panel.listEl.scrollTop})'),edit);await c.evaluate('__dbg.panel.cancelEdit()');checks.push({check:'Follow does not move or rewrite an active inline editor'});
 const latest=await rpc('studioList');for(const old of baseline){const p=latest.find(p=>p.id===old.id);assert.equal(p?.revision,old.revision,old.id);assert.equal(p?.mediaId,old.mediaId,old.id);}checks.push({check:'All original subtitle revisions and media associations preserved',projects:baseline.length});
 await fs.writeFile('android/out/phone-follow-wsa-results.json',JSON.stringify({checks,fixture:fixture.id,preserved:baseline.length,clock:'Real Android subtitle-only preview clock; not media playback validation'},null,2));console.log(JSON.stringify({passed:checks.length,fixture:fixture.id,preserved:baseline.length,checks},null,2));
}catch(error){await fs.writeFile('android/out/phone-follow-wsa-failure.json',JSON.stringify({error:error.stack,checks,snapshot:await snapshot().catch(()=>null)},null,2));throw error;}
finally{
 await c.evaluate(`__dbg.video.pause();location.hash=${JSON.stringify(original.hash)}`).catch(()=>{});await wait(600);
 await c.evaluate(`document.querySelector('.ptab[data-tab=${original.tab}]')?.click();__dbg.panel.followPlayback=${original.follow};window.__sfSeek(${original.time})`).catch(()=>{});
 await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();
}
