import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const worker = fs.readFileSync(path.join(root, 'asr', 'vibevoice.py'), 'utf8');
const server = fs.readFileSync(path.join(root, 'editor', 'server.js'), 'utf8');
const project = fs.readFileSync(path.join(root, 'editor', 'js', 'project.js'), 'utf8');

// Keep the device contract explicit: VibeVoice is a CUDA-only NF4 worker and
// must never silently turn into a CPU/NPU/offload path when the runtime is not
// available.
assert.match(worker, /choices=\["cuda"\]/);
assert.match(worker, /VibeVoice 只允许 CUDA 推理/);
assert.match(worker, /量化元数据/);
assert.match(worker, /quantization_method/);
assert.match(worker, /acoustic_tokenizer_chunk_size/);
assert.match(worker, /VibeVoiceAsrForConditionalGeneration/);
assert.match(worker, /dtype.*torch\.bfloat16/);
assert.doesNotMatch(worker, /AutoModelForSeq2SeqLM/);
assert.match(worker, /CPU\/offload/);

// The server manifest must download the metadata file together with the
// checkpoint and expose the family to the new settings UI.
assert.match(server, /id: 'vibevoice-asr-4bit'/);
assert.match(server, /Dubedo\/VibeVoice-ASR-HF-NF4/);
assert.match(server, /quantization_metadata\.json/);
assert.match(server, /VibeVoice 4bit 只支持 NVIDIA CUDA GPU/);
assert.match(server, /engine === 'vibevoice'/);
assert.match(server, /Preserve the hardware fields/);
assert.match(server, /--index-url', VIBEVOICE_RUNTIME\.torchIndex/);
assert.match(server, /不会改用 CPU/);
assert.match(project, /if \(m\.engine === 'vibevoice'\) return 'VibeVoice 系列'/);

console.log('vibevoice-contract: CUDA-only NF4 manifest, native model class, metadata and UI family passed');
