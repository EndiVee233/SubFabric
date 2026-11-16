const $=id=>document.getElementById(id);
const native=window.androidStudio;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
while(!window.__dbg)await wait(50);
const dbg=window.__dbg;
// Subtitle-only documents use an explicit virtual playback clock, not a fabricated media file.
const mediaPrototype=HTMLMediaElement.prototype,video=dbg.video;
const noMedia=()=>!video.hasAttribute('src')&&!!dbg.state.assDoc;
const descriptors=Object.fromEntries(['currentTime','duration','paused','currentSrc','readyState'].map(key=>[key,Object.getOwnPropertyDescriptor(mediaPrototype,key)]));
let previewTime=0,previewPaused=true,lastFrame=performance.now();
for(const key of ['videoWidth','videoHeight']) {
  const descriptor=Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype,key);
  Object.defineProperty(video,key,{configurable:true,get(){return noMedia()?(key==='videoWidth'?dbg.state.assDoc.playResX:dbg.state.assDoc.playResY):descriptor.get.call(video);}});
}
const previewDuration=()=>Math.max(1,...(dbg.state.items||[]).map(item=>item.end));
for(const key of ['duration','paused','currentSrc','readyState'])Object.defineProperty(video,key,{configurable:true,get(){return noMedia()?({duration:previewDuration(),paused:previewPaused,currentSrc:'android:subtitle-preview',readyState:4})[key]:descriptors[key].get.call(video);}});
Object.defineProperty(video,'currentTime',{configurable:true,get(){return noMedia()?previewTime:descriptors.currentTime.get.call(video);},set(value){if(!noMedia())return descriptors.currentTime.set.call(video,value);previewTime=Math.max(0,Math.min(previewDuration(),Number(value)||0));video.dispatchEvent(new Event('timeupdate'));queueMicrotask(()=>video.dispatchEvent(new Event('seeked')));dbg.assPlayer.seek(previewTime);}});
const nativePlay=video.play.bind(video),nativePause=video.pause.bind(video);
video.play=()=>{if(!noMedia())return nativePlay();previewPaused=false;lastFrame=performance.now();video.dispatchEvent(new Event('play'));return Promise.resolve();};
video.pause=()=>{if(!noMedia())return nativePause();previewPaused=true;video.dispatchEvent(new Event('pause'));};
function frame(now){if(noMedia()&&!previewPaused){video.currentTime=previewTime+(now-lastFrame)/1000;if(previewTime>=previewDuration())video.pause();}lastFrame=now;requestAnimationFrame(frame);}requestAnimationFrame(frame);
let previewProject='';
setInterval(()=>{if(!noMedia())return;document.body.classList.add('android-subtitle-only');$('stage-hint').hidden=true;if(previewProject!==dbg.state.project?.id){previewProject=dbg.state.project?.id;dbg.timeline.setDuration(previewDuration());video.dispatchEvent(new Event('loadedmetadata'));dbg.assPlayer.seek(previewTime);}},250);
video.addEventListener('loadstart',()=>document.body.classList.remove('android-subtitle-only'));
const bar=document.createElement('div');bar.id='android-tools';bar.setAttribute('aria-label','安卓编辑操作');
const notice=document.createElement('div');notice.id='android-status';notice.setAttribute('role','status');document.body.append(notice);
let noticeTimer;
function status(message){notice.textContent=message;notice.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.hidden=true,4000);}
async function flush(){dbg.panel.commitEdit();await wait(50);await window.__subfabricFlushSave();}
async function open(id){await flush();location.hash='#/project/'+id;if(dbg.state.project?.id===id)await window.__androidRefreshProject(id);}
async function library(){if(location.hash==='#/home')await window.__androidRefreshLibrary();else location.hash='#/home';}
function button(label,fn){const node=document.createElement('button');node.textContent=label;node.type='button';node.onclick=()=>Promise.resolve().then(fn).catch(error=>status(error.message));bar.append(node);return node;}
button('☰',()=>document.body.classList.toggle('android-nav-open')).setAttribute('aria-label','展开导航');
button('打开字幕',async()=>{
  await flush();const file=await native.rpc('pickSubtitle');if(!file)return;
  const {isAssSubtitle,AssDoc}=await import('/editor/js/ass.js');const {parseSRT}=await import('/editor/js/srt.js');
  if(isAssSubtitle(file.text,file.name)){new AssDoc(file.text);if(!/^\s*\[Events\]/im.test(file.text))throw new Error('ASS 缺少 Events 段');}
  else if(!parseSRT(file.text).length)throw new Error('字幕格式无效，请选择 ASS 或 SRT');
  await native.create(file.name,file.text,file.name);await library();status('字幕已导入，请从稿件库打开');
});
button('关联媒体',async()=>{
  await flush();const id=dbg.state.project?.id;if(!id)throw new Error('请先打开一份字幕');
  const media=await native.rpc('pickMedia');if(!media)return;
  await native.update(id,{mediaId:media.id,mediaName:media.title,hasAudio:false,hasPeaks:false,prepare:null});
  location.hash='#/home';await wait(100);await open(id);
});
button('保存',async()=>{await flush();status('稿件已保存到安卓本机');});
button('下载素材',async()=>{const download=await import('./android-download.js');await download.showDownload({flush,open,library,status});});
button('术语校对',async()=>{await flush();if(!dbg.state.project)throw new Error('请先打开字幕');$('btn-glossary-review').click();});
button('语义重分句',async()=>{await flush();if(!dbg.state.project)throw new Error('请先打开字幕');$('btn-reseg-llm').click();});
button('翻译字幕',async()=>{const translation=await import('./android-translate.js');await translation.showTranslation();});
button('翻译设置',async()=>{await flush();location.hash='#/settings';});
button('导出视频',async()=>{await flush();const id=dbg.state.project?.id;if(!id)throw new Error('请先打开字幕');const {openExportVideoDialog}=await import('/editor/js/export-video.js');await openExportVideoDialog(id);});
button('导出原件',async()=>{const id=dbg.state.project?.id;if(!id)throw new Error('请先打开字幕');const p=await native.load(id);await native.rpc('export',{name:'original-'+p.subtitleName,text:p.originalText??p.text,mime:'text/plain'});});
button('导入项目包',async()=>{await flush();const p=await native.rpc('pickPack');if(p){await library();status('项目包已导入，请从稿件库打开');}});
for(const [label,direction]of[['撤销','undo'],['重做','redo']])button(label,async()=>{
  await flush();const id=dbg.state.project?.id,h=native.history.get(id);if(!h?.[direction]?.length)throw new Error('没有可恢复的编辑');
  const p=await native.load(id),text=h[direction].pop();h[direction==='undo'?'redo':'undo'].push(p.text);await native.update(id,{text},p.revision);
  location.hash='#/home';await wait(100);await open(id);
});
button('字幕操作',()=>{const item=dbg.state.selected||dbg.panel.filtered?.[0];if(!item)throw new Error('请先选中字幕');dbg.panel._showCardMenu(12,Math.min(innerHeight-300,180),item);});
button('添加字幕',async()=>{
  await flush();if(!dbg.state.project)throw new Error('请先打开字幕');
  const start=Math.max(0,...dbg.state.items.map(item=>item.end))+.1,end=start+3;
  if(dbg.state.format==='ass'&&!dbg.state.items.length){
    const {AssDoc}=await import('/editor/js/ass.js');const id=dbg.state.project.id,p=await native.load(id),doc=new AssDoc(p.text);
    doc.appendEvent({style:doc.styleNames[0]||'Default',start,end,text:'新字幕'});
    await native.update(id,{text:doc.serialize()},p.revision);location.hash='#/home';await wait(100);await open(id);
  }else dbg.timeline.onCreate(start,end);
  dbg.timeline.setDuration(Math.max(dbg.timeline.duration,end));
});
button('拆分字幕',async()=>{
  await flush();const item=dbg.state.selected;if(!item?.l2)throw new Error('请先选择带英文的字幕');
  const words=[...item.l2.matchAll(/\S+\s*/g)];if(words.length<2)throw new Error('至少需要两个英文词才能拆分');
  const dialog=document.createElement('dialog');dialog.className='android-split-dialog';
  const title=document.createElement('h3');title.textContent='选择拆分位置';dialog.append(title);
  for(const word of words.slice(0,-1)){
    const choice=document.createElement('button');choice.textContent=word[0].trim()+' ▸';choice.type='button';
    choice.onclick=()=>{dialog.close();dialog.remove();dbg.panel.onSplitRow(item,item.l2,word.index+word[0].trimEnd().length);};dialog.append(choice);
  }
  const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>{dialog.close();dialog.remove();};dialog.append(cancel);document.body.append(dialog);dialog.showModal();
});
button('合并上一句',async()=>{await flush();const item=dbg.state.selected;if(!item)throw new Error('请先选中字幕');dbg.panel.onMergePrev(item);});
button('适合窗口',()=>dbg.timeline.fit());
button('缩小',()=>dbg.timeline.zoomOut());button('放大',()=>dbg.timeline.zoomIn());
button('筛选',()=>document.body.classList.toggle('android-filter-open'));
button('备注',()=>document.body.classList.toggle('android-notes-open'));
for(const [label,focus]of[['专注字幕','subs'],['专注时间轴','timeline']])button(label,()=>{document.body.dataset.androidFocus=document.body.dataset.androidFocus===focus?'':focus;window.dispatchEvent(new Event('resize'));});
const newButton=button('新建 ASS',async()=>{
  const text='[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,50,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,请在字幕列表编辑这一句\n';
  await flush();await native.create('未命名 ASS',text,'subtitle.ass');await library();status('稿件已创建，请从稿件库打开');
});
newButton.id='android-new-ass';
const more=document.createElement('div');more.id='android-more';more.hidden=true;more.setAttribute('role','menu');
for(const node of [...bar.children].slice(4))more.append(node);
button('更多',()=>{more.hidden=!more.hidden;});document.body.append(more);
more.addEventListener('click',event=>{if(event.target.closest('button'))more.hidden=true;});
document.addEventListener('pointerdown',event=>{if(!more.contains(event.target)&&!bar.contains(event.target))more.hidden=true;});
document.body.prepend(bar);
const {initMobile}=await import('./android-mobile.js');
const mobile=initMobile({bar,more,flush,status});
// Route the original editor's file buttons through the same persistent Android workflow.
for(const [id,label]of [['btn-open-sub','打开字幕'],['btn-open-video','关联媒体']])$(id)?.addEventListener('click',event=>{
  event.preventDefault();event.stopImmediatePropagation();[...bar.querySelectorAll('button')].find(node=>node.textContent===label)?.click();
},true);
const exporting=new WeakSet();
for(const id of ['btn-export','btn-export-pack','btn-export-clean','btn-export-zh','btn-export-en','btn-export-full','btn-export-json','btn-export-advanced','btn-export-video'])$(id)?.addEventListener('click',event=>{
  const node=event.currentTarget;if(exporting.has(node))return;event.preventDefault();event.stopImmediatePropagation();
  flush().then(()=>{exporting.add(node);try{node.click();}finally{exporting.delete(node);}}).catch(error=>status(error.message));
},true);
document.addEventListener('android-progress',event=>status(event.detail.message));
document.addEventListener('android-export',event=>{if(event.detail)status('文件已导出到所选位置');});
// Touch access to desktop context menus, including role rename/color and word operations.
let hold,origin;
document.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='touch'||event.target.closest('input,textarea,[contenteditable]'))return;
  const target=event.target.closest('.role-card,.cue-card,#timeline');if(!target)return;
  origin={x:event.clientX,y:event.clientY};hold=setTimeout(()=>target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:origin.x,clientY:origin.y})),550);
});
for(const name of ['pointerup','pointercancel','scroll'])document.addEventListener(name,()=>clearTimeout(hold),true);
document.addEventListener('pointermove',event=>{if(origin&&Math.hypot(event.clientX-origin.x,event.clientY-origin.y)>9)clearTimeout(hold);});
const themes=window.SF_THEMES;window.SF_THEMES=Object.freeze({...themes,builtins:themes.builtins.filter(p=>p.id==='windows-uwp'),visibleBuiltins:themes.visibleBuiltins.filter(p=>p.id==='windows-uwp'),list:()=>themes.builtins.filter(p=>p.id==='windows-uwp'),get:()=>themes.get('windows-uwp',[])});
document.querySelectorAll('[data-theme-pack]').forEach(node=>{if(node.dataset.themePack!=='windows-uwp')node.hidden=true;});
// Screen keyboard gets room; the selected text remains scrollable and the original editor handles IME composition.
let redraw;
let viewportWidth=innerWidth,fullHeight=visualViewport?.height||innerHeight;
function resize(){
  const height=visualViewport?.height||innerHeight;
  if(Math.abs(innerWidth-viewportWidth)>Math.max(50,viewportWidth*.25)){viewportWidth=innerWidth;fullHeight=height;}
  else fullHeight=Math.max(fullHeight,height);
  const focused=document.activeElement,editing=focused&&(focused.isContentEditable||/^(INPUT|TEXTAREA)$/.test(focused.tagName));
  document.documentElement.style.setProperty('--android-height',height+'px');
  document.body.classList.toggle('android-keyboard',height<innerHeight*.78||!!editing&&height<fullHeight*.78);
  dbg.timeline.touch();clearTimeout(redraw);redraw=setTimeout(()=>{if(dbg.assPlayer.ready&&dbg.state.assDoc){dbg.assPlayer.instance.resize();dbg.assPlayer.updateNow(dbg.state.assDoc.serialize());dbg.assPlayer.seek(video.currentTime);}},180);
}
visualViewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);resize();
document.addEventListener('focusout',()=>setTimeout(resize,0));
let lastRoute='';
function route(){if(location.hash!==lastRoute){previewTime=0;previewPaused=true;lastRoute=location.hash;}document.body.dataset.androidEditor=String(/^#\/(?:project\/|editor)/.test(location.hash));document.body.classList.remove('android-nav-open');native.rpc('rememberRoute',{route:location.hash||'#/home'}).catch(()=>{});}
window.addEventListener('hashchange',route);route();
document.addEventListener('visibilitychange',()=>{if(document.hidden)flush().catch(()=>{});});
window.androidBack=async()=>{
  if(mobile.hasSheet()){mobile.close();return;}
  if($('stg-dialog')?.open){$('stg-dialog').close();return;}
  if($('sf-folder-dialog')?.hidden===false){$('sf-folder-dialog').querySelector('[data-folder-cancel]').click();return;}
  for(const kind of ['glossary','reseg'])if($(kind+'-overlay')?.hidden===false){$(kind+'-cancel').click();return;}
  const download=document.querySelector('.android-download-dialog[open]');if(download){download.close();return;}
  if($('sf-export-video')?.hidden===false){$('sf-ev-close').click();return;}
  const translation=document.querySelector('.android-translation-dialog[open]');if(translation){translation.dispatchEvent(new Event('cancel',{cancelable:true}));return;}
  if(!more.hidden){more.hidden=true;return;}
  await flush();if(location.hash!=='#/home')location.hash='#/home';else native.rpc('close');
};
window.androidReady=true;
window.__androidAssistCheck=async kind=>{const assist=await import('./android-assist.js');return assist.checkPreview(kind);};
window.__androidAssistOwner=async kind=>{const assist=await import('./android-assist.js');return assist.checkOwner(kind);};
for(const kind of ['glossary','reseg'])$(kind+'-cancel')?.addEventListener('click',()=>import('./android-assist.js').then(m=>m.cancel(kind)),true);
window.addEventListener('hashchange',()=>{for(const kind of ['glossary','reseg']){if($(kind+'-overlay')?.hidden===false)$(kind+'-cancel').click();else import('./android-assist.js').then(m=>m.cancel(kind));}});
document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const kind of ['glossary','reseg'])if($(kind+'-overlay')?.hidden===false)import('./android-assist.js').then(m=>m.cancel(kind));},true);
