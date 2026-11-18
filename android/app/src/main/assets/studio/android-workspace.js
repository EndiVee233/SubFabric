/** Android product scope: import/recognize, translate, edit and export. Desktop stays complete. */
export const editorTools=new Set(['保存','关联媒体','翻译字幕','翻译设置','逐词对齐','撤销','重做','添加字幕','拆分字幕','合并上一句','适合窗口']);
export const editorTabs=new Set(['subs','roles','settings']);
const removedRoutes=new Set(['#/help','#/batch']);
const omitted=[
  '#sf-settings-tab-theme','#st-panel-theme','#sf-settings-tab-fetch','#st-panel-fetch',
  '#sf-settings-tab-perf','#st-panel-perf','#sf-settings-tab-enhance','#st-panel-enhance',
  '#help-view','#batch-view','.ws-kicker','.sf-settings-heading > p',
  '.page-eyebrow','#np-view .ws-sub','#np-view .np-input-panel .ws-head','#np-view .np-settings-panel .ws-head',
  '#home-view .sf-cover','#home-view .home-head','#home-view .home-list-title','#st-view .page-head','#st-view .page-intro',
  '#sf-asr-families > button:not([id="android-parakeet-tile"]):not([id="qwen3-asr-0.6b-android"]):not([id="qwen3-forced-aligner-android"])',
  '#st-entry-asr','#st-entry-llm','.st-entries','.sf-settings-nav-label','.sf-settings-kicker',
  '#btn-settings','#btn-batch-draft','#sf-list-mode','.pc-actions .sf-choice-shell',
  '#tab-logs','[data-tab="logs"]',
  '#word-convert-group','#sf-editor-timeline','#editor-advanced-actions','#ass-fx-group',
  '#sf-editor-media','#sf-editor-export','#ass-style-preset-export','#ass-style-preset-import',
  '#np-row-url','#np-row-part','#np-cast-group .np-cast-head','#np-row-conf','#np-row-spk',
  '#dt-set-speakers-note','#dt-advanced',
  '#detail-url','#detail-probe','#btn-low-conf','#btn-badcat',
  '#card-menu [data-act="fix"]','#card-menu [data-act="karaoke-style"]','#card-menu [data-act="word-continuity"]',
  '#tl-menu [data-act="fix"]','#tl-menu [data-act="karaoke-style"]','#tl-menu [data-act="word-continuity"]',
  '[data-android-omit]',
];
export function initWorkspace({dbg,bar,more,flush,status}){
  const $=id=>document.getElementById(id),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const style=document.createElement('style');style.textContent=omitted.join(',')+'{display:none!important} #android-bottom-nav{grid-template-columns:repeat(3,minmax(0,1fr))!important}';document.head.append(style);
  // Keep the backing nodes and data; only the Android surface is reduced.
  $('tab-settings')?.querySelectorAll('.set-group').forEach(n=>{if(!['android-editor-tools','ass-style-group'].includes(n.id))n.dataset.androidOmit='';});
  function action(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>Promise.resolve().then(fn).catch(e=>status(e.message));return b;}
  async function navigate(route){
    await flush();if(removedRoutes.has(route))route='#/home';
    if(route==='#/home')document.querySelector('#sf-nav [data-route="home"]')?.click();
    location.hash=route;
    if(route==='#/home')await window.__androidRefreshLibrary?.();
    if(route==='#/new'){
      for(let n=0;n<40&&$('np-view').hidden;n++)await wait(25);
      $('np-mode-draft').click();
    }
  }
  async function settings(section='models'){
    await navigate('#/settings');
    for(let n=0;n<40&&$('st-view').hidden;n++)await wait(25);
    document.querySelector('.st-tab[data-stp="'+(section==='translate'?'translate':'models')+'"]')?.click();
  }
  const home=document.createElement('section');home.id='android-home-flow';
  const title=document.createElement('h1');title.textContent='开始创作';home.append(title);
  const hint=document.createElement('p');hint.textContent='识别 → 翻译 → 编辑';home.append(hint);
  home.append(action('新建稿件',()=>navigate('#/new')),action('导入字幕',()=>[...bar.children,...more.children].find(n=>n.textContent==='打开字幕')?.click()),action('打开稿件库',()=>navigate('#/home')));
  for(const child of $('dashboard-view').children)child.dataset.androidOmit='';$('dashboard-view').append(home);
  const storage=action('存储空间',()=>navigate('#/storage'));storage.id='android-storage-link';$('st-view').append(storage);
  const modelLoading=document.createElement('p');modelLoading.textContent='正在读取模型状态…';$('sf-asr-home').prepend(modelLoading);
  $('btn-new-project').textContent='新建稿件';
  $('btn-new-project').addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();navigate('#/new').catch(e=>status(e.message));},true);
  $('np-pick-video').textContent='选择视频';$('np-pick-sub').textContent='选择字幕';
  function fold(node,label){
    if(!node||node.closest('[data-android-fold]'))return;
    const details=document.createElement('details');details.dataset.androidFold='';
    const summary=document.createElement('summary');summary.textContent=label;details.append(summary);node.before(details);details.append(node);return details;
  }
  fold($('ass-style-group'),'字幕样式');
  const preview=fold(document.querySelector('#np-view .np-preview-panel'),'视频预览');
  const progress=fold(document.querySelector('#np-view .np-progress-panel'),'处理进度');
  $('np-pick-pack')?.closest('.np-file-row')?.setAttribute('data-android-omit','');
  for(const input of ['st-batch','st-temperature','st-prompt']){
    const field=$(input);if(field)fold(field.closest('.st-card'),input==='st-prompt'?'高级翻译提示词':'高级调用参数');
  }
  // These desktop-only pipeline switches must not be silently submitted as enabled.
  for(const id of ['dt-set-cast','dt-set-speakers'])$(id)?.closest('label')?.setAttribute('data-android-omit','');
  const cast=$('dt-set-cast')?.closest('.ws-checks')?.previousElementSibling;if(cast)cast.dataset.androidOmit='';
  $('dt-set-confidence')?.closest('.ws-row')?.setAttribute('data-android-omit','');
  let previous='';
  function sync(){
    if(removedRoutes.has(location.hash)){location.hash='#/home';return;}
    if(location.hash==='#/settings'){
      const active=document.querySelector('#st-view .st-tab.active');
      if(!active||!['models','translate'].includes(active.dataset.stp))document.querySelector('#sf-settings-tab-models')?.click();
    }
    if(!editorTabs.has(dbg.panel._tab))dbg.panel.showTab('subs');
    modelLoading.hidden=!!$('android-parakeet-tile');
    if(!$('android-asr-stop')?.hidden&&progress)progress.open=true;
    for(const b of document.querySelectorAll('#home-list .pc-details'))if(b.textContent!=='识别/翻译')b.textContent='识别/翻译';
    if(location.hash!==previous){previous=location.hash;document.body.classList.remove('android-notes-open','android-filter-open','android-nav-open');}
  }
  window.addEventListener('hashchange',sync);sync();
  function roots(route){
    if(route!=='#/new')return null;
    const video=preview?.querySelector('video');
    return [document.querySelector('#np-view .np-input-panel'),$('np-settings-panel'),video?.getAttribute('src')?preview:null,progress].filter(Boolean);
  }
  const api={sync,navigate,settings,home,roots};window.__androidWorkspace=api;return api;
}
