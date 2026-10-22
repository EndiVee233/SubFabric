/* Draft ASR / aligner separation contract.
 * Run: node tests/draft-align-test.mjs
 *
 * Product rule:
 *   - ASR downloads only ASR; Qwen3-ForcedAligner is a separate model.
 *   - Models without native word timestamps (Qwen ASR, Whisper Vulkan) cannot
 *     check the native "逐词" option; they may check "对齐" instead.
 *   - Word off + align off = SRT; align on = word-level ASS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
const pj = fs.readFileSync(path.join(root, 'editor/js/project.js'), 'utf8');
const py = fs.readFileSync(path.join(root, 'asr/qwen_asr.py'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg); }
}

console.log('\n== 1. 对齐模型独立 ==');
ok(/const ALIGNER_MODELS = \[/.test(srv), '有独立的 ALIGNER_MODELS');
ok(/id: 'qwen3-forced-aligner-0\.6b'/.test(srv), 'CUDA 对齐器独立条目');
ok(/id: 'qwen3-forced-aligner-0\.6b-vulkan'/.test(srv), 'Vulkan 对齐器独立条目');
ok(/const alignerById = \(id\) => ALIGNER_MODELS/.test(srv), '对齐器有独立查找');
ok(/aligners: ALIGNER_MODELS\.map/.test(srv), '状态接口按独立模型返回对齐器');
ok(/const anyModelById = \(id\) => modelById\(id\) \|\| alignerById\(id\)/.test(srv), '下载/删除可命中对齐器');
const qwenStart = srv.indexOf("id: 'qwen3-asr-1.7b'");
const qwenEnd = srv.indexOf("id: 'whisper-large-v2-vulkan'", qwenStart);
const qwenBlock = qwenStart >= 0 && qwenEnd > qwenStart ? srv.slice(qwenStart, qwenEnd) : '';
ok(qwenBlock.length > 0, '找得到 Qwen3-ASR 条目');
ok(!/aligner\//.test(qwenBlock) && !/qwen3-forced-aligner/.test(qwenBlock),
  '★ 下载 Qwen3-ASR 不再包含对齐器文件');
ok(/nativeWordLevel: false/.test(qwenBlock), 'Qwen3-ASR 标记为无原生逐词');
const whisperStart = srv.indexOf("id: 'whisper-large-v2-vulkan'");
const whisperEnd = srv.indexOf("id: 'qwen3-asr-1.7b-vulkan'", whisperStart);
const whisperBlock = whisperStart >= 0 && whisperEnd > whisperStart ? srv.slice(whisperStart, whisperEnd) : '';
ok(!/qwen3-forced-aligner/.test(whisperBlock), 'Whisper Vulkan 也不夹带对齐器');
ok(/nativeWordLevel: false/.test(whisperBlock), 'Whisper Vulkan 标记为无原生逐词');
const qwenVkStart = srv.indexOf("id: 'qwen3-asr-1.7b-vulkan'");
const qwenVkEnd = srv.indexOf("id: 'parakeet-tdt-0.6b-v2-vulkan'", qwenVkStart);
const qwenVkBlock = qwenVkStart >= 0 && qwenVkEnd > qwenVkStart ? srv.slice(qwenVkStart, qwenVkEnd) : '';
ok(!/qwen3-forced-aligner/.test(qwenVkBlock), 'Qwen Vulkan 也不夹带对齐器');

console.log('\n== 2. 初稿选项与输出 ==');
ok(/id="np-row-align"/.test(html) && /id="np-align"/.test(html), '★ 建稿页有「对齐」选项');
ok(/id="np-row-word"/.test(html) && /id="np-word"/.test(html), '建稿页仍有「逐词」选项');
ok(/nativeWordLevel/.test(pj), '前端读取 nativeWordLevel');
ok(/word\.disabled = true; word\.checked = false;/.test(pj), '★ 无原生逐词时禁止勾选逐词');
ok(/align\.checked = true/.test(pj), '有对齐器时默认走对齐');
ok(/payload\.align =/.test(pj), '建稿 payload 带 align');
ok(pj.includes("align: !!($('#np-align')"), '链接下载建稿 payload 带 align');
ok(/wordLevel: nativeWanted \|\| align/.test(srv) || /wordLevel: nativeWanted \|\| align/.test(srv),
  '后端生成有效 wordLevel = 原生逐词或对齐');
ok(/nativeWanted && !native/.test(srv), '★ 后端拒绝无原生逐词模型的 wordLevel=true');
ok(/align && !draftAlignerReady\(m\)/.test(srv), '★ 勾选对齐但无对齐器时拒绝创建');
ok(/alignDraftAsrJson/.test(srv), '★ 原生模型勾对齐时有统一后对齐');
ok(/segs\[i\]\.words = item\.words\.map\(w => \(\{ word: w\.w, start: w\.s, end: w\.e \}\)\)/.test(srv),
  '对齐结果转换成 asr.json 的 word/start/end 形态');
ok(/if \(meta0\.draft && meta0\.draft\.align && model\.engine !== 'qwen'\)/.test(srv),
  '非 Qwen 引擎在生成字幕后、分句前做对齐');
ok(/wordLevel: draftPlan\.wordLevel, align: draftPlan\.align/.test(srv), 'meta 同时记录 effective wordLevel 与 align');

console.log('\n== 3. Qwen ASR worker 对齐器可选 ==');
ok(/--aligner", default=""|--aligner", default=''/.test(py) || /"--aligner", default=""|'--aligner', default=''/.test(py),
  'qwen_asr.py 的 --aligner 可选');
ok(/al_proc = al = None/.test(py), '未给对齐器时跳过加载');
ok(/segments_simple/.test(py), '★ 未给对齐器时输出句级段（SRT）');
ok(/if al_proc is None:/.test(py), '输出分支明确');
ok(srv.includes("--aligner', modelDirFor('qwen3-forced-aligner-0.6b')"), '建稿对齐时给 Qwen worker 传对齐器');

console.log('\n== 4. 设置页对齐模型下载 ==');
ok(/function alignerRowHtml/.test(pj), '有对齐模型卡片');
ok(/sm-dl" data-id="\$\{esc\(a\.id\)\}/.test(pj), '对齐模型卡片有下载按钮');
ok(/sm-del" data-id="\$\{esc\(a\.id\)\}/.test(pj), '对齐模型卡片有删除按钮');
ok(!/st-realign-minratio|st-realign-minconf|realign-conf/.test(html), '旧 realign 阈值没有回潮');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
