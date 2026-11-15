import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect } from './cdp.mjs';
import { assFixture } from './ass-fixture.mjs';

const c=await connect(),results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(expression,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const v=await c.evaluate(expression);if(v)return v;await sleep(150);}throw new Error('Timed out: '+expression);}
try{
  await until('window.androidReady');
  const p=await c.evaluate(`androidStudio.create('ASS 安卓验收',${JSON.stringify(assFixture)},'android-acceptance.ass')`);
  await c.evaluate(`location.hash='#/project/${p.id}'`);
  await until(`__dbg.state.project?.id===${JSON.stringify(p.id)}&&__dbg.assPlayer.ready&&__dbg.state.items.length>=2`);
  const imported=await c.evaluate('({events:__dbg.state.assDoc.events.length,items:__dbg.state.items.length,wordRows:__dbg.state.items.filter(x=>x.ref.en?.words?.length).length,previewDuration:__dbg.video.duration,themes:SF_THEMES.list([]).map(p=>p.id)})');
  assert.equal(imported.events,4);assert.ok(imported.wordRows>=1);assert.deepEqual(imported.themes,['windows-uwp']);results.push({check:'shared full ASS import, karaoke grouping, Windows-only theme',...imported});
  await c.evaluate('__dbg.video.currentTime=1.5');await sleep(450);
  await until(`(()=>{const canvas=__dbg.assPlayer.instance?.canvas;if(!canvas)return false;const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let alpha=0;for(let i=3;i<data.length;i+=4)if(data[i])alpha++;return alpha>100;})()`);
  const pixels=await c.evaluate(`(()=>{const canvas=__dbg.assPlayer.instance.canvas,rect=canvas.getBoundingClientRect(),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let alpha=0;for(let i=3;i<data.length;i+=4)if(data[i])alpha++;return {alpha,width:rect.width,height:rect.height};})()`);
  assert.ok(pixels.alpha>100&&pixels.width>0&&pixels.height>0,'Actual libass pixels must be drawn');results.push({check:'actual WASM ASS rendering without a media file',...pixels});
  const originalWords=await c.evaluate('__dbg.state.items.find(x=>x.ref.en?.words?.length).ref.en.words.map(w=>({s:w.s,e:w.e,text:w.text}))');
  await c.evaluate(`(()=>{const node=document.querySelector('.cue-card .cc-l1');node.click();return true})()`);
  await until('!!__dbg.panel.editorEl?.querySelector(".ie-l1")');
  await c.evaluate(`(()=>{const field=__dbg.panel.editorEl.querySelector('.ie-l1');field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));field.textContent='你好，安卓平板。';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true}));field.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你好，安卓平板。'}));__dbg.panel.commitEdit();return true;})()`);
  await sleep(120);await c.evaluate('__subfabricFlushSave()');
  const saved=await c.evaluate(`androidStudio.load('${p.id}')`);
  assert.match(saved.text,/你好，安卓平板。/);assert.ok(saved.text.includes('Custom Metadata: keep this exact value'));assert.ok(saved.text.includes('{\\pos(640,160)\\bord4\\i1}Keep, this title'));assert.ok(saved.text.includes('preserve comment'));
  const wordsAfter=await c.evaluate('__dbg.state.items.find(x=>x.ref.en?.words?.length).ref.en.words.map(w=>({s:w.s,e:w.e,text:w.text}))');
  assert.deepEqual(wordsAfter,originalWords);results.push({check:'Chinese IME editing + native auto-save preserves English word times and unrelated ASS data',passed:true});
  // Exercise the production style controls, rather than rewriting styles in the test adapter.
  await c.evaluate(`document.querySelector('.ptab[data-tab=settings]').click()`);await sleep(150);
  const styleResult=await c.evaluate(`(()=>{const field=document.getElementById('ass-style-en-size');field.value='52';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));return field.value})()`);
  assert.equal(styleResult,'52');await c.evaluate('__subfabricFlushSave()');
  const styled=await c.evaluate(`androidStudio.load('${p.id}')`);assert.match(styled.text,/Style: Default,Noto Sans CJK SC,52,/);results.push({check:'original ASS style editor writes font size to the actual ASS document',passed:true});
  await c.evaluate(`document.querySelector('.ptab[data-tab=subs]').click()`);
  for(const [label,width,height]of [['phone',390,650],['small-phone',320,650],['tablet',1024,705]]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(350);
    await until(`(()=>{const canvas=__dbg.assPlayer.instance?.canvas;if(!canvas||!__dbg.assPlayer.ready)return false;const d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;for(let i=3;i<d.length;i+=4)if(d[i])return true;return false;})()`);
    const layout=await c.evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,listHeight:document.getElementById('cue-list').getBoundingClientRect().height,canvasHeight:document.getElementById('timeline').getBoundingClientRect().height,tools:[...document.querySelectorAll('#android-tools>button')].map(e=>({text:e.textContent,right:e.getBoundingClientRect().right})),rows:getComputedStyle(document.getElementById('app')).gridTemplateRows})`);
    assert.equal(layout.width,width);assert.ok(layout.scroll<=width);assert.ok(layout.listHeight>=110,`${label}: subtitle list needs editing room`);assert.ok(layout.canvasHeight>=65,`${label}: timeline must remain usable`);assert.ok(layout.tools.every(b=>b.right<=width));results.push({check:`${label} layout`,...layout});
    const shot=await c.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(new URL(`./out/ass-${label}.png`,import.meta.url),Buffer.from(shot.data,'base64'));
  }
  await c.send('Emulation.clearDeviceMetricsOverride');
  // A stale revision must never overwrite a concurrent save.
  const conflict=await c.evaluate(`androidStudio.rpc('studioUpdate',{id:'${p.id}',revision:'stale',patch:{text:'bad overwrite'}}).then(()=>false,e=>e.message.startsWith('CONFLICT:'))`);assert.equal(conflict,true);results.push({check:'native revision conflict rejects stale save',passed:true});
  const errors=await c.evaluate('androidErrors.filter(e=>/\[JS错误\]|\[Promise未处理\]/.test(e))');assert.deepEqual(errors,[]);
  await fs.writeFile(new URL('./out/ass-wsa-results.json',import.meta.url),JSON.stringify({projectId:p.id,results,errors,limitations:['Phone sizes use the actual WSA WebView viewport; ARM phone hardware has not been tested.']},null,2));
  console.log(JSON.stringify({projectId:p.id,results},null,2));
}finally{await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();}
