import {draftDocument,emptyAss,recognitionSegments} from '/editor/android-asr-doc.js';
const rpc=(a,p={})=>window.androidRpc(a,p),$=id=>document.getElementById(id);
export const modelId='parakeet-tdt-0.6b-v2-android';
const operations=new Map();
function serial(id,fn){const next=(operations.get(id)||Promise.resolve()).catch(()=>{}).then(fn);operations.set(id,next);return next.finally(()=>{if(operations.get(id)===next)operations.delete(id);});}
export const qwenId='qwen3-asr-0.6b-android',alignerId='qwen3-forced-aligner-android';
const modelIds=[modelId,qwenId];
let lastStatus;
export async function status(){
 const native=await rpc('asrModelStatus'),gpu=native.gpu;
 const list=native.models.map(m=>({...m,engine:m.kind===1?'android-parakeet':'android-qwen',backend:'vulkan',usable:m.ready,nativeWordLevel:m.kind===1,draftAllowed:m.kind!==3,blockedReason:gpu.available?'':('Vulkan GPU 不可用；CPU 识别已禁用：'+(gpu.error||'')),desc:m.kind===1?'英语离线识别，原生逐词时间':m.kind===2?'多语言离线识别；逐词 ASS 需 Qwen 对齐器':'按现有字幕文本重新计算逐词时间'}));
 const selectedModel=localStorage.getItem('android-asr-model')||modelId,rerecogModel=localStorage.getItem('android-asr-rerecog')||'';
 return lastStatus={android:true,ready:list.some(m=>m.ready&&m.draftAllowed),models:list.filter(m=>m.kind!==3),aligners:list.filter(m=>m.kind===3),selectedModel,selected:selectedModel,rerecogModel,extraModels:[],downloads:[],native,segmentSeconds:600,backends:{configured:true,cuda:false,vulkan:true},hardware:{cpu:{available:false},cuda:{available:false},vulkan:{available:gpu.available,name:gpu.device||'',error:gpu.error||''},npu:{available:false}},pythonProbe:{ok:true,msg:'Android Vulkan 原生识别，无需 Python'},runtime:{ok:true},prereq:{},ffmpeg:{ready:true}};
}
export async function route(path,method,input){
 if(path==='/api/asr/status')return status();
 if(path==='/api/asr/hardware')return (await status()).hardware;
 if(path==='/api/asr/select'||path==='/api/asr/select-rerecog'){const id=input.modelId||input.id||'';if(id&&!modelIds.includes(id))throw Error('请选择 Parakeet 或 Qwen ASR Vulkan 模型');localStorage.setItem(path.endsWith('select-rerecog')?'android-asr-rerecog':'android-asr-model',id);return {ok:true,...await status()};}
 if(path==='/api/asr/backends')return {configured:true,cuda:false,vulkan:true};
 if(path==='/api/asr/confidence')return {mode:'off'};
 if(path==='/api/asr/hint')return {prompt:'',hotwordsScore:1.5};
 throw Error('该识别辅助功能尚未适配安卓');
}
function options(input){
 const id=input.modelId||localStorage.getItem('android-asr-model')||modelId;if(!modelIds.includes(id))throw Error('请选择安卓 Vulkan 识别模型');
 if(input.wordLevel===true&&id===qwenId&&!input.align)throw Error('Qwen ASR 没有原生逐词时间，请启用 Qwen 对齐或关闭逐词输出');
 if(input.speakers||input.autoPost)throw Error('安卓端暂不支持说话人分离或自动后处理');
 const align=!!input.align;
 return {modelId:id,align,wordLevel:align||(id===modelId&&input.wordLevel!==false),karaokeStyle:input.karaokeStyle==='k'?'k':'color',karaokeSweep:!!input.karaokeSweep,karaokeBase:input.karaokeBase||'#FFFFFF',confidence:'off',segmentSeconds:600};
}
export async function create(input,media,source){
 const opts=options(input);const state=await status();if(!state.models.find(m=>m.id===opts.modelId)?.ready)throw Error('请先在设置中准备所选 Vulkan 模型与 GPU');if(opts.align&&!state.aligners.some(m=>m.ready))throw Error('请先下载或导入 Qwen 对齐器');
 const job=await rpc('asrStart',{...opts,mediaId:media.path});
 try{return await rpc('studioCreate',{project:{name:input.name||media.name||'Parakeet 初稿',subtitleName:opts.wordLevel?'subtitle.ass':'subtitle.srt',text:opts.wordLevel?emptyAss:'',originalText:'',mediaId:media.path,mediaName:media.name,source,notes:[],oplog:[],createdAt:Date.now(),draft:{...opts,status:'running',stage:'asr',progress:0,message:job.stage,taskId:job.id,startText:opts.wordLevel?emptyAss:'',mediaId:media.path,startedAt:Date.now()}}});}
 catch(e){await rpc('asrCancel',{id:job.id}).catch(()=>{});throw e;}
}
export function refresh(project){return serial(project.id,async()=>{
 let p=await rpc('studioLoad',{id:project.id}),d=p.draft;
 if(!d?.taskId||d.status!=='running')return p;
 let job;try{job=await rpc('asrStatus',{id:d.taskId});}catch(e){job={status:'error',error:'识别结果读取失败：'+e.message};}
 if(job.status==='running')return {...p,draft:{...d,stage:'asr',progress:job.pct||0,message:job.stage||'Vulkan 识别中'}};
 let patch;
 if(job.status==='done'){
  if(p.text!==d.startText||p.mediaId!==d.mediaId)patch={draft:{...d,status:'error',stage:'asr',error:'识别期间稿件已修改，已保留当前字幕',message:'识别结果未覆盖当前修改'}};
  else {try{const output=draftDocument(job.result,d);patch={text:output.text,originalText:output.text,subtitleName:output.subtitleName,draft:{...d,startText:undefined,status:'done',stage:'done',progress:100,message:'Vulkan 初稿完成；可手动翻译字幕',lines:output.segments.length,words:output.segments.reduce((n,s)=>n+s.words.length,0),finishedAt:Date.now()}};}catch(e){patch={draft:{...d,status:'error',stage:'asr',error:e.message,message:'识别结果无效，原字幕保留'}};}}
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
  const job=await rpc('asrStart',{...options(p.draft),mediaId:p.mediaId});
  try{await rpc('studioUpdate',{id,patch:{draft:{...p.draft,status:'running',taskId:job.id,progress:0,error:'',message:job.stage}}});}catch(e){await rpc('asrCancel',{id:job.id});throw e;}
  return {ok:true,from:'asr'};
 }
 if(action==='rerecognize'||action==='reidentify'){
  if(method==='POST'){
   if(Array.isArray(input.regions)&&input.regions.length>1)throw Error('安卓端请逐段重新识别');
   const region=Array.isArray(input.regions)?input.regions[0]||{}:input;
   const start=Number(region.start),end=Number(region.end);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw Error('重新识别时间范围无效');
   const selected=localStorage.getItem('android-asr-rerecog')||p.draft?.modelId||localStorage.getItem('android-asr-model')||modelId,align=input.align??p.draft?.align??(selected===qwenId&&/\.(ass|ssa)$/i.test(p.subtitleName||''));
   const job=await rpc('asrStart',{...options({...p.draft,...input,modelId:selected,align}),mediaId:p.mediaId,start,end});
   try{await rpc('studioUpdate',{id,patch:{androidRerecog:{taskId:job.id,start,end,mediaId:p.mediaId}}});}catch(e){await rpc('asrCancel',{id:job.id}).catch(()=>{});throw e;}return {job:{...job,start,end}};
  }
  const task=p.androidRerecog;if(!task||task.mediaId!==p.mediaId)return {job:null};
  const job=await rpc('asrStatus',{id:task.taskId});
  return {job:{...job,start:task.start,end:task.end,progress:job.pct||0,message:job.stage,segments:job.status==='done'?recognitionSegments(job.result):[],warning:'本机 Vulkan 识别；每段最多 10 分钟，翻译请使用翻译字幕'}};
 }
 throw Error('未知安卓识别操作');
}

let modelTimer,detail='';
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function renderSettings(data){
 const models=$('st-models'),family=$('sf-asr-families');if(!models||!family)return;
 $('st-hardware').textContent=data.native.gpu.available?'Vulkan GPU · '+data.native.gpu.device+' · CPU 识别回退已禁用':'Vulkan GPU 不可用 · CPU 识别已禁用';
 family.replaceChildren();
 const all=[...data.models,...data.aligners];
 for(const m of all){const tile=element('button',null,'sf-asr-family');tile.type='button';tile.id=m.id===modelId?'android-parakeet-tile':m.id;for(const [cls,text]of [['sf-asr-family-name',m.name],['sf-asr-family-desc',m.kind===3?'Qwen 对齐 · Vulkan':'离线识别 · Vulkan'],['sf-asr-count',m.ready?'已就绪':m.filesOk?'GPU 不可用':'下载或导入模型'],['sf-asr-arrow','↗']])tile.append(element('span',text,cls));tile.onclick=()=>{detail=m.id;renderSettings(data);};family.append(tile);}
 family.hidden=!!detail;$('sf-asr-detail').hidden=!detail;models.closest('.st-card').hidden=!detail;$('sf-asr-detail-title').textContent=all.find(m=>m.id===detail)?.name||'';
 $('sf-asr-back').onclick=()=>{detail='';renderSettings(data);};
 for(const id of ['st-model-dir','st-runtime-env','dual-ratio-row','sf-asr-rerecog-mount']){const el=$(id);if(el)(id.startsWith('st-')?el.closest('.st-card'):el).hidden=true;}
 models.replaceChildren();if(!detail)return;
 const m=all.find(m=>m.id===detail);if(!m){detail='';return;}
 const state=element('p',m.ready?'模型与 Vulkan GPU 已就绪':m.filesOk?m.blockedReason:'模型未就绪，请下载或导入 GGUF 文件');state.id='android-model-state';
 const download=element('button',m.filesOk?'校验模型':'下载模型','btn'),local=element('button','从文件导入 GGUF','btn'),stop=element('button','停止','btn');download.type=local.type=stop.type='button';download.id='android-model-download';local.id='android-model-import';stop.hidden=true;
 const card=element('div',null,'sm-model android-parakeet-model');
 if(m.kind!==3){for(const [key,label]of [['android-asr-model','设为默认识别模型'],['android-asr-rerecog','设为重识别模型']]){const button=element('button',label,'btn');button.type='button';button.disabled=!m.ready;button.onclick=()=>{localStorage.setItem(key,m.id);state.textContent=label+'：'+m.name;};card.append(button);}}card.append(element('h3',m.name+' · Vulkan'),element('p',m.desc+'。模型约 '+Math.round(m.totalBytes/1048576)+' MiB；许可 '+m.license+'。识别每段最多 10 分钟，结果合并到同一稿件。'),state,download,local,stop);models.append(card);
 let jobId='';const enabled=()=>{download.disabled=local.disabled=false;stop.hidden=true;};
 async function poll(){clearTimeout(modelTimer);try{const job=await rpc('asrStatus',{id:jobId});state.textContent=(job.stage||job.error||job.status)+' · '+Math.round(job.pct||0)+'%';if(job.status==='running')modelTimer=setTimeout(poll,800);else{enabled();if(job.status==='done')renderSettings(await status());}}catch(e){state.textContent=e.message;enabled();}}
 rpc('asrActive').then(job=>{if(job?.kind==='model'){download.disabled=local.disabled=true;if(job.modelId===m.id){jobId=job.id;stop.hidden=false;poll();}else state.textContent='另一模型正在下载，请完成或停止后继续';}}).catch(()=>{});
 download.onclick=async()=>{download.disabled=local.disabled=true;try{const job=await rpc('asrStart',{kind:'model',modelId:m.id});jobId=job.id;stop.hidden=false;await poll();}catch(e){state.textContent=e.message;enabled();}};
 stop.onclick=()=>rpc('asrCancel',{id:jobId}).catch(e=>state.textContent=e.message);
 local.onclick=async()=>{download.disabled=local.disabled=true;try{await rpc('pickModel',{modelId:m.id});renderSettings(await status());}catch(e){state.textContent=e.message;}finally{enabled();}};
}

export function init(){
 for(const id of ['np-speakers','np-autopost','np-set-cast','dt-set-cast','batch-speakers','batch-autopost','batch-item-speakers','batch-item-autopost']){const el=$(id);if(el){el.checked=false;el.disabled=true;el.closest('.ws-row,.st-row,label')?.setAttribute('title','安卓暂不提供此功能');}}
 const syncBatch=()=>{
  const available=lastStatus?.aligners.some(m=>m.ready);
  for(const prefix of ['batch','batch-item']){const id=$(prefix+'-model')?.value||$('batch-model')?.value,word=$(prefix+'-word'),align=$(prefix+'-align');if(!word||!align)continue;
   if(id===qwenId){if(word.type==='checkbox')word.checked=false;else word.value='0';word.disabled=true;if(available&&!align.dataset.androidTouched){if(align.type==='checkbox')align.checked=true;else align.value='1';}}
   else word.disabled=false;align.disabled=!available;if(!available){if(align.type==='checkbox')align.checked=false;else align.value='0';}
  }
 };
 for(const prefix of ['batch','batch-item']){const el=$(prefix+'-model');if(el)new MutationObserver(syncBatch).observe(el,{childList:true});$(prefix+'-align')?.addEventListener('change',()=>{$(prefix+'-align').dataset.androidTouched='1';});}
 document.addEventListener('change',syncBatch);window.addEventListener('hashchange',()=>setTimeout(syncBatch,300));
 const explain=()=>{syncBatch();for(const id of ['np-speakers','np-autopost']){const el=$(id);if(el){el.checked=false;el.disabled=true;}}const c=$('np-confidence');if(c){c.value='off';c.disabled=true;}};
 document.addEventListener('change',explain);window.addEventListener('hashchange',()=>setTimeout(explain,200));$('np-mode-draft')?.addEventListener('click',()=>setTimeout(explain,200));
 const note=document.createElement('p');note.className='gl-hint';note.textContent='Parakeet / Qwen ASR 使用 Vulkan；每段最多 10 分钟。Qwen 逐词 ASS 需要对齐器，翻译在出稿后手动运行。';$('np-voice-group')?.prepend(note);
 const stop=document.createElement('button');stop.type='button';stop.className='btn';stop.textContent='停止识别';stop.id='android-asr-stop';stop.hidden=true;document.querySelector('.np-progress-panel')?.append(stop);
 stop.onclick=async()=>{const id=stop.dataset.project;if(id){stop.disabled=true;try{await window.fetch('/api/projects/'+id+'/asr-cancel',{method:'POST',body:'{}'});}finally{stop.disabled=false;}}};
 const detailStop=stop.cloneNode(true);detailStop.id='android-asr-detail-stop';document.querySelector('.dp-actions')?.append(detailStop);
 detailStop.onclick=async()=>{const id=/^#\/details\/([0-9a-f-]{36})$/.exec(location.hash)?.[1];if(id){detailStop.disabled=true;try{await window.fetch('/api/projects/'+id+'/asr-cancel',{method:'POST',body:'{}'});}finally{detailStop.disabled=false;}}};
 // A persisted draft can be resumed after Activity/WebView recreation; polling never launches another task.
 let reading=false;setInterval(async()=>{if(reading||document.hidden)return;reading=true;try{const list=await rpc('studioList');for(const p of list.filter(p=>p.draft?.status==='running'))await refresh(p);const current=list.find(p=>p.draft?.status==='running');stop.hidden=!current;if(current)stop.dataset.project=current.id;const detailId=/^#\/details\/([0-9a-f-]{36})$/.exec(location.hash)?.[1];detailStop.hidden=!list.some(p=>p.id===detailId&&p.draft?.status==='running');}catch{}finally{reading=false;}},1500);explain();
}
