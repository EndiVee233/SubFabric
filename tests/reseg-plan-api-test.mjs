import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { mockLlm } from './helpers/mock-llm.mjs';

/* 全片重分句规划：模型给的每段必须能拼回原文，拼不回去的行整行丢弃。 */
const llm = await mockLlm(() => ([
  { row: 0, parts: [{ zh: '大家好', en: 'Hello everyone,' }, { zh: '欢迎来到今天的节目', en: 'welcome to the show today' }] },
  { row: 1, parts: [{ zh: '我们直接', en: 'Let us' }, { zh: '开始吧', en: 'get going' }] },  // "get going" ≠ 原文 → 丢弃
  { row: 99, parts: [{ zh: 'x', en: 'y' }, { zh: 'z', en: 'w' }] },                          // 行号越界 → 丢弃
]));
const s = await isolatedServer();
try {
  s.settings({ translate: { provider: 'custom', baseUrl: llm.url, apiKey: 'test-key', model: 'fake' } });
  const dir = path.join(s.root, 'projects/p-rs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-rs', name: 'rs', subtitle: { file: 'subtitle.ass' } }));

  const rows = [
    { zh: '大家好 欢迎来到今天的节目', en: 'Hello everyone, welcome to the show today', start: 1, end: 4 },
    { zh: '我们直接开始吧', en: 'Let us get started right now', start: 5, end: 8 },
  ];
  const r = await s.call('/api/projects/p-rs/reseg-plan', { method: 'POST', body: JSON.stringify({ rows }) });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const j = JSON.parse(text);
  assert.equal(j.plan.length, 1, '只有能拼回原文的行留下');
  assert.equal(j.plan[0].row, 0);
  assert.deepEqual(j.plan[0].parts.map(p => p.zh), ['大家好', '欢迎来到今天的节目']);
  assert.equal(j.dropped, 1, '改写原文的那一行被记为 dropped');
  assert.equal(j.rows, 2);
  const reqText = llm.requests.at(-1).messages.map(m => m.content).join('\n');
  assert.ok(reqText.includes('大家好 欢迎来到今天的节目'), '请求里带上中文行');
  assert.ok(reqText.includes('Hello everyone, welcome to the show today'), '请求里带上英文行');
  assert.ok(!reqText.includes('video'), '请求不夹带无关内容');

  // 没有可拆的行 → [] 且不报错
  const empty = await mockLlm(() => ([]));
  s.settings({ translate: { provider: 'custom', baseUrl: empty.url, apiKey: 'test-key', model: 'fake' } });
  const r2 = await s.call('/api/projects/p-rs/reseg-plan', { method: 'POST', body: JSON.stringify({ rows }) });
  assert.equal(r2.status, 200);
  assert.deepEqual((await r2.json()).plan, []);
  await empty.close();

  // 空行 → 400
  const r3 = await s.call('/api/projects/p-rs/reseg-plan', { method: 'POST', body: JSON.stringify({ rows: [] }) });
  assert.equal(r3.status, 400);

  console.log('reseg-plan: 合法拆分保留、改写/越界丢弃、空计划与空输入校验通过');
} finally {
  await s.close();
  await llm.close();
}
