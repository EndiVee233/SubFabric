import {ico} from '/editor/js/icons.js';
/** Phone navigation and bottom sheets. Desktop editor handlers remain the single action implementation. */
export function initMobile({bar,more,flush,status}){
  const phone=matchMedia('(max-width:759px), (max-width:1000px) and (max-height:500px)'),nav=document.createElement('nav');
  nav.id='android-bottom-nav';nav.setAttribute('aria-label','手机底部功能栏');
  let sheet;
  const button=(parent,label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>Promise.resolve().then(fn).catch(e=>{const message=sheet?.querySelector('[role=alert]');if(message){message.textContent=e.message;message.hidden=false;}else status(e.message);});parent.append(b);return b;};
  function close(){if(sheet){sheet.close();sheet.remove();sheet=null;}}
  function panel(title){
    close();more.hidden=true;sheet=document.createElement('dialog');sheet.id='android-mobile-sheet';
    const head=document.createElement('header'),h=document.createElement('h2');h.textContent=title;head.append(h);button(head,'关闭',close);sheet.append(head);
    const error=document.createElement('p');error.setAttribute('role','alert');error.hidden=true;sheet.append(error);
    const body=document.createElement('div');body.className='android-mobile-sheet-body';sheet.append(body);document.body.append(sheet);
    sheet.addEventListener('click',event=>{if(event.target===sheet){const r=sheet.getBoundingClientRect();if(event.clientY<r.top||event.clientY>r.bottom)close();}});
    const dialog=sheet;dialog.addEventListener('close',()=>{dialog.remove();if(sheet===dialog)sheet=null;});sheet.showModal();return body;
  }
  function actionSheet(){
    const body=panel('稿件操作');
    for(const original of [...bar.children,...more.children]){
      if(original.tagName!=='BUTTON'||['☰','更多'].includes(original.textContent))continue;
      if(!/^#\/project\//.test(location.hash)&&!['打开字幕','导入项目包','新建 ASS','下载素材','翻译设置'].includes(original.textContent))continue;
      button(body,original.textContent,()=>{close();original.click();});
    }
  }
  async function go(route){await flush();close();location.hash=route;}
  function moreSheet(){
    const body=panel('更多功能');
    for(const [label,route]of [['设置','#/settings'],['存储空间','#/storage'],['帮助与快捷键','#/help']])button(body,label,()=>go(route));
    button(body,'新建文件夹',()=>{close();document.getElementById('sf-folder-add').click();});
    const heading=document.createElement('h3');heading.textContent='文件夹';body.append(heading);
    for(const folder of document.querySelectorAll('#sf-folders [data-folder]')){
      const id=folder.dataset.folder;
      const current=attribute=>{const node=[...document.querySelectorAll('#sf-folders ['+attribute+']')].find(n=>n.dataset[attribute==='data-folder'?'folder':'removeFolder']===id);if(!node)throw new Error('文件夹已变化，请重新打开');return node;};
      const row=document.createElement('div');row.className='android-mobile-folder';body.append(row);
      button(row,folder.querySelector('span')?.textContent||folder.textContent,async()=>{await flush();const node=current('data-folder');close();node.click();});
      const remove=folder.parentNode.querySelector('[data-remove-folder]');if(remove)button(row,'移除',()=>{const node=current('data-remove-folder');close();node.click();});
    }
  }
  const items=[['主页',()=>go('#/dashboard')],['稿件',()=>go('#/home')],['操作',actionSheet],['更多',moreSheet]];
  items.forEach(([label,fn],i)=>{const b=button(nav,label,fn);b.setAttribute('aria-label',label);b.insertAdjacentHTML('afterbegin',ico(['home','folder','wand','sliders'][i]));b.dataset.mobileTab=String(i);});document.body.append(nav);
  function sync(){
    const hash=location.hash,id=/^#\/project\/([0-9a-f-]{36})$/.exec(hash)?.[1];
    if(id){localStorage.setItem('android-last-project',id);}
    const selected=hash==='#/dashboard'?0:hash==='#/home'?1:3;
    for(const b of nav.children){b.setAttribute('aria-current',Number(b.dataset.mobileTab)===selected?'page':'false');}
    document.body.classList.toggle('android-phone',phone.matches);if(!phone.matches)close();
    document.body.classList.remove('android-nav-open');
  }
  const tools=document.createElement('button');tools.type='button';tools.id='android-editor-actions';tools.className='btn';tools.textContent='操作';tools.setAttribute('aria-label','稿件操作');tools.onclick=actionSheet;document.querySelector('#toolbar .tb-right').prepend(tools);
  // Dashboard shortcuts lead to the library; only a draft Open action enters the editor.
  document.getElementById('dashboard-view').addEventListener('click',event=>{
    if(event.target.closest('[data-widget=resume],#sf-mu-resume,[data-mu-attn=resume]')){event.preventDefault();event.stopImmediatePropagation();go('#/home').catch(e=>status(e.message));}
  },true);
  phone.addEventListener('change',sync);window.addEventListener('hashchange',()=>{close();sync();});sync();
  return {close,hasSheet:()=>!!sheet,actionSheet,moreSheet};
}
