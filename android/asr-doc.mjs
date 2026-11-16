import {AssDoc} from '../editor/js/ass.js';
import {buildWordSpecs,splitEnglishWords} from '../editor/js/karaoke.js';
import {serializeSRT} from '../editor/js/srt.js';

export const emptyAss='[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,50,1\nStyle: 中文字幕,Noto Sans CJK SC,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,130,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
const safe=text=>String(text||'').replace(/[{}\\\r\n]/g,' ').replace(/\s+/g,' ').trim();
export function recognitionSegments(result){
 if(!Array.isArray(result?.cues)||!result.cues.length)throw Error('没有识别到英文语音，原字幕保留');
 return result.cues.map(c=>{
  const start=Number(c.start),end=Number(c.end),text=safe(c.text);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||!text)throw Error('识别结果时间或文字无效，原字幕保留');
  const words=(c.words||[]).map(w=>({word:safe(w.text??w.word),start:Number(w.start),end:Number(w.end)}));
  let last=start;
  for(const w of words){if(!w.word||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<start-.015||w.end>end+.015||w.end<=w.start||w.start<last-.015)throw Error('识别词时间无效，原字幕保留');last=w.end;}
  return {start,end,text,words};
 });
}
export function draftDocument(result,options={}){
 const segments=recognitionSegments(result);
 if(options.wordLevel===false)return {text:serializeSRT(segments.map((s,i)=>({id:i+1,start:s.start,end:s.end,lines:[s.text]}))),subtitleName:'subtitle.srt',segments};
 const doc=new AssDoc(emptyAss);doc.setScriptInfoComment('SubFabricWordStyle','Default');doc.setScriptInfoComment('SubFabricWordHighlightColor','#00FF00');
 const karStyle=options.karaokeStyle==='k'?'k':'color';
 if(karStyle==='k')doc.setScriptInfoComment('SubFabricKaraokeStyle','k');
 for(const s of segments){
  const proto=doc.appendEvent({start:s.start,end:s.end,style:'Default',text:s.text});
  // Keep real native timings; a tokenizer mismatch leaves a readable sentence instead of invented timing.
  if(s.words.length&&splitEnglishWords(s.text).length===s.words.length){
   const specs=buildWordSpecs({...s,style:'Default',proto,highlightTag:'{\\c&H00FF00&}',karStyle,kTag:options.karaokeSweep?'\\kf':'\\k',kBaseHex:options.karaokeBase||'#FFFFFF',words:s.words.map(w=>({w:w.word,s:w.start,e:w.end}))});
   doc.replaceEvents([proto],specs);
  }
 }
 return {text:doc.serialize(),subtitleName:'subtitle.ass',segments};
}
