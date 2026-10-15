import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolatedServer } from './helpers/isolated-server.mjs';
// 只使用临时目录、虚构凭证和回环假厂商，不调用真实模型或服务商。
const upstream = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(JSON.parse(body).model, 'test-model');
  assert.equal(req.headers.authorization, 'Bearer fixture-key-a');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const server = await isolatedServer({ source: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
const settingsFile = path.join(server.root, 'asr/settings.json');
async function call(url = '/api/translate/schemes', method = 'GET', payload, status = 200) {
  const response = await server.call(url, { method, headers: { 'Content-Type': 'application/json' }, ...(payload ? {body:JSON.stringify(payload)} : {}) });
  const data = await response.json();
  assert.equal(response.status, status, method + ' ' + url + ': ' + (data.error || ''));
  assert.ok(!JSON.stringify(data).includes('fixture-key'), 'no key leaks in API response');
  assert.ok(!JSON.stringify(data).includes('apiKeyEnc'), 'no ciphertext returned');
  return data;
}
try {
  const before = {translate:{provider:'custom',baseUrl:'http://localhost:9999/v1',model:'legacy'},confidence:{mode:'full'},fetch:{quality:'best'}};
  server.settings(before);
  assert.deepEqual(await call(), {activeSchemeId:'',schemes:[]});
  const read = () => JSON.parse(fs.readFileSync(settingsFile));
  assert.deepEqual(read(), before, 'empty list does not migrate old config or write settings');
  const config = {name:'方案 A',provider:'custom',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,model:'test-model',apiKey:'fixture-key-a',glossary:'##简体\nhello=你好\n##English\n你好=hello',glossaryLang:'English',prompt:'Prompt A',activate:true};
  await call(undefined,'POST',{...config,name:''},400);
  await call(undefined,'POST',{...config,provider:''},400);
  await call(undefined,'POST',{...config,baseUrl:'file:///bad'},400);
  assert.deepEqual(read(),before,'failed saves leave config unchanged');
  const a=await call(undefined,'POST',config), aid=a.savedId;
  assert.equal(a.activeSchemeId,aid); assert.equal(a.schemes[0].name,'方案 A'); assert.equal(a.schemes[0].hasKey,true);
  assert.equal(read().translate.glossaryLang,'English'); assert.equal(read().translate.glossary,config.glossary);
  assert.ok(/^(dpapi|aes):/.test(read().translateSchemes[0].apiKeyEnc));
  assert.ok(!fs.readFileSync(settingsFile,'utf8').includes('fixture-key-a'),'only ciphertext on disk');
  const b=await call(undefined,'POST',{...config,name:'方案 B',apiKey:'fixture-key-b',model:'second-model',glossary:'term=术语',activate:false}),bid=b.savedId;
  assert.equal(b.activeSchemeId,aid); assert.equal(read().translate.model,'test-model');
  await call(undefined,'POST',config,409);
  const keyBefore=read().translateSchemes.find(item=>item.id===aid).apiKeyEnc;
  await call('/api/translate/schemes/'+aid,'PUT',{name:'新方案 A',temperature:10,contextRows:-1,apiKey:''});
  assert.equal(read().translateSchemes.find(item=>item.id===aid).apiKeyEnc,keyBefore,'blank key preserves saved key');
  assert.equal(read().translate.temperature,2); assert.equal(read().translate.contextRows,0);
  await call('/api/translate/schemes/'+bid+'/activate','POST',{});
  assert.equal(read().translate.model,'second-model'); assert.equal(read().translate.glossary,'term=术语');
  const diskBeforeTest=fs.readFileSync(settingsFile);
  const result=await call('/api/translate/schemes/test','POST',{...config,id:aid,name:'',apiKey:'',activate:true});
  assert.equal(result.ok,true); assert.equal(result.reply,'ok');
  assert.deepEqual(fs.readFileSync(settingsFile),diskBeforeTest,'test never saves or activates draft');
  await call('/api/translate/schemes/'+bid,'PUT',{apiKeyClear:true});
  assert.equal(read().translate.apiKeyEnc,''); assert.equal((await call()).schemes.find(item=>item.id===bid).hasKey,false);
  await call('/api/translate/schemes/no-such-id','PUT',{name:'bad'},404);
  const legacy=await call('/api/translate/config','POST',{model:'legacy-change'});
  assert.equal(legacy.cfg.model,'legacy-change'); assert.equal((await call()).activeSchemeId,'','old UI override cannot mislabel active scheme');
  await call('/api/translate/schemes/'+aid+'/activate','POST',{});
  await call('/api/translate/schemes/'+bid,'DELETE');
  assert.equal(read().translateSchemeId,aid,'deleting inactive scheme preserves active');
  await call('/api/translate/schemes/'+aid,'DELETE');
  assert.deepEqual((await call()).schemes,[]); assert.deepEqual(read().translate,{});
  assert.deepEqual(read().confidence,before.confidence); assert.deepEqual(read().fetch,before.fetch);
  console.log('Named translation schemes: CRUD, independent glossary/model/keys, activate, validation, test without saving, encrypted storage and legacy compatibility passed');
} finally { await server.close(); await new Promise(resolve => upstream.close(resolve)); }
