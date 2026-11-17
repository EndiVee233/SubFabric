/** Android list geometry; the shared editor still owns selection and playback. */
export function followInset(height,cardHeight){
  return Math.min(48,Math.max(8,height*.12),Math.max(0,height-cardHeight));
}
export function followScroll({scroll,cardTop,cardHeight,viewTop,viewHeight,maxScroll}){
  return Math.max(0,Math.min(maxScroll,scroll+cardTop-viewTop-followInset(viewHeight,cardHeight)));
}
export function initFollow(panel,video){
  const list=panel.listEl,spacer=panel.spacerEl;
  const phone=()=>document.body.classList.contains('android-phone');
  const tail=document.createElement('div');tail.id='android-follow-tail';tail.setAttribute('aria-hidden','true');list.append(tail);
  let frame=0,lastLayout='',aligning=false;
  function viewport(){
    const r=list.getBoundingClientRect(),visual=window.visualViewport;
    let top=Math.max(r.top,visual?.offsetTop||0),bottom=Math.min(r.bottom,(visual?.offsetTop||0)+(visual?.height||innerHeight));
    for(let el=list.parentElement;el;el=el.parentElement){
      if(getComputedStyle(el).overflowY!=='visible'){
        const clip=el.getBoundingClientRect();top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);
      }
    }
    return {top,height:Math.max(0,bottom-top),listTop:r.top};
  }
  function tailSize(view){
    if(!phone()){tail.style.height='0px';return;}
    const last=panel.filtered.length-1,h=last>=0?panel._cardH(last):view.height;
    const inset=followInset(view.height,h);
    // Extra scroll room keeps even the final caption in the upper visible area.
    const marginRoom=2*(panel._gap||0)+2;
    const height=Math.max(0,list.clientHeight-(view.top-view.listTop)-inset-h+marginRoom);
    const value=height+'px';if(tail.style.height!==value)tail.style.height=value;
  }
  function align(idx,force=false){
    if(!phone())return false;
    if(aligning||!panel.followPlayback||panel.editItem||panel._tab!=='subs'||!list.clientHeight)return true;
    if(!force&&panel._userScrollAt&&performance.now()-panel._userScrollAt<5000)return true;
    let view=viewport();if(!view.height||idx<0)return true;
    aligning=true;
    try{
      measureLayout();
      if(panel._metricsDirty)panel._render();
      const items=[],keys=[];
      for(let i=Math.max(0,idx-12);i<Math.min(panel.filtered.length,idx+13);i++){
        const item=panel.filtered[i],key=panel._hKey(item);if(!panel._h.has(key)){items.push(item);keys.push(key);}
      }
      if(items.length){panel._measure(items,keys);for(const key of keys)panel._measurePending?.delete(key);panel._metricsDirty=true;}
      const cached=panel._h.get(panel._hKey(panel.filtered[idx]));
      if(cached!=null&&Math.abs(cached-(idx===panel.filtered.length-1?(panel._gap||0):0)-panel._cardH(idx))>.5)panel._metricsDirty=true;
      if(panel._metricsDirty)panel._render();
      tailSize(view);
      let card=panel._cardElAt(idx);
      if(!card){
        panel._progScroll=true;
        list.scrollTop=Math.max(0,panel._cardTop(idx)-followInset(view.height,panel._cardH(idx)));
        panel._render();card=panel._cardElAt(idx);
      }
      if(card){
        view=viewport();const rect=card.getBoundingClientRect();
        const target=followScroll({scroll:list.scrollTop,cardTop:rect.top,cardHeight:rect.height,viewTop:view.top,viewHeight:view.height,maxScroll:Math.max(0,list.scrollHeight-list.clientHeight)});
        if(Math.abs(target-list.scrollTop)>1){panel._progScroll=true;list.scrollTop=target;panel._render();}
      }
    }finally{aligning=false;}
    return true;
  }
  function measureLayout(){
    const width=spacer.clientWidth||list.clientWidth;if(!width||!list.clientHeight)return false;
    const layout=width+':'+phone();
    if(layout!==lastLayout){
      lastLayout=layout;
      // A phone breakpoint changes padding/line wrapping as well as the width.
      clearTimeout(panel._measureTimer);panel._measureTimer=0;panel._measureQueue=null;panel._measurePending?.clear();
      panel._h.clear();panel._gap=null;panel._metricsDirty=true;
      const before=list.scrollTop;panel._render();if(list.scrollTop!==before)panel._progScroll=true;
    }
    return true;
  }
  function refresh(){
    frame=0;if(!measureLayout())return;
    const view=viewport();tailSize(view);
    align(panel.filtered.indexOf(panel.playingItem));
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(refresh);};
  window.__androidFollowPlaying=(owner,idx,force)=>owner===panel&&align(idx,force);
  new ResizeObserver(schedule).observe(list);
  list.addEventListener('sf-cue-rendered',schedule);
  window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);
  window.visualViewport?.addEventListener('scroll',schedule);
  const seek=time=>{if(phone()&&panel.followPlayback&&!panel.editItem)panel.setPlayingByTime(time,true);};
  window.__androidFollowSeek=seek;
  let nativeSeeking=false;
  video.addEventListener('seeking',()=>{nativeSeeking=true;});
  video.addEventListener('seeked',()=>{if(nativeSeeking&&!video.seeking){nativeSeeking=false;seek(video.currentTime);}});
  schedule();
}
