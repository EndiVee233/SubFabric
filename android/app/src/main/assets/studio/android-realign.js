import {AssDoc} from '/editor/js/ass.js';
import {analyzeKaraoke,realignTargetKey,splitEnglishWords} from '/editor/js/karaoke.js';
import {alignmentRows,alignedSrtDocument} from '/editor/android-alignment-doc.js';
const rpc=(a,p={})=>window.androidRpc(a,p),wait=ms=>new Promise(r=>setTimeout(r,ms));
const identity=p=>({projectId:p.id,sourceRevision:p.revision,mediaId:p.mediaId});
const rowsOf=p=>alignmentRows(p.text);
function targets(p,input){
 let list;
 if(/\.(ass|ssa)$/i.test(p.subtitleName||''))list=analyzeKaraoke(new AssDoc(p.text)).sentences.filter(s=>s.words.length&&/[A-Za-z]/.test(s.text)).map((s,index)=>({index,start:s.start,end:s.end,text:s.text,targetKey:realignTargetKey(s),target:s.style||''}));
 else {if(!input.allowSrtToAss)throw Error('请确认将 SRT 转换为 ASS');list=rowsOf(p).filter(s=>/[A-Za-z]/.test(s.text)).map(s=>({index:s.index,start:s.start,end:s.end,text:s.text,targetKey:JSON.stringify(['srt',s.index,s.start,s.end,s.text]),target:'SRT'}));}
 const skip=new Set(p.realignSkip||[]),only=input.onlyKeys?new Set(input.onlyKeys):null,region=input.region;
 return list.filter(s=>!skip.has(Number(s.start).toFixed(3))&&(!only||only.has(Number(s.start).toFixed(3)))&&(!region||s.start<region.end&&s.end>region.start)).map(s=>({...identity(p),...s,tokens:splitEnglishWords(s.text)}));
}
function results(job){
 if(job.status!=='done')return [];
 return job.result.cues.map((c,index)=>{const words=c.words.map(w=>({w:w.text,s:w.start,e:w.end})),expected=c.tokens||splitEnglishWords(c.text);
  if(words.length!==expected.length||words.some((w,i)=>w.w!==expected[i]||!Number.isFinite(w.s)||!Number.isFinite(w.e)||w.e<=w.s||w.s<c.start-.01||w.e>c.end+.01||i&&w.s<words[i-1].e))throw Error('对齐词序或时间不完整，原字幕保留');
  return {...c,index:c.index??index,ok:true,words,note:'Qwen Vulkan 对齐'};
 });
}
async function start(p,blocks){
 if(!p.mediaId)throw Error('请先关联媒体');if(!blocks.length)throw Error('没有可对齐的英文字幕');
 const active=await rpc('asrActive');if(active)throw Error('已有本机识别或对齐任务进行中');
 const job=await rpc('asrStart',{kind:'align',modelId:'qwen3-forced-aligner-android',mediaId:p.mediaId,blocks});
 return job;
}
async function poll(p){
 const task=p.androidRealign;if(!task||task.mediaId!==p.mediaId)return null;
 const native=await rpc('asrStatus',{id:task.taskId});
 return {...identity(p),...task,status:native.status==='cancelled'?'canceled':native.status==='interrupted'?'error':native.status,pct:native.pct||0,msg:native.stage,error:native.error,total:task.total,usable:native.status==='done'?native.result.cues.length:0,items:results(native)};
}
export async function route(id,action,method,input){
 const p=await rpc('studioLoad',{id});
 if(action==='realign-skip'){if(!Array.isArray(input.skip)||input.skip.length>100000||input.skip.some(s=>!/^\d+\.\d{3}$/.test(s)))throw Error('忽略字幕范围无效');await rpc('studioUpdate',{id,patch:{realignSkip:input.skip}});return {ok:true};}
 if(action==='realign-full-cancel'){if(p.androidRealign?.taskId)await rpc('asrCancel',{id:p.androidRealign.taskId});return {ok:true};}
 if(action==='realign'){
  if(!Array.isArray(input.blocks)||!input.blocks.length)throw Error('没有对齐字幕');
  const blocks=input.blocks.map((b,index)=>({...b,index,...identity(p),tokens:splitEnglishWords(b.text)})),job=await start(p,blocks);
  for(;;){await wait(500);const current=await rpc('asrStatus',{id:job.id});if(current.status==='running')continue;if(current.status!=='done')throw Error(current.error||'对齐已停止，原字幕保留');const blocks=results(current);return {blocks,total:blocks.length,usable:blocks.length};}
 }
 if(action==='realign-full'){
  if(method!=='POST')return {job:await poll(p)};
  const blocks=targets(p,input),job=await start(p,blocks);
  const task={taskId:job.id,...identity(p),sourceFormat:/\.(ass|ssa)$/i.test(p.subtitleName||'')?'ass':'srt',total:blocks.length};
  try{await rpc('studioUpdate',{id,patch:{androidRealign:task}});}catch(e){await rpc('asrCancel',{id:job.id});throw e;}return {job:{...task,status:'running',pct:0,msg:job.stage}};
 }
 if(action==='realign-full-apply'){
  const task=p.androidRealign,job=await poll(p);if(!task||task.sourceFormat!=='srt'||job?.status!=='done')throw Error('SRT 对齐结果尚未就绪');
  if(p.revision!==task.sourceRevision)throw Error('CONFLICT: 对齐期间字幕已修改，原字幕保留');
  const output=alignedSrtDocument(p.text,job.items,input.keys||[]);
  await rpc('studioApplyAlignment',{id,revision:task.sourceRevision,mediaId:task.mediaId,taskId:task.taskId,text:output.text});return {applied:output.applied,total:job.total};
 }
 throw Error('未知安卓对齐操作');
}
