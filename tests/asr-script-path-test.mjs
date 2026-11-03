/* ASR 脚本在嵌入式 Python 下必须能 import 同目录的 common.py。
 * asr/runtime-python 的 ._pth 不把脚本目录加入 sys.path，启动 qwen_align.py 时
 * 曾报 ModuleNotFoundError: No module named 'common'。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
for (const rel of ['asr/qwen_align.py', 'asr/diarize.py']) {
  const src = read(rel);
  const at = src.lastIndexOf('from common import');
  assert.ok(at > 0, `${rel} imports common`);
  const before = src.slice(0, at);
  assert.match(before, /sys\.path\.insert\(0, /, `${rel} adds its own directory to sys.path before common`);
  assert.match(before, /__file__/, `${rel} uses __file__ for the script directory`);
}
const align = read('asr/qwen_align.py');
assert.ok(align.indexOf('sys.path.insert') < align.lastIndexOf('from common import'), 'qwen_align bootstraps before import');
assert.match(align, /ModuleNotFoundError/, 'comment explains embedded _pth reason');
console.log('asr-script-path: qwen_align/diarize 在嵌入式 Python 下可导入 common');
