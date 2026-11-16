import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {connect} from './cdp.mjs';
// Layout/readiness only. This script does not start recognition or download a model.
const fixture=JSON.parse(await fs.readFile('android/out/asr-wsa-results.json','utf8')).created[0];
const source=process.argv.includes('--source');
const c=await connect(),results=[],wait=ms=>new Promise(r=>setTimeout(r,ms)),ev=s=>c.evaluate(s);
const original=await ev('({hash:location.hash,tab:document.querySelector("#st-view .st-tab.active")?.dataset.stp})');
async function inspect(selector,label){
 const state=await ev(`(()=>{const p=document.querySelector(${JSON.stringify(selector)}),r=p.getBoundingClientRect();return {hidden:p.hidden,page:{x:r.x,right:r.right,client:p.clientWidth,scroll:p.scrollWidth},outside:[...p.querySelectorAll('button,input,select,textarea,.st-card,.ws-panel,.sf-asr-family')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&(r.x< -1||r.right>innerWidth+1)&&!e.closest('.sf-choice-menu')}).map(e=>({id:e.id,cls:e.className,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right}))}})()`);
 assert.equal(state.hidden,false,label);assert.ok(state.page.x>=-1&&state.page.right<=await ev('innerWidth')+1,label+' page bounds');assert.ok(state.page.scroll<=state.page.client+1,label+' horizontal overflow '+JSON.stringify(state));assert.deepEqual(state.outside,[],label+' control bounds');return state;
}
try{
 if(source){const css=await fs.readFile('android/app/src/main/assets/studio/android.css','utf8');await ev(`(()=>{const s=document.createElement('style');s.id='android-asr-pages-source-test';s.textContent=${JSON.stringify(css)};document.head.append(s)})()`);}
 for(const [width,height]of [[320,480],[390,844],[626,998],[900,420],[1024,768]]){
  await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<760||height<=500});await wait(160);
  await ev(`location.hash='#/settings'`);await wait(400);await ev(`document.getElementById('sf-settings-tab-models').click();document.getElementById('sf-asr-back')?.click()`);await wait(120);
  const tile=await ev(`(()=>{const e=document.getElementById('android-parakeet-tile');return {text:e?.textContent,visible:!!e?.getClientRects().length,height:e?.getBoundingClientRect().height}})()`);assert.equal(tile.visible,true);assert.match(tile.text,/Parakeet/);assert.ok(tile.height>=44);results.push({width,height,check:'Parakeet tile',geometry:await inspect('#st-view','model catalog')});
  await ev(`document.getElementById('android-parakeet-tile').click()`);await wait(180);
  assert.equal(await ev(`document.getElementById('sf-asr-detail').hidden`),false);assert.equal(await ev(`document.getElementById('st-models').closest('.st-card').hidden`),false);
  const model=await ev(`({ready:document.getElementById('android-model-state').textContent,download:document.getElementById('android-model-download').getBoundingClientRect().toJSON(),local:document.getElementById('android-model-import').getBoundingClientRect().toJSON()})`);if(width<760||height<=500)assert.ok(model.download.height>=44&&model.local.height>=44);results.push({width,height,check:'Parakeet model detail',geometry:await inspect('#st-view','model detail'),model});
  await ev(`location.hash='#/new'`);await wait(400);await ev(`document.getElementById('np-mode-draft').click()`);await wait(500);
  const form=await ev(`({models:[...document.getElementById('np-model-sel').options].map(o=>({value:o.value,text:o.textContent})),word:document.getElementById('np-word').checked,blocked:['np-align','np-speakers','np-autopost'].map(id=>({id,disabled:document.getElementById(id).disabled,checked:document.getElementById(id).checked})),confidence:document.getElementById('np-confidence').value,stop:!!document.getElementById('android-asr-stop')?.isConnected})`);
  assert.ok(form.models.some(m=>m.value==='parakeet-tdt-0.6b-v2-android'));assert.equal(form.word,true);assert.ok(form.blocked.every(e=>e.disabled&&!e.checked));assert.equal(form.confidence,'off');assert.equal(form.stop,true);results.push({width,height,check:'New Parakeet draft defaults',geometry:await inspect('#np-view','new draft'),form});
  await ev(`location.hash='#/details/${fixture}'`);await wait(650);results.push({width,height,check:'Actual completed Parakeet draft details',geometry:await inspect('#detail-view','draft details')});
 }
 await fs.writeFile('android/out/phone-asr-pages-wsa-results.json',JSON.stringify({sourcePreview:source,passed:results.length,fixture,results},null,2));console.log(JSON.stringify({sourcePreview:source,passed:results.length,fixture,checks:'Parakeet tile/detail, new draft defaults and actual completed draft detail at five sizes'},null,2));
}catch(error){await fs.writeFile('android/out/phone-asr-pages-wsa-failure.json',JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{await ev(`document.getElementById('android-asr-pages-source-test')?.remove();${original.tab?`document.querySelector('#st-view .st-tab[data-stp=${original.tab}]')?.click();`:''}location.hash=${JSON.stringify(original.hash)}`).catch(()=>{});await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();}
