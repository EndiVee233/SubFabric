import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), params = require('../editor/asr-params.js');
const source = fs.readFileSync(new URL('../editor/server.js', import.meta.url), 'utf8');
function body(name) { const a=source.indexOf('function '+name+'('); assert.ok(a>=0); return source.slice(a,source.indexOf('\n}',a)+2); }
const manifest = source.slice(source.indexOf('const ASR_MODELS ='), source.indexOf('const ALIGNER_MODELS ='));
const modelCtx=vm.createContext({path,ASR_DIR:'fixture-asr'});
vm.runInContext(manifest+';globalThis.models=ASR_MODELS;',modelCtx);
const model=modelCtx.models.find(m=>m.engine==='whisperx'); assert.ok(model);
assert.equal(model.fileSizes['model.bin'],modelCtx.models.find(m=>m.engine==='faster-whisper').fileSizes['model.bin']);
assert.ok(model.files.includes('align/en/model.safetensors'));
assert.equal(model.fileRepos['align/en/model.safetensors'],'facebook/wav2vec2-base-960h');
assert.equal(model.fileSources['align/en/config.json'],'config.json');
assert.ok(model.draftAllowed);
assert.equal(params.defaultsFor(model).batchSize,4);
assert.equal(params.resolveFor(model,{batchSize:1000}).batchSize,32);
assert.equal(params.normalizeFor(model,{computeType:'cpu'}).ok,false);
const ctx=vm.createContext({path,ASR_DIR:'fixture-asr',WHISPERX_RUNTIME:{dir:'fixture-runtime'},
  modelParamsFor:m=>params.resolveFor(m,{batchSize:2,language:'auto'}),isRetiredEngine:()=>false,
  whisperxPython:()=> 'isolated python.exe',ttaArgs:()=>{throw Error('WhisperX must not receive TTA');}});
const engineCode=source.slice(source.indexOf('const asrEngineArgs ='),source.indexOf('/** 子进程退出码'));
vm.runInContext(engineCode+';globalThis.make=asrEngineArgs;globalThis.args=asrArgsFor;',ctx);
const ea=ctx.make(model),args=Array.from(ctx.args(ea,'model path','audio path','out.json','full'));
assert.equal(ea.python,'isolated python.exe');assert.ok(ea.script.endsWith('whisperx_asr.py'));
assert.equal(args[args.indexOf('--batch-size')+1],'2');assert.equal(args[args.indexOf('--language')+1],'auto');
assert.ok(!args.includes('--tta')&&!args.includes('--threads')&&!args.includes('--hotwords-file'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sf-whisperx-contract-'));
try{
  const python=path.join(temp,'independent python.exe');fs.writeFileSync(python,'fixture');
  const qwen=path.join(temp,'qwen.txt');fs.writeFileSync(qwen,'keep existing runtime');
  const downloads=new Map(),commands=[];let badProbe=false;
  const runtime=vm.createContext({fs,path,process:{env:{SUBFABRIC_WHISPERX_PYTHON:python},platform:'win32'},
    WHISPERX_RUNTIME:{key:'runtime:whisperx',version:'3.8.6',dir:temp},ASR_DIR:'fixture-asr',EMBEDDED_PY:{pipIndex:'fixture-index'},
    whisperxPython:()=>python,
    dlState(key,value){if(value)downloads.set(key,value);return downloads.get(key)||{};},
    async runCapture(exe,args,_timeout,_line,env){commands.push([exe,args,env]);return{stdout:args.includes('--prepare-runtime')?JSON.stringify({version:'3.8.6',cuda:!badProbe}):'pip'};},
    async pipInstallRetry(exe,args,_timeout,_line,_tries,env){commands.push([exe,args,env]);},});
  vm.runInContext(body('whisperxRuntimeOk')+'\n'+body('startWhisperxRuntimeInstall')+';globalThis.install=startWhisperxRuntimeInstall;globalThis.ready=whisperxRuntimeOk;',runtime);
  assert.equal(runtime.ready(),false);runtime.install();
  for(let i=0;i<100&&downloads.get('runtime:whisperx').running;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(downloads.get('runtime:whisperx').pct,100,JSON.stringify(downloads.get('runtime:whisperx')));assert.equal(runtime.ready(),true);
  assert.ok(commands.every(c=>c[0]===python));assert.ok(commands.some(c=>c[1].includes('whisperx==3.8.6')));
  assert.ok(commands.every(c=>c[2].TMP.startsWith(temp)&&c[2].PIP_CACHE_DIR.startsWith(temp)),'installer caches/temp stay in its own runtime');
  assert.equal(fs.readFileSync(qwen,'utf8'),'keep existing runtime');
  badProbe=true;runtime.install();
  for(let i=0;i<100&&downloads.get('runtime:whisperx').running;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(runtime.ready(),false,'failed reinstallation invalidates the prior readiness marker');
  assert.ok(downloads.get('runtime:whisperx').error);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
const security=require('../desktop/security.cjs');assert.equal(security.sourcePath('asr/whisperx_asr.py'),'asr/whisperx_asr.py');
assert.throws(()=>security.sourcePath('asr/runtime-whisperx/ready.json'));
assert.match(source,/const python = ea\.python/,'benchmark uses independent interpreter');
assert.match(source,/spawn\(ea\.python \|\| ASR_PY, asrArgs/,'re-identification uses independent interpreter');
assert.match(source,/const pyExe = asrEngineArgs\(model\)\.python \|\| ASR_PY/,'draft and its slices use independent interpreter');
assert.match(source,/!\['qwen', 'whisperx'\]\.includes\(model\.engine\)/,'WhisperX does not get aligned a second time by Qwen');
console.log('WhisperX: manifest, shared parameters/arguments, isolated runtime success/failure, dispatch and packaging boundaries passed');
