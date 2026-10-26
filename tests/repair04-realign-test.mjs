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

  /* 「仅逐词异常的字幕」修复模式：异常行本来就有缺词（逐词 1 个 / 文本 2 个），
   * 严格模式永远应用不了（这就是用户截图里「0 句」的原因）。修复模式允许把
   * 对齐结果的词序列落回 splitEnglishWords 的分词，并接受本次作业开始后别处的编辑。 */
  const badText = '{\\c&HFFFFFF&}hello{\\c} world';
  const badDoc = new AssDoc(head
    + `Dialogue: 0,0:00:01.00,0:00:03.00,Default,Alice,0,0,0,fx,${badText}\n`
    + 'Dialogue: 0,0:00:01.00,0:00:03.00,Chinese,,0,0,0,,第一句\n');
  const badSent = analyzeKaraoke(badDoc).sentences.find(s => s.words.length);
  assert.ok(badSent && badSent.words.length === 1, '构造出缺词行（逐词少于文本）');
  const repairProposal = {
    projectId: 'p-A', sourceRevision: 'stale-but-target-unchanged',
    targetKey: realignTargetKey(badSent), text: badSent.text,
    words: [{ w: 'hello', s: 1, e: 2 }, { w: 'world', s: 2, e: 3 }],
  };
  const strictBad = new AssDoc(badDoc.serialize());
  assert.equal(applyRealignItems(strictBad, analyzeKaraoke(strictBad), [repairProposal],
    { projectId: 'p-A', revision: rev }).changed, 0, '严格模式仍拒绝词数不一致');
  const repairedDoc = new AssDoc(badDoc.serialize());
  const repaired = applyRealignItems(repairedDoc, analyzeKaraoke(repairedDoc), [repairProposal],
    { projectId: 'p-A', revision: 'other-revision', repairWords: true });
  assert.equal(repaired.changed, 1, '修复模式接受词数不一致的异常行');
  const after = analyzeKaraoke(repairedDoc).sentences.find(s => s.words.length);
  assert.equal(after.words.length, 2, '修复后逐词序列与文本分词一致');
  assert.equal(assPlainText(repairedDoc.events.find(e => e.style === 'Default').text), 'hello world',
    '修复逐词不改文本');
  const wrongWords = new AssDoc(badDoc.serialize());
  assert.equal(applyRealignItems(wrongWords, analyzeKaraoke(wrongWords),
    [{ ...repairProposal, words: [{ w: 'hello', s: 1, e: 2 }, { w: 'there', s: 2, e: 3 }] }],
    { projectId: 'p-A', revision: 'other-revision', repairWords: true }).changed, 0,
  '词序列与文本对不上时仍拒绝');
}
console.log('repair04: k/color text preservation, stale text/revision, project, repeated dialogue and word-count conflicts passed');
