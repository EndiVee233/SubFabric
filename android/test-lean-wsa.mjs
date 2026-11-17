import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {connect,shell} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';

const c=await connect(),results=[],wait=ms=>new Promise(r=>setTimeout(r,ms)),ev=s=>c.evaluate(s);
async function until(s){for(let n=0;n<120;n++){const v=await ev(s);if(v)return v;await wait(100);}throw Error('Timed out: '+s);}
async function hierarchy(){
  shell('shell','uiautomator','dump','/sdcard/subfabric-lean-test.xml');let xml=shell('shell','cat','/sdcard/subfabric-lean-test.xml');const nodes=[],stack=[];
  if(!xml.includes('package="com.subfabric.android"')){shell('shell','am','start','-W','--activity-single-top','--activity-reorder-to-front','-n','com.subfabric.android/.MainActivity');shell('shell','uiautomator','dump','/sdcard/subfabric-lean-test.xml');xml=shell('shell','cat','/sdcard/subfabric-lean-test.xml');}
  for(const m of xml.matchAll(/<node\b[^>]*>|<\/node>/g)){
    if(m[0]==='</node>'){stack.pop();continue;}
    const n=Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2].replace(/&amp;/g,'&').replace(/&quot;/g,'"')]));n.web=stack.some(n=>n.class==='android.webkit.WebView');nodes.push(n);if(!m[0].endsWith('/>'))stack.push(n);
  }return nodes.filter(n=>!n.web);
}
async function tap(text){
  // Native entrances and closing windows may still be moving when UIAutomator reports idle.
  await wait(500);
  for(let i=0;i<7;i++){
    const nodes=await hierarchy(),node=nodes.find(n=>n.class==='android.widget.Button'&&n.text===text&&n.bounds!=='[0,0][0,0]');
    if(node){const b=node.bounds.match(/\d+/g).map(Number);shell('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));await wait(250);return;}
    const list=nodes.filter(n=>n.class==='android.widget.ListView'&&n.bounds!=='[0,0][0,0]').at(-1);if(!list)break;const b=list.bounds.match(/\d+/g).map(Number);shell('shell','input','swipe',String((b[0]+b[2])/2),String(i===0?b[1]+45:b[3]-35),String((b[0]+b[2])/2),String(i===0?b[3]-35:b[1]+45),'220');
  }throw Error('Native button missing: '+text);
}
const snapshot=()=>ev('androidNative.snapshot()');
function texts(state){return JSON.stringify(state.controls||[]);}
const removed=['外观与体验','帮助与快捷键','性能与调度','下载与登录','反思纠错','语义重分句','导入项目包','描边映射曲线'];
let fixture,original;
try{
  await until('window.androidNative&&window.__androidWorkspace');await ev('__subfabricFlushSave()');
  original=await ev('({route:location.hash,time:__dbg.video.currentTime})');
  const before=await ev('androidStudio.rpc("studioList").then(rows=>rows.map(p=>({id:p.id,revision:p.revision,mediaId:p.mediaId})))');
  const config=await ev('androidRpc("llmConfig")');const modelPrefs=await ev('[localStorage.getItem("android-asr-model"),localStorage.getItem("android-asr-rerecog")]');
  await ev('androidNative.command({kind:"route",route:"#/dashboard"})');await until('location.hash==="#/dashboard"');
  let state=await snapshot();assert.deepEqual(state.controls.filter(n=>n.kind==='button').map(n=>n.text),['新建稿件','导入字幕','打开稿件库']);
  let nodes=await hierarchy();assert.ok(['主页','稿件','设置'].every(t=>nodes.some(n=>n.class==='android.widget.Button'&&n.text===t)));assert.ok(!nodes.some(n=>n.class==='android.widget.Button'&&['操作','更多'].includes(n.text)));results.push('Home contains three workflow actions and exactly Home / Drafts / Settings navigation');
  await tap('新建稿件');await until('location.hash==="#/new"&&document.getElementById("np-mode-draft").classList.contains("active")');
  state=await snapshot();for(const text of removed)assert.ok(!texts(state).includes(text),text);assert.ok(!texts(state).includes('全流程全自动'));assert.ok(!texts(state).includes('区分说话人'));assert.ok(!texts(state).includes('粘贴链接或 BV 号'));
  assert.ok(await ev('document.getElementById("np-word").closest("#np-cast-group")&&!getComputedStyle(document.getElementById("np-cast-group")).display.includes("none")'),'Word/alignment options retain their backing group');
  results.push('New draft defaults to recognition; unsupported automation, diarization and URL download inputs are absent');
  await tap('选择视频');nodes=await hierarchy();assert.ok(['从相册导入','从文件导入'].every(t=>nodes.some(n=>n.text===t)));await tap('取消');results.push('The retained local video input opens both native gallery and file sources, and cancels safely');
  await tap('设置');await until('location.hash==="#/settings"');await tap('语音识别');await until('document.querySelector("#sf-settings-tab-models").classList.contains("active")');
  await until('!!document.getElementById("android-parakeet-tile")');state=await snapshot();for(const text of removed)assert.ok(!texts(state).includes(text),text);assert.ok(texts(state).includes('Parakeet'));assert.ok(texts(state).includes('Qwen'));assert.ok(texts(state).includes('存储空间'));results.push('Settings retain ASR, translation and storage; unavailable desktop categories are removed');
  await ev('document.getElementById("android-parakeet-tile").click()');await wait(500);state=await snapshot();assert.ok(texts(state).includes('从文件导入 GGUF'));assert.ok(texts(state).includes('校验模型')||texts(state).includes('下载模型'));assert.ok(!texts(state).includes('配置与依赖'));await ev('document.getElementById("sf-asr-back").click()');results.push('Model detail still offers real GGUF management without the obsolete prerequisites tile');
  await tap('翻译与术语');await until('!document.getElementById("st-panel-translate").hidden');await tap('添加方案');await until('!document.getElementById("st-scheme-drawer").hidden');
  state=await snapshot();assert.ok(JSON.stringify(state.modal?.controls||state.controls).includes('方案名称'));assert.ok(!JSON.stringify(state.modal?.controls||state.controls).includes('每批字幕行数'));assert.ok(await ev('!document.getElementById("st-prompt").closest("details").open'));assert.ok(await ev('!document.getElementById("st-batch").closest("details").open'));
  await ev('document.getElementById("st-drawer-cancel").click()');await wait(200);assert.deepEqual(await ev('androidRpc("llmConfig")'),config);results.push('Translation provider/model/key fields are retained; advanced prompt/call parameters collapse and Cancel preserves schemes');
  await tap('存储空间');await until('location.hash==="#/storage"');nodes=await hierarchy();assert.ok(nodes.some(n=>n.text==='设置'&&n.class==='android.widget.Button'));results.push('Storage remains reachable from Settings without a More destination');
  await ev('androidNative.command({kind:"route",route:"#/home"})');await until('location.hash==="#/home"');state=await snapshot();for(const text of removed)assert.ok(!texts(state).includes(text),text);assert.ok(!texts(state).includes('批量初稿'));assert.ok(texts(state).includes('识别/翻译'));assert.ok(state.controls.some(n=>n.kind==='buttons'&&n.choices.some(b=>b.text==='删除')));assert.ok(!texts(state).includes('音频、波形、字幕副本一起删'));results.push('Library keeps search/status/open and recognition/translation handling, with duplicate settings and batch controls removed');
  fixture=await ev(`androidStudio.create('Android lean UI fixture '+Date.now(),${JSON.stringify(assFixture)},'lean.ass')`);
  await ev(`location.hash='#/project/${fixture.id}'`);await until(`__dbg.state.project?.id==='${fixture.id}'`);await tap('工具');
  state=await snapshot();for(const text of removed)assert.ok(!texts(state).includes(text),text);assert.ok(texts(state).includes('翻译字幕'));assert.ok(texts(state).includes('逐词对齐'));assert.ok(!texts(state).includes('Noto Sans'));
  nodes=await hierarchy();assert.ok(!nodes.some(n=>n.class==='android.widget.Button'&&['日志','工作量','备注'].includes(n.text)));await tap('字幕样式');state=await snapshot();assert.ok(texts(state).includes('字体')||texts(state).includes('ass-style-zh-font'));await tap('字幕样式');results.push('Editor has Subtitles / Roles / Tools only; useful editing actions remain and subtitle style fields expand on demand');
  await tap('字幕');const item=await ev('androidNative.snapshot().rows[0].id');await ev(`androidNative.command({kind:'menu',item:'${item}'})`);await until('!!androidNative.snapshot().modal');state=await snapshot();const menu=state.modal.controls.map(n=>n.text||'').join(' ');assert.ok(menu.includes('重新识别该句'));assert.ok(menu.includes('已校对'));assert.ok(menu.includes('重排逐词时间'));assert.ok(!menu.includes('卡拉OK')&&!menu.includes('连续性'));await ev('androidNative.command({kind:"back"})');results.push('Per-caption recognition/proofreading moves to the long-press menu; rare conversion actions are absent');
  for(const route of ['#/help','#/batch']){await ev(`location.hash='${route}'`);await until('location.hash==="#/home"');state=await snapshot();for(const text of removed)assert.ok(!texts(state).includes(text),text);}results.push('Old help/batch routes return to the library rather than exposing removed screens');
  assert.deepEqual(await ev('androidRpc("llmConfig")'),config);assert.deepEqual(await ev('[localStorage.getItem("android-asr-model"),localStorage.getItem("android-asr-rerecog")]'),modelPrefs);
  const after=await ev('androidStudio.rpc("studioList").then(rows=>rows.map(p=>({id:p.id,revision:p.revision,mediaId:p.mediaId})))');for(const p of before)assert.deepEqual(after.find(r=>r.id===p.id),p);results.push(`${before.length} existing drafts, ASR choices and translation schemes retain their identities/settings`);
  await fs.writeFile('android/out/lean-wsa-results.json',JSON.stringify({fixtureId:fixture.id,results},null,2));console.log(JSON.stringify(results,null,2));
}catch(error){await fs.writeFile('android/out/lean-wsa-failure.json',JSON.stringify({fixtureId:fixture?.id,error:error.stack,results,state:await ev('({route:location.hash,mode:document.getElementById("np-mode-draft").className,section:document.querySelector(".st-tab.active")?.dataset.stp,modal:androidNative.snapshot().modal?.title})').catch(()=>null)},null,2));throw error;}
finally{
  if(original){await ev(`(async()=>{if(androidNative.snapshot().modal)await window.androidBack();await androidNative.command({kind:'route',route:${JSON.stringify(original.route)}})})()`).catch(()=>{});await wait(450);await ev(`__dbg.video.pause();__dbg.video.currentTime=${Number(original.time)||0}`).catch(()=>{});}
  c.close();
}
