# 媒体处理链路调研与接入记录

> 2026-11-17。范围：FFmpeg 鸿蒙移植、字幕/波形/降噪、Vulkan / Mali 视频导出。
> 本文记录**已核实的事实**与**已接入/未接入**的边界，避免把调研结论当成已实现功能。

## 1. 结论摘要

| 能力 | 结论 | 状态 |
| --- | --- | --- |
| FFmpeg | 已自编 **x86_64 + arm64-v8a** 双 ABI 共享库，接入主 HAP；含 `libdav1d` / `libopenh264` | 已接入并验证 x86_64 模拟器 |
| 字幕实时预览 | 用系统 `Video` + 原生字幕层，按 ASS 文件逐词时间渲染 | 已实现（见 `HOME_MATERIAL.md` §4.5） |
| AV1 软件解码 | 系统无 AV1 硬解时，FFmpeg(`libdav1d`) → H.264(`libopenh264`) 代理，再交给系统 `Video` | 已实现并验证 |
| 波形提取 | 可用系统 `AVTranscoder` 解码 PCM 后算峰值；FFmpeg 作为可选加速路径 | 待接入 |
| 人声降噪 | 华为 Audio Kit `OHAudioSuite` 提供现成降噪节点（API 22+），SDK 26 头/库齐全 | 已接入原生 NAPI + 设置页自检 |
| 视频导出硬件加速 | 没有“Mali 独立视频编码 API”；系统 `AVCodec` 的 `HARDWARE` 编码器是正式路径 | 能力探测/接口待接入 |
| 编解码后端切换 | 设置 → 性能与调度 → 媒体编解码：`AVCodec + FFmpeg` / `全流程 FFmpeg` | 已接入偏好；影响 AV1 代理选择 |
| Vulkan | SDK 有 Vulkan 头/库；FFmpeg 的 OHOS 构建常关闭 Vulkan，Vulkan video encode 依赖驱动 | 不作为首期导出路径 |

## 2. 已有 FFmpeg 移植

### 2.1 `@ohos/ffmpeg-kit` 1.0.1

- 仓库：`https://gitcode.com/CPF-ApplicationTPC/ohos_ffmpeg_kit`
- OHPM：`ohpm install @ohos/ffmpeg-kit`
- 基于 FFmpegKit，提供 `FFmpegKit.execute()` / `FFprobeKit`，底层 `libffmpegkit_napi.so` + `@ohos/aki`。
- 下载 HAR 后核对：`libs/` 只有 **arm64-v8a**，包含 `libavcodec/libavformat/libavfilter/libass/libx264/libx265` 等完整库。
- License：OHPM 元数据为 LGPL-3.0（README 有 MIT 表述，接入前需按实际发布物再核对）。
- 限制：无 x86_64，DevEco 模拟器（x86_64）无法加载；只能在 arm64 真机/HAP 上验证。

### 2.2 `@prq/ffmpeg-tools` 2.2.7

- 仓库：`https://github.com/jjjjjjava/ffmpeg_tools`
- OHPM：`ohpm install @prq/ffmpeg-tools`
- 提供 `FFmpegFactory` / `FFmpegCommandBuilder` / `FFmpegManager`，README 明确支持
  `hwaccel()` 硬解硬编；体积约 11.46 MB，`libffmpegutils.so`。
- 限制：README 写明**仅 arm64-v8a**；API 12+；FFmpeg 内部全局状态，任务需串行。
- 适合作为“arm64 真机 + 系统硬编”的快速路径，但仍绕不开模拟器 ABI。

### 2.3 从源码编译

- `https://github.com/chucongqing/ffmpeg-harmony-builder`：脚本支持
  `arm64-v8a` / `armeabi-v7a` / `x86_64`，基于 HarmonyOS NDK 交叉编译；需 Linux/macOS
  构建宿主（bash、make、cmake、perl）。
- `https://gitee.com/changsanjiang/ffmpeg_harmony_os`：完整 HarmonyOS FFmpeg 播放器工程（GPL-3.0）。
- `https://github.com/openharmony/third_party_ffmpeg`：OpenHarmony 官方 FFmpeg 源码/构建。
- `https://github.com/1814356580/ffmpegHarmony`：`harmony.sh`，支持 `OHOS_ARCH_LIST="arm64-v8a,x86_64"`，
  可编出双 ABI；默认带 libass/freetype/x264/dav1d。
- 当前 Windows 开发机没有 make/MSYS2，直接本机构建需要先装构建环境；这会是一个独立阶段，
  不应和 UI 迭代混在一起。

### 2.4 当前工程的自编双 ABI（已落地）

- 源码：FFmpeg 8.1，使用 DevEco SDK native clang 交叉编译；Git Bash + MinGW `mingw32-make`
  （复制为 `make.exe`）构建，x86_64 额外使用 nasm，arm64 使用 clang 集成汇编。
- 配置要点：
  - `--target-os=linux --enable-cross-compile --sysroot=<SDK>/sysroot`
  - `--disable-programs --disable-doc --disable-network --disable-avdevice`
  - `--enable-avcodec --enable-avformat --enable-avutil --enable-swscale --enable-swresample`
  - `--enable-libdav1d --enable-decoder=libdav1d`（AV1 软件解码）
  - `--enable-libopenh264 --enable-encoder=libopenh264`（H.264 软件编码）
  - 共享库，`--enable-pic`，关闭 symver。
- 依赖版本：dav1d 1.5.1（BSD）、OpenH264 2.6.0（BSD）。两者都按 x86_64/arm64 双 ABI
  自编，避免 GPL 的 x264 影响工程 Apache-2.0 声明。
- 产物位置：`entry/libs/x86_64`、`entry/libs/arm64-v8a`；只保留 SONAME 对应的
  `libavcodec.so.62`、`libavformat.so.62`、`libavutil.so.60`、`libswresample.so.6`、
  `libswscale.so.9`、`libavfilter.so.11`、`libdav1d.so.7`、`libopenh264.so.8`。
- **关键事实**：FFmpeg 8.1 内置的 `av1` 解码器在无 `hwaccel` 时 `avcodec_send_packet`
  返回 `-ENOSYS`（源码注释明确“当前不支持 native decode”）。因此“FFmpeg 自带 AV1 软解”
  不成立，必须带 `libdav1d`（或 libaom）。本工程使用 `libdav1d`，并在 NAPI 中优先
  `avcodec_find_decoder_by_name("libdav1d")`。
- NAPI：`entry/src/main/cpp/ffmpeg_napi.cpp` → `libffmpeg.so`，提供
  `probeMedia` / `hasAv1Hardware` / `transcodeToH264` / `getTranscodeProgress` /
  `cancelTranscode`；转码在 async work 线程执行，ArkTS 用 Promise + 进度轮询。
- 代理编码：H.264 Baseline（OpenH264）+ AAC，MP4；默认最长边 720，1.8 Mbps；
  输出缓存在项目目录 `proxy_av1_h264.mp4`，重开项目直接复用。
- 实测（平板模拟器 x86_64，API 26）：480×270 / 8 s AV1 样例 → 约 1.6–1.7 s 生成代理（C 版 dav1d）；
  代理可被系统 `Video` 播放，时长 8 s、分辨率 480×270、画面正常；H.264 原片走系统解码正常。
  自检样片和临时入口只用于本次验证，最终 HAP 不含样例文件。
- 尚未验证：arm64 真机 FFmpeg 转码、系统 AV1 硬件解码、长视频转码耗时/发热。

## 3. 华为现成能力

### 3.1 人声降噪（Audio Kit / OHAudioSuite）

- 官方文档：Audio Kit「音频效果(C/C++)」的 `EFFECT_NODE_TYPE_NOISE_REDUCTION`（API 22+）。
- 效果节点固定输出 **16 kHz / S16LE / 单声道**；支持离线编辑和实时预览管线。
- SDK 26 的 `sysroot/usr/include/ohaudiosuite/` 与 `libohaudiosuite.so` 在 arm64/x86_64 都存在。
- 已接入：
  - `entry/src/main/cpp/audiosuite_napi.cpp`：输入节点 → 降噪节点 → 输出节点，`RenderFrame`
    逐帧处理，返回同格式 PCM；
  - `libmediakit.so` 类型声明与 `engine/AudioSuiteDenoise.ets`；
  - 设置 → 性能与调度 → “人声降噪”卡片 + 1 秒带噪正弦自检。
- 模拟器实测：`isNoiseReductionSupported()` 返回 false，卡片显示“当前设备不可用”；
  这是系统节点/设备能力限制，不是 NAPI 加载失败。真机（Kirin + API 22+）需复验。

### 3.2 视频编码（AVCodec Kit）

- 没有“Mali 专用视频编码 SDK”或公开的 Mali 编码 API。
- HarmonyOS 的硬件编码路径是 `OH_VideoEncoder`：
  - `OH_AVCodec_GetCapabilityByCategory(OH_AVCODEC_MIMETYPE_VIDEO_AVC, true, HARDWARE)`
  - `OH_VideoEncoder_CreateByName` / `Configure` / `GetSurface` / `Start`
  - H.264 / H.265 8bit/10bit 硬件编码、Surface/Buffer 两种输入，API 20+ 还支持同步模式。
- 具体由 VPU/GPU/DSP 中的哪一个执行由 SoC/系统决定，应用侧只看到 `HARDWARE` 类别。
- 因此“基于 Mali GPU 的视频压制”不能按厂商 GPU API 接入；正确实现是 **AVCodec HARDWARE
  编码器 + Surface 合成**（字幕/滤镜先画到 Surface，再零拷贝送编码器）。

### 3.3 Vulkan

- SDK 含 `sysroot/usr/include/vulkan/vulkan.h`、`libvulkan.so`（arm64/x86_64）。
- FFmpeg 的 OHOS 构建说明普遍建议 `--disable-vulkan`（历史构建缺头/驱动）；Vulkan video
  encode/decode 还依赖具体 GPU 驱动，模拟器与部分设备不可用。
- 结论：Vulkan 可作为后续 GPU 滤镜/合成实验路径，不作为首期“视频导出加速”的承诺。
  首期导出走 AVCodec HARDWARE；FFmpeg 负责字幕烧录/封装（arm64 真机）。

## 4. 当前落地与下一步

### 已落地

1. 字幕：真实 `Video` 播放 + ASS 文件驱动的逐词高亮（详见 `HOME_MATERIAL.md` §4.5）。
2. 人声降噪：AudioSuite 原生 NAPI、ArkTS 封装、设置页能力查询/自检。
3. 字幕修复：编辑页「重新导入字幕」，按源 ASS 重建行与 `Cue.words`。
4. FFmpeg：双 ABI 共享库、dav1d/OpenH264、NAPI 媒体探测与 AV1→H.264 代理。
5. 编辑页视频：优先原片系统解码；AV1 且无系统硬解时自动生成/复用代理，显示进度与
   “AV1 · 软件代理”状态；系统 AV1 硬解存在时保持原片播放。
6. 编辑页各板块已接真实数据：时间轴/右侧字幕列表（`LazyForEach` + 真实 cue）、人物列表
   （`[Name]` 标签统计）、设置（双行/逐词/自动滚动/翻译/VAD/目标语言）、日志（Logger 环形
   缓冲）、工作量（真实 cue/word/speaker/duration 统计）。右边栏顶部 Tab，双栏按钮可同时显示
   字幕列表 + 人物列表（对应桌面版 split roles）。
7. 媒体编解码开关：设置 → 性能与调度 → 媒体编解码，支持 `AVCodec + FFmpeg` 与
   `全流程 FFmpeg`；后者会让 AV1 处理跳过系统硬解、强制 FFmpeg 代理。详见 §5。

### 待落地（按建议顺序）

1. **真机验收**：arm64 FFmpeg/dav1d 转码、系统 AV1 硬解、长视频代理耗时与发热；
   模拟器只能验证 x86_64 软件路径。
2. **波形提取**：优先用系统 `HarmonyAudioDecoder.decodeToPcm16k`（已有）算峰值并缓存到项目目录；
   FFmpeg 路径只作为更快/更多格式的备选。
3. **降噪处理链**：解码 PCM → AudioSuite 降噪 → WAV 试听；真机确认节点可用后再做整段导出。
4. **视频导出**：AVCodec HARDWARE 编码 + Surface 字幕合成 + 封装；FFmpeg 负责需要 libass
   复杂特效的场景。Vulkan 仅做实验，不作为首期阻塞项。

## 5. AVCodec / FFmpeg 分工评估与切换

### 5.1 设置里的开关

设置 → 性能与调度 → 媒体编解码：

| 选项 | 含义 | 实际影响 |
| --- | --- | --- |
| `AVCodec + FFmpeg`（默认） | 优先系统 AVCodec 硬解/硬编，FFmpeg 只做兜底 | AV1 有系统硬解时直接播放原片；无硬解时生成 FFmpeg H.264 代理 |
| `全流程 FFmpeg` | 处理链路优先 FFmpeg 软件实现 | AV1 即使有系统硬解也强制走 FFmpeg 代理；功耗更高，适合对比兼容性/画质 |

**边界**：这个开关不会替换编辑页的 `Video` 播放器。HarmonyOS 端没有接入
FFmpeg + SDL/OHNativeWindow 播放器，视频预览始终由系统 `Video`（AVCodec）解码。
“全流程 FFmpeg”只影响已经接入 FFmpeg 的处理步骤，目前就是 AV1 → H.264 代理。

设置页同时显示当前设备的 AV1 硬解能力（`OH_AVCodec_GetCapabilityByCategory(...AV1, false,
HARDWARE)`）。没有 AV1 硬解时，两种模式都会落到 FFmpeg 代理；开关只决定“有硬解时是否仍强制
FFmpeg”，不会凭空提供硬件能力。

### 5.2 逐流程评估

| 流程 | 当前实现 | 能否改用 AVCodec | 结论 |
| --- | --- | --- | --- |
| 视频预览 / 播放 | 系统 `Video` | 已经是 AVCodec | 保留；FFmpeg 播放器不接入 |
| 音频提取 16 kHz PCM | `AVTranscoder` → WAV → PCM | 已经是系统 AVCodec/媒体框架 | 保留；不需要 FFmpeg |
| H.264 / H.265 解码 | 系统 `Video` | 已经是 AVCodec | 保留 |
| AV1 解码 | 有硬解走系统；无硬解 FFmpeg + libdav1d | 仅硬件 AV1 可用时能完全替代 | 保留混合；FFmpeg 不可移除 |
| AV1 → H.264 代理 | FFmpeg `libdav1d` + `libopenh264` | 解码可用 AVCodec 硬解，但编码与封装仍需另接 | 现状可用；后续可做硬解硬编代理 |
| H.264 / H.265 压制 / 导出 | 无导出入口 | `OH_VideoEncoder` HARDWARE 是正式路线 | 建议新做；FFmpeg 作为软编兜底 |
| 字幕烧录 / 文字合成 | 预览是 ArkUI 叠加层，没有烧录导出 | `OH_VideoDecoder` → Surface → 原生绘制 → `OH_VideoEncoder` 可行 | 新功能；不是简单替换 |
| 波形提取 | 未实现 | AVTranscoder / AVCodec 解码 PCM 可行 | 优先系统；FFmpeg 备选 |
| 人声降噪 | AudioSuite 原生节点 | 不属于 AVCodec/FFmpeg 二选一 | 保持 AudioSuite |
| 容器封装 / remux | 未实现；代理由 FFmpeg 直接封装 | `OH_AVMuxer` 可行 | 新功能可优先系统 |
| 媒体探测 / 元信息 | FFmpeg `probeMedia` | AVCodec 没有等价的通用 probe API | 可继续用 FFmpeg，或用 `AVMetadataExtractor` 补 |

**可以完全去掉 FFmpeg 的前提**：目标格式都有系统硬解/硬编，且不需要 AV1 软解、
libass 复杂字幕特效和软件 H.264 兜底。当前项目不满足，所以推荐混合而不是“全系统”。

### 5.3 “解码 → 绘制文字 → 硬编”路线

用户提出的视频压制路线（后续导出功能）在 HarmonyOS 上可拆成：

1. **解封装**：系统 `AVDemuxer`；必要时用 FFmpeg 只做 demux（混合链路）。
2. **解码**：`OH_VideoDecoder` 输出到 Surface；有 H.264/H.265/AV1 硬解时走 HARDWARE。
3. **合成文字**：把解码 Surface 作为纹理，在原生层用 `OH_NativeWindow` + EGL/原生绘制
   画字幕，再写入编码器输入 Surface。注意：**ArkUI 的 `Canvas` 是 UI 组件，不能直接
   给原生解码器当画布**；需要 NativeWindow/EGL + Drawing Kit（或 FreeType 位图）实现。
4. **编码**：`OH_VideoEncoder_GetSurface` 拿到输入 Surface，配置 H.264/H.265、
   bitrate/GOP/关键帧，`Start()` 后逐帧送编码器。
5. **封装**：`OH_AVMuxer` 写 MP4；音频轨可先复制或重新编码。
6. **音画同步**：以 PTS 为唯一时间基准，丢帧/重复帧策略要在合成层处理；
   字幕时间必须来自 ASS/Cue，而不是按帧均分。

收益：解码/编码走 VPU，CPU 只做合成与文字，长时间导出比 FFmpeg 软编更省电。
风险：
- 设备不一定支持 AV1 硬解或指定分辨率/像素格式；
- 解码器 Surface 与编码器 Surface 不能直接互连，需要中间纹理/合成 Surface；
- 文字渲染在原生层没有 ArkUI 的字体/排版能力，需要自带字体与排版；
- 模拟器通常没有硬件编码器，只能真机验收。

当前状态：**该导出路线尚未实现**；设置页和评估先落地，避免把“可切换”误认为
“硬编导出已可用”。下一步应先做 H.264 硬解硬编的无字幕代理，再叠加文字合成。

---

## 6. 参考链接

- FFmpegKit OHOS：<https://gitcode.com/CPF-ApplicationTPC/ohos_ffmpeg_kit>
- ffmpeg-tools：<https://github.com/jjjjjjava/ffmpeg_tools>
- ffmpeg-harmony-builder：<https://github.com/chucongqing/ffmpeg-harmony-builder>
- ffmpegHarmony：<https://github.com/1814356580/ffmpegHarmony>
- OpenHarmony FFmpeg：<https://github.com/openharmony/third_party_ffmpeg>
- AudioSuite 音频效果：<https://device.harmonyos.com/cn/docs/apiref/harmonyos-guides/audio-suite-effects>
- AVCodec 视频编码：<https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/video-encoding>
