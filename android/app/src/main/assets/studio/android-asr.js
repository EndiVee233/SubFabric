import {draftDocument,emptyAss,recognitionSegments} from '/editor/android-asr-doc.js';
const rpc=(a,p={})=>window.androidRpc(a,p),$=id=>document.getElementById(id);
export const modelId='parakeet-tdt-0.6b-v2-android';
const operations=new Map();
function serial(id,fn){const next=(operations.get(id)||Promise.resolve()).catch(()=>{}).then(fn);operations.set(id,next);return next.finally(()=>{if(operations.get(id)===next)operations.delete(id);});}
export async function status(){
 const native=await rpc('asrModelStatus'),ready=native.ready;
 return {android:true,ready,models:[{id:modelId,name:'Parakeet TDT v2 · 英语 · Android CPU',engine:'android-parakeet',backend:'cpu',ready,usable:ready,filesOk:ready,nativeWordLevel:true,draftAllowed:true,desc:'本机离线识别，支持真实逐词时间；模型约 631 MiB。'}],selectedModel:modelId,selected:modelId,aligners:[],extraModels:[],downloads:[],native,backends:{configured:true,cuda:false,vulkan:false},hardware:{cpu:{available:true},cuda:{available:false},vulkan:{available:false},npu:{available:false}},pythonProbe:{ok:true,msg:'Android 原生识别，无需 Python'},runtime:{ok:true},prereq:{},ffmpeg:{ready:true}};
}
export async function route(path,method,input){
 if(path==='/api/asr/status')return status();
 if(path==='/api/asr/hardware')return (await status()).hardware;
 if(path==='/api/asr/select'||path==='/api/asr/select-rerecog'){if(input.modelId&&input.modelId!==modelId)throw Error('安卓端仅支持 Parakeet TDT v2');return {ok:true,selectedModel:modelId};}
 if(path==='/api/asr/backends')return {configured:true,cuda:false,vulkan:false};
 if(path==='/api/asr/confidence')return {mode:'off'};
 if(path==='/api/asr/hint')return {prompt:'',hotwordsScore:1.5};
 throw Error('该识别辅助功能尚未适配安卓');
}
function options(input){
 if(input.modelId&&input.modelId!==modelId)throw Error('安卓端仅支持 Parakeet TDT v2');
 if(input.align||input.speakers||input.autoPost)throw Error('安卓 Parakeet 暂不支持独立对齐、说话人分离或自动后处理');
 return {modelId,wordLevel:input.wordLevel!==false,karaokeStyle:input.karaokeStyle==='k'?'k':'color',karaokeSweep:!!input.karaokeSweep,karaokeBase:input.karaokeBase||'#FFFFFF',confidence:'off'};
}
export async function create(input,media,source){
 const opts=options(input);if(!(await status()).ready)throw Error('请先在设置中下载或导入 Parakeet 模型');
 const job=await rpc('asrStart',{mediaId:media.path});
 try{return await rpc('studioCreate',{project:{name:input.name||media.name||'Parakeet 初稿',subtitleName:opts.wordLevel?'subtitle.ass':'subtitle.srt',text:opts.wordLevel?emptyAss:'',originalText:'',mediaId:media.path,mediaName:media.name,source,notes:[],oplog:[],createdAt:Date.now(),draft:{...opts,status:'running',stage:'asr',progress:0,message:job.stage,taskId:job.id,startText:opts.wordLevel?emptyAss:'',mediaId:media.path,startedAt:Date.now()}}});}
 catch(e){await rpc('asrCancel',{id:job.id}).catch(()=>{});throw e;}
}
export function refresh(project){return serial(project.id,async()=>{
 let p=await rpc('studioLoad',{id:project.id}),d=p.draft;
 if(!d?.taskId||d.status!=='running')return p;
 let job;try{job=await rpc('asrStatus',{id:d.taskId});}catch(e){job={status:'error',error:'识别结果读取失败：'+e.message};}
 if(job.status==='running')return {...p,draft:{...d,stage:'asr',progress:job.pct||0,message:job.stage||'Parakeet 识别中'}};
 let patch;
 if(job.status==='done'){
  if(p.text!==d.startText||p.mediaId!==d.mediaId)patch={draft:{...d,status:'error',stage:'asr',error:'识别期间稿件已修改，已保留当前字幕',message:'识别结果未覆盖当前修改'}};
  else {try{const output=draftDocument(job.result,d);patch={text:output.text,originalText:output.text,subtitleName:output.subtitleName,draft:{...d,startText:undefined,status:'done',stage:'done',progress:100,message:'Parakeet 初稿完成；可手动翻译字幕',lines:output.segments.length,words:output.segments.reduce((n,s)=>n+s.words.length,0),finishedAt:Date.now()}};}catch(e){patch={draft:{...d,status:'error',stage:'asr',error:e.message,message:'识别结果无效，原字幕保留'}};}}
 }else patch={draft:{...d,status:'error',stage:'asr',error:job.error||'识别已停止，原字幕保留，可重试',message:job.stage||'识别已停止'}};
 return rpc('studioApplyAsr',{id:p.id,taskId:d.taskId,revision:p.revision,mediaId:p.mediaId,patch});
 });}
export async function projectRoute(id,action,method,input){
 const p=await rpc('studioLoad',{id});
 if(action==='draft')return refresh(p);
 if(action==='asr-cancel'){if(p.draft?.taskId)await rpc('asrCancel',{id:p.draft.taskId});return refresh(p);}
 if(action==='retry'){
  if(p.draft?.status==='running')throw Error('识别任务仍在进行');
  if(!p.draft||p.text!==p.draft.startText)throw Error('请新建初稿，避免覆盖已经编辑的字幕');
  const job=await rpc('asrStart',{mediaId:p.mediaId});
  try{await rpc('studioUpdate',{id,patch:{draft:{...p.draft,status:'running',taskId:job.id,progress:0,error:'',message:job.stage}}});}catch(e){await rpc('asrCancel',{id:job.id});throw e;}
  return {ok:true,from:'asr'};
 }
 if(action==='rerecognize'||action==='reidentify'){
  if(method==='POST'){
   if(Array.isArray(input.regions)&&input.regions.length>1)throw Error('安卓端请逐段重新识别');
   const region=Array.isArray(input.regions)?input.regions[0]||{}:input;
   const start=Number(region.start),end=Number(region.end);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw Error('重新识别时间范围无效');
   const job=await rpc('asrStart',{mediaId:p.mediaId,start,end});
   try{await rpc('studioUpdate',{id,patch:{androidRerecog:{taskId:job.id,start,end,mediaId:p.mediaId}}});}catch(e){await rpc('asrCancel',{id:job.id}).catch(()=>{});throw e;}return {job:{...job,start,end}};
  }
  const task=p.androidRerecog;if(!task||task.mediaId!==p.mediaId)return {job:null};
  const job=await rpc('asrStatus',{id:task.taskId});
  return {job:{...job,start:task.start,end:task.end,progress:job.pct||0,message:job.stage,segments:job.status==='done'?recognitionSegments(job.result):[],warning:'本次仅本机英文识别；翻译请使用翻译字幕'}};
 }
 throw Error('未知安卓识别操作');
}

let modelTimer,detail=false;
export function renderSettings(data){
 const models=$('st-models'),family=$('sf-asr-families');if(!models||!family)return;
 const ready=data.ready;
 $('st-hardware').textContent='本机识别：Android CPU · 离线英语 · 真实逐词时间';
 family.replaceChildren();const tile=document.createElement('button');tile.type='button';tile.className='sf-asr-family';tile.id='android-parakeet-tile';
 for(const [cls,text]of [['sf-asr-family-name','Parakeet'],['sf-asr-family-desc','TDT v2 · 英语 · CPU'],['sf-asr-count',ready?'模型已就绪':'下载或导入模型'],['sf-asr-arrow','↗']]){const el=document.createElement('span');el.className=cls;el.textContent=text;tile.append(el);}family.append(tile);
 const show=()=>{family.hidden=detail;$('sf-asr-detail').hidden=!detail;models.closest('.st-card').hidden=!detail;$('sf-asr-detail-title').textContent='Parakeet';};tile.onclick=()=>{detail=true;show();};$('sf-asr-back').onclick=()=>{detail=false;show();};
 $('st-model-dir').closest('.st-card').hidden=true;$('st-runtime-env').closest('.st-card').hidden=true;$('dual-ratio-row').hidden=true;$('sf-asr-rerecog-mount').hidden=true;show();
 models.replaceChildren();const title=document.createElement('h3');title.textContent='Parakeet TDT v2 · int8';const desc=document.createElement('p');desc.textContent='英语离线识别，CPU 运行，无需 Python。约 631 MiB 模型；新建初稿支持逐词 ASS 或 SRT，完成后可手动翻译。';const state=document.createElement('p');state.id='android-model-state';state.textContent=ready?'模型已就绪':'模型未就绪，请下载或导入完整模型文件夹。';
 const download=document.createElement('button');download.type='button';download.className='btn';download.textContent=ready?'校验模型':'下载模型';download.id='android-model-download';
 const local=document.createElement('button');local.type='button';local.className='btn';local.textContent='从文件夹导入模型';local.id='android-model-import';
 const stop=document.createElement('button');stop.type='button';stop.className='btn';stop.textContent='停止';stop.hidden=true;const card=document.createElement('div');card.className='sm-model android-parakeet-model';card.append(title,desc,state,download,local,stop);models.append(card);
 let jobId='';rpc('asrActive').then(job=>{if(job?.kind==='model'){jobId=job.id;download.disabled=local.disabled=true;stop.hidden=false;poll();}}).catch(()=>{});
 download.onclick=async()=>{download.disabled=local.disabled=true;try{const job=await rpc('asrStart',{kind:'model'});jobId=job.id;stop.hidden=false;await poll();}catch(e){state.textContent=e.message;download.disabled=local.disabled=false;}};
 stop.onclick=()=>rpc('asrCancel',{id:jobId}).catch(e=>state.textContent=e.message);
 local.onclick=async()=>{download.disabled=local.disabled=true;try{await rpc('pickModel');renderSettings(await status());}catch(e){state.textContent=e.message;}finally{download.disabled=local.disabled=false;}};
 async function poll(){clearTimeout(modelTimer);try{const job=await rpc('asrStatus',{id:jobId});state.textContent=(job.stage||job.error||job.status)+' · '+Math.round(job.pct||0)+'%';if(job.status==='running')modelTimer=setTimeout(poll,800);else{stop.hidden=true;download.disabled=local.disabled=false;if(job.status==='done')renderSettings(await status());}}catch(e){state.textContent=e.message;download.disabled=local.disabled=false;}}
}

export function init(){
 for(const id of ['np-speakers','np-autopost','np-set-cast','dt-set-cast','batch-speakers','batch-autopost','batch-align','batch-item-speakers','batch-item-autopost','batch-item-align']){const el=$(id);if(el){el.checked=false;el.disabled=true;el.closest('.ws-row,.st-row,label')?.setAttribute('title','安卓 Parakeet 暂不提供此功能');}}
 const explain=()=>{for(const id of ['np-speakers','np-autopost','np-align']){const el=$(id);if(el){el.checked=false;el.disabled=true;}}const c=$('np-confidence');if(c){c.value='off';c.disabled=true;}};
 document.addEventListener('change',explain);window.addEventListener('hashchange',()=>setTimeout(explain,200));$('np-mode-draft')?.addEventListener('click',()=>setTimeout(explain,200));
 const note=document.createElement('p');note.className='gl-hint';note.textContent='Android Parakeet 仅做本机英文识别与逐词时间；翻译在出稿后手动运行。';$('np-voice-group')?.prepend(note);
 const stop=document.createElement('button');stop.type='button';stop.className='btn';stop.textContent='停止识别';stop.id='android-asr-stop';stop.hidden=true;document.querySelector('.np-progress-panel')?.append(stop);
 stop.onclick=async()=>{const id=stop.dataset.project;if(id){stop.disabled=true;try{await window.fetch('/api/projects/'+id+'/asr-cancel',{method:'POST',body:'{}'});}finally{stop.disabled=false;}}};
 const detailStop=stop.cloneNode(true);detailStop.id='android-asr-detail-stop';document.querySelector('.dp-actions')?.append(detailStop);
 detailStop.onclick=async()=>{const id=/^#\/details\/([0-9a-f-]{36})$/.exec(location.hash)?.[1];if(id){detailStop.disabled=true;try{await window.fetch('/api/projects/'+id+'/asr-cancel',{method:'POST',body:'{}'});}finally{detailStop.disabled=false;}}};
 // A persisted draft can be resumed after Activity/WebView recreation; polling never launches another task.
 let reading=false;setInterval(async()=>{if(reading||document.hidden)return;reading=true;try{const list=await rpc('studioList');for(const p of list.filter(p=>p.draft?.status==='running'))await refresh(p);const current=list.find(p=>p.draft?.status==='running');stop.hidden=!current;if(current)stop.dataset.project=current.id;const detailId=/^#\/details\/([0-9a-f-]{36})$/.exec(location.hash)?.[1];detailStop.hidden=!list.some(p=>p.id===detailId&&p.draft?.status==='running');}catch{}finally{reading=false;}},1500);explain();
}
