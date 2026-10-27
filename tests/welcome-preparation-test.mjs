import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { welcomeRecommendations, gpuMemoryText } from '../editor/js/welcome-model.js';

const models = [
  ['faster-whisper-large-v2', 'cuda', 'faster-whisper', 3090, 'runtime:faster-whisper', true],
  ['qwen3-asr-1.7b', 'cuda', 'qwen', 3880, 'runtime:qwen', false],
  ['parakeet-tdt-0.6b-v2-vulkan', 'vulkan', 'crispasr', 379, 'runtime:crispasr', true],
  ['whisper-large-v2-vulkan', 'vulkan', 'crispasr-whisper', 3095, 'runtime:crispasr', false],
  ['qwen3-asr-1.7b-vulkan', 'vulkan', 'crispasr-qwen', 1491, 'runtime:crispasr', false],
].map(([id, backend, engine, sizeMB, runtimeKey, nativeWordLevel]) => ({
  id, name: id, backend, engine, sizeMB, runtimeKey, nativeWordLevel,
  draftAllowed: true, filesOk: false, runtimeReady: false, backendAllowed: false,
}));
const status = { models, qwenPythonReady: true, aligners: ['cuda', 'vulkan'].map(backend => ({
  id: 'align-' + backend, backend, name: backend + ' aligner', filesOk: true,
  runtimeKey: backend === 'cuda' ? 'runtime:qwen' : 'runtime:crispasr', runtimeReady: false,
})) };
const hw = (cudaMB, vulkanMB = cudaMB) => ({
  cuda: { available: true, device: 'RTX 4060', vramMB: cudaMB, freeMB: 1024 },
  vulkan: { available: true, adapters: [{ name: 'AMD Radeon', vramMB: vulkanMB }] },
});
const both = { cuda: true, vulkan: true };
const group = (hardware, backend) => welcomeRecommendations(status, hardware, both).find(g => g.backend === backend);
assert.deepEqual(welcomeRecommendations(status, hw(8192), {}).map(g => g.backend), []);
assert.deepEqual(welcomeRecommendations(status, hw(8192), { vulkan: true }).map(g => g.backend), ['vulkan']);
assert.deepEqual(welcomeRecommendations(status, { cuda: { available: false } }, both), []);
assert.deepEqual(welcomeRecommendations(null, hw(8192), both), []);
assert.equal(group(hw(8192), 'cuda').models.filter(m => m.fits).length, 2);
assert.equal(group(hw(8188), 'cuda').models.filter(m => m.fits).length, 2, 'small driver reservation does not downgrade an 8GiB card');
assert.equal(group(hw(8063), 'cuda').models.filter(m => m.fits).length, 1, 'tier tolerance is bounded');
assert.equal(group(hw(6144), 'cuda').models.filter(m => m.fits).length, 1);
assert.equal(group(hw(4096), 'cuda').lowMemory, true);
assert.equal(group(hw(8192, 2048), 'vulkan').preferred, 'parakeet-tdt-0.6b-v2-vulkan');
assert.equal(group(hw(8192, 6144), 'vulkan').preferred, 'whisper-large-v2-vulkan');
assert.equal(group(hw(null), 'vulkan').preferred, 'parakeet-tdt-0.6b-v2-vulkan');
assert.equal(group(hw(null), 'cuda').models.some(m => m.fits), false);
assert.match(gpuMemoryText({ name: 'Arc', vramMB: 12288, freeMB: 0 }), /12.0 GiB.*0.0 GiB/);
assert.match(gpuMemoryText({ name: '<GPU>', vramMB: null }), /显存未知/);

const multi = hw(8192);
multi.cuda.devices = [{ name: 'RTX 2060', vramMB: 4096 }, { name: 'RTX 4090', vramMB: 24576 }];
multi.vulkan.adapters.push({ name: 'Intel UHD', vramMB: null });
assert.equal(group(multi, 'cuda').vramMB, 4096, 'CUDA uses first card, never sums cards');
assert.equal(group(multi, 'vulkan').vramMB, null, 'one unknown auto-selected adapter prevents a capacity claim');
multi.vulkan.adapters[1].vramMB = 2048;
assert.equal(group(multi, 'vulkan').vramMB, 2048);
multi.cuda.devices[0].vramMB = 12288;
assert.equal(group(multi, 'cuda').models.find(m => m.id === 'qwen3-asr-1.7b').fits, false, 'Turing bf16 is not recommended');

const before = JSON.stringify(status);
welcomeRecommendations(status, hw(8192), both);
assert.equal(JSON.stringify(status), before, 'recommendations do not mutate status or resurrect retired models');

// Execute the actual backend probe functions with deterministic command responses.
const source = fs.readFileSync(new URL('../editor/server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function detectNvidia()');
const end = source.indexOf('function asrBackends()', start);
assert.ok(start > 0 && end > start);
let nvidiaCalls = 0;
let controllerMemory = null;
let gpuLines = ['NVIDIA GeForce RTX 4060, 8192, 6144, 560.00', 'NVIDIA RTX 4090, 24576, N/A, 560.00'];
const sandbox = { path, process: { env: {} }, fs: { statSync: () => ({ isFile: () => true }) },
  setTimeout, clearTimeout,
  command: async (cmd, args) => {
    if (cmd === 'nvidia-smi') { nvidiaCalls++; return gpuLines; }
    const script = args.at(-1);
    if (script.includes('qwMemorySize')) return [JSON.stringify([{ name: 'AMD Radeon', vramMB: controllerMemory }])];
    if (script.includes('Win32_PnPEntity')) return [];
    return ['NVIDIA GeForce RTX 4060', 'AMD Radeon', 'Microsoft Remote Display Adapter'];
  } };
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end) + '\nrunCmdLines = command;', sandbox);
const probe = force => vm.runInContext('probeHardware(' + force + ')', sandbox);
const [first, duplicate] = await Promise.all([probe(false), probe(false)]);
assert.equal(first, duplicate, 'concurrent probes share their result');
assert.equal(nvidiaCalls, 1);
assert.equal(first.cuda.vramMB, 8192, 'VRAM above 4GB is not truncated');
assert.equal(first.cuda.devices.length, 2);
assert.equal(first.cuda.devices[1].freeMB, null, 'N/A is unknown, not zero');
assert.equal(first.vulkan.adapters[0].vramMB, 8192);
assert.equal(first.vulkan.adapters[1].vramMB, null);
assert.equal(first.vulkan.devices.length, 2, 'virtual adapters excluded');
await probe(false);
assert.equal(nvidiaCalls, 1, 'five minute cache is reused');
gpuLines = ['NVIDIA GeForce RTX 4060, 8192, 2048, 570.00'];
controllerMemory = 16384;
const refreshed = await probe(true);
assert.equal(nvidiaCalls, 2, 'refresh bypasses CUDA cache as well as hardware cache');
assert.equal(refreshed.cuda.freeMB, 2048);
assert.equal(refreshed.cuda.driver, '570.00');
assert.equal(refreshed.vulkan.adapters[1].vramMB, 16384);
gpuLines = ['No devices were found'];
const disconnected = await probe(true);
assert.equal(disconnected.cuda.available, false);
assert.equal(disconnected.cuda.devices.length, 0, 'failed re-probe clears stale device details');
assert.equal(disconnected.vulkan.adapters[0].vramMB, null);
console.log('welcome-preparation-test: ok (backend, VRAM tiers, dependencies, multi-GPU, cache/refresh)');
