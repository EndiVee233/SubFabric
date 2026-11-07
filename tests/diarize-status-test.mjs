import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const server=fs.readFileSync(new URL('../editor/server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const project=fs.readFileSync(new URL('../editor/js/project.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const extract=(source,name)=>{const start=source.indexOf('function '+name+'(');assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }\n',start)+4);};
const context=vm.createContext({});vm.runInContext(extract(server,'diarizeProgressView'),context);
const detail={phase:'inference',pct:63,msg:'声纹提取与聚类…',provider:'cpu',durationSec:3780,
  startedAt:1000,phaseStartedAt:2000,lastProgressAt:4000,lastWorkerAt:9000,done:60,total:100};
const recent=context.diarizeProgressView(detail,10000),waiting=context.diarizeProgressView(detail,45000);
assert.equal(recent.reportAgeSec,1);assert.equal(recent.progressAgeSec,6);
assert.match(recent.message,/模型分块 60\/100（60%）/);assert.match(recent.message,/CPU/);
assert.equal(waiting.pct,recent.pct,'elapsed time cannot advance percent');
assert.equal(waiting.done,60);assert.match(waiting.message,/暂未收到新状态/);
assert.match(waiting.message,/不能据此确认卡死/);
assert.match(context.diarizeProgressView({...detail,lastWorkerAt:0},5000).message,/等待工作进程首次上报/);
const nodes=new Map();
const ui=vm.createContext({$:id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,classList:{toggle(){}}});return nodes.get(id);},
  dpParseTransfer:()=>({eta:null}),dpClock:s=>String(s),dpStepName:s=>s,Date});
vm.runInContext(extract(project,'dpRenderDetail'),ui);
const draft={status:'running',stage:'区分说话人中',progress:84,startedAt:new Date(Date.now()-120000).toISOString(),
  message:recent.message,diarizeProgress:recent};
ui.dpRenderDetail('np',draft);
assert.equal(nodes.get('#np-eta').textContent,'','weighted draft percent must not fabricate diarization ETA');
assert.equal(nodes.get('#np-msg').textContent,recent.message);
ui.dpRenderDetail('np',{...draft,stage:'语音识别中',diarizeProgress:null});
assert.match(nodes.get('#np-eta').textContent,/剩余约/,'other task estimates remain available');
console.log('Diarization status: native counters, report freshness, honest heartbeat and draft ETA passed');
