import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect,shell} from './cdp.mjs';

const c=await connect(),ev=s=>c.evaluate(s),wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[];
async function until(s){for(let i=0;i<100;i++){const v=await ev(s);if(v)return v;await wait(80);}throw Error('Timed out: '+s);}
async function nodes(){
  shell('shell','uiautomator','dump','/sdcard/subfabric-motion-test.xml');let xml=shell('shell','cat','/sdcard/subfabric-motion-test.xml');
  if(!xml.includes('package="com.subfabric.android"')){shell('shell','am','start','-W','--activity-single-top','--activity-reorder-to-front','-n','com.subfabric.android/.MainActivity');shell('shell','uiautomator','dump','/sdcard/subfabric-motion-test.xml');xml=shell('shell','cat','/sdcard/subfabric-motion-test.xml');}
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2].replace(/&amp;/g,'&').replace(/&quot;/g,'"')])));
}
function bounds(node){assert.ok(node,'Native control exists');return node.bounds.match(/\d+/g).map(Number);}
function frames(){const s=shell('shell','dumpsys','gfxinfo','com.subfabric.android');const match=s.match(/Total frames rendered:\s*(\d+)/);assert.ok(match,'Hardware renderer frame counters');return Number(match[1]);}
let original,held;
try{
 await until('window.androidNative&&window.__androidSetMotion');original=await ev('({route:location.hash,time:__dbg.video.currentTime})');
 const before=await ev('androidStudio.rpc("studioList").then(rows=>rows.map(p=>({id:p.id,revision:p.revision,mediaId:p.mediaId,archived:!!p.archived})))');
 const allowed=await ev('SubFabric.animationsEnabled()');assert.equal(typeof allowed,'boolean');
 assert.equal(await ev('document.body.dataset.motion'),allowed?'on':'off');results.push('WebView motion follows the native Android animator policy instead of being forced off');
 await ev('androidNative.command({kind:"route",route:"#/dashboard"})');await wait(700);
 assert.ok(await ev('androidNative.snapshot().controls.some(n=>n.text==="新建稿件"&&n.tone==="primary")'));
 let list=await nodes();const button=list.find(n=>n.class==='android.widget.Button'&&n.text==='新建稿件'),idle=bounds(button),x=idle[0]+(idle[2]-idle[0])*.82,y=idle[1]+(idle[3]-idle[1])*.25;
 shell('shell','input','motionevent','DOWN',String(x),String(y));held={x,y};await wait(180);
 list=await nodes();const pressed=bounds(list.find(n=>n.class==='android.widget.Button'&&n.text==='新建稿件'));
 if(allowed)assert.notDeepEqual(pressed,idle,'Real native button tilts/scales while held');
 shell('shell','input','motionevent','CANCEL',String(x),String(y));held=null;await wait(550);
 assert.equal(await ev('location.hash'),'#/dashboard','Cancelled press must not navigate');
 const released=bounds((await nodes()).find(n=>n.class==='android.widget.Button'&&n.text==='新建稿件'));for(let i=0;i<4;i++)assert.ok(Math.abs(released[i]-idle[i])<=1,'Release restores original hit area');
 results.push('Real native pointer hold visibly changes button geometry; Cancel restores it without firing the action');
 shell('shell','dumpsys','gfxinfo','com.subfabric.android','reset');
 await ev('androidNative.command({kind:"route",route:"#/settings"})');await wait(800);
 const transitionFrames=frames();if(allowed)assert.ok(transitionFrames>=3,'Navigation draws intermediate native frames');
 await wait(3000);const start=frames();await wait(1200);const idleFrames=frames()-start;
 assert.ok(idleFrames<=4,'Settled work pages must not keep an animation frame loop alive');
 results.push(`Native navigation renders intermediate frames (${transitionFrames}); idle frame count over 1.2s is ${idleFrames}`);
 // No system setting is modified. Exercise the shared renderer's reduced-motion branch locally.
 await ev('__androidSetMotion(false)');assert.equal(await ev('document.body.dataset.motion'),'off');
 await ev(`__androidSetMotion(${allowed})`);assert.equal(await ev('document.body.dataset.motion'),allowed?'on':'off');
 results.push('Shared rendering can settle into reduced motion and restore the current system policy without changing OS settings');
 assert.deepEqual(await ev('androidStudio.rpc("studioList").then(rows=>rows.map(p=>({id:p.id,revision:p.revision,mediaId:p.mediaId,archived:!!p.archived})))'),before);
 results.push(`${before.length} existing drafts retain revision, media association and archive state`);
 await fs.writeFile('android/out/motion-wsa-results.json',JSON.stringify({allowed,idle,pressed,released,transitionFrames,idleFrames,results},null,2));console.log(JSON.stringify(results,null,2));
}catch(error){await fs.writeFile('android/out/motion-wsa-failure.json',JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{
 if(held)shell('shell','input','motionevent','CANCEL',String(held.x),String(held.y));
 if(original){await ev(`(async()=>{await androidNative.command({kind:'route',route:${JSON.stringify(original.route)}});__androidSetMotion(SubFabric.animationsEnabled());})()`).catch(()=>{});}
 c.close();
}
