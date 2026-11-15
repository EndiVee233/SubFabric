import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect } from './cdp.mjs';
import { assFixture } from './ass-fixture.mjs';
import { fmtTimeAss } from '../editor/js/util.js';
const c=await connect(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const previous=await c.evaluate('__dbg.state.project?.id');
try{
  const header=assFixture.slice(0,assFixture.indexOf('Comment:'));
  const lines=[];
  for(let i=0;i<500;i++)for(const [style,text]of [['中文',`[Host]长稿字幕第 ${i+1} 句。`],['Default',`Sentence number ${i+1}.`]])lines.push(`Dialogue: 0,${fmtTimeAss(1+i*4)},${fmtTimeAss(4+i*4)},${style},Host,0,0,0,,${text}`);
  const started=Date.now();
  const p=await c.evaluate(`androidStudio.create('长稿验收 · 500 句',${JSON.stringify(header+lines.join('\n'))},'large-acceptance.ass')`);
  await c.evaluate(`location.hash='#/project/${p.id}'`);
  for(let i=0;i<100;i++){if(await c.evaluate(`__dbg.state.project?.id==='${p.id}'&&__dbg.state.items.length===500`))break;await wait(100);}
  assert.equal(await c.evaluate('__dbg.state.items.length'),500);
  await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await c.evaluate(`document.body.dataset.androidFocus='subs';window.dispatchEvent(new Event('resize'))`);await wait(300);
  const first=await c.evaluate('document.querySelectorAll(".cue-card").length');assert.ok(first<60,'Large projects must stay virtualized');
  await c.evaluate('document.getElementById("cue-list").scrollTop=document.getElementById("cue-list").scrollHeight');await wait(400);
  const last=await c.evaluate('Math.max(...[...document.querySelectorAll(".cue-card")].map(e=>Number(e.dataset.idx)))');assert.ok(last>=490);
  const result={projectId:p.id,rows:500,events:1000,visibleCards:first,lastReachableIndex:last,elapsedMs:Date.now()-started};
  await fs.writeFile(new URL('./out/ass-large-results.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await c.send('Emulation.clearDeviceMetricsOverride');await c.evaluate(`document.body.dataset.androidFocus='';location.hash='#/project/${previous}'`);c.close();}
