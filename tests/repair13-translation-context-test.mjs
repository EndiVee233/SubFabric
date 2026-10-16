import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import llmText from '../editor/llm-text.js';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { mockLlm, until } from './helpers/mock-llm.mjs';
import { serverFunctions } from './helpers/server-functions.mjs';

const messageParts = body => {
  const msg = body.messages.at(-1).content;
  const marker = /\[\[以下 \d+ 行才是本次要翻译的内容\]\]\n/;
  return { msg, texts: msg.split(marker).at(-1).split('\n') };
};
// 模型直接返回逐行纯文本；生产解析器仍兼容旧 JSON 数组，但本测试固定走新默认路径。
const llm = await mockLlm(body => ({ __rawContent: true,
  content: messageParts(body).texts.map(t => '译文' + t.match(/\d+/)[0]).join('\n') }));
const s = await isolatedServer();
try {
  const dir = path.join(s.root, 'projects/p-context'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'subtitle.srt'), cache = path.join(dir, 'translation.json');
  const manuscript = translated => Array.from({ length: 11 }, (_, i) =>
    `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i + 1).padStart(2, '0')},000\n${translated[i] ? translated[i] + '\n' : ''}line${i}\n\n`).join('');
  const configure = contextRows => s.settings({ translate: { provider: 'custom', baseUrl: llm.url,
    apiKeyEnc: 'isolated', model: 'fake', batchSize: 5, contextRows } });
  const start = async translated => {
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-context', subtitle: { file: 'subtitle.srt' } }));
    fs.writeFileSync(file, manuscript(translated)); llm.requests.length = 0;
    assert.equal((await s.call('/api/projects/p-context/translate', { method: 'POST', body: '{}' })).status, 200);
    const draft = await until(async () => {
      const d = await (await s.call('/api/projects/p-context/draft')).json(); return d.draft?.status !== 'running' && d.draft;
    });
    assert.equal(draft.status, 'done', draft.error);
    return llm.requests.map(messageParts);
  };
  configure(2);
  let calls = await start([]);
  assert.match(llm.requests[0].messages[0].content, /直接输出译文|纯文本译文/);
  assert.doesNotMatch(llm.requests[0].messages[0].content, /只输出一个 JSON 数组/);
  assert.deepEqual(calls.map(c => c.texts.length), [5, 5, 1]);
  assert.equal(calls[0].msg, 'line0\nline1\nline2\nline3\nline4');
  assert.match(calls[1].msg, /line3\t=> 译文3\nline4\t=> 译文4/);
  assert.match(calls[2].msg, /line8\t=> 译文8\nline9\t=> 译文9/);
  // 模拟中断后，仅前 5 行已保存到同版本缓存。
  const saved = JSON.parse(fs.readFileSync(cache));
  fs.writeFileSync(cache, JSON.stringify({ ...saved, lines: saved.lines.map((v, i) => i < 5 ? v : '') }));
  calls = await start([]);
  assert.deepEqual(calls.map(c => c.texts), [['line5', 'line6', 'line7', 'line8', 'line9'], ['line10']]);
  assert.match(calls[0].msg, /line4\t=> 译文4/);
  // 当前人工译文比缓存优先；参考从完整稿件取，待翻行可以不连续。
  fs.unlinkSync(cache);
  calls = await start({ 0: '已译零', 1: '已译一', 4: '人工四', 7: '人工七' });
  assert.deepEqual(calls[0].texts, ['line2', 'line3', 'line5', 'line6', 'line8']);
  assert.match(calls[0].msg, /line0\t=> 已译零\nline1\t=> 已译一/);
  assert.match(calls[1].msg, /line7\t=> 人工七\nline8\t=> 译文8/);
  fs.unlinkSync(cache); configure(0);
  calls = await start({ 0: '已译零' }); assert.ok(calls.every(c => !c.msg.includes('前文参考')));
  configure(2);
  fs.writeFileSync(cache, JSON.stringify({ ...saved, sourceKey: 'obsolete-version' }));
  calls = await start([]); assert.equal(calls[0].texts[0], 'line0'); assert.ok(!calls[0].msg.includes('前文参考'));
} finally { await s.close(); await llm.close(); }

// 执行真实拆批函数，模拟服务截断；检查右半批包含左半批新译文和稿件间隔行。
const requests = [];
const { translateLines } = serverFunctions(['translateLines'], {
  llmText, setTimeout: fn => { fn(); },
  translateOnce: async (cfg, texts, strict, opts) => {
    requests.push({ texts, refs: opts.refs });
    if (texts.length > 2) throw Object.assign(Error('truncated'), { kind: 'truncated' });
    return texts.map(t => '译' + t);
  }
});
const items = Array.from({ length: 7 }, (_, i) => ({ text: 's' + i }));
const idxs = [1, 2, 4, 6], lines = ['已译0', '', '', '已译3', '', '已译5', ''];
assert.deepEqual(Array.from(await translateLines({ contextRows: 3 }, idxs.map(i => items[i].text), 0, null, null,
  { items, idxs, lines })), ['译s1', '译s2', '译s4', '译s6']);
assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1).refs)), [
  { text: 's1', zh: '译s1' }, { text: 's2', zh: '译s2' }, { text: 's3', zh: '已译3' }
]);
requests.length = 0;
await translateLines({ contextRows: 0 }, ['a', 'b', 'c', 'd'], 0);
assert.ok(requests.every(r => !r.refs || !r.refs.length));
console.log('repair13: fresh batches, complete manuscript, current cache resume, edited translations, context=0 and split retry passed');
