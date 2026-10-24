import assert from 'node:assert/strict';
import { mergeGlossary, parseEntry } from '../editor/glossary-merge.js';

/* 1) 空术语表 → 直接追加 */
assert.equal(mergeGlossary('', '简体', [{ src: 'Ender Dragon', dst: '末影龙' }]), 'Ender Dragon=末影龙');
assert.equal(mergeGlossary(null, '简体', [{ src: 'Alex', dst: '亚历克斯' }]), 'Alex=亚历克斯');

/* 2) 已存在（忽略大小写）只改译法，保留原行位置与注释 */
{
  const src = '# 人物\nAlex=亚历克斯\n# 生物\nEnder Dragon=末影龙\n';
  const out = mergeGlossary(src, '简体', [{ src: 'alex', dst: '阿力克斯' }]);
  assert.ok(out.includes('# 人物'), '注释保留');
  assert.ok(out.includes('# 生物'), '其它注释保留');
  assert.ok(out.includes('Alex=阿力克斯'), '大小写不同的原文原地更新（保留原拼写）');
  assert.ok(out.includes('Ender Dragon=末影龙'), '未涉及的词不动');
}

/* 3) 有分组时只写目标组，不动其它组 */
{
  const src = '##简体\nAlex=亚历克斯\n\n##繁體\nAlex=亞歷克斯\n';
  const out = mergeGlossary(src, '简体', [{ src: 'Alex', dst: '阿力' }, { src: 'Cookie', dst: '饼干' }]);
  assert.ok(/##简体\nAlex=阿力\nCookie=饼干\n/.test(out), '简体组更新 + 追加（插在尾随空行之前）:\n' + out);
  assert.ok(out.includes('##繁體\nAlex=亞歷克斯'), '繁體组原文不动');
}

/* 4) 目标组不存在 → 末尾新建该组 */
{
  const out = mergeGlossary('##繁體\nAlex=亞歷克斯\n', '简体', [{ src: 'Cookie', dst: '饼干' }]);
  assert.ok(/##简体\nCookie=饼干\n?$/.test(out.trimEnd() + '\n'), '新建 ##简体 组:\n' + out);
}

/* 5) 非法/重复词条：跳过与去重 */
{
  const out = mergeGlossary('', '简体', [
    { src: '', dst: '空原文' },
    { src: 'X', dst: '' },
    { src: 'Alex', dst: '亚历克斯' },
    { src: 'alex', dst: '后写的重复项' },
    { src: '有\n换行', dst: 'y' },
  ]);
  assert.equal(out, 'Alex=亚历克斯', '第一条有效词写入，重复/非法跳过');
}

/* 6) 空格分隔的旧写法：更新时沿用原来的分隔符 */
{
  const out = mergeGlossary('Ender Dragon 末影龙', '简体', [{ src: 'Ender Dragon', dst: '终界龙' }]);
  assert.equal(out, 'Ender Dragon 终界龙');
}

/* 7) parseEntry 口径 */
assert.deepEqual(parseEntry('A=B'), { src: 'A', dst: 'B', sep: '=' });
assert.equal(parseEntry('# 注释'), null);
assert.equal(parseEntry('##简体'), null);
assert.equal(parseEntry(''), null);

console.log('glossary-merge: 空表/已有/分组/新建组/非法词/旧分隔符 7 组用例通过');
