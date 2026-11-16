import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect} from './cdp.mjs';

// Geometry audit of the real shared work pages, without changing projects or settings.
// --source previews current source CSS before rebuilding; omit it for installed-APK acceptance.
const c=await connect(),results=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const source=process.argv.includes('--source'),original=await c.evaluate(`({hash:location.hash,list:document.getElementById('home-view').dataset.list,tab:document.querySelector('#st-view .st-tab.active')?.dataset.stp})`);
const pages={dashboard:'dashboard-view',home:'home-view',new:'np-view',batch:'batch-view',settings:'st-view',storage:'storage-view',help:'sf-help'};
try{
 if(source){const css=await fs.readFile('android/app/src/main/assets/studio/android.css','utf8');await c.evaluate(`(()=>{const s=document.createElement('style');s.id='android-pages-source-test';s.textContent=${JSON.stringify(css)};document.head.append(s)})()`);}
 for(const [width,height]of [[320,480],[390,844],[626,998],[900,420],[1024,768]]){
  const phone=width<760||height<=500&&width<=1000;
  await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:phone});await wait(180);
  for(const [route,id]of Object.entries(pages)){
   await c.evaluate(`location.hash='#/${route}'`);await wait(route==='settings'?350:250);
   for(const variant of route==='settings'?['theme','models','translate','enhance','fetch','perf']:route==='home'?['grid','list']:['']){
    if(route==='settings')await c.evaluate(`document.querySelector('#st-view .st-tab[data-stp=${variant}]').click()`);
    if(route==='home')await c.evaluate(`document.getElementById('home-view').dataset.list=${JSON.stringify(variant)}`);
    await wait(120);
    const geometry=await c.evaluate(`(()=>{const p=document.getElementById(${JSON.stringify(id)}),r=p.getBoundingClientRect();return {hidden:p.hidden,page:{x:r.x,right:r.right,bottom:r.bottom,client:p.clientWidth,scroll:p.scrollWidth},outside:[...p.querySelectorAll('button,input,select,textarea,.st-card,.ws-panel,.stg-panel,.sf-settings-line')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&(r.left< -1||r.right>innerWidth+1)&&!e.closest('.sf-choice-menu,.sf-settings-swatches,.sf-settings-backgrounds')}).slice(0,12).map(e=>({id:e.id,cls:e.className,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right})),settings:${route==='settings'?`(()=>{const tabs=document.querySelector('#st-view .st-tabs'),body=document.querySelector('#st-view .st-body');return {display:getComputedStyle(tabs).display,tabs:tabs.getBoundingClientRect().toJSON(),body:body.getBoundingClientRect().toJSON(),groupLabels:[...tabs.querySelectorAll('.sf-settings-nav-label')].filter(e=>e.getClientRects().length).length,buttons:[...tabs.querySelectorAll('.st-tab')].map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))}})()`:'null'}}})()`);
    const label=`${width}x${height} ${route} ${variant}`;
    assert.equal(geometry.hidden,false,label);assert.ok(geometry.page.x>=-1&&geometry.page.right<=width+1,label+' page bounds');
    assert.ok(geometry.page.scroll<=geometry.page.client+1,label+' horizontal page overflow');
    assert.deepEqual(geometry.outside,[],label+' controls outside the viewport');
    if(geometry.settings){if(phone){assert.equal(geometry.settings.display,'grid',label);assert.equal(geometry.settings.groupLabels,0,label);assert.ok(Math.abs(geometry.settings.tabs.width-geometry.settings.body.width)<=1,label+' full-width body');assert.ok(geometry.settings.buttons.every(b=>b.height>=44&&b.width>=100),label+' readable touch categories');}else{assert.equal(geometry.settings.display,'flex',label);assert.ok(geometry.settings.body.x>geometry.settings.tabs.right,label+' desktop side navigation');}}
    results.push({width,height,route,variant,geometry});
   }
  }
 }
 await fs.writeFile('android/out/phone-pages-wsa-results.json',JSON.stringify({sourcePreview:source,passed:results.length,results},null,2));
 console.log(JSON.stringify({sourcePreview:source,passed:results.length,checks:'7 work pages, both library modes, all 6 settings categories; phone/landscape bounds and desktop tablet navigation'},null,2));
}catch(error){await fs.writeFile('android/out/phone-pages-wsa-failure.json',JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{
 await c.evaluate(`document.getElementById('android-pages-source-test')?.remove();document.getElementById('phone-review-style')?.remove();document.getElementById('home-view').dataset.list=${JSON.stringify(original.list)};${original.tab?`document.querySelector('#st-view .st-tab[data-stp=${original.tab}]')?.click();`:''}location.hash=${JSON.stringify(original.hash)}`).catch(()=>{});
 await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();
}
