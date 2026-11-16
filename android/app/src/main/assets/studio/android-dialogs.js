/** Cancel the foremost shared dialog through its existing close handler. Never apply changes. */
export function closeTopDialog(){
  const font=document.querySelector('.fp-panel:not([hidden]) .fp-filter');
  if(font?.getClientRects().length){font.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:false,cancelable:true}));return true;}
  const controls=[
    ['#confirm-overlay','#confirm-no'],['#role-new','#role-new-cancel'],['#pick-overlay','#pick-cancel'],
    ['#fix-overlay','#fix-cancel'],['#cue-text-overlay','#ctd-cancel'],['#fr-overlay','#fr-close'],
    ['#adv-export-overlay','#adv-export-cancel'],['#batch-draft-overlay','#bd-close'],
    ['#batch-item-overlay','#batch-item-cancel'],['#reflect-overlay','#reflect-cancel'],
    ['#rim-overlay','#rim-cancel'],['#realign-overlay','#realign-cancel'],
    ['#op-range-overlay','#op-range-cancel'],['#sf-asr-params','#sf-ap-cancel'],
    ['.sscp','.sscp-x'],['#st-drawer','#st-drawer-cancel'],
  ];
  const shown=controls.map(([surface,button],order)=>{const node=document.querySelector(surface),cancel=node?.querySelector(button);if(!node||!cancel||node.hidden||cancel.disabled||!node.getClientRects().length||getComputedStyle(node).display==='none')return null;return {node,cancel,order,z:Number.parseInt(getComputedStyle(node).zIndex,10)||0};}).filter(Boolean);
  shown.sort((a,b)=>b.z-a.z||b.order-a.order);
  if(shown.length){shown[0].cancel.click();return true;}
  const split=document.querySelector('.android-split-dialog[open]');
  if(split){split.querySelector('button:last-child')?.click();return true;}
  for(const [id,owner,method]of [['role-rename','panel','_hideRenameBox'],['card-menu','panel','_hideCardMenu'],['role-menu','panel','_hideRoleMenu'],['tl-menu','timeline','_hideMenu']]){
    const menu=document.getElementById(id),controller=window.__dbg?.[owner];
    if(menu&&!menu.hidden&&menu.getClientRects().length&&controller?.[method]){controller[method]();return true;}
  }
  return false;
}
