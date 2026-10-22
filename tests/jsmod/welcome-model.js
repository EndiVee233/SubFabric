/* 欢迎界面的加速后端 / 模型可见性（纯逻辑，可单测）。
 *
 * 规则（用户定稿）：
 *   · 欢迎页只提供 CUDA 与 Vulkan 两个勾选；NPU 不在欢迎页出现，只在设置里按硬件显示。
 *   · 没勾 CUDA → 所有 CUDA 模型（sherpa / faster-whisper / NeMo / VibeVoice）不在正常列表。
 *   · 没勾 Vulkan → whisper.cpp / CrispASR 不在正常列表。
 *   · 没有 NPU 硬件 → OpenVINO 与双引擎模型不显示；有 NPU 则无需勾选也显示。
 *   · 双引擎同时需要 CUDA 与 NPU。
 *   · 云端模型不依赖本机加速，始终显示。
 *   · 不提供 CPU 推理，所以没有 "cpu" 后端。
 *   · 已下载但属于“未勾选后端 / 当前没有对应硬件”的模型单独进入 extraModels，
 *     由设置页收到「其它模型」里，只允许删除，不参与默认选择。
 */

export const BACKEND_LABEL = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  npu: 'NPU',
  dual: 'CUDA + NPU',
  cloud: '云端',
};

/** 模型属于哪个后端。未知引擎按 CUDA 处理，避免漏显示。 */
export function backendOf(model) {
  if (!model || model.cloud) return 'cloud';
  switch (model.engine) {
    case 'openvino': return 'npu';
    case 'dual': return 'dual';
    case 'whisper.cpp':
    case 'crispasr':
    case 'crispasr-whisper':
    case 'crispasr-qwen': return 'vulkan';
    case 'sherpa-onnx':
    case 'faster-whisper':
    case 'qwen':
    case 'nemo':
    case 'vibevoice':
    case 'bcut':
    case 'capcut': return 'cuda';
    default: return 'cuda';
  }
}

/** 后端勾选是否至少有一个。null = 还没配置过，按“可用”处理（兼容旧用户）。 */
export function hasEnabledBackend(backends) {
  if (!backends || typeof backends !== 'object') return true;
  return !!(backends.cuda || backends.vulkan);
}

function hardwareKnown(hardware) {
  return !!(hardware && typeof hardware === 'object' && (hardware.cuda || hardware.vulkan || hardware.npu));
}

/** 单个模型在当前勾选 + 硬件下是否可见。 */
export function modelVisible(model, { backends = null, hardware = null } = {}) {
  if (!model) return false;
  if (model.cloud) return true;
  if (model.backendAllowed === false) return false;
  const kind = backendOf(model);
  if (backends && typeof backends === 'object') {
    if (kind === 'cuda' && !backends.cuda) return false;
    if (kind === 'vulkan' && !backends.vulkan) return false;
    if (kind === 'dual' && !backends.cuda) return false;
  }
  if (hardwareKnown(hardware)) {
    if (kind === 'npu' && hardware.npu?.available !== true) return false;
    if (kind === 'cuda' && hardware.cuda?.available === false) return false;
    if (kind === 'vulkan' && hardware.vulkan?.available === false) return false;
    if (kind === 'dual' && (hardware.cuda?.available !== true || hardware.npu?.available !== true)) return false;
  }
  return true;
}

/** 过滤一整个 status.models 列表。不修改入参。 */
export function visibleModels(models, ctx) {
  return (Array.isArray(models) ? models : []).filter(m => modelVisible(m, ctx));
}

/** 文件是否已经下载过（运行时缺失也算“已下载”）。用于“其它模型”筛选。 */
export function isDownloadedModel(model) {
  return !!(model && !model.cloud && (model.filesOk === true || model.ready === true));
}

/** 已下载、但当前勾选/硬件下不可用的模型。
 *
 * 典型场景：AMD 显卡用户从旧版本留下了 CUDA 模型，或者先勾了 CUDA 下载完又改成只勾
 * Vulkan。它们不能出现在正常模型列表里（否则等于绕过后端选择），但也不该凭空消失；
 * 设置页把它们放到「其它模型」，保留删除入口，避免占着磁盘却找不到。
 *
 * NPU 规则例外：没有 NPU 硬件时，连「其它模型」也不显示 NPU/双引擎，严格做到
 * “有就显示，没有就不显示”。
 */
export function extraModels(models, { backends = null, hardware = null } = {}) {
  const npuPresent = !!(hardware && hardware.npu && hardware.npu.available === true);
  return (Array.isArray(models) ? models : []).filter((m) => {
    if (!isDownloadedModel(m) || modelVisible(m, { backends, hardware })) return false;
    const kind = backendOf(m);
    if (kind === 'npu' && !npuPresent) return false;
    if (kind === 'dual' && !npuPresent) return false;
    return true;
  });
}

/** 在当前可见且就绪的模型里挑一个默认；没有就返回空串。
 *  优先保留原来的选择，其次第一个“可创建初稿 + 就绪”的，最后第一个可见的。 */
export function pickVisibleModel(models, selectedId, ctx) {
  const vis = visibleModels(models, ctx);
  if (selectedId && vis.some(m => m.id === selectedId && (m.ready || m.cloud))) return selectedId;
  const ready = vis.find(m => m.ready && m.draftAllowed !== false)
    || vis.find(m => m.ready)
    || vis[0];
  return ready ? ready.id : '';
}
