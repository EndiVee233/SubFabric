/* Qwen3-ForcedAligner CUDA 运行时安装：必须真装 CUDA 版 PyTorch，而不是只装 Transformers。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'editor/server.js'), 'utf8');
assert.match(src, /const QWEN_TORCH_INDEX =/, 'Qwen 运行时配置 CUDA PyTorch 源');
assert.match(src, /return fs\.existsSync\(vp\) \? vp : ASR_PY;/, '优先复用 VibeVoice CUDA Python');
assert.match(src, /import torch; print\(torch\.cuda\.is_available\(\)\)/, '安装前后探测 CUDA');
assert.match(src, /'torch', 'torchaudio'/, 'CUDA torch 随运行时安装');
assert.match(src, /CUDA PyTorch 安装后仍不可用/, 'CUDA 仍不可用时给出可读错误');
assert.match(src, /transformers==5\.20\.2/, '继续安装 Qwen 所需 Transformers');
console.log('qwen-runtime-install: CUDA PyTorch 安装与复用 VibeVoice 运行时已接线');
