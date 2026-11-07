import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { serverFunctions } from './helpers/server-functions.mjs';
import { AssDoc, assPlainText } from '../editor/js/ass.js';
import * as karaoke from '../editor/js/karaoke.js';
import { makeSyntheticAss } from './ass-fixture.mjs';
const require=createRequire(import.meta.url),draft={speakers:true,cast:{map:{SPK2:'Alice'}}};
assert.deepEqual(karaoke.draftSpeakerIdentity('SPK1',draft),{name:'SPK1',color:karaoke.ROLE_PALETTE[0]});
assert.equal(karaoke.draftSpeakerIdentity('Alice',draft).color,karaoke.ROLE_PALETTE[1]);
for(const name of ['Metadata only','SPK0','SPK21','[SPK1]','SPK1\\Nbad'])assert.equal(karaoke.draftSpeakerIdentity(name,draft),null);
assert.equal(karaoke.draftSpeakerIdentity('SPK1',{speakers:false}),null);
assert.equal(karaoke.draftSpeakerText('{\\c&H123456&}[Custom] 正文','SPK1',draft),'{\\c&H123456&}[Custom] 正文');
assert.equal(karaoke.draftSpeakerText('{\\1c&H00FF00&}正文','SPK1',draft),'{\\1c&H00FF00&}[SPK1] 正文');
assert.equal(karaoke.draftSpeakerText('正文','SPK1',{}),'正文','foreign Name metadata stays non-visible');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sf-speaker-label-'));
try{
 const file=path.join(temp,'subtitle.ass'),doc=new AssDoc(makeSyntheticAss());doc.deleteEvents(doc.events.slice());
 for(const event of [
  {start:0,end:1,style:'Default',name:'SPK1',text:'{\\c&H00FF00&}Hello{\\c} world.'},
  {start:1,end:2,style:'Default',name:'SPK1',text:'Hello {\\c&H00FF00&}world.{\\c}'},
  {start:3,end:4,style:'Default',name:'Alice',text:'{\\k50}Okay {\\k50}now.'},
 ])doc.appendEvent(event);
 fs.writeFileSync(file,doc.serialize());
 const meta={subtitle:{file:'subtitle.ass'},draft};
 const funcs=serverFunctions(['subtitleSource','patchSubtitleTranslations','fmtAssTime'],{
  fs,path,AssDoc,crypto,karaokeMod:karaoke,readMeta:()=>meta,safeProjectFile:()=>file,
  assSentencesMod:require('../editor/ass-sentences.js'),llmText:require('../editor/llm-text.js'),
  escAss:require('../editor/k-line.js').escAss,
  subtitleRevision:bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),
 });
 const source=funcs.subtitleSource('p-test'),english=doc.events.map(e=>doc.lines[e.lineIdx]);
 assert.equal(source.rows.length,2);
 funcs.patchSubtitleTranslations('p-test',source,['你好 世界','好的 现在']);
 const translated=new AssDoc(fs.readFileSync(file,'utf8')),anchors=translated.events.filter(e=>e.style==='中文字幕');
 assert.equal(anchors.length,2);
 assert.ok(anchors[0].text.includes('[SPK1] 你好 世界'));
 assert.ok(anchors[1].text.includes('[Alice] 好的 现在'));
 for(const line of english)assert.ok(translated.lines.includes(line),'word events and k tags remain verbatim');
 // Simulate the older installed writer: identity is in Name but absent from the Chinese text.
 for(const e of anchors)translated.setEventText(e,assPlainText(e.text,true).replace(/^\[[^\]]+\]\s*/,''));
 const raw=translated.serialize(),kar=karaoke.analyzeKaraoke(translated);
 const words=kar.sentences.filter(s=>s.words.length).map(s=>s.words.map(w=>[w.w,w.s,w.e]));
 assert.equal(karaoke.restoreDraftSpeakerLabels(translated,kar.sentences,kar.wordStyle,{}),0);
 assert.equal(translated.serialize(),raw);
 assert.equal(karaoke.restoreDraftSpeakerLabels(translated,kar.sentences,kar.wordStyle,draft),2);
 const rows=karaoke.pairRows(kar.sentences,kar.wordStyle);
 assert.ok(rows.every(row=>!karaoke.isUnassignedRole(row)&&row.color));
 assert.deepEqual(kar.sentences.filter(s=>s.words.length).map(s=>s.words.map(w=>[w.w,w.s,w.e])),words);
 assert.equal(karaoke.restoreDraftSpeakerLabels(translated,kar.sentences,kar.wordStyle,draft),0,'repair is idempotent');
 for(const line of english)assert.ok(translated.lines.includes(line));
 const reloaded=karaoke.analyzeKaraoke(new AssDoc(translated.serialize()));
 assert.ok(karaoke.pairRows(reloaded.sentences,reloaded.wordStyle).every(row=>!karaoke.isUnassignedRole(row)&&row.color));
 // Retranslation preserves the explicit identity/color while changing only the translated text.
 fs.writeFileSync(file,translated.serialize());
 funcs.patchSubtitleTranslations('p-test',funcs.subtitleSource('p-test'),['新译文','第二句新译文']);
 const final=new AssDoc(fs.readFileSync(file,'utf8')).events.filter(e=>e.style==='中文字幕');
 assert.ok(final[0].text.includes('[SPK1] 新译文'));assert.ok(final[1].text.includes('[Alice] 第二句新译文'));
 console.log('Draft speaker labels: translation insertion, legacy restoration, palette, external metadata protection and word timings passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
