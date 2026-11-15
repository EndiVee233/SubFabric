import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {connect} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';
import {translationDocument} from './translation-doc.mjs';
import {AssDoc} from '../editor/js/ass.js';

const adb=process.env.SUBFABRIC_ADB||'adb',device=process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526';
const secret='subfabric-isolated-fake-key',requests=[],results=[];
let mode='valid',wrongOnce=false,partialCalls=0,responseDelay=0,prefix='译文 ';
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=JSON.parse(raw);requests.push({path:req.url,auth:req.headers.authorization,anthropic:req.headers['x-api-key'],body});
  if(mode==='delay'||mode==='partial'&&++partialCalls===2){setTimeout(()=>{if(!res.destroyed)res.end('{}');},5000).unref();return;}
  if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:19487/stolen'});res.end();return;}
  if(mode==='error'){res.writeHead(401);res.end(JSON.stringify({error:{message:secret}}));return;}
  if(responseDelay)await new Promise(resolve=>setTimeout(resolve,responseDelay));
  const user=body.messages.at(-1).content;
  let content='ok';
  if(user!=='只回复一个单词：ok'){
    const source=JSON.parse(user.slice(user.lastIndexOf('\n')+1));
    content=JSON.stringify(source.map(record=>({...record,source:wrongOnce?record.source+'!':record.source,translation:prefix+record.source})));
    wrongOnce=false;
  }
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.url.endsWith('/messages')?{content:[{type:'text',text:content}],stop_reason:'end_turn'}:{choices:[{message:{content},finish_reason:'stop'}]}));
});
server.listen(19487,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
execFileSync(adb,['-s',device,'reverse','tcp:19487','tcp:19487']);
let c=await connect();const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(expression,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const result=await c.evaluate(expression);if(result)return result;await wait(100);}throw new Error('Timed out: '+expression);}
const call=(path,method='GET',input={})=>c.evaluate(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${method==='GET'?'undefined':JSON.stringify(JSON.stringify(input))}}).then(async r=>({status:r.status,data:await r.json()}))`);
const saved=[];
let activeBefore='';
try{
  await until('window.androidReady&&!!window.__dbg');
  const before=await call('/api/translate/config');assert.equal(before.status,200);
  activeBefore=before.data.activeSchemeId||'';
  if(before.data.ready&&!activeBefore)throw new Error('Preserve the existing unnamed configuration; run this test in an isolated Android profile');
  const openai={name:'Android protocol test',provider:'custom',baseUrl:'http://127.0.0.1:19487/v1',model:'isolated-model',apiKey:secret,activate:true,batchSize:5,contextRows:1,glossary:'Hello=你好'};
  await c.evaluate(`location.hash='#/settings'`);
  await until(`document.getElementById('st-provider').querySelector('option[value="custom"]')!==null`);
  await c.evaluate(`document.getElementById('sf-settings-tab-translate').click();document.getElementById('st-scheme-new').click();document.getElementById('st-scheme-name').value='Android UI save test';document.getElementById('st-provider').value='custom';document.getElementById('st-provider').dispatchEvent(new Event('change'));document.getElementById('st-baseurl').value='http://127.0.0.1:19487/v1';document.getElementById('st-model').value='isolated-model';document.getElementById('st-key').value='${secret}'`);
  for(const width of [320,390,1024]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:705,deviceScaleFactor:1,mobile:false});await wait(200);
    const bounds=await c.evaluate(`['st-scheme-name','st-provider-choice','st-baseurl','st-model','st-key','st-drawer-save'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,right:r.right,width:r.width}})`);
    assert.ok(bounds.every(r=>r.width>0&&r.x>=0&&r.right<=width+1),JSON.stringify({width,bounds}));
    assert.ok(bounds.filter(r=>!r.id.includes('save')).every(r=>r.width>=150),JSON.stringify({width,bounds}));
  }
  await c.send('Emulation.clearDeviceMetricsOverride');
  await c.evaluate(`document.getElementById('st-drawer-save').click()`);
  const uiId=await until(`fetch('/api/translate/schemes').then(r=>r.json()).then(d=>d.schemes.find(s=>s.name==='Android UI save test')?.id)`);saved.push(uiId);results.push('Production settings form creates a named translation scheme');
  const created=await call('/api/translate/schemes','POST',openai);assert.equal(created.status,200);const id=created.data.savedId;saved.push(id);assert.ok(id);
  const cfg=await call('/api/translate/config');assert.equal(cfg.data.ready,true);assert.equal(cfg.data.cfg.hasKey,true);assert.ok(!JSON.stringify(cfg).includes(secret));assert.ok(!JSON.stringify(cfg).includes('apiKeyEnc'));
  const privateSettings=execFileSync(adb,['-s',device,'exec-out','run-as','com.subfabric.android','cat','files/llm-settings.json'],{encoding:'utf8'});assert.ok(!privateSettings.includes(secret));assert.ok(privateSettings.includes('apiKeyEnc'));results.push('Android Keystore encryption, redacted config and named scheme persistence');
  assert.equal((await call('/api/translate/schemes/test','POST',{id,...openai,apiKey:''})).data.ok,true);
  assert.equal(requests.at(-1).auth,'Bearer '+secret);assert.equal(requests.at(-1).path,'/v1/chat/completions');
  c.close();execFileSync(adb,['-s',device,'shell','am','force-stop','com.subfabric.android']);execFileSync(adb,['-s',device,'shell','am','start','-n','com.subfabric.android/.MainActivity']);
  await wait(1000);for(let attempt=0;;attempt++){try{c=await connect();break;}catch(error){if(attempt>20)throw error;await wait(200);}}
  await until('window.androidReady&&!!window.__dbg');
  assert.equal((await call('/api/translate/config')).data.activeSchemeId,id);
  assert.equal((await call('/api/translate/test','POST')).data.ok,true);results.push('Cold restart restores scheme and successfully decrypts saved credentials');
  const one=await call('/api/translate/one','POST',{text:'Hello world.'});assert.equal(one.data.zh,'译文 Hello world.');assert.match(requests.at(-1).body.messages[0].content,/Hello = 你好/);results.push('Native OpenAI transport, saved-key reuse, glossary and single translation');
  const anthropic={...openai,name:'Android Anthropic test',provider:'anthropic',baseUrl:'http://127.0.0.1:19487',activate:false};
  assert.equal((await call('/api/translate/schemes/test','POST',anthropic)).data.ok,true);assert.equal(requests.at(-1).anthropic,secret);assert.equal(requests.at(-1).path,'/v1/messages');results.push('Native Anthropic Messages endpoint and x-api-key protocol');
  mode='redirect';const count=requests.length;const redir=await call('/api/translate/schemes/test','POST',{id,...openai,apiKey:''});assert.equal(redir.data.ok,false);assert.equal(requests.length,count+1);assert.match(redir.data.error,/重定向/);mode='error';const error=await call('/api/translate/schemes/test','POST',{id,...openai,apiKey:''});assert.equal(error.data.ok,false);assert.ok(!JSON.stringify(error).includes(secret));mode='valid';results.push('Redirects rejected and provider errors do not disclose keys');
  mode='delay';await c.evaluate(`window.cancelledTest=null;void androidRpc('llmChat',{requestId:'cancel-native-test',messages:[{role:'user',content:'cancel'}]}).then(()=>window.cancelledTest=false,e=>window.cancelledTest=e.message);true`);await wait(250);
  await c.evaluate(`androidRpc('llmCancel',{requestId:'cancel-native-test'})`);const cancelled=await until(`typeof window.cancelledTest==='string'&&window.cancelledTest`);assert.match(cancelled,/停止|超时/);mode='valid';results.push('In-flight native request cancellation');
  const bad=await call('/api/translate/schemes','POST',{...openai,name:'Reject public plaintext',baseUrl:'http://example.com/v1'});assert.equal(bad.status,500);assert.match(bad.data.error,/HTTPS/);
  const source=assFixture.split('\n').filter(line=>!line.startsWith('Dialogue:')||!line.includes('中文字幕')).join('\n');
  const p=await c.evaluate(`androidStudio.create('Android translation acceptance',${JSON.stringify(source)},'translation.ass')`);
  await c.evaluate(`location.hash='#/project/${p.id}'`);await until(`__dbg.state.project?.id==='${p.id}'&&__dbg.assPlayer.ready`);
  wrongOnce=true;const requestCount=requests.length;
  await c.evaluate(`import('/studio/android-translate.js').then(m=>m.showTranslation())`);await c.evaluate(`document.getElementById('android-translate-start').click()`);
  await until(`document.getElementById('android-translate-progress').textContent.startsWith('翻译完成')`);
  const translated=await c.evaluate(`androidStudio.load('${p.id}')`);
  assert.equal(translated.translationJob.status,'done');assert.equal(translationDocument(translated.text,'translation.ass').rows.filter(row=>!row.zh).length,0);assert.ok(requests.length>requestCount+1,'Misaligned multi-line replies must split and retry, never save shifted translations');
  assert.ok(translated.text.includes('Custom Metadata: keep this exact value'));assert.ok(translated.text.includes('{\\pos(640,160)\\bord4\\i1}Keep, this title'));results.push('Actual translation dialog: wrong source binding rejected, split retry and cumulative ASS persistence');
  await fs.writeFile(new URL('./out/translation-wsa-report.json',import.meta.url),JSON.stringify({projectId:p.id,results},null,2));
  await c.evaluate(`document.getElementById('android-translate-stop').click()`);
  await wait(500);
  const largeDoc=new AssDoc(assFixture.split('\n').filter(line=>!line.startsWith('Dialogue:')).join('\n'));
  for(let i=0;i<12;i++)largeDoc.appendEvent({style:'Default',start:i*3,end:i*3+2,text:'Line '+i});
  const partial=await c.evaluate(`androidStudio.create('Android interrupted translation',${JSON.stringify(largeDoc.serialize())},'partial.ass')`);
  await c.evaluate(`location.hash='#/project/${partial.id}'`);await until(`__dbg.state.project?.id==='${partial.id}'&&__dbg.assPlayer.ready`);
  mode='partial';partialCalls=0;
  await c.evaluate(`import('/studio/android-translate.js').then(m=>m.showTranslation())`);await c.evaluate(`document.getElementById('android-translate-start').click()`);
  await until(`androidStudio.load('${partial.id}').then(p=>p.translationJob?.done===5)`);
  // Kill while the next request is in flight: only the completed first batch may remain committed.
  c.close();execFileSync(adb,['-s',device,'shell','am','force-stop','com.subfabric.android']);mode='valid';execFileSync(adb,['-s',device,'shell','am','start','-n','com.subfabric.android/.MainActivity']);
  await wait(1000);for(let attempt=0;;attempt++){try{c=await connect();break;}catch(error){if(attempt>20)throw error;await wait(200);}}
  await until(`window.androidReady&&__dbg.state.project?.id==='${partial.id}'&&__dbg.assPlayer.ready`);
  const interrupted=await c.evaluate(`androidStudio.load('${partial.id}')`);assert.equal(interrupted.translationJob.done,5);assert.equal(translationDocument(interrupted.text,'partial.ass').rows.filter(row=>!row.zh).length,7);
  await c.evaluate(`import('/studio/android-translate.js').then(m=>m.showTranslation())`);
  assert.match(await c.evaluate(`document.getElementById('android-translate-progress').textContent`),/中断/);
  await c.evaluate(`document.getElementById('android-translate-start').click()`);await until(`document.getElementById('android-translate-progress').textContent.startsWith('翻译完成')`);
  const resumed=await c.evaluate(`androidStudio.load('${partial.id}')`);assert.equal(resumed.translationJob.done,7);assert.equal(translationDocument(resumed.text,'partial.ass').rows.filter(row=>!row.zh).length,0);
  results.push('Kill during batch 2 preserves 5 committed rows; cold reopen translates only the remaining 7');
  await c.evaluate(`document.getElementById('android-translate-stop').click()`);await wait(300);
  await until(`__dbg.state.project?.id==='${partial.id}'&&__dbg.state.items.length>0`);
  prefix='单句重译 ';
  await c.evaluate(`__dbg.panel._showCardMenu(20,180,__dbg.state.items[0]);document.querySelector('#card-menu [data-act="retranslate"]').click()`);
  await until(`__dbg.state.assDoc.serialize().includes('单句重译')`);await c.evaluate('__subfabricFlushSave()');
  const singleSaved=await c.evaluate(`androidStudio.load('${partial.id}')`);assert.ok(singleSaved.text.includes('单句重译'));results.push('Production subtitle context menu retranslates and saves the selected row');
  const conflict=await c.evaluate(`androidStudio.create('Android translation conflict',${JSON.stringify(source)},'conflict.ass')`);
  await c.evaluate(`location.hash='#/project/${conflict.id}'`);await until(`__dbg.state.project?.id==='${conflict.id}'&&__dbg.assPlayer.ready`);
  responseDelay=500;
  await c.evaluate(`window.lateTranslation=null;void fetch('/api/translate/one',{method:'POST',body:JSON.stringify({text:'late result'})}).then(async r=>window.lateTranslation={status:r.status,data:await r.json()});true`);
  await wait(100);await c.evaluate(`location.hash='#/project/${partial.id}'`);
  await until(`window.lateTranslation!==null`);assert.equal(await c.evaluate('window.lateTranslation.status'),409);results.push('A late single-line result is rejected after switching projects');
  responseDelay=0;await c.evaluate(`location.hash='#/project/${conflict.id}'`);await until(`__dbg.state.project?.id==='${conflict.id}'&&__dbg.assPlayer.ready`);
  responseDelay=500;await c.evaluate(`import('/studio/android-translate.js').then(m=>m.showTranslation())`);await c.evaluate(`document.getElementById('android-translate-start').click()`);await wait(100);
  const changedText=source+'\n; concurrent edit preserved';await c.evaluate(`androidStudio.update('${conflict.id}',{text:${JSON.stringify(changedText)}})`);
  await until(`document.getElementById('android-translate-progress').textContent.includes('CONFLICT')`);responseDelay=0;
  assert.equal((await c.evaluate(`androidStudio.load('${conflict.id}')`)).text,changedText);results.push('A concurrent subtitle revision rejects a stale translated result without overwriting edits');
  await c.evaluate(`document.getElementById('android-translate-stop').click()`);
  await fs.writeFile(new URL('./out/translation-wsa-report.json',import.meta.url),JSON.stringify({projectId:p.id,resumedProject:partial.id,results},null,2));
  console.log(JSON.stringify({projectId:p.id,results},null,2));
}finally{
  await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
  mode='valid';for(const id of saved){await call('/api/translate/schemes/'+id,'DELETE').catch(()=>{});}
  if(activeBefore)await call('/api/translate/schemes/'+activeBefore+'/activate','POST').catch(()=>{});
  c.close();execFileSync(adb,['-s',device,'reverse','--remove','tcp:19487']);server.closeAllConnections();server.close();
}
