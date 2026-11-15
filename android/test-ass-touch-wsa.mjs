import assert from 'node:assert/strict';
import {connect} from './cdp.mjs';
const c=await connect();const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function touch(type,x,y){await c.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});}
try{
await c.evaluate(`document.querySelector('.ptab[data-tab=roles]').click()`);await wait(100);
const role=await c.evaluate(`(()=>{const r=document.querySelector('.role-card[data-name="Host"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
await touch('touchStart',role.x,role.y);await wait(650);await touch('touchEnd');
assert.equal(await c.evaluate('document.getElementById("role-menu").hidden'),false);
await c.evaluate(`document.querySelector('#role-menu [data-act=rename]').click();document.getElementById('role-rename-input').value='Narrator';document.getElementById('role-rename-ok').click()`);await wait(150);await c.evaluate('__subfabricFlushSave()');
assert.ok(await c.evaluate('__dbg.panel._roles.some(r=>r.name==="Narrator")'));
console.log('Real touch long press + role rename: passed');
await c.evaluate(`document.querySelector('.ptab[data-tab=subs]').click();__dbg.timeline.fit()`);await wait(200);
const pos=await c.evaluate(`(()=>{const tl=__dbg.timeline,canvas=tl.canvas.getBoundingClientRect(),row=__dbg.state.items[0];const x=tl.t2x((row.start+row.end)/2),y=tl._laneTop(0)+12;return{x:canvas.x+x,y:canvas.y+y,start:row.start,end:row.end,hit:!!tl._hitTest(x,y,true),id:__dbg.state.project.id}})()`);
assert.ok(pos.hit);await touch('touchStart',pos.x,pos.y);await touch('touchEnd');await wait(100);await touch('touchStart',pos.x,pos.y);await touch('touchMove',pos.x+25,pos.y);await touch('touchEnd');await wait(200);await c.evaluate('__subfabricFlushSave()');
const after=await c.evaluate('__dbg.state.items[0].start');assert.ok(Math.abs(after-pos.start)>.05);console.log(JSON.stringify({check:'Real touch timeline select then drag changes ASS times',before:pos.start,after}));
}finally{c.close();}
