import assert from 'node:assert/strict';
import {
  backendOf, modelVisible, visibleModels, extraModels, isDownloadedModel,
  pickVisibleModel, hasEnabledBackend,
} from '../editor/js/welcome-model.js';

const hwBoth = {
  cuda: { available: true, device: 'RTX' },
  vulkan: { available: true, devices: ['RTX'] },
  npu: { available: true, devices: ['AI Boost'] },
};
const hwVulkan = {
  cuda: { available: false },
  vulkan: { available: true, devices: ['Arc'] },
  npu: { available: false },
};
const hwCuda = {
  cuda: { available: true, device: 'RTX' },
  vulkan: { available: false },
  npu: { available: false },
};
const model = (id, engine, extra = {}) => ({ id, engine, ready: true, ...extra });

// 后端归类
assert.equal(backendOf(model('a', 'sherpa-onnx')), 'cuda');
assert.equal(backendOf(model('a', 'faster-whisper')), 'cuda');
assert.equal(backendOf(model('a', 'nemo')), 'cuda');
assert.equal(backendOf(model('a', 'whisper.cpp')), 'vulkan');
assert.equal(backendOf(model('a', 'crispasr')), 'vulkan');
assert.equal(backendOf(model('a', 'openvino')), 'npu');
assert.equal(backendOf(model('a', 'dual')), 'dual');
assert.equal(backendOf(model('a', 'bcut', { cloud: true })), 'cloud');
assert.equal(backendOf(null), 'cloud');

// 至少一个后端
assert.equal(hasEnabledBackend(null), true);
assert.equal(hasEnabledBackend({ cuda: false, vulkan: false }), false);
assert.equal(hasEnabledBackend({ cuda: true, vulkan: false }), true);

// 没勾 CUDA → CUDA 模型隐藏；Vulkan 模型保留
assert.equal(modelVisible(model('pk', 'sherpa-onnx'), { backends: { cuda: false, vulkan: true }, hardware: hwBoth }), false);
assert.equal(modelVisible(model('fw', 'faster-whisper'), { backends: { cuda: false, vulkan: true }, hardware: hwBoth }), false);
assert.equal(modelVisible(model('wc', 'whisper.cpp'), { backends: { cuda: false, vulkan: true }, hardware: hwBoth }), true);
// 没勾 Vulkan → Vulkan 模型隐藏
assert.equal(modelVisible(model('wc', 'whisper.cpp'), { backends: { cuda: true, vulkan: false }, hardware: hwBoth }), false);
assert.equal(modelVisible(model('pk', 'sherpa-onnx'), { backends: { cuda: true, vulkan: false }, hardware: hwBoth }), true);

// 没有 NPU 硬件 → NPU / 双引擎隐藏
assert.equal(modelVisible(model('npu', 'openvino'), { backends: { cuda: true, vulkan: true }, hardware: hwVulkan }), false);
assert.equal(modelVisible(model('dual', 'dual'), { backends: { cuda: true, vulkan: true }, hardware: hwBoth }), true);
assert.equal(modelVisible(model('dual', 'dual'), { backends: { cuda: false, vulkan: true }, hardware: hwBoth }), false);
// NPU 不在欢迎页勾选；只要硬件在就显示（设置页）
assert.equal(modelVisible(model('npu', 'openvino'), { backends: { cuda: true, vulkan: false }, hardware: hwBoth }), true);

// 云端永远可见，哪怕什么都没勾
assert.equal(modelVisible(model('bcut', 'bcut', { cloud: true }), { backends: { cuda: false, vulkan: false }, hardware: hwVulkan }), true);

// 服务端已判 backendAllowed=false 时前端也隐藏（双保险）
assert.equal(modelVisible(model('x', 'sherpa-onnx', { backendAllowed: false }), { backends: { cuda: true, vulkan: true }, hardware: hwBoth }), false);

// 严格按勾选：只勾 Vulkan 时 CUDA 不可见；只勾 CUDA 时 Vulkan 不可见；两个都勾才都可见。
assert.equal(modelVisible(model('cuda', 'sherpa-onnx'), { backends: { cuda: false, vulkan: true }, hardware: hwCuda }), false);
assert.equal(modelVisible(model('vulkan', 'whisper.cpp'), { backends: { cuda: true, vulkan: false }, hardware: hwVulkan }), false);
assert.equal(modelVisible(model('cuda', 'sherpa-onnx'), { backends: { cuda: true, vulkan: false }, hardware: hwCuda }), true);
assert.equal(modelVisible(model('vulkan', 'whisper.cpp'), { backends: { cuda: false, vulkan: true }, hardware: hwVulkan }), true);
assert.equal(modelVisible(model('cuda', 'sherpa-onnx'), { backends: { cuda: true, vulkan: true }, hardware: hwBoth }), true);
assert.equal(modelVisible(model('vulkan', 'whisper.cpp'), { backends: { cuda: true, vulkan: true }, hardware: hwBoth }), true);

// “其它模型”：已下载但当前后端未勾选/硬件不可用；未下载的不进。
const downloadedCuda = model('down-cuda', 'sherpa-onnx', { filesOk: true, ready: true });
const downloadedVulkan = model('down-vk', 'whisper.cpp', { filesOk: true, ready: true });
const partialCuda = model('partial-cuda', 'sherpa-onnx', { filesOk: false, ready: false });
const downloadedNpu = model('down-npu', 'openvino', { filesOk: true, ready: true });
const downloadedDual = model('down-dual', 'dual', { filesOk: true, ready: true });
assert.equal(isDownloadedModel(downloadedCuda), true);
assert.equal(isDownloadedModel(partialCuda), false);
assert.equal(isDownloadedModel(model('cloud', 'bcut', { cloud: true, filesOk: true })), false);
assert.deepEqual(
  extraModels([downloadedCuda, partialCuda], { backends: { cuda: false, vulkan: true }, hardware: hwVulkan }).map(m => m.id),
  ['down-cuda']);
assert.deepEqual(
  extraModels([downloadedVulkan], { backends: { cuda: true, vulkan: false }, hardware: hwCuda }).map(m => m.id),
  ['down-vk']);
// 旧配置里勾了 CUDA，但机器是 AMD（没有 N 卡）：已下载的 CUDA 仍进其它模型。
assert.deepEqual(
  extraModels([downloadedCuda], { backends: { cuda: true, vulkan: false }, hardware: hwVulkan }).map(m => m.id),
  ['down-cuda']);
// 反过来，勾了 Vulkan 但机器没有 Vulkan：已下载的 Vulkan 也进其它模型。
assert.deepEqual(
  extraModels([downloadedVulkan], { backends: { cuda: false, vulkan: true }, hardware: hwCuda }).map(m => m.id),
  ['down-vk']);
assert.deepEqual(
  extraModels([downloadedCuda, downloadedVulkan], { backends: { cuda: true, vulkan: true }, hardware: hwBoth }).map(m => m.id),
  []);
// NPU 没有硬件时，连“其它模型”都不出现；有 NPU 且只勾 CUDA 时，下错的双引擎仍可收进其它模型
assert.deepEqual(extraModels([downloadedNpu, downloadedDual], { backends: { cuda: true, vulkan: false }, hardware: hwCuda }).map(m => m.id), []);
assert.deepEqual(extraModels([downloadedNpu], { backends: { cuda: true, vulkan: false }, hardware: hwBoth }).map(m => m.id), []);
assert.deepEqual(extraModels([downloadedDual], { backends: { cuda: false, vulkan: true }, hardware: hwBoth }).map(m => m.id), ['down-dual']);
// 未勾选但已下载的 Vulkan，也只在没选 Vulkan 时进其它模型
assert.deepEqual(extraModels([downloadedVulkan], { backends: { cuda: false, vulkan: true }, hardware: hwBoth }).map(m => m.id), []);

// 过滤 + 默认选择：跳过隐藏/未就绪，优先可创建初稿
const models = [
  model('cuda-ready', 'sherpa-onnx'),
  model('vulkan-not-ready', 'whisper.cpp', { ready: false }),
  model('vulkan-ready', 'crispasr'),
  model('cloud', 'bcut', { cloud: true }),
  model('npu', 'openvino'),
];
const vis = visibleModels(models, { backends: { cuda: true, vulkan: false }, hardware: hwBoth });
assert.deepEqual(vis.map(m => m.id), ['cuda-ready', 'cloud', 'npu']);
assert.equal(pickVisibleModel(models, 'vulkan-ready', { backends: { cuda: true, vulkan: false }, hardware: hwBoth }), 'cuda-ready');
assert.equal(pickVisibleModel(models, 'cuda-ready', { backends: { cuda: true, vulkan: false }, hardware: hwBoth }), 'cuda-ready');
assert.equal(pickVisibleModel([], 'x', {}), '');

console.log('welcome-model-test: ok');
