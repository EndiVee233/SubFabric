import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect,shell} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';

const c=await connect(),results=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ev=source=>c.evaluate(source);
async function until(source){for(let n=0;n<100;n++){const value=await ev(source);if(value)return value;await wait(100);}throw Error('Timed out: '+source);}
function decode(value){return value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
async function hierarchy(){
  shell('shell','uiautomator','dump','/sdcard/subfabric-native-test.xml');
  const xml=shell('shell','cat','/sdcard/subfabric-native-test.xml');
  const stack=[],nodes=[];
  for(const match of xml.matchAll(/<node\b[^>]*>|<\/node>/g)){
    if(match[0]==='</node>'){stack.pop();continue;}
    const node=Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
    node.web=stack.some(n=>n.class==='android.webkit.WebView');nodes.push(node);if(!match[0].endsWith('/>'))stack.push(node);
  }
  return nodes.filter(n=>!n.web);
}
async function tap(text,kind='android.widget.Button'){
  let nodes,node;
  for(let i=0;i<7;i++){
    nodes=await hierarchy();node=nodes.find(n=>n.text===text&&n.class===kind);if(node)break;
    const list=nodes.filter(n=>n.class==='android.widget.ListView').at(-1);if(!list)break;const b=list.bounds.match(/\d+/g).map(Number);
    shell('shell','input','swipe',String((b[0]+b[2])/2),String(b[3]-35),String((b[0]+b[2])/2),String(b[1]+45),'220');await wait(200);
  }
  if(!node){await fs.writeFile('android/out/native-tap-failure.json',JSON.stringify({text,nodes,snapshot:await ev('androidNative.snapshot()')},null,2));}
  assert.ok(node,'Native '+kind+' '+text);
  const b=node.bounds.match(/\d+/g).map(Number);shell('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));await wait(250);return node;
}
async function touch(type,points=[]){await c.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({...p,radiusX:6,radiusY:6,force:1}))});await wait(70);}
async function pinch(from,to){
  await touch('touchStart',from);for(let i=1;i<=5;i++)await touch('touchMove',from.map((p,k)=>({id:p.id,x:p.x+(to[k].x-p.x)*i/5,y:p.y+(to[k].y-p.y)*i/5})));await touch('touchEnd');
}
let fixture,original,task,bounds;
try{
  await until('window.androidNative&&window.androidReady');await ev('if(androidNative.snapshot().modal)window.androidBack()');await ev('__subfabricFlushSave()');
  original=await ev('({route:location.hash,time:__dbg.video.currentTime,projects:androidStudio.rpc("studioList")})');original.projects=await ev('androidStudio.rpc("studioList").then(rows=>rows.map(p=>({id:p.id,revision:p.revision,mediaId:p.mediaId})))');
  const activities=shell('shell','dumpsys','activity','activities');
  const match=activities.match(/Task\{[^\n]+#(\d+)[^\n]+com\.subfabric\.android[^\n]*\}\s+ mBounds=Rect\((\d+), (\d+) - (\d+), (\d+)\)/);assert.ok(match,'Own WSA task bounds');task=match[1];bounds=match.slice(2).map(Number);
  fixture=await ev(`androidStudio.create('Android native UI fixture '+Date.now(),${JSON.stringify(assFixture)},'native.ass')`);
  const media=JSON.parse(await fs.readFile('android/out/export-fixture.json','utf8'));await ev(`androidStudio.update('${fixture.id}',{mediaId:'${media.mediaId}',mediaName:'native-fixture.mp4'})`);
  await ev(`location.hash='#/project/${fixture.id}'`);await until(`__dbg.state.project?.id==='${fixture.id}'`);
  for(const [width,height]of process.argv.includes('--quick')?[[390,844]]:[[320,650],[390,844],[626,998],[900,420],[1024,768]]){
    shell('shell','am','task','resize',task,'100','100',String(100+width),String(100+height));await wait(600);
    const nodes=await hierarchy();assert.ok(nodes.some(n=>n.class==='android.widget.ListView'),'Native ListView '+width);
    assert.ok(nodes.some(n=>n.text==='导出'&&n.class==='android.widget.Button'));
    assert.ok(!nodes.some(n=>['主页','稿件','操作','更多'].includes(n.text)&&n.class==='android.widget.Button'),'Editor has no work navigation');
    const web=await ev('({w:innerWidth,h:innerHeight,t:__dbg.timeline.canvas.getBoundingClientRect().toJSON()})');assert.ok(web.t.width>100&&web.t.height>=60);assert.ok(web.t.bottom<=web.h+1);
    results.push(`${width}×${height}: native list, toolbar, pivots and contained rendering surface`);
  }
  shell('shell','am','task','resize',task,'100','100','490','944');await wait(500);
  await tap('导出');let nodes=await hierarchy();assert.ok(nodes.some(n=>n.text==='导出字幕'&&n.class==='android.widget.Button'));assert.ok(nodes.some(n=>n.text==='导出视频'&&n.class==='android.widget.Button'));
  await tap('导出视频');await until('!document.getElementById("sf-export-video").hidden');if(!await ev('document.querySelector("#sf-export-video details").open'))await tap('压制参数（可选，不改字幕样式）');
  assert.ok(await ev('androidNative.snapshot().modal.controls.some(n=>n.kind==="select")'),'Native dropdown view model');
  for(let i=0;i<4;i++){nodes=await hierarchy();if(nodes.some(n=>n.class==='android.widget.Spinner'))break;const list=nodes.find(n=>n.class==='android.widget.ListView'),b=list.bounds.match(/\d+/g).map(Number);shell('shell','input','swipe',String((b[0]+b[2])/2),String(b[3]-40),String((b[0]+b[2])/2),String(b[1]+60),'250');}
  assert.ok(nodes.some(n=>n.class==='android.widget.Spinner'));shell('shell','input','keyevent','4');await wait(300);assert.equal(await ev('document.getElementById("sf-export-video").hidden'),true);results.push('Native secondary export menu, real Spinner video parameters; Back cancels without leaving draft');
  await tap('角色');await until('__dbg.panel._tab==="roles"');nodes=await hierarchy();assert.ok(nodes.some(n=>n.class==='android.widget.Button'&&n.text.includes('Host')));await tap('字幕');
  await tap('编辑');await until('!!androidNative.snapshot().edit');nodes=await hierarchy();let fields=nodes.filter(n=>n.class==='android.widget.EditText');assert.equal(fields.length,4);const endField=fields[3],b=endField.bounds.match(/\d+/g).map(Number);shell('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));await wait(180);shell('shell','input','keyevent','123');shell('shell','input','text','%sNative%swidget%sedit.');await wait(200);nodes=await hierarchy();assert.ok(nodes.some(n=>n.class==='android.widget.EditText'&&n.text.includes('Native widget')),'Android input reaches the actual editor field');await tap('保存');await until('!androidNative.snapshot().edit');await ev('__subfabricFlushSave()');
  const saved=await ev(`androidStudio.load('${fixture.id}')`);assert.ok(saved.text.includes('Native')&&saved.text.includes('widget'));assert.ok(saved.text.includes('preserve comment')&&saved.text.includes('Custom Metadata: keep this exact value'));results.push('Real Android EditText typing and native Save preserve ASS metadata/comments');
  // Pinch the renderer via browser input. Native controls above were exercised via Android input.
  await ev('__dbg.timeline.viewStart=0;__dbg.timeline.pxPerSec=__dbg.timeline._zoomLimits().min*4;__dbg.timeline._viewReady=true;__dbg.timeline.touch()');
  const rect=await ev('__dbg.timeline.canvas.getBoundingClientRect().toJSON()');const y=rect.top+rect.height*.55;
  const start=[{id:1,x:rect.left+45,y},{id:2,x:rect.right-45,y}],inside=[{id:1,x:rect.left+115,y},{id:2,x:rect.right-115,y}];
  const before=await ev('({scale:__dbg.timeline.pxPerSec,count:__dbg.state.items.length,text:__dbg.state.assDoc.serialize()})');
  await pinch(start,inside);assert.ok(await ev('__dbg.timeline.pxPerSec')<before.scale,'Inward pinch expands time span');
  const small=await ev('__dbg.timeline.pxPerSec');await pinch(inside,start);assert.ok(await ev('__dbg.timeline.pxPerSec')>small,'Outward pinch reduces time span');
  assert.equal(await ev('__dbg.state.items.length'),before.count);assert.equal(await ev('__dbg.state.assDoc.serialize()'),before.text);assert.equal(await ev('!!__dbg.timeline._drag'),false);results.push('Two real pointer pinch sequences: correct directions, no accidental creation or document changes');
  const itemId=await ev('androidNative.snapshot().rows[0].id');await ev(`androidNative.command({kind:'select',item:'${itemId}'})`);assert.equal(await ev('__dbg.state.selected===__dbg.panel.filtered[0]'),true);
  const skip=await ev('__dbg.state.items[0].realignSkip');await ev(`androidNative.command({kind:'rowAction',item:'${itemId}',action:'skip'})`);assert.notEqual(await ev('__dbg.state.items[0].realignSkip'),skip);await ev(`androidNative.command({kind:'rowAction',item:'${itemId}',action:'skip'})`);assert.equal(!!await ev('__dbg.state.items[0].realignSkip'),!!skip);results.push('Native selection reaches shared selected state; proofread toggle uses original row handler');
  // Equal-distance translation continues to select a range rather than zoom.
  const scale=await ev('__dbg.timeline.pxPerSec'),translation=35;
  await touch('touchStart',[{id:5,x:rect.left+60,y},{id:6,x:rect.left+150,y}]);await touch('touchMove',[{id:5,x:rect.left+60+translation,y},{id:6,x:rect.left+150+translation,y}]);await touch('touchEnd');assert.equal(await ev('__dbg.timeline.pxPerSec'),scale);assert.ok(await ev('!!__dbg.timeline.rangeSel'));await ev('__dbg.timeline.clearRangeSel()');results.push('Two-finger translation retains Ctrl range selection without changing zoom');
  await ev('androidNative.command({kind:"seek",time:6})');await wait(450);nodes=await hierarchy();const list=nodes.find(n=>n.class==='android.widget.ListView'),current=nodes.find(n=>n.text==='Keep, this title');assert.ok(list&&current);const lb=list.bounds.match(/\d+/g).map(Number),cb=current.bounds.match(/\d+/g).map(Number);assert.ok(cb[1]>=lb[1]&&cb[3]<=lb[3],'Last native caption stays inside list');assert.ok(cb[1]<lb[1]+(lb[3]-lb[1])*.7,'Last caption stays above list bottom');results.push('Native last-caption follow has enough trailing scroll space and remains visibly above bottom');
  await ev('__dbg.timeline.fit()');const blank=await ev('(()=>{const t=__dbg.timeline,r=t.canvas.getBoundingClientRect();return {a:r.left+t.t2x(3.8),b:r.left+t.t2x(4.5),y:r.top+t._laneTop(0)+t._laneH(0)*.25}})()');const count=await ev('__dbg.state.items.length');
  await touch('touchStart',[{id:9,x:blank.a,y:blank.y}]);await touch('touchMove',[{id:9,x:blank.b,y:blank.y}]);await touch('touchEnd');await until('!!androidNative.snapshot().edit');assert.equal(await ev('!!__dbg.panel.editItem?.isNew'),true);shell('shell','input','keyevent','4');await until('!androidNative.snapshot().edit');assert.equal(await ev('__dbg.state.items.length'),count);results.push('Single-finger blank drag opens native editor; Back cancels an empty new caption without leaving a ghost row');
  nodes=await hierarchy();const held=nodes.find(n=>n.text==='Keep, this title');assert.ok(held);const hb=held.bounds.match(/\d+/g).map(Number);shell('shell','input','swipe',String((hb[0]+hb[2])/2),String((hb[1]+hb[3])/2),String((hb[0]+hb[2])/2),String((hb[1]+hb[3])/2),'650');await until('!!androidNative.snapshot().modal');nodes=await hierarchy();assert.ok(nodes.some(n=>n.class==='android.widget.Button'&&n.text.includes('删除')));shell('shell','input','keyevent','4');await until('!androidNative.snapshot().modal');assert.equal(await ev('__dbg.state.items.length'),count);results.push('Native subtitle-row long press opens the original contextual menu; Back does not delete');
  await ev('androidNative.command({kind:"route",route:"#/home"})');await until('location.hash==="#/home"');nodes=await hierarchy();assert.ok(['主页','稿件','操作','更多'].every(text=>nodes.some(n=>n.text===text&&n.class==='android.widget.Button')));results.push('Work navigation is native and returns outside editor only');
  await ev('androidNative.command({kind:"route",route:"#/settings"})');await wait(600);nodes=await hierarchy();assert.ok(nodes.some(n=>n.class==='android.widget.ListView'));results.push('Global settings use scrollable native rows');
  const after=await ev('androidStudio.rpc("studioList").then(rows=>rows.map(p=>({id:p.id,revision:p.revision,mediaId:p.mediaId})))');for(const row of original.projects)assert.deepEqual(after.find(p=>p.id===row.id),row);results.push(`${original.projects.length} pre-existing drafts retain revision/media identity`);
  await fs.writeFile('android/out/native-ui-wsa-results.json',JSON.stringify({fixtureId:fixture.id,results},null,2));console.log(JSON.stringify(results,null,2));
}catch(error){await fs.writeFile('android/out/native-ui-wsa-failure.json',JSON.stringify({fixtureId:fixture?.id,error:error.stack,results},null,2));throw error;}
finally{
  await touch('touchCancel').catch(()=>{});
  if(bounds)shell('shell','am','task','resize',task,...bounds.map(String));
  if(original){await ev(`androidNative.command({kind:'editCancel'});if(androidNative.snapshot().modal)await window.androidBack();location.hash=${JSON.stringify(original.route)}`).catch(()=>{});await wait(600);await ev(`__dbg.video.pause();__dbg.video.currentTime=${Number(original.time)||0}`).catch(()=>{});}
  c.close();
}
