import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AssDoc, assPlainText } from '../editor/js/ass.js';
import { analyzeKaraoke, realignTargetKey, applyRealignItems } from '../editor/js/karaoke.js';

const head = '[Script Info]\n; SubFabricWordStyle: Default\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize\nStyle: Default,Arial,40\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n';
const revision = doc => crypto.createHash('sha256').update(doc.serialize()).digest('hex');
for (const kind of ['k', 'color']) {
  const row = (start, end, text) => `Dialogue: 0,${start},${end},Default,Alice,0,0,0,fx,${text}\n`;
  const source = kind === 'k'
    ? row('0:00:01.00', '0:00:03.00', '{\\k100}hello {\\k100}world') + row('0:00:03.01', '0:00:05.00', '{\\k99}hello {\\k100}world')
    : row('0:00:01.00', '0:00:02.00', '{\\c&HFFFFFF&}hello{\\c} world') + row('0:00:02.00', '0:00:03.00', 'hello {\\c&HFFFFFF&}world{\\c}')
      + row('0:00:03.01', '0:00:04.00', '{\\c&HFFFFFF&}hello{\\c} world') + row('0:00:04.00', '0:00:05.00', 'hello {\\c&HFFFFFF&}world{\\c}');
  const anchors = 'Dialogue: 0,0:00:01.00,0:00:03.00,Chinese,,0,0,0,,第一句\nDialogue: 0,0:00:03.01,0:00:05.00,Chinese,,0,0,0,,第二句\n';
  const doc = new AssDoc(head + source + anchors), kar = analyzeKaraoke(doc);
  const wordSentences = kar.sentences.filter(s => s.words.length);
  const sent = wordSentences[0]; assert.ok(sent.words.length >= 2);
  const rev = revision(doc);
  const proposal = { projectId: 'p-A', sourceRevision: rev, targetKey: realignTargetKey(sent), text: sent.text,
    words: sent.words.map((w, i) => ({ w: w.w, s: i ? 2.2 : 1, e: i ? 3 : 2.2 })) };
  const second = wordSentences[1].events.map(e => doc.lines[e.lineIdx]);
  assert.equal(applyRealignItems(doc, kar, [proposal], { projectId: 'p-A', revision: rev }).changed, 1);
  assert.ok(doc.events.filter(e => e.start < 3 && e.style === 'Default').every(e => assPlainText(e.text) === 'hello world'));
  assert.deepEqual(analyzeKaraoke(doc).sentences.filter(s => s.words.length)[1].events.map(e => doc.lines[e.lineIdx]), second);
  const edited = new AssDoc(head + source.replaceAll('world', 'brave new world') + anchors);
  const before = edited.serialize();
  assert.equal(applyRealignItems(edited, analyzeKaraoke(edited), [proposal], { projectId: 'p-A', revision: revision(edited) }).changed, 0);
  assert.equal(edited.serialize(), before);
  const fresh = new AssDoc(head + source + anchors), freshKar = analyzeKaraoke(fresh);
  assert.equal(applyRealignItems(fresh, freshKar, [{ ...proposal, projectId: 'p-B' }], { projectId: 'p-A', revision: rev }).changed, 0);
  assert.equal(applyRealignItems(fresh, freshKar, [{ ...proposal, words: proposal.words.slice(0, 1) }], { projectId: 'p-A', revision: rev }).changed, 0);
}
console.log('repair04: k/color text preservation, stale text/revision, project, repeated dialogue and word-count conflicts passed');
