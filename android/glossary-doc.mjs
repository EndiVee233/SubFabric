import {AssDoc,assPlainText} from '../editor/js/ass.js';
import {analyzeKaraoke} from '../editor/js/karaoke.js';

const strip=s=>String(s||'').replace(/^\s*(?:\{[^}]*\}\s*)*\[[^\]]+\]\s*/,'');
const chinese=s=>/[\u3400-\u9fff]/.test(s);
export function cleanTerms(terms){
  if(!Array.isArray(terms)||terms.length>400)throw new Error('术语数量无效，最多 400 条');
  const out=[],seen=new Set();
  for(const term of terms){
    const src=String(term?.src||'').trim(),dst=String(term?.dst||'').trim();
    if(!src||!dst||src.length>300||dst.length>300||/[\r\n\\{}]/.test(src+dst))throw new Error('术语必须是单行纯文本，且不含 ASS 控制符');
    if(seen.has(src))continue;seen.add(src);out.push({src,dst});
  }
  if(!out.length)throw new Error('没有可应用的术语');return out;
}
function compileTerms(terms){
  return terms.filter(({src,dst})=>src!==dst).map(({src,dst})=>{
    const escaped=src.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),latin=/[A-Za-z]/.test(src);
    const pattern=new RegExp((latin?'(?<![A-Za-z0-9])':'')+escaped+(latin?'(?![A-Za-z0-9])':''),'g');
    return {dst,pattern};
  });
}
function replaceText(value,terms){
  let text=value,n=0;
  for(const {dst,pattern}of terms){
    text=text.replace(pattern,()=>{n++;return dst;});
  }
  return {text,n};
}
function visibleReplace(raw,terms){
  const prefix=/^\s*(?:\{[^}]*\}\s*)*(?:\[[^\]]+\]\s*)?/.exec(raw)[0];
  let n=0,leading=true,drawing=false;
  const mode=tags=>{for(const match of tags.matchAll(/\\p(\d+)\b/g))drawing=Number(match[1])!==0;};mode(prefix);
  const body=raw.slice(prefix.length).split(/(\{[^}]*\}|<[^>\r\n]*>|\\[Nnh])/g).map(part=>{
    if(part.startsWith('{')){mode(part);return part;}
    if(!part||drawing||part.startsWith('<')||/^\\[Nnh]$/.test(part))return part;
    const role=leading?(/^(\s*\[[^\]]+\]\s*)/.exec(part)?.[0]||''):'';leading=false;
    const result=replaceText(part.slice(role.length),terms);n+=result.n;return role+result.text;
  }).join('');
  return {text:prefix+body,n};
}
/** Only target visible Chinese text. Preserve tags at their original positions and all unrelated raw lines. */
export function glossaryDocument(text,name='subtitle.ass'){
  const eol=text.includes('\r\n')?'\r\n':'\n',raw=text.split(/\r?\n/),targets=[],lines=[];
  if(!/\.srt$/i.test(name)){
    const doc=new AssDoc(text),isZh=ev=>/中文|翻译|translation|^zh|chinese|chs|cht|简体|繁體|繁体/i.test(ev.style)||chinese(strip(assPlainText(ev.text)));
    for(const ev of doc.events)if(!ev.comment&&isZh(ev))targets.push({line:ev.lineIdx,value:ev.text,parts:ev._rawParts,textIndex:doc.format.indexOf('text')});
    const sentences=analyzeKaraoke(doc).sentences;
    const zh=sentences.filter(s=>isZh(s));
    for(const sentence of (zh.length?zh:sentences)){const value=strip(assPlainText(sentence.text)).trim();if(value)lines.push(value);}
  }else{
    for(let i=0;i<raw.length;i++){
      if(!/^\s*\d+:\d+:\d+[,.]\d+\s*-->/.test(raw[i]))continue;
      let end=i+1;while(end<raw.length&&raw[end].trim())end++;
      const body=raw.slice(i+1,end),zh=body.filter(line=>chinese(strip(line)));
      lines.push(...(zh.length?zh:body).map(strip).filter(s=>s.trim()));
      for(let k=i+1;k<end;k++)if(chinese(strip(raw[k])))targets.push({line:k,value:raw[k]});i=end;
    }
  }
  return {lines,apply(input){
    const terms=compileTerms(cleanTerms(input)),next=raw.slice();let replaced=0,rows=0;
    for(const target of targets){const result=visibleReplace(target.value,terms);if(!result.n)continue;
      if(target.parts){const parts=target.parts.slice();parts[target.textIndex]=result.text;next[target.line]='Dialogue: '+parts.join(',');}
      else next[target.line]=result.text;
      replaced+=result.n;rows++;
    }
    return {text:next.join(eol),replaced,rows};
  }};
}
