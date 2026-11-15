import assert from 'node:assert/strict';
import { connect } from './cdp.mjs';
const c=await connect(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(expression){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(await c.evaluate(expression))return;await wait(100);}
  throw new Error('Timed out: '+expression);
}
try{
  await until('window.androidReady&&__dbg.state.items.length>0&&__dbg.assPlayer.ready');
  await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await wait(400);await c.evaluate(`__dbg.panel.startEdit(__dbg.state.items[0],1)`);
  await until('document.activeElement.isContentEditable');
  await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:350,deviceScaleFactor:1,mobile:false});await wait(250);
  const layout=await c.evaluate(`({keyboard:document.body.classList.contains('android-keyboard'),rows:getComputedStyle(document.getElementById('app')).gridTemplateRows,editor:document.getElementById('editor-panel').getBoundingClientRect().height})`);
  assert.equal(layout.keyboard,true);assert.ok(layout.editor>=180);console.log(JSON.stringify({check:'Same-width keyboard shrink keeps the editor usable',...layout}));
  await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await until("!document.body.classList.contains('android-keyboard')");
  assert.ok(await c.evaluate("document.getElementById('timeline').getBoundingClientRect().height>=65"));
}finally{await c.evaluate('__dbg.panel.commitEdit()');await wait(80);await c.send('Emulation.clearDeviceMetricsOverride');c.close();}
