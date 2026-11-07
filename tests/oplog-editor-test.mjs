import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import crypto from 'node:crypto';
import {escapeHtml} from '../editor/js/util.js';
import {captureLogScope} from '../editor/js/log-import.js';
const source=fs.readFileSync(new URL('../editor/js/main.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('let opLogPending ='),source.indexOf('/* 两个板块的切换 */',source.indexOf('let opLogPending =')));
function setup(fetcher) {
  const elements=new Map(['oplog-view','oplog-empty','oplog-summary','oplog-cnt','btn-oplog-export','btn-oplog-more','oplog-export-format','log-pane-op'].map(id=>[id,{innerHTML:'',textContent:'',hidden:false,disabled:false,value:'csv',addEventListener(){},insertAdjacentHTML(pos,html){this.innerHTML+=html;}}]));
  const state={project:{id:'p-a',meta:{name:'稿件/测试'}}},requests=[],downloads=[],messages=[];
  const ctx=vm.createContext({state,crypto,escapeHtml,captureLogScope,Blob,AbortSignal,
    document:{getElementById:id=>elements.get(id),addEventListener(){}},window:{addEventListener(){}},
    navigator:{sendBeacon:()=>true},setTimeout:()=>1,clearTimeout(){},
    fetch:async(url,init={})=>{requests.push({url,init});return fetcher(url,init);},
    download:(...args)=>downloads.push(args),toast:msg=>messages.push(msg)});
  vm.runInContext(block+'\nglobalThis.api={logOp,flushOpLog,flushOpLogOnHide,renderOpLog,loadOpLog,exportOpLog,opLogExportText,opActionLabel,opLogViewVisible,pending:()=>opLogPending};',ctx);
  return {api:ctx.api,state,elements,requests,downloads,messages};
}
const response=data=>({ok:true,json:async()=>data});
const entries=[{t:'2026-11-06T01:02:03Z',action:'edit',target:'<unsafe>',detail:'=HYPERLINK("bad")',why:'line1\nline2'},
  {t:'2026-11-06T01:03:03Z',action:'__proto__',detail:'quotes,"newline\nkept'}];
const stats={total:2,byAction:JSON.parse('{"edit":1,"__proto__":1}')};
{
  const {api,elements}=setup(()=>response({}));
  assert.equal(api.opLogViewVisible(),false,'hidden logs tab does not trigger background list reads');
  elements.set('tab-logs',{classList:{contains:()=>true}});assert.equal(api.opLogViewVisible(),true);
  api.renderOpLog(entries,stats);
  assert.ok(elements.get('oplog-summary').innerHTML.includes('总操作次数：2'));
  assert.ok(elements.get('oplog-summary').innerHTML.includes('编辑字幕：1'));
  assert.ok(elements.get('oplog-view').innerHTML.includes('&lt;unsafe&gt;'));
  assert.equal(api.opActionLabel('__proto__'),'__proto__');
  const csv=api.opLogExportText(entries,stats,'csv',{id:'p',name:'Test'});
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"总操作次数","2"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'),'spreadsheet formula is exported as text');
  assert.ok(csv.includes('line1\nline2'),'multiline details survive');
  const json=JSON.parse(api.opLogExportText(entries,stats,'json',{id:'p'}));
  assert.deepEqual(json.entries,entries);assert.deepEqual(json.stats,stats);
  api.renderOpLog([],{total:0,byAction:{}});assert.equal(elements.get('oplog-empty').hidden,false);
}
{
  let loads=0;const panel={},ctx=vm.createContext({panel,workloadPanel:null,pruneUnusedRoles(){},window:{__onLogsTabShown(){loads++;}}});
  const hook=source.match(/^panel\.onTabChange = \(name\) => \{\n[\s\S]*?^};/m)?.[0];assert.ok(hook);
  vm.runInContext(hook,ctx);panel.onTabChange('logs');panel.onTabChange('subs');assert.equal(loads,1,'first logs tab entry loads statistics');
}
{
  let failure=true;
  const x=setup(()=>failure?{ok:false,json:async()=>({ok:false})}:response({ok:true}));
  x.api.logOp('edit','A');x.state.project={id:'p-b'};
  await assert.rejects(x.api.flushOpLog(),/保存失败/);assert.equal(x.api.pending().length,1);
  const first=JSON.parse(x.requests[0].init.body).entries[0];failure=false;await x.api.flushOpLog();
  assert.equal(x.requests[1].url,'/api/projects/p-a/oplog','queued operation stays with its original project');
  assert.equal(JSON.parse(x.requests[1].init.body).entries[0].id,first.id,'retry keeps idempotency key');
  assert.equal(x.api.pending().length,0);
}
{
  let release;const gate=new Promise(r=>{release=r;}),written=[];let posts=0;
  const x=setup(async(url,init)=>{
    if(init.method==='POST'){posts++;if(posts===1)await gate;written.push(...JSON.parse(init.body).entries);return response({ok:true});}
    assert.equal(written.length,25,'export GET waits for every queued/in-flight batch');
    return response({entries:written,stats:{total:written.length,byAction:{edit:written.length}}});
  });
  for(let i=0;i<25;i++)x.api.logOp('edit','row '+i);
  const exporting=x.api.exportOpLog();assert.equal(x.downloads.length,0);release();await exporting;
  assert.equal(written.length,25);assert.equal(new Set(written.map(e=>e.id)).size,25);
  assert.equal(x.downloads.length,1);assert.ok(x.downloads[0][0].startsWith('稿件_测试-操作日志'));
}
{
  let reads=0;
  const x=setup(url=>{reads++;const q=new URL('http://local'+url).searchParams;
    if(reads===1){assert.equal(q.get('limit'),'100');return response({entries:[entries[1]],stats,snapshotTotal:540,nextOffset:100,hasMore:true});}
    assert.equal(q.get('until'),'540');assert.equal(q.get('offset'),'100');
    return response({entries:[entries[0]],stats:{total:541,byAction:{edit:540,other:1}},snapshotTotal:540,nextOffset:200,hasMore:true});
  });
  assert.equal(await x.api.loadOpLog(),true);assert.equal(await x.api.loadOpLog(true),true);
  assert.equal((x.elements.get('oplog-view').innerHTML.match(/class="oplog-row"/g)||[]).length,2);
  assert.ok(x.elements.get('oplog-summary').innerHTML.includes('541'),'statistics cover all stored entries, not the rendered page');
}
console.log('oplog-editor: type/total counts, complete CSV/JSON, escaping, pending flush/retry/project ownership and pagination passed');
