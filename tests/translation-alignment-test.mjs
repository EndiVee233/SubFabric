import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import llmText from '../editor/llm-text.js';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { mockLlm, until } from './helpers/mock-llm.mjs';

const originals = ['First fragment.', 'second fragment.', 'Final sentence.'];
const records = originals.map((source, i) => ({ id: i + 1, source, translation: '译文' + i }));
const parse = value => llmText.parseTranslationReply(JSON.stringify(value), originals);
assert.deepEqual(parse([records[2], records[0], records[1]]), ['译文0', '译文1', '译文2']);
assert.equal(parse([records[0], records[0], records[2]]), null, 'duplicated IDs cannot compensate for a missing line');
assert.equal(parse([records[0], records[2]]), null);
assert.equal(parse([{ ...records[0], id: 4 }, records[1], records[2]]), null);
assert.equal(parse([{ ...records[0], id: '1' }, records[1], records[2]]), null);
assert.equal(parse([{ ...records[0], translation: '' }, records[1], records[2]]), null);
// Reproduce the reported shift. A model merges two source fragments, renumbers
// subsequent translations, then repeats the last one to satisfy the line count.
assert.equal(parse([
  { id: 1, source: originals[0] + ' ' + originals[1], translation: '合并译文' },
  { id: 2, source: originals[2], translation: '错位译文' },
  { id: 3, source: originals[2], translation: '补齐行数' },
]), null);
assert.equal(llmText.parseTranslationReply('1. 合并译文\n2. 错位译文\n3. 补齐行数', originals), null);
assert.equal(llmText.parseLineArrayReply('1. 甲\n3. 丙\n3. 重复丙', 3), null);
assert.equal(llmText.parseLineArrayReply('1. 甲\n3. 丙\n补回遗漏乙', 3), null);
assert.equal(llmText.parseLineArrayReply('1. 甲\n2. 乙\n3. 多余丙', 2), null);
assert.deepEqual(llmText.parseTranslationReply('1. 单句译文', ['Single sentence.']), ['单句译文']);
const special = ['quote " slash \\ newline\n字', 'same', 'same', ''];
const specialRecords = special.map((source, i) => ({ id: i + 1, source, translation: source ? '译文' + i : '' }));
assert.deepEqual(llmText.parseTranslationReply(JSON.stringify(specialRecords), special), ['译文0', '译文1', '译文2', '']);
assert.deepEqual(JSON.parse(llmText.buildTranslateUserMessage(special, null, true)).map(row => row.source), special);

let phase = 'fail';
const llm = await mockLlm(body => {
  const content = body.messages.at(-1).content;
  const inputs = content.startsWith('[') ? JSON.parse(content)
    : [{ id: 1, source: content.replace(/^1\. /, '') }];
  // The first five lines permanently fail in this attempt. The following batch
  // succeeds, and must stay attached to line 6 across cache/save/retry.
  if (phase === 'fail' && inputs[0].source !== 'source5') return ['bad0', 'bad1'];
  return inputs.map(row => ({ ...row, translation: '中文' + row.source.slice(6) }));
});
const server = await isolatedServer();
try {
  server.settings({ translate: { provider: 'custom', baseUrl: llm.url, apiKeyEnc: 'isolated-test', model: 'mock', batchSize: 5 } });
  const dir = path.join(server.root, 'projects/p-binding');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-binding', subtitle: { file: 'subtitle.srt' } }));
  const original = Array.from({ length: 6 }, (_, i) =>
    (i + 1) + '\n00:00:0' + i + ',000 --> 00:00:0' + (i + 1) + ',000\nsource' + i + '\n\n').join('');
  const file = path.join(dir, 'subtitle.srt');
  fs.writeFileSync(file, original);
  const run = async () => {
    const response = await server.call('/api/projects/p-binding/translate', { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    return until(async () => {
      const response = await server.call('/api/projects/p-binding/draft');
      const { draft } = await response.json();
      return draft && draft.status !== 'running' && draft;
    });
  };
  const first = await run();
  assert.equal(first.status, 'paused');
  assert.equal(first.pendingTranslate, 5);
  const cache = () => JSON.parse(fs.readFileSync(path.join(dir, 'translation.json')));
  assert.deepEqual(cache().lines, ['', '', '', '', '', '中文5']);
  assert.equal(fs.readFileSync(file, 'utf8'), original.replace('source5\n', '中文5\nsource5\n'));
  const boundary = llm.requests.length;
  phase = 'retry';
  const second = await run();
  assert.equal(second.status, 'done', second.error);
  assert.deepEqual(cache().lines, Array.from({ length: 6 }, (_, i) => '中文' + i));
  assert.equal(llm.requests.length - boundary, 1, 'only the incomplete lines are translated again');
  assert.equal(fs.readFileSync(file, 'utf8'), original.replace(/source(\d)\n/g, '中文$1\nsource$1\n'));
  console.log('Translation alignment: merged/renumbered replies rejected; source, ID, empty and special text validated; partial failure and resume retain original row positions');
} finally {
  await server.close();
  await llm.close();
}
