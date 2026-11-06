import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AssDoc, assPlainText } from '../editor/js/ass.js';
import { analyzeKaraoke, pairRows, buildWordSpecs, continuousWordTimes } from '../editor/js/karaoke.js';
import { Timeline } from '../editor/js/timeline.js';

const head = '[Script Info]\n; SubFabricWordStyle: English\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize\nStyle: English,Arial,40\nStyle: Chinese,Arial,40\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n';
function sentence(start, kind) {
  return { start, end:start+4, text:'A B C', style:'English', karStyle:kind, kTag:'\\kf',
    kBaseHex:'#ffffff', kHead:'\\an8', highlightTag:'{\\c&H00FF00&}',
    proto:{layer:'0',name:'Alice',effect:'fx',margins:{marginl:'1',marginr:'2',marginv:'3'}},
    words:[{w:'A',s:start+.2,e:start+1,pStart:0,pEnd:1},{w:'B',s:start+1.5,e:start+2,pStart:2,pEnd:3},{w:'C',s:start+2.5,e:start+3.5,pStart:4,pEnd:5}] };
}
for(const kind of ['color','k']) {
  const s=sentence(1,kind), original=structuredClone(s);
  const words=continuousWordTimes(s);
  assert.deepEqual(s,original,'planning never mutates source');
  assert.deepEqual(words.map(w=>[w.s,w.e]),[[1.2,2.5],[2.5,3.5],[3.5,4.5]]);
  assert.equal(words[0].pStart,0);assert.equal(words[2].e,s.words[2].e,'tail stays silent');
  assert.equal(continuousWordTimes({...s,words}),null,'idempotent');
  assert.equal(continuousWordTimes({...s,words:[{w:'A',s:1,e:3},{w:'B',s:2,e:4}]}),null,'overlap is not silently shortened');
  assert.equal(continuousWordTimes({...s,words:[]}),null);

  const doc=new AssDoc(head);
  for(const start of [1,6]) {
    doc.appendEvent({style:'Chinese',start,end:start+4,text:'测试句',name:'Alice'});
    for(const spec of buildWordSpecs(sentence(start,kind)))doc.appendEvent(spec);
  }
  const kar=analyzeKaraoke(doc);kar.rows=pairRows(kar.sentences,kar.wordStyle);
  const state={format:'ass',assDoc:doc,kar,project:{id:'p'}};
  let updates=0,saves=0,rebuilds=0,resumes=0;
  const ctx=vm.createContext({state,continuousWordTimes,buildWordSpecs,
    panel:{stashInlineEdit:()=>({draft:'kept'}),resumeInlineEdit:s=>{assert.equal(s.draft,'kept');resumes++;}},
    clearEditPreview(){},clearWordPreview(){},pendingPlaybackRows:new Set(),assPlayer:{updateNow(){updates++;}},
    rebuildItemsAndLanes(){rebuilds++;},Projects:{scheduleSave(){saves++;}},logOp(){},toast(){}});
  const main=fs.readFileSync(new URL('../editor/js/main.js',import.meta.url),'utf8');
  const body=main.match(/^function convertWordContinuity\([^\n]*\n[\s\S]*?^}/m)?.[0];assert.ok(body);
  const spanInfo=main.match(/^function enSpanInfo\([^\n]*\n[\s\S]*?^}/m)?.[0];assert.ok(spanInfo);
  vm.runInContext('const SPAN_TOL=.005;\n'+spanInfo+'\nglobalThis.spanInfo=enSpanInfo;',ctx);
  assert.equal(ctx.spanInfo(kar.rows[0]).mismatch,false,'explicit lead/tail silence must survive load-time repair');
  const missingCoverage={...kar.rows[0],en:{...kar.rows[0].en,events:[{start:1.2,end:4.5}]}};
  assert.equal(ctx.spanInfo(missingCoverage).mismatch,true,'genuine missing English coverage still needs alignment');
  vm.runInContext(body+'\nglobalThis.convert=convertWordContinuity;',ctx);
  const row=kar.rows.find(r=>r.start===1), untouched=kar.rows.find(r=>r.start===6).en;
  const untouchedLines=untouched.events.map(e=>doc.lines[e.lineIdx]);
  ctx.convert(row);
  assert.deepEqual(untouched.events.map(e=>doc.lines[e.lineIdx]),untouchedLines,'row action preserves other rows');
  assert.deepEqual([updates,saves,rebuilds,resumes],[1,1,1,1]);
  ctx.convert();assert.deepEqual([updates,saves,rebuilds,resumes],[2,2,2,2],'whole document gets one final preview/save');
  const before=doc.serialize();ctx.convert();assert.equal(doc.serialize(),before);assert.equal(updates,2,'no-op does not refresh');
  const loaded=analyzeKaraoke(new AssDoc(doc.serialize()));
  for(const s2 of loaded.sentences.filter(s=>s.words.length)) {
    assert.equal(s2.text,'A B C');assert.equal(s2.words.length,3);
    assert.deepEqual(s2.words.slice(0,-1).map((w,i)=>w.e===s2.words[i+1].s),[true,true]);
    assert.equal(s2.words[0].s,s2.start+.2);assert.equal(s2.words.at(-1).e,s2.end-.5);
    assert.ok(s2.events.every(e=>e.name==='Alice'&&assPlainText(e.text)==='A B C'));
    if(kind==='k'){assert.equal(s2.kTag,'\\kf');assert.ok(s2.kHead.includes('\\an8'));}
  }
}

// Execute the actual production retime handler: independent markers preserve neighbors and row bounds.
{
  const main=fs.readFileSync(new URL('../editor/js/main.js',import.meta.url),'utf8');
  const code=main.match(/^timeline\.onWordRetime = \([^\n]*\n[\s\S]*?^};/m)?.[0];assert.ok(code);
  const timeline={},en=sentence(1,'color'),row={start:1,end:5,en,zh:{start:1,end:5,events:[]}};
  const ctx=vm.createContext({timeline,WORD_MIN_GAP:.02,video:{duration:20},state:{},wordPreviewFrame:0,editRowVisible:()=>false});
  vm.runInContext(code,ctx);
  timeline.onWordRetime(row,0,2.4,false,'word-end');assert.equal(en.words[0].e,2.4);assert.equal(en.words[1].s,2.5);
  timeline.onWordRetime(row,0,9,false,'word-end');assert.equal(en.words[0].e,2.5,'end stops at next start');
  timeline.onWordRetime(row,0,0,false,'word-end');assert.equal(en.words[0].e,1.22,'end keeps positive width');
  timeline.onWordRetime(row,1,3,false,'word-start');assert.equal(en.words[1].s,2.98);assert.equal(en.words[0].e,1.22,'start preserves previous end');
  timeline.onWordRetime(row,2,4.8,false,'word-end');assert.equal(en.words[2].e,4.8);
  assert.deepEqual([row.start,row.end,en.start,en.end,row.zh.start,row.zh.end],[1,5,1,5,1,5]);
}

// Coincident start/end markers occupy separate vertical bands; the last marker is visible inside the clip.
{
  const t=Object.create(Timeline.prototype),g={markTop:70,markH:16,markW:8,top:70,bottom:90};
  const c={start:1,end:5,words:[{w:'A',s:1,e:2},{w:'B',s:2,e:3},{w:'C',s:3.5,e:5}]};
  Object.assign(t,{viewStart:0,pxPerSec:100,_cssW:()=>800,lanes:[{cues:[c]}],_laneTop:()=>0,_laneH:()=>100,_wordGeom:()=>g});
  const h=t._wordHandles(c,g,100,500),a=h.find(x=>x.idx===0&&x.edge==='word-end'),b=h.find(x=>x.idx===1&&x.edge==='word-start');
  assert.equal(a.x,b.x);assert.ok(a.y>b.y+b.h);
  for(const marker of h){const hit=t._hitWordHandle(marker.x+marker.w/2,marker.y+marker.h/2);assert.equal(hit.idx,marker.idx);assert.equal(hit.edge,marker.edge);}
  assert.equal(h.filter(x=>x.edge==='word-end').length,2);
  assert.equal(h.some(x=>x.idx===2&&x.edge==='word-end'),false,'last word has no duplicate end marker');
  assert.equal(t._hitWordHandle(490,82),null,'hidden last-end marker cannot intercept the block boundary');
}
// A non-final endpoint near the block edge stays inset; grab offset prevents jumps and taps do not edit.
{
  const handlers=new Map(),calls=[],c={start:1,end:5,ref:{},words:[{s:1,e:2},{s:2,e:4.99},{s:4.99,e:5}]};
  const t=Object.create(Timeline.prototype),priorDocument=globalThis.document;
  globalThis.document={getElementById:()=>null,addEventListener(){}};
  try {
    Object.assign(t,{canvas:{setPointerCapture(){},addEventListener:(type,fn)=>handlers.set(type,fn)},
      pxPerSec:100,viewStart:0,_drag:null,_pointerId:null,_pointerType:null,
      _hideMenu(){},_hideEdgeHint(){},clearRangeSel(){},_laneIndexAtY:()=>0,_hitTest:()=>({cue:c}),
      _hitWordHandle:()=>({cue:c,idx:1,edge:'word-end'}),_clampT:x=>x,onWordRetime:(...args)=>calls.push(args)});
    t._bindEvents();
    const fire=(type,x)=>handlers.get(type)({button:0,pointerType:'mouse',pointerId:1,offsetX:x,offsetY:80});
    fire('pointerdown',490);fire('pointerup',490);assert.equal(calls.length,0,'clicking a handle never retimes');
    fire('pointerdown',490);fire('pointermove',470);fire('pointerup',470);
    assert.ok(calls.every(args=>Math.abs(args[2]-4.79)<1e-9),'retime follows displacement from grab point');
    assert.deepEqual(calls.map(args=>args[3]),[false,true]);assert.equal(c.end,5,'word end never moves block end');
  } finally { globalThis.document=priorDocument; }
}
console.log('word-continuity: scoped conversion, color/kf reload, independent edges, coincident/inset handles and click stability passed');
