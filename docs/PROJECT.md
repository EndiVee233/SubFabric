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
| `editor/css/`、`editor/js/`、`editor/lang/`、`editor/themes/`、`editor/assets/`、`editor/vendor/` | 样式、前端 ESM 模块、`zh-CN.json` 文案、主题包 JSON、Logo、libass 资源（vendor 不入库） |
| `editor/*.js`（顶层） | 后端 CJS 辅助模块：`cast.js`、`llm-text.js`、`reseg.js`、`k-line.js`、`fonts.js`、`secret-store.js`、`asr-chunks.js`、`audio-slice.js`、`bcut-asr.js`、`capcut-asr.js`、`hardsub.js`（视频导出，见 §11）、`ffmpeg-tool.js`（ffmpeg 定位与自动下载），以及 fork 并入的 `align.js`、`asr-service.js`、`ass-group.js`、`danmaku.js`、`hotwords.js`、`mt-local.js`、`project-pack.js`、`reflect.js`、`region.js`、`region-merge.js`、`repair-words.js`、`speech-gap.js` |
| `editor/scripts/` | `fetch-vendor.js`（拉 libass）、`sea-launcher.cjs`（SEA 入口）、`tray.ps1`、`gen_app_icon.py`、`gen_tray_icon.py` |
| `asr/` | Python 侧能力：`asr.py`、`asr_dual.py`、`asr_npu.py`、`asr_perf.py`、`vibevoice.py`、`diarize.py`、`multitalker.py`、`mt_nllb.py`、`confidence.py`、`common.py`；`asr/settings.json` 为含密文本机设置（不入库） |
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
  prepare（ffprobe → ffmpeg 抽 `audio.wav` + `peaks.bin`）→ ASR（whisper.cpp / Parakeet / VibeVoice /
  必剪 / 剪映 / NeMo）→ 语义分句 `reseg`（所有引擎必经）→ 可选 `diarize` → 写字幕（逐词 ASS 或 SRT）
  → LLM `translate`。
- **流水线状态**写 `meta.draft`（`running` / `paused` / `error` / `done`），前端轮询
  `GET /api/projects/:id/draft`；防重入用 `draftJobs.has(id)`，每步统一走 `safeDraftStep`
  （同步异常与 async reject 都收）。
- **项目内操作**统一为 `/api/projects/:id/<action>`：`info`(PUT 改名)、`retry`、`skip`、`rerecognize`、
  `translate`、`draft`、`subtitle`、`relink`、`prepare`、`peaks`、`audio`；`DELETE` 无 action 即删项目。
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
- **主题色遮罩**：`自定义主题色` 行与色板/恢复默认按钮同处 `.sf-theme-color-panel` 一块遮罩；
  MY 圆角 24px、UWP 2px、其它 8px，避免色板落在遮罩外。
- **角色列表入场**：每次进入编辑器后**第一次**切到角色页时 `#role-list` 加 `is-role-entering`，
  每张 `.role-card` 按 `--role-i` 以 32ms 阶梯执行 260ms 淡入 + `translateY(10px→0)` + `scale(.96→1)`；
  后续切回、数据刷新不重播；进入编辑器路由或载入/切换字幕文件时重置；减少动效或 `data-motion=off` 时关闭。
- **编辑器设置入场**：每次进入编辑器后第一次切到「设置」页时，`.settings-list` 加 `is-settings-entering`，
  直接子级 `.set-group` / `.st-card` 按 `--settings-i` 以 36ms 阶梯执行 260ms 淡入 + `translateY(8px→0)`；
  后续切回不重播，重置时机与角色列表相同。
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
- **Material 时钟**：时针与分针统一 `stroke-width:7`；SVG 中先画时针、后画分针，重叠时分针在上。
- **弹幕备注条**：输入框、停留时长下拉与发送按钮统一 34px 高；输入框基础圆角 8px，Material You
  下为 12px，与全局输入设计一致。
- **材质偏好**：毛玻璃压暗、模糊度、透明度由 `editor/js/studio-state.js` 保存、`studio.js` 同时算
  深浅色令牌、`studio.css` 末端统一应用，主题包不能绕开。
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
  `crispasr`、`runtime-python`、`ytdlp`、`logs` 等用户数据与运行时。入库的只有
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

- **最终结论：双引擎有效**，比最快的单引擎再快，NPU 与 N 卡分工并行是净收益。
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

**2026-10-19（本次，已完成且已验证）**

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
