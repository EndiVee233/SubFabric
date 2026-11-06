// Exercise production wheel/pointer handlers without a GUI or user project.
import assert from 'node:assert/strict';
import { Timeline } from '../editor/js/timeline.js';

function setup() {
  const handlers = new Map(), retimes = [], seeks = [], creates = [], words = [], zooms = [];
  const cue = { start: 15, end: 25, ref: { id: 'A' } };
  const timeline = Object.create(Timeline.prototype);
  const canvas = { style: {}, setPointerCapture() {},
    addEventListener(type, fn) { handlers.set(type, fn); } };
  Object.assign(timeline, { canvas, viewStart: 10, pxPerSec: 10, duration: 1000, panSensitivity: 120,
    zoomSensitivity: 1.25, follow: true, lanes: [{ cues: [cue] }], _drag: null,
    _pointerId: null, _pointerType: null, _touchEditRef: null, _cssW: () => 1000,
    _contentRange: () => ({ a: 0, b: 1000, span: 1000 }), _tMax: () => 1000,
    _laneIndexAtY: y => y >= 30 ? 0 : -1, _laneTop: () => 30, _laneH: () => 140,
    _hitWordHandle: () => null,
    _hitTest(x) { const t = this.x2t(x); return t >= cue.start-.5 && t <= cue.end+.5 ? { cue } : null; },
    _neighbors: () => ({ prevEnd: 0, nextStart: 1000 }), _refreshRange: () => false,
    _hideMenu() {}, _hideEdgeHint() {}, clearRangeSel() {}, _notifyRange() {},
    _zoomAtSmooth: (x,f) => zooms.push([x,f]),
    onSelect(ref) { timeline.setSelected(ref); }, onSeek: t => seeks.push(t),
    onRetime: (...args) => retimes.push(args), onCreate: (...args) => creates.push(args),
    onWordRetime: (...args) => words.push(args), onBeforeWordDrag() {},
  });
  globalThis.document = { getElementById: () => null, addEventListener() {} };
  timeline._bindEvents();
  function event(type, x, y=60, props={}) {
    const e = { offsetX:x, offsetY:y, clientX:x, clientY:y, button:0, pointerType:'touch',
      pointerId:1, isPrimary:true, deltaX:0, deltaY:0, deltaMode:0, defaultPrevented:false,
      preventDefault() { this.defaultPrevented = true; }, ...props };
    handlers.get(type)?.(e); return e;
  }
  const center = () => timeline.t2x((cue.start+cue.end)/2);
  const tap = (x=center()) => { event('pointerdown',x); event('pointerup',x); };
  return { timeline,cue,retimes,seeks,creates,words,zooms,event,center,tap };
}
{
  const {timeline:t,event,zooms}=setup(); t.viewStart=100;
  event('wheel',100,60,{deltaX:40}); assert.equal(t.viewStart,104,'positive horizontal distance pans later');
  event('wheel',100,60,{deltaX:-40}); assert.equal(t.viewStart,100,'negative horizontal distance pans earlier');
  event('wheel',100,60,{deltaX:2}); assert.equal(t.viewStart,100.2,'small trackpad events stay proportional');
  t.viewStart=100; event('wheel',100,60,{deltaX:10,deltaY:-1}); assert.equal(t.viewStart,101,'horizontal axis wins over vertical noise');
  t.viewStart=100; event('wheel',100,60,{deltaX:2,deltaMode:1}); assert.equal(t.viewStart,103.2,'line delta units are normalized');
  t.viewStart=100; event('wheel',100,60,{deltaX:1,deltaMode:2}); assert.equal(t.viewStart,200,'page delta units are normalized');
  t.viewStart=100; event('wheel',100); assert.equal(t.viewStart,100,'zero delta never pans');
  event('wheel',100,60,{deltaY:120}); assert.equal(t.viewStart,88,'mouse wheel down retains earlier direction');
  event('wheel',100,60,{deltaY:-120}); assert.equal(t.viewStart,100,'mouse wheel up retains later direction');
  event('wheel',100,60,{deltaY:-120,ctrlKey:true}); assert.ok(zooms.at(-1)[1]>1,'Ctrl wheel up still zooms in');
  event('wheel',100,60,{deltaY:120,ctrlKey:true}); assert.ok(zooms.at(-1)[1]<1,'Ctrl wheel down still zooms out');
}
{
  const {timeline:t,cue,event,retimes,seeks,creates}=setup();
  const before=[cue.start,cue.end];
  event('pointerdown',100); assert.equal(t._drag.type,'pan','first contact on block prepares pan');
  event('pointermove',150); event('pointerup',150);
  assert.equal(t.viewStart,5,'dragging finger right moves content right / viewport earlier');
  assert.deepEqual([cue.start,cue.end],before,'first swipe cannot change subtitle timing');
  assert.equal(retimes.length,0); assert.equal(seeks.length,0); assert.equal(creates.length,0);
  assert.equal(t._touchEditRef,null,'a swipe does not arm editing');
  assert.equal(t.follow,false,'manual touch pan is not pulled back by playback follow');
}
{
  const {timeline:t,cue,event,retimes,tap,center}=setup();
  tap(); assert.equal(t._touchEditRef,cue.ref,'first tap arms only that block');
  const x=center(); event('pointerdown',x); assert.equal(t._drag.type,'cue');
  event('pointermove',x+30); event('pointerup',x+30);
  assert.deepEqual([cue.start,cue.end],[18,28],'next touch can move selected block');
  assert.equal(t.viewStart,10,'editing a block does not pan viewport');
  assert.equal(retimes.filter(a=>a[3]).length,1,'touch drag finalizes exactly once');
  t.setSelected({id:'B'}); assert.equal(t._touchEditRef,null,'changing selection disarms touch editing');
}
{
  const {timeline:t,event,retimes,creates,tap}=setup();
  tap(); event('pointerdown',400); event('pointermove',370); event('pointerup',370);
  assert.equal(creates.length,0,'touching empty track pans rather than creates subtitles');
  assert.equal(retimes.length,0); assert.equal(t._touchEditRef,null,'panning elsewhere disarms previous block');
  const view=t.viewStart;
  event('pointerdown',100); event('pointerdown',110,60,{pointerId:2,isPrimary:false});
  event('pointerup',110,60,{pointerId:2}); assert.ok(t._drag,'another finger cannot finish primary gesture');
  event('pointermove',130,60,{pointerId:2}); assert.equal(t.viewStart,view,'another finger cannot pan the primary gesture');
  event('pointercancel',100); assert.equal(t._drag,null); assert.equal(t._pointerId,null);
}
{
  const {timeline:t,cue,event,retimes,creates}=setup();
  event('pointerdown',100,60,{pointerType:'mouse'}); assert.equal(t._drag.type,'cue','mouse can drag immediately');
  event('pointermove',130,60,{pointerType:'mouse'}); event('pointerup',130,60,{pointerType:'mouse'});
  assert.deepEqual([cue.start,cue.end],[18,28]); assert.equal(retimes.filter(a=>a[3]).length,1);
  event('pointerdown',400,60,{pointerType:'mouse'}); event('pointermove',430,60,{pointerType:'mouse'}); event('pointerup',430,60,{pointerType:'mouse'});
  assert.equal(creates.length,1,'mouse blank-track drag still creates a subtitle');
}
{
  const {timeline:t,cue,event,words,tap,center}=setup();
  cue.words=[{s:15,e:20},{s:20,e:25}];
  t._hitWordHandle=()=>({cue,idx:1});
  event('pointerdown',100); event('pointermove',130); event('pointerup',130);
  assert.equal(words.length,0,'first touch over word handle never edits timing');
  tap(center()); event('pointerdown',center()); event('pointerup',center());
  assert.equal(words.length,0,'second tap without drag still does not change a word');
  const x=center(); event('pointerdown',x); event('pointermove',x+20); event('lostpointercapture',x+20);
  assert.equal(words.filter(a=>a[3]).length,1,'interrupted armed word drag finalizes once');
  assert.equal(t._drag,null); assert.equal(t._touchEditRef,null);
}
{
  const {timeline:t,cue,tap}=setup(); tap();
  t.setLanes([{cues:[{start:1,end:2,ref:{id:'new'}}]}]);
  assert.equal(t._touchEditRef,null,'new project/removed block cannot inherit an armed touch');
  assert.notEqual(t._touchEditRef,cue.ref);
}
console.log('timeline-input: signed/proportional wheel, touch pan/tap/edit, pointer ownership/cancel and unchanged mouse drag passed');
