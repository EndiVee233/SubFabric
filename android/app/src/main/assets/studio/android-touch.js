import {twoFingerMode,pinchView} from './android-gesture.js';
/** Translate Android touch gestures into the existing editor's pointer operations. */
export function initTouch({timeline,panel}){
  const canvas=timeline.canvas,replayed=new WeakSet(),points=new Map();
  let gesture=null,listPress=null,suppressUntil=0,suppressTarget=null,swallowClick=false,twoFrame=0;
  const position=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*timeline._cssW()/r.width,y:(e.clientY-r.top)*timeline._cssH()/r.height,clientX:e.clientX,clientY:e.clientY};};
  function feedback(cue){
    timeline.androidPressedCue=cue;timeline._enterBaseKey='';timeline._enterSpriteKey='';timeline.touch();
  }
  function send(type,p,kind='touch',ctrl=false){
    const event=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:gesture.id,pointerType:kind,isPrimary:true,button:0,buttons:type==='pointerup'||type==='pointercancel'?0:1,clientX:p.clientX,clientY:p.clientY,ctrlKey:ctrl});
    Object.defineProperties(event,{offsetX:{value:p.x},offsetY:{value:p.y}});replayed.add(event);canvas.dispatchEvent(event);
  }
  function context(target,p){
    suppressUntil=performance.now()+900;suppressTarget=target;swallowClick=true;
    const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:p.clientX,clientY:p.clientY});replayed.add(event);target.dispatchEvent(event);
  }
  function clearList(){if(listPress){clearTimeout(listPress.timer);listPress.target.classList.remove('android-touch-pressed');listPress=null;}}
  function cancel(){
    cancelAnimationFrame(twoFrame);twoFrame=0;
    clearList();swallowClick=false;if(!gesture){points.clear();return;}
    clearTimeout(gesture.timer);if(gesture.started&&gesture.kind!=='pinch')send('pointercancel',gesture.last,gesture.pointerType,gesture.kind==='range');
    if(gesture.kind==='range')timeline.clearRangeSel();gesture=null;feedback(null);
    const ids=[...points.keys()];points.clear();for(const id of ids)try{canvas.releasePointerCapture(id);}catch{}
  }
  function center(){const a=[...points.values()];return {x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2,clientX:(a[0].clientX+a[1].clientX)/2,clientY:(a[0].clientY+a[1].clientY)/2};}
  function distance(){const a=[...points.values()];return a.length<2?0:Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y);}
  function rangePoint(p){
    const y=Math.max(timeline._lanesTop()+2,Math.min(timeline._lanesBottom()-2,p.y)),r=canvas.getBoundingClientRect();
    return {...p,y,clientY:r.top+y*r.height/timeline._cssH()};
  }
  function down(event){
    if(replayed.has(event)||event.pointerType!=='touch')return;
    event.preventDefault();event.stopImmediatePropagation();clearList();points.set(event.pointerId,position(event));
    try{canvas.setPointerCapture(event.pointerId);}catch{}
    timeline._hideMenu();panel._hideCardMenu();
    if(points.size===1){
      const p=position(event),onLane=timeline._laneIndexAtY(p.y)!==-1,hit=onLane?timeline._hitTest(p.x,p.y,true):null;
      gesture={id:event.pointerId,start:p,last:p,kind:hit?'cue':onLane?'create':'pan',pointerType:hit||!onLane?'touch':'mouse',started:false,held:false};feedback(hit?.cue||null);
      if(hit)gesture.timer=setTimeout(()=>{if(!gesture||gesture.started||points.size!==1)return;gesture.held=true;feedback(null);context(canvas,p);},500);
    }else if(points.size===2&&gesture&&!gesture.ignore){
      clearTimeout(gesture.timer);feedback(null);
      if(gesture.started)send('pointercancel',gesture.last,gesture.pointerType);
      const p=center();
      if(timeline._zoomAnim){cancelAnimationFrame(timeline._zoomAnim);timeline._zoomAnim=0;}
      gesture={id:gesture.id,start:p,last:p,kind:'two',pointerType:'mouse',started:false,distance:distance(),scale:timeline.pxPerSec,anchor:timeline.x2t(p.x)};
    }else if(points.size>2){cancel();gesture={ignore:true};}
  }
  function moveTwo(){
    twoFrame=0;
    if(gesture&&['two','pinch','range'].includes(gesture.kind)&&points.size===2){
      const c=center(),d=distance(),g=gesture;
      if(g.kind==='two'){
        const mode=twoFingerMode(g.distance,d,Math.hypot(c.x-g.start.x,c.y-g.start.y));
        if(!mode)return;g.kind=mode;g.started=true;
        if(mode==='range')send('pointerdown',rangePoint(g.start),'mouse',true);
      }
      if(g.kind==='pinch'){
        const view=pinchView(g.scale,g.distance,d,g.anchor,c.x,timeline._zoomLimits());
        timeline.pxPerSec=view.scale;timeline.viewStart=view.start;timeline._clampView();timeline._viewReady=true;
        timeline._followHoldUntil=performance.now()+2000;timeline.onLayout?.();timeline.touch();g.last=c;return;
      }
      const p=rangePoint(c);g.last=p;send('pointermove',p,'mouse',true);
    }
  }
  function move(event){
    if(replayed.has(event)||event.pointerType!=='touch'||!points.has(event.pointerId))return;
    event.preventDefault();event.stopImmediatePropagation();points.set(event.pointerId,position(event));if(!gesture||gesture.ignore||gesture.held)return;
    if(['two','pinch','range'].includes(gesture.kind)&&points.size===2){if(!twoFrame)twoFrame=requestAnimationFrame(moveTwo);return;}
    const p=gesture.kind==='range'?rangePoint(center()):points.get(gesture.id);if(!p)return;
    if(!gesture.started){if(Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)<8)return;clearTimeout(gesture.timer);feedback(null);send('pointerdown',gesture.start,gesture.pointerType);gesture.started=true;}
    gesture.last=p;send('pointermove',p,gesture.pointerType,gesture.kind==='range');
  }
  function up(event){
    if(replayed.has(event)||event.pointerType!=='touch')return;
    event.preventDefault();event.stopImmediatePropagation();if(!points.has(event.pointerId)){if(!points.size)gesture=null;return;}
    if(twoFrame){cancelAnimationFrame(twoFrame);twoFrame=0;moveTwo();}
    const g=gesture;if(g&&!g.ignore){
      clearTimeout(g.timer);feedback(null);const p=g.kind==='range'?rangePoint(center()):position(event);
      if(g.held){suppressUntil=performance.now()+900;suppressTarget=canvas;swallowClick=true;}
      if(!g.held&&!['two','pinch'].includes(g.kind)){if(!g.started)send('pointerdown',g.start,'touch');send('pointerup',p,g.started?g.pointerType:'touch',g.kind==='range');}
      gesture={ignore:true};
    }
    points.delete(event.pointerId);if(!points.size)gesture=null;
  }
  for(const [type,fn]of [['pointerdown',down],['pointermove',move],['pointerup',up]])canvas.addEventListener(type,fn,{capture:true,passive:false});
  for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    if(!replayed.has(event)&&event.pointerType==='touch'&&points.has(event.pointerId)){event.stopImmediatePropagation();cancel();}
  },true);
  // Lists keep native vertical scrolling; a hold never falls through into text editing.
  document.addEventListener('pointerdown',event=>{
    if(!replayed.has(event))swallowClick=false;
    if(replayed.has(event)||event.pointerType!=='touch'||event.target===canvas)return;
    clearList();if(event.isPrimary===false||event.target.closest('input,textarea,[contenteditable=true]'))return;
    const target=event.target.closest('.cue-card,.role-card');if(!target)return;
    const p={clientX:event.clientX,clientY:event.clientY};target.classList.add('android-touch-pressed');
    listPress={target,p,id:event.pointerId,timer:setTimeout(()=>{if(!listPress)return;listPress.held=true;context(target,p);},500)};
  },true);
  document.addEventListener('pointermove',event=>{if(listPress&&event.pointerId===listPress.id&&Math.hypot(event.clientX-listPress.p.clientX,event.clientY-listPress.p.clientY)>8)clearList();},true);
  for(const type of ['pointerup','pointercancel'])document.addEventListener(type,event=>{if(listPress?.id===event.pointerId){if(listPress.held){suppressUntil=performance.now()+900;suppressTarget=listPress.target;swallowClick=true;}clearList();}},true);
  document.addEventListener('scroll',clearList,true);
  for(const type of ['click','contextmenu'])document.addEventListener(type,event=>{
    if(!replayed.has(event)&&performance.now()<suppressUntil&&(type==='click'?swallowClick:suppressTarget?.contains(event.target))){event.preventDefault();event.stopImmediatePropagation();if(type==='click')swallowClick=false;}
  },true);
  window.addEventListener('blur',cancel);window.addEventListener('hashchange',cancel);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel();});
  return {cancel};
}
