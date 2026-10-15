# 项目当前状态（唯一权威入口）

- **设置页残留黑色遮罩（2026-10-15，已完成且已验证并实装）**：定位到旧版 `.st-box.page-surface` 仍继承深色毛玻璃，导致设置页外层出现整块黑色背景；新增设置页专用高优先级透明规则，移除该层的背景、模糊和阴影，其他页面毛玻璃保持不变。开发版与安装版 `editor/css/studio.css` 已同步，备份在 `update-backups/20261015-settings-overlay/`。安装版硬刷新后深色设置页 computed 为透明、无 blur、无 shadow；已恢复浅色和默认毛玻璃参数，`ui-integration-test.mjs` 通过。

- **设置页遮罩与毛玻璃参数（2026-10-15，已完成且已验证并实装）**：设置导航、设置内容卡片和操作区恢复此前版本的无遮罩观感；毛玻璃继续用于稿件库、编辑器和弹层。外观设置新增“毛玻璃透明度”滑杆，并将压暗、模糊度、透明度分别保存、即时应用和跨刷新恢复；旧偏好自动兼容，默认值保持原强度。源码与安装版同步更新 `studio.css`、`studio.html`、`studio.js`、`studio-state.js`，备份在 `update-backups/20261015-glass-controls/`。`node --check`、`studio-navigation-test.mjs`、`ui-integration-test.mjs` 通过；真实 8321 已验证设置页无遮罩、主页卡片仍有毛玻璃，三项参数可调，最后恢复浅色与默认 80/18/100 设置。

- **主题包示意卡片明暗同步（2026-10-15，已完成且已验证并实装）**：Studio 与 Material You 主题包的示意工作区不再固定使用浅色 palette，`renderPacks()` 根据当前 `body[data-theme]` 将卡片内部背景、强调色与文字色切换到对应浅色/深色令牌。仅更新 `editor/js/studio.js`，安装前备份在 `update-backups/20261015-theme-preview-mode/`；开发源码与安装版 SHA-256 已核对一致。`node --check` 与 `node tests/ui-integration-test.mjs` 通过；真实 8321 设置页分别切换深色/浅色，Studio/Material You 两张示意卡片 computed 背景均随模式变化，最后已恢复浅色设置。

- **侧栏焦点框与操作按钮（2026-10-15，已完成且已验证并实装）**：修复桌面新 UI 左侧导航按 Tab 时描边被裁切的问题，改用控件内描边；文件夹新增按钮与移除按钮统一为圆角矩形、图标居中，悬浮/按下反馈保留；SubFabric 品牌按钮增加左侧内边距，版本号和文字与图标间距更均衡。源码与安装版 `editor/css/studio.css` 已局部更新，安装前备份在 `update-backups/sidebar-focus-buttons-20261015/`。真实 8321 硬刷新后核对品牌盒模型、设置焦点框和文件夹加号焦点框；`node tests/ui-integration-test.mjs` 通过。

- **字幕顺序/分句与深色毛玻璃（2026-10-15，已完成且已验证并实装）**：修复字体→中文在上→分句→再次切序时的失效事件引用、顺序反转与重复字幕；分句前捕获原词时序并继承中英顺序。Marlow 与重复导入稿件的损坏 ASS 头、样式、Events 已恢复，清理有日志证据的旧首句/半句残留，保留用户中文编辑与后续字幕；Skyblock 清理第二句旧长句残留，保留用户两半中文。三个稿件原文件、源码、安装版已备份于 `update-backups/subtitle-order-glass-20261015/`，修复候选经 `AssDoc` 解析、HTTP `/subtitle`、实际 8321 编辑器加载核对。深色设置新增“压暗 72–92% / 模糊 0–32px”，卡片使用半透明 `backdrop-filter`，长字幕列表内层不重复建大型模糊层，fallback 使用实色保证可读性；编辑器与设置主题同步。验证：`node tests/run-all.mjs` 通过（78通过/20跳过/0失败），另有 `tests/subtitle-split-order-test.mjs`、`tests/order-color-stale-test.mjs`、`tests/split-sentence-test.mjs`、`tests/studio-navigation-test.mjs`、`tests/ui-integration-test.mjs` 与三文件 Node 语法通过；真实 8321 `/api/version`、Studio 设置控件、深色卡片 computed blur、Marlow 编辑器字幕加载通过。安装版局部资源与主编辑逻辑已更新，未整体覆盖 legacy UI。GitHub尚未提交，连接器缺少 expected HEAD 原子写入能力。

- **VibeVoice CUDA 4bit（2026-10-14，已完成且已验证并实装；长音频与全新环境安装未验证）**：独立 runtime-vibevoice 与固定 NF4 权重已就绪，权重/tokenizer SHA-256 通过。RTX 4060 Laptop 8187MiB 实测 200 个 NF4 层，参数/缓冲区全 CUDA；CPU 推理、CPU/NPU fallback、CPU/磁盘 offload 均拒绝，NPU 无已验证后端，保持禁用。十秒英语旁白得到真实文本/句级时间/角色，解码3.1s、峰值分配6691MiB；候选 HTTP 初稿最终验收52s（早期另一次约30s）、8秒选区重识别21s，ASS/SPK1与时间偏移通过，无需 LLM，不伪造逐词时间。五文件事务安装完成，原 EXE/设置/项目/字幕等100项哈希核对通过；8321已恢复，三个变更静态资源按服务版本戳转换后与磁盘一致。真实设置页 VibeVoice 系列可进入，显示1个模型/1就绪，默认识别模型保留。源码 server/project 测试镜像已备份同步；本轮语法、vibevoice-contract/backend、studio-navigation、ui-integration（571控件/37资源）通过，此前 worker 行为与真实 CUDA NF4 推理通过。161637915字节 .dl 临时文件已清理；截图操作被中断，未保存新截图。恢复入口 `update-backups/vibevoice-20261014/`（manifest.json、inference-verification.json、installed-verification.json、verify-installed.mjs、mirror-sync.json）。下一步：长音频/全新依赖下载安装验收；恢复可进行预期HEAD校验的云端授权后审阅增量并保存。尚未提交GitHub。

- 最后更新：2026-10-15（Asia/Shanghai）。VibeVoice 安装于2026-10-14完成，安装后界面/API/保护哈希、测试镜像同步与相关回归收尾于2026-10-15完成；worker 行为测试本轮重新运行通过。长音频与全新环境下载安装仍未验证，云端保存仍受授权/预期HEAD接口限制。
- 当前下载与登录间距：已完成且已验证并实装（2026-10-14）。仅 studio.css 为该分类卡片内相邻 st-grid/st-row 增加12px纵向间距，覆盖画质→代理及Cookie输入→操作按钮；源/安装各自备份与单文件事务清单在 `update-backups/ui-fetch-spacing-20261014/`（installed）。候选 ui-integration 的571原控件/37资源/生成器/旧UI核对通过；隔离Studio浅色/Material深色1280×720与真实8321均实测两处12px、无横向溢出、error/warn为空。37真实资源与磁盘清单一致，12稿件/0任务、保护哈希/配置不变，laterDataChanges为空；未点击Cookie保存/清除或运行真实下载/登录验证。截图settings-live.jpg；16304临时服务和验收标签已关闭，视口恢复。纯CSS未增加JS或测试文件；未运行ESLint或构建安装包。上游main收尾仍ebf9ff2828941d5dfc7f39aeb4ec7b2a3ab40b1f，gh缺失/连接器无expected-HEAD能力，尚未提交GitHub；恢复范围包含本轮CSS及此前未提交增量，见既有云端状态。
- 当前焦点/日志/设置布局：已完成且已验证并实装（2026-10-14）。日志三子页统一主题分段按钮（Studio 8px / Material 胶囊）；设置/导航/日志焦点内绘，品牌按钮轮廓收紧；唯一版本节点移到品牌旁，仍由 main 读取真实服务版本，列表标题不重复。设置以 #st-view 整页滚动，右栏不独立滚动，分类切换复位新滚动容器；返回/必要保存保留原监听器，移标题右侧，返回用强调色区分卡片。源码及安装独立局部补丁仅三前端文件，生成器与 studio.js 镜像同步；备份 `update-backups/ui-focus-settings-layout-20261014/`（installed）。studio-navigation、源码及候选 ui-integration（571原控件/37资源/生成器/旧UI）、两JS语法通过；隔离两主题焦点/品牌/日志切换/完整底卡、1280×720及1024×640桌面无横向溢出、返回编辑器链路通过。真实8321刷新后核对焦点内环、品牌版本、底部卡片、三个日志切换与返回入口，error/warn为空；37资源与磁盘/清单一致，12稿件、0活动任务，安装及首次验收的保护哈希/偏好配置未变；后续复核报告一个稿件的 project.json/subtitle.ass 于17:07:16发生运行后变化，未覆盖或回退，页面资源/EXE/配置仍严格通过。截图 settings-live.jpg / settings-bottom-live.jpg 在备份；临时31771服务与验收标签已关闭，视口已恢复。未运行ESLint（无可用包）、真实ASR/LLM/下载或安装包构建。上游main收尾仍为 ebf9ff2828941d5dfc7f39aeb4ec7b2a3ab40b1f；gh入口缺失、连接器无expected-HEAD原子写入能力，尚未提交GitHub。
- 当前视觉修整：已完成且已验证并实装（2026-10-14）。首页胶囊悬浮字保持直立；设置模型间隔14px、子视图卡片间隔16px；稿件库/任务中心轨道8px，Material完成波浪stroke8px、暂停直线。前置仅三列 Python/NeMo/说话人小卡（未安装显式下载，Python路径details保留），重复运行环境及冗余底栏提示隐藏；重新识别常驻真实select移到语音识别主页最下方，change仍POST原接口。翻译方案透明整卡按钮/主题材质/字号与标签统一；硬件条999px胶囊。流光支持跟随主题/苔绿/海蓝/暮霞/自定义三色及动态/静态，localStorage严格校验保存、跨页同步，背景静态/隐藏/减少动效无动画，未增加JS时钟。六前端文件事务安装，备份 `update-backups/ui-settings-polish-20261014/`（installed），安装版独立局部补丁保留原project差异。扩展studio-navigation（流光验证/保存/visibility/无循环/重新识别真实API/三小卡）、ui-integration（颜色校验/旧配置/拷贝隔离、候选HTTP/571控件/生成器）、home-project-list及三JS语法通过；镜像一致。隔离Studio/Material浅深色、14/16px实测、海蓝刷新/静态和减少动效、任务暂停8px线、无溢出及error/warn空通过。实际8321已刷新，首页hover外20°与内−20°抵消、前置三列/硬件999px/重新识别底部验收；37资源与磁盘/清单一致，12稿件、0活动任务，保护哈希及用户偏好/配置未变。截图 `settings-live.jpg`，33992临时服务/29标签已关闭；未跑真实ASR/LLM/下载，不重启/构建EXE；本轮ESLint未运行（无可用包）。上游main收尾仍为 `ebf9ff2828941d5dfc7f39aeb4ec7b2a3ab40b1f`，gh入口缺失、连接器无expected-HEAD原子写入能力，尚未提交GitHub。
- 前轮设置分层与命名方案：已完成且已验证并实装。翻译主页面默认空，仅显示用户保存的命名方案；新增/编辑表单独立保存服务商、API/模型/参数/术语/提示词，支持选用、删除、保存后使用和草稿连接测试；凭证后端加密且不回传，原配置保留。语音识别使用 Whisper / Parakeet / 云端 / 前置大卡片，VibeVoice 原生禁用；Parakeet 主列表三种硬件模型，额外多说话人/双引擎收在 details，依赖与目录/重新识别/说话人分离归前置。全局“编辑与工作台”已移除，五组编辑器设置、自愈与 ASS 保留原稿件入口。旧 UI 继续单配置/抽屉链路。五文件事务安装，备份 `update-backups/ui-settings-schemes-families-20261014/`（installed）；安装版各文件单独补丁，未复制覆盖源码与安装原有差异。两次真实8321核对37资源、12稿件、默认新UI/配置隐私和保护哈希通过，laterDataChanges为空；当前程序正常运行。源码及候选方案HTTP隔离测试/扩展 studio-navigation/ui-integration、Node语法、llm-params与repair13通过；浏览器隔离空列表/命名保存/刷新/English术语/两主题卡片/70词条自然高度，实际空列表/5卡片/6分类/编辑器设置原位且1280px无横向溢出、error/warn为空已验。截图 `settings-live.jpg` 在备份目录。未运行真实ASR/LLM/下载，不构建EXE；本轮未运行ESLint（常用缓存及bundled runtime无可用包）。上游 main 本轮核对仍为 `ebf9ff2828941d5dfc7f39aeb4ec7b2a3ab40b1f`；gh缺失、连接器无 expected-HEAD 原子写入，尚未提交 GitHub。
- 本轮设置收口（2026-10-14）：已删除全局 ASS 分类、资源快捷入口和帮助页死链接；未删除编辑器中的 `word-convert-group`、`ass-style-group`、`ass-fx-group`、ASS 预设导入导出。常驻 ASS 节点、值和监听器在设置/资源/编辑器路由间保持不变；事务安装 `studio.html`、`studio.css`、`studio.js` 三文件，备份 `update-backups/ui-settings-ass-editor-only-20261014/`（installed）。`studio-navigation`、`ui-integration`、Node 语法及真实8321资源/保护哈希核对通过，设置页显示7类，编辑器设置页仍显示 ASS 双语样式、逐词转换与后处理。
- 本轮首页统计胶囊微调（2026-10-14）：将“可编辑稿件”统计数字与标签整体向左上偏移 3px/4px，适配倾斜胶囊的视觉重心；Studio 生产 CSS 与 Material You 原型主题同步，事务安装 `editor/css/studio.css`，备份在 `update-backups/ui-orbit-text-position-20261014/`（installed）。实际首页刷新后已核对 12 个可编辑稿件与页面布局，保护文件哈希不变。
- 本轮设置视觉修整（2026-10-14）：修复 Material You 深色设置页左侧分类选中框被滚动容器裁切的问题，将焦点外框改为控件内绘制；统一右侧翻译方案/模型列表卡片为 16px 圆角。仅安装 `editor/css/studio.css`，备份在 `update-backups/ui-settings-model-corners-20261014/`（installed）。实际设置页翻译与术语分类、8 个方案卡片、导航回归和 571 个真实控件完整性检查通过。
- 本轮 LLM 设置交互（2026-10-14）：设置 → 翻译与术语 → LLM 方案列表改为点击整张方案卡片展开配置；配置区插入当前卡片正下方，使用高度/透明度/位移连续展开动效，移除右侧滑入视觉。保留原服务商选择、API Key、模型、术语、提示词、测试、保存和取消链路；卡片支持 Enter/Space 键盘展开。事务安装 `studio.html`、`studio.css`、`project.js` 三文件，备份在 `update-backups/ui-llm-inline-settings-20261014/`（installed）。实际运行版已核对卡片下方展开，Node 语法、ui-integration、studio-navigation 通过。
- 当前目标：将已完成原型接入真实 SubFabric，默认新 UI，保留旧 UI 并支持配置文件切换；完整保留功能，尤其 ASS 双语样式设置。需求与计划见 [UI_INTEGRATION.md](UI_INTEGRATION.md)。
- 整体状态：UI 接线已完成且已验证；**beta 1.0 安装包已实际构建完成（2026-10-14）**：`build/SubFabric.exe`（文件版本 `1.0.0.0`）与 `build/installer/SubFabric-beta 1.0-setup.exe`（34.3MB，解包 94 文件 / 104.2MB）均已产出并通过构建后核对。**未执行真实静默安装自检**（该步会原地覆盖用户已装的 2.4.0），故"装完能跑"属未验证。
- 上一任务：15 项修复已完成且已验证，完整验收记录：[REPAIR_15_RESULTS.md](REPAIR_15_RESULTS.md)。
- 前轮设置重做：已完成且已验证并实装。当时全局设置保留7个一级分类（外观与体验 / 编辑与工作台 / 语音识别 / 翻译与术语 / 识别与校对 / 下载与登录 / 性能与调度）；ASS 样式与特效已从全局设置移除，完整控件固定留在稿件编辑器设置页，避免把当前稿件功能误认为全局配置。571旧控件保留，常驻节点/未提交翻译草稿/编辑器原位恢复、键盘分类、稳定模型委托、生成器模板与图标回归通过；Node语法、studio-navigation、ui-integration通过，studio.js镜像一致，语言新增63键且保留既有译文。安装4个前端文件，备份在工作区 `update-backups/ui-settings-redesign-20261014/`（installed）；实际8321的37资源/磁盘/清单一致，9项保护哈希不变，12项目、默认新UI/配置隐私正常。隔离Studio/Material浅深色与流光、真实八类1280px无横向溢出/底栏可见、抽屉离类关闭与草稿保留通过，error/warn为空。实际Studio浅色设置页已打开，截图在备份settings-live.png；8356隔离服务/标签已关闭，真实8321与8347原型保留。完整功能分类与理由见 UI_INTEGRATION；未运行真实GPU/ASR/LLM/下载或构建。
- 前轮选择栏：已完成且已验证并实装：Studio选择栏统一为8px圆角细描边按钮、10px轻阴影菜单、6px选项和淡色选中勾选，含全部页面单选/动态卡片、倍速及字体面板；常规38px、编辑器/卡片与倍速32px，两主题共用事件与键盘交互，Material造型保留。补齐st-grid/sm-model可访问标签。Node语法、扩展studio-navigation（Studio键盘/禁用/焦点/倍速/重复扫描及标签）和ui-integration通过，studio.js镜像一致。备份在工作区 `update-backups/ui-studio-choices-20261014/`（installed）。真实8321的37资源/磁盘/清单一致，8项保护哈希不变、默认新入口/配置隐私通过。浏览器Studio浅深色菜单、Material仍16px圆角、编辑器倍速32px/菜单10px、12张稿件卡片32px/8px均已验；1280px无横向溢出，error/warn为空；已恢复Studio浅色，无新临时服务。前轮全页面Material选择栏及胶囊搜索已实装，备份 `ui-global-choices-20261014`；8px播放轨道/20px滑块/13px时间的备份为 `ui-material-selects-20261014-9f284ff5`。
- 前轮页签字号：已完成且已验证并实装：字幕/角色/设置/日志11px→14px。备份在工作区 `update-backups/ui-editor-tabs-20261014-9abf0e01/`（installed）；运行字号、可见页签无溢出、8321资源一致及八项保护哈希不变已验。
- 前轮分隔线：已完成且已验证并实装：隐藏横竖两条装饰线（含悬浮），保留8px横区/6px纵区、原拖动监听器及光标。备份在工作区 `update-backups/ui-hidden-dividers-20261014-d7c85e7a/`（installed）；8321可见空编辑器确认伪元素display:none、拖动区pointer-events:auto，资源/磁盘/清单一致、八项保护哈希不变。旧UI/原main/style/ui未改。
- 前轮编辑器背景：已完成且已验证并实装：跟随全局主题背景，纯色保持实色，流光/图片模式在外壳使用78%主题表面材质，背景层位于工作区下方；字幕卡、吸顶头、视频与时间轴canvas保持清晰。非流光模式隐藏流光层。仅安装studio.css，备份在工作区 `update-backups/ui-editor-background-20261014-af77296d/`（installed）。ui-integration及隔离三种背景/刷新保留/减少动效/1280px无溢出通过；8321资源一致、八项保护哈希不变，实际安装设置页error/warn为空。隔离libass有一次隐藏零尺寸提示；临时服务已关闭，8347原型保留。
- 前轮播放器修整：已完成且已验证并实装：播放/暂停与音量 SVG 居中，Material 播放按钮40px、前后跳转28px、间距2px（总宽100px）；主题圆角倍速菜单支持鼠标和键盘。仅更新 studio.css/studio.js，备份在工作区 `update-backups/ui-player-refine-20261014-269bf2c3/`（installed）。8321资源/磁盘/清单一致、八项保护哈希不变、单个镜像一致；语法、ui-integration、扩展studio-navigation及隔离深浅色菜单/真实倍速/空格不触发播放/SVG中心/1280px无溢出/Studio原select通过。隔离libass有一次隐藏零尺寸提示；真实安装设置页刷新error/warn为空。临时服务/标签页已关闭。
- 本轮实装：studio.css、studio.js、zh-CN.json 三文件，备份/候选/哈希清单在工作区 `update-backups/ui-material-player-20261014-f9219acf/`，状态 installed。真实 8321 三资源/磁盘/清单一致，八项保护哈希不变；Node 语法、语言 JSON、ui-integration、扩展 studio-navigation 通过，单个镜像同步。隔离实测 0→10→0 秒、35% 音量/1.5× 倍速、播放暂停轮廓/运行波浪；1280px 无横向溢出，Studio 切回保留原样。实际安装版已刷新，error/warn 为空。
- 前轮播放条修复：即时跟随/悬浮迁移/主题色边缘/示意图已完成且实装，三文件备份在工作区 `update-backups/ui-seek-theme-20261014-b553534b/`；旧悬浮位置隐藏、新轨道时间提示与键盘调整已验。
- 上一轮 UI 修整：主页胶囊、重复播放条、波浪接缝、两列角色及浅色外观行已完成且实装；四文件备份在工作区 `update-backups/ui-touchups-20261014-UV9M1y/`。
- 本轮设置与 VibeVoice 云端：上一轮提交受到阻塞，2026-10-15本轮已**与远端 main（59e811d）同步**并合入 PROJECT_MAP §1.1 版本号命名规则、beta 1.0 推送记录与 "EndiVee is the biggest bird"，本地 UI/Studio/VibeVoice 增量合并冲突已解并形成新的本地提交；后续推送目标为 EndiVee233/SubFabric，并通过该仓库接口原子保存。`update-backups/vibevoice-20261014/`、上一轮未提交的工作记录与候选在恢复时按 `source-before` 与本轮安装/镜像清单区分任务范围。
- 此前真实首页修复的安装范围：安装版 project.js 的首页代码段与 ui.css。保留其他已安装代码、项目/设置/模型与用户已有修改；旧文件及哈希清单备份在工作区 `update-backups/home-list-20261013-TM05xm/`。当前原型调整没有安装操作。
- 上一任务基线：[repair15-baseline.json](repair15-baseline.json)。此前实装只更新上述两个前端文件；本轮编辑器修改前哈希见原型 review/editor-layout-baseline.json，调整原型编辑器/数据/入口/必要测试与文档，新增两张桌面截图；真实源码及安装文件未修改。
- 历史 PR #7 为上一任务文档工作，本轮不更新。此前 CI 成功不代表本轮验证。
- 最新范围（2026-10-15，承接远端 5a3ba25/ebf9ff2/59e811d）：已把 PROJECT_MAP §1.1 版本号命名规则（5a3ba25）+ beta 1.0 推送记录（ebf9ff2）+ "EndiVee is the biggest bird"（59e811d）三条远端提交同步到本地 main；本轮 UI 接线、Studio 毛玻璃参数、设置页材质、主题包示意、VibeVoice CUDA 4bit 等增量在 `docs/STATUS.md` 顶部按"已完成且已验证并实装"列出，准备推送至 EndiVee233/SubFabric。
- 此前真实首页修复的安装范围：安装版 project.js 的首页代码段与 ui.css。保留其他已安装代码、项目/设置/模型与用户已有修改；旧文件及哈希清单备份在工作区 `update-backups/home-list-20261013-TM05xm/`。当前原型调整没有安装操作。
- 上一任务基线：[repair15-baseline.json](repair15-baseline.json)。此前实装只更新上述两个前端文件；本轮编辑器修改前哈希见原型 review/editor-layout-baseline.json，调整原型编辑器/数据/入口/必要测试与文档，新增两张桌面截图；真实源码及安装文件未修改。
- 历史 PR #7 为上一任务文档工作，本轮不更新。此前 CI 成功不代表本轮验证。
- 发布版本源：`editor/server.js` 与 `editor/README.md`、Inno `MyAppVersion` 为 `beta 1.0`；`APP_FILE_VERSION` / `MyAppFileVersion` 为 Windows 兼容的 `1.0.0.0`。**版本号推进规则与"下一个待发版本"已写入 PROJECT_MAP.md §1.1（本次默认下一版：显示 `beta 1.1` / 文件 `1.1.0.0` / tag `v1.1.0-beta.1`；若为 beta 1.0 修补重发则 tag 用 `v1.0.0-beta.2`）。**

## 本轮 beta 1.0 构建与发版（2026-10-14）

- 构建链路（全部实际执行成功）：`node editor/scripts/fetch-vendor.js`（libass worker + wasm + Noto CJK，18.4MB）→ `python build_exe.py`（SEA blob 注入 + rcedit 图标/版本 + GUI 子系统）→ `ISCC.exe build/installer/SubFabric.iss`。
- 产物核对：`build/SubFabric.exe` 87,057,920 字节，含 SEA sentinel fuse 与 UTF-16 版本串（`SubFabric 字幕工作台` / `1.0.0.0` / `EndiVee233`）；安装包 35,925,258 字节（34.3MB），sha256 `bb0897c7b8e13aebf340afbfa891d971440ce6e3b2c0026336cb199a4541c7ec`；按 .iss 的 [Files]+Excludes 复算得 94 个待装文件 / 104.2MB（editor 71、asr 19、根 4），与 README 期望的 ~106MB 同量级，说明 vendor 已进包（未复现"掉到 22.7MB"的失败形态）。
- **修复了一个既有隐患**：`SubFabric.iss` 的 `VersionInfoProductVersion` 原为 `{#MyAppVersion}`（显示版本 `beta 1.0` 非纯数字）→ ISCC 报 `Value of [Setup] section directive "VersionInfoProductVersion" is invalid` 并中止。上一轮只改版本标记、未真正编译，所以一直没暴露。现改为 `{#MyAppFileVersion}`，并把该文件里"远端补丁位 +1"的旧口径注释改为指向 PROJECT_MAP §1.1。
- 未做（明确记录，不算已验证）：真实静默安装/卸载自检、装后启动与真实 GPU/ASR/LLM 验收。未在用户机器上安装或改动其现有 2.4.0 安装。
- **云端状态（2026-10-14）：云端提交成功且已核对**。`EndiVee233/SubFabric` `main` 由 `c288c89a9557`（2026-10-13）前进到 `5a3ba25021fa`
  （`docs(版本): 新增 PROJECT_MAP §1.1 版本号命名规则 + 修正 .iss 版本字段与发版口径`，改动 4 个文件：PROJECT_MAP.md / build/installer/SubFabric.iss / editor/README.md / docs/STATUS.md；`force=false` 快进，无历史改写）。
  提交前逐文件核对：远端 416 个 blob 与本地仅这 4 个不同、无并发变化；提交后复查差异为 0、本地缺失为 0。
  **Release 已发布**：`v1.0.0-beta.1`（name `SubFabric beta 1.0`，prerelease，tag 指向 `5a3ba25`），
  资产 `SubFabric-beta.1.0-setup.exe` 35,925,258 字节，`digest = sha256:bb0897c7…` 与本地一致；
  链接 <https://github.com/EndiVee233/SubFabric/releases/tag/v1.0.0-beta.1>。用连接器与 REST 两条路径分别核对通过。
- 观察（未处理，非本次范围）：PROJECT_MAP §4/§11 与 STATUS 多处描述的 `prototypes/subfabric-ui/` 在当前工作区与远端仓库中**都不存在**
  （`.gitignore` 也未忽略它）；`editor/lang/en-US.json` 只在已装的 2.4.0 里有、仓库中没有。两者均不影响本次安装包内容（`.iss` 按 `editor/**` 通配，不含这两个路径），未擅自改动文档或补文件。
- 观察：本次安装包 34.3MB，而 v2.4.0 的资产为 53.9MB。两者 `SubFabric.exe` 体积几乎相同（87,057,920 vs 87,058,432）、vendor 与字体齐全、待装文件清单按 `.iss` 复算一致，
  故判断差异来自压缩/输入而非内容缺失；但**最终内容比对需真实安装后 `find`+逐字节核对**（本次未做）。
- 云端状态：**云端提交成功且已核对**（2026-10-13）。上一轮"整文件替换、无 expected-HEAD"的阻塞已改用本地 Git 流程解决：先把工作树按主题拆成 7 个原子提交（`16bd6c8`…`fcce6b2`），再把上游 98 个提交合并进来做兼容（`6c74025`），最后**快进**推送。目标 `EndiVee233/SubFabric` / `main` 由 `5d0e91c66354414b7158f2e69a546fd9359de5cf` 前进到 `6c7402596262618337cedad1c30e4a9c500b869c`；原 HEAD `5d0e91c` 仍是新 HEAD 的祖先（历史无覆盖、无 force）。账号 `R2FtYml0` 对该仓库有 push 权限（`permissions.push=true`）。
- 合并遗留：`repair09-pack-import-test`、`repair12-build-install-test` 在本机失败；已在**合并前的 `fcce6b2`** 用独立 worktree 复核，同样是这两个失败 → 属既有/环境问题，非本次合并引入，未改动其行为。

## 当前 UI 原型检查点

- 编辑器旧布局回归：已完成且已验证；恢复左起止/时长列、右双语卡片，字幕覆盖波形并局部 blur(1.25px)，拖动期间关滤镜。角色单击分配、右键/Shift+F10 改名改色，弹窗取消/焦点恢复已验。稿件库与编辑器均可打开独立逐词示例（5句/33词/非等分合成词时间），支持播放高亮/点词跳转/拖边界/键盘微调、句时间同步/英文改写失效。时间轴四项设置保存/导入校验/实际重叠分轨已验；下滑更早、上滑更晚，Ctrl+滚轮锚点/倍率由实际事件回归覆盖。编辑器 129（本轮46新增）、主流程40场景/196断言、状态94、主题30场景/2618断言、进度51及相关语法全部通过。浏览器1280×720设置改值刷新保留、边界1.25→1.30→1.50并撤销、滚轮100→0、点词1.7/2.9与高亮、播放到30秒自动暂停、无横向/词轨纵向溢出，error/warn为空。普通交付编辑器已打开逐词示例且主页已刷新；截图/限制见原型验收记录。未安装/提交/推送/发布。
- 波浪进度：已完成且已验证；独立原型稿件、任务、模型下载与编辑器接入共享 `progress.js`。单个可见性观察器与固定图案 CSS 位移，无新增动画帧循环/计时器，后台/屏外/减少动效停止；编辑器暂停/后台清除原播放时钟。生命周期 51、编辑器 83、主流程 38 场景/185 断言、主题 30 场景/2618 断言、状态 82 与相关 Node 语法通过。浏览器已验键盘定位、拖动至 30.8s、运行波浪/暂停直线；任务暂停保留 63% 后继续完成，done/error 无动画；屏外稿件条不动画，可见横条动画。编辑器 1280×720 无横向溢出，验收控制台 error/warn 为空。仅验收命名空间示例任务发生变化。截图和性能验证边界见原型验收记录；独立服务 session 83126、8347。未安装、提交、推送或发布。
- 首页细节调整：已完成且已验证；加入 16:9 合成视频封面与对应编辑入口，倾斜胶囊统计保持文字直立，SVG 加号几何居中。Node 语法、主流程 38 场景/185 断言、主题 30 场景/2612 断言通过；1280×720 浅深色首排底部约 710px、文档宽度 1265/1265，无横向溢出，加号中心偏差为 0/0。封面打开对应独立编辑器、统计筛出 4 个可编辑稿件、花瓣进入新建向导均已验；验收控制台 error/warn 为空。交付首页已刷新，隔离验收外观已恢复。最新截图和细节见原型验收记录。不安装、提交、推送或发布。
- 主题包：已完成且已验证；内置 Studio/Material You、JSON 导入导出、自定义主题色、草稿包保存/取消与同 ID 替换回滚、跨页同步、花瓣/倾斜胶囊主页与波浪播放条。上一轮主题 30 场景/2612 断言、主流程 38 场景/185 断言、状态 82 与编辑器 72 通过。浏览器已验自定义色保存刷新、主题包导入/取消/保存刷新/导出文件、深色编辑器、波浪条键盘与鼠标拖到 30.9 秒、播放更新；独立编辑器无横向溢出。主题静态白名单 200/API 与 review 夹具 404；上一轮最终主页/编辑器控制台 error/warn 为空。截图和详细结果见原型验收记录。入口与数据继续和真实程序隔离，不安装、提交、推送或发布。
- 主原型本轮打磨已完成且已验证：桌面首页继续编辑横条、上下文筛选/空状态、文件夹新建继承、设置常驻保存反馈与离场三选项、无模型阻止创建、链接解析代次与连接弹窗隔离、取消保留进度/重试、模型下载暂停继续。新建向导明确只记录文件名、使用合成字幕，完整工作区恢复仍在设置中。
- 上轮主原型浏览器已验：设置继续调整/放弃/保存并离开、品牌链接离场保护、保存外观刷新、链接改写后重新解析、文件夹配置继承、创建活动置顶、暂停/取消后进度与需处理分类、取消刷新/重试、模型下载暂停刷新/继续/取消、旧方案结果不串入新弹窗、无模型阻止创建、搜索无结果/清除恢复。上轮主流程 37 场景/175 断言通过；本轮扩展为 38 场景/185 断言。最新截图与细节见原型验收记录。
- `prototypes/subfabric-ui/`：稿件库、新建向导、任务中心、资源、设置、帮助与编辑交互已实现；无真实 API。独立编辑入口为 `editor.html`，沿用旧版工作区空间分配并采用简洁四 Tab 侧面板。
- 前轮已验证：新建/保留配置、队列、模型模拟下载/取消、翻译方案模拟连接成功、术语/样式保存、外观/图片背景/设置持久化、字幕输入/查找替换/AI建议/导出 SRT、JSON 项目数据导出、分段偏移导入/撤销、字幕指针拖拽/撤销、弹层拖动/Esc 焦点恢复、最近稿件恢复、独立工作台备注/角色/样式/日志/时间轴。
- 隔离测试：编辑器行为 72 项通过；工作区导入与资源规范化校验 82 项通过，拒绝损坏嵌套数据、非法样式/术语导入，并覆盖无稿件模型下载任务。独立编辑器 1280×720 浏览器布局已验：文档无横向溢出，预览约 847px、时间轴完整、右侧面板可滚动。
- 用户要求桌面优先，停止继续扩展手机端；窄屏基础检查已经做过。本轮桌面首排卡片信息与短屏侧栏入口完整可见，资源 5 个标签均可见；桌面文档无横向溢出。
- 浏览器审批曾短暂超时/额度失败，后续正常恢复；本轮最后清除筛选动作两次审批超时，用户继续后正常完成复验。最终清除搜索恢复 6 个稿件；交付预览控制台 error/warn 为空。未绕过浏览器安全控制。
- 原型服务：`node prototypes/subfabric-ui/serve.cjs`，`127.0.0.1:8347`。修改静态白名单需重启此独立服务，不影响真实 8321。

## 本次首页修复与验证

- 原因：排序分支跳过内容未变的卡片；旧 `data-from` 被每轮重复用于数字动画；完成卡片仍有 CSS 填充动画；任务更新修改时间会重建整卡。
- 行为：下载/提取/识别等活动稿件置顶，组内沿用服务端顺序；失败/暂停稿件回普通区。复用卡片也参与排序，仅位置变化时移动节点。
- 进度：移除整表百分比扫描与通用填充动画；首次直接显示当前值，只有 running 的新进度才做 420ms 过渡。进度/消息/显示时间就地更新，旧动画和已移除节点不再写数字。
- `node tests/home-project-list-test.mjs` 通过：真实 initProjects/路由/轮询 + 内存 DOM/时钟，覆盖活动置顶、多任务顺序、静态卡片零改写、相同进度不重播、连续动画接替、完成/移除、prepare/下载空窗、改名/删除、减少动效及停止轮询。旧实现在活动排序断言失败，修复后通过。
- `node tests/repair05-project-load-test.mjs` 通过；本次生产 JS 与新增测试的语法检查、离线 ESLint 通过（0 错误/0 警告）；`tests/jsmod/project.js` 与生产源码逐字节一致。
- 隔离 Edge 加载真实 style.css/ui.css + 合成卡片通过：done/paused/error 的 animation 为 none、transition 为 none；running 为 shimmer + 0.42s width 过渡；减少动效模式无动画。普通沙箱启动失败，获批执行权限后通过；镜像同步与离线 lint 同样需获批权限。
- 实装：安装版首页代码段与修复前基线完全一致，保留文件其余部分并应用源码首页段；ui.css 同步本次修改。安装候选引用当前安装依赖，真实 initProjects 行为回归及 Node 语法检查通过；先备份，再加锁暂存替换并核对哈希，失败路径可回滚。
- 当前 2.4.0 已从原 SubFabric.exe 启动。真实 8321 HTTP 核对通过：JS（去服务版本戳后）与安装文件一致、CSS 字节一致、首页 200、12 个项目列表正常。EXE/后端/设置与 Git 元数据哈希不变；未构建、未启动识别任务。当前无活动任务，活动场景依据安装候选的隔离行为回归验证。

## 上一任务修复进度

| 编号 | 内容 | 状态 | 验证 |
| --- | --- | --- | --- |
| 1 | 模型删除边界 | 已完成且已验证 | repair01-model-delete-test.mjs：合法、根、兄弟、自定义、杂文件、junction |
| 2 | 并发字幕保存 | 已完成且已验证 | repair02-save-test.mjs：交错、多窗口、PUT/beacon、断连清理 |
| 3 | 翻译保护人工稿件 | 已完成且已验证 | repair03-translation-test.mjs：当前 ASS/SRT、角色样式、期间编辑冲突 |
| 4 | 全片重校对保护文本 | 已完成且已验证 | repair04-realign-test.mjs：k/颜色、过期文本/版本、重复台词、词数冲突 |
| 5 | 原子项目加载 | 已完成且已验证 | repair05-project-load-test.mjs：加载失败、快速切换、离场、旧保存及波形 |
| 6 | 最新元数据字段更新 | 已完成且已验证 | repair06-meta-test.mjs：慢上传期间任务/改名更新、字幕字段保留 |
| 7 | 常驻 ASR 生命周期 | 已完成且已验证 | repair07-asr-lifecycle-test.mjs：就绪前/识别中退出、共享取消、迟到结果 |
| 8 | 空闲回收 | 已完成且已验证 | repair08-asr-idle-test.mjs：可控时钟、并发/就绪/替换 worker、计时器清理 |
| 9 | 有界项目包导入 | 已完成且已验证 | repair09-pack-import-test.mjs：声明及实际限额、路径/链接、包装、失败清理 |
| 10 | 异步请求异常 | 已完成且已验证 | repair10-request-errors-test.mjs：同步/异步/写失败、超限、断连、重复响应 |
| 11 | Origin 校验 | 已完成且已验证 | repair11-origin-test.mjs：当前端口别名、跨源、无 Origin、native token、Host |
| 12 | 事务构建安装 | 已完成且已验证 | repair12-build-install-test.mjs：零写入、构建失败、回滚、保护目录、打包与实际 batch 入口（隔离微型构建） |
| 13 | 翻译上下文 | 已完成且已验证 | repair13-translation-context-test.mjs：首次逐批刷新、完整稿件、缓存续翻、人工译文、零上下文及拆批 |
| 14 | 静态资源白名单 | 已完成且已验证 | repair14-static-allowlist-test.mjs：实际 HTTP 资源图、双端模块/字体/wasm、敏感/编码/junction 拒绝、测试模式、媒体 Range/HEAD |
| 15 | 项目打包目录 | 已完成且已验证 | repair15-project-pack-test.mjs：不同 cwd/同名文件、中文及引号路径、真实 tar 首选与 PowerShell 回退、失败清理、HTTP 导入往返 |

## 恢复入口

先读本文件、AGENTS.md、PROJECT_MAP §6–§8，再按任务读取相关代码；上次 15 项需求与验收见 REPAIR_15.md / REPAIR_15_RESULTS.md。
Node v24.21.0；源码仓库自带 Git（`dev/` 下的 `main`），工作区与安装目录不初始化 Git。保留已有代码/测试修改及连续性文档。
安全回归入口：`node tools/repair15-regression.mjs`；可附测试文件名只复核变化项。普通沙箱拒绝旧测试写生成模块/镜像，已使用获批的测试执行权限复核通过。
后端必须保持单文件 SEA 入口；前端原生 ESM，无新增 npm 依赖。
测试入口 `node tests/run-all.mjs` 会生成夹具并同步 tests/jsmod，执行前审计副作用。
GPU、模型、网络及真实用户数据验收不得冒充已验证。

## 上一任务验证与限制

- 安全 JS 回归：[repair15-regression-results.json](repair15-regression-results.json)，66 文件完整通过 + 20 文件含明确跳过子项，0 失败；另排除 4 个真实数据/设置/GUI 测试。15 个 repair 测试均完整通过。
- 旧 log-panel 2 条过时的保存源码形状断言改为隔离 HTTP 行为并通过；私有素材测试用隔离开关，生成模块仅在 tests 或临时目录。
- Python 5 个纯逻辑/隔离测试通过（65/12/58/47/24），frame-units 最终隔离静态检查 11 项通过；禁写 bytecode。
- 静态：Node 291 文件语法、Python 33 文件内存 compile 通过；离线 ESLint 相关范围 0 错误/15 警告。扩大扫描有既有未入基线的 tools/verify_home_only_running.mjs:97 语法错误（文件头已有说明），保留该用户文件并单独记录。
- tests/jsmod 与对应生产源码逐字节一致；tray.ps1 的 UTF-8 BOM 保留。
- 第 12 项是隔离微型构建与模拟 Inno，第 15 项真实 Windows tar/PowerShell 在临时项目验证。未运行真实 GPU/NPU/ASR/LLM、浏览器 wasm 渲染/托盘 GUI、完整 SEA/Inno 构建或实际安装。
- 原 HTTP 探针的旧保存调用尚需适配 revision；本轮未在真实服务执行，相关 API 行为用新增隔离测试覆盖。
- 当前接线检查点：源码及安装候选 571 控件/37 资源、配置回退/隐私通过；首页、项目加载、ASS 预设、并发保存、资源白名单与时间轴文字/强调色/适应全片回归通过。新增 studio-navigation 使用真实 adapter+initProjects，覆盖直开编辑器、资源/设置返回保留建稿材料、资源保存、无 ASS 项目禁用、延迟上传期间 6 种导航互斥，精确核对原 File/字幕/标题只提交一次；3 项反向探针能检出旧问题。安装候选隔离浏览器验证 ASS 字号 72→71 保存刷新与预设导出、Material You/深色/流光刷新保留、自定义 #4867A1 取色器；60行/120句真实编辑、波形与libass正常，无 error/warn，1280×720无横向溢出。未测试真实 ASR/LLM。
- 实装完成：12 个 UI 相关文件（含首次创建默认 ui-config.json），原 EXE 正常启动 2.4.0/8321，libass 依赖正常、12 项目/0活动任务。备份/候选/清单在工作区 update-backups/ui-wiring-20261013-Q8KCxT；旧 HTML/CSS/main、EXE、设置及项目核心文件哈希保留。首次校验漏记根示例配置触发自动回滚，逐文件核对原哈希/新增文件清理通过；修正后实装与再次核对成功。只合并本次增量，先前 15 项源码修复未整体安装。
- 最终验收：`verify-studio-live.mjs <manifest> --toggle-config` 核对真实服务的 37 个 HTTP 资源与磁盘一致、默认新 UI、legacy→new 切换并恢复原配置、配置 403、安装及保护数据哈希通过；浏览器真实 ASS 设置入口/no-project inert 与 error/warn 为空。隔离媒体实际运行时 wave=true、暂停 wave=false，主题 #4867A1/深色/流光刷新保留。最后路由/首页/接线回归与相关语法通过，前端镜像同步。截图、具体功能映射与使用见 UI_INTEGRATION；当前安装新界面已打开，验收窗口大小已恢复。无接线待办；真实 GPU/在线 ASR/LLM 未运行，不能视为实测通过。
- 收尾时服务已恢复使用：22:29 后一个项目的元数据和字幕发生后续变化；安装事务及此前两次真实资源/数据验收均已通过，未覆盖该变化。verify-studio-live 现在将恢复运行后的项目/设置差异单列报告，资源/EXE/config 仍严格核对。三个接线临时服务已停止，不影响真实 8321；独立原型服务保留。

- 2026-10-15 设置页材质范围调整：页面背景、主导航、顶部栏与外层 st-box 保持无遮罩；右侧子页面的 .st-card、.set-group、.st-section、ASR 系列卡片恢复与其他页面一致的深色黑色毛玻璃，继续使用可配置的压暗、模糊度与透明度参数。开发版与安装版 CSS 已同步并通过 8321 设置页深色模式实机核验。

