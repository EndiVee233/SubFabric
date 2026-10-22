/* Aligner model status = files and runtime reported separately.
 * Run: node tests/asr-aligner-status-test.mjs
 *
 * Product rule: an aligner whose files are complete but whose runtime is missing
 * must not look like "not downloaded". The UI needs filesOk / needRuntime /
 * runtimeReady so it can show 「模型已下载 · 还差运行时」 and an install button
 * instead of a download button that silently does nothing (server returns
 * {started:false, ready:true} when the files are already complete).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedServer } from './helpers/isolated-server.mjs';

const CUDA_FILES = {
  'config.json': 248029,
  'model.safetensors': 1835545960,
  'processor_config.json': 487,
  'tokenizer.json': 11429842,
  'tokenizer_config.json': 998,
  'chat_template.jinja': 551,
};
const VULKAN_FILE = 'qwen3-forced-aligner-0.6b-q8_0.gguf';
const VULKAN_SIZE = 985594624;

/** Sparse file: fast on NTFS and enough for the size checks (content is never read). */
function sparse(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}

const server = await isolatedServer();
try {
  const models = path.join(server.root, 'asr', 'models');
  const cudaDir = path.join(models, 'qwen3-forced-aligner-0.6b');
  const vulkanDir = path.join(models, 'qwen3-forced-aligner-0.6b-vulkan');
  for (const [name, size] of Object.entries(CUDA_FILES)) sparse(path.join(cudaDir, name), size);
  sparse(path.join(vulkanDir, VULKAN_FILE), VULKAN_SIZE);
  // CrispASR runtime present: the Vulkan aligner has everything it needs.
  fs.mkdirSync(path.join(server.root, 'asr', 'crispasr'), { recursive: true });
  fs.writeFileSync(path.join(server.root, 'asr', 'crispasr', 'crispasr.exe'), '');

  const readAligners = async () => {
    const status = await server.call('/api/asr/status');
    assert.equal(status.status, 200);
    return (await status.json()).aligners;
  };

  const fullStatus = await (await server.call('/api/asr/status')).json();
  let aligners = fullStatus.aligners;
  const cuda = aligners.find(a => a.id === 'qwen3-forced-aligner-0.6b');
  const vulkan = aligners.find(a => a.id === 'qwen3-forced-aligner-0.6b-vulkan');
  assert.ok(cuda && vulkan, 'both aligner entries are reported');

  // CUDA alignment model downloaded, Qwen CUDA runtime absent → downloaded but not ready.
  assert.equal(cuda.filesOk, true, 'CUDA aligner files count as downloaded');
  assert.deepEqual(cuda.missing, [], 'no missing files');
  assert.equal(cuda.runtimeReady, false, 'Qwen runtime is not installed');
  assert.equal(cuda.needRuntime, true, 'CUDA aligner still needs its runtime');
  assert.equal(cuda.ready, false, 'runtime missing → not ready');
  assert.equal(cuda.runtimeKey, 'runtime:qwen');

  // Vulkan alignment model + CrispASR runtime both present → fully ready.
  assert.equal(vulkan.filesOk, true);
  assert.equal(vulkan.runtimeReady, true, 'CrispASR runtime detected');
  assert.equal(vulkan.needRuntime, false);
  assert.equal(vulkan.ready, true, 'files + runtime = ready');

  // The download endpoint must not pretend to re-download complete files, and must
  // refuse the CUDA aligner on a machine without an NVIDIA card.
  const cudaDownload = await server.call('/api/asr/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'qwen3-forced-aligner-0.6b' }),
  });
  if (fullStatus.gpu) {
    assert.equal(cudaDownload.status, 200);
    assert.equal((await cudaDownload.json()).started, false, 'complete files are adopted, not re-downloaded');
  } else {
    assert.equal(cudaDownload.status, 400);
    assert.match((await cudaDownload.json()).error, /NVIDIA|N 卡/);
  }
  const vulkanDownload = await server.call('/api/asr/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'qwen3-forced-aligner-0.6b-vulkan' }),
  });
  const vulkanReply = await vulkanDownload.json();
  assert.equal(vulkanDownload.status, 200);
  assert.equal(vulkanReply.started, false, 'Vulkan aligner files are already complete');

  // A half-missing file must be reported, not hidden behind ready:false.
  fs.truncateSync(path.join(cudaDir, 'model.safetensors'), 1024);
  aligners = await readAligners();
  const broken = aligners.find(a => a.id === 'qwen3-forced-aligner-0.6b');
  assert.equal(broken.filesOk, false, 'undersized weights are not a complete model');
  assert.equal(broken.missing.includes('model.safetensors'), false, 'present but wrong size is not "missing"');
  assert.equal(broken.partial, true, 'present but incomplete files must be deletable from the UI');

  // Restore the exact size: the API must recover without a server restart.
  sparse(path.join(cudaDir, 'model.safetensors'), CUDA_FILES['model.safetensors']);
  aligners = await readAligners();
  assert.equal(aligners.find(a => a.id === 'qwen3-forced-aligner-0.6b').filesOk, true,
    'status re-reads the directory instead of caching a stale failure');
  assert.equal(aligners.find(a => a.id === 'qwen3-forced-aligner-0.6b').partial, false);

  // A stale settings.models mapping (moved/deleted custom dir) must fall back to the
  // default directory when the model is actually there.
  server.settings({ models: { 'qwen3-forced-aligner-0.6b-vulkan': path.join(server.root, 'gone', 'vulkan') } });
  let fallback = (await readAligners()).find(a => a.id === 'qwen3-forced-aligner-0.6b-vulkan');
  assert.equal(fallback.dir, vulkanDir, 'stale mapping falls back to the default model directory');
  assert.equal(fallback.filesOk, true, 'fallback still detects the downloaded model');

  // An existing custom directory wins over the default one.
  const customDir = path.join(server.root, 'custom-aligner');
  sparse(path.join(customDir, VULKAN_FILE), VULKAN_SIZE);
  server.settings({ models: { 'qwen3-forced-aligner-0.6b-vulkan': customDir } });
  fallback = (await readAligners()).find(a => a.id === 'qwen3-forced-aligner-0.6b-vulkan');
  assert.equal(fallback.dir, customDir, 'an existing custom directory is still preferred');
  assert.equal(fallback.filesOk, true);

  console.log('asr-aligner-status-test: ok');
} finally {
  await server.close();
}
