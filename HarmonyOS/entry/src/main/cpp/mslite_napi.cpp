/*
 * MindSpore Lite NAPI 妗ユ 鈥斺€?缁曞紑 ArkTS 缁戝畾鍦?NNRt 鍚庣鐨勯檺鍒躲€? *
 * ===================== 涓轰粈涔堥渶瑕佽繖涓€灞?=====================
 *
 * ArkTS 渚х殑 `@ohos.ai.mindSporeLite` 鏈変竴涓疄娴嬪埌鐨勭‖闄愬埗锛? * **target = 'nnrt'锛圢PU锛夋椂 `model.getInputs()` 杩斿洖 undefined**锛? * 鑰岀洰鏍囧紶閲忔槸 `predict()` 鐨勫繀闇€鍏ュ弬锛汣PU 鍚庣鍒欐甯搞€? * 缁撴灉鏄蛋 ArkTS 灏卞彧鑳藉湪 CPU 涓婃帹鐞?鈥斺€?涓?蹇呴』鐢?NPU"鐨勮姹傚啿绐併€? *
 * 瀹樻柟 C API锛坄libmindspore_lite_ndk.so`锛夋病鏈夎繖涓檺鍒讹細
 *   - `OH_AI_ModelGetInputByTensorName()`  **鎸夊悕瀛楃洿鎺ュ彇寮犻噺**锛? *     姣旀暟缁勫紡鐨?GetInputs 鏇寸ǔ鍋ワ紱
 *   - `OH_AI_DeviceInfoCreate(OH_AI_DEVICETYPE_NNRT)` + `SetDeviceId`
 *     鍙互绮剧‘鎸囧畾 NPU 璁惧锛? *   - `OH_AI_ModelGetOutputs()` 鍙互鐩存帴鎷垮埌杈撳嚭寮犻噺銆? *
 * 鏈枃浠剁殑 API 鐢ㄦ硶鍧囧鐓?SDK 澶存枃浠舵牳瀹炶繃锛堣矾寰勮 CMakeLists锛夛細
 *   sysroot/usr/include/mindspore/{context,model,tensor,types,status}.h
 *
 * ===================== 璁捐瑕佺偣 =====================
 *
 * 1. **寮哄埗 NPU**锛氭灇涓句笉鍒?NNRt 璁惧灏辩洿鎺ユ姏閿欙紝缁濅笉闈欓粯闄嶇骇锛? *    涓婂眰 ArkTS 涔熶笉鍋?CPU 鍏滃簳銆? * 2. **鎸夊悕瀛楀彇寮犻噺**锛屼笉渚濊禆椤哄簭銆? * 3. **杈撳嚭鐨?ArrayBuffer 鏄嫹璐?*锛歚OH_AI_TensorGetData` 杩斿洖鐨勬槸
 *    妯″瀷鍐呴儴缂撳啿鎸囬拡锛屼笅涓€娆?predict 浼氳瑕嗙洊锛岀洿鎺ュ寘 external
 *    buffer 鏈夌敓鍛藉懆鏈熼櫡闃便€俥ncoder 杈撳嚭鎵?385 KB锛屾嫹璐濇垚鏈彲蹇界暐銆? * 4. **涓嶅湪姝ゅ眰鍋氭暟鍊艰浆鎹?*锛氭暣鍨?娴偣鍖哄垎浜ょ粰 ArkTS锛岃繖閲屽瀹炰笂鎶? *    dtype/shape/dataSize銆? */

#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <napi/native_api.h>
#include <hilog/log.h>

#include "mindspore/model.h"
#include "mindspore/context.h"
#include "mindspore/tensor.h"
#include "mindspore/types.h"
#include "mindspore/status.h"

#undef LOG_DOMAIN
#undef LOG_TAG
#define LOG_DOMAIN 0x5B1F
#define LOG_TAG "MsLiteNapi"

#define LOGI(...) OH_LOG_INFO(LOG_APP, __VA_ARGS__)
#define LOGW(...) OH_LOG_WARN(LOG_APP, __VA_ARGS__)
#define LOGE(...) OH_LOG_ERROR(LOG_APP, __VA_ARGS__)

namespace {

// ---------------------------------------------------------------- 鍙ユ焺琛?//
// NAPI 涓嶈兘鎶婅８鎸囬拡浜ょ粰 ArkTS锛堜細鍙樻垚涓嶉€忔槑涓旀槗璇敤锛夛紝
// 鐢ㄨ嚜澧?id 鏄犲皠鍒?C++ 瀵硅薄銆?
struct ModelEntry {
  OH_AI_ModelHandle model = nullptr;
  std::map<std::string, OH_AI_TensorHandle> inputs;
  std::vector<std::string> inputNames;
};

std::map<int32_t, ModelEntry *> g_models;
int32_t g_nextId = 1;

ModelEntry *GetModel(int32_t id) {
  auto it = g_models.find(id);
  return it == g_models.end() ? nullptr : it->second;
}

// ---------------------------------------------------------------- 宸ュ叿

std::string ArgString(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) {
    return std::string();
  }
  std::string s(len, '\0');
  size_t copied = 0;
  napi_get_value_string_utf8(env, v, &s[0], len + 1, &copied);
  s.resize(copied);
  return s;
}

napi_value MakeInt(napi_env env, int32_t v) {
  napi_value out = nullptr;
  napi_create_int32(env, v, &out);
  return out;
}

napi_value MakeBool(napi_env env, bool v) {
  napi_value out = nullptr;
  napi_get_boolean(env, v, &out);
  return out;
}

napi_value MakeNull(napi_env env) {
  napi_value out = nullptr;
  napi_get_null(env, &out);
  return out;
}

napi_value MakeString(napi_env env, const std::string &s) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, s.c_str(), s.size(), &out);
  return out;
}

napi_value Throw(napi_env env, const std::string &msg) {
  LOGE("%{public}s", msg.c_str());
  napi_throw_error(env, nullptr, msg.c_str());
  return nullptr;
}

/** 鎶?OH_AI_Status 杞垚鍙鏂囨湰锛屼究浜庡畾浣嶅け璐ュ師鍥犮€?*/
std::string StatusText(OH_AI_Status st) {
  switch (st) {
    case OH_AI_STATUS_SUCCESS:
      return "SUCCESS";
    case OH_AI_STATUS_LITE_NULLPTR:
      return "NULLPTR";
    case OH_AI_STATUS_LITE_PARAM_INVALID:
      return "PARAM_INVALID";
    case OH_AI_STATUS_LITE_MEMORY_FAILED:
      return "MEMORY_FAILED";
    case OH_AI_STATUS_LITE_NOT_SUPPORT:
      return "NOT_SUPPORT";
    case OH_AI_STATUS_LITE_GRAPH_FILE_ERROR:
      return "GRAPH_FILE_ERROR";
    case OH_AI_STATUS_LITE_NOT_FIND_OP:
      return "NOT_FIND_OP";
    case OH_AI_STATUS_LITE_INVALID_OP_NAME:
      return "INVALID_OP_NAME";
    case OH_AI_STATUS_LITE_INVALID_OP_ATTR:
      return "INVALID_OP_ATTR";
    case OH_AI_STATUS_LITE_OP_EXECUTE_FAILURE:
      return "OP_EXECUTE_FAILURE";
    case OH_AI_STATUS_LITE_INFER_ERROR:
      return "INFER_ERROR";
    case OH_AI_STATUS_LITE_INFER_INVALID:
      return "INFER_INVALID";
    case OH_AI_STATUS_LITE_INPUT_TENSOR_ERROR:
      return "INPUT_TENSOR_ERROR";
    case OH_AI_STATUS_LITE_OUT_OF_TENSOR_RANGE:
      return "OUT_OF_TENSOR_RANGE";
    default:
      return "status=" + std::to_string(static_cast<int32_t>(st));
  }
}

// ---------------------------------------------------------------- context

/**
 * 鍒涘缓鎺ㄧ悊涓婁笅鏂囷紙寮哄埗 NNRt锛夈€? *
 * @param threads CPU 绾跨▼鏁帮紙NPU 鍥句笂涓嶇敓鏁堬紝浣?joint 瀛愬浘閲屽彲鑳? *                鏈夊洖钀藉埌 CPU 鐨勭畻瀛愶紝浠嶈涓€涓嬶級
 * @returns 涓婁笅鏂囧彞鏌勶紙bigint锛屽唴閮ㄦ槸鎸囬拡鍊硷級
 *
 * 澶辫触锛堟棤 NPU / 鍒涘缓澶辫触锛夌洿鎺ユ姏寮傚父锛屼笉鍋?CPU 闄嶇骇銆? */
napi_value CreateContext(napi_env env, napi_callback_info info) {
  // 鈽?鐗堟湰鏍囪锛氱敤浜庣‘璁ゆ墜鏈轰笂璺戠殑 .so 鏄笉鏄渶鏂版瀯寤恒€?  // 鍘熺敓搴撴洿鏂板悗蹇呴』閲嶈 HAP 鎵嶇敓鏁堬紝鏀逛唬鐮佷絾娌￠噸瑁呬細鍑虹幇
  LOGI("=== MsLiteNapi BUILD=7 (official-nnrt-by-type) ===");

  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  int32_t threads = 4;
  if (argc >= 1) {
    napi_get_value_int32(env, args[0], &threads);
  }

  // ---- 鏋氫妇 NPU 璁惧
  //
  // 鈿狅笍 蹇呴』鎸戝璁惧锛佺湡鏈猴紙Kirin 9020锛夋灇涓惧埌 **涓や釜** NNRt 璁惧锛?  //     [0] id=10528977252980073605  name=NPU_ohos.boot.hardware.kirin9020_v2_0
  //     [1] id=8987859593747354028   name=HIAI_F        <<< 鐪熸鐨?NPU
  // 鍙栫 0 涓細澶辫触鍦?MindSpore Lite 鐨?CheckNPUPrefix锛?  //     "current device name prefix is not HIAI_F"
  //     鈫?NNRt: Authentication failed, input model cannot run by npu
  size_t descNum = 0;
  NNRTDeviceDesc *descs = OH_AI_GetAllNNRTDeviceDescs(&descNum);
  if (descs == nullptr || descNum == 0) {
    if (descs != nullptr) {
      OH_AI_DestroyAllNNRTDeviceDescs(&descs);
    }
    return Throw(env, "NNRt device not found");
  }


  const char *chosenName = nullptr;
  // 绗竴浼樺厛锛氬悕瀛楀墠缂€鏄?HIAI_F 鐨勶紙MindSpore Lite 璁よ繖涓級
  for (size_t i = 0; i < descNum; ++i) {
    NNRTDeviceDesc *d = OH_AI_GetElementOfNNRTDeviceDescs(descs, i);
    if (d == nullptr) {
      continue;
    }
    const char *nm = OH_AI_GetNameFromNNRTDeviceDesc(d);
    LOGI("NNRt 璁惧[%{public}zu]锛歯ame=%{public}s id=%{public}zu type=%{public}d",
         i, nm != nullptr ? nm : "?", OH_AI_GetDeviceIdFromNNRTDeviceDesc(d),
         static_cast<int>(OH_AI_GetTypeFromNNRTDeviceDesc(d)));
    if (chosenName == nullptr && nm != nullptr && strncmp(nm, "HIAI_F", 6) == 0) {
      chosenName = nm;
    }
  }
  // 绗簩浼樺厛锛氬姞閫熷櫒绫诲瀷
  if (chosenName == nullptr) {
    for (size_t i = 0; i < descNum; ++i) {
      NNRTDeviceDesc *d = OH_AI_GetElementOfNNRTDeviceDescs(descs, i);
      if (d == nullptr) {
        continue;
      }
      if (OH_AI_GetTypeFromNNRTDeviceDesc(d) == OH_AI_NNRTDEVICE_ACCELERATOR) {
        chosenName = OH_AI_GetNameFromNNRTDeviceDesc(d);
        break;
      }
    }
  }
  if (chosenName == nullptr) {
    chosenName = OH_AI_GetNameFromNNRTDeviceDesc(descs);
  }

  std::string devNameStr = chosenName != nullptr ? chosenName : "";
  const size_t devId = OH_AI_GetDeviceIdFromNNRTDeviceDesc(descs);
  OH_AI_DestroyAllNNRTDeviceDescs(&descs);

  if (devNameStr.empty()) {
    return Throw(env, "NNRt 璁惧鍚嶄负绌猴紝鏃犳硶鍒涘缓璁惧淇℃伅");
  }
  LOGI("selected NNRt device %{public}s", devNameStr.c_str());

  // ---- 寤轰笂涓嬫枃
  OH_AI_ContextHandle ctx = OH_AI_ContextCreate();
  if (ctx == nullptr) {
    return Throw(env, "OH_AI_ContextCreate 澶辫触");
  }
  OH_AI_ContextSetThreadNum(ctx, threads);
  OH_AI_ContextSetEnableParallel(ctx, false);

  // 瀹樻柟 NNRt 鎺ㄨ崘璺緞锛氭寜鍔犻€熷櫒绫诲瀷鍒涘缓璁惧淇℃伅锛屼笉鎵嬪伐鏀瑰啓
  // provider/providerDevice銆傛墜宸ユ敞鍏ヨ澶囧悕绉颁細璁╂棫鐗?NNRt 璧板埌
  OH_AI_DeviceInfoHandle npuInfo =
      OH_AI_CreateNNRTDeviceInfoByType(OH_AI_NNRTDEVICE_ACCELERATOR);

  if (npuInfo == nullptr) {
    OH_AI_ContextDestroy(&ctx);
    return Throw(env, "failed to create NNRt device info");
  }

  // 鎵撳嵃瀹為檯鍐欒繘鍘荤殑鍊?鈥斺€?杩欐槸鍒ゆ柇 provider 瀛楁鏈夋病鏈夌敓鏁堢殑鍏抽敭
  const char *gotProvider = OH_AI_DeviceInfoGetProvider(npuInfo);
  const char *gotDev = OH_AI_DeviceInfoGetProviderDevice(npuInfo);
  LOGI("璁惧淇℃伅鏍稿锛歱rovider=%{public}s providerDevice=%{public}s devType=%{public}d",
       gotProvider != nullptr ? gotProvider : "(null)",
       gotDev != nullptr ? gotDev : "(null)",
       static_cast<int>(OH_AI_DeviceInfoGetDeviceType(npuInfo)));

  OH_AI_DeviceInfoSetPerformanceMode(npuInfo, OH_AI_PERFORMANCE_HIGH);
  OH_AI_DeviceInfoSetPriority(npuInfo, OH_AI_PRIORITY_HIGH);
  OH_AI_ContextAddDeviceInfo(ctx, npuInfo);

  // NNRt 鍙鐩栫‖浠舵敮鎸佺殑绠楀瓙銆傚姞鍏?CPU 璁惧鍚庯紝MindSpore Lite
  OH_AI_DeviceInfoHandle cpuInfo = OH_AI_DeviceInfoCreate(OH_AI_DEVICETYPE_CPU);
  if (cpuInfo != nullptr) {
    OH_AI_ContextAddDeviceInfo(ctx, cpuInfo);
  }

  LOGI("NNRt context created device=%{public}s threads=%{public}d",
       devNameStr.c_str(), threads);

  napi_value out = nullptr;
  napi_create_bigint_uint64(
      env, static_cast<uint64_t>(reinterpret_cast<uintptr_t>(ctx)), &out);
  return out;
}

napi_value DestroyContext(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) {
    return MakeBool(env, false);
  }
  uint64_t raw = 0;
  bool lossless = false;
  napi_get_value_bigint_uint64(env, args[0], &raw, &lossless);
  OH_AI_ContextHandle ctx =
      reinterpret_cast<OH_AI_ContextHandle>(static_cast<uintptr_t>(raw));
  if (ctx != nullptr) {
    OH_AI_ContextDestroy(&ctx);
  }
  return MakeBool(env, true);
}

// ---------------------------------------------------------------- model

/**
 * 浠庢枃浠舵瀯寤烘ā鍨嬨€? *
 * @param ctxRaw      createContext 鐨勮繑鍥炲€? * @param path        娌欑鍐?.ms 鐨勭粷瀵硅矾寰? * @returns 妯″瀷 id锛? 0锛? */
napi_value LoadModel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    return Throw(env, "loadModel 闇€瑕?(context, path)");
  }

  uint64_t raw = 0;
  bool lossless = false;
  napi_get_value_bigint_uint64(env, args[0], &raw, &lossless);
  OH_AI_ContextHandle ctx =
      reinterpret_cast<OH_AI_ContextHandle>(static_cast<uintptr_t>(raw));
  if (ctx == nullptr) {
    return Throw(env, "loadModel: context 涓虹┖");
  }
  std::string path = ArgString(env, args[1]);
  if (path.empty()) {
    return Throw(env, "loadModel: path 涓虹┖");
  }

  OH_AI_ModelHandle model = OH_AI_ModelCreate();
  if (model == nullptr) {
    return Throw(env, "OH_AI_ModelCreate 澶辫触");
  }

  OH_AI_Status st = OH_AI_ModelBuildFromFile(
      model, path.c_str(), OH_AI_MODELTYPE_MINDIR, ctx);
  if (st != OH_AI_STATUS_SUCCESS) {
    OH_AI_ModelDestroy(&model);
    return Throw(env, "model build failed: " + StatusText(st) + " path=" + path);
  }


  auto *entry = new ModelEntry();
  entry->model = model;

  OH_AI_TensorHandleArray ins = OH_AI_ModelGetInputs(model);
  for (size_t i = 0; i < ins.handle_num; ++i) {
    const char *nm = OH_AI_TensorGetName(ins.handle_list[i]);
    if (nm == nullptr) {
      continue;
    }
    entry->inputs[nm] = ins.handle_list[i];
    entry->inputNames.push_back(nm);
  }
  if (entry->inputNames.empty()) {
    LOGI("GetInputs 涓虹┖锛屾敼鐢?GetInputByTensorName 閫愪釜鎺㈡祴");
    const char *cand[] = {"audio_signal", "length",
                          "encoder_outputs", "targets", "target_length",
                          "input_states_1", "input_states_2"};
    for (const char *c : cand) {
      OH_AI_TensorHandle t = OH_AI_ModelGetInputByTensorName(model, c);
      if (t != nullptr) {
        entry->inputs[c] = t;
        entry->inputNames.push_back(c);
      }
    }
  }

  // 杈撳嚭寮犻噺涔熷垪涓€涓嬶紝渚夸簬纭濂戠害
  OH_AI_TensorHandleArray outs = OH_AI_ModelGetOutputs(model);

  LOGI("model ready %{public}s inputs=%{public}zu outputs=%{public}zu",
       path.c_str(), entry->inputNames.size(), outs.handle_num);
  for (const auto &n : entry->inputNames) {
    LOGI("  IN  %{public}s", n.c_str());
  }
  for (size_t i = 0; i < outs.handle_num; ++i) {
    const char *nm = OH_AI_TensorGetName(outs.handle_list[i]);
    LOGI("  OUT %{public}s (%{public}zu B)", nm != nullptr ? nm : "?",
         OH_AI_TensorGetDataSize(outs.handle_list[i]));
  }

  int32_t id = g_nextId++;
  g_models[id] = entry;
  return MakeInt(env, id);
}

napi_value DestroyModel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t id = 0;
  if (argc >= 1) {
    napi_get_value_int32(env, args[0], &id);
  }
  auto it = g_models.find(id);
  if (it != g_models.end()) {
    if (it->second->model != nullptr) {
      OH_AI_ModelDestroy(&it->second->model);
    }
    delete it->second;
    g_models.erase(it);
  }
  return MakeBool(env, true);
}

napi_value GetInputNames(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t id = 0;
  if (argc >= 1) {
    napi_get_value_int32(env, args[0], &id);
  }
  ModelEntry *e = GetModel(id);
  if (e == nullptr) {
    return Throw(env, "getInputNames: model not found");
  }
  napi_value arr = nullptr;
  napi_create_array_with_length(env, e->inputNames.size(), &arr);
  for (size_t i = 0; i < e->inputNames.size(); ++i) {
    napi_set_element(env, arr, static_cast<uint32_t>(i),
                     MakeString(env, e->inputNames[i]));
  }
  return arr;
}

/** 鍙栧紶閲忓厓淇℃伅锛涙壘涓嶅埌杩斿洖 null銆?*/
napi_value GetTensorInfo(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3] = {nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    return Throw(env, "getTensorInfo 闇€瑕?(modelId, name, isInput)");
  }
  int32_t id = 0;
  napi_get_value_int32(env, args[0], &id);
  std::string name = ArgString(env, args[1]);
  bool isInput = false;
  napi_get_value_bool(env, args[2], &isInput);

  ModelEntry *e = GetModel(id);
  if (e == nullptr) {
    return Throw(env, "getTensorInfo: model not found");
  }
  OH_AI_TensorHandle t = isInput
      ? OH_AI_ModelGetInputByTensorName(e->model, name.c_str())
      : OH_AI_ModelGetOutputByTensorName(e->model, name.c_str());
  if (t == nullptr) {
    return MakeNull(env);
  }

  napi_value obj = nullptr;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "name", MakeString(env, name));
  napi_set_named_property(
      env, obj, "dtype",
      MakeInt(env, static_cast<int32_t>(OH_AI_TensorGetDataType(t))));
  napi_set_named_property(
      env, obj, "dataSize",
      MakeInt(env, static_cast<int32_t>(OH_AI_TensorGetDataSize(t))));
  napi_set_named_property(
      env, obj, "elementNum",
      MakeInt(env, static_cast<int32_t>(OH_AI_TensorGetElementNum(t))));

  size_t rank = 0;
  const int64_t *dims = OH_AI_TensorGetShape(t, &rank);
  napi_value shape = nullptr;
  napi_create_array_with_length(env, rank, &shape);
  if (dims != nullptr) {
    for (size_t i = 0; i < rank; ++i) {
      napi_value d = nullptr;
      napi_create_int64(env, dims[i], &d);
      napi_set_element(env, shape, static_cast<uint32_t>(i), d);
    }
  }
  napi_set_named_property(env, obj, "shape", shape);

  char buf[64];
  snprintf(buf, sizeof(buf), "%d",
           static_cast<int32_t>(OH_AI_TensorGetDataType(t)));
  napi_set_named_property(env, obj, "dtypeName", MakeString(env, buf));
  return obj;
}

/**
 * 鎸夊悕瀛楀啓鍏ヨ緭鍏ユ暟鎹€? * data 蹇呴』鏄暱搴︽伆濂界瓑浜庤寮犻噺 dataSize 鐨?ArrayBuffer銆? */
napi_value SetInputData(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3] = {nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    return Throw(env, "setInputData 闇€瑕?(modelId, name, arrayBuffer)");
  }
  int32_t id = 0;
  napi_get_value_int32(env, args[0], &id);
  std::string name = ArgString(env, args[1]);

  ModelEntry *e = GetModel(id);
  if (e == nullptr) {
    return Throw(env, "setInputData: model not found");
  }
  OH_AI_TensorHandle t = nullptr;
  auto it = e->inputs.find(name);
  if (it != e->inputs.end()) {
    t = it->second;
  } else {
    t = OH_AI_ModelGetInputByTensorName(e->model, name.c_str());
  }
  if (t == nullptr) {
    return Throw(env, "setInputData: 鎵句笉鍒拌緭鍏ュ紶閲?" + name);
  }

  void *data = nullptr;
  size_t len = 0;
  if (napi_get_arraybuffer_info(env, args[2], &data, &len) != napi_ok) {
    return Throw(env, "setInputData: 绗?3 涓弬鏁颁笉鏄?ArrayBuffer");
  }
  size_t need = OH_AI_TensorGetDataSize(t);
  if (len != need) {
    return Throw(env, "setInputData: size mismatch");

  }
  OH_AI_TensorSetData(t, data);
  return MakeBool(env, true);
}

/** 鎵ц涓€娆℃帹鐞嗐€?*/
napi_value Predict(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t id = 0;
  if (argc >= 1) {
    napi_get_value_int32(env, args[0], &id);
  }
  ModelEntry *e = GetModel(id);
  if (e == nullptr) {
    return Throw(env, "predict: model not found");
  }
  // NNRt may return an empty array from ModelGetInputs even though the
  // named handles were discovered during load. Rebuild the input array from
  // the handles cached by name so native prediction does not depend on the
  // ArkTS binding's empty-array behavior.
  std::vector<OH_AI_TensorHandle> inputList;
  inputList.reserve(e->inputNames.size());
  for (const auto &name : e->inputNames) {
    auto it = e->inputs.find(name);
    if (it != e->inputs.end() && it->second != nullptr) {
      inputList.push_back(it->second);
    }
  }
  OH_AI_TensorHandleArray ins{
      inputList.size(), inputList.empty() ? nullptr : inputList.data()};
  if (ins.handle_num == 0) {
    return Throw(env, "predict: no input tensors");
  }
  OH_AI_TensorHandleArray outs = OH_AI_ModelGetOutputs(e->model);
  // 瀹屾暣绛惧悕鏄?5 涓弬鏁帮細model, inputs, *outputs, before, after
  OH_AI_Status st = OH_AI_ModelPredict(e->model, ins, &outs, nullptr, nullptr);
  if (st != OH_AI_STATUS_SUCCESS) {
    return Throw(env, "predict failed: " + StatusText(st));
  }
  return MakeBool(env, true);
}

/** 鍙栬緭鍑哄紶閲忔暟鎹紙杩斿洖鎷疯礉锛夈€傛壘涓嶅埌鍚屽悕杈撳嚭杩斿洖 null銆?*/
napi_value GetOutputData(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    return Throw(env, "getOutputData 闇€瑕?(modelId, name)");
  }
  int32_t id = 0;
  napi_get_value_int32(env, args[0], &id);
  std::string name = ArgString(env, args[1]);

  ModelEntry *e = GetModel(id);
  if (e == nullptr) {
    return Throw(env, "getOutputData: model not found");
  }
  OH_AI_TensorHandle t =
      OH_AI_ModelGetOutputByTensorName(e->model, name.c_str());
  if (t == nullptr) {
    return MakeNull(env);
  }
  size_t size = OH_AI_TensorGetDataSize(t);
  const void *src = OH_AI_TensorGetData(t);
  if (src == nullptr || size == 0) {
    return Throw(env, "getOutputData: no data");
  }
  void *dst = nullptr;
  napi_value buf = nullptr;
  if (napi_create_arraybuffer(env, size, &dst, &buf) != napi_ok) {
    return Throw(env, "getOutputData: 鍒嗛厤 ArrayBuffer 澶辫触");
  }
  std::memcpy(dst, src, size);
  return buf;
}

// ---------------------------------------------------------------- 娉ㄥ唽

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"createContext", nullptr, CreateContext, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroyContext", nullptr, DestroyContext, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"loadModel", nullptr, LoadModel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroyModel", nullptr, DestroyModel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getInputNames", nullptr, GetInputNames, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getTensorInfo", nullptr, GetTensorInfo, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setInputData", nullptr, SetInputData, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"predict", nullptr, Predict, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getOutputData", nullptr, GetOutputData, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

}  // namespace

static napi_module g_msliteModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "mslite",
    .nm_priv = nullptr,
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterMsLiteModule(void) {
  napi_module_register(&g_msliteModule);
}

