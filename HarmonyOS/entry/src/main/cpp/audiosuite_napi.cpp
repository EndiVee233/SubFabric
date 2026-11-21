/*
 * HarmonyOS AudioSuite 人声降噪 NAPI。
 *
 * 为什么用原生层：AudioSuite 的降噪节点（EFFECT_NODE_TYPE_NOISE_REDUCTION）
 * 只开放 C API（libohaudiosuite.so），ArkTS 侧没有对应封装。
 *
 * 这里只做「离线 PCM 降噪」这一条最小管线：
 *   输入节点（16 kHz / S16LE / 单声道）
 *     -> 降噪节点（系统算法，固定输出 16 kHz / S16LE / 单声道）
 *     -> 输出节点（同格式）
 * 通过 OH_AudioSuiteEngine_RenderFrame 逐帧拉取处理后的 PCM。
 *
 * 节点/管线限制：
 *   · 引擎最多 10 条管线；这里每次调用创建一条，结束即销毁；
 *   · 降噪节点需要系统支持，调用前先 OH_AudioSuiteEngine_IsNodeTypeSupported；
 *   · 处理格式固定 16 kHz S16LE 单声道；调用方负责把媒体解码成这个格式。
 */

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <napi/native_api.h>
#include <hilog/log.h>

#include "ohaudiosuite/native_audio_suite_base.h"
#include "ohaudiosuite/native_audio_suite_engine.h"

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0x5B1F
#define LOG_TAG "AudioSuiteNapi"

#define LOGI(...) OH_LOG_INFO(LOG_APP, __VA_ARGS__)
#define LOGW(...) OH_LOG_WARN(LOG_APP, __VA_ARGS__)
#define LOGE(...) OH_LOG_ERROR(LOG_APP, __VA_ARGS__)

namespace {

constexpr int32_t SAMPLE_RATE = 16000;
constexpr int32_t BYTES_PER_SAMPLE = 2;
constexpr int32_t CHUNK_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE / 10; // 100 ms

struct InputCursor {
  const uint8_t* data = nullptr;
  size_t size = 0;
  size_t offset = 0;
};

struct SuiteHandles {
  OH_AudioSuiteEngine* engine = nullptr;
  OH_AudioSuitePipeline* pipeline = nullptr;
  OH_AudioNode* input = nullptr;
  OH_AudioNode* denoise = nullptr;
  OH_AudioNode* output = nullptr;
  OH_AudioNodeBuilder* builder = nullptr;
  bool started = false;
};

OH_AudioFormat Mono16kFormat() {
  OH_AudioFormat format;
  format.samplingRate = SAMPLE_RATE_16000;
  format.channelLayout = static_cast<OH_AudioChannelLayout>(CH_LAYOUT_MONO);
  format.channelCount = 1;
  format.encodingType = AUDIO_ENCODING_TYPE_RAW;
  format.sampleFormat = AUDIO_SAMPLE_S16LE;
  return format;
}

int32_t RequestInputData(OH_AudioNode* node, void* userData, void* audioData,
                         int32_t audioDataSize, bool* finished) {
  (void)node;
  auto* cursor = static_cast<InputCursor*>(userData);
  if (cursor == nullptr || audioData == nullptr || finished == nullptr ||
      audioDataSize <= 0) {
    if (finished != nullptr) {
      *finished = true;
    }
    return 0;
  }
  size_t remain = cursor->size > cursor->offset ? cursor->size - cursor->offset : 0;
  size_t count = std::min<size_t>(remain, static_cast<size_t>(audioDataSize));
  if (count > 0) {
    std::memcpy(audioData, cursor->data + cursor->offset, count);
    cursor->offset += count;
  }
  *finished = cursor->offset >= cursor->size;
  return static_cast<int32_t>(count);
}

void DestroySuite(SuiteHandles& handles) {
  if (handles.pipeline != nullptr && handles.started) {
    OH_AudioSuiteEngine_StopPipeline(handles.pipeline);
    handles.started = false;
  }
  if (handles.output != nullptr) {
    OH_AudioSuiteEngine_DestroyNode(handles.output);
    handles.output = nullptr;
  }
  if (handles.denoise != nullptr) {
    OH_AudioSuiteEngine_DestroyNode(handles.denoise);
    handles.denoise = nullptr;
  }
  if (handles.input != nullptr) {
    OH_AudioSuiteEngine_DestroyNode(handles.input);
    handles.input = nullptr;
  }
  if (handles.pipeline != nullptr) {
    OH_AudioSuiteEngine_DestroyPipeline(handles.pipeline);
    handles.pipeline = nullptr;
  }
  if (handles.engine != nullptr) {
    OH_AudioSuiteEngine_Destroy(handles.engine);
    handles.engine = nullptr;
  }
  if (handles.builder != nullptr) {
    OH_AudioSuiteNodeBuilder_Destroy(handles.builder);
    handles.builder = nullptr;
  }
}

bool Ensure(bool ok, const char* step, std::string& error) {
  if (!ok) {
    error = step;
  }
  return ok;
}

bool IsSupported() {
  bool supported = false;
  OH_AudioSuite_Result ret =
    OH_AudioSuiteEngine_IsNodeTypeSupported(EFFECT_NODE_TYPE_NOISE_REDUCTION, &supported);
  return ret == AUDIOSUITE_SUCCESS && supported;
}

bool DenoisePcm16k(const uint8_t* data, size_t size, std::vector<uint8_t>& output,
                   std::string& error) {
  if (data == nullptr || size == 0) {
    error = "empty input";
    return false;
  }
  if (size % BYTES_PER_SAMPLE != 0) {
    error = "input is not 16-bit PCM";
    return false;
  }
  if (!IsSupported()) {
    error = "noise reduction node unsupported";
    return false;
  }

  SuiteHandles h;
  InputCursor cursor;
  cursor.data = data;
  cursor.size = size;

  if (!Ensure(OH_AudioSuiteEngine_Create(&h.engine) == AUDIOSUITE_SUCCESS,
              "create engine", error)) {
    DestroySuite(h);
    return false;
  }
  if (!Ensure(OH_AudioSuiteEngine_CreatePipeline(h.engine, &h.pipeline,
                                                 AUDIOSUITE_PIPELINE_EDIT_MODE) ==
              AUDIOSUITE_SUCCESS, "create pipeline", error)) {
    DestroySuite(h);
    return false;
  }
  if (!Ensure(OH_AudioSuiteNodeBuilder_Create(&h.builder) == AUDIOSUITE_SUCCESS,
              "create builder", error)) {
    DestroySuite(h);
    return false;
  }

  OH_AudioFormat format = Mono16kFormat();

  if (!Ensure(OH_AudioSuiteNodeBuilder_SetNodeType(h.builder, INPUT_NODE_TYPE_DEFAULT) ==
              AUDIOSUITE_SUCCESS, "input node type", error) ||
      !Ensure(OH_AudioSuiteNodeBuilder_SetFormat(h.builder, format) == AUDIOSUITE_SUCCESS,
              "input format", error) ||
      !Ensure(OH_AudioSuiteNodeBuilder_SetRequestDataCallback(h.builder, RequestInputData,
                                                              &cursor) == AUDIOSUITE_SUCCESS,
              "input callback", error) ||
      !Ensure(OH_AudioSuiteEngine_CreateNode(h.pipeline, h.builder, &h.input) ==
              AUDIOSUITE_SUCCESS, "create input", error)) {
    DestroySuite(h);
    return false;
  }

  if (!Ensure(OH_AudioSuiteNodeBuilder_Reset(h.builder) == AUDIOSUITE_SUCCESS,
              "reset builder (denoise)", error) ||
      !Ensure(OH_AudioSuiteNodeBuilder_SetNodeType(h.builder,
                                                   EFFECT_NODE_TYPE_NOISE_REDUCTION) ==
              AUDIOSUITE_SUCCESS, "denoise node type", error) ||
      !Ensure(OH_AudioSuiteEngine_CreateNode(h.pipeline, h.builder, &h.denoise) ==
              AUDIOSUITE_SUCCESS, "create denoise", error)) {
    DestroySuite(h);
    return false;
  }

  if (!Ensure(OH_AudioSuiteNodeBuilder_Reset(h.builder) == AUDIOSUITE_SUCCESS,
              "reset builder (output)", error) ||
      !Ensure(OH_AudioSuiteNodeBuilder_SetNodeType(h.builder, OUTPUT_NODE_TYPE_DEFAULT) ==
              AUDIOSUITE_SUCCESS, "output node type", error) ||
      !Ensure(OH_AudioSuiteNodeBuilder_SetFormat(h.builder, format) == AUDIOSUITE_SUCCESS,
              "output format", error) ||
      !Ensure(OH_AudioSuiteEngine_CreateNode(h.pipeline, h.builder, &h.output) ==
              AUDIOSUITE_SUCCESS, "create output", error)) {
    DestroySuite(h);
    return false;
  }

  if (!Ensure(OH_AudioSuiteEngine_ConnectNodes(h.input, h.denoise) == AUDIOSUITE_SUCCESS,
              "connect input -> denoise", error) ||
      !Ensure(OH_AudioSuiteEngine_ConnectNodes(h.denoise, h.output) == AUDIOSUITE_SUCCESS,
              "connect denoise -> output", error) ||
      !Ensure(OH_AudioSuiteEngine_StartPipeline(h.pipeline) == AUDIOSUITE_SUCCESS,
              "start pipeline", error)) {
    DestroySuite(h);
    return false;
  }
  h.started = true;

  std::vector<uint8_t> chunk(CHUNK_BYTES);
  bool finished = false;
  int32_t maxFrames = static_cast<int32_t>(size / CHUNK_BYTES) + 64;
  for (int32_t i = 0; i < maxFrames && !finished; ++i) {
    int32_t response = 0;
    OH_AudioSuite_Result ret = OH_AudioSuiteEngine_RenderFrame(
      h.pipeline, chunk.data(), CHUNK_BYTES, &response, &finished);
    if (ret != AUDIOSUITE_SUCCESS) {
      error = "render frame failed: " + std::to_string(static_cast<int>(ret));
      DestroySuite(h);
      return false;
    }
    if (response > 0) {
      int32_t safe = std::min(response, CHUNK_BYTES);
      output.insert(output.end(), chunk.begin(), chunk.begin() + safe);
    }
    if (response == 0 && !finished && cursor.offset >= cursor.size) {
      // 输入已经喂完但仍未标记结束：再拉一帧，避免死循环。
      continue;
    }
  }

  DestroySuite(h);
  if (output.empty()) {
    error = "denoise produced no data";
    return false;
  }
  return true;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out = nullptr;
  napi_get_boolean(env, value, &out);
  return out;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.size(), &out);
  return out;
}

napi_value MakeBuffer(napi_env env, const std::vector<uint8_t>& bytes) {
  void* data = nullptr;
  napi_value out = nullptr;
  if (napi_create_arraybuffer(env, bytes.size(), &data, &out) != napi_ok) {
    return nullptr;
  }
  if (!bytes.empty() && data != nullptr) {
    std::memcpy(data, bytes.data(), bytes.size());
  }
  return out;
}

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

napi_value NapiIsSupported(napi_env env, napi_callback_info info) {
  (void)info;
  return MakeBool(env, IsSupported());
}

napi_value NapiDenoise(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "denoisePcm16k expects an ArrayBuffer");
    return nullptr;
  }

  void* input = nullptr;
  size_t inputSize = 0;
  if (napi_get_arraybuffer_info(env, args[0], &input, &inputSize) != napi_ok) {
    Throw(env, "input is not an ArrayBuffer");
    return nullptr;
  }
  if (input == nullptr || inputSize == 0) {
    Throw(env, "input is empty");
    return nullptr;
  }

  std::vector<uint8_t> output;
  std::string error;
  if (!DenoisePcm16k(static_cast<const uint8_t*>(input), inputSize, output, error)) {
    LOGE("denoise failed: %{public}s", error.c_str());
    Throw(env, error);
    return nullptr;
  }
  LOGI("denoise done: %{public}zu -> %{public}zu bytes", inputSize, output.size());
  return MakeBuffer(env, output);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"isNoiseReductionSupported", nullptr, NapiIsSupported, nullptr, nullptr, nullptr,
     napi_default, nullptr},
    {"denoisePcm16k", nullptr, NapiDenoise, nullptr, nullptr, nullptr,
     napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

napi_module g_audioSuiteModule = {
  1,
  0,
  nullptr,
  Init,
  "mediakit",
  nullptr,
  {0},
};

extern "C" __attribute__((constructor)) void RegisterAudioSuiteModule() {
  napi_module_register(&g_audioSuiteModule);
}

} // namespace
