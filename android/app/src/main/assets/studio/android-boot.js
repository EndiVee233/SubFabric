/* Platform adapter, loaded before the unchanged desktop editor modules. */
(() => {
  let windowsThemes;
  Object.defineProperty(window,'SF_THEMES',{configurable:true,get:()=>windowsThemes,set:themes=>{
    windowsThemes=Object.freeze({...themes,builtins:themes.builtins.filter(p=>p.id==='windows-uwp'),visibleBuiltins:themes.visibleBuiltins.filter(p=>p.id==='windows-uwp'),list:()=>themes.builtins.filter(p=>p.id==='windows-uwp'),get:()=>themes.get('windows-uwp',[])});
  }});
  localStorage.setItem('sf-welcome-v1', JSON.stringify({ done: true, android: true, cuda: false, vulkan: false }));
  localStorage.setItem('sf-welcome-synced', '1');
  let prefs={}; try {prefs=JSON.parse(localStorage.getItem('subfabric-studio-v1')||'{}');}catch{}
  localStorage.setItem('subfabric-studio-v1',JSON.stringify({...prefs,themePack:'windows-uwp',custom:[],background:'solid',motion:'off',accent:prefs.accent||'#0078D7'}));
  const waiting=new Map();let sequence=0;
  const errors=[],requests=[],history=new Map();
  window.androidErrors=errors;window.androidRequests=requests;
  window.nativeEvent=(type,data)=>{
    if(type==='response') {const p=waiting.get(data.id);if(!p)return;waiting.delete(data.id);data.ok?p.resolve(data.data):p.reject(new Error(data.data));}
    if(type==='progress')document.dispatchEvent(new CustomEvent('android-progress',{detail:data}));
  };
  const rpc=(action,payload={})=>new Promise((resolve,reject)=>{const id='studio-'+(++sequence);waiting.set(id,{resolve,reject});window.SubFabric.call(id,action,JSON.stringify(payload));});
  window.androidRpc=rpc;
  const originalFetch=window.fetch.bind(window);
  const response=(data,status=200,headers={})=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'Content-Type':typeof data==='string'?'text/plain':'application/json',...headers}});
  const documentMeta=p=>({ ...p, text:undefined,originalText:undefined,packExtras:undefined,oplog:undefined,notes:undefined,
    name:p.name||'未命名稿件', format:/\.(ass|ssa)$/i.test(p.subtitleName||'')?'ass':'srt',
    subtitle:{name:p.subtitleName||'subtitle.ass',file:p.subtitleName||'subtitle.ass'},
    video:p.mediaId?{path:p.mediaId,name:p.mediaName||'媒体'}:null,videoExists:!!p.mediaId,androidStandalone:!p.mediaId,androidProject:true,
    prepare:p.prepare||{status:'done'},audio:{mode:'raw'},hasAudio:!!p.hasAudio,hasPeaks:!!p.hasPeaks,createdAt:p.createdAt||p.modifiedAt,
  });
  const load=id=>rpc('studioLoad',{id});
  const update=(id,patch,revision)=>rpc('studioUpdate',{id,patch,...(revision!=null?{revision}:{})});
  const jsonBody=async body=>body==null?{}:JSON.parse(typeof body==='string'?body:await body.text());
  const migrate=(async()=>{
    if(localStorage.getItem('android-studio-migrated-v1'))return;
    const previous=await rpc('list'),existing=await rpc('studioList');
    const {serializeSRT}=await import('/editor/js/srt.js');
    for(const item of previous){if(existing.some(p=>p.originId===item.id))continue;const p=await rpc('load',{id:item.id});if(!p.cues?.length)continue;
      const text=serializeSRT(p.cues);await rpc('studioCreate',{project:{name:p.title,subtitleName:'subtitle.srt',text,originalText:text,mediaId:p.media?p.id:'',mediaName:p.title,originId:p.id,notes:[],oplog:[],createdAt:p.updated}});
    }
    localStorage.setItem('android-studio-migrated-v1','1');
  })();
  async function api(url,options) {
    const path=url.pathname,method=(options.method||'GET').toUpperCase();
    requests.push({path,method});if(requests.length>300)requests.shift();
    if(path==='/api/version')return response({version:'Android 0.6 · 字幕辅助',vendorOk:true,stamp:''});
    if(path.startsWith('/api/fetch/')||path.startsWith('/api/downloads')){
      const download=await import('/studio/android-download.js');
      return response(await download.route(path,method,await jsonBody(options.body),options.signal));
    }
    if(path==='/api/pick'&&method==='POST'){
      const input=await jsonBody(options.body);
      if(input.kind==='folder'&&input.purpose==='video-export')return response(await rpc('pickExportDirectory')||{});
      return response({error:'此选择器用途尚未适配安卓'},501);
    }
    if(path==='/api/samples')return response({videos:[],subtitles:[]});
    if(path==='/api/fonts')return response({fonts:['Noto Sans CJK SC']});
    if(path==='/api/asr/hardware')return response({cuda:{available:false},vulkan:{available:false,devices:[]},npu:{available:false}});
    if(path==='/api/asr/backends')return response({configured:true,cuda:false,vulkan:false});
    if(path==='/api/asr/status')return response({models:[],aligners:[],selected:'',backends:{cuda:false,vulkan:false},runtime:{},prereq:{},python:{ok:false},ffmpeg:{ready:false}});
    if(path==='/api/asr/confidence')return response({mode:'off'});
    if(path==='/api/oplog/stats')return response({days:[],total:0});
    if(path.startsWith('/api/translate/')){
      const snapshot=()=>window.__dbg?.state.assDoc?.serialize()||JSON.stringify(window.__dbg?.state.items.map(row=>[row.start,row.end,row.l1,row.l2]));
      const project=window.__dbg?.state.project,before=path==='/api/translate/one'?snapshot():null;
      const translation=await import('/studio/android-translate.js'),result=await translation.route(path,method,await jsonBody(options.body));
      if(before!==null&&(project!==window.__dbg?.state.project||before!==snapshot()))return response({error:'翻译期间稿件已变化，请重试'},409);
      return response(result);
    }
    if(path==='/api/youtube/updates')return response({channels:[],items:[],stale:false});
    if(path==='/api/logs/client'||path==='/api/diag'){if(path==='/api/logs/client'&&options.body)errors.push(String(options.body).slice(0,4000));return response({ok:true});}
    if(path==='/api/projects'){
      if(method==='GET'){await migrate;return response({projects:(await rpc('studioList')).filter(p=>!p.archived).map(documentMeta)});}
      if(method==='POST'){
        const data=await jsonBody(options.body);if(data.draft)return response({error:'识别流水线将在编辑器移植后接入'},501);
        let media=data.video||{},source=data.source;
        if(data.fetch?.url&&!media.path){
          const download=await import('/studio/android-download.js');
          const result=await download.finish(await rpc('downloadStart',{...data.fetch,kind:'download'}),options.signal);
          media={path:result.mediaId,name:result.mediaName};source=result.source;
        }
        const project=await rpc('studioCreate',{project:{name:data.name||data.subtitle?.name||'未命名稿件',subtitleName:data.subtitle?.name||'subtitle.ass',text:data.subtitle?.text||'',originalText:data.subtitle?.text||'',mediaId:media.path||'',mediaName:media.name||'',source,notes:[],oplog:[],createdAt:Date.now()}});
        return response(documentMeta(project));
      }
    }
    if(path==='/api/upload-video'){
      const imported=await rpc('uploadSelected',{name:url.searchParams.get('name')});
      return response({path:imported.id,name:imported.title});
    }
    const match=/^\/api\/projects\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(path);
    if(match){
      if(['glossary-review','glossary-apply-project','reseg-plan'].includes(match[2])){
        const assist=await import('/studio/android-assist.js');
        return response(await assist.route(match[1],match[2],method,await jsonBody(options.body),options.signal));
      }
      if((match[2]||'').startsWith('export-video')){
        const video=await import('/studio/android-video.js');
        return response(await video.route(match[1],match[2].slice('export-video'.length),method,await jsonBody(options.body)));
      }
      const id=match[1],action=match[2]||'',project=await load(id);
      if(!action){if(method==='DELETE')return response(await rpc('studioDelete',{id}));return response(documentMeta(project));}
      if(action==='subtitle'){
        if(method==='GET')return response(project.text||'',200,{ETag:'"'+project.revision+'"'});
        const text=typeof options.body==='string'?options.body:await options.body.text();
        const h=history.get(id)||{undo:[],redo:[]};
        const saved=await update(id,{text},url.searchParams.get('revision')??project.revision);
        if(text!==project.text){h.undo.push(project.text);if(h.undo.length>15)h.undo.shift();h.redo=[];history.set(id,h);}
        return response({ok:true,revision:saved.revision,savedAt:saved.modifiedAt});
      }
      if(action==='info'){const patch=await jsonBody(options.body);return response(documentMeta(await update(id,patch)));}
      if(action==='export-pack'){
        const encoded=await rpc('studioExportPack',{id}),bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
        return new Response(bytes,{headers:{'Content-Type':'application/zip','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(project.name||'SubFabric')+'.zip'}});
      }
      if(action==='relink'){const data=await jsonBody(options.body);return response(documentMeta(await update(id,{mediaId:data.path||data.video?.path,mediaName:data.name||data.video?.name,hasAudio:false,hasPeaks:false,prepare:null})));}
      if(action==='prepare'){
        const settings=await jsonBody(options.body);if(settings.mode&&settings.mode!=='raw')return response({error:'安卓端目前使用原声音轨，降噪处理尚未适配'},501);
        if(!project.mediaId)return response({error:'尚未关联媒体'},400);
        const saved=await rpc('studioPrepare',{id,mediaId:project.mediaId});return response(documentMeta(saved));
      }
      if(action==='notes'){
        let notes=project.notes||[];
        if(method==='POST'){const note=await jsonBody(options.body);notes.push({...note,id:crypto.randomUUID(),createdAt:Date.now()});await update(id,{notes});}
        if(method==='DELETE'){notes=notes.filter(note=>note.id!==url.searchParams.get('id'));await update(id,{notes});}
        return response({notes,items:notes,ok:true});
      }
      if(action==='oplog'){
        let entries=project.oplog||[];
        if(method==='POST'){const body=await jsonBody(options.body);entries.push(...(body.entries||[]));await update(id,{oplog:entries.slice(-5000)});}
        const byAction={};for(const entry of entries)byAction[entry.action]=(byAction[entry.action]||0)+1;
        return response({ok:true,entries,items:entries,total:entries.length,stats:{total:entries.length,byAction},snapshotTotal:entries.length,nextOffset:entries.length,hasMore:false});
      }
      if(action==='reidentify')return response({job:null});
      if(action==='realign-skip')return response({ok:true});
      if(action==='draft')return response({status:'done'});
    }
    return response({error:'此功能尚未完成安卓移植，当前先提供完整 ASS 编辑工作流'},501);
  }
  window.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return originalFetch(input,options);
    if(url.pathname==='/api/media'||/\/(audio|peaks|thumbnail)$/.test(url.pathname)||url.pathname==='/api/font-file')return originalFetch(input,options);
    try{return await api(url,options);}catch(error){return response({error:error.message},error.message.startsWith('CONFLICT:')?409:500);}
  };
  navigator.sendBeacon=(url,body)=>{window.fetch(url,{method:'POST',body}).catch(()=>{});return true;};
  // Android has no local Node lifecycle/log event stream. Preserve the event interface without network retries.
  window.EventSource=class extends EventTarget{constructor(){super();this.readyState=1;}close(){this.readyState=2;}};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download&&this.href.startsWith('blob:')){
      const href=this.href,name=this.download;
      originalFetch(href).then(r=>r.blob()).then(blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({base64:String(reader.result).split(',')[1],mime:blob.type||'application/octet-stream',name});reader.onerror=reject;reader.readAsDataURL(blob);})).then(data=>rpc('export',data)).then(result=>document.dispatchEvent(new CustomEvent('android-export',{detail:result}))).catch(error=>alert(error.message));return;
    }
    return click.call(this);
  };
  window.androidStudio={rpc,load,update,documentMeta,history,async create(name,text,subtitleName=name){return rpc('studioCreate',{project:{name,subtitleName,text,originalText:text,notes:[],oplog:[],createdAt:Date.now()}});}};
})();
