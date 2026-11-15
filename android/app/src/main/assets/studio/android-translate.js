import * as text from '/editor/android-llm-text.js';
import {LLM_PRESETS,DEFAULT_TRANSLATE_PROMPT,systemPromptWithGlossary} from '/editor/android-llm-defaults.js';
import {translationDocument} from '/editor/android-translation-doc.js';

const rpc=(action,data)=>window.androidRpc(action,data);
const requestId=()=>crypto.randomUUID();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function config(){
  const data=await rpc('llmConfig',{});
  return {...data,presets:LLM_PRESETS.filter(p=>!p.local),defaultPrompt:DEFAULT_TRANSLATE_PROMPT,
    cfg:{prompt:DEFAULT_TRANSLATE_PROMPT,batchSize:25,temperature:.3,contextRows:0,...data.cfg}};
}
async function chat(cfg,sources,refs,control){
  if(control.cancelled)throw new Error('翻译已停止');
  const id=requestId();control.requestId=id;
  try{
    const result=await rpc('llmChat',{requestId:id,schemeId:cfg.activeSchemeId||'',maxTokens:Math.min(16384,Math.max(1024,sources.length*250+512)),messages:[
      {role:'system',content:systemPromptWithGlossary(cfg.cfg,false,true)},
      {role:'user',content:text.buildTranslateUserMessage(sources,refs,true)},
    ]});
    if(control.cancelled)throw new Error('翻译已停止');
    const parsed=text.parseTranslationReply(result.content,sources);
    if(!parsed)throw new Error('译文未通过 ID 与原文对应校验');
    return parsed.map(text.normalizeZhPunctuation);
  }finally{control.requestId='';}
}
export async function translate(cfg,sources,refs=[],control={cancelled:false},depth=0){
  try{return await chat(cfg,sources,refs,control);}catch(error){
    if(control.cancelled||/HTTP (400|401|403|404)|还没配置/.test(error.message))throw error;
    if(sources.length>1&&depth<5){
      const n=text.nextBatchSize(sources.length),out=[];
      for(let i=0;i<sources.length;i+=n){if(control.cancelled)throw new Error('翻译已停止');out.push(...await translate(cfg,sources.slice(i,i+n),refs,control,depth+1));}
      return out;
    }
    if(depth===0){await wait(500);return chat(cfg,sources,refs,control);}
    throw error;
  }
}
export async function route(path,method,input){
  const preset=LLM_PRESETS.find(p=>p.id===input.provider);
  if(preset)input={...input,baseUrl:input.baseUrl||preset.baseUrl,model:input.model||preset.model};
  if(path==='/api/translate/config'){
    if(method==='POST')await rpc('llmConfig',{method,input});return config();
  }
  if(path==='/api/translate/test'){
    const result=await rpc('llmTest',{requestId:requestId()});return {ok:true,reply:result.content.slice(0,200)};
  }
  if(path==='/api/translate/one'){
    const cfg=await config();if(!String(input.text||'').trim())throw new Error('缺少 text');
    return {zh:(await translate(cfg,[String(input.text)]))[0]};
  }
  const match=/^\/api\/translate\/schemes(?:\/([a-zA-Z0-9-]+)(?:\/(activate))?)?$/.exec(path);
  if(!match)throw new Error('未知翻译接口');
  const id=match[1]||'';
  if(id==='test'){
    try{const result=await rpc('llmTest',{config:input,requestId:requestId()});return {ok:true,reply:result.content.slice(0,200)};}
    catch(error){return {ok:false,error:error.message};}
  }
  return rpc('llmSchemes',{id,method,activate:match[2]==='activate',input});
}

let active;
export async function showTranslation(){
  if(active)throw new Error('翻译任务正在进行');
  const dbg=window.__dbg,studio=window.androidStudio;
  dbg.panel.commitEdit();await wait(80);await window.__subfabricFlushSave();
  const id=dbg.state.project?.id;if(!id)throw new Error('请先打开字幕');
  const cfg=await config();if(!cfg.ready)throw new Error('请先在全局设置中配置翻译方案');
  const project=await studio.load(id),snapshot=translationDocument(project.text,project.subtitleName);
  if(!snapshot.rows.length)throw new Error('当前字幕没有可翻译的原文');
  const dialog=document.createElement('dialog');dialog.className='android-translation-dialog';
  const title=document.createElement('h3');title.textContent='翻译字幕';
  const summary=document.createElement('p');summary.textContent='使用当前翻译方案，已完成的批次逐批保存。停止后可补翻缺失译文。';
  const label=document.createElement('label'),overwrite=document.createElement('input');overwrite.type='checkbox';overwrite.id='android-translate-overwrite';label.append(overwrite,' 重新翻译已有译文');
  const progress=document.createElement('p');progress.id='android-translate-progress';
  if(project.translationJob?.status==='running')progress.textContent='上次翻译已中断，可继续补翻缺失译文。';
  const start=document.createElement('button');start.textContent='开始翻译';start.id='android-translate-start';
  const stop=document.createElement('button');stop.textContent='关闭';stop.id='android-translate-stop';
  dialog.append(title,summary,label,progress,start,stop);document.body.append(dialog);dialog.showModal();
  let control,revision=project.revision,changed=false,conflict=false;
  async function close(){dialog.close();dialog.remove();if((changed||conflict)&&location.hash==='#/project/'+id)await window.__androidRefreshProject(id);}
  async function cancel(){if(!control){await close();return;}control.cancelled=true;stop.disabled=true;if(control.requestId)await rpc('llmCancel',{requestId:control.requestId});}
  dialog.addEventListener('cancel',event=>{event.preventDefault();cancel().catch(error=>progress.textContent=error.message);});
  stop.onclick=()=>cancel().catch(error=>progress.textContent=error.message);
  start.onclick=async()=>{
    start.disabled=true;overwrite.disabled=true;stop.textContent='停止翻译';control={cancelled:false,requestId:''};active=control;
    const pending=snapshot.rows.map((row,i)=>({row,i})).filter(({row})=>overwrite.checked||!row.zh.trim());
    const lines=new Array(snapshot.rows.length);let done=0;
    const saveState=async(status,error='')=>studio.update(id,{translationJob:{status,done,total:pending.length,model:cfg.cfg.model,error,updatedAt:Date.now()}});
    try{
      await saveState('running');
      for(let offset=0;offset<pending.length;offset+=cfg.cfg.batchSize){
        if(control.cancelled)throw new Error('翻译已停止');
        const batch=pending.slice(offset,offset+cfg.cfg.batchSize),first=batch[0].i;
        progress.textContent=`正在翻译 ${done} / ${pending.length}`;
        const refs=text.translationRefs(snapshot.rows,first,cfg.cfg.contextRows,lines.map((v,i)=>v||snapshot.rows[i].zh));
        const result=await translate(cfg,batch.map(({row})=>row.text),refs,control);
        if(control.cancelled)throw new Error('翻译已停止');
        batch.forEach(({i},k)=>lines[i]=result[k]);
        const saved=await studio.update(id,{text:snapshot.patch(lines)},revision);revision=saved.revision;changed=true;done+=batch.length;
        await saveState('running');
      }
      await saveState('done');progress.textContent=`翻译完成 ${done} / ${pending.length}`;
    }catch(error){conflict=error.message.startsWith('CONFLICT:');await saveState(control.cancelled?'stopped':'error',error.message).catch(()=>{});progress.textContent=error.message+`（已保存 ${done} / ${pending.length}）`;}
    finally{active=null;control=null;stop.disabled=false;stop.textContent='关闭';}
  };
}
