#include <cstdio>
#include <cstring>
#include <string>
#include <memory>

#include <napi/native_api.h>
#include "ggml-vulkan.h"
#include "parakeet.h"
#include "qwen3_asr.h"

namespace {

struct Handle {
  int kind = 0;
  parakeet_context *parakeet = nullptr;
  qwen3_asr_context *qwen = nullptr;
};

napi_value Probe(napi_env env, napi_callback_info) {
  const int count = ggml_backend_vk_get_device_count();
  napi_value result = nullptr;
  napi_create_object(env, &result);

  napi_value available = nullptr;
  napi_get_boolean(env, count > 0, &available);
  napi_set_named_property(env, result, "available", available);

  napi_value countValue = nullptr;
  napi_create_int32(env, count, &countValue);
  napi_set_named_property(env, result, "deviceCount", countValue);

  char description[256] = {};
  if (count > 0) {
    ggml_backend_vk_get_device_description(0, description, sizeof(description));
  }
  napi_value name = nullptr;
  napi_create_string_utf8(env, description, NAPI_AUTO_LENGTH, &name);
  napi_set_named_property(env, result, "deviceName", name);
  return result;
}

std::string StringArg(napi_env env, napi_value value) {
  size_t len = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  std::string out(len, '\0');
  napi_get_value_string_utf8(env, value, out.data(), len + 1, &len);
  return out;
}

napi_value Load(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) {
    napi_throw_error(env, nullptr, "load(kind, path) requires two arguments");
    return nullptr;
  }
  int32_t kind = 0;
  napi_get_value_int32(env, argv[0], &kind);
  const std::string path = StringArg(env, argv[1]);
  auto *handle = new Handle();
  handle->kind = kind;
  if (kind == 1) {
    auto params = parakeet_context_default_params();
    params.use_gpu = true;
    params.use_flash = false;
    handle->parakeet = parakeet_init_from_file(path.c_str(), params);
  } else if (kind == 2 || kind == 3) {
    auto params = qwen3_asr_context_default_params();
    params.use_gpu = true;
    params.flash_attn = false;
    handle->qwen = qwen3_asr_init_from_file(path.c_str(), params);
  }
  if ((kind == 1 && handle->parakeet == nullptr)
      || ((kind == 2 || kind == 3) && handle->qwen == nullptr)) {
    delete handle;
    napi_throw_error(env, nullptr, "Vulkan model load failed");
    return nullptr;
  }
  napi_value out = nullptr;
  napi_create_bigint_uint64(env, reinterpret_cast<uintptr_t>(handle), &out);
  return out;
}

napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t raw = 0;
  bool lossless = false;
  napi_get_value_bigint_uint64(env, argv[0], &raw, &lossless);
  auto *handle = reinterpret_cast<Handle *>(static_cast<uintptr_t>(raw));
  if (handle != nullptr) {
    if (handle->parakeet != nullptr) {
      parakeet_free(handle->parakeet);
    }
    if (handle->qwen != nullptr) {
      qwen3_asr_free(handle->qwen);
    }
    delete handle;
  }
  napi_value ok = nullptr;
  napi_get_boolean(env, true, &ok);
  return ok;
}

napi_value Transcribe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) {
    napi_throw_error(env, nullptr, "transcribe(handle, pcm, offsetCs) requires at least two arguments");
    return nullptr;
  }
  uint64_t raw = 0;
  bool lossless = false;
  napi_get_value_bigint_uint64(env, argv[0], &raw, &lossless);
  auto *handle = reinterpret_cast<Handle *>(static_cast<uintptr_t>(raw));
  if (handle == nullptr || handle->parakeet == nullptr) {
    napi_throw_error(env, nullptr, "transcribe requires a loaded Parakeet Vulkan handle");
    return nullptr;
  }

  void *data = nullptr;
  size_t length = 0;
  napi_status bufferStatus = napi_get_arraybuffer_info(env, argv[1], &data, &length);
  if (bufferStatus != napi_ok) {
    napi_typedarray_type type = napi_float32_array;
    size_t elementCount = 0;
    napi_value arrayBuffer = nullptr;
    size_t byteOffset = 0;
    if (napi_get_typedarray_info(env, argv[1], &type, &elementCount,
                                 &data, &arrayBuffer, &byteOffset) != napi_ok
        || type != napi_float32_array) {
      data = nullptr;
      elementCount = 0;
    }
    length = elementCount * sizeof(float);
  }
  if (data == nullptr || length == 0) {
    napi_throw_error(env, nullptr, "transcribe requires a non-empty Float32Array");
    return nullptr;
  }
  int64_t offsetCs = 0;
  if (argc >= 3) {
    napi_get_value_int64(env, argv[2], &offsetCs);
  }
  const int sampleCount = static_cast<int>(length / sizeof(float));
  auto *result = parakeet_transcribe_ex(handle->parakeet,
      static_cast<const float *>(data), sampleCount, offsetCs);
  if (result == nullptr) {
    napi_throw_error(env, nullptr, "Vulkan Parakeet transcription failed");
    return nullptr;
  }

  napi_value out = nullptr;
  napi_create_object(env, &out);
  const char *text = parakeet_result_text(result);
  napi_value textValue = nullptr;
  napi_create_string_utf8(env, text != nullptr ? text : "", NAPI_AUTO_LENGTH, &textValue);
  napi_set_named_property(env, out, "text", textValue);

  const int count = parakeet_result_n_words(result);
  napi_value words = nullptr;
  napi_create_array_with_length(env, count > 0 ? static_cast<size_t>(count) : 0, &words);
  for (int i = 0; i < count; ++i) {
    napi_value word = nullptr;
    napi_create_object(env, &word);
    const char *wordText = parakeet_result_word_text(result, i);
    napi_value wordValue = nullptr;
    napi_create_string_utf8(env, wordText != nullptr ? wordText : "", NAPI_AUTO_LENGTH, &wordValue);
    napi_set_named_property(env, word, "text", wordValue);
    napi_value start = nullptr;
    napi_value end = nullptr;
    napi_create_double(env, static_cast<double>(parakeet_result_word_t0(result, i)) / 100.0, &start);
    napi_create_double(env, static_cast<double>(parakeet_result_word_t1(result, i)) / 100.0, &end);
    napi_set_named_property(env, word, "start", start);
    napi_set_named_property(env, word, "end", end);
    napi_value confidence = nullptr;
    napi_create_double(env, 1.0, &confidence);
    napi_set_named_property(env, word, "confidence", confidence);
    napi_set_element(env, words, static_cast<uint32_t>(i), word);
  }
  napi_set_named_property(env, out, "words", words);
  parakeet_result_free(result);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"probe", nullptr, Probe, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"load", nullptr, Load, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"transcribe", nullptr, Transcribe, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, desc);
  return exports;
}

napi_module g_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "vulkanprobe",
    .nm_priv = nullptr,
    .reserved = {nullptr, nullptr, nullptr, nullptr},
};

}  // namespace

extern "C" __attribute__((constructor)) void RegisterVulkanProbeModule(void) {
  napi_module_register(&g_module);
}
