import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { mockLlm, until } from './helpers/mock-llm.mjs';

let release, blocked = false;
const llm = await mockLlm(async () => {
  if (blocked) await new Promise(r => { release = r; });
  return ['新译文'];
});
const s = await isolatedServer();
try {
  s.settings({ translate: { provider: 'custom', baseUrl: llm.url, apiKeyEnc: 'isolated-test', model: 'fake', batchSize: 5 } });
  const dir = path.join(s.root, 'projects/p-trans'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-trans', name: 'test', subtitle: { file: 'subtitle.ass' }, draft: { wordLevel: true } }));
  fs.writeFileSync(path.join(dir, 'asr.json'), JSON.stringify({ segments: [{ start: 0, end: 2, text: 'obsolete words' }] }));
  const original = '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize\nStyle: MyEditedStyle,Arial,42\nStyle: 中文字幕,Arial,31\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n'
    + 'Dialogue: 3,0:00:05.00,0:00:07.00,MyEditedStyle,Alice,10,20,30,custom,{\\blur2}{\\k100}hello {\\k100}corrected world\n'
    + 'Dialogue: 1,0:00:05.00,0:00:07.00,中文字幕,Alice,4,5,6,fx,{\\c&HFFFFFF&}[Alice] 旧译文\n';
  const file = path.join(dir, 'subtitle.ass'); fs.writeFileSync(file, original);
  const start = async () => {
    const r = await s.call('/api/projects/p-trans/translate', { method: 'POST', body: '{"redo":true}' }); assert.equal(r.status, 200);
  };
  const done = () => until(async () => {
    const d = await (await s.call('/api/projects/p-trans/draft')).json();
    return d.draft && d.draft.status !== 'running' ? d.draft : null;
  });
  await start(); assert.equal((await done()).status, 'done');
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.split('\n').find(l => l.startsWith('Dialogue: 3,')), original.split('\n').find(l => l.startsWith('Dialogue: 3,')));
  assert.ok(after.includes('Style: MyEditedStyle,Arial,42'));
  assert.ok(after.includes('中文字幕,Alice,4,5,6,fx,{\\c&HFFFFFF&}[Alice] 新译文'));
  assert.ok(llm.requests[0].messages.at(-1).content.includes('hello corrected world'));
  assert.ok(!llm.requests[0].messages.at(-1).content.includes('obsolete words'));
  blocked = true; await start(); await until(() => release);
  const r = await s.call('/api/projects/p-trans/subtitle');
  const edited = after.replace('corrected world', 'brave new world');
  const save = await s.call('/api/projects/p-trans/subtitle?revision=' + r.headers.get('etag').replaceAll('"', ''), { method: 'PUT', body: edited });
  assert.equal(save.status, 200); release();
  assert.match((await done()).error, /冲突/);
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  blocked = false; await start(); await done();
  assert.ok(llm.requests.at(-1).messages.at(-1).content.includes('hello brave new world'));
  // SRT 原始时间/标签/副语言保留。
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-trans', subtitle: { file: 'subtitle.srt' } }));
  const srt = '7\r\n00:00:09,123 --> 00:00:11,456\r\n旧译文\r\n<i>human correction</i>\r\n\r\n';
  fs.writeFileSync(path.join(dir, 'subtitle.srt'), srt);
  await start(); await done();
  assert.equal(fs.readFileSync(path.join(dir, 'subtitle.srt'), 'utf8'), srt.replace('旧译文', '新译文'));
  console.log('repair03: current ASS/SRT source, timing/role/style/effects, concurrent edit conflict and changed-content cache passed');
} finally { if (release) release(); await s.close(); await llm.close(); }
