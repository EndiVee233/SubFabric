/* 角色筛选在删除当前角色的全部字幕后保持，不跳回「全部角色」。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'editor/js/editor.js'), 'utf8');
assert.match(src, /if \(!keepView\) \{\s*this\._speaker = '';/, '只有载入新文件/换项目才清角色筛选');
assert.match(src, /this\._applyFilter\(keepView \? keepTop : 0\)/, '重建时保留当前角色过滤');
assert.match(src, /（0）<\/option>/, '角色消失后保留 0 条选项');
assert.match(src, /const cur = this\._speaker \|\| sel\.value \|\| '__all__'/, '当前筛选角色优先于下拉值');
assert.match(src, /sel\.value = \[\.\.\.sel\.options\]\.some\(o => o\.value === cur\) \? cur : '__all__'/, '找不到时才回退全部角色');
console.log('role-filter-persistence: 删除当前角色字幕后仍停留在该角色筛选');
