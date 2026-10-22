# SubFabric 项目文档（唯一技术文档）

本文件合并了原先散落在仓库各处的开发文档，是**结构、流程、约定与设计结论的唯一权威入口**。
用户向介绍见 [README.md](../README.md)；长期工作规则见 [AGENTS.md](../AGENTS.md)。

> 历史材料（三轮代码审查、两次 STATUS 快照、卡拉OK 调研、双引擎实测）已压缩为本文的
> [历史文档索引](#12-历史文档索引)，原件删除后仍可在 git 历史中找回。

---

## 1. 快速开始

- 渲染依赖（新克隆必做一次，约 18MB，不入库）：`node editor/scripts/fetch-vendor.js`。
  缺 `editor/vendor/` 时字幕列表与时间轴正常，但视频区不显示字幕、样式面板也没有「ASS 渲染就绪」
  —— 原因是 libass worker 起不来。安装版不需要这一步（安装包已含）。
- 启动服务：`node editor/server.js --no-tray`，打开 <http://127.0.0.1:8321/>（`/` 与 `/index.html`
  均 302 到 `/editor/studio.html`）。`--no-tray` 表示不挂 Windows 托盘（等价 `SUBFABRIC_TRAY=0`），
  供自动化/无桌面环境使用；需要托盘时直接 `node editor/server.js`。
- 端口优先级：`--port NNNN` > 环境变量 `PORT` > 默认 `8321`。SEA 启动器把端口写死 8321。
- 该命令会创建本地日志与数据（`logs/`、`projects/`、`asr/settings.json`）；手工验收用一次性工作副本
  并确认端口空闲，正常测试不要直接启动源码服务。
- 运行需要 Node.js 22+（项目靠 `require(esm)` 让一份 ESM 双端复用）。服务端零 npm 依赖、
  前端原生 ESM 无构建步骤（仓库没有 `package.json`）；Python 依赖见 `asr/requirements.txt`。
- 双击启动器：`启动SubFabric(无窗口).vbs` 隐藏窗口拉起服务，在 8321–8324 找空闲端口，就绪后开浏览器。

## 2. 目录地图

| 路径 | 职责 |
| --- | --- |
| `editor/server.js` | 后端全部逻辑的单一文件：安全守卫、薄分发器 + 7 段路由、项目系统、下载/prepare/ASR/翻译流水线、托盘与退出 |
| `editor/studio.html` | 唯一生产界面入口，由 `tools/templates/studio.html` 经 `node tools/generate-studio.mjs` 逐字节生成 |
| `editor/css/`、`editor/js/`、`editor/lang/`、`editor/themes/`、`editor/assets/`、`editor/vendor/` | 样式、前端 ESM 模块（含首次启动的 `welcome-model.js` 可见性纯逻辑）、`zh-CN.json` 文案、主题包 JSON、Logo、libass 资源（vendor 不入库） |
| `editor/*.js`（顶层） | 后端 CJS 辅助模块：`cast.js`、`llm-text.js`、`reseg.js`、`k-line.js`、`fonts.js`、`secret-store.js`、`asr-chunks.js`、`audio-slice.js`、`bcut-asr.js`、`capcut-asr.js`、`faster-whisper.js`（Whisper large-v2 参数/JSON 适配）、`glossary-repair.js`（术语表拼写修复，所有 ASR 共用）、`hardsub.js`（视频导出，见 §11）、`ffmpeg-tool.js`（ffmpeg 定位与自动下载）、
`asr-params.js`（Faster-Whisper / CrispASR 的参数 schema；Parakeet CUDA / whisper.cpp / VibeVoice 的旧 schema 保留但模型已停用），以及 fork 并入的 `align.js`、`asr-service.js`、`ass-group.js`、`danmaku.js`、`hotwords.js`、`mt-local.js`、`project-pack.js`、`reflect.js`、`region.js`、`region-merge.js`、`repair-words.js`、`speech-gap.js` |
| `editor/scripts/` | `fetch-vendor.js`（拉 libass）、`sea-launcher.cjs`（SEA 入口）、`tray.ps1`、`gen_app_icon.py`、`gen_tray_icon.py`、`7z.exe`（7-Zip standalone，解 Faster-Whisper-XXL 的 .7z 运行时） |
| `asr/` | Python 侧能力：`asr.py`、`asr_dual.py`、`asr_npu.py`、`asr_perf.py`、`vibevoice.py`、`diarize.py`、`multitalker.py`、`mt_nllb.py`、`confidence.py`、`common.py`；`asr/faster-whisper-xxl/` 是服务端按需下载的 XXL 运行时（不入库），`asr/settings.json` 为含密文本机设置（不入库） |
| `asr/fetch/` | bilibili / YouTube 下载内核（见 §9） |
| `tests/` | Node/Python 测试与统一入口 `tests/run-all.mjs`；`tests/jsmod/` 是前端模块自动同步镜像（入库） |
| `tools/` | 探针与验收脚本：`build-install.mjs`（事务构建入口）、`generate-studio.mjs`、`studio-install.mjs`、`repair15-regression.mjs` |
| `tools/templates/studio.html` | Studio 入口的唯一上游模板，改界面先改模板再生成 |
| `prototypes/` | 与生产隔离的无构建原型：`cue-card-redesign/`、`subtitle-editor/`、`adaptive-selection/` |
| `build/` | 打包产物目录；仅 `build/installer/` 的 `.iss`、图标与启动脚本入库 |
| `docs/` | 本文件 + `ui-integration-baseline.json`、`repair15-baseline.json` 等被测试读取的数据文件 |
| `main.py` | 历史遗留的 Python 字幕处理工具（`ass`/`srt`/`config`/`fonts` 子命令与 GUI），与编辑器主线关系弱 |
| `build_exe.py` | SEA 打包脚本，产出 `build/SubFabric.exe`；从 `editor/server.js` 读 `APP_VERSION` / `APP_FILE_VERSION` |
| `eslint.config.js` | ESLint 9 flat config，仅开发/CI 期使用，不是运行时依赖 |

## 3. 后端与数据流

- **单文件约束**：SEA 入口 `editor/scripts/sea-launcher.cjs` 用 `Module._compile` 从磁盘加载
  `server.js`，SEA 里相对 `require` 不可用，因此 `server.js` 必须保持单文件；"拆分"只能是函数体内重排。
- **铁律：跨请求状态必须放模块作用域**——`prepareJobs`、`draftJobs`、`pendingAsr`、`draftProcs`、
  `draftAborts`、`rerecogJobs`、`projProcs`、`MEDIA_ALLOW`、`mediaMetaCache`、`logBuf`、`logClients`、
  `lifeClients`、`dlState`、`CHILDREN`、`realignJobs`、`subtitleCommits`、`deletedProjects`。
  放进路由段函数等于每请求重置。
- **路由结构**：`SIMPLE_ROUTE_MAP` 承接同步无副作用端点，`API_SECTIONS` 前缀表分发到 7 个段函数
  `handleWaveRoutes` / `handleFetchRoutes` / `handleAsrRoutes` / `handleLlmRoutes` / `handleLogsRoutes` /
  `handleDiagRoutes` / `handleProjectsRoutes`，签名统一 `(req, res, u)`，段末 404 JSON 兜底，最后静态回落。
- **安全基线**：Host 必须回环；有 Origin 的读写请求校验明确集合，无 Origin 的写请求须带
  `X-SubFabric-Token`；`/__test/` 仅 `SUBFABRIC_TEST_MODE=1` 启用；`safeJoin` 解码后归一化并补路径
  分隔符边界，拒绝编码穿越。
- **初稿流水线**：创建 → 下载（`startFetchJob` → `asr/fetch/fetch_cli.py`，10 分钟无输出看门狗）→
  prepare（ffprobe → ffmpeg 抽 `audio.wav` + `peaks.bin`；**ASR 默认用原声 `mode='raw'`**，降噪版实测会让
  Whisper large-v2 的 WER 从 8.70% 升到 11.02%）→ ASR（Faster-Whisper-XXL / Parakeet NPU /
  Parakeet Vulkan / Qwen3-ASR + 对齐 / 必剪 / 剪映；CUDA Parakeet、Whisper large-v3-turbo、
  Multitalker、双引擎、VibeVoice 已于 2026-10-21 停用）→ **术语表拼写修复**（`glossary-repair.js`，所有引擎共用）→
  语义分句 `reseg`（所有引擎必经）→ 可选 `diarize` → 写字幕（逐词 ASS 或 SRT）→ LLM `translate`。
- **流水线状态**写 `meta.draft`（`running` / `paused` / `error` / `done`），前端轮询
  `GET /api/projects/:id/draft`；防重入用 `draftJobs.has(id)`，每步统一走 `safeDraftStep`
  （同步异常与 async reject 都收）。
- **项目内操作**统一为 `/api/projects/:id/<action>`：`info`(PUT 改名)、`retry`、`skip`、`rerecognize`、
  `translate`、`draft`、`subtitle`、`relink`、`prepare`、`peaks`、`audio`；`DELETE` 无 action 即删项目。
- **逐词时间重排**（单条 `/realign` + 全片 `/realign-full`）：语义是“文本已确认，只量时间”。
  只调用 **Qwen3-ForcedAligner**：CUDA 用 `asr/qwen_align.py` 批量 worker（一次加载、按切片对齐），
  Vulkan 用 `CrispASR --align-only`；结果经 `align.js` 做 token 映射/单调性修正。**不跑 ASR、
  不改文本、不改整句起止**；对齐失败保持原时间，不回退 ASR。文本不确定走独立的 `rerecognize`。
  已删除 `/api/asr/realign-settings` 与锚点率/置信度门槛。
- **删除项目**：先 `killDraftProc` + `killProjProcs`（Windows 用 `taskkill /T /F`），再带重试逐文件删，
  `project.json` 最后删；新增读写 `projects/<id>/` 的子进程必须 `trackProjProc(id, proc)`。
- **元数据**：`updateMeta(id, mutate)` 同步读取最新内容、字段更新、唯一临时文件原子替换，
  禁止旧对象整体覆盖；跨 await 的新更新优先用它。
- **数据文件**（`projects/<id>/`，全部不入库）：`project.json`、`subtitle.ass` / `subtitle.srt`、
  `audio.wav`、`peaks.bin`、`asr.json`、`translation.json`、`reseg.json`、`asr-chunks.json`、
  `source.json`、`draft.log`、`llm-debug.jsonl`、`video/`。

## 4. 前端与主题

- **装配**：`editor/studio.html` 装载多个 `<script type="module">`（`js/studio.js`、`js/main.js`、
  `js/color-picker.js` 等）。主 hash 路由：`#/dashboard`、`#/home`、`#/new`、`#/settings`、
  `#/project/<id>`、`#/editor`；无 hash 默认 `#/dashboard`，旧 `#/resources` 转 `#/settings`、
  旧 `#/tasks` 转 `#/home`。
- **首次启动（加速方式）**：浏览器没有 `localStorage.sf-welcome-v1` 时先显示 `#welcome-view`，
  `#app` 置 `inert` 并隐藏；只提供 **CUDA / Vulkan** 两个勾选，至少勾一个才能进入（不支持 CPU 推理）。
  NPU 不在欢迎页出现：`GET /api/asr/hardware` 探到 Intel AI Boost / Ryzen AI 才在设置页显示。
  硬件探测：CUDA 走 `nvidia-smi`；Vulkan 用 `System32\vulkan-1.dll` + 非虚拟显卡列表；NPU 用
  `Win32_PnPEntity` 匹配 `AI Boost|Ryzen AI|NPU|IPU`（排除 Input/HID）。结果缓存 5 分钟，
  `?refresh=1` 强制重探。勾选写入 `asr/settings.json` 的 `backends`（`POST /api/asr/backends`），
  服务端 `modelAllowedByBackends` / `modelAllowedByHardware` 过滤 `resolveAsrModel` /
  `resolveDraftModel` / `resolveRerecogModel`；前端 `editor/js/welcome-model.js` 同步过滤
  `/api/asr/status` 的 `models`，系列没有模型时隐藏入口。已下载但不属于当前勾选/硬件的模型
  不删除也不混进正常列表，前端 `extraModels()` 把它们放进「其它模型」，只保留删除，不参与默认选择；
  NPU 没有硬件时连这里也不显示。云端识别不依赖本机加速，仍显示在「云端识别」。
  设置 → 性能与调度 → 「重新进入欢迎界面」
  可再次打开；主题沿用现有令牌（Material 大圆角、UWP 近直角/无毛玻璃、Classic 默认），
  入场/勾选/极光背景动画在 `prefers-reduced-motion` 或 `data-motion=off` 时关闭。首帧由
  `editor/js/welcome-boot.js`（同步脚本）先挂 `sf-welcome-pending` 隐藏 App，避免闪一下主页再弹欢迎。
  未选中卡片使用主题 `surface-2` 的浅色底（不再回落到深色 `--bg-3`）；提示条用
  `grid-template-rows: 0fr → 1fr` 展开/收起，配合负 gap 抵消与 440ms 非线性曲线，
  选择状态切换时卡片、按钮、提示条连续移动，不跳帧。
- **UWP 欢迎页磁贴**：CUDA / Vulkan 两张选择卡加 `uwp-tile`，与工作台磁贴共用 Reveal 面光、
  2px 直角和实色底；`data-theme-pack="windows-uwp"` 同时兜底圆角，避免首帧 `data-design`
  尚未写入时出现大圆角。红色错误条也固定 2px 直角。欢迎卡、UWP 原生 checkbox、下拉选择
  的勾选图标统一用 `inset:0 + margin:auto` 居中；UWP 复选/单选的下拉选择勾也走同一规则。
- **文案层（i18n）**：`editor/js/i18n.js` 是显示出口；`editor/lang/zh-CN.json` 是「原文 → 可润色译文」
  词典，键缺失回退原文。`tests/gen-lang.mjs` 用共享 `tools/lib/copy_scan.mjs` 扫描
  `editor/studio.html`（文本/title/placeholder/aria-label/alt/value）、`editor/js/*.js`、
  `editor/server.js`、`editor/scripts/*`，跳过注释，保留已有译文和旧键；`tests/i18n-coverage-test.mjs`
  在回归里保证没有漏进词典的用户可见中文。新增动态 DOM 由 MutationObserver 落地后过词典，
  所以欢迎页、模型卡片、进度日志和提示框都不需要手写 `t()` 才能翻译。
- **入口生成**：`node tools/generate-studio.mjs` 把 `tools/templates/studio.html` 逐字节写到
  `editor/studio.html`（另从 `prototypes/subfabric-ui/` 拷贝 `themes.js`→`editor/js/studio-themes.js`、
  `progress.js`→`editor/js/studio-progress.js`，源不存在时保留现文件）。
- **静态白名单**：`editor/server.js` 的 `STATIC_RESOURCES` 显式列出 `editor/studio.html`、
  `editor/css/studio.css`、`editor/lang/zh-CN.json`、`editor/themes/subfabric-classic.theme.json`、
  `editor/assets/app-logo.png`、指定的 `editor/js/*.js` 与少量 `editor/*.js`、`editor/vendor/` 的 libass
  文件；另仅放行 `samples/` 顶层媒体/字幕。`editor` 下未列出的后端模块不随目录公开。
- **静态服务**：`staticResource` 拒绝反斜杠、空字节、`:`、`%` 及 `.` / `..` 路径段；`publicResource`
  逐级拒绝符号链接与祖先 junction。项目字幕、媒体、字体走各自 API。
- **UI 单入口**：旧 `editor/index.html` 与旧 CSS 已删除，旧视觉迁移为 `subfabric-classic` 主题包；
  根入口无论 `ui-config.json` 缺失、损坏还是 `{"ui":"legacy"}` 都只进 Studio，且该配置不对外服务。
- **主题包**：内置四个——Windows 10(`uwp`)、Material You(`material`)、SubFabric Classic(`classic`)、
  Claude(`claude`)；`design:"studio"` 仅保留给旧自定义包。同源 JSON 在 `editor/themes/*.theme.json`，
  运行期定义在 `editor/js/studio-themes.js`。自定义包只接受白名单键（`schema` `id` `name` `version` `description`
  `author` `design` `seed` `tokens` `assets` `builtin`）、`#RRGGBB` 颜色令牌与内嵌 PNG/JPEG/WebP 预览；
  **不能**含脚本、CSS、HTML、SVG 或远程 URL。导入同名自定义包替换旧版，导入内置包生成 `-custom` 副本，
  内置包不可删除。
- **主题示意图几何**：主题卡内的预览示意图按卡片自身 `design` 取圆角（Windows 10 2px / Material You 24px /
  Classic 8px / Studio 12px），不随当前启用主题的 `body[data-design]` 切换；UWP 的三条内容横条保持直角。
- **主题卡悬浮**：Material You 下悬浮非当前主题卡时，1px 边框以 160ms 过渡点亮为 `--accent`；当前卡继续
  使用 2px 选中环，UWP 保留其中性 `--muted` 悬浮边框。
- **描边映射开关**：`#sf-rim-enabled` 复用共享 `.switch` 组件（默认 38×20 / 14px，UWP 40×20 / 12px），
  不再使用 26×15 的自绘双伪元素开关；`configureRim()` 继续同步 `checked`。
- **文件夹滚动条**：Material You 下隐藏 `#sf-folders` 的右侧滚动条（`scrollbar-width:none` 与 0 宽
  WebKit 滚动条），列表仍可用滚轮/触控板滚动；其它主题保留原滚动条。
- **文件夹头与弹窗**：`.sf-folder-head` 右侧不留内边距，`#sf-folder-add` 与每行删除 X 同为 34×34
  （图标 16px），两个按钮共用同一条右基线；新建/移除文件夹的页内弹窗用 `sf-dialog-veil-*` /
  `sf-dialog-box-*` 入场（UWP 150ms 淡变 + `scale(.96)`）、退场 120ms 反向，`closeFolderDialog()`
  等 `is-closing` 动画结束后再摘 `hidden`；减少动效或 `data-motion=off` 时动画时长为 0，立即收起。
- **文件夹不在识别时反复重建**：稿件识别进度会让主页每 1.5 秒推一次项目快照；`__sfStudio.projects()`
  先比对 `folders + assignments` 的计数签名，只有文件夹名称/数量或归属计数真的变化才 `renderFolders()`。
  单纯进度变化只更新卡片，不重建 `#sf-folders`，也不会重播 Material 文件夹入场动画。
- **主页入场后不再二次刷新**：进入 `#/dashboard` 时磁贴有最长 330ms 错峰 + 420ms 的入场动画，
  而项目快照是异步到的，`refreshLibrary()` 还会再走一次 `renderWidgets()` / `syncDashboardMode()`。
  旧实现里 `renderWidgets()` 整块 `innerHTML` 重建、`syncDashboardMode()` 无条件调
  `animateDashboardCards()`，于是数据晚到会把磁贴节点全换掉、动画从头再播一遍 —— 看起来就是
  「动画播完过一会刷新一下」。现在磁贴只在第一次建节点，之后只改文字（`setWidgetText`）；
  `syncDashboardMode()` 只在 Material 主页 ↔ 磁贴模式真的切换、或显式切换主题时重播入场，
  项目数据刷新不再触发动画。`sf-studio-theme` 仍显式传入重播标记。
- **流光过渡**：`.sf-ambient i` 用 `background-color` 承接 `--sf-aurora-1..3` 并做 420ms 过渡，换配色或
  切换明暗都不硬切；动态/静态只切 `animation-play-state`，静态停在当前帧、切回继续漂移，不跳回原点。
- **主题色遮罩**：`自定义主题色` 行与色板/恢复默认按钮同处 `.sf-theme-color-panel` 一块遮罩；
  MY 圆角 24px、UWP 2px、其它 8px，避免色板落在遮罩外。
- **角色列表入场**：每次进入编辑器后**第一次**切到角色页时 `#role-list` 加 `is-role-entering`，
  每张 `.role-card` 按 `--role-i` 以 32ms 阶梯执行 260ms 淡入 + `translateY(10px→0)` + `scale(.96→1)`；
  后续切回、数据刷新不重播；进入编辑器路由或载入/切换字幕文件时重置；减少动效或 `data-motion=off` 时关闭。
- **编辑器设置入场**：每次进入编辑器后第一次切到「设置」页时，`.settings-list` 加 `is-settings-entering`，
  直接子级 `.set-group` / `.st-card` 按 `--settings-i` 以 36ms 阶梯执行 260ms 淡入 + `translateY(8px→0)`；
  后续切回不重播，重置时机与角色列表相同。
- **模型列表入场只播一次**：`#st-models` 由下载轮询每秒重建；动画改由用户切换系列时给父级加
  `is-model-entering` 触发（基础主题 `sf-settings-enter`，UWP `uwp-enter-item`），260ms 后移除。
  `.sf-asr-model` 自身不再常驻动画，否则 UWP 会每秒重播一次缩放/淡入。
- **「模型与配置」卡留白**：`#st-models` 用 `padding-top:16px` 下移（`margin-top` 会和标题的
  `margin-bottom` 折叠，等于没动）；列表底部留 4px，同卡 `padding-bottom` 从 22px 收到 3px，
  使标题到首卡、末卡到卡底都约为 25px。
- **参数面板开关动画**：打开时面板从 `scale(.97)`、`translateY(10px)` 在 220ms 内放大上移到原位；
  关闭时用 `is-closing` 播放 180ms 的 `scale(.94)`、`translateY(-10px)` + 淡出，等
  `animationend`（260ms 兜底）后再 `hidden`，并恢复焦点、解除滚动锁。
  `prefers-reduced-motion` 与 `data-motion=off` 时关闭动画；关闭中途重新打开会取消退场，
  不会被旧定时器收起。
- **字幕列表滚动条**：`#cue-list` 的 thumb 使用 `color-mix(--muted 70%, transparent)`，比全局 25%
  更亮；hover 变为 `--accent`，Firefox 的 `scrollbar-color` 同步覆盖。
- **编辑器设置结构**：`#ass-fx-group` 必须在 `#fx-controls` 后正确闭合，后续「字幕显示 / 角色 /
  导入与音频 / 外观 / 导出」组保持为 `.settings-list` 的直接子级；否则整张后处理卡会吞并后续卡片，
  在窄面板里表现为内容显示不全。设置末尾只闭合 `.settings-list` 与 `#tab-settings`，不能再多一个
  `</div>` 提前关闭 `#app`——否则 `#timeline-panel` / `#hsplit` / `#vsplit` 会被挤出编辑器网格，
  时间轴整块消失。
- **编辑器设置窄宽**：`#tab-settings` 的 range 使用 `flex:1 1 0; min-width:44px` 先收缩，标签
  `min-width:56px`、row gap 8px，右侧 `.setting-val` 保留 `min-width:52px` 与 `white-space:nowrap`；
  拖窄右侧列表时数值不越界。
- **中英上下顺序说明**：`#ass-style-order-val` 通过 `ass-order-row` 独占一行（`flex:0 0 100%`），
  10.5px、左对齐，避免和下拉框挤在同一行折成两行。
- **Material 时钟**：外轮廓为 13 瓣波浪花形（SVG path，`r = 48 × (1 + .042 cos(13θ + π/2))`），外层 `span` 不再用星形 clip-path，轮廓只由 path 承担；时针与分针统一 `stroke-width:7`；SVG 中先画时针、后画分针，重叠时分针在上。
- **Material 需处理卡**：四瓣花形底做成 1:1 方形（宽 ≤190px，与处理中卡同高，避免抬高整行；SVG path，`r = 53.7 × (1 − .145 cos 4θ)`，`preserveAspectRatio="xMidYMid meet"`），底色为 8% danger 混 `--surface`；底形与两个按钮三部分都加 1px `--line` 框线；文字块水平垂直居中；右上 62px 圆形「继续处理」（play，accent 72% 混 surface 的低饱和底），左下 62×62 圆角方形「详情页」（info），两个按钮外移 5px 并压出轮廓。卡片与按钮的阴影只在鼠标悬浮时出现。继续优先打开第一个 attention 项目，没有项目时进入需处理筛选；详情始终进入模板里的需处理筛选。
- **Material 主页悬浮**：除时钟外，`sf-resume` / `sf-orbit` / `sf-mu-widget` / 注意力卡 / 项目卡统一为 1px `--accent` 边框提亮 + `--sf-hover-shadow` + `brightness(1.04)` + `translateY(-2px)`；时钟没有边框，只做 drop-shadow + brightness + 上浮。注意力卡在卡片悬浮时同时提亮四瓣描边和两个按钮边框。
- **新建项目页布局**：`#np-view` 导入模式为左右两列：左列「稿件预览 + 处理进度」，右列「输入与配置 + 生成设置」；两列等高（`align-items:stretch`），上卡顶边同线、下卡底边同线，中段因预览/输入高度不同自然错开，底部卡片 `flex:1` 填满列高。切到**创建初稿**时加 `is-draft`，变成三列：左列仍是预览+进度，中间输入，右下角的生成设置移到第三列并展开；三列按内容高度，底部不再 flex 拉伸，处理进度保持 `min-height:340px`。模式切换只用一个 View Transition：四张卡（输入、生成设置、稿件预览、处理进度）在同一个 `.46s cubic-bezier(.2,.8,.2,1)` 里整体移动/缩放，模式字段在同一次切换中完成；右侧两张不再单独做垂直 height 动画、100ms 停顿或分段展开/收起。`view-transition-name` 为 `np-input` / `np-generate` / `np-preview` / `np-process`。View Transition 处于 top layer；顶栏单独命名 `np-topbar` 并置于 `z-index:999`，卡片动画不覆盖顶栏，同时顶栏与侧栏文字不会被裁掉。减少动效或不支持时直接切换。稿件预览区固定 16:9、封面 `object-fit:cover`。置信度档位说明 `#np-confidence-desc` 用 `.np-conf-desc` 独占一行显示在置信度选项下方，长文案不再挤在选项右侧；「只导入一段」的 checkbox 标签 `.np-lbl-check` 用 auto 宽度 + nowrap，避免在时间范围行折成两行。处理进度卡内加 `.np-progress-box` 小框，`min-height:170px` 向下延伸到 idle 上方，显示当前百分比/状态和处理记录占位；卡片按内容自然增高，不再用固定高度或 flex 拉伸小框。分角色识别标题与「开启」同一行，开启在标题右侧。导入模式下语音识别组整体隐藏时，生成设置卡片说明与「翻译方案」标题之间不再保留空档。识别来源的 `openvino` 显示为「本机 Parakeet TDT V2（Intel NPU）」；说话人数字紧跟标签，与逐词样式/置信度控件左对齐，「区分说话人（中文行标 [SPKn]，按颜色区分）」独占下一行并保持单行。逐词样式下拉 `#np-kstyle` 与置信度下拉同宽（`max-width:230px`），不再撑满整行；选项文案只保留「颜色高亮」「\k 卡拉OK」，去掉括号解释。≤1080px 单列恢复预览 → 输入 → 进度 → 设置的顺序；详细信息页仍用原来的 2×2 网格。
- **弹幕备注条**：输入框、停留时长下拉与发送按钮统一 34px 高；输入框基础圆角 8px，Material You
  下为 12px，与全局输入设计一致。
- **材质偏好**：毛玻璃压暗、模糊度、透明度由 `editor/js/studio-state.js` 保存、`studio.js` 同时算
  深浅色令牌、`studio.css` 末端统一应用，主题包不能绕开。
- **浅色玻璃自动浅色字**：`editor/js/glass-contrast.js` 把卡片自身的半透明背景逐层压到页面底色上
  （图片背景取 16×16 平均色，按 `opacity` 与 `imageDim` 合成），算 WCAG 相对亮度；亮度低于约 0.30、
  浅色字至少 3:1 时给面板加 `.sf-fg-on-dark`，局部覆盖 `--text` / `--muted` / `--line`。
  只在浅色模式生效，深色模式本来就用浅色字。覆盖主题包卡片、设置卡片、项目卡、字幕卡等玻璃表面，
  主题包预览图内部不参与。
- **UWP 特例**：默认 Windows 10 蓝 `#0078D7`；仅在未自定义强调色时使用该默认值，`SSAccent.set()`
  允许覆盖，设置页取色控件保持可用；形状走 2–4px 近直角、无 `backdrop-filter`。
- **Claude 特例**：暖纸底 `#F6F4EE` / 墨色文字 / 陶土强调 `#B0512F`（用户改色时用 `readable()` 兜底），
  容器圆角 14px、控件 10px、胶囊与进度 999px；控件描边走 `--outline`（比 `--line` 深，保证 1px 边界仍可辨识）；
  标题与统计数字用「拉丁衬线 + 中文无衬线」的同一字体栈。三处必须注意的层级：
  ① 共享层的浅色玻璃规则用 `:is()` 里带 ID 的选择器（特异性 1,2,0），会盖掉设计层的 `background`，
  因此 Claude 直接改写 `--sf-glass-*-surface` 为纸色，让压暗/模糊参数在纸面主题下自然失效；
  ② 编辑器的文本输入框（`#note-input`、`#search-box`、`.fr-input` 等）是 ID 级旧规则，设计层用同一份
  `:is()` 清单补 ID 级覆盖，否则圆角与描边会回到旧值；
  ③ `.switch` 是 `label.switch > input + span.switch-slider` 三段结构，基底的 `.switch-slider` 写死深色
  `#2a2a34`，必须整体换掉滑块本体而不是外层 label（label 是 `flex:1` 容器）。
  另外 `palette()` 派生出的 `--secondary-container` / `--tertiary-container` 在 Claude 下会收回到陶土家族，
  避免装饰性残留色。
- **Claude 深色强调色**：内置 seed `#B0512F` 是为浅色纸面调的，直接用于深色只有 2.6:1，
  箭头/计数/链接会糊在深底上，因此深色下换用提亮变体 `#DE8A64`（6.1:1）；不用 `palette()` 的
  `readable()`，因为它会把陶土一路洗成 `#EABEAE` 三文鱼粉。用户自选颜色时仍走 `readable()` 兜底。
- **Classic / Claude 主页**：隐藏右下角重复的「打开稿件库」`.dashboard-foot` 浮钮；`sf-widget-library` 作为第 8 张卡纳入错峰入场（延迟 385ms），与其余卡片同节奏出现。
- **MY 主题包缩略图**：`.sf-pack-art.material .sf-pack-symbol` 改用主页时钟同一 13 瓣路径，缩放到 49px 并在 57px 符号内留 4px 边距，避免左瓣贴边被看成裁切；不再用 24 点星形。
- **Windows 10 / UWP MY 图标**：UWP 把 `.sf-pack-symbol` 缩到 48px，material 花形单独用 42px 路径（3px 内边距），避免 57px 路径被裁掉右/下两瓣。
- **设计层与共享层的特异性战争**（Claude 踩过三个坑，都已用注释标在 CSS 里）：
  ① 共享玻璃层 `studio.css:4190` 的 `:is()` 里带 ID 选择器，特异性 1,2,0，会盖掉设计层的
  `background`——Claude 的解法是把 `--sf-glass-*-surface` 本身改写成纸/墨色，并给必须可见的
  选中态（`.cue-card.selected` 等）加 `!important`；
  ② 设计层自己的「深色表面扫描」与 `.sf-widget[data-tone=accent]`、`.cue-card.selected` 特异性
  同为 (0,4,0)，**谁在后面谁赢**——所以深色归一化必须排在所有状态/色调规则之前；
  ③ 编辑器的文本输入框是 ID 级旧规则，需用同一份 `:is()` 清单补 ID 级覆盖。
- **`--on-accent` 深色兜底按 design 分流**：Claude 用暖褐 `#241B14`，其它主题保持 `#101318`，
  避免波及 Material/Classic/Studio 的自定义强调色。
- **翻译按「序号」收发**（2026-10-21）：`buildTranslateUserMessage` 现在把每行写成 `1. 原文`
  （`llm-text.numberLines`），提示词也要求模型按 `1. 译文` 回。只靠换行分隔时模型容易把两行合成一句，
  行数一少整批就判失败，提示词怎么写都压不住；有序号后可锚定、可归位 —— 解析器新增
  `parseNumberedReply`，只要 1..n 齐全就**按序号重排**（顺序被打乱也能对上），缺号才回落到逐行兜底。
  序号只认行首且在 1..n 内，避免把台词里的「3. 」当序号。
- **降批走阶梯而不是折半**（2026-10-21）：`llm-text.nextBatchSize` 一次砍到 1/3 左右
  （100→25→6→1），因为每一档失败都要付一次完整请求时间（实测 100 行约 90 秒），
  折半会在 50 行这种仍容易失败的档位多耗一轮。档位表 `BATCH_LADDER` 可调。
- **译文解析必须接受「空行」**（2026-10-21 修）：`DEFAULT_TRANSLATE_PROMPT` 第 5 条要求
  「原文为空的行输出空行」，但 `llm-text.js` 的逐行兜底原先无条件 `if (!line) continue` 把空行丢掉，
  行数少 1 → 整批抛 `format` → 严格提示词重试（还是丢）→ 拆半（空行仍在某一半）→ 一路失败。
  现象是**含空行的批次必挂、不含的必过**，与模型随机性无关（用户两篇稿件都复现）。
  现改为保留空行占位、只裁到「刚好 n 行」为止；裁不动再回退到旧口径。回归见
  `tests/parse-line-array-test.mjs` 的【5】。
- **打包不要用 `fs.cpSync`**（2026-10-21 修）：Windows 上源路径含非 ASCII 字符（中文项目目录很常见）时，
  `cpSync` 会让进程 **fast-fail（0xC0000409，无任何错误输出）**，`buildAndInstall` 的打包步骤会静默崩掉。
  已改为 `copyDir()`（mkdir + readdir + copyFileSync，同路径下 copyFileSync 正常）。
  `repair12-build-install-test.mjs` 之前一直「失败但无输出」就是踩的这个 —— 它的临时目录叫「源码」「安装」。
- **处理日志必须有上限**（2026-10-21 修）：`#dp-log` 的基础规则本来就有 `max-height:320px`，
  但 `studio.css` 里 `.ws-panel .dp-log { max-height:none; flex:1 1 auto }` 在 2×2 工作台里把它抹掉了：
  日志一长就把整个网格往下顶、整页变长（用户截图）。现改为
  `max-height: clamp(160px, 38vh, 420px)` + `overflow:auto` + `overscroll-behavior:contain`：
  内容少时撑满面板，内容多时自己滚，页面高度不再随日志增长（实测 200 行日志：日志框 306px / 可滚内容 3814px / 页面高度 = 视口）。
- **「生成设置」两处同形**（2026-10-21 修）：新建项目页 (`#np-view`) 与详情页 (`#details/:id`) 共用同一套
  2×2 工作台骨架，但右侧 GENERATE 面板长期是两套 UI——新建页是「翻译方案」卡片，详情页直接摊开
  「翻译模型 / 模型名称 / 翻译提示词 / 角色分析提示词」。用户在同一位置看到两种形态，会以为详情页是
  「回退到了老版本」。现统一为：两处都给「翻译方案」列表（同一份 `savedSchemes`，渲染函数 `renderDtSchemes`
  与 `renderNpSchemes` 共用卡片样式），手改参数收进 `details#dt-advanced`「高级 · 自定义翻译参数」。
  改模板要跑 `node tools/generate-studio.mjs` 重新生成 `editor/studio.html`，不能只改生成物。
- **卡片操作区按钮个数是 3 或 4**：`#home` 的 `.pc-actions` 里「更多」恒在、「重试/翻译」按状态出现、
  「打开」「删除」恒在。UWP 曾用固定三列网格，4 个按钮时会把「删除」挤到第二行、只剩 1/3 宽
  （用户截图报的「突出来一块」）。已改为等宽 flex：文字按钮 `flex:1 1 0`、图标按钮定宽 30px，
  3 个和 4 个都只占一行；「重试」在卡片内退成描边按钮，避免和「打开」两个实心强调色打架。
- **仪表盘网格：跨行与跨列必须成对考虑**（2026-10-20 修）：`.sf-widget[data-widget=settings]`
  与 `[data-widget=library]` 基础层各写 `grid-column: span 2`，这套账只有「主卡只占 1 行」的
  基础布局（Studio / Material / Classic）才配得平：`2+1+1` 与 `2+2` 都能凑满 4 列。
  **UWP 的主卡 `.sf-widget-resume` 跨 2 行**，网格少一行可用空间，第 3 行 `2+2` 会把稿件库挤到
  第 4 行、独占两列并空出右半边；因此 UWP 下这两个磁贴必须退回 `grid-column:auto`（`2+1+1=4`）。
  改这条规则前先数一遍「主卡占几行 × 后面还有几个 span 2」。
- **设置分类**：全局设置六个一级分类为「外观与体验 / 语音识别 / 翻译与术语 / 识别与校对 / 下载与登录 /
  性能与调度」；ASS 双语样式与后处理固定在稿件的 `#tab-settings`，不进全局设置。
- **性能页卡片间距**：`#perf-dual-view` 里「双引擎分工性能测试」与「当前已应用的配置」是两张直接相邻的
  `.st-section`；`.st-panel` 的 flex `gap` 只作用到 `.perf-view` 这一层，两张卡片之间因此没有间距。
  现由 `.perf-view { display:flex; flex-direction:column; gap:16px }` 提供垂直间距（与其它设置面板一致），
  `.perf-view[hidden]` 仍保持 `display:none`。不要改成给 `.st-section` 加 margin —— 设置页卡片规则带
  `#st-view` ID 且写死 `margin:0`，普通选择器会被覆盖。
- **设置保存位置**：设置页不再渲染底部全局动作栏，改由「识别与校对」面板末尾的 `.st-panel-actions`
  手动保存热词与强度；其它分类即时保存。`#st-msg` 作为设置页浮动状态（`.sf-settings-status`），
  无消息时不占位，不再留下空框线；`#st-cancel` / `#st-test` 仅保留隐藏的 DOM 兼容节点。
- **设置作用域**：字体/字号/颜色等 ASS 设置写入当前项目稿件，后处理特效属本机偏好；文件夹只在浏览器
  本地记录分组，不移动 `projects/` 实际文件。
- **原型隔离**：`prototypes/` 各原型只用合成数据与独立命名空间，不连接真实 API、设置或 `projects/`；
  其模拟识别/进度数据不得当作真实引擎结果。

## 5. 测试与验证

- **JS 全量回归**：`node tests/run-all.mjs`；带机器可读报告：
  `node tests/run-all.mjs --report _test/maintenance/js-results.json`。入口先跑 `tests/gen-fixture.mjs`
  生成 ASS 夹具，再**串行**执行 `tests/` 根目录的 `.mjs`，默认注入 `SUBFABRIC_TEST_ISOLATED=1`、
  `PYTHONDONTWRITEBYTECODE=1`，不连接默认 8321 服务、不写用户设置或稿件。报告只记录本轮结果。
- **只跑单项**：`node tests/run-all.mjs secret-store-test.mjs translate-schemes-test.mjs`。文件名须匹配
  `^[\w-]+\.mjs$`，`gen-lang`/`gen-fixture`/`ass-fixture`/`run-all` 这些 helper 不可选。
- **结果口径**：`passed` / `partial` / `diagnostic` / `failed`。`partial` 表示输出出现跳过标记
  （缺素材、私有夹具或 GUI/硬件限制），不算完整通过；`diagnostic`（`rows-timeline-test.mjs`）是诊断脚本，
  不计入断言通过数；`EXCLUDED` 固定排除 `colorfix-test.mjs`（需真实用户项目）与
  `font-status-test.mjs`（需真实 GUI 与项目）。单项超时 180s；有 `failed` 时退出码 1。
- **ASR 纯逻辑单测**：`tests/faster-whisper-test.mjs`（XXL 参数跨版本、JSON → segments、进度解析）、
  `tests/glossary-repair-test.mjs`（术语表修复的命中与误伤边界）、`tests/welcome-model-test.mjs`
  （CUDA/Vulkan/NPU/云端模型的可见性、双引擎依赖、其它模型、过滤后默认选择）、
  `tests/glass-contrast-test.mjs`（玻璃背景 alpha 合成、相对亮度、对比度与浅色前景阈值）、
  `tests/asr-params-test.mjs`（模型参数 schema/默认值/范围校验/`multipleOf` 吸附/重置语义；
  已停用引擎的旧 schema 保留但模型不可达）、
  `tests/asr-params-api-test.mjs`（隔离服务上的 GET/POST 保存、状态摘要、恢复默认，退役模型返回 400）、
  `tests/asr-model-args-test.mjs`（参数 → 命令行 → worker argparse 的静态契约；含已停用引擎的旧分支，
  只验证静态拼接，不代表模型仍可运行）、
  `tests/asr-bench-repair-test.mjs`（速度测试工作目录不得落 `%TEMP%`、退役引擎统一兜底与安装接口拒绝）。
  这些测试不加载模型、不需要 GPU。
- **文案覆盖**：`tests/i18n-coverage-test.mjs` 用 `tools/lib/copy_scan.mjs` 重扫
  `editor/studio.html`、`editor/js/*.js`、`editor/server.js`、`editor/asr-params.js`、`editor/scripts/*`，要求每条
  用户可见中文都能在 `editor/lang/zh-CN.json` 找到键；`node tests/gen-lang.mjs` 负责补齐/保留用户润色。
- **兼容别名**：`node tools/repair15-regression.mjs` 内部转发到同一实现，参数相同。
- **Python 隔离回归**：先设 `$env:SUBFABRIC_TEST_ISOLATED='1'; $env:PYTHONDONTWRITEBYTECODE='1'`，
  再对 `confidence-test`、`draft-role-gap-test`、`fetch-format-test`、`glommed-split-test`、
  `frame-units-test`、`asr-segment-parity-test`、`vibevoice-worker-test`、`diarize-wav-test` 逐个执行
  `python -B tests/<名>.py`。
- **静态检查**：全仓 JS 用 `node --check` 遍历 `editor/`、`tools/`、`tests/`（跳过 `vendor/`、`jsmod/`
  镜像与依赖目录）；Python 用 `ast.parse`。开发期另跑 ESLint、Ruff：`npx --yes eslint@9 editor/ tools/ tests/`
  与 `ruff check .`（配置见 `eslint.config.js`、`ruff.toml`），二者都不是运行时依赖。
- **其它探针**：`tools/route_smoke.mjs`（24 路由，需先起服务）、`tools/http_layer_probe.mjs`
  （自带服务但会写同树数据，只在隔离副本执行）、`tools/studio-install.mjs --prepare` /
  `--apply <backup-directory>`（候选、备份、锁与回滚）。
- **夹具与镜像**：`tests/jsmod/` 镜像按内容比对补齐、互不清空，跑完恒等于源；改过源码后镜像要与源码
  一起提交。先记录已有修改，只提交属于当前任务的镜像差异。
- **CI**（`.github/workflows/ci.yml`，push 到 main 与所有 PR，同分支连推取消旧任务）两个 job：
  `JS · ESLint + 全量测试` 在 ubuntu-latest + Node 22 上跑 `npx --yes eslint@9 editor/ tools/ tests/` 与
  `node tests/run-all.mjs`；`Python · ruff + 单测` 在 ubuntu-latest + Python 3.12 上 `pip install ruff numpy`
  （刻意不装 sherpa-onnx/openvino），跑 `ruff check .` 并逐个执行上面那 8 个可移植测试文件。
- GPU、模型、真实媒体或服务依赖必须具备后才做相应验收。造测试媒体用 ffmpeg lavfi 的 `testsrc`，
  必须加 `sine` 音轨，否则抽音轨失败。

## 6. 打包与发版

- 只发 Inno Setup 安装包 `SubFabric-<版本>-setup.exe`，不再出便携版 zip。链路：
  `node editor/scripts/fetch-vendor.js` → `python build_exe.py` →
  `"<Inno Setup 目录>\ISCC.exe" build/installer/SubFabric.iss`。
- `build_exe.py` 生成 Node 22 SEA 单文件 `build/SubFabric.exe`（内嵌 `editor/scripts/sea-launcher.cjs`；
  会按需跑 `gen_app_icon.py` 刷新 `logo.ico`，再用 rcedit 把图标与版本资源嵌进 exe——在注入 SEA blob
  之前）。Node 依次取 `SUBFABRIC_NODE` → PATH → 托管 Node → 常见安装路径，首次需联网下载 node.exe。
- `build/installer/SubFabric.iss` 把 `build/SubFabric.exe`、`main.py`、`start-editor.*`、`editor\*`、
  `asr\*` 等收进安装包，并排除 `projects/`、`asr\.venv`、`asr\models`、`settings.json`、`whisper.cpp`、
  `crispasr`、`faster-whisper-xxl`、`runtime-python`、`ytdlp`、`logs` 等用户数据与运行时。入库的只有
  `build/installer/{SubFabric.iss, logo.png, logo.ico, start-editor.*}`。
- **三处版本号必须同步**（漏一处会出现"装完版本还是旧的"）：`editor/server.js` 的 `APP_VERSION`
  （显示版本，如 `beta 1.3`）与 `APP_FILE_VERSION`（Windows 文件版本，四段纯数字，如 `1.3.0.0`）；
  `build/installer/SubFabric.iss` 的 `MyAppVersion` / `MyAppFileVersion`；git tag / Release tag。
  `.iss` 的 `VersionInfoVersion` / `VersionInfoProductVersion` **只接受纯数字**，一律填
  `MyAppFileVersion`；显示版本只走 `AppVersion` / `AppVerName` / `VersionInfoProductName`。
- **推进规则**（发版前必读）：0）先取远端最新 tag 核对三处是否已对齐，对不上先补齐；1）同版本修补重发
  ——显示版本与文件版本不变，只把 tag 的 beta 序号 +1；2）开新 beta（默认推进）——次位 +1：显示
  `beta <主>.<次+1>`、文件 `<主>.<次+1>.0.0`、tag `v<主>.<次+1>.0-beta.1`；3）转正——显示版本去掉
  `beta ` 前缀、tag 去掉 `-beta.<序号>`、Release 取消 prerelease；4）稳定版之后——修复/小改抬补丁位、
  新增模块抬次位、架构级改动须用户确认才动主位；5）撞号检查——推出的号必须与远端 tag 列表比对。
  `beta <主>.<次>` 读作"`<主>.<次>` 的 beta"，显示版本与 tag 用同一个 `<主>.<次>`。
- **Release**：只上传 setup.exe 一个资产，发完核对 `assets[].digest` 与本地 sha256 一致。
- **静默安装自检**：`/VERYSILENT ... /DIR=<临时目录>` 会被 Inno 默认的 `UsePreviousAppDir` 顶掉，
  本机装过 SubFabric 时实际上是一次原地覆盖升级（`[Files]` 不含用户数据，属无害），但要知道它确实换了
  用户机器上的版本；真要隔离得临时给 `.iss` 加 `UsePreviousAppDir=no` 重编。
- **构建稳定性**：刚写出的约 90MB exe 会被杀毒/索引短暂占用，rcedit 报
  `Fatal error: Unable to commit changes`；`build_exe.py` 的 `embed_icon_and_version` 已做短重试
  （0.4–2.0s，最多 5 次），真失败仍退出。
- **升级原地覆盖**：`SubFabric.iss` 三路检测已有安装目录（Inno 的 `UsePreviousAppDir` → 注册表 AppId →
  扫盘），结果预填到目录页；不要把 `DefaultDirName` 写成 `{code:...}`（会顶掉命令行 `/DIR`）。
- **安装包与已停用运行时**：`SubFabric.iss` 现在排除 `asr/runtime-vibevoice` 以及
  `multitalker.py` / `vibevoice.py` / `asr_dual.py` / `asr_perf.py`，不会再打包约 2.2GB 的
  VibeVoice 运行时；用户已下载的旧目录不会被安装/卸载碰到。
- **改了后端 / 前端代码后正式版必须重打包**：源码运行重启即生效；已安装版是 SEA 单文件
  `SubFabric.exe`，不重跑 `python build_exe.py` 与 ISCC 不会带上修复；版本号仍按上面的三处同步规则推进。

## 7. 功能与设计结论

### `\k` 逐词字幕

- 单一数据模型 `words[] = {w, s, e}`（秒），两条序列化通道：颜色覆盖切片（旧）与 `\k` 卡拉OK（新）；
  分析时两种形态都还原为同一 `words[]`，编辑管线完全复用。
- 逐句判定形态并存 `sentence.karStyle: 'color' | 'k'`（文本含 `\k` → k，含 `{\c&H..&}词{\c}` → color）；
  整轨默认值写 ScriptInfo 元数据 `SubFabricKaraokeStyle`，与 `SubFabricWordStyle` /
  `SubFabricWordHighlightColor` 同一惯例。混合文件天然支持。
- `\k` 时长单位是厘秒；k 模式下词时间吸附到 10ms 网格，保存↔重载严格往返、误差不累积。
- 解析：`parseKLine(text)` 逐 `{\k..}` 段推进游标，段文本非空 → 一个词，无文本段 = 空档 filler；
  `\kf`/`\K`/`\ko` 读入时按段时长等价处理并记录原标签写法（`kTag`）供重建沿用。
- 生成：`buildWordSpecs` 是按 `karStyle` 分派的分发器（原实现改名 `buildWordSpecsColor`，新增
  `buildWordSpecsK`），13 个调用点零改动。
- k 行是单事件整行：行首自包含颜色头 `{\1c<已唱色>&\2c<未唱色>&}`，随后是句首 filler、每词一段、
  词间空档 filler、行尾 filler；段时长用 `Math.round(差*100)` 且下限 1，段总和严格等于行时长。
- 用 filler 而非"连排"：`\k` 没有"熄灭"语义，连排会丢掉词间空档的 `e`。
- 明文零重排：解析时按裸文本原样拼接并记录位置，重建按"原文位置 → 应用分词口径 → 词+空格连排兜底"
  三级回退，外来文件的任意空格布局都能逐字节往返。
- 末词不强贴行尾：正常编辑路径本就保证末词 `e == 句尾`，尾部留空由行尾 filler 吸收残差。
- k 行的"缺词"校验不能用 `splitEnglishWords`，改用 `kLineTokens(sent)`，否则打开外来 k 文件会整轨误报。
- 中英时间自愈对齐对 k 行必须走 `replaceEvents(events, buildWordSpecs(en))` 重建，不能逐条 `setEventTime`。
- 新建初稿由**服务端直接产出 `\k`**（初稿在后台跑、用户可能已关闭页面）；`editor/k-line.js` 与编辑器
  `buildWordSpecsK` 同格式，二者一致性由交叉单测守着。

### 颜色设计

- 已唱 = 逐词高亮色（现有设置，默认绿）；未唱 = 说话人色（该行有角色时）否则英文主色（默认白）。
- 采用行内 `\1c/\2c` 自带颜色头，不动样式表：只影响该行、随文件走、导出即生效。
- 两色都可自定义：已唱色复用「逐词高亮色」全链路，未唱默认色是同款选择器（无角色行才生效）。
- 角色换色改 `\2c`、全局换高亮色改 `\1c`，且**绝不碰 k 行行首的 `\1c/\c`**（那是已唱色，不是角色色）。
- 唯一观感差异：颜色模式是"当前词瞬时高亮、空档可熄灭"，k 模式是**高亮累积、唱过不灭**（标准卡拉OK观感）。

### 特效兼容（Glow / Fade / Grow）

- 整行淡入（`\fade`）与整行微光（`\4c/\4a/\blur`）：颜色模式与 `\k` 模式都支持，`postprocess.js` 无需改动。
- 活动词微光 / 词生长：k 行暂不能表达（`\k` 没有"词级活动态"可包裹，且 `\t` 是项目明令禁区）；
  生成器对 k 行自动跳过。
- **Grow（词生长）已暂停**：模板中整段控件注释、生成产物同步注释、初始化强制 `grow.enabled=false`，
  旧 localStorage/项目配置也不会再生效；生长引擎与旧存档解析保留，生产 UI/运行时不可达。Glow/Fade 仍在。
- `stripEffectTagsSafe` 对 k 行逐字节零改动。

### 双引擎（NPU + GPU）

> **2026-10-21 起已停用**：`parakeet-tdt-0.6b-v2-dual` 模型、`/api/asr/dual`、`/api/asr/perf/*`
> 和设置页的双引擎页签均已关闭；以下保留为历史设计记录，不能再作为当前行为依据。

- **最终结论（历史）：双引擎有效**，比最快的单引擎再快，NPU 与 N 卡分工并行是净收益。
  2026-10-08 那份「双引擎在本机没有收益、用 GPU 单引擎就够」的判断**已被 2026-10-11 复测推翻**，只作历史记录。
- 反转原因是代码变了而非测量噪声：旧版走 8 秒分片 + 每片重载模型，且 NPU 侧时间戳单位有错；当前版本
  单窗口 15.01s、时间戳覆盖整段。结论有时效性——**复测要重跑，不能引用旧数字**。
- 分工约定：NPU 侧只碰 NPU + 核显（`--joint GPU.0`），N 卡整块留给 sherpa 侧。注意两套设备编号含义相反
  （OpenVINO 的 `GPU.0`=Arc 核显、`GPU.1`=RTX 4060；CUDA 的 `cuda:0`=RTX 4060）。
- joint 设备以 `GPU.0` 为最优（当前默认），挪到 CPU 或独显都更慢，**别按"独显更快"的直觉改**。
- 质量结论：不同配比跑出的前 40 秒词序列逐词一致，合并时间轴没有引入重复或错序。
- NPU 的账：算力不是瓶颈，时间主要花在逐帧串行的 TDT 主循环上；`full` 置信度档的稳定性重跑（加噪再跑
  两遍）是最大单项开销，现已改为一次识别内缓存编码结果（键为 `(窗口偏移, 窗口长度)`），编码器调用 3→1 次，
  词表与置信度逐位不变。窗口重叠合并逻辑逐字保留。
- 尚未做：三遍解码仍串行（`InferRequest` 非线程安全，OpenVINO 异步实测更慢）；`_tdt_loop` 的
  reshape + softmax 固定开销值得优化；双引擎没走常驻识别服务，短音频因重载模型不划算。

### ASR 准确率（Whisper large-v2 与 Parakeet 实测）

**口径**：`How I Saved the World's Largest Minecraft Server.webm` 前 10 分钟；参考文本由
`人工精校的字幕（前两小时）.ass` 还原（去掉颜色标签、按相同文本合并逐词事件）；WER 比较前做
大小写、标点、撇号与数字统一，不比较时间轴。数字只对本机/本段素材有效，换素材必须重跑。

| 引擎/配置 | WER | 说明 |
| --- | ---: | --- |
| Whisper large-v2（无 MDX，无 VAD） | 19.38% | 只有 VAD 时实测；人声分离是分水岭 |
| Whisper large-v2（MDX + VAD 0.05） | 8.70% | 「卡卡」参考设置；VAD 会切掉 31 词 |
| **Whisper large-v2（MDX + 关 VAD）** | **7.74%** | 当前默认；逐词 1740 |
| + 术语表拼写修复 | **7.23%** | 只修专名；不动时间轴 |
| Whisper 后接语义分句（完整初稿） | 8.36% | 分句会重拼词/标点，口径与原始转写略有差异 |
| Parakeet TDT 0.6B v2（greedy） | 11.02% | 原默认 |
| + `blank_penalty=0.5` | 10.68% | 减少漏短词；0.7 为 10.62，取 0.5 更稳 |
| + 术语表拼写修复 | **10.34%** | 当前默认 |
| Parakeet NPU（滑窗，携带 LSTM 状态） | 27.06% | 成片漏词 |
| Parakeet NPU（每窗口重置状态） | **22.99%** | 当前默认；重叠 400 帧无进一步收益 |
| Parakeet NPU（dual 固定 15s 分片） | 19.66% | `asr_dual.py --ratio 0:1`，分片边界仍丢词 |

**结论（必须如实记录）**：本段素材上 **Whisper large-v2 仍比 Parakeet 准**。参考 ASS 本身由
WhisperX（Whisper large-v2 + 对齐）+ 人工修正生成，Whisper 在专名/上下文上有先天优势；Parakeet
的强项是速度（10 分钟约 33 秒 vs Whisper 约 2 分钟）与不需要 MDX。**没有**把「Parakeet 准确率
高于 Whisper」写成结论，也没有用双引擎拼接去伪造这个数字：Parakeet+Whisper 交叉校验实测
8.08%~9.2%，反而比 Whisper 单引擎差，所以未启用。

**Whisper large-v2 的实现约定**：
- 运行时 `Faster-Whisper-XXL`（`asr/faster-whisper-xxl/`，约 4.4GB 解压 / 1.4GB 下载，服务端按需
  下载并用 `editor/scripts/7z.exe` 解包）；模型 `Systran/faster-whisper-large-v2` 放
  `asr/models/faster-whisper-large-v2`（CTranslate2，3.09GB），XXL 用
  `--model large-v2 --model_dir <父目录>` 加载。
- 默认参数：`--ff_mdx_kim2`（r245.3+ 自动换 `--ff_vocal_extract mdx_kim2`）、`--vad_filter False`、
  `--word_timestamps True`、`--language en`、**不给 `--initial_prompt`**。实测把专名表当 prompt 会
  让 1740 词的转写塌到 1528 词、WER 17.34%，专名改由识别后的术语表修复处理。
- 输出 JSON → `{segments:[{start,end,text,words,confidence}]}`，与 `asr.py` 同构，
  后面复用同一套 reseg / 置信度 / ASS 生成。

**模型参数设置（Whisper 等）**：设置 → 语音识别 → 模型行上的「参数」打开独立模态面板，
  显示每个字段的**当前值**与**默认值**，支持保存和「恢复默认」。参数存在 `asr/settings.json`
  的 `modelParams[modelId]`，不写进项目；新建初稿、长音频分片和选区重新识别都读当前值。
  - Faster-Whisper-XXL：识别语言、VAD 开关 / 阈值 / 方法（pyannote v3、Silero v3–v5、WebRTC）、
    MDX 人声分离、逐词时间戳、识别提示词。
  - CrispASR/Parakeet（Vulkan）：CPU 线程数、词时间戳阈值。
  - Qwen3-ASR：分块长度（默认 150s，30–240）、ASR 最大生成 token（默认 4096，1024–8192）。
  - Parakeet NPU 没有可安全暴露的参数：稳定性重跑遍数由置信度档位统一控制，线程数由 OpenVINO
    自管，所以不显示「参数」按钮。
  - **已停用**：whisper.cpp、Parakeet CUDA（sherpa-onnx）、VibeVoice 的 schema 保留在
    `editor/asr-params.js` 作为回滚参考，但模型条目已注释，`GET/POST /api/asr/params` 对它们返回 400。
  - schema / 默认值 / 范围校验集中在 `editor/asr-params.js`（支持 `multipleOf` 吸附）；
    `GET/POST /api/asr/params` 读写。参数面板使用独立模态而不是行内展开，因为下载轮询每秒重建
    模型列表，行内输入会丢焦点。
  - 参数在命令行只由 `asrEngineArgs` / `asrArgsFor` 落一次，初稿、分片、选区重新识别、
    全模型速度测试共用；常驻识别服务把线程数与 blank 惩罚计入 worker 键，改参数会另起进程，
    不会静默沿用旧设置。
  - 默认值保持现有实测口径：VAD 默认关（避免漏掉轻词）、MDX 开、逐词开、Whisper 提示词默认空。

**全模型速度测试**：设置 → 性能与调度 →「全模型速度」（双引擎页签已于 2026-10-21 停用）。
  - 从 `/api/asr/status` 读取 `ready` 的本地模型（排除云端与退役引擎），勾选后逐个测试；
    默认勾选当前 `usable` 的模型，可刷新、全选、清空。当前只有 Faster-Whisper、Parakeet Vulkan、
    Parakeet NPU 三类本地模型。
  - 测试音频可复用项目 `audio.wav`（自动查找）或手动选择；截取开头 5–600 秒，
    每个模型串行跑一次，避免多模型同时抢 GPU。
  - 结果表列出模型、**识别耗时 / 后处理耗时 / 总耗时 / 倍率 / 平均置信度**：倍率 = 音频秒数 /
    实际总耗时（识别 + 已开启的后处理，含模型加载），按实际倍率从高到低排列；失败模型单列错误原因。
  - `details:true` 时结果额外返回每个模型的识别文本（横评脚本据此算 WER）；普通 UI 不传，避免状态膨胀。
  - **测试条件**（与创建稿件页对齐）：逐词、置信度（完整 / 快速 / 关闭）、分角色识别、说话人区分 +
    说话人数。逐词只对可关闭词时间戳的引擎生效（Faster-Whisper-XXL）；置信度「完整」会给
    Parakeet NPU 加 2 遍稳定性重跑；分角色识别以说话人区分为前提（勾选分角色会自动勾上说话人）。
  - 后处理与模型无关：同一段音频只测一次，时间加到每个模型的 `postSec`/`totalSec`。
    说话人分离用 `diarize.py` 实测；分角色识别用第一份成功结果跑与创建流程相同的两步 LLM
    （会调用用户已配置的 LLM，可能产生费用；未配置/已关闭时跳过并在结果下方说明）。
  - `POST /api/asr/bench/start`、`GET /api/asr/bench/state`、`POST /api/asr/bench/cancel`
    使用独立模块状态；`conditions` 随状态返回，刷新页面可恢复。
  - 支持引擎：OpenVINO NPU、Faster-Whisper-XXL、CrispASR、Qwen3-ASR + 对齐。已停用的 sherpa-onnx /
    whisper.cpp / NeMo / VibeVoice / dual 即使被旧前端点名，也会被 `RETIRED_ENGINES` 和
    `benchSupported` 拒绝。
  - **测试工作目录固定为 `projects/.bench/run-*`**，测完删除；**不能放 `%TEMP%`**：
    Faster-Whisper-XXL 的 PyInstaller 子进程写 `%TEMP%` 下的 `input.json` 会报
    `PermissionError: [Errno 13]`（同一段音频只换输出目录即可复现；写项目目录正常，见
    `runFasterWhisper` 的 `outRoot` 约定）。`.bench` 以点开头，`validId` 不接受，不会被当成项目。
  - 失败行只保留 Faster-Whisper 运行时的应用内修复入口；VibeVoice 修复入口已随模型停用。
  - 倍率只代表本机这次测得的吞吐，不代表准确率；不同模型适合的素材不同。

**运行时修复（历史：VibeVoice / Faster-Whisper；VibeVoice 已停用）**：
  - 以下 VibeVoice 记录只作历史参考；模型与运行时安装接口已于 2026-10-21 停用。
  - VibeVoice 的 `bitsandbytes` 单独补装（`bitsandbytes==0.50.2`），与
    `transformers==5.17.0` / `accelerate` / `soundfile` / `soxr` 分两段执行：镜像源缺 wheel 时
    用 `--extra-index-url https://pypi.org/simple` 兜底；bitsandbytes 失败会明确报错，
    其它依赖已装好，下次只需补缺的那一段。
  - 模型行在「运行时只装了一部分」时把按钮显示为「修复运行时」；已满足的包 pip 会跳过，
    不会重下 2.2GB。安装结束仍以 `probeVibeVoice(true)` 的真实 CUDA/NF4 预检为准。

**音频预处理约定**：新项目 ASR 默认用原声 `mode='raw'`。项目里原本默认 `afftdn` 降噪，实测
Whisper large-v2 的 WER 8.70% → 11.02%、Parakeet 11.02% → 11.19%；降噪版仍保留给「降噪模式播放」
和用户显式「重新生成音频」。

## 8. 下载内核（`asr/fetch/`）

给「下载初稿流水线」用的 bilibili / YouTube 下载内核：粘贴链接 → 下载进项目目录 → 接着跑初稿。
`yt_format.py` / `bili_format.py` / `priority.py` 提供画质档位表与选择器构造（纯标准库），`selector.py`
把界面档位翻成 yt-dlp `-f`（bilibili 默认 1080P 优先、只降不升，YouTube 保留通用兜底），`ytdlp.py` 从
PyPI 自举官方 wheel 到 `asr/ytdlp/`（不入库/不进安装包），`bilibili.py` 只留 URL 判定与 Cookie 解析，
`fetch_cli.py` 走"解析 → 下载 → 元数据 → 逐行 JSON 进度"协议。登录态只复制 `SESSDATA` 值，Cookie 落
项目目录 `_bili_cookies.txt`，桌面设置里密文保存（Windows DPAPI / 其他平台 AES-GCM），绝不写日志；
元数据写 `source.json` 供 LLM 分角色推断阵容。验证见 `tests/fetch-format-test.py`，`--simulate` 只解析不下载。

## 9. 工作约定与红线

- **读数规则**：新任务或上下文压缩后恢复，先读本文件与被引用的代码，再看 `AGENTS.md`；按当前任务读完整
  需求/计划/相关设计与代码，首次建立认识、后续只核对变化，不遍历模型、运行时、依赖、构建产物或无关历史。
- **状态用词**：`未开始` / `进行中` / `已实现但未验证` / `已完成且已验证`；GitHub 保存用词：
  `尚未提交 GitHub` / `云端提交成功且已核对` / `提交失败或受到阻塞`。测试失败、未运行与跳过必须写明；
  历史验证与本次验证分开；提交成功不能代替功能验收。
- **文档职责**：本文件承担结构、流程、约定与设计结论；`AGENTS.md` 承担长期工作规则；`README.md` 面向
  用户。结构、职责、接口或数据流变化要同步更新本文件 §2–§4。文档与代码冲突时先核实并以代码为准。
- **代码红线**：不引入前端构建步骤或 npm 依赖；不把 `server.js` 拆成多文件；跨请求状态不得放进路由段
  函数体；新增后台任务必须有超时/看门狗与异常收尾；新增用户可见文案进 `editor/lang/zh-CN.json`（键=原文）。
- **敏感值**：统一走 `editor/secret-store.js`（DPAPI 密文，降级 AES），不进命令行参数、不进日志、
  不回传前端；临时明文文件用完即删。文档中不写凭据、隐私或无必要本机绝对路径。
- **不提交用户数据与大文件**：`projects/`、`asr/settings.json`、`asr/models/`、`asr/runtime-python/`、
  `editor/vendor/` 等已被 `.gitignore` 排除。
- **保留用户资产**：保留所有原文件、已有修改、项目数据与历史快照，不清理运行环境；验收不得改写真实
  用户稿件。只改源码仓库，安装版另做带备份与回滚的局部合并，不整体覆盖安装目录。

## 10. GitHub 云端里程碑

- 目标仓库固定为 `EndiVee233/SubFabric`；本地 `origin` 的 fork 不改变该目标。只用已有 GitHub 连接器、
  GitHub API 或已认证的 `gh api` 写入：**不初始化仓库，不本地暂存、提交或推送**。按项目分支约定；
  没有约定时读取仓库默认分支（不假定叫 main/master）。
- 并发校验：优先多文件原子接口 + 预期 HEAD，例如 GraphQL `createCommitOnBranch.expectedHeadOid`；
  用 REST Git Data API 时必须保留 base tree、显式父提交、非强制更新。远程前进或内容冲突时重读核对，
  无法安全分离的文件暂缓并记录；不用整个本地目录覆盖远程，不把本地缺失当远程删除。
- 提交门槛：记录相关文件基线与远程 HEAD → 审阅实际差异并分离用户已有修改 → 执行阶段相关验证 →
  更新状态记录 → 重读远程 HEAD 与相关文件、比较基线与并发变化 → 确认只纳入归属本任务的改动 → 提交。
  相关代码、测试与文档尽量一次原子提交；不为刷新日期、自填 SHA 或无实质变化制造提交。
- 提交前排查敏感信息、隐私、无关修改、运行时与大文件，不输出敏感值；发现问题暂停受影响内容。
  不强制更新引用、不改写历史、不删分支/标签、不绕过保护或检查；不创建其他仓库/Release、不改可见性、
  不擅自合并其他分支。
- 用户明确要求 PR 时，才在已有且有写权限的 fork 里从最新上游基线开独立分支、经云端 API 提交并向指定
  上游发起 PR，不改 fork 默认分支、不夹带其他提交、不自动合并；fork 保存、PR 创建、上游合并分别核对。
- 提交后核对目标仓库与分支确含该提交、实际文件内容与范围一致、范围外内容未变；部分成功逐项核对、
  不盲目重试。无认证或写权限时记录具体阻塞、未提交内容与恢复入口，继续可做的工作；不切换成本地提交
  推送，不要求用户粘贴密码/令牌/私钥。不创建、修改、启用或信任任何 Hook。

## 11. 视频导出（硬字幕 / 生肉 / 字幕）

编辑器「设置 → 导出 → 导出视频…」打开导出对话框：选一个导出目录，勾选要产出的内容（可多选同时导出）。

| 选项 | 产出 | 说明 |
| --- | --- | --- |
| 双语言硬字幕视频 | `<稿件名>_双语.mp4/.mkv` | 把字幕**永久烧进画面**，逐词高亮、角色色、微光/淡入全部按稿件的 ASS 样式渲染 |
| 生肉（原视频） | `<稿件名>_生肉<原扩展名>` | 复制原片。链接下载的视频本就在项目目录里，复制一份到目标目录 |
| 字幕文件 | `<稿件名>_字幕.ass` | 当前稿件的 ASS（含你在设置里调好的样式与已启用的特效） |

### 关键约定

- **样式默认继承稿件**：压制不重新生成样式，而是直接烧稿件字幕。用户调过的字体/字号/颜色/逐词高亮色
  全在那份 ASS 里，所以对话框只问"怎么编码"，不问"长什么样"。
- **特效必须由前端烘进去**：微光/淡入的配置存在浏览器 localStorage，服务端读不到。前端先把
  `applyPostProcess` 应用到字幕正文，随请求以 `subtitleText` 送过去；服务端优先用它，取不到才回退磁盘稿件。
  没有这条，"压出来的画面"和"编辑器预览"会对不上。
- **不改写用户稿件**：内联正文落到临时目录；生肉是复制；只有显式勾选 `overwrite` 才覆盖同名产出。
- 同名文件默认拒绝覆盖并给出明确原因，避免误删。
- **大字幕正文**：`subtitleText` 可能到几百 KB 甚至几 MB，导出路由单独放宽到 **32MB**；其它 API 仍保持
  64KB 上限。压缩失败和取消都会删除写了一半的成片/生肉，不让半成品冒充成功。
- **检测与结果**：打开对话框时先禁用「开始导出」并显示“正在检测本机的编码器…”，探测完成后才允许；
  完成后在对话框里列出产出文件名与完整路径。`ffmpeg` 从缺失恢复后，加速下拉会重新启用。

### 实现位置

- `editor/hardsub.js`（后端 CJS）：硬件编码探测与回退、垫背事件注入、滤镜链、进度解析、成片自检。
  逻辑取自同作者的 [hardsub-py](https://github.com/EndiVee233/hardsub-py)，内嵌后用户不用再装那个 CLI。
- `editor/ffmpeg-tool.js`（后端 CJS）：ffmpeg/ffprobe 定位与按需自动下载（见下节）。
- `editor/server.js`：`/api/projects/:id/export-video` 及其 `capabilities` / `status` / `cancel` 子路由。
- `editor/js/export-video.js`（前端 ESM）：对话框 DOM、目录选择、进度轮询、能力展示。

### 加速方案：GPU 优先

**用户明确要求的口径：压制首先选用 GPU，而不是 CPU。** 优先级 NVIDIA → AMD → Intel → CPU。

- **必须按"厂商 × 编码格式"逐项判断，不能只看厂商**。实测 RX550：`h264_amf` / `hevc_amf` 能跑，
  但 `av1_amf` 不行。若只记"AMD 可用"就去配 `av1_amf`，会白跑一次试压再掉回 CPU，而别的厂商
  （如 Intel QSV）本来就能压 AV1。所以 `probe()` 把每个组合的真实结果都记下来，`pickAccel()` 按需查。
- 用户显式指定了某个 GPU 但它压不了当前格式时，**先降到其它 GPU**，最后才落 CPU，并在进度提示里说明。
- 环境变量 `FFMPEG_PATH` / `FFPROBE_PATH` 永远优先，自动下载绝不覆盖用户显式指定的路径。

### ffmpeg 的获取（前置依赖）

ffmpeg 是波形、抽音频与视频压制的前提。定位顺序（`editor/ffmpeg-tool.js`）：

1. 环境变量 `FFMPEG_PATH` / `FFPROBE_PATH`
2. 程序自带副本 `tools/ffmpeg/bin/`（自动下载的落点，已在 `.gitignore`）
3. 常见安装路径
4. `PATH`

都找不到时，在「设置 → 语音识别 → 前置」里点「下载」即可自动获取一份到 `tools/ffmpeg/`，
**不动系统 PATH、不需要管理员权限**；装完立刻生效（`FFMPEG`/`FFPROBE` 是 `let` + `refreshFfmpegBinaries()`，
不是启动时固定的 `const`）。

- 下载源 **GitHub 优先**（`GyanD/codexffmpeg` 的 essentials 构建，实测约 800KB/s），
  gyan.dev 兜底（同一台机器实测只有约 64KB/s，109MB 要 29 分钟）。
- 每条源先试 Node `fetch`，失败再试 PowerShell `Invoke-WebRequest`：有些机器缺中间证书，
  Node 会报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，而 Windows 证书库是好的。
- 解包用系统自带 `tar`（Windows 10 1803+ 的 bsdtar 能直接解 zip），不额外依赖 7zip。
- **ffmpeg 不可用时不能显示成"没有硬件编码，将用 CPU"** —— 那会让人以为只是慢，实际必然失败。
  `checkTools()` 把"根本跑不起来"与"能用但只有 CPU"分开；导出接口会在接活之前就明确拒绝并给出安装指引。

### 四个必须保留的实现要点

1. **垫背事件**：ffmpeg/libass 在事件数多（实测 ≥100）时会吞掉 `[Events]` 首条字幕。解法是在 `Format:`
   之后插一条"空文本 + 10ms"的事件，被吞的是它。加 `Collisions`、删 `WrapStyle`、把首条时间改成 0 都无效。
2. **硬件链路必须先试跑**：硬件编码常常"能列出编码器但跑不动"。正式压之前用真实视频试跑 0.5 秒整条链路，
   失败就自动回退 CPU，并把原因写进进度提示。
3. **Windows 路径进 `-vf` 的转义**：必须同时满足"反斜杠转正斜杠 + 盘符冒号转义 + 整段单引号"
   （`subtitles='D\:/x/y.ass'`），少一条就报 `Unable to parse "original_size"`。三种写法都实测过。
4. **CPU 路径不能带 `hwdownload`**；`libsvtav1` 的 preset 必须是数字（写 `medium` 直接失败）。

### 验证

- `tests/export-video-test.mjs`（9 组断言，真实 ffmpeg，无 ffmpeg 时记部分执行）：能力探测、参数校验、
  三种内容并存、生肉逐字节等于原片、字幕与稿件一致、成片时长/分辨率/音轨自检、
  **首条字幕在 120 条事件时仍入画**、同名不覆盖与 `overwrite`、前端正文优先且不改写稿件。
- `tests/hardsub-accel-test.mjs`（30 项，纯逻辑）：GPU 优先、按编码格式逐项判断、显式指定不可用时的降级、
  工具不可用时不假装能压、垫背事件不变量、路径转义、ffmpeg 定位与 `checkTools`。

## 12. 原始原型

三个 `prototypes/` 原型均为单文件、无依赖、无构建，可直接用 `file://` 打开，**与生产 `editor/` 隔离**：

- `prototypes/adaptive-selection/`：把「边框随背景取色」落到设置页与字幕栏各类可选表面，含取样窗口与
  描边映射曲线（S ↑ → kSat ↓ / kBri ↑）；生产接入时需把 `--wp` 换成真实背景层。
- `prototypes/cue-card-redesign/`：字幕卡「Quiet Card」视觉原型，内容优先的单容器卡片、三级层级、
  状态按需出现、操作渐进披露、角色名从正文提升为元信息。
- `prototypes/subtitle-editor/`：只替换右侧字幕卡（样式常驻、时间轴块背景降饱和）的编辑器原型；
  上一版整页暗色重设计归档为 `redesign-full-dark.html`。

## 13. 历史文档索引

原文件已删除，内容可在 git 历史中找回。

| 原文件 | 内容 | 现状 |
| --- | --- | --- |
| `PROJECT_MAP.md` | 目录地图、后端/前端结构、核心数据流、开发约定、测试地图 | 已并入本文 §2–§6、§9 |
| `README-DEV.md` | 环境、测试、启动与构建、仓库写入 | 已并入本文 §1、§5、§6、§10 |
| `docs/STATUS.md` | 逐条任务状态流水账（约 58KB） | 已压缩进下文「最近状态」 |
| `docs/STATUS-before-maintenance-20261015.md` | 维护前状态快照 | 已被 STATUS 取代，仅历史存档 |
| `docs/CONTINUITY.md` | 连续性要求与验收门槛 | 已并入本文 §9、§10 |
| `docs/MAINTENANCE.md` | 全项目测试与维护命令 | 已并入本文 §5 |
| `docs/UI_INTEGRATION.md` | 新 UI 生产接线的逐日施工记录（约 42KB） | 已并入本文 §4；施工细节仅历史存档 |
| `docs/UI_REDESIGN.md` | 独立 UI 原型的信息架构与验收 | 已被实装取代，仅历史存档 |
| `docs/THEME_PACKS.md` | 主题包 JSON 格式与校验规则 | 已并入本文 §4 |
| `docs/KARAOKE_DESIGN.md` | `\k` 逐词字幕完整设计 | 已并入本文 §7 |
| `docs/KARAOKE_REFS.md` | `\k` 开源项目调研与许可证核验 | 调研已完成，结论已吸收，仅历史存档 |
| `docs/双引擎实测结论.md` | NPU+GPU 实测；2026-10-08 旧结论 + 2026-10-11 反转 | 旧结论已作废，最终结论见本文 §7 |
| `docs/CODE_REVIEW.md` | 第一轮审查（2026-10-04），5 项，全部已修 | 已被后续两轮覆盖，仅历史存档 |
| `docs/CODE_REVIEW_2026-10-10.md` | 第二轮全面审查，10 项高危 | 已在第三轮逐项验收，仅历史存档 |
| `docs/CODE_REVIEW_2026-10-11.md` | 第三/四轮，安全专项与全面清扫 | 已由 REPAIR_15 落实，仅历史存档 |
| `docs/REPAIR_15.md` | 15 项修复需求书 | 已由 `REPAIR_15_RESULTS.md` 交付 |
| `docs/REPAIR_15_RESULTS.md` | 15 项验收记录 | 修复结论仍生效，要点见 §9 |
| `editor/README.md` | 约 150KB 的逐版本 changelog + 发版流程 | 发版流程已并入本文 §6，changelog 仅历史存档 |
| `asr/fetch/README.md` | 下载内核的目录内容、设计要点、验证 | 已并入本文 §8 |
| `prototypes/*/README.md` | 三个原型各自的说明 | 已并入本文 §12 |

### 最近状态

**2026-10-22（Whisper/Qwen Vulkan 兜底接入）**

- **产品分层**：快速档 Parakeet（Vulkan/NPU），中档 Qwen3-ASR，质量档 Whisper large-v2。
  有 N 卡时 CUDA 版优先；没有 N 卡时新增的 Vulkan 版必须可用，不再出现“中档/质量档都不可用”。
- **新增模型**（均 engine `crispasr-whisper` / `crispasr-qwen`，backend `vulkan`）：
  - `whisper-large-v2-vulkan`：GGML large-v2 3.09GB；CrispASR + Vulkan，**Vulkan 原生词时间太差
    （中位 170–210ms）**，初稿勾「对齐」时用独立对齐器重算。
  - `qwen3-asr-1.7b-vulkan`：Qwen3-ASR Q4_K 1.49GB；CrispASR + Vulkan。Q4 是唯一能在
    CrispASR 0.8.42 跑通的版本；
    Q8 GGUF 缺 audio tensor 无法加载。**5/10min 质量明显低于 CUDA bf16**，desc 明确要求
    有 N 卡优先 CUDA。
- **运行时**：CrispASR 0.8.42 已随应用；新模型只下载 GGUF，不需要 Python/CUDA。
  `needRuntime: runtime:crispasr`；模型文件仍由设置页下载，安装包不内置。
- **CrispASR 执行层**：`runCrispAsr` 支持 backend、语言、`-ck` 分块、post-align；
  新增 ASCII 模型/音频缓存（Qwen/部分 GGUF 对中文路径不友好），并新增
  `crispPostAlignWords`：按 ASR 段边界切 ≤150s，再逐段 `--align-only`，避免
  whisper/Qwen 长音频原生词缺失或时间塌缩。
- **UI**：模型分到 Whisper/Qwen 系列；新增引擎标签“Whisper large-v2（Vulkan）”、
  “Qwen3（Vulkan）”；运行时提示显示 CrispASR；创建/重新识别/速度测试三条路径都支持
  新引擎。N 卡用户同时看到 CUDA 与 Vulkan，CUDA 排在前面并推荐；无 N 卡时 CUDA
  模型由 backend 过滤隐藏，Vulkan 模型可见。
- **对齐模型彻底独立**：`ALIGNER_MODELS` 两个独立条目
  （`qwen3-forced-aligner-0.6b` / `...-vulkan`），设置页「语音识别 → 对齐模型」有
  独立下载/删除；下载 Qwen3-ASR 只拿 ASR 权重，不再夹带对齐器。初稿新增「对齐」：
  未勾「逐词」时显示；勾选 → 对齐器生成逐词 ASS，否则 SRT；Qwen ASR / Whisper Vulkan
  没有原生逐词，禁止勾「逐词」，只能勾「对齐」。
- **前置动画**：「语音识别 → 前置 → Python 路径设置」加了高度+透明度展开/收起动画；
  展开 `cubic-bezier(.16,1,.3,1)`（先快后慢），收起 `cubic-bezier(.4,0,.2,1)`；
  支持 `prefers-reduced-motion`，不改变原生 `<details>` 语义。
- **realign 改为 Qwen3 纯对齐**：「逐词时间重排」的前提是文本已确认，因此删掉了
  `realignOne`/`realignRecognize`/热词第二级/锚点率/置信度门槛；realign 现在只做
  **切原片切片 → Qwen3-ForcedAligner → token 映射**，不跑 ASR、不改文本。
  - CUDA：新 `asr/qwen_align.py` 批量 worker，一次加载对齐器处理整批（30s 测试项目
    单句与全片 4 句均成功）。
  - Vulkan：逐块 `CrispASR --align-only`，10s 测试成功，1 句约 2.8s（含加载）。
  - 移除 `/api/asr/realign-settings`、`st-realign-minratio/minconf`、全片预览的
    采纳门槛；对齐失败/无有效词时保持原时间，不回退 ASR。
  - 文本不确定的情况继续走独立的「重新识别」，与 realign 职责分开。
- **验证**：手动 30s 项目单句 + 全片 realign 均成功；Vulkan 强制路径成功；
  30s 项目 realign 成功；10s Qwen ASR 勾「对齐」生成 ASS（23 词）成功；
  10s 原生 Parakeet 模型勾「对齐」成功（对齐后写 ASS）；10s Qwen ASR 不勾对齐输出 SRT 成功；全量 JS 回归
  **114 通过 / 8 部分执行 / 0 失败 / 2 排除**；i18n **3122 keys**。
- **实测**：Whisper Vulkan 10s 草稿成功（2 行、23 词）；Qwen Vulkan 10s 草稿成功；
  Qwen Vulkan 5min 草稿成功（93 行、808 词，逐词重算正常）。全量 JS 回归
  **114 通过 / 8 部分执行 / 0 失败 / 2 排除**；8321 已重启，两个 Vulkan 模型
  `ready/usable=true`。
- **状态**：**已实现并验证（本机 Vulkan + CUDA；下载/无 N 卡切换需目标机复验）**。
  GitHub：尚未提交（工作副本无 `.git`）。

**2026-10-22（非 Qwen 候选模型 CUDA 横评）**

- **范围**：Canary-1B-Flash、Canary-1B-v2、Whisper large-v3、Parakeet-TDT-1.1B、
  Paraformer-en、Granite Speech 2B；全部只用 CUDA，未接入 SubFabric，脚本与原始输出在
  `_test/maintenance/candidates/`。Qwen 系列不重复测试。
- **结果（总耗时含模型加载 / WER）**：
  - 30s：Canary-1B-Flash 34.173s / 3.66%；Canary-1B-v2 7.571s / 4.88%；
    Parakeet-TDT-1.1B 14.6s / 3.66%；Whisper large-v3 24s / 3.66%；
    Paraformer-en 9.073s / 8.54%；Granite Speech 2B 12.129s / 3.66%。
  - 5min：Parakeet-TDT-1.1B 115.963s / 12.21%；Whisper large-v3 74s / 10.19%；
    其余 Canary-Flash、Canary-v2、Paraformer、Granite 2B 均为 `-`。
  - 10min：Parakeet-TDT-1.1B 643.768s / 16.95%；Whisper large-v3 182s / 12.99%；
    其余为 `-`。
- **失败/跳过**：Canary-1B-Flash 5/10min 900s 内未完成；Canary-1B-v2 300s 触发
  CUDA device-side assert、600s 未跑；Granite 2B 5/10min 900s 内未完成；
  Paraformer-en 300s ONNX `Mul` 广播错误、600s 未跑；**Granite Speech 8B 明确 8GB 显存不足，
  未测试并记 `-`**。这些不是应用功能，未改 `ASR_MODELS`/流水线。
- **报告**：总表新增 42 行（14 模型 × 3 时长），`-` 项在表后逐条标注；PDF **10 页**，
  桌面 `SubFabric-ASR-横评报告-2026-10-21.pdf`。原始数据
  `_test/maintenance/asr-benchmark/results.csv` 与 `_test/maintenance/candidates/summary.json`。
- **GLM-ASR-Nano-2512（补充调研）**：`zai-org/GLM-ASR-Nano-2512`，2.3B dense / 1.5B active，
  8K context，4.5GB safetensors，Transformers `GlmAsrForConditionalGeneration`。CUDA bf16，
  加载 4.37s + 30s 推理 4.394s，总 8.764s（3.42×），WER 6.10%；300s 输出错乱（WER 77.38%）、
  600s 只输出 379 字符，长音频不可用。**30s 有效，长片段记 `-`**。
- **Fun-ASR-Nano-2512（补充调研）**：`FunAudioLLM/Fun-ASR-Nano-2512`，0.8B，1.97GB `model.pt`，
  FunASR 1.4.16。CUDA，加载 14.17s + 30s 推理 4.844s，总 19.014s（1.58×），WER 3.66%；
  300s 只输出 120 字、600s 出现 `there, there...` 复读，整段长音频需要它自己的 streaming/cache
  分块，未按当前流程通过。**30s 有效，长片段记 `-`**。两者均未接入 SubFabric。
- **Index-Echo-S2TT-2B-GGUF Q8_0（调研，未测试）**：`IndexTeam/Index-Echo-S2TT-2B-GGUF` 的
  Q8_0 只有 2.08GB **文本 LLM backbone**，audio tower/connector 不在 GGUF 里，llama.cpp 无法跑
  完整语音；`mmproj` 是视觉投影，不是音频。完整 `IndexTeam/Index-Echo-S2TT-2B` 为 bf16
  Qwen3-Omni AuT 1.3GB + LLM 4.55GB + connector，官方卡片标注约 **10GB VRAM**，本机 8GB
  明确不足，按规则不测试、30/300/600s 全记 `-`。它是**中→英/日/西 S2TT**，不是英语 ASR；
  输出只有句级时间戳。逐词调研应使用完整包的源语言转写再喂 Qwen3-ForcedAligner（按源语言），
  但 Q8_0 无音频能力、完整包在本机跑不起来，所以本次没有可对齐转写，也没有逐词数值。
  FP8 完整包（约 3.05GB LLM + 音频塔）理论上有机会进 8GB，但不是 Q8_0，未测试。未接入 SubFabric。
- **结论**：30s 里 Canary-1B-v2 最快，Granite 2B/Paraformer 可用；5/10min 只有 Whisper large-v3
  与 Parakeet 1.1B 跑完，但 large-v3 WER 更差，Parakeet 1.1B 比 0.6B 更慢且 WER 更高。
  未发现比现有 Parakeet 0.6B/Whisper large-v2 更适合本机的候选。
- **2026-10-22 追加候选**：Granite Speech 5.0 470M、Parakeet-TDT-0.6B-v3、
  Nemotron 3.5 ASR 0.6B、MOSS-Transcribe-Diarize 0.9B、Canary-Qwen 2.5B，均 CUDA-only、
  未接入应用。
  - Parakeet v3：4.146 / 11.348 / 45.482s，WER 2.44 / 10.64 / 11.30%，**本轮最强新候选**；
    30s 比 v2 好，5/10min 略差但快 1.8–2 倍。
  - Granite 470M：2.215 / 1.922 / 2.03s（156–296×），WER 6.10 / 12.77 / 11.86%；
    速度极端，适合粗剪，不适合终稿。
  - Nemotron 3.5：4.868 / 18.737s，WER 8.54 / 15.23%；600s 未完成，记 `-`。
  - MOSS 0.9B：18.274 / 185.161s，WER 3.66 / 9.18%；600s 只输出 1053 词、WER 44.63% 无效。
    它有说话人标签/段级时间戳，适合多说话人，但普通 ASR 太慢。
  - **MOSS vs Whisper 长音频补充（10/30min）**：Whisper large-v2 10min 148s / WER 9.55%，
    30min 422s / WER 10.97%；MOSS 10min 单次 452.8s / WER 10.40%，30min 单次在 8GB 上
    超过 30 分钟未完成，改用 3×10min 分块，总 1022.6s / WER 11.79%。MOSS 10min 有 7 个
    匿名 speaker 标签、250 段；30min 分块 549 段、15 个局部标签（每块重置，不能直接合并）。
    逐词：MOSS 用 Qwen3-ForcedAligner 按 ≤5min 分块，10/30min 覆盖率 90.45/91.49%、
    起始中位 80/100ms、≤200ms 82.56/84.53%；Whisper 原生词 90.45/91.38%、80/100ms、
    88.13/84.26%。**MOSS 不是 Whisper 替代；多说话人需先做 speaker 真值和跨块 stitching 验证。**
    单独 PDF：`SubFabric-MOSS-vs-Whisper-长音频多说话人对比-2026-10-22.pdf`。
- **2026-10-22 Vulkan vs CUDA（Whisper large-v2 / Qwen3-ASR / Qwen 对齐器）**：
  独立用 CrispASR 0.8.42 的 Vulkan 后端测试，**未修改 SubFabric 的模型后端**；现有 app 仍是
  Whisper CUDA / Qwen CUDA。素材仍为 30s/5/10min 英语片段。
  - **Whisper**：CUDA 29.41 / 81.99 / 192.37s，WER 1.22 / 8.73 / 8.92%；
    Vulkan 5 / 32 / 76s（30s 冷启动 18s），WER 1.22 / 8.17 / 11.24%。Vulkan 快 2–2.5 倍，
    但 10min WER 更差；且 Vulkan 原生词时间中位 170–210ms、≤200ms 只有 48–68%，
    必须再用 Qwen 对齐器才能到约 70ms / 92%。
  - **Qwen3-ASR**：CUDA（PyTorch bf16，150s 块）12.325 / 61.257 / 121.987s，
    WER 2.44 / 9.07 / 10.17%；Vulkan（CrispASR Q4_K）10 / 76 / 125s，
    WER 3.66 / 18.03 / 23.11%，长音频明显退化。Q8 Vulkan GGUF 在 CrispASR 0.8.42 缺
    audio tensor，无法加载；Q4 是唯一跑通的版本，不能当作等质量对比。
  - **Qwen3-ForcedAligner**：Vulkan `--align-only` 30s 2.52s（含加载），
    词覆盖率 97.5%、起始中位 70ms、≤200ms 92.4%；与 CUDA 对齐器接近。
    Qwen Vulkan 300/600 的 words 是 ASR 后按 150s 块单独 align-only 得到的。
  - **结论**：Vulkan 对 Whisper 的吞吐收益真实，但原生词时间不可用；Qwen Vulkan 的 Q4
    长音频质量明显下降。**不建议现在把 app 的 Whisper/Qwen 默认后端切到 Vulkan；
    若切，必须同时上 Vulkan 对齐器并重新验收 WER。**
    数据：`_test/maintenance/vulkan/vulkan-compare.json` / `.csv`。
  - **Whisper 原生逐词 vs Whisper 文本 + Qwen 对齐（20–50min）**：Whisper large-v2 开
    `word_timestamps=True` 墙钟 366s；关闭逐词生成字幕 346s，再把字幕按 ≤120s 切块用
    Qwen3-ForcedAligner 对齐 8.93s（含加载约 357.8s）。两套输出 3,726 / 3,698 词；
    匹配参考词 1,169 / 1,183，覆盖率 90.97% / 92.06%。原生：起始中位 70ms、P90 290ms、
    ≤200ms 85.29%，结束中位 40ms、P90 160ms、≤200ms 92.47%。Qwen：起始中位 70ms、
    P90 150ms、≤200ms 92.73%，结束中位 40ms、P90 190ms、≤200ms 90.28%。
    **Qwen 的起始边界更稳，Whisper 原生结束边界更好；总耗时只差约 8s，Qwen 多一套 1.8GB
    对齐器与分块逻辑，不值得替换原生逐词。** 5min 大块会让 Qwen 尾部词卡在同一时间，
    实测 P90 结束误差 340ms；≤120s 分块才正常。20–50min 的 ASS 原始有 2,518 条
    Dialogue / 21,167 个英文 token（含卡拉OK重复行），去重后只有 216 个完整句块 /
    1,332 个句内 token、1,285 个高亮词；ASR 输出约 3,700 词，ASS 不是全量转写，
    所以 WER 193% 不是有效 WER，只比较匹配的高亮词边界。
    数据：`_test/maintenance/asr-benchmark/timestamp-ab/compare.json`。
  - Canary-Qwen 2.5B：30s 46.088s、WER 3.66%；300s 输出错乱、600s 未跑；**已淘汰并删除权重**。
  - 逐词统一用 Qwen3-ForcedAligner：30s 起始中位 70–80ms、≤200ms 92–96%；
    5min 中位 80–90ms、≤200ms 79–83%；10min 未做（aligner 单段 ≤5min）。
- **存储清理**：删除已淘汰候选权重：Canary-Flash、Canary-v2、Parakeet 1.1B、Granite 3.3 2B、
  Paraformer、Fun-ASR、GLM-ASR、Whisper large-v3、Canary-Qwen；保留 Qwen3/Whisper large-v2/
  Parakeet 0.6B 应用模型，以及本轮 Parakeet v3/Granite 470M/Nemotron 3.5/MOSS 候选。
  释放约 31GB，`asr/models` 仍保留应用模型。

**2026-10-21（Qwen3 实装 + 创建稿件模型列表）**

- **Qwen3-ASR 1.7B + Qwen3-ForcedAligner 0.6B 已接入应用**：单个模型条目
  `qwen3-asr-1.7b`（engine `qwen`，约 5.6GB）；ASR 权重在模型根目录、对齐器在 `aligner/` 子目录，
  下载/校验/删除都按相对路径处理。CUDA bf16，仅 N 卡；CPU/NPU 直接拒绝。
- **worker**：`asr/qwen_asr.py` 内部按 150s 分块（30s 单次），每块先 ASR 出文本，再用 ASR 文本做
  强制对齐出词级时间；输出与 `asr.py` 同构的 `{segments:[{start,end,text,words}]}`。参数：
  分块长度、ASR 最大 token（`editor/asr-params.js`）。
- **运行时**：复用 app 的 `asr/runtime-python`（CUDA torch 2.14），安装
  Transformers 5.20.2 + Accelerate；装好后写 `asr/.qwen-runtime-ok.json`，状态页只读标记，
  不再每次轮询 import torch。设置页 Qwen 行可直接「安装运行时」；换 Python 解释器会作废标记。
- **UI**：新增「Qwen 系列」入口；创建稿件的「语音识别」下拉改为**扁平列表**，Whisper V2 / Qwen /
  Parakeet 直接可选（不再必须先切「识别来源」），选模型时自动同步来源。全模型速度测试支持
  `qwen` 引擎。
- **实测**：Qwen worker 30s -> 4 段 / 80 词；创建 12s 测试稿件（Qwen）成功出稿；创建 8s 测试稿件
  （Whisper V2）成功出稿。两者项目已删除，未留测试数据。
- **验证**：全量 JS 回归 **113 通过 / 8 部分执行 / 0 失败 / 2 排除**；i18n **3028 条**；
  本机 8321 已重启，状态里 Qwen `ready/usable=true`，Whisper V2 `ready/usable=true`。
  **状态：已实现并验证（本机 CUDA；安装包内模型需用户下载）**。
- **发布注意**：安装包仍排除 `asr/models` 与 `runtime-python`，Qwen 模型要在应用内下载；
  Qwen 运行依赖需在设置页点「安装运行时」（标记文件也被安装包排除，避免误判）。
  GitHub：**尚未提交**（工作副本无 `.git`）。

**2026-10-21（停用五个识别模型及关联运行时）**

- **停用清单**（`ASR_MODELS` 条目已原样注释，保留回滚入口）：
  `parakeet-tdt-0.6b-v2`（sherpa-onnx CUDA）、`ggml-large-v3-turbo`（whisper.cpp）、
  `multitalker-parakeet-streaming-0.6b-v1`（NeMo）、`parakeet-tdt-0.6b-v2-dual`（双引擎）、
  `vibevoice-asr-4bit`（VibeVoice CUDA 4bit）。
- **后台兜底**：新增 `RETIRED_ENGINES = {sherpa-onnx, whisper.cpp, nemo, dual, vibevoice}`；
  `modelById` 不再命中这些条目，`asrEngineArgs` / `asrGpuGateError` / `benchSupported` 遇到退役引擎
  直接报错；NeMo/VibeVoice 探针被短路，不再后台 import torch；双引擎 `asr_dual.py` /
  `asr_perf.py` 的接口已封死。
- **接口**：`/api/asr/download` 的 whisper/ VibeVoice 运行时与退役模型返回 410/400；
  `/api/asr/install-nemo`、`/api/asr/dual`、`/api/asr/perf/*` 返回 410；`select`/`params`/`bench`
  对退役 ID 返回 400。状态里只返回 5 个在用模型（Faster-Whisper large-v2、Parakeet Vulkan、
  Parakeet NPU、必剪、剪映），`nemo`/`runtime`/`vibevoice` 字段为 `null`。
- **界面**：VibeVoice 系列入口注释；双引擎分工页签/视图隐藏，全模型速度成为默认页；
  NeMo 运行时行和 VibeVoice 修复入口停用；Python 环境卡保留（NPU/说话人分离仍需要）。
- **realign**：固定模型从 CUDA Parakeet 改为 `parakeet-tdt-0.6b-v2-npu`；NPU 不支持热词偏置，
  第二级退化为无热词复核，界面文案已同步。
- **旧设置/旧稿件**：`selectedModel`/`rerecogModel` 指向退役 ID 时按“未知模型”处理并回退到可用模型；
  不删除已下载的模型文件，也不自动清理用户目录。
- **验证**：全量 JS 回归 **113 通过 / 8 部分执行 / 0 失败 / 2 排除**；i18n **2992 条**；
  隔离服务实测状态只列 5 个模型，退役模型下载/安装/双引擎/测速接口均被拒绝，
  后台无 python/NeMo/VibeVoice 子进程。**状态：已实现并验证（源码与隔离服务）**；
  真实 GPU 上的手动点按验收未重复做。GitHub：**尚未提交**（工作副本无 `.git`）。

**2026-10-21（历史：ASR 三长度横评）**

- **口径**：用 `How I Saved the World's Largest Minecraft Server.webm` 的前 30s / 300s / 600s，
  参考 `人工精校的字幕（前两小时）.ass`（只取 Default 英文行，剥离颜色标签、合并逐词重复行）；
  WER 忽略大小写/标点/连字符、数字转英文词；不做术语表修复与语义分句。片段都从 0 秒开始。
  机器：RTX 4060 Laptop 8GB + Intel Arc 核显 + Intel AI Boost NPU。
- **结果（关键行，WER / 识别倍率 / 含说话人总倍率）**：

  | 片段 | 模型+配置 | WER | 识别× | 总×（含分离） | 置信度 |
  | --- | --- | ---: | ---: | ---: | ---: |
  | 300s | Whisper large-v2 · 置信度完整 | 8.73% | 3.66 | 1.51 | 0.740 |
  | 300s | Parakeet CUDA · 完整 | 9.07% | 4.00 | 1.57 | 0.789 |
  | 300s | Parakeet CUDA · 关闭 | 9.07% | 14.18 | 2.19 | 0.806 |
  | 300s | Parakeet NPU · 关闭 | 22.84% | 25.11 | 2.34 | 0.733 |
  | 600s | Whisper large-v2 · 完整 | 8.92% | 3.12 | 1.53 | 0.747 |
  | 600s | Parakeet CUDA · 关闭 | 10.67% | 13.25 | 2.44 | 0.837 |
  | 600s | Parakeet NPU · 关闭 | 22.98% | 27.32 | 2.69 | 0.760 |

  - 置信度「完整」对 Parakeet CUDA 的代价是 2.1×（30s）/ 3.6×（5–10min），对 NPU 是 1.5–1.9×；
    WER 完全不变（同一段解码文本），完整档只增加稳定性标记与更保守的置信度。
  - 说话人分离实测 7.19s / 116.08s / 200.98s（30s / 5min / 10min），与模型无关；开启后
    5/10min 总倍率分别降到约 1.5–2.3× / 1.5–2.7×。
  - Faster-Whisper 关闭逐词后 WER 变差（6.1% / 10.19% / 9.94%），速度没有稳定收益。
  - **Multitalker Parakeet 0.6B**（应用实际用法：单说话人重识别）：30s/5min/10min 分别
    34.42s / 281.31s / 736.19s，WER 3.66% / 13.44% / 14.57%；没有逐词时间戳与置信度，
    比 Whisper/Parakeet 都慢，只适合「选区重新识别」，不适合批量转写。
  - **Qwen3-ASR-1.7B + Qwen3-ForcedAligner-0.6B（独立部署，不接入 SubFabric）**：
    `Qwen/Qwen3-ASR-1.7B-hf`（4.08GB）+ `Qwen/Qwen3-ForcedAligner-0.6B-hf`（1.84GB），CUDA bf16；
    独立目录 `_test/maintenance/qwen-asr/`，ASR 加载 4.24s、对齐加载 2.63s，ASR 峰值显存约 3.8GB。
    流程：ASR 只出文本 → 用该文本做强制对齐出词级时间；30s 单次，5/10min 都按 150s 分块。
    30s/5min/10min **端到端（含加载）12.325s / 61.257s / 121.987s（2.43× / 4.90× / 4.92×）**，
    WER **2.44% / 9.07% / 10.17%**；起始边界中位 80/80/70ms，200ms 内 92.4% / 94.7% / 93.8%。
    300s 单次对齐会把尾部约 20s 的词挤到最后一个时间戳，必须分块；ASR 本身也随分块运行。
  - **Whisper large-v2（无逐词）+ 同一个 Qwen3-ForcedAligner（独立部署）**：
    Faster-Whisper-XXL `word_timestamps=False` 只出文本；用它自己的 segment 边界在约 150/300/450s
    切音频，文本随 segment 分配，再交给对齐器。30/5/10min 端到端 **33.558s / 96.013s / 181.520s
    （0.89× / 3.12× / 3.31×）**，WER **1.22% / 10.08% / 8.64%**；起始中位 70/80/70ms，
    200ms 内 92.5% / 91.3% / 92.3%。Whisper 30s 被 XXL 约 26s 加载拖慢；5/10min Qwen 方案
    仍快约 1.3–1.6 倍，WER 两者各有胜负。主表保留两套组合行，纯对齐器行已移除。
  - **VibeVoice**：5s 实测 27.4s；30s 在 900s 上限仍未完成，5/10min 未跑——当前 8GB 显存机器
    不适合 30s 以上整段识别。
- **产品改动**：全模型速度测试上限从 120s 提到 600s；结果增加「平均置信度」列；`details:true`
  返回识别文本供横评算 WER。真实 5/10min 片段的 bench 均跑通（`projects/.bench` 自动清理）。
- **未纳入**：双引擎（独立页）、云端必剪/剪映（非本地）、whisper.cpp large-v3-turbo 与
  Parakeet Vulkan（未安装）；NeMo 已按单说话人模式纳入。
- **验证**：全量 JS 回归 **113 通过 / 8 部分执行 / 0 失败 / 2 排除**；ESLint **0 error**
  （6 条既有 warning）；i18n 2975 条。横评原始数据与报告：
  `_test/maintenance/asr-benchmark/{results*.json,results.csv,横评报告.md}` 与
  `_test/maintenance/qwen-asr/results/{pipeline,whisper_align}.json`、
  `_test/maintenance/qwen-aligner/results/result.json`（本地分析产物，不入库）；
  桌面另有导出的 4 页 PDF。
  **限制**：每档只跑一次、无误差棒；30s 含模型加载；WER 不是强制对齐级评测；置信度是各引擎
  自评分，不能跨引擎直接比。GitHub：**尚未提交 GitHub**（工作副本无 `.git`）。

**2026-10-21（本轮增量：速度测试条件 + 运行时修复反馈）**

- **速度测试条件**：全模型页新增与创建稿件页一致的逐词 / 置信度 / 分角色识别 / 说话人区分
  （+ 说话人数）。逐词下发到 Faster-Whisper-XXL；置信度进入 `asrArgsFor`（Parakeet 的
  `--tta`）；分角色以说话人为前提。后处理只测一次：说话人分离跑 `diarize.py`，分角色识别用
  第一份成功结果跑 `inferCast` + `mapSpeakers`，时间加到每个模型的总耗时；结果表改为
  识别 / 后处理 / 总耗时 / 倍率，状态里带 `conditions` 与 `post`。
- **修复按钮可见进度**：VibeVoice / Faster-Whisper 的安装按钮点击后在同一行轮询
  `/api/asr/status`，显示百分比与失败原因，装好显示「✓ 运行时已就绪，点「开始测试」重新跑一次」；
  不再只弹一个 toast 让用户去别的页签猜。
- **VibeVoice bench 真正根因（本轮定位并修复）**：`benchRunModel` 对所有 Python 引擎统一用
  `ASR_PY`，但 VibeVoice 的 torch/bitsandbytes 只装在独立运行时 `asr/runtime-vibevoice` 里。
  因此探针（用独立 Python）显示运行时 OK，bench（用共享 Python）必然报
  `No module named 'bitsandbytes'`。现已改为 `model.engine === 'vibevoice' ? vibevoicePython() : ASR_PY`；
  真实 5s 音频 bench 成功：27.39s、倍率 0.18×。
- **验证（本次，已完成且已验证）**：临时在 8398 端口起源码服务（用真实模型/运行时，
  结束后关闭并清理），真实跑通 Faster-Whisper 10s 音频：
  `word:false / confidence:full / speakers:false` → 识别 27.57s；
  `speakers:true` → 识别 25.72s + 说话人分离 2.48s = 总 28.20s，`post` 与倍率按总耗时重算；
  VibeVoice 5s 音频 → 27.39s、倍率 0.18×，`projects/.bench` 测完已删除。另在同一临时服务上
  POST `{kind:'runtime:vibevoice', force:true}`：约 12s 完成，过程 8→18→64→86→100%，
  最终 `probe ok:true`、CUDA/NF4/bitsandbytes 全绿 —— 强制修复链路本身可用。
  全量 JS 回归 **113 通过 / 8 部分执行 / 0 失败 / 2 排除**
  （报告 `_test/maintenance/js-results-bench-conditions.json`），新增
  `tests/asr-bench-conditions-test.mjs`；ESLint **0 error**（6 条既有 warning）；i18n 2973 条。
  **未执行**：分角色识别真实 LLM 调用（会消耗用户额度，只做了静态契约与跳过分支）、
  真实浏览器点击验收。
  注意：用户当时运行的 8321 实例是 10:09 启动的旧进程，**必须重启服务**后新条件与本轮修复才生效。
  GitHub：**尚未提交 GitHub**（工作副本无 `.git`）。

**2026-10-21（本轮增量：速度测试写盘 + VibeVoice 运行时修复）**

- **速度测试 PermissionError 修复**：Faster-Whisper-XXL 在 `%TEMP%\sf-bench-*\...\input.json` 写结果报
  `PermissionError: [Errno 13]`。实测复现：同一段音频、同一套参数，只把 `--output_dir` 从
  `%TEMP%` 换到 `projects/.bench/...` 就成功。`benchClip` 现在固定使用
  `projects/.bench/run-*`（点开头，`validId` 不认，不会被当成项目），测完删除并回收空父目录；
  所有测试引擎（含 asr.py / whisper.cpp / CrispASR 的 JSON）共用该目录。
- **VibeVoice 运行时修复**：`startVibeVoiceInstall` 拆成「Transformers/Accelerate/soundfile/soxr」
  与「CUDA bitsandbytes」两段，后者单独安装并加 `--extra-index-url https://pypi.org/simple`
  兜底；缺 `bitsandbytes` 时错误明确指向该包。`/api/asr/download` 支持 `force:true`，绕过旧探针
  缓存强制重装；模型行在部分运行时存在时按钮显示「修复运行时」；速度测试失败行新增
  「安装 / 修复 VibeVoice 运行时」按钮（VibeVoice）与「安装 Faster-Whisper 运行时」（缺运行时），
  直接调用同一安装接口并在应用内显示进度。
- **性能页卡片间距**：双引擎页签的两张 `.st-section` 之间补 16px 垂直间距（`.perf-view` 改 flex 列 +
  gap），见 §4；新增 `tests/perf-view-spacing-test.mjs` 钉住布局与「生产 HTML 等于模板」。
- **验证（本次，已完成且已验证）**：用真实 `faster-whisper-xxl.exe` + `large-v2` 在同一段 5s 音频上
  复现了 `%TEMP%` 的 PermissionError，并在 `projects/.bench` 下成功产出 `input.json`（退出码 0）；
  本机 VibeVoice 运行时 `--probe` 为 `ok:true`（CUDA/NF4/bitsandbytes 全绿），pip 解析
  `bitsandbytes==0.50.2` 在「镜像 + 官方源」组合下正常。全量 JS 回归 **112 通过 / 8 部分执行 /
  0 失败 / 2 排除**（报告 `_test/maintenance/js-results-perf-spacing.json`），新增
  `tests/asr-bench-repair-test.mjs`、`tests/perf-view-spacing-test.mjs`；ESLint **0 error**
  （6 条既有 warning）；i18n 词条 2941 条。
  **未执行**：从零安装 bitsandbytes（只验证了 pip 解析与现有环境）、真实 UI 里点按钮装运行时、
  真实 VibeVoice 全模型测速（需加载 6.6GB 模型）。GitHub：**尚未提交 GitHub**（工作副本无 `.git`）。

**2026-10-21（本轮增量：Parakeet / VibeVoice 参数 + 主页二次刷新）**

- **Parakeet 参数**：sherpa-onnx / CUDA 那条新增「CPU 线程数」（默认 4）与「TDT blank 惩罚」
  （`--blank-penalty`，默认 0.5，范围 0–2）；CrispASR/Vulkan 原本已有线程数与词阈值。
  参数在 `asrEngineArgs` 统一落到命令行，初稿、长音频分片、选区重识别、全模型速度测试共用；
  常驻识别服务的 worker 键包含线程数与 blank 惩罚，改参数会另起进程，不会沿用旧识别器。
  Parakeet NPU / 双引擎仍不提供参数：NPU 的 `--threads` 被 OpenVINO 忽略、稳定性重跑由置信度档位控制，
  双引擎分工在「性能与调度」。
- **VibeVoice 参数**：新增「音频编码分块」（`--acoustic-tokenizer-chunk-size`，默认 32000，
  必须为 3200 的倍数；`asr-params.js` 新增 `multipleOf`，越界先夹取再吸附）与「最大生成 token」
  （`--max-new-tokens`，默认 8192，1024–32768）。两项在初稿与选区重识别两条 spawn 路径都已下发。
- **主页入场后二次刷新修复**：`renderWidgets()` 改为首次建节点、之后只改文字；
  `syncDashboardMode()` 只在 Material 主页 ↔ 磁贴模式切换或显式主题切换时重播入场动画。
  项目快照晚到不再替换磁贴 DOM、也不再重播 330ms 错峰的入场，消除「动画播完过一会刷新一下」。
- **验证（本次，已完成且已验证）**：`node --check` 覆盖 `editor/asr-params.js`、`editor/asr-service.js`、
  `editor/server.js`、`editor/js/studio.js`、`editor/js/project.js` 与两个参数测试；
  `node tests/asr-params-test.mjs`、`tests/asr-params-api-test.mjs`、`tests/i18n-coverage-test.mjs`
  通过；用项目自带 Python 轮询子命令确认 `--blank-penalty`、`--acoustic-tokenizer-chunk-size`、
  `--max-new-tokens` 均被对应 worker 接受。新增 `tests/asr-model-args-test.mjs` 静态守住
  「参数 → 命令行 → worker argparse」与常驻 worker 键。全量 JS 回归
  **110 通过 / 8 部分执行 / 0 失败 / 2 排除**
  （报告 `_test/maintenance/js-results-asr-params-home-fix.json`）；`tests/studio-navigation-test.mjs`
  新增「晚到项目快照不重播主页入场、不替换磁贴节点」的行为断言，`tests/material-home-test.mjs`
  更新为新的模式判断源码断言。ESLint **0 error**（20 条既有 warning）。`node tests/gen-lang.mjs`
  补齐词条到 2930 条。**真实浏览器里的动画观感与参数面板交互未做人工验收**；Parakeet / VibeVoice
  真机识别未重跑（无新增模型文件，参数只影响命令行）。GitHub：**尚未提交 GitHub**（工作副本无 `.git`）。

**2026-10-21（本次，已完成且已验证）**

- 新增 **Whisper large-v2** 引擎（`faster-whisper`）：Faster-Whisper-XXL 运行时 + `Systran/faster-whisper-large-v2`
  CTranslate2 权重；设置页「Whisper 系列」可见、可下载、可创建初稿、可选区重识别；模型下载走现有 HF 镜像
  链路，运行时可从 GitHub 下载 `.7z` 并用 `editor/scripts/7z.exe` 解包（下载链路代码已完成，**本轮未实际联网
  跑一次 1.4GB 下载**；本机用的是从「卡卡的 bin」拷入的 r245.2 运行时，已实测识别）。
- 音频预处理改为 ASR 默认原声；新增术语表拼写修复并接入所有引擎；Parakeet 默认 `blank_penalty=0.5`；
  NPU 滑窗每窗口重置解码状态。
- 准确率实测见 §7「ASR 准确率」：Whisper large-v2 7.23%（术语表后）/ 8.36%（完整初稿），Parakeet 10.34% /
  完整初稿约 11.7%，NPU 27.06%→22.99%。**Parakeet 未超过 Whisper large-v2**，原因与取舍已原样记录。
- 新增**首次启动加速方式界面**：CUDA/Vulkan 勾选（无 N 卡时 CUDA 不可选）、至少一项才能进入；
  NPU 只在设置页按硬件显示；`POST /api/asr/backends` 持久化并过滤模型，设置 → 性能与调度可重新打开。
  硬件探测、主题适配与动画见 §4；新增 `tests/welcome-model-test.mjs`。
- 模型可见性进一步收紧：只勾选的后端出现在正常列表（NPU 按硬件、云端免显卡）；旧版本下错后端的
  已下载模型收进「其它模型」，保留删除入口，避免占磁盘却找不到。`welcome-model-test` 覆盖
  “只勾 Vulkan / 只勾 CUDA / 两个都选 / 无 NPU / 已下载未启用模型”等边界。
- **Whisper 等模型参数可调**：设置 → 语音识别 → 模型行「参数」打开独立面板，显示当前值与默认值，
  支持保存和「恢复默认」。Faster-Whisper-XXL 暴露语言 / VAD 开关、阈值、方法 / MDX 人声分离 /
  逐词时间戳 / 提示词；whisper.cpp 暴露语言、线程、词阈值、提示词；CrispASR 暴露线程与词阈值。
  参数存 `asr/settings.json` 的 `modelParams`，新建初稿、分片与选区重识别都使用当前值。
  新增 `editor/asr-params.js`、`tests/asr-params-test.mjs`、`tests/asr-params-api-test.mjs`。
- **全模型速度测试**：性能与调度新增「全模型速度」页签，勾选已安装本地模型后串行实测，
  结果按倍率（音频秒数 / 含加载墙钟）排序；支持音频自动查找、进度、取消，与双引擎测试互斥。
  API 见 §7，新增 `tests/asr-bench-api-test.mjs`；真实 Parakeet 5 秒音频实测倍率 1.04×。
- **所有用户可见文案进入 i18n**：修复 `gen-lang` 扫描已删除 `editor/index.html` 导致生成器不可用的问题；
  改为扫描 `editor/studio.html` + 共享 `copy_scan`（含 `aria-label`/`alt`/`value`，剥掉 HTML 注释），
  词典从 1608 条补到 2920 条，并保留旧键和用户改过的 50 条译文。把 4 个遗留语义键
  （`save.conflict` / `model.deleteFailed` / `model.detached` / `vibevoice.*`）改成中文原文，
  避免 `t()` 对英文键直接原样返回。新增 `tests/i18n-coverage-test.mjs` 防止以后漏文案。
- **视频导出修复**：`subtitleText` 请求体上限从 64KB 放宽到 32MB（大字幕不再在请求阶段失败）；
  压缩失败/取消会清理写了一半的成片与生肉；能力探测期间禁用开始按钮，完成后显示产出路径和文件名。
  `tests/export-video-test.mjs` 增加 >64KB 大字幕回归。
- **模型下载动画**：移除 `.sf-asr-model` 的常驻动画，改为切换系列时给 `#st-models` 加一次性
  `is-model-entering`；UWP 下载轮询重建 DOM 不再每秒重播缩放动画。
- 浅色模式 + 高毛玻璃压暗新增前景色检测：`editor/js/glass-contrast.js` 合成卡片背景 alpha、
  页面底色与背景图平均色，亮度低于阈值时给面板加 `.sf-fg-on-dark`，只切换该面板的
  `--text` / `--muted` / `--line`；深色模式不覆盖。新增 `tests/glass-contrast-test.mjs`。
- 新增 `tests/faster-whisper-test.mjs`、`tests/glossary-repair-test.mjs`（纯逻辑，不加载模型）；顺带修了
  `badcat-layer-test` / `pair-anchor-test` / `word-highlight-test` 在**中文路径**下把 `%E5%B7%A5…`
  当成真实目录的旧问题（改用 `decodeURIComponent(fileURLToPath)`）。
- 全量 JS 回归 **109 通过 / 8 部分执行 / 0 失败 / 2 排除**；新增 i18n 覆盖、玻璃前景、ASR 参数与全模型测试通过；
  全仓 ESLint **0 error**（既有 warning）；8 个隔离 Python 回归全过（本机 `ruff` 未安装，未跑）。
  校验报告 `_test/js-results-all-model-bench.json`。
- 「卡卡的 bin」临时目录已删除；需要的 XXL 运行时、`7z.exe` 与 MIT 许可证已迁入 `asr/faster-whisper-xxl/`
  与 `editor/scripts/`。
- **版本推进至 beta 1.4.1**：`editor/server.js` 的显示版本 `beta 1.4.1`、文件版本 `1.4.1.0`，
  `build/installer/SubFabric.iss` 同步；`build/SubFabric.exe` 为 1.4.1.0（89.3 MB），
  `build/installer/SubFabric-beta 1.4.1-setup.exe` 约 1.78 GB（历史构建含 VibeVoice 运行时；
  2026-10-21 起安装包脚本已排除 `runtime-vibevoice` 与相关脚本）。
  **未创建 tag 与 Release**。
- **GitHub：上一轮云端提交成功且已核对**。`main` 上一轮为 `d62f0e9`（28 个文件，父 `852c882`）；
  **本轮 UWP 欢迎页、全模型速度测试与 1.4.1 版本改动尚未提交 GitHub**，需要重新授权设备码。
- **尚未做**：1.4GB 运行时下载实测、完整 4 小时音频回归、打包后的 exe 运行时冒烟。

**2026-10-19（历史快照，非本次验证）**

- 本轮 UI 增量：Material You 编辑器移除下拉字幕列表的补播动画（仅进入编辑器时播放入场）；`#sf-list-mode` 切换卡片/列表后只重播卡片入场，页头/筛选/搜索工具栏不参与动画也不刷新；专用 `home-view.is-view-switching` + 卡片 `data-view-enter` 使用 `uwp-view-in`/`my-view-in`（透明度始终 1、仅轻微位移），不再复用 `data-my-enter`/`data-uwp-enter`，动画结束不会掉回旧入场选择器导致二次闪烁；连点会清空上一轮并强制 reflow，每一轮都能重新起播。UWP 列表视图垂直 gap 从 2px 调到 6px；设置页动作栏移出右上角；UWP/MY 背景模式切换与 UWP 明暗切换使用 View Transition 交叉淡变。图标视觉微调：UWP 项目封面播放三角 `left:28.5px → 30px`，新建小组件加号 `translateY(-1px)`；MY 项目卡状态胶囊：`.pc-badges { margin-top:2px }`、`.pc-st { display:inline-flex; align-items:center; line-height:1; padding:3px 8px; margin-left:0 }`，上下留白对称；`.pc-actions { padding-left:8px }` 让标题、状态胶囊、按钮共用 x=271 左边界。全量回归 `_test/my-badge-align-full-20261019.json` 为 **98 通过 / 9 部分 / 0 失败 / 2 排除**。编辑器首屏波形/ASS 就绪提示改为 `toastAfterCueIntro()` 排队，等字幕卡入场类摘掉后再显示，避免弹窗打断列表动画；字幕卡出现间隔 MY `55→22ms`、UWP `14→8ms`，飞入/回弹单卡时长保持 420/180ms。UWP 首页动画已回退到本轮修改前的版本（不再使用 600ms 页面锁/首页专用排序），文件夹“＋”改为居中的内联 SVG。全量回归 `_test/home-anim-revert-full-20261019.json` 为 **98 通过 / 9 部分 / 0 失败 / 2 排除**。
- 新增 **视频导出**（双语硬字幕 / 生肉 / ASS 字幕，可多选），§11。
- 压制**GPU 优先**（NVIDIA → AMD → Intel → CPU），按「厂商 × 编码格式」逐项判断。
- 新增 `editor/ffmpeg-tool.js`：ffmpeg 定位与按需自动下载；「前置」新增状态卡与下载入口。
- 文档收敛为 `README.md` / `docs/PROJECT.md` / `AGENTS.md` 三份（原 23 份已删除，见 §13 索引）。
- 版本推进至 **beta 1.4**：显示 `beta 1.4` / 文件 `1.4.0.0`；**未创建 tag 与 Release**。
- 构建已核对：`build/SubFabric.exe`（89.1 MB，FileVersion/ProductVersion `1.4.0.0`，`NODE_SEA_BLOB` 在）、
  `build/installer/SubFabric-beta 1.4-setup.exe`（约 35.8 MB，含 `hardsub.js` / `ffmpeg-tool.js` /
  `export-video.js`）。**sha256 每次构建都会变（打包了会变的文档与源码），不写进文档，以实际文件为准。**
- 测试：全量 JS 回归 **96 通过 / 9 部分执行 / 0 失败 / 2 排除**；ESLint **0 error**。
- 已通过 GitHub REST API 提交到 `main`（`63eb463`，父 `9a738c3`），提交后核对远端文件与删除项一致。

**未验证 / 未执行**：打包后的 exe 未做运行时冒烟（SEA 启动器把端口写死 8321，而本机 8321 已被
beta 1.3 实例占用；启动器本轮未改动，其链路由该实例间接证明）；真实静默安装、GPU/ASR/LLM 实测未执行。

**2026-10-18 历史快照（非本次验证）**

- 版本推进至 beta 1.3：显示 `beta 1.3` / 文件 `1.3.0.0`（未创建 tag 与 Release）。
- 取色器重做为 Windows 经典双栏布局，并支持标题栏拖动、在鼠标点击处打开。
- Material You 明暗切换加入圆形扩散转场（View Transitions API，`prefers-reduced-motion` 时即时切换）。
- 统一设置页左侧栏压暗、修复设置页不显示自定义背景。
