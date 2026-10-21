import assert from 'node:assert/strict';
import { repairWord, repairSegments, buildGlossary } from '../editor/glossary-repair.js';

// 用户术语表（与真实素材里的专名一致）
const terms = ['Wemmbu', 'Spoke', 'Saparata', 'Flowtives', 'Minutetech', 'Jaden',
  'Unstable SMP', 'USMP', 'Bdubs', 'Etho', 'Minecraft', 'Null', 'Wraith'];
const g = buildGlossary(terms);

const cases = [
  // 真实误拼
  ['Wembu.', 'Wemmbu.', 'Wembu 少一个 m'],
  ['Sapparata,', 'Saparata,', 'Sapparata 多一个 p'],
  ['Flotives', 'Flowtives', 'Flotives 少 w'],
  ['Floatives', 'Flowtives', 'Floatives 多 a'],
  ['Minitech', 'Minutetech', 'Minitech 少 ute'],
  // 完全相等：保留标点与大小写
  ['USMP', 'USMP', '全大写缩写不动'],
  ['USMP.', 'USMP.', '标点保留'],
  ['Saparata,', 'Saparata,', '已正确不动'],
  // 不能误伤普通词
  ['with', 'with', 'with 不能被修成 Wraith'],
  ['Wait,', 'Wait,', 'Wait 不能被修成 Wraith'],
  ['spoke.', 'spoke.', '动词 spoke 不能改成角色名 Spoke'],
  ['wraith', 'wraith', '普通名词小写时保留小写习惯'],
];
for (const [inp, want, why] of cases) {
  assert.equal(repairWord(inp, g), want, why + `（输入 ${inp}）`);
}

// 空/无术语表：严格原样
assert.equal(repairWord('Wembu', []), 'Wembu');
assert.equal(repairWord('', g), '');
assert.equal(repairWord(null, g), '');

// segments：只重拼改过词的句子，未改的 text 保持原样（不重排外来空白）
const segs = [
  { text: 'say  hello   Wembu.', words: [{ word: 'say' }, { word: 'hello' }, { word: 'Wembu.' }] },
  { text: 'keep   this layout', words: [{ word: 'keep' }, { word: 'this' }, { word: 'layout' }] },
];
const n = repairSegments(segs, terms);
assert.equal(n, 1, '只报告一个改动');
assert.equal(segs[0].text, 'say hello Wemmbu.', '改过的句子重拼');
assert.equal(segs[1].text, 'keep   this layout', '未改的句子保持原始空白');

console.log('glossary-repair-test: ok');
