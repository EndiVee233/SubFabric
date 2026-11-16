import {AssDoc} from '../editor/js/ass.js';
import {parseSRT} from '../editor/js/srt.js';
import {escapeAssUser} from '../editor/js/segment.js';
import {emptyAss} from './asr-doc.mjs';
export const alignmentRows=text=>parseSRT(text).map((s,index)=>({...s,index,text:s.lines.filter(x=>/[A-Za-z]/.test(x)).join(' ')||s.lines.join(' ')}));
export function alignedSrtDocument(text,items,keys){
 const selected=new Set(keys),picked=new Map(items.filter(i=>i.ok&&selected.has(i.targetKey)).map(i=>[i.index,i]));if(!picked.size)throw Error('请先选择已对齐字幕');
 const doc=new AssDoc(emptyAss);doc.setScriptInfoComment('SubFabricWordStyle','Default');doc.setScriptInfoComment('SubFabricWordHighlightColor','#00FF00');
 for(const row of alignmentRows(text)){
  const item=picked.get(row.index),english=row.lines.filter(line=>/[A-Za-z]/.test(line));
  if(item){const raw=english.join('\n'),proto=doc.appendEvent({start:row.start,end:row.end,style:'Default',text:escapeAssUser(raw)}),specs=[];let pos=0,cursor=row.start;
   for(const word of item.words){const at=raw.indexOf(word.w,pos);if(at<0||word.s<cursor-.01||word.e<=word.s||word.e>row.end+.01)throw Error('对齐词序与原文不一致，原字幕保留');
    if(word.s>cursor+.004)specs.push({...proto,start:cursor,end:word.s,text:escapeAssUser(raw)});
    specs.push({...proto,start:word.s,end:word.e,text:escapeAssUser(raw.slice(0,at))+'{\\c&H00FF00&}'+escapeAssUser(word.w)+'{\\c}'+escapeAssUser(raw.slice(at+word.w.length))});pos=at+word.w.length;cursor=word.e;
   }
   if(cursor<row.end-.004)specs.push({...proto,start:cursor,end:row.end,text:escapeAssUser(raw)});doc.replaceEvents([proto],specs);
  }
  for(const line of row.lines){if(item&&english.includes(line))continue;doc.appendEvent({start:row.start,end:row.end,style:/[A-Za-z]/.test(line)?'Default':'中文字幕',text:escapeAssUser(line)});}
 }
 return {text:doc.serialize(),applied:picked.size};
}
