# 项目当前状态（唯一权威入口）

- 当前任务（2026-10-17）：已修复视频区单击字幕后编辑框与片段高亮框的几何偏移。`main.js` 与 `overlay.js` 统一使用视频 `getBoundingClientRect()`、真实舞台偏移和未取整的画面矩形；`videoedit.js` 的 ASS 回退测量使用样式声明的字体、字号、粗斜体、横/纵向缩放、字距与 Canvas 字体指标，ASS 可用时继续以 libass 实际墨迹校准，SRT 使用字符级 `Range`。新增 `video-geometry-test.mjs`；完整回归 `node tests/run-all.mjs --report _test/video-subtitle-geometry-20261017.json` 为 89 通过、9 部分执行、0 失败、2 排除。`tests/jsmod/` 镜像已同步。状态：**已完成且已验证**。已随 2026-10-17 增量提交 GitHub（见「GitHub 与恢复」）。

- 当前任务（2026-10-17）：主题包已拆分为四个独立内置 JSON 包（Studio、Material You、SubFabric Classic、Windows UWP），并补齐类似材质包的自定义主题包导入、导出、内置/自定义分组、删除、替换和安全校验。自定义包支持白名单颜色令牌与本地 PNG/JPEG/WebP 预览图，导入上限 800KB，拒绝脚本、CSS 注入、SVG 和远程资源；UWP 仍保持固定 Windows 10 蓝色规则。状态：**已完成且已验证**。专项 `theme-packs-test.mjs`、`ui-integration-test.mjs`、`uwp-theme-test.mjs` 与 JS 语法检查通过；完整回归 `node tests/run-all.mjs --report _test/theme-packs-final2-20261017.json` 为 88 通过、9 部分执行、0 失败、2 排除。`tests/jsmod/` 三个主题相关镜像与生产源码逐字节一致。已随 2026-10-17 增量提交 GitHub（见「GitHub 与恢复」）。

- 当前任务（2026-10-17）：编辑器与主题体验增量已**完成且已验证**。时间轴项目载入默认 30 秒；按项目保存/恢复视频播放进度；任务中心尊重卡片/列表视图；无在线来源的本地视频异步抽帧生成项目封面；统一使用安装包高分辨率 Logo（Studio 品牌、编辑器左上角、托盘图标）；UWP 增大标题与卡片间距；设置页工作区去除整页灰色遮罩；胶囊样式限制为 Material You 并将倾斜角增至 26°。相关源码、模板、`tests/jsmod/` 镜像和 `PROJECT_MAP.md` 已同步。专项验证：时间轴 16/16、Studio 导航、首页项目列表、UWP 主题、UI 集成、Logo 静态资源与项目 API 冒烟、JS 语法均通过；完整回归 `node tests/run-all.mjs --report _test/current-ui-feature-full-20261017.json` 为 87 通过、9 部分、1 诊断、0 失败、2 排除；封面进程收尾补丁后的重点回归 7/7 通过。GitHub 保存：已随 2026-10-17 增量提交（见「GitHub 与恢复」）。

- 最后更新：2026-10-16（Asia/Tokyo）。
- 当前任务（2026-10-16）：将设置中的三项毛玻璃参数统一扩展到浅色模式，并让压暗、模糊度、透明度对 Studio、Material、Windows UWP、SubFabric Classic 全部主题包生效；状态：**已完成且已验证**。
- 当前任务：降低翻译/语义分句对 LLM JSON 输出格式的依赖，改为模型优先直接输出纯文本、程序负责严格解析为译文行或标点对；已**完成且已验证**。
- 历史任务（2026-10-16）：按 Windows 10 Fluent 设计规范继续收紧 Studio 生产界面，**已完成且已验证**。规范原文保存在用户粘贴附件；本轮重点是移除首页营销式 Hero、统一 Windows 10 中性色令牌、替换操作 Emoji 为 SVG 图标，并补齐 UWP 动态控件覆盖。
- 追踪任务（2026-10-16）：Windows 10 Fluent/UWP 主题包已**完成且已验证**。已移除 Studio 侧栏“资源管理”入口，设置页不再显示重复资源快捷栏，旧 `#/resources` 书签重定向到 `#/settings`；UWP 末端覆盖统一处理导航、设置卡、字段、选择器、编辑器页签、模型卡、方案抽屉、弹层、播放器、进度条、背景预览和运行时提示条，并压过通用圆角/玻璃规则。详见 [UI_INTEGRATION.md](UI_INTEGRATION.md)。
- 本轮用户反馈（2026-10-16）：UWP 设置分类已改为小圆角/近直角矩形，选中项使用中性表面与左侧短 Windows 蓝线；主导航同步使用中性选中表面。强调按钮固定为 `#0078D7`，悬浮/按下为 `#106EBE/#005A9E`；控件外围统一使用浅色 `#B8B8B8`、深色 `#666666` 描边。UWP 的自定义主题色输入、色板和旧取色入口均禁用，`#0078D7` 不再被粉色等用户 accent 污染。状态：**已完成且已验证**。
- 当前任务（2026-10-16）：新增字幕、改字幕、分段导入、逐词转换及其它逐词重分配路径统一按英文**字母数**分配时间；`i can do it` 的权重为 `1:3:2:2`。文本不变且没有发生时间范围重分配时保留已有真实词级时间；文本改变、词数改变或退化校准时重新按字母数分配。状态：**已完成且已验证**。
- 本轮验证：UWP 主题专项与导航回归继续通过；逐词专项 `word-split-test.mjs` 39 项、`region-import-format-test.mjs` 21 项、`align-test.mjs` 82 项、`karaoke-exhaustive.mjs` 28183 项、`karaoke-k-test.mjs` 158 项、`ass-escape-test.mjs` 40 项、`fix-word-color-test.mjs` 22 项均通过。调整 UI 集成保护断言后，完整回归 `node tests/run-all.mjs --report _test/letter-weighted-word-timing-final-20261016.json` 为 87 通过、9 部分执行、0 失败、2 排除。生成器、JS 语法和 `tests/jsmod/` 镜像核对通过。没有提交 GitHub。
- 本次自审查补充：在生产 CSS 末端增加 UWP audit pass，覆盖动态挂载的旧编辑器卡片/弹层/主题预览、关闭设置与方案抽屉动效、取消悬浮位移、统一 2–4px Fluent 几何及编辑器外壳表面；专项断言同步覆盖这些边界。
- 本轮材质实现：设置文案改为通用“毛玻璃压暗 / 模糊度 / 透明度”；`studio.js` 计算浅色材质变量，`studio.css` 末端按明暗模式把共享参数应用到导航、顶栏、项目卡片、编辑器表面、设置卡、弹层、菜单和字体选择器。UWP、Classic、Material 与 Studio 共用这组材质偏好；设置页自身继续保持可读的透明工作区。
- 本轮验证：`node tests/run-all.mjs --report _test/classic-light-glass-final-20261016.json` 为 87 通过、9 部分执行、0 失败、2 排除；`ui-integration-test.mjs`、`studio-navigation-test.mjs`、`uwp-theme-test.mjs` 与 `font-picker-test.mjs`（27/27）通过；生成器与相关 JS 语法检查通过。GitHub 保存（2026-10-16）：连接器的批量树与单文件 contents 接口对本仓库均返回 `403 Resource not accessible by integration`；本轮增量改经**已认证 REST 通道**（本机 Windows 凭据管理器内账号 `R2FtYml0` 的 PAT，含 repo scope）以单次原子多文件提交写入 main——提交前复核 HEAD 未前进，提交后核对父提交与变更文件集合（113 改动 + 4 新增 + 3 删除），提交标识与链接见最终报告。
- 规范对照补充：UWP 首页隐藏装饰性 Hero/统计椭圆，项目管理回到标题、筛选、搜索、列表/卡片的工作流；生产应用路径使用 `#0078D7`、`#F3F3F3`、`#FFFFFF`、`#EDEDED`、`#202020`、`#606060`、`#D1D1D1` 及对应深色令牌；“异常/反思/重校对/分段导入”按钮使用 `icons.js` 的单色 SVG，不再使用 Emoji。
- 初版主题浏览器检查（历史）：隔离端口 `8332` 曾确认选择器和基础浅/深色令牌；因用户反馈整体风格不够 UWP，该次结果不作为最终验收，现由下方完整覆盖复核取代。初版报告见 `_test/uwp-theme-results.json`。
- 浏览器验收（2026-10-16）：此前 Chrome headless/CDP 实际加载 Studio；Windows UWP 选择器、浅/深色切换和 `#/resources` 重定向生效，侧栏无资源管理且设置无重复资源入口。历史计算样式确认 Segoe UI、浅色 `#f3f3f3/#ffffff`、深色 `#202020/#2b2b2b`、按钮/字段/页签/播放器/进度条 2px、设置卡 4px、UWP 页面与卡片无 `backdrop-filter`；本轮按规范将生产令牌收紧为深色 `#1F1F1F/#2B2B2B`、浅色 `#F3F3F3/#FFFFFF`，未重新取得截图。当前回合再次启动独立 CDP 页面时目标崩溃；此前预先存在的 8334 服务未停止，避免影响来源不明的进程。真实安装器/SEA 仍未验收。
- 连续性规则：[CONTINUITY.md](CONTINUITY.md)；结构与红线：[../PROJECT_MAP.md](../PROJECT_MAP.md) §6–§8。
- 开始基线：当前目录为源码快照，无 `.git`，不初始化。Node v24.21.0（系统）/ v22.22.2（托管）；`gh` 已安装但未登录，Windows 凭据管理器内有账号 `R2FtYml0` 的 PAT；eslint@9 已装入托管 Node 工作区，可用于复现 CI 检查。
- 维护记录称曾将 417 个文件的 SHA-256 保存至 `_test/maintenance/baseline.json`；该文件在当前源码快照中不存在，未重建基线，也未据此覆盖文件。
- 远程开始基线：`EndiVee233/SubFabric` main；2026-10-15 为 `8cb07bac`，10-16 提交后为 `8cc76d84`，本次（2026-10-17）为 `085fcd7f`（含图标换新、beta 1.1 发版与版本文档提交）；main 未保护；连接器账号 R2FtYml0。

- 本轮用户反馈（2026-10-17）：修复非 UWP 主题时间轴字幕块右键菜单无反应。`timeline.js` 将右键菜单提升到 `body` 以避开 `#tl-canvas-wrap` 的 `overflow:hidden` 裁剪，并用 `getBoundingClientRect()` 按 CSS 尺寸换算命中坐标；字幕卡片播放中状态统一增强为背景、边框、阴影与“播放中”标识，自动跟随滚动增加短暂焦点反馈；中英分隔线统一为内容区全宽；字幕列表顶部保留角色、搜索、显示模式、跟随播放和异常快速筛选，高级刷新/修复/异常分类/反思纠错/全片逐词重校对/分段导入移入编辑器设置。状态：**已完成且已验证**。`node --check`、时间轴专项、卡片样式、异常筛选、Studio 导航、UI 集成与 UWP 主题专项均通过；完整回归 `node tests/run-all.mjs --report _test/uwp-context-follow-20261017.json` 为 87 通过、9 部分、0 失败、2 排除。
- 本轮用户反馈（2026-10-17）：修复 UWP 下首词开头/末词结尾拖拽略卡的问题。根因是词级拖拽每个动画帧调用 `assPlayer.updateNow()` 重建 libass 轨道，而整块边界使用防抖 `update()`；现统一词级预览走防抖刷新，松手仍立即 `updateNow()` 提交最终位置。源码与 `tests/jsmod/main.js` 已同步；状态：**已完成且已验证**。专项与完整回归 `node tests/run-all.mjs --report _test/word-edge-drag-smoothness-20261017.json` 为 87 通过、9 部分、0 失败、2 排除。
## 本次执行

- JS：`node tests/run-all.mjs --report _test/maintenance/js-results.json`，Node v24.21.0；96 项执行，88 通过、7 部分执行、1 个诊断、0 失败，2 项因真实项目数据排除。通过 `SUBFABRIC_PYTHON` 使词边界与 VibeVoice 行为用例完整执行。逐项结果在 gitignore 下 `_test/maintenance/js-results.json`。
- Python：8 个可隔离测试全部退出 0：confidence(65)、draft-role-gap(12)、fetch-format(58)、glommed-split(47)、frame-units 静态(11)、asr-segment-parity(24)、VibeVoice unittest(3)、diarize 合成 WAV/内存测试。frame-units 私有历史数据明确跳过；NPU `samples=None` 已知提示不影响结果。
- 语法：273 个 JS/MJS/CJS 文件 `node --check` 通过；33 个 Python 文件 `ast.parse` 通过。
- 改进：统一 JS 回归入口支持筛选/独立 JSON 报告，旧 repair15 命令改为兼容别名；测试默认隔离；纠错模型切换测试使用临时服务与设置；Python 行为探针可由 `SUBFABRIC_PYTHON` 指定；AES 用户名读取在受限系统 API 报错时回退账户环境变量；修复 home-only 工具的模板语法错误；更新 CI、项目地图和开发说明。
- 未运行/阻塞：本机没有 ESLint/Ruff；真实 GUI、GPU/NPU、推理模型、vendor、SEA/安装器未验收。用户项目颜色修复及字体状态 GUI 未运行；其余 7 项部分执行的确切原因见维护文档。
- 当前任务增量：`editor/server.js` 的翻译提示改为逐行纯文本并保留 JSON 兼容解析；`editor/reseg.js` 新增原词复述+词尾标点解析，校验词序/词数后再映射时间轴；`tests/reseg-test.mjs`、`tests/repair13-translation-context-test.mjs`、`tests/helpers/mock-llm.mjs` 已覆盖纯文本路径；`tests/jsmod/server.js` 与 `tests/jsmod/reseg.js` 已由测试自举同步。专项回归及完整 `node tests/run-all.mjs --report _test/translation-plain-text-full.json` 均通过：87 通过、9 部分执行、1 诊断、0 失败，2 项按环境排除。没有提交 GitHub。
- 历史 `docs/repair15-regression-results.json` 已恢复为开始 SHA-256 `86fdbe98737403e8aeaeb38df4d244b8ee24c4d0ff45802de62cbafefe572d10`；测试生成的 `tests/jsmod/` 差异是测试镜像同步，已保留。
- 最后复核：兼容入口定向运行 `secret-store-test.mjs` 与隔离 `correct-switch-test.mjs` 均通过；随后完整 JS 回归再次得到 88/7/1/0（排除 2）。
- 云端保存：本轮增量 18 个文件（16 个改动 + 新增 `docs/MAINTENANCE.md`、`docs/STATUS-before-maintenance-20261015.md`）经 GitHub 连接器以**单次原子多文件提交**写入 main。提交前核对：远程 HEAD 与开始基线一致（无并发变化）；本地与远端逐目录 git blob 比对（editor/、editor/js/、asr/、tools/、docs/、tests/jsmod/ 共 249 文件），差异仅限上述文件；敏感信息扫描无命中；全部改动 JS 通过语法检查。`tests/fixture.ass` 等生成物按 `.gitignore` 排除；`启动SubFabric(无窗口).vbs` 在远端为符号链接且与本任务无关，未纳入；`ui-config.example.json` 与远端逐字节一致，无需提交。
- CI 修复（2026-10-15 续）：`eslint.config.js` 浏览器侧 globals 补 `HTMLSelectElement` —— `editor/js/studio.js:739` 的自定义选择器用 `typeof HTMLSelectElement` 透传 `value/selectedIndex/disabled` 访问器，该全局自 8cb07bac 起缺失，导致 2026-10-13 以来每次推送的 `CI / JS · ESLint + 全量测试` 均失败（ESLint 步骤 1 error，测试步骤被跳过）；上一提交已修复 `tools/verify_home_only_running.mjs:97` 的解析错误（同类历史故障）。本地 eslint@9 对 `editor/ tools/ tests/` 复现 0 error（余 19 条历史 warning，不阻断 CI）。
- 提交前验证（2026-10-16 提交时重跑）：Node v24.21.0 完整回归 `node tests/run-all.mjs --report _test/oct16-verify-v24.json` 为 **87 通过、9 部分执行、1 诊断、0 失败、2 排除**；ESLint 0 error（19 历史 warning）；105 个改动 JS `node --check` 通过。Node v22.22.2（本机托管运行时）下仅 `repair12-build-install-test` 失败：该版本在 Windows 对**非 ASCII 路径**执行 `fs.cpSync` 会**原生崩溃**（已最小复现；v24 与 CI 的 Node 22/Linux 均通过；`repair12` 与 `tools/build-install.mjs` 本次均未改动，属运行时缺陷）。
- repair09 时序竞态修复（测试，随本次提交）：失败导入的项目目录与临时目录在 400 响应之后才清理完毕（实测本机稳定复现：响应到达时目录仍在、数百毫秒内消失），原测试收到响应后立即断言会误报；改为轮询等待真实“无残留”后再断言（意图与严格性不变），v22/v24 下均通过。A/B 对照远端版本行为一致，非本次增量引入。
- 提交（2026-10-17）：本轮 UI/主题/几何增量 36 个文件（30 改动 + 6 新增）经已认证 REST 通道单次原子提交写入 main；提交前复核远程 HEAD 为 `085fcd7f`（10-17 凌晨的图标换新、beta 1.1 发版与版本文档三条提交已在远程并包含于本地快照），提交后核对父提交与变更文件集合（30 改 + 6 增，无删除、无范围外改动）。新增文件：`docs/THEME_PACKS.md`、`editor/assets/app-logo.png`（512×512）、`editor/themes/{studio,material-you}.theme.json`、`tests/{theme-packs,video-geometry}-test.mjs`。
- 提交前验证（2026-10-17 重跑）：Node v24.21.0 完整回归 `node tests/run-all.mjs --report _test/oct17-verify-v24.json` 为 **89 通过、9 部分执行、1 诊断、0 失败、2 排除**（99 项执行）；ESLint 0 error（19 历史 warning）；24 个改动/新增 JS `node --check` 通过；51 个 `tests/jsmod/` 镜像与源码逐字节一致；`theme-packs`、`video-geometry`、`timeline-fit`（16/16）专项通过。

## 历史已验证成果（不代表本次重验）

- 新 Studio UI 已接入真实功能，默认新 UI、保留 legacy；ASS 控件固定在编辑器。完整需求/验收：[UI_INTEGRATION.md](UI_INTEGRATION.md)。
- 15 项修复已完成且已验证：[REPAIR_15.md](REPAIR_15.md)、[REPAIR_15_RESULTS.md](REPAIR_15_RESULTS.md)。
- 2026-10-15：字幕分句/切序/颜色过期引用、设置页材质/焦点/毛玻璃参数和主题包明暗预览已修复并实装；此前 JS 全量 78 通过、20 含跳过、0 失败。
- VibeVoice NF4 CUDA 4bit 已实装并有十秒真实推理证据；长音频、全新环境安装未验证。
- beta 1.0 SEA/Inno 产物此前已构建；真实安装自检未验证，避免覆盖已装版本。未授权本次覆盖安装。
- 本次源码快照没有 vendor/模型/推理 runtime，真实 GPU/NPU/ASR/LLM/wasm/托盘与完整安装验收须具备条件后单独执行。
- 原状态全部保留在 [STATUS-before-maintenance-20261015.md](STATUS-before-maintenance-20261015.md)，仅为历史证据，不再维护第二份状态；其中安装备份路径指向此前工作区，当前快照未确认存在。

## GitHub 与恢复

- GitHub：2026-10-17 增量已提交至 `EndiVee233/SubFabric` main，父提交 `085fcd7f84074c3e1dd51a6ae1d0c33da16bcd12`（在图标换新、beta 1.1 发版与版本文档三条提交之上续接）；提交标识与链接见最终报告。写入通道同 10-16（凭据管理器内 R2FtYml0 PAT → REST blob → tree(base_tree) → commit(parents=[期望 HEAD]) → refs PATCH `force=false`），提交前核对远程 HEAD、提交后核对父提交与变更文件集合（30 改动 + 6 新增，无删除、无范围外改动）。`tests/fixture.ass`、`_test/`、`logs/`、`.diag.json` 等生成物按 `.gitignore` 排除。
- GitHub：2026-10-16 增量已提交至 `EndiVee233/SubFabric` main，父提交 `829f2204fd48cea3601d64cd71fe321473d236d6`（10-15 的 CI 修复提交）；提交标识与链接见最终报告。写入通道：连接器 tree/contents 接口对本仓库返回 403，改用本机 Windows 凭据管理器内账号 `R2FtYml0` 的 PAT 走 REST（blob → tree(base_tree) → commit(parents=[期望 HEAD]) → refs PATCH `force=false`），提交前核对远程 HEAD、提交后核对父提交与变更文件集合（113 改动 + 4 新增 + 3 删除，无范围外改动）。`tests/fixture.ass`、`_test/`、`logs/`、`.diag.json` 等生成物按 `.gitignore` 排除。
- 10-15 提交（同通道）：维护增量 18 文件、父提交 `8cb07bac`；CI 修复 2 文件、父提交 `43d04941`。
- 恢复时先读本文件，再读 MAINTENANCE 与本次结果；不清理用户数据、不再本地暂存/提交/推送、不创建或调查 Hook。



