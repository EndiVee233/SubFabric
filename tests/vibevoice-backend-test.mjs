import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {isolatedServer} from './helpers/isolated-server.mjs';

const source=fs.readFileSync(path.resolve(import.meta.dirname,'../editor/server.js'),'utf8');
function block(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing boundary ${end}`);return source.slice(a,b);}
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subfabric-vibe-hash-'));
try{
  fs.writeFileSync(path.join(folder,'model.bin'),'NF4 fixture');
  const context=vm.createContext({fs,path,crypto});
  vm.runInContext(block('async function verifyDownloadedModelFiles(', 'function modelReady('),context);
  const hash=crypto.createHash('sha256').update('NF4 fixture').digest('hex');
  await context.verifyDownloadedModelFiles(folder,{fileSizes:{'model.bin':11},fileHashes:{'model.bin':hash}});
  await assert.rejects(context.verifyDownloadedModelFiles(folder,{fileSizes:{'model.bin':12}}),/大小校验失败/);
  await assert.rejects(context.verifyDownloadedModelFiles(folder,{fileHashes:{'model.bin':'0'.repeat(64)}}),/SHA-256/);
  assert.equal(fs.readFileSync(path.join(folder,'model.bin'),'utf8'),'NF4 fixture','Failed validation preserves file');
}finally{fs.rmSync(folder,{recursive:true,force:true});}

let selection='vibe';const vibe={id:'vibe',engine:'vibevoice'},other={id:'other',engine:'sherpa-onnx'};
const ctx=vm.createContext({readAsrSettings:()=>({selectedModel:selection}),modelById:id=>id==='vibe'?vibe:id==='other'?other:null,
  modelReady:id=>id==='other',draftAllowedOf:()=>true,ASR_MODELS:[other,vibe]});
vm.runInContext(block('function resolveAsrModel()', '/** 项目初稿用的模型'),ctx);
assert.equal(ctx.resolveAsrModel(),null,'Unavailable VibeVoice must never select another engine');
selection='other';assert.equal(ctx.resolveAsrModel().id,'other');

const server=await isolatedServer({env:{SUBFABRIC_VIBEVOICE_PYTHON:path.join(os.tmpdir(),'missing-vibe-runtime.exe')}});
try{
  server.settings({selectedModel:'vibevoice-asr-4bit'});
  const response=await server.call('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:true,modelId:'vibevoice-asr-4bit',video:{path:'missing.mp4'}})});
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/VibeVoice.*CUDA/);
  assert.equal((await(await server.call('/api/projects')).json()).projects.length,0,'No project created when runtime is missing');
}finally{await server.close();}
console.log('vibevoice-backend: hash/size validation, no model fallback, cold-start missing runtime gate passed');
