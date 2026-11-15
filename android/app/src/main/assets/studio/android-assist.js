import {config} from './android-translate.js';
import {parseGlossary} from '/editor/android-llm-defaults.js';
import {mergeGlossary} from '/editor/android-glossary-merge.js';
import {glossaryDocument,cleanTerms} from '/editor/android-glossary-doc.js';
import {planResegRows} from '/editor/android-reseg-plan.js';

const rpc=(action,arg)=>window.androidRpc(action,arg),native=window.androidStudio;
const active=new Map(),previews=new Map();
const snapshot=()=>window.__dbg?.state.assDoc?.serialize()||JSON.stringify(window.__dbg?.state.items.map(row=>[row.start,row.end,row.l1,row.l2]));
const cfgSignature=cfg=>JSON.stringify({id:cfg.activeSchemeId,cfg:cfg.cfg});
async function assertCurrent(job,checkConfig=true){
  if(job.cancelled)throw new Error('字幕辅助操作已停止');
  if(window.__dbg?.state.project!==job.owner||snapshot()!==job.memory||(await native.load(job.id)).revision!==job.project.revision)throw new Error('CONFLICT: 稿件已变化，请重新预览');
  if(checkConfig&&cfgSignature(await config())!==job.signature)throw new Error('CONFLICT: 翻译方案已变化，请重新预览');
}
export function cancel(kind){
  const job=active.get(kind);if(job){job.cancelled=true;if(job.requestId)rpc('llmCancel',{requestId:job.requestId}).catch(()=>{});}
  previews.delete(kind);
}
export async function checkPreview(kind){
  const job=previews.get(kind);if(!job)throw new Error('请先重新生成预览');await assertCurrent(job);return true;
}
export function checkOwner(kind){
  const job=previews.get(kind);if(!job||window.__dbg.state.project!==job.owner)throw new Error('CONFLICT: 已切换稿件，停止应用预览');
}
async function begin(id,kind,signal){
  if(active.has(kind))throw new Error('字幕辅助操作正在进行');
  const reservation={cancelled:false,requestId:''};active.set(kind,reservation);
  try{
  window.__dbg.panel.commitEdit();await new Promise(r=>setTimeout(r,80));await window.__subfabricFlushSave();
  if(window.__dbg.state.project?.id!==id)throw new Error('CONFLICT: 已切换稿件，请重试');
  const project=await native.load(id),cfg=await config();if(!cfg.ready)throw new Error('请先在全局设置中配置翻译方案');
  const job={id,kind,project,cfg,owner:window.__dbg.state.project,memory:snapshot(),signature:cfgSignature(cfg),cancelled:false,requestId:''};
  job.abort=()=>cancel(kind);if(signal?.aborted||reservation.cancelled)throw new Error('字幕辅助操作已停止');signal?.addEventListener('abort',job.abort,{once:true});job.signal=signal;
  active.set(kind,job);job.timer=setTimeout(()=>cancel(kind),600000);previews.delete(kind);return job;
  }catch(error){active.delete(kind);throw error;}
}
function end(job){active.delete(job.kind);clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.abort);job.requestId='';}
async function chat(job,messages,maxTokens=8192){
  await assertCurrent(job);job.requestId=crypto.randomUUID();
  try{const response=await rpc('llmChat',{requestId:job.requestId,schemeId:job.cfg.activeSchemeId||'',messages,maxTokens});await assertCurrent(job);return response;}
  finally{job.requestId='';}
}
function jsonList(raw){
  const text=String(raw||''),start=text.indexOf('['),end=text.lastIndexOf(']');
  let parsed;try{parsed=JSON.parse(start>=0&&end>start?text.slice(start,end+1):text);}catch{throw new Error('模型未返回有效的 JSON 预览');}
  if(!Array.isArray(parsed))throw new Error('模型未返回有效的 JSON 预览');return parsed;
}
async function review(job){
  const document=glossaryDocument(job.project.text,job.project.subtitleName);if(!document.lines.length)throw new Error('字幕中没有可校对的文本');
  const known=parseGlossary(job.cfg.cfg.glossary||'',job.cfg.cfg.glossaryLang||'简体'),knownMap=new Map(known.map(([src,dst])=>[src.toLowerCase(),{src,dst}]));
  const transcript=document.lines.join('\n'),truncated=transcript.length>60000,body=transcript.slice(0,60000);
  const response=await chat(job,[{role:'system',content:'你是字幕术语校对助手。只输出 JSON 数组，不要解释、不要 markdown 代码块。'},
    {role:'user',content:['找出字幕中的中英文专有名词（人名、地名、组织、作品、游戏/道具/技能名、品牌、称号）。普通名词、常用词不要。',
      '给出统一的中文译法，沿用现有术语表。只输出 [{"src":"原文","dst":"译法"}]，最多 200 条；没有则输出 []。',
      '【现有术语表】',known.slice(0,400).map(([a,b])=>a+'='+b).join('\n'),'【字幕正文】',body].join('\n')}]);
  const terms=[],seen=new Set();
  for(const row of jsonList(response.content).slice(0,200)){
    let term;try{term=cleanTerms([{src:row?.src||row?.source||row?.term,dst:row?.dst||row?.translation||row?.zh}])[0];}catch{continue;}
    const key=term.src.toLowerCase();if(seen.has(key))continue;seen.add(key);const existing=knownMap.get(key);terms.push({...existing||term,known:!!existing});
  }
  for(const [key,term]of knownMap)if(!seen.has(key)&&term.src.length>=2&&body.includes(term.src)){terms.push({...term,known:true});seen.add(key);if(terms.length>=400)break;}
  const scheme=(await rpc('llmSchemes',{method:'GET'})).schemes.find(s=>s.id===job.cfg.activeSchemeId);
  previews.set('glossary',job);return {terms,total:terms.length,known:terms.filter(t=>t.known).length,scanned:document.lines.length,truncated,scheme:scheme?{id:scheme.id,name:scheme.name}:null};
}
async function apply(job,input){
  await assertCurrent(job);const terms=cleanTerms(input.terms),result=glossaryDocument(job.project.text,job.project.subtitleName).apply(terms);
  if(result.replaced){
    await native.update(job.id,{text:result.text},job.project.revision);
    const history=native.history.get(job.id)||{undo:[],redo:[]};history.undo.push(job.project.text);if(history.undo.length>15)history.undo.shift();history.redo=[];native.history.set(job.id,history);
  }
  let saved={saved:false},saveError=null;
  if(input.saveToScheme){try{
    const cfg=job.cfg.cfg,previous=cfg.glossary||'',lang=cfg.glossaryLang||'简体';
    saved=await rpc('llmGlossary',{schemeId:job.cfg.activeSchemeId||'',previous,lang,glossary:mergeGlossary(previous,lang,terms)});
  }catch(error){saveError=error.message;}}
  previews.delete('glossary');
  // Read the new revision before the original dialog reopens the project and resumes editing.
  if(result.replaced&&window.__dbg.state.project===job.owner)await window.__androidRefreshProject(job.id);
  return {applied:true,replaced:result.replaced,rows:result.rows,...saved,saveError};
}
export async function route(id,action,method,input,signal){
  if(method!=='POST')throw new Error('字幕辅助接口仅支持 POST');
  if(action==='glossary-apply-project'){
    const job=previews.get('glossary');if(!job||job.id!==id)throw new Error('请先重新生成术语预览');return apply(job,input);
  }
  const kind=action==='glossary-review'?'glossary':'reseg',job=await begin(id,kind,signal);
  try{
    if(kind==='glossary')return await review(job);
    const rows=Array.isArray(input.rows)?input.rows:[];if(!rows.length||rows.length>2000||JSON.stringify(rows).length>1500000)throw new Error('重分句需要 1–2000 行中英字幕');
    for(const row of rows)if(typeof row.zh!=='string'||typeof row.en!=='string'||!row.zh.trim()||!row.en.trim()||row.zh.length>10000||row.en.length>10000)throw new Error('字幕行格式无效');
    const result=await planResegRows(id,rows,job.cfg.cfg,async(_cfg,messages,options)=>{const response=await chat(job,messages,options.maxTokens);jsonList(response.content);return response;});
    // Shared validation rejects rewritten text; duplicate model row numbers must never cause a double split.
    const seen=new Set();result.plan=result.plan.filter(p=>!seen.has(p.row)&&seen.add(p.row));
    previews.set('reseg',job);return {...result,rows:rows.length};
  }finally{end(job);}
}
