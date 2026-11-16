// Geometry and cancellation audit only. Uses an isolated ASS draft and never starts LLM/export/ASR jobs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';

const c=await connect(),ev=s=>c.evaluate(s),sleep=ms=>new Promise(r=>setTimeout(r,ms)),results=[];
const overlays=[['fr-overlay','.fr-box'],['adv-export-overlay','.rn-box'],['confirm-overlay','.rn-box'],['rim-overlay','.rn-box'],['op-range-overlay','.rn-box'],['role-new','.rn-box'],['pick-overlay','.pick-box'],['cue-text-overlay','.rn-box'],['fix-overlay','.fix-box'],['batch-draft-overlay','.rn-box'],['batch-item-overlay','.rn-box'],['glossary-overlay','.rn-box'],['reseg-overlay','.rn-box']];
const baseline=await ev('androidRpc("studioList")');
let project;
async function until(expression){for(let n=0;n<120;n++){if(await ev(expression))return;await sleep(100);}throw Error('Timed out: '+expression);}
function fits(g,width,height,label){assert.ok(g.right-g.x>50&&g.bottom-g.y>1,`${label} must be rendered`);assert.ok(g.x>=-.5&&g.right<=width+.5&&g.y>=-.5&&g.bottom<=height+.5,`${label} outside viewport: ${JSON.stringify(g)}`);assert.ok(g.scroll<=g.client+1,`${label} has horizontal overflow: ${JSON.stringify(g)}`);}
try{
 await ev('window.__subfabricFlushSave()');
 project=await ev(`androidStudio.create('Android dialog layout '+Date.now(),${JSON.stringify(assFixture)},'dialog-layout.ass')`);
 await ev(`location.hash='#/project/${project.id}'`);await until(`__dbg.state.project?.id==='${project.id}'&&__dbg.state.assDoc`);
 if(process.argv.includes('--source')){
  const css=await fs.readFile('android/app/src/main/assets/studio/android-dialogs.css','utf8');
  await ev(`(()=>{const s=document.createElement('style');s.id='android-dialog-audit-source';s.textContent=${JSON.stringify(css)};document.head.append(s)})()`);
  const js=await fs.readFile('android/app/src/main/assets/studio/android-dialogs.js','utf8');
  await ev(js.replace('export function closeTopDialog','window.dialogAuditClose = function closeTopDialog'));
 }else{
  await ev(`import('/studio/android-dialogs.js').then(m=>window.dialogAuditClose=m.closeTopDialog)`);
 }
 for(const [width,height]of [[320,480],[390,844],[626,998],[900,420]]){
  await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await sleep(250);
  for(const tab of ['subs','roles','settings','logs','workload']){
   await ev(`document.querySelector('#panel-tabs [data-tab="${tab}"]').click()`);await sleep(100);
   const g=await ev(`(()=>{const e=document.getElementById('tab-${tab}'),r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}})()`);fits(g,width,height,tab);results.push({width,height,panel:tab,...g});
  }
  for(const [id,box]of overlays){
   // Expose the actual production DOM without invoking recognition or paid services.
   await ev(`document.getElementById('${id}').hidden=false`);await sleep(260);
   const g=await ev(`(()=>{const e=document.querySelector('#${id} ${box}'),r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}})()`);fits(g,width,height,id);
   const touch=await ev(`(()=>{const e=document.getElementById('${id}');return [...e.querySelectorAll('button')].filter(b=>b.getClientRects().length&&getComputedStyle(b).display!=='none').map(b=>({id:b.id,height:b.getBoundingClientRect().height})).filter(b=>b.height<43.5)})()`);assert.deepEqual(touch,[],id+' buttons must be touch sized');
   results.push({width,height,overlay:id,...g});
   await ev(`document.getElementById('${id}').hidden=true`);
  }
 }
 // Reproduce an old desktop drag position, which must not strand a phone dialog outside the screen.
 await c.send('Emulation.setDeviceMetricsOverride',{width:320,height:480,deviceScaleFactor:1,mobile:true});await sleep(180);
 await ev(`(()=>{const e=document.querySelector('#confirm-overlay .rn-box');e.classList.add('modal-dragged');e.style.left='800px';e.style.top='600px';document.getElementById('confirm-overlay').hidden=false})()`);await sleep(80);
 const dragged=await ev(`(()=>{const e=document.querySelector('#confirm-overlay .rn-box'),r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,client:e.clientWidth}})()`);fits(dragged,320,480,'dragged dialog');
 await ev(`(()=>{const e=document.querySelector('#confirm-overlay .rn-box');e.classList.remove('modal-dragged');e.style.removeProperty('left');e.style.removeProperty('top');document.getElementById('confirm-overlay').hidden=true})()`);
 await ev(`__dbg.panel.showConfirm('Dialog layout test','Cancel must preserve this draft','Confirm','Cancel',()=>{window.dialogAuditApplied=true})`);await sleep(260);
 assert.equal(await ev('dialogAuditClose()'),true);assert.equal(await ev('document.getElementById("confirm-overlay").hidden'),true);assert.equal(await ev('!!window.dialogAuditApplied'),false);assert.equal(await ev('location.hash'),'#/project/'+project.id);
 await ev(`document.querySelector('#panel-tabs [data-tab=roles]').click();document.querySelector('#role-list .role-add').click()`);await sleep(260);assert.equal(await ev('document.getElementById("role-new").hidden'),false);assert.equal(await ev('dialogAuditClose()'),true);assert.equal(await ev('document.getElementById("role-new").hidden'),true);assert.equal(await ev('location.hash'),'#/project/'+project.id);
 const after=await ev('androidRpc("studioList")');for(const p of baseline)assert.equal(after.find(n=>n.id===p.id)?.revision,p.revision,'Existing draft changed: '+p.id);
 await fs.writeFile('android/out/phone-dialogs-wsa-results.json',JSON.stringify({project:project.id,passed:results.length+4,results},null,2));
 console.log(JSON.stringify({passed:results.length+4,existingUnchanged:baseline.length},null,2));
}catch(error){await fs.writeFile('android/out/phone-dialogs-wsa-failure.json',JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{
 await ev(`(()=>{for(const id of ${JSON.stringify(overlays.map(([id])=>id))})document.getElementById(id).hidden=true;document.getElementById('android-dialog-audit-source')?.remove();delete window.dialogAuditClose;delete window.dialogAuditApplied})()`).catch(()=>{});
 await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();
}
