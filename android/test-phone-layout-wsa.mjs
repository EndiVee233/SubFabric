import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';

let oldMode;
const c=await connect(),results=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ev=s=>c.evaluate(s);
async function until(expression){for(let n=0;n<100;n++){const v=await ev(expression);if(v)return v;await sleep(120);}throw Error('Timed out: '+expression);}
async function viewport(width,height){await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await sleep(350);}
async function library(){await ev('androidBack()');await until(`location.hash==='#/home'`);await sleep(300);}
async function open(id){
  await ev(`document.querySelector('#sf-search').value='';document.querySelector('#sf-search').dispatchEvent(new Event('input'));document.querySelector('#sf-filters [data-filter=all]').click()`);
  await until(`document.querySelector('#home-list [data-id="${id}"] .pc-open')`);
  await sleep(450);
  const hit=await ev(`(()=>{const b=document.querySelector('#home-list [data-id="${id}"] .pc-open');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b}})()`);
  assert.ok(hit.x>=0&&hit.x+hit.w<=await ev('innerWidth')&&hit.h>=43.5&&hit.w>=43.5&&hit.hit,JSON.stringify(hit));
  await ev(`document.querySelector('#home-list [data-id="${id}"] .pc-open').click()`);
  await until(`__dbg.state.project?.id==='${id}'&&__dbg.state.assDoc&&__dbg.assPlayer.ready`);
}
try{
  await until('window.androidReady');oldMode=await ev(`JSON.parse(localStorage.getItem('subfabric-studio-v1')).mode`);
  await ev(`__subfabricFlushSave();location.hash='#/home'`);await until(`location.hash==='#/home'`);
  const doc=assFixture+Array.from({length:25},(_,i)=>`Dialogue: 0,0:00:${String(9+i).padStart(2,'0')}.00,0:00:${String(10+i).padStart(2,'0')}.00,Default,,0,0,0,,Layout line ${i}\n`).join('');
  const p=await ev(`androidStudio.create('Android phone layout '+Date.now(),${JSON.stringify(doc)},'phone-layout.ass')`);
  // Refresh the real library rather than entering the editor via a test-only route.
  await ev(`location.hash='#/dashboard'`);await sleep(200);await ev(`location.hash='#/home'`);await sleep(500);
  await viewport(390,844);await open(p.id);await ev('__subfabricFlushSave()');const loaded=await ev(`androidStudio.load('${p.id}')`);await library();
  for(const [width,height]of [[320,480],[390,844],[626,998],[900,420]]){
    await viewport(width,height);
    const page=await ev(`(()=>{const h=document.getElementById('home-view').getBoundingClientRect(),t=document.querySelector('.sf-library-tools');return {x:h.x,w:h.width,scroll:t.scrollWidth,client:t.clientWidth,nav:[...document.querySelectorAll('#android-bottom-nav button')].map(b=>b.textContent)}})()`);
    assert.equal(page.x,0);assert.equal(page.w,width);assert.ok(page.scroll<=page.client+1,JSON.stringify(page));assert.deepEqual(page.nav,['主页','稿件','操作','更多']);
    await open(p.id);await sleep(350);
    const layout=await ev(`(()=>{const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}};return {video:box('video-stage'),stage:box('stage-wrap'),timeline:box('timeline-panel'),panel:box('editor-panel'),list:box('cue-list'),nav:getComputedStyle(document.getElementById('android-bottom-nav')).display,scroll:document.documentElement.scrollWidth,height:visualViewport.height}})()`);
    assert.equal(layout.nav,'none');assert.ok(Math.abs(layout.video.w/layout.video.h-16/9)<.002,JSON.stringify(layout));assert.ok(Math.abs(layout.panel.bottom-height)<=1,JSON.stringify(layout));assert.ok(layout.scroll<=width);assert.ok(layout.list.h>25);
    if(width<760){assert.equal(layout.video.x,0);assert.equal(layout.video.w,width);assert.ok(layout.timeline.y>=layout.stage.bottom-1);assert.ok(layout.panel.y>=layout.timeline.bottom-1);}
    await ev(`document.getElementById('android-editor-actions').click()`);assert.equal(await ev(`document.getElementById('android-mobile-sheet').open`),true);assert.ok(await ev(`[...document.querySelectorAll('#android-mobile-sheet button')].some(b=>b.textContent==='保存')`));await ev('androidBack()');
    await ev(`__dbg.video.currentTime=1.5`);await sleep(300);
    const pixels=await ev(`(()=>{const c=document.getElementById('timeline'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let transitions=0;for(let n=4;n<a.length;n+=4)if(a[n]!==a[n-4])transitions++;return transitions})()`);assert.ok(pixels>30,'Timeline must draw ruler and subtitle blocks');
    for(const tab of ['roles','settings','subs']){await ev(`document.querySelector('#panel-tabs [data-tab="${tab}"]').click()`);assert.equal(await ev(`document.getElementById('tab-${tab}').classList.contains('active')`),true);}
    results.push({width,height,...layout,timelineDrawn:true});await library();
  }
  await viewport(390,844);await ev(`document.querySelector('#sf-list-mode').click()`);await sleep(250);await open(p.id);await library();await ev(`document.querySelector('#sf-list-mode').click()`);
  await ev(`location.hash='#/dashboard'`);await sleep(200);assert.equal(await ev(`document.querySelector('#sf-uwp-youtube,#sf-mu-youtube,#sf-mu-temp')!==null`),false);
  await ev(`document.querySelector('[data-widget=resume]')?.click()`);await sleep(250);assert.equal(await ev('location.hash'),'#/home');
  const saved=await ev(`androidStudio.load('${p.id}')`);assert.equal(saved.text.replaceAll('\r\n','\n'),loaded.text.replaceAll('\r\n','\n'),'Layout/navigation must preserve the initially loaded ASS content');assert.equal(saved.originalText,doc,'Original import retains exact source bytes');
  await viewport(1024,768);await open(p.id);const tablet=await ev(`({nav:getComputedStyle(document.getElementById('android-bottom-nav')).display,top:getComputedStyle(document.getElementById('android-tools')).display,stage:document.getElementById('stage-wrap').getBoundingClientRect().right,panel:document.getElementById('editor-panel').getBoundingClientRect().left})`);assert.equal(tablet.nav,'none');assert.notEqual(tablet.top,'none');assert.ok(tablet.panel>=tablet.stage-1);results.push({tablet});
  const mediaId=process.env.SUBFABRIC_TEST_MEDIA_ID||JSON.parse(await fs.readFile('android/out/download-public-download-results.json','utf8'))[0].mediaId;
  const media=await ev(`androidStudio.create('Android phone video '+Date.now(),${JSON.stringify(assFixture)},'phone-video.ass')`);await ev(`androidStudio.update('${media.id}',{mediaId:'${mediaId}',mediaName:'phone-preview.mp4'})`);await library();await ev(`location.hash='#/dashboard'`);await sleep(150);await ev(`location.hash='#/home'`);await sleep(300);await viewport(390,844);await open(media.id);await until(`__dbg.video.videoWidth>0&&__dbg.video.readyState>=2`);
  for(const mode of ['dark','light']){
    await ev(`document.getElementById('sf-mode').value='${mode}';document.getElementById('sf-mode').dispatchEvent(new Event('change'))`);await sleep(400);assert.equal(await ev('document.body.dataset.theme'),mode);
    await ev(`__dbg.video.currentTime=1.5`);await sleep(350);const video=await ev(`(()=>{const e=document.getElementById('video-stage'),r=e.getBoundingClientRect();return {w:r.width,h:r.height,mediaWidth:__dbg.video.videoWidth,mediaHeight:__dbg.video.videoHeight,canvas:!!__dbg.assPlayer.instance?.canvas}})()`);assert.ok(Math.abs(video.w/video.h-16/9)<.002);assert.ok(video.canvas);results.push({mode,video});
    await fs.writeFile(`android/out/phone-layout-${mode}-390.png`,Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await fs.writeFile('android/out/phone-layout-wsa-results.json',JSON.stringify({projectId:p.id,results},null,2));console.log(JSON.stringify({passed:results.length+3,results},null,2));
}finally{
  if(oldMode)await ev(`document.getElementById('sf-mode').value=${JSON.stringify(oldMode)};document.getElementById('sf-mode').dispatchEvent(new Event('change'))`).catch(()=>{});
  await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();
}
