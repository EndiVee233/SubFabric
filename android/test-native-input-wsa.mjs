// After choosing an isolated video through the native file-input probe, verify its real bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {connect} from './cdp.mjs';

const c=await connect();
try{
  const result=await c.evaluate(`(async()=>{
    const input=document.getElementById('native-picker-probe'),file=input?.files[0];if(!file)throw Error('Select the isolated native picker fixture first');
    const url=URL.createObjectURL(file),v=document.createElement('video');v.preload='metadata';v.src=url;document.body.append(v);
    await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=()=>reject(Error(v.error.message));setTimeout(()=>reject(Error('Native preview timeout')),5000)});
    const upload=await fetch('/api/upload-video?name='+encodeURIComponent(file.name),{method:'POST',body:file}).then(r=>r.json());
    const result={bytes:file.size,url,upload,duration:v.duration,width:v.videoWidth};v.remove();return result;
  })()`);
  assert.equal(new URL(result.url).pathname,'/media/'+result.upload.path,'Preview and upload reuse one native import');
  assert.equal(result.width,640);assert.equal(result.duration,8);
  const adb=process.env.SUBFABRIC_ADB||'adb',device=process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526';
  const actual=execFileSync(adb,['-s',device,'exec-out','run-as','com.subfabric.android','cat',`files/media/${result.upload.path}.media`],{maxBuffer:2*1024*1024});
  const fixture=await fs.readFile('android/out/export-source.mp4');assert.equal(result.bytes,fixture.length);assert.deepEqual(actual,fixture);
  await fs.writeFile('android/out/native-input-wsa-results.json',JSON.stringify({bytes:actual.length,sha256:createHash('sha256').update(actual).digest('hex'),duration:result.duration,width:result.width,sameImport:true},null,2));console.log('Native file chooser: exact source bytes, 640px/8s preview, same import for upload');
}finally{c.close();}
