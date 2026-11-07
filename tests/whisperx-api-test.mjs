import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const server=await isolatedServer();
try{
  const status=await(await server.call('/api/asr/status')).json();
  const model=status.models.find(m=>m.id==='whisperx-large-v2');
  assert.ok(model);assert.equal(model.engine,'whisperx');assert.equal(model.nativeWordLevel,true);
  assert.equal(model.draftAllowed,true);assert.equal(model.runtimeKey,'runtime:whisperx');
  assert.equal(model.needRuntime,true);assert.equal(model.runtimeReady,false);assert.equal(model.ready,false);
  assert.ok(model.missing.includes('align/en/model.safetensors'));
  assert.equal(model.params.count,7);
  const query='/api/asr/params?model=whisperx-large-v2';
  const initial=await(await server.call(query)).json();
  assert.equal(initial.ok,true);assert.equal(initial.values.batchSize,4);assert.equal(initial.values.language,'en');
  const saved=await(await server.call('/api/asr/params',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'whisperx-large-v2',values:{batchSize:2,computeType:'int8_float16',language:'auto'}})})).json();
  assert.equal(saved.ok,true);assert.equal(saved.values.batchSize,2);
  const changed=await(await server.call('/api/asr/status')).json();
  assert.match(changed.models.find(m=>m.id==='whisperx-large-v2').params.summary,/批量 2/);
  const again=await(await server.call(query)).json();assert.equal(again.values.computeType,'int8_float16');
  const settings=JSON.parse(fs.readFileSync(path.join(server.root,'asr/settings.json'),'utf8'));
  assert.equal(settings.modelParams['whisperx-large-v2'].batchSize,2);
  const bad=await server.call('/api/asr/params',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'whisperx-large-v2',values:{computeType:'cpu'}})});assert.equal(bad.status,400);
  const reset=await(await server.call('/api/asr/params',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'whisperx-large-v2',reset:true})})).json();assert.equal(reset.values.batchSize,4);
  // No download/install endpoint is called by this test: real packages and GPU are unnecessary.
  console.log('WhisperX API: manifest/readiness, model/runtime separation, persisted parameters, validation and reset passed');
}finally{await server.close();}
