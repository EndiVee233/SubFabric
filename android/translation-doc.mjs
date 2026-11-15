import {AssDoc,assPlainText} from '../editor/js/ass.js';
import {analyzeKaraoke,normalizeZhPunctuation,draftSpeakerText} from '../editor/js/karaoke.js';
import {fmtTimeAss} from '../editor/js/util.js';

/** Snapshot -> cumulative translations. Never rebuild source events / word timing from plain text. */
export function translationDocument(text,name){
  const eol=text.includes('\r\n')?'\r\n':'\n',raw=text.split(/\r?\n/),ass=!/\.srt$/i.test(name),rows=[];
  let doc;
  if(ass){
    doc=new AssDoc(text);
    const analysis=analyzeKaraoke(doc);
    const zh=sentence=>/中文|翻译|translation|^zh|chinese|chs|cht|简体|繁體|繁体/i.test(sentence.style)||/[\u3400-\u9fff]/.test(assPlainText(sentence.text).replace(/^\[[^\]]+\]\s*/,''));
    const targets=analysis.sentences.filter(zh),used=new Set();
    for(const sentence of analysis.sentences.filter(s=>!zh(s))){
      const source=assPlainText(sentence.text,true);if(!source.trim())continue;
      const matches=targets.filter(t=>!used.has(t)&&Math.abs(t.start-sentence.start)<.05&&Math.abs(t.end-sentence.end)<.05);
      for(const target of matches)used.add(target);
      rows.push({text:source,start:sentence.start,end:sentence.end,name:sentence.proto?.name||'',events:sentence.events,targets:matches.flatMap(s=>s.events),zh:matches[0]?assPlainText(matches[0].text).replace(/^\[[^\]]+\]\s*/,''):''});
    }
  }else{
    for(let i=0;i<raw.length;i++){
      if(!/^\d+:\d+:\d+[,.]\d+\s*-->/.test(raw[i]))continue;
      let end=i+1;while(end<raw.length&&raw[end].trim())end++;
      const content=raw.slice(i+1,end),hasZh=content.length>1&&/[\u3400-\u9fff]/.test(content[0]);
      rows.push({text:content.slice(hasZh?1:0).join('\n'),from:i+1,zh:hasZh?content[0]:'',hasZh});i=end;
    }
  }
  return {rows,patch(translations){
    const lines=raw.slice(),inserts=new Map();let needsStyle=false;
    for(let i=0;i<rows.length;i++){
      if(!translations[i]?.trim())continue;const row=rows[i],value=normalizeZhPunctuation(translations[i]);
      if(!ass){lines[row.from]=row.hasZh?value:value+eol+lines[row.from];continue;}
      // Literal model text cannot inject an ASS override or a new event line.
      const literal=value.replace(/\\/g,'＼').replace(/\{/g,'｛').replace(/\}/g,'｝').replace(/\r?\n/g,' ');
      if(row.targets.length){
        for(const ev of row.targets){
          const parts=ev._rawParts.slice(),prefix=/^(?:\{[^}]*\})*(?:\[[^\]]+\]\s*)?/.exec(ev.text)[0];
          const tags=ev.text.slice(prefix.length).match(/\{[^}]*\}/g)||[];
          parts[doc.format.indexOf('text')]=draftSpeakerText(prefix+literal+tags.join(''),ev.name||row.name);
          lines[ev.lineIdx]='Dialogue: '+parts.join(',');
        }
      }else{
        const first=row.events[0],parts=first._rawParts.slice();
        const set=(key,v)=>{const index=doc.format.indexOf(key);if(index>=0)parts[index]=v;};
        set('start',fmtTimeAss(row.start));set('end',fmtTimeAss(row.end));set('style','中文字幕');set('text',draftSpeakerText(literal,row.name));
        inserts.set(first.lineIdx,'Dialogue: '+parts.join(','));needsStyle=true;
      }
    }
    if(ass&&needsStyle&&![...doc.styles.keys()].some(key=>key.toLowerCase()==='中文字幕')){
      const style=doc.styles.values().next().value;if(!style)throw new Error('缺少 ASS 样式，无法添加译文轨');
      const values=style.values.slice();values[style.format.indexOf('name')]='中文字幕';
      inserts.set(style.lineIdx,'Style: '+values.join(','));
    }
    return lines.flatMap((line,i)=>inserts.has(i)?[line,inserts.get(i)]:[line]).join(eol);
  }};
}
