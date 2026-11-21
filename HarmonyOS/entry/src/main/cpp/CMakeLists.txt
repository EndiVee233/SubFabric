# ============================================================================
# MindSpore Lite NAPI 模块构建配置
#
# 为什么需要原生层：ArkTS 的 @ohos.ai.mindSporeLite 在 NNRt（NPU）后端下
# `model.getInputs()` 返回 undefined，拿不到张量就没法 predict。
# 官方 C API 没有这个限制（而且能按名字取张量）。
#
# 已核实的依赖位置（SDK 6.0.0 / API 26）：
#   sysroot/usr/include/mindspore/*.h           C API 头文件
#   sysroot/usr/lib/aarch64-linux-ohos/libmindspore_lite_ndk.so   链接桩
#   sysroot/usr/lib/<abi>/libace_napi.z.so      NAPI 运行时
#
# ⚠️ ABI 名字有两套，容易踩坑：
#   hvigor 传进来的 CMAKE_OHOS_ARCH_ABI 是 "arm64-v8a"
#   而 sysroot 下的目录名是 "aarch64-linux-ohos"
#   两者必须映射，否则 ninja 会报 "missing and no known rule to make it"
# ============================================================================

cmake_minimum_required(VERSION 3.5.0)
project(subfabric_mslite)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- 定位 OHOS SDK native 根目录（hvigor 会注入 OHOS_SDK_NATIVE）
if(NOT DEFINED OHOS_SDK_NATIVE)
    set(OHOS_SDK_NATIVE "D:/HarmonyOS/DevEco Studio/sdk/default/openharmony/native")
endif()
message(STATUS "OHOS_SDK_NATIVE = ${OHOS_SDK_NATIVE}")
message(STATUS "CMAKE_OHOS_ARCH_ABI = ${CMAKE_OHOS_ARCH_ABI}")

# ---- ABI 名映射：hvigor 的 ABI 名 -> sysroot 目录名
if(CMAKE_OHOS_ARCH_ABI STREQUAL "arm64-v8a")
    set(SYSROOT_ABI "aarch64-linux-ohos")
elseif(CMAKE_OHOS_ARCH_ABI STREQUAL "armeabi-v7a")
    set(SYSROOT_ABI "arm-linux-ohos")
elseif(CMAKE_OHOS_ARCH_ABI STREQUAL "x86_64")
    set(SYSROOT_ABI "x86_64-linux-ohos")
else()
    set(SYSROOT_ABI "${CMAKE_OHOS_ARCH_ABI}")
endif()
message(STATUS "SYSROOT_ABI = ${SYSROOT_ABI}")

set(SYSROOT_LIB "${OHOS_SDK_NATIVE}/sysroot/usr/lib/${SYSROOT_ABI}")
set(MSLITE_SO "${SYSROOT_LIB}/libmindspore_lite_ndk.so")

if(NOT EXISTS "${MSLITE_SO}")
    message(FATAL_ERROR
        "找不到 MindSpore Lite 原生库：${MSLITE_SO}\n"
        "请确认 SDK 完整（devices 目录下有 openharmony/native/sysroot）。")
endif()
message(STATUS "MSLITE_SO = ${MSLITE_SO}")

# ---- 头文件
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${OHOS_SDK_NATIVE}/sysroot/usr/include
)

# ---- 源文件
add_library(mslite SHARED
    mslite_napi.cpp
)

# ---- AudioSuite 人声降噪 NAPI（libmediakit.so）
add_library(mediakit SHARED
    audiosuite_napi.cpp
)

# ---- FFmpeg AV1 软件解码代理 NAPI（libffmpeg.so）
set(FFMPEG_HEADERS ${CMAKE_CURRENT_SOURCE_DIR}/ffmpeg/include)
set(FFMPEG_LIBS ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${CMAKE_OHOS_ARCH_ABI})
add_library(ffmpeg SHARED
    ffmpeg_napi.cpp
)
target_include_directories(ffmpeg PRIVATE
    ${FFMPEG_HEADERS}
)
target_link_libraries(ffmpeg PUBLIC
    ${SYSROOT_LIB}/libnative_media_codecbase.so
    ${FFMPEG_LIBS}/libavformat.so.62
    ${FFMPEG_LIBS}/libavcodec.so.62
    ${FFMPEG_LIBS}/libavfilter.so.11
    ${FFMPEG_LIBS}/libswscale.so.9
    ${FFMPEG_LIBS}/libswresample.so.6
    ${FFMPEG_LIBS}/libavutil.so.60
    ${FFMPEG_LIBS}/libdav1d.so.7
    ace_napi.z
    hilog_ndk.z
)

# CrispASR Vulkan backend. The generated static libraries are build artifacts
# from the pinned Vulkan toolchain. Keep this target conditional so a clean
# editor build still works before the optional backend is prepared.
set(VULKAN_ARTIFACT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../build/vkb5")
if(CMAKE_OHOS_ARCH_ABI STREQUAL "arm64-v8a" AND
   EXISTS "${VULKAN_ARTIFACT_ROOT}/ggml/src/ggml-vulkan/libggml-vulkan.a")
    add_library(vulkanprobe SHARED vulkanprobe_napi.cpp)
    target_include_directories(vulkanprobe PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${VULKAN_ARTIFACT_ROOT}/../ggml/include
        ${VULKAN_ARTIFACT_ROOT}/../ggml/src
    )
    target_link_libraries(vulkanprobe PRIVATE
        ${VULKAN_ARTIFACT_ROOT}/ggml/src/ggml-vulkan/libggml-vulkan.a
        ${VULKAN_ARTIFACT_ROOT}/ggml/src/libggml.a
        ${VULKAN_ARTIFACT_ROOT}/ggml/src/libggml-base.a
        ${VULKAN_ARTIFACT_ROOT}/ggml/src/libggml-cpu.a
        ${SYSROOT_LIB}/libvulkan.so
        ace_napi.z
        hilog_ndk.z
    )
    target_link_options(vulkanprobe PRIVATE -Wl,-z,max-page-size=16384 -Wl,--exclude-libs,ALL)
    set_target_properties(vulkanprobe PROPERTIES
        LIBRARY_OUTPUT_DIRECTORY
        ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${CMAKE_OHOS_ARCH_ABI})
endif()

# ---- 链接
target_link_libraries(mslite PUBLIC
    ${MSLITE_SO}
    ace_napi.z
    hilog_ndk.z
)

target_link_libraries(mediakit PUBLIC
    ${SYSROOT_LIB}/libohaudiosuite.so
    ace_napi.z
    hilog_ndk.z
)

# ---- 输出到 libs/<hvigor 的 ABI 名>/
set_target_properties(mslite PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${CMAKE_OHOS_ARCH_ABI}
)

set_target_properties(mediakit PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${CMAKE_OHOS_ARCH_ABI}
)

set_target_properties(ffmpeg PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${CMAKE_OHOS_ARCH_ABI}
)
