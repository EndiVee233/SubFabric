import {ico} from '/editor/js/icons.js';
import {editorTools} from './android-workspace.js';
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
  async function go(route){await flush();close();location.hash=route;}
  const items=[['主页',()=>go('#/dashboard')],['稿件',()=>go('#/home')],['设置',()=>go('#/settings')]];
  items.forEach(([label,fn],i)=>{const b=button(nav,label,fn);b.setAttribute('aria-label',label);b.insertAdjacentHTML('afterbegin',ico(['home','folder','sliders'][i]));b.dataset.mobileTab=String(i);});document.body.append(nav);
  function sync(){
    const hash=location.hash,id=/^#\/project\/([0-9a-f-]{36})$/.exec(hash)?.[1];
    if(id){localStorage.setItem('android-last-project',id);}
    const selected=hash==='#/dashboard'?0:hash==='#/settings'||hash==='#/storage'?2:1;
    for(const b of nav.children){b.setAttribute('aria-current',Number(b.dataset.mobileTab)===selected?'page':'false');}
    document.body.classList.toggle('android-phone',phone.matches);if(!phone.matches)close();
    document.body.classList.remove('android-nav-open');
  }
  // Editing tools remain available in the Settings panel without crowding the header.
  const group=document.createElement('section');group.id='android-editor-tools';group.className='set-group';
  const heading=document.createElement('h3');heading.textContent='稿件工具';group.append(heading);
  const actions=document.createElement('div');actions.className='android-inline-tools';group.append(actions);
  for(const original of [...bar.children,...more.children]){
    if(original.tagName!=='BUTTON'||!editorTools.has(original.textContent))continue;
    button(actions,original.textContent,()=>original.click());
  }
  document.getElementById('tab-settings').prepend(group);
  function exportSheet({subtitle,video}){
    const body=panel('导出');button(body,'导出字幕',async()=>{close();await subtitle();});button(body,'导出视频',async()=>{close();await video();});
  }
  // Dashboard shortcuts lead to the library; only a draft Open action enters the editor.
  document.getElementById('dashboard-view').addEventListener('click',event=>{
    if(event.target.closest('[data-widget=resume],#sf-mu-resume,[data-mu-attn=resume]')){event.preventDefault();event.stopImmediatePropagation();go('#/home').catch(e=>status(e.message));}
  },true);
  phone.addEventListener('change',sync);window.addEventListener('hashchange',()=>{close();sync();});sync();
  return {close,hasSheet:()=>!!sheet,exportSheet};
}
