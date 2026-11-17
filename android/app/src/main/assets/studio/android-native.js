import {fmtTime,parseTime} from '/editor/js/util.js';

/** Native widgets consume view descriptions; shared controllers still own all document edits. */
export function initNative({dbg,flush,status,mobile}){
  if(typeof window.SubFabric?.ui!=='function')return;
  const body=document.body,ids=new WeakMap(),nodes=new Map(),items=new WeakMap(),itemNodes=new Map();
  let serial=0,itemSerial=0,last='',edit=null,stopped=false,editGeneration=0;
  const key=node=>{if(!ids.has(node)){const id=String(++serial);ids.set(node,id);nodes.set(id,node);}return ids.get(node);};
  const itemKey=item=>{if(!items.has(item)){const id=String(++itemSerial);items.set(item,id);itemNodes.set(id,item);}return items.get(item);};
  const clean=s=>(s||'').replace(/\s+/g,' ').trim();
  const visible=node=>{for(let n=node;n&&n!==body;n=n.parentElement){if(n.hidden||getComputedStyle(n).display==='none'||getComputedStyle(n).visibility==='hidden')return false;}return true;};
  function fieldLabel(node){
    const explicit=node.id&&document.querySelector('label[for="'+CSS.escape(node.id)+'"]');
    const parent=node.closest('label');
    const source=explicit||parent,copy=source?.cloneNode(true);copy?.querySelectorAll('input,textarea,select,.sf-choice-shell,svg').forEach(n=>n.remove());
    return clean(copy?.textContent||node.getAttribute('aria-label')||node.title||node.placeholder||node.id);
  }
  function describe(root){
    const out=[];
    function walk(node){
      if(out.length>=6000)return;
      if(node.nodeType===3){const text=clean(node.textContent);if(text)out.push({kind:'text',text});return;}
      if(node.nodeType!==1||/^(SCRIPT|STYLE|SVG|PATH|CANVAS|OPTION|TEMPLATE)$/.test(node.tagName))return;
      if(node.matches('#st-panel-theme .sf-appearance-card')){out.push({kind:'heading',text:'Windows Phone',large:true},{kind:'text',text:'深色背景 · 直角布局 · 蓝色强调'});return;}
      // Custom desktop choice widgets hide their real select. Read that model once.
      if(node.classList.contains('sf-choice-shell')&&visible(node)){
        const select=node.querySelector('select');if(select){control(select);return;}
      }
      if(!visible(node))return;
      if(node.tagName==='VIDEO'){
        const source=node.currentSrc||node.src;
        if(source){const url=new URL(source,location.href),id=url.pathname.startsWith('/media/')?url.pathname.slice(7):url.searchParams.get('path');if(/^[0-9a-f-]{36}$/.test(id||''))out.push({kind:'video',mediaId:id});}return;
      }
      if(node.matches('.home-toolbar-btns,#sf-filters,.pc-actions,.android-inline-tools,.st-tabs')){
        const choices=[...node.querySelectorAll('button')].filter(visible).map(n=>({id:key(n),text:clean(n.textContent)||n.title||'操作',disabled:!!n.disabled,active:n.classList.contains('active')}));
        if(choices.length){out.push({kind:'buttons',columns:node.matches('#sf-filters')?4:node.matches('.home-toolbar-btns,.pc-actions')?3:2,choices});return;}
      }
      if(node.tagName==='LABEL'&&!node.querySelector('button')){const field=node.querySelector('input:not([type=hidden]),textarea,select');if(field){control(field);return;}}
      if(node.matches('button,a[href],[role=button],[role=option],summary,.role-card,.rn-swatch,[data-hex]')){
        const text=clean(node.textContent)||node.getAttribute('aria-label')||node.title||'操作';
        out.push({kind:'button',id:key(node),text:node.classList.contains('rn-swatch')?node.dataset.c:text,context:node.classList.contains('role-card'),disabled:!!node.disabled,active:node.classList.contains('active')||node.getAttribute('aria-selected')==='true'});return;
      }
      if(node.matches('input,textarea,select,[contenteditable=true]')){control(node);return;}
      if(node.matches('img'))return;
      if(node.matches('h1,h2,h3,h4,legend,.pc-name')){out.push({kind:'heading',text:clean(node.textContent),large:node.matches('h1,h2')});return;}
      if(node.matches('progress')){out.push({kind:'progress',value:node.value,max:node.max});return;}
      if(node.matches('details')&&!node.open){const summary=node.querySelector('summary');if(summary)walk(summary);return;}
      for(const child of node.childNodes)walk(child);
      if(node.matches('section,.sf-card,.proj-card,.cue-card,.role-card,.set-group,.stg-row,tr'))out.push({kind:'divider'});
    }
    function control(node){
      if(node.tagName==='INPUT'&&node.type==='hidden')return;
      const base={id:key(node),text:fieldLabel(node),disabled:!!node.disabled,readonly:!!node.readOnly};
      if(node.tagName==='SELECT')out.push({...base,kind:'select',value:node.value,options:[...node.options].filter(o=>!o.hidden).map(o=>({text:o.textContent,value:o.value,disabled:o.disabled||!!o.parentElement?.disabled}))});
      else if(node.type==='checkbox'||node.type==='radio')out.push({...base,kind:'check',value:node.checked});
      else if(node.type==='file')out.push({...base,kind:'button',text:base.text||'选择文件'});
      else if(node.type==='range')out.push({...base,kind:'range',value:node.value,min:node.min||0,max:node.max||100,step:node.step||1});
      else if(node.type==='color')out.push({...base,kind:'color',value:node.value});
      else out.push({...base,kind:'input',type:node.type||'text',value:node.isContentEditable?node.textContent:node.value,multiline:node.tagName==='TEXTAREA'||node.isContentEditable,placeholder:node.placeholder||''});
    }
    walk(root);return out;
  }
  function modalRoot(){
    const selectors='dialog[open],[role=dialog],.modal-overlay,.sf-choice-menu,.sscp,.fp-panel,#sf-export-video,#st-drawer,#role-new,#role-rename,#sf-folder-dialog,#sf-asr-params,#stg-dialog';
    const dialogs=[...document.querySelectorAll(selectors+', [id$="-overlay"]')].filter(n=>!['srt-overlay','cue-hit-shield'].includes(n.id)&&visible(n));
    const candidates=[...dialogs,...[dbg.panel.cardMenu,dbg.panel.roleMenu,dbg.timeline.menuEl].filter(n=>n&&visible(n))];
    if(body.classList.contains('android-notes-open'))candidates.push(document.getElementById('note-bar'));
    return candidates.filter(n=>n&&n.id!=='welcome-view').sort((a,b)=>(b.id==='note-bar'?-1:Number(getComputedStyle(b).zIndex)||0)-(a.id==='note-bar'?-1:Number(getComputedStyle(a).zIndex)||0))[0];
  }
  function snapshot(){
    if(stopped)return;
    for(const [id,node]of nodes)if(!node.isConnected)nodes.delete(id);
    const current=new Set(dbg.state.items||[]);for(const [id,item]of itemNodes)if(!current.has(item)&&edit?.item!==item)itemNodes.delete(id);
    const editor=/^#\/project\//.test(location.hash),root=modalRoot();
    const state={route:location.hash,editor,title:editor?'':clean(document.querySelector('.workspace-page:not([hidden]) h1,#home-view:not([hidden]) h1')?.textContent)||'SubFabric',save:document.getElementById('save-state')?.textContent||'',tab:dbg.panel._tab||'subs',dark:true};
    if(editor){
      state.project=dbg.state.project?.id||'';
      if(state.tab==='subs'){
        const mode=dbg.panel._mode;
        state.rows=(dbg.panel.filtered||dbg.state.items||[]).map(it=>({id:itemKey(it),start:fmtTime(it.start),end:fmtTime(it.end),l1:mode==='second'?'':(it.l1||'').replace(/^\s*\[[^\]]+\]\s*/,''),l2:mode==='first'?'':it.l2||'',role:(it.speaker||'').replace(/^\[|\]$/g,''),color:it.color||'#0078d7',skip:!!it.realignSkip,confidence:typeof it.confidence?.score==='number'?Math.round(it.confidence.score*100)+'%':'',bad:it.bad?it.badReason||'异常行':'',style:[it.badge1,it.badge2].filter(Boolean).join(' · ')}));
        state.controls=describe(document.querySelector('#tab-subs .panel-head'));
      }else state.controls=describe(document.getElementById('tab-'+state.tab));
    }else{
      const page=[...document.querySelectorAll('.workspace-page,#home-view,#help-view,#welcome-view')].find(visible);
      state.controls=page?describe(page):[];
    }
    if(root){root.classList.add('android-native-modal');state.modal={id:key(root),title:clean(root.querySelector('h1,h2,h3,.modal-title')?.textContent)||'操作',controls:describe(root)};}
    if(edit)state.edit=edit.descriptor;
    const encoded=JSON.stringify(state);
    if(encoded!==last){last=encoded;window.SubFabric.ui(encoded);}
    return state;
  }
  function playing(){
    if(stopped||!/^#\/project\//.test(location.hash))return;
    const time=dbg.video.currentTime,rows=dbg.panel.filtered||dbg.state.items||[];
    const it=rows.find(i=>time>=i.start&&time<i.end);
    window.SubFabric.ui(JSON.stringify({tick:true,playing:it?itemKey(it):'',selected:dbg.state.selected?itemKey(dbg.state.selected):'',follow:!!dbg.panel.followPlayback,paused:dbg.video.paused,time,duration:dbg.video.duration,muted:dbg.video.muted,rate:dbg.video.playbackRate}));
  }
  async function beginEdit(item){
    const generation=++editGeneration,projectId=dbg.state.project?.id;
    await flush();if(!dbg.state.items.includes(item)||dbg.state.project?.id!==projectId)throw Error('字幕已变化，请重新选择');
    const project=await window.androidStudio.load(projectId);
    if(generation!==editGeneration||dbg.state.project?.id!==projectId||!dbg.state.items.includes(item))throw Error('字幕已变化，请重新选择');
    const tag=/^\s*\[[^\]]+\]\s*/.exec(item.l1||'')?.[0]||'';
    edit={item,project:project.id,revision:project.revision,doc:dbg.state.assDoc,start:item.start,end:item.end,l1:item.l1,l2:item.l2,tag,descriptor:{id:itemKey(item),l1:(item.l1||'').slice(tag.length),l2:item.l2||'',start:fmtTime(item.start),end:fmtTime(item.end)}};
    dbg.panel.editItem=item;
  }
  async function command(action){
    try{
      const item=action.item?itemNodes.get(action.item):null;
      if(action.routeOwner&&action.routeOwner!==location.hash)throw Error('页面已切换，请重新操作');
      if(action.project&&action.project!==dbg.state.project?.id)throw Error('稿件已切换，请重新操作');
      if(action.kind==='route'){await flush();location.hash=action.route;}
      else if(action.kind==='play'){if(dbg.video.paused)await dbg.video.play();else dbg.video.pause();}
      else if(action.kind==='seek'){dbg.video.currentTime=Math.max(0,Math.min(dbg.video.duration,Number(action.time)||0));window.__androidFollowSeek?.(dbg.video.currentTime);}
      else if(action.kind==='mute'){dbg.video.muted=!dbg.video.muted;}
      else if(action.kind==='rate'){dbg.video.playbackRate=Number(action.value)||1;}
      else if(action.kind==='tab'){await flush();dbg.panel.showTab(action.tab);}
      else if(action.kind==='back'){if(edit)edit=null;else await window.androidBack();}
      else if(action.kind==='actions')mobile.actionSheet();
      else if(action.kind==='more')mobile.moreSheet();
      else if(action.kind==='export')document.getElementById('btn-export').click();
      else if(['select','seekCue','edit','menu','rowAction'].includes(action.kind)){
        if(!item||!dbg.state.items.includes(item))throw Error('字幕已变化，请重新选择');
        if(['select','seekCue','edit','menu'].includes(action.kind))dbg.panel.onSelect?.(item);
        if(action.kind==='select'||action.kind==='seekCue')dbg.panel.select(item,false);
        if(action.kind==='seekCue')dbg.panel.onSeek?.(item);
        if(action.kind==='edit')await beginEdit(item);
        if(action.kind==='menu')dbg.panel._showCardMenu(12,100,item);
        if(action.kind==='rowAction'&&['skip','rerecog'].includes(action.action)){
          const index=dbg.panel.filtered.indexOf(item);if(index<0)throw Error('字幕筛选已变化');
          const card=document.createElement('div'),button=document.createElement('button');card.dataset.idx=index;card.className='cue-card';button.className='cc-'+action.action;button.dataset.act=action.action;card.append(button);dbg.panel.spacerEl.append(card);try{button.click();}finally{card.remove();}
        }
      }else if(action.kind==='editCancel'){++editGeneration;const item=edit?.item;edit=null;if(dbg.panel.editItem===item)dbg.panel.editItem=null;if(item?.isNew&&!item.l1&&!item.l2)dbg.panel.onEmptyNew?.(item);}
      else if(action.kind==='editApply'){
        const owner=edit;if(!owner)throw Error('编辑已结束');
        if(!Number.isFinite(parseTime(action.start))||!Number.isFinite(parseTime(action.end))||parseTime(action.start)<0||parseTime(action.end)<=parseTime(action.start))throw Error('请输入有效的字幕起止时间');
        const current=await window.androidStudio.load(owner.project);
        if(dbg.state.project?.id!==owner.project||dbg.state.assDoc!==owner.doc||current.revision!==owner.revision||!dbg.state.items.includes(owner.item)||owner.item.start!==owner.start||owner.item.end!==owner.end||owner.item.l1!==owner.l1||owner.item.l2!==owner.l2)throw Error('字幕已变化，保留输入后重新打开编辑');
        const l1=String(action.l1||'').replace(/\s+/g,' ').trim(),l2=String(action.l2||'').replace(/\s+/g,' ').trim();
        const text=(owner.tag&&!/^\[/.test(l1)?owner.tag:'')+l1+'\n'+l2;
        if(dbg.panel.editItem===owner.item)dbg.panel.editItem=null;
        if(text!==(owner.l1||'')+'\n'+(owner.l2||''))dbg.panel.onApply({item:owner.item,start:action.start,end:action.end,dur:'',text});
        else if(action.start!==fmtTime(owner.start)||action.end!==fmtTime(owner.end))dbg.panel.onApply({item:owner.item,start:action.start,end:action.end,dur:'',text});
        await flush();edit=null;
      }else if(action.kind==='dismiss'){
        const root=nodes.get(action.id);if(root?.isConnected){
          if(root.id==='note-bar')body.classList.remove('android-notes-open');else if(root===dbg.panel.cardMenu)dbg.panel._hideCardMenu();else if(root===dbg.timeline.menuEl)dbg.timeline._hideMenu();else if(root===dbg.panel.roleMenu)dbg.panel._hideRoleMenu();else await window.androidBack();
        }
      }else{
        const node=nodes.get(action.id);
        if(!node?.isConnected||node.disabled||!visible(node)&&!(node.matches('select.sf-choice-native')&&visible(node.parentElement)))throw Error('控件已变化，请重试');
        if(action.kind==='click')node.click();
        else if(action.kind==='context')node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:12,clientY:100}));
        else if(action.kind==='value'){
          if(node.readOnly)return;
          if(node.type==='checkbox'||node.type==='radio'){if(node.checked!==!!action.value)node.click();}
          else{if(node.isContentEditable)node.textContent=String(action.value);else node.value=String(action.value);if(action.phase!=='change')node.dispatchEvent(new Event('input',{bubbles:true}));if(action.phase!=='input')node.dispatchEvent(new Event('change',{bubbles:true}));}
        }
      }
    }catch(error){status(error.message);window.SubFabric.ui(JSON.stringify({error:error.message}));}
    finally{setTimeout(snapshot,80);}
  }
  body.classList.add('android-native');
  const style=document.createElement('style');style.textContent=`
    body.android-native[data-android-editor=true]{padding:0!important;--android-bottom:0px!important}
    body.android-native[data-android-editor=true] #app{display:grid!important;width:100%!important;height:100vh!important;padding:0!important;margin:0!important;gap:0!important;grid-template-columns:100%!important;grid-template-rows:minmax(0,1fr) 140px!important}
    body.android-native[data-android-editor=true] #toolbar,body.android-native #android-tools,body.android-native #android-bottom-nav{display:none!important}
    body.android-native .android-native-modal{opacity:0!important;pointer-events:none!important}
    body.android-native #note-bar{position:fixed!important;left:-10000px!important;top:0!important;width:600px!important}
    body.android-native[data-android-editor=true] #sf-player{opacity:0!important;pointer-events:none!important}
    body.android-native[data-android-editor=true] #stage-wrap{grid-area:1/1!important;padding:0!important}
    body.android-native[data-android-editor=true] #video-stage{inset:0 0 40px!important;height:auto!important}
    body.android-native[data-android-editor=true] #timeline-panel{grid-area:2/1!important;height:140px!important}
    body.android-native[data-android-editor=true] #editor-panel{position:fixed!important;left:-10000px!important;top:0!important;width:600px!important;height:800px!important;display:flex!important}
  `;document.head.append(style);
  window.androidNative={command,snapshot,playing};
  const commit=dbg.panel.commitEdit.bind(dbg.panel);
  dbg.panel.commitEdit=(...args)=>{if(edit&&dbg.panel.editItem===edit.item)return;return commit(...args);};
  dbg.panel.startEdit=item=>{beginEdit(item).then(snapshot).catch(error=>{status(error.message);window.SubFabric.ui(JSON.stringify({error:error.message}));});};
  const clickInput=HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click=function(){if(this.type==='file'){window.androidChooseInput(this).catch(error=>{status(error.message);window.SubFabric.ui(JSON.stringify({error:error.message}));});return;}return clickInput.call(this);};
  setInterval(snapshot,350);setInterval(playing,200);snapshot();
  return ()=>{stopped=true;};
}
