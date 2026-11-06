import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {isolatedServer} from './helpers/isolated-server.mjs';
const server=await isolatedServer();
try {
  const dir=path.join(server.root,'projects','p-log');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify({id:'p-log',name:'Log fixture'}));
  const old=Array.from({length:530},(_,i)=>({t:'2026-11-06T00:00:00Z',action:i%2?'split':'edit',target:'old-'+i}));
  fs.writeFileSync(path.join(dir,'oplog.json'),JSON.stringify(old));
  const post=entries=>server.call('/api/projects/p-log/oplog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries})});
  const batch=Array.from({length:200},(_,i)=>({id:'fixture-'+i,action:'adjust',detail:'new-'+i}));
  const saved=await (await post(batch)).json();assert.equal(saved.written,200);
  let all=await (await server.call('/api/projects/p-log/oplog')).json();
  assert.equal(all.entries.length,730,'all records beyond 500 are retained');assert.equal(all.entries[0].target,'old-0');
  assert.deepEqual(all.stats,{total:730,byAction:{edit:265,split:265,adjust:200}});
  assert.equal((await (await post(batch)).json()).written,0,'retries do not inflate operation counts');
  const first=await (await server.call('/api/projects/p-log/oplog?limit=100')).json();assert.equal(first.entries.length,100);
  assert.equal(first.stats.total,730);assert.equal(first.nextOffset,100);
  await post([{id:'new-during-pagination',action:'import'}]);
  const second=await (await server.call(`/api/projects/p-log/oplog?limit=100&offset=100&until=${first.snapshotTotal}`)).json();
  assert.equal(second.entries.at(-1).id,'fixture-99','new append does not shift the older page');
  assert.equal(second.stats.total,731);assert.equal(second.stats.byAction.import,1);
  const seen=[];for(let offset=0;offset<731;offset+=100){const page=await(await server.call(`/api/projects/p-log/oplog?limit=100&offset=${offset}&until=731`)).json();seen.push(...page.entries);}
  assert.equal(seen.length,731);assert.equal(new Set(seen.map(e=>e.id||e.target)).size,731);
  all=await(await server.call('/api/projects/p-log/oplog')).json();assert.equal(all.entries.length,731);
  const bad='{"broken":';fs.writeFileSync(path.join(dir,'oplog.json'),bad);
  assert.equal((await post([{action:'edit'}])).status,500);assert.equal(fs.readFileSync(path.join(dir,'oplog.json'),'utf8'),bad,'broken history is never overwritten with an empty log');
  console.log('oplog-editor-api: >500 preservation, exact type/total counts, batching/idempotency, stable pages and corrupt history protection passed');
} finally {await server.close();}
