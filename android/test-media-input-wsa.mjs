// Run after selecting the two isolated same-name fixtures through the real system chooser.
// Keep their actual File objects as window.mediaInputA/B; no synthetic File substitution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {connect} from './cdp.mjs';
import {assFixture} from './ass-fixture.mjs';

const fixtures=JSON.parse(await fs.readFile('android/out/media-input-fixtures.json','utf8'));
const batch=process.argv.includes('--batch');
const c=await connect(),results=[];
const rpc=(action,payload={})=>c.evaluate(`androidRpc(${JSON.stringify(action)},${JSON.stringify(payload)})`);
const adb=process.env.SUBFABRIC_ADB||'adb',device=process.env.SUBFABRIC_DEVICE||'127.0.0.1:58526';
try{
 if(batch)await c.evaluate('window.mediaInputA=mediaInputTestFiles[0];window.mediaInputB=mediaInputTestFiles[1]');
 const files=await c.evaluate(`[mediaInputA,mediaInputB].map(f=>({name:f.name,size:f.size}))`);
 if(!batch)assert.equal(files[0].name,files[1].name);assert.notEqual(files[0].size,files[1].size);
 const imported=[];
 for(const [index,key]of ['A','B'].entries()){
  const result=await c.evaluate(`fetch('/api/upload-video?name='+encodeURIComponent(mediaInput${key}.name),{method:'POST',body:mediaInput${key}}).then(async r=>({status:r.status,data:await r.json()}))`);
  assert.equal(result.status,200,JSON.stringify(result));
  const bytes=execFileSync(adb,['-s',device,'exec-out','run-as','com.subfabric.android','cat',`files/media/${result.data.path}.media`],{maxBuffer:32*1024*1024});
  const hash=crypto.hash('sha256',bytes),fixture=fixtures.find(f=>f.bytes===files[index].size);
  assert.equal(hash,fixture.sha);assert.equal(bytes.length,files[index].size);
  imported.push({...result.data,sha256:hash,bytes:bytes.length});
 }
 assert.notEqual(imported[0].path,imported[1].path);
 results.push(batch?'Photo picker multi-selection returns both exact videos with ordered File/URI binding':'Sequential same-name File selections retain the exact respective native URI and bytes');
 if(!batch){await assert.rejects(rpc('uploadSelected',{name:files[0].name}),/媒体名称重复/);
 results.push('Legacy ambiguous name-only lookup rejects instead of silently importing another video');}
 const project=await rpc('studioCreate',{project:{name:'Android media input fixture '+Date.now(),subtitleName:'fixture.ass',text:assFixture,originalText:assFixture,mediaId:imported[0].path,mediaName:'old.mp4',notes:[],oplog:[],createdAt:Date.now()}});
 const linked=await c.evaluate(`fetch('/api/projects/${project.id}/relink',{method:'POST',body:JSON.stringify({videoPath:${JSON.stringify(imported[1].path)},name:'sf10.mp4'})}).then(async r=>({status:r.status,data:await r.json()}))`);
 assert.equal(linked.status,200);assert.equal(linked.data.video.path,imported[1].path);assert.equal(linked.data.video.name,'sf10.mp4');
 const after=await rpc('studioLoad',{id:project.id});assert.equal(after.text,assFixture);assert.equal(after.originalText,assFixture);assert.equal(after.mediaId,imported[1].path);
 assert.equal(after.hasAudio,false);assert.equal(after.hasPeaks,false);
 const invalid=await c.evaluate(`fetch('/api/projects/${project.id}/relink',{method:'POST',body:'{}'}).then(r=>r.status)`);assert.equal(invalid,400);
 assert.equal((await rpc('studioLoad',{id:project.id})).mediaId,imported[1].path);
 results.push('Shared relink videoPath/name binds the chosen media, preserves ASS and rejects empty selection');
 await fs.writeFile(`android/out/media-input-${batch?'batch-':''}wsa-results.json`,JSON.stringify({results,imported,project:project.id},null,2));
 console.log(JSON.stringify(results,null,2));
}finally{c.close();}
