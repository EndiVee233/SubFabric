const rpc=(action,payload={})=>window.androidStudio.rpc(action,payload);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function finish(job,signal){
  while(job.status==='running'){
    if(signal?.aborted){await rpc('downloadCancel',{id:job.id});throw new Error('任务已取消');}
    await wait(400);job=await rpc('downloadStatus',{id:job.id});
  }
  if(job.status!=='done')throw new Error(job.error||'下载未完成');
  const result=job.result;
  if(result?.source&&result.hasThumbnail)result.source.thumbnail='/api/downloads/'+job.id+'/thumbnail';
  return result;
}
export async function route(path,method,body,signal){
  if(path==='/api/fetch/settings')return rpc('downloadSettings',method==='POST'?{patch:body}:{});
  if(path==='/api/fetch/probe')return finish(await rpc('downloadStart',{...body,kind:'probe'}),signal);
  if(path==='/api/fetch/check-cookie')return finish(await rpc('downloadStart',{kind:'cookie'}),signal);
  if(path==='/api/downloads')return method==='POST'?rpc('downloadStart',body):{jobs:await rpc('downloadList')};
  const match=/^\/api\/downloads\/([0-9a-f-]{36})(?:\/(cancel|retry))?$/.exec(path);
  if(match)return rpc(match[2]==='cancel'?'downloadCancel':match[2]==='retry'?'downloadRetry':'downloadStatus',{id:match[1]});
  throw new Error('未知下载接口');
}
export const emptyAss='[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,50,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
export async function attach(result,id){
  if(!result?.mediaId)throw new Error('素材尚未下载完成');
  const native=window.androidStudio;
  if(!id){const p=await native.create(result.source.title||'在线素材',emptyAss,'subtitle.ass');id=p.id;}
  await native.update(id,{mediaId:result.mediaId,mediaName:result.mediaName,source:result.source,hasAudio:false,hasPeaks:false,prepare:null});
  return id;
}
function element(tag,text,parent){const node=document.createElement(tag);if(text)node.textContent=text;parent?.append(node);return node;}
export async function showDownload({flush,open,status}){
  const previous=document.querySelector('.android-download-dialog');if(previous){previous.showModal();return;}
  const dialog=element('dialog');dialog.className='android-download-dialog';
  const header=element('header',null,dialog);element('h2','下载素材',header);
  const close=element('button','关闭',header);close.type='button';close.onclick=()=>dialog.close();
  const form=element('form',null,dialog);
  const label=element('label','视频或音频链接',form),url=element('input',null,label);url.type='url';url.required=true;url.placeholder='https://';url.autocomplete='off';
  const qualityLabel=element('label','画质',form),quality=element('select',null,qualityLabel);
  for(const [value,text]of[['best','自动'],['2160','2160p'],['1440','1440p'],['1080','1080p'],['720','720p'],['480','480p'],['360','360p'],['audio','仅音频'],['worst','最低画质']]){const option=element('option',text,quality);option.value=value;}
  const actions=element('div',null,form);actions.className='android-download-actions';
  const probe=element('button','解析链接',actions);probe.type='button';const start=element('button','开始下载',actions);start.type='submit';
  const cancelProbe=element('button','取消解析',actions);cancelProbe.type='button';cancelProbe.hidden=true;
  const settings=element('button','下载设置',actions);settings.type='button';settings.onclick=async()=>{await flush();dialog.close();location.hash='#/settings';await wait(150);document.getElementById('sf-settings-tab-fetch')?.click();};
  const message=element('p','下载在后台继续，可关闭此窗口。完成后可关联当前稿件或新建 ASS。',dialog);message.setAttribute('role','status');
  const preview=element('p',null,dialog);preview.className='android-download-preview';
  const jobs=element('div',null,dialog);jobs.className='android-download-jobs';
  let timer,probing='',fetching=false,closed=false;
  const busy=value=>{start.disabled=value;probe.disabled=value;};
  const run=async(kind)=>{
    busy(true);message.textContent=kind==='probe'?'正在解析链接':'正在启动下载';
    try{
      const job=await rpc('downloadStart',{kind,url:url.value.trim(),quality:quality.value});
      if(kind==='probe'){
        probing=job.id;cancelProbe.hidden=false;const result=await finish(job);preview.textContent=[result.source.title,result.source.uploader,result.source.duration?Math.round(result.source.duration)+' 秒':''].filter(Boolean).join(' · ');message.textContent='解析完成';
      }else message.textContent='下载已开始';
    }catch(error){message.textContent=error.message;}
    finally{probing='';cancelProbe.hidden=true;busy(false);refresh();}
  };
  probe.onclick=()=>run('probe');form.onsubmit=event=>{event.preventDefault();run('download');};
  cancelProbe.onclick=()=>rpc('downloadCancel',{id:probing}).catch(error=>message.textContent=error.message);
  function action(parent,label,fn){const b=element('button',label,parent);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(error){message.textContent=error.message;}finally{b.disabled=false;}};}
  async function refresh(){
    if(closed||fetching)return;fetching=true;
    try{
      const list=await rpc('downloadList');
      // Keep keyboard focus and pointer targets stable while polling.
      for(const job of list){
        let card=jobs.querySelector('[data-job="'+job.id+'"]');
        if(!card){card=element('article',null,jobs);card.dataset.job=job.id;element('strong',null,card);element('p',null,card);const p=element('progress',null,card);p.max=100;element('div',null,card);}
        card.querySelector('strong').textContent=job.result?.source?.title||job.url||'在线素材';
        const state=card.querySelector('p');state.textContent=job.error||job.stage||job.status;
        if(job.bytes)state.textContent+=' · '+(job.bytes/1048576).toFixed(1)+' MB';
        const p=card.querySelector('progress');p.value=job.pct||0;p.hidden=job.status!=='running';
        const controls=card.querySelector('div');
        if(card.dataset.status!==job.status){
          card.dataset.status=job.status;controls.replaceChildren();
          if(job.status==='running')action(controls,'取消下载',()=>rpc('downloadCancel',{id:job.id}));
          if(['error','cancelled','interrupted'].includes(job.status))action(controls,'重新下载',async()=>{await rpc('downloadRetry',{id:job.id});refresh();});
          if(job.status==='done'){
            const use=async current=>{await flush();const id=current?window.__dbg.state.project?.id:null;if(current&&!id)throw new Error('请先打开一份字幕');const target=await attach(job.result,id);dialog.close();await open(target);status('下载素材已关联');};
            action(controls,'关联当前稿件',()=>use(true));action(controls,'新建 ASS 稿件',()=>use(false));
          }
        }
      }
      if(!list.length)jobs.textContent='暂无下载任务';else if(jobs.firstChild?.nodeType===Node.TEXT_NODE)jobs.firstChild.remove();
    }catch(error){message.textContent=error.message;}finally{fetching=false;}
  }
  dialog.addEventListener('close',()=>{closed=true;clearInterval(timer);if(probing)rpc('downloadCancel',{id:probing}).catch(()=>{});dialog.remove();},{once:true});
  document.body.append(dialog);dialog.showModal();
  try{quality.value=(await rpc('downloadSettings')).quality||'best';}catch(error){message.textContent=error.message;}
  await refresh();timer=setInterval(refresh,700);
}
