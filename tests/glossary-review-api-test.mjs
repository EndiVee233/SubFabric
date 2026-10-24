import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';
import { mockLlm } from './helpers/mock-llm.mjs';

/* 全片术语表校对：LLM 返回的专有名词里，术语表已有的词带出现有译法（known=true），
 * 其余标记为模型新生成；apply 把词条合并进当前翻译方案的术语表（保留注释/分组）。 */
const llm = await mockLlm(() => ([
  { src: 'Ender Dragon', dst: '末影龙' },
  { src: 'Alex', dst: '模型乱译' },          // 术语表里已有 → 必须用表里的 亚历克斯
  { src: 'Cookie', dst: '饼干' },
]));
const s = await isolatedServer();
try {
  s.settings({
    translate: {
      provider: 'custom', baseUrl: llm.url, apiKey: 'test-key', model: 'fake',
      glossary: '# 人物\nAlex=亚历克斯\n', glossaryLang: '简体',
    },
  });
  const dir = path.join(s.root, 'projects/p-gloss');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'p-gloss', name: 'test', subtitle: { file: 'subtitle.ass' } }));
  fs.writeFileSync(path.join(dir, 'asr.json'), JSON.stringify({
    segments: [
      { start: 0, end: 2, text: '[Alex] Ender Dragon 来了' },
      { start: 2, end: 4, text: '[Spoke] 这是一句普通的话' },
    ],
  }));

  const r = await s.call('/api/projects/p-gloss/glossary-review', { method: 'POST' });
  const rText = await r.text();
  assert.equal(r.status, 200, rText);
  const j = JSON.parse(rText);
  const bySrc = Object.fromEntries(j.terms.map(t => [t.src, t]));
  assert.ok(bySrc['Ender Dragon'], '模型新生成的词出现');
  assert.equal(bySrc['Ender Dragon'].known, false, '新词标记为模型生成');
  assert.equal(bySrc['Ender Dragon'].dst, '末影龙');
  assert.ok(bySrc['Alex'], '术语表已有的词出现');
  assert.equal(bySrc['Alex'].known, true, '已有词标记为来自术语表');
  assert.equal(bySrc['Alex'].dst, '亚历克斯', '已有词沿用术语表译法而不是模型乱译');
  assert.equal(bySrc['Cookie'].known, false, '另一个新词也在');
  const reqText = llm.requests.at(-1).messages.map(m => m.content).join('\n');
  assert.ok(reqText.includes('Ender Dragon 来了'), '请求里带上了字幕正文（角色标签已去掉）');
  assert.ok(!reqText.includes('[Alex] Ender Dragon'), '行首角色标签不送给模型');
  assert.ok(reqText.includes('Alex=亚历克斯'), '请求里带上了现有术语表');

  // 保存：合并进当前翻译配置（无方案时写 settings.translate.glossary）
  let a = await s.call('/api/projects/p-gloss/glossary-apply', {
    method: 'POST',
    body: JSON.stringify({ terms: [{ src: 'Ender Dragon', dst: '末影龙' }, { src: 'Alex', dst: '亚历克斯' }], saveToScheme: true }),
  });
  assert.equal(a.status, 200);
  let aj = await a.json();
  assert.equal(aj.saved, true);
  assert.equal(aj.count, 2);
  let st = JSON.parse(fs.readFileSync(path.join(s.root, 'asr/settings.json'), 'utf8'));
  assert.ok(st.translate.glossary.includes('# 人物'), '注释保留');
  assert.ok(st.translate.glossary.includes('Alex=亚历克斯'), '已有词不变');
  assert.ok(st.translate.glossary.includes('Ender Dragon=末影龙'), '新词写入');

  // 不勾选保存：不落盘
  const before = st.translate.glossary;
  a = await s.call('/api/projects/p-gloss/glossary-apply', {
    method: 'POST',
    body: JSON.stringify({ terms: [{ src: 'Cookie', dst: '饼干' }], saveToScheme: false }),
  });
  assert.equal(a.status, 200);
  aj = await a.json();
  assert.equal(aj.saved, false);
  st = JSON.parse(fs.readFileSync(path.join(s.root, 'asr/settings.json'), 'utf8'));
  assert.equal(st.translate.glossary, before, 'saveToScheme=false 时术语表不变');

  // 有命名方案时：写进该方案 + 当前配置，且不改变 schemeId
  const st0 = JSON.parse(fs.readFileSync(path.join(s.root, 'asr/settings.json'), 'utf8'));
  st0.translateSchemeId = 'sc-1';
  st0.translateSchemes = [{ id: 'sc-1', name: '方案A', provider: 'custom', baseUrl: llm.url, model: 'fake', glossary: '##简体\nAlex=亚历克斯\n', glossaryLang: '简体' }];
  s.settings(st0);
  a = await s.call('/api/projects/p-gloss/glossary-apply', {
    method: 'POST',
    body: JSON.stringify({ terms: [{ src: 'Cookie', dst: '饼干' }], saveToScheme: true }),
  });
  assert.equal(a.status, 200);
  aj = await a.json();
  assert.equal(aj.scheme && aj.scheme.id, 'sc-1', '返回写入的方案');
  st = JSON.parse(fs.readFileSync(path.join(s.root, 'asr/settings.json'), 'utf8'));
  assert.equal(st.translateSchemeId, 'sc-1', '不改变当前方案');
  const sc = st.translateSchemes.find(x => x.id === 'sc-1');
  assert.ok(sc.glossary.includes('Cookie=饼干'), '写进方案 A 的术语表');
  assert.ok(sc.glossary.includes('##简体'), '分组保留');
  assert.ok(st.translate.glossary.includes('Cookie=饼干'), '当前翻译配置同步');

  // 空词条 / 全空 → 400
  a = await s.call('/api/projects/p-gloss/glossary-apply', {
    method: 'POST', body: JSON.stringify({ terms: [{ src: '', dst: '' }], saveToScheme: true }),
  });
  assert.equal(a.status, 400);

  console.log('glossary-review: LLM 提取、已有词沿用、新词标记、合并写入方案、不保存分支与空词校验通过');
} finally {
  await s.close();
  await llm.close();
}
