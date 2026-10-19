# SubFabric 项目地图（PROJECT_MAP.md）

> **⚠️ 本文件是项目结构与开发约定入口，也是必须随代码更新的活文档。**
> 任何改动只要动了 **目录结构 / 模块职责 / 数据流 / 接口 / 约定**，
> **必须在同一个提交里同步更新本文件**（"改代码 → 改地图"是一件事，不是两件事）。
> 若发现本文件与代码不一致：**以代码为准**，顺手把本文件改对。
> 新任务或恢复上下文先读唯一权威状态 [docs/STATUS.md](docs/STATUS.md) 与 [AGENTS.md](AGENTS.md)，
> 再按需读本地图；阶段进度只维护在 STATUS，连续性要求与验收见 [docs/CONTINUITY.md](docs/CONTINUITY.md)。
> 最后更新：2026-10-19（UWP 磁贴主题实装；统一隔离 JS 测试入口及本轮维护整理；新增 §1.1「版本号命名规则」并发布 `beta 1.0` 安装包；此前独立 UI 原型与单独字幕工作台入口，
> 15 项修复验收见 `docs/REPAIR_15_RESULTS.md`，当前状态见 STATUS）。历史演进见 §11。

---

## 0. 十秒了解

SubFabric 是一个**本地动态字幕编辑器**：给视频做「中文整句 + 英文逐词」的 ASS 字幕，
播放时高亮颜色跟着当前单词走。核心流程 = 导入 / 识别出初稿 → 逐词对齐校对 → 导出带逐词高亮的 ASS。

- **完全本地**：服务只听 `127.0.0.1:8321`；除「必剪/剪映云端识别」与「LLM 翻译」外不联网。
- **技术栈**：Node 22（后端 `editor/server.js`，无框架、零 npm 依赖）+ 原生 ES Module 前端（**无构建步骤**）+ Python（ASR 与下载内核）。
- **发行形态**：Node SEA 打成单文件 `SubFabric.exe` + Inno Setup 安装包。
- **开发方式**：项目由 AI 开发维护，作者不看代码 —— 注释写"为什么"并带实测数据，是给下一个 AI 的交接材料。
- 设计参考 [Subforges](https://www.subforges.com/)（在线协作编辑器），但**无关联、无依赖**；本项目取舍是"单机、不卡顿、逐词高亮为核心"。
- **2026-10-10 起并入 R2FtYml0 的 fork 功能**（PR #1）：分段导入（多人协作）/ 区域字幕导入 / 项目压缩包导出导入 / 逐词字幕自愈 / 全片逐词重校对 / 备注弹幕 / 句级置信度 / NPU 识别 / 本地 NLLB 翻译 / 热词挖掘 / 长稿反思纠错 等。

**读法建议**：先 §1–§2 建立全貌；动手改哪块读哪块；**动手前务必读 §6、§7**。

---

## 1. 运行 / 打包 / 发版

| 目的 | 命令 |
| --- | --- |
| 准备渲染依赖（libass，首次） | `node editor/scripts/fetch-vendor.js` |
| 启动服务 | `node editor/server.js`（支持 `PORT=xxxx`；`--no-tray` 或 `SUBFABRIC_TRAY=0` 可关托盘） |
| 打开界面 | <http://127.0.0.1:8321/>（`/` 会 302 到 `/editor/studio.html`） |
| 打包 exe | `python build_exe.py` → `build/SubFabric.exe`（SEA，入口 `editor/scripts/sea-launcher.cjs`） |
| 只构建 / 构建并打安装包 | 安装目录的 `build_and_install.cmd --no-install [--package]` → `dev/tools/build-install.mjs`；只构建不更新运行副本 |
| 打安装包 | `"D:\Program Files\Inno Setup 7\ISCC.exe" build/installer/SubFabric.iss` |
| 完整发版流程 | **见 `editor/README.md`「发版流程」节** |

- 版本号唯一来源是 `editor/server.js` 的 `APP_VERSION`；**发版时还要同步** `build/installer/SubFabric.iss` 与 `editor/README.md`。
  **版本怎么编号、下一版怎么推（看上一个已发布版本再迭代）→ 见 §1.1「版本号命名规则」（发版前必读）。**
- SEA 启动器把端口写死 8321（服务端本身认 `PORT` 环境变量，测试探针靠它跑隔离实例）。
- 纯前端修复可在明确安装授权后仅更新对应外置资源，无需重建 SEA；先比对安装基线并保留文件范围外改动，备份、暂存替换，再核对当前服务返回资源。2026-10-13 首页修复仅更新当前 2.4.0 的 project.js 首页段与 studio.css，未整体安装其他待同步源码；实际安装与验证记录见 STATUS。
- 构建入口支持 `SUBFABRIC_DEV/INST/PY/ISCC` 路径覆盖。先语法检查、构建、EXE 校验及可选打包，成功后才进入安装锁、暂存、备份与回滚；EXE 最后替换。模型/设置/项目/runtime/vendor 不进入源码安装清单。打包用临时树，可只读借用安装目录 vendor。真实 SEA/Inno 验收仍需单独执行。
- **本轮（beta 1.0）已实际构建安装包**：`fetch-vendor.js` → `build_exe.py` → `ISCC` 全链路跑通，产物
  `build/installer/SubFabric-beta 1.0-setup.exe`（34.3MB，解包 94 文件 / 104.2MB）。**未执行真实静默安装自检**
  （见下方「/DIR 会被 UsePreviousAppDir 顶掉」：那一步会原地覆盖用户已装的 2.4.0），因此"装完能不能跑"仍属未验证。
- **beta 1.3 构建（2026-10-18）**：`build_exe.py` → `build/SubFabric.exe`（93,613,568 字节，FileVersion/ProductVersion
  `1.3.0.0`，SEA sentinel 与 blob 均在，子系统 2=GUI）；`ISCC` → `build/installer/SubFabric-beta 1.3-setup.exe`
  （37,565,546 字节；取色器重做后于 21:17 重建）。构建时刚写出的 90MB exe 会被杀毒/索引短暂占用，rcedit 报
  `Fatal error: Unable to commit changes`；`build_exe.py` 已对这一步做短重试（0.4–2.0s，最多 5 次），
  真失败仍退出。安装包/Release 未做真实安装与发布。
- **beta 1.4 构建（2026-10-19，与远程合并后重建）**：远程已推进版本，本次沿用 `beta 1.4` / `1.4.0.0`。
  `python build_exe.py` → `build/SubFabric.exe`（93,613,568 字节，FileVersion/ProductVersion `1.4.0.0`，
  SEA sentinel 与 blob 均在，子系统 2=GUI；rcedit 重试第 2 次成功）；`ISCC` →
  `build/installer/SubFabric-beta 1.4-setup.exe`（37,567,810 字节）。远程侧新增视频导出
  （`editor/hardsub.js` + `editor/ffmpeg-tool.js` + `editor/js/export-video.js`，前端 `main.js` 里
  `initExportVideoButton()` 接线，服务端新增 4 条 `/export-video*` 路由与静态白名单条目）与 `docs/PROJECT.md`
  （合并后的唯一技术文档）。
- **踩过的坑（2026-10-14）**：`SubFabric.iss` 的 `VersionInfoProductVersion` 曾写成 `{#MyAppVersion}`（= 显示版本
  `beta 1.0`）。该字段**只接受纯数字**，ISCC 直接 `Value ... is invalid` 编译中止；因为上一轮把版本改成 `beta 1.0`
  后从未真正编过安装包，这个错一直没暴露。**凡是 `VersionInfo*` 字段一律用 `MyAppFileVersion`**，显示版本只走
  `AppVersion` / `AppVerName` / `VersionInfoProductName`。

### 1.1 版本号命名规则（发版前必读）

**三段各司其职，"改一处 = 三处同改"**（`editor/server.js` / `build/installer/SubFabric.iss` / `editor/README.md` 标题）：

| 用途 | 字段 | 格式 |
| --- | --- | --- |
| 产品显示版本（给人看：界面、安装向导、Release 名） | `editor/server.js` 的 `APP_VERSION`、`.iss` 的 `MyAppVersion` | beta 期 `beta <主>.<次>`；转正后 `<主>.<次>` |
| Windows 文件版本（PE 资源，**只能四段纯数字**） | `APP_FILE_VERSION` / `MyAppFileVersion` | `<主>.<次>.<补丁>.0`；beta 期补丁段固定 0 |
| Git tag / GitHub Release tag | Release 的 tag | beta 期 `v<主>.<次>.0-beta.<序号>`；转正 `v<主>.<次>.0` |

**`beta <主>.<次>` 的读法是"`<主>.<次>` 的 beta"** —— 显示版本的 `<主>.<次>` 与 tag 的 `<主>.<次>` 是同一个数，不是两套编号。

**本文件不写"下一版是多少"。** 发版时自己去取上一个已发布版本，再按下面规则推。

推进规则：

0. **先取当前版本**：查远端最新 tag（`git ls-remote --tags origin`，或 Releases 页
   <https://github.com/EndiVee233/SubFabric/releases>），用它核对三处字段是否已经对得上
   （对不上说明上次发版没改全，先补齐再谈下一版）。
1. **同一版本再裁剪**（只对上一版做修补重发）：显示版本与文件版本**不变**，只把 tag 的 beta 序号 +1
   （`v<主>.<次>.0-beta.<n>` → `<n+1>`）。
2. **开新 beta 版本（默认推进）**：次位 +1 —— 显示 `beta <主>.<次+1>`、文件 `<主>.<次+1>.0.0`、
   tag `v<主>.<次+1>.0-beta.1`。
3. **转正**：功能定型后显示版本去掉 `beta ` 前缀，tag 去掉 `-beta.<序号>`，Release 取消 prerelease 勾选。
4. **稳定版之后**：修复/小改抬补丁位；新增模块抬次位；架构级改动须用户确认才动主位
   （历史：`2.3.0` 是"并入 R2FtYml0 fork 全部功能"经确认才跳的次位）。
5. **撞号检查**：推出的号必须与远端 tag 列表比对一次，确认不与已发布号冲突；
   **不要**用"远端补丁位 +1"的老口径（2.4.0 之前的做法），beta 线按上面第 1~2 条走。

---

## 2. 目录地图

| 路径 | 职责 |
| --- | --- |
| `editor/server.js` | **后端全部**（约 9450 行单文件：安全守卫、薄分发器 + 7 段路由、项目系统、下载/prepare/ASR/翻译流水线、HEIC 背景转换、托盘、退出） |
| `editor/studio.html`、`editor/css/` | 单页界面（`<script type="module" src="js/main.js">`） |
| `editor/assets/app-logo.png`、`editor/scripts/tray.ico` | 安装包同源的高分辨率应用 Logo；Studio 品牌、编辑器工具栏与 Windows 托盘共用 |
| `editor/js/` | 前端模块（见 §4） |
| `editor/*.js`（顶层） | 后端辅助模块（CJS）：`cast` `llm-text` `reseg` `k-line` `fonts` `secret-store` `asr-chunks` `audio-slice` `bcut-asr` `capcut-asr`；fork 并入：`align` `asr-service` `ass-group` `danmaku` `hotwords` `mt-local` `project-pack` `reflect` `region` `region-merge` `repair-words` `speech-gap` |
| `asr/` | Python 侧：`asr.py`（本地识别）`vibevoice.py`（VibeVoice NF4·CUDA 4bit，拒绝 CPU/NPU/offload）`diarize.py`（说话人分离）`multitalker.py`（NeMo 多说话人）`fetch/`（下载内核）`settings.json`（本机设置，含密文，不入库） |
| `asr/fetch/` | bilibili / YouTube 下载内核（yt-dlp 自举、格式选择、Cookie、分P），细节见 `asr/fetch/README.md` |
| `tests/` | Node / Python 测试（见 §8）；`tests/jsmod/` 是**前端模块自动同步镜像** |
| `tools/` | 探针 / 诊断脚本；`build-install.mjs` 是事务构建入口，`repair15-regression.mjs` 兼容转发至统一 JS 回归入口 |
| `build/`、`build_exe.py` | 打包（`build/installer/` 内图标与 `.iss` 入库，其余产物不入库） |
| `main.py` | **历史遗留**的 Python GUI 工具（字体/颜色等默认值处理），与编辑器主线关系弱 |
| `docs/` | `docs/STATUS.md` 是唯一权威当前状态，`docs/CONTINUITY.md` 保存连续性要求与验收；另含归档/设计文档（**不在根目录堆着**）：`docs/KARAOKE_DESIGN.md`、`docs/KARAOKE_REFS.md`（逐词高亮与 `\k` 的格式设计与调研，**改字幕格式前必读**）；`docs/CODE_REVIEW.md`（第一轮审查记录）；`docs/双引擎实测结论.md`（NPU+GPU 双引擎实测：本机无收益） |
| `eslint.config.js` | ESLint 9 开发期静态检查配置；它不是运行时依赖，CI 用临时 npx 执行 |

---

## 3. 后端地图（`editor/server.js`）

### 3.1 单文件约束（先看这条）

SEA 打包入口 `editor/scripts/sea-launcher.cjs` 用 `Module._compile` 从磁盘加载 `server.js`，
**相对 require 在 SEA 里不可用 → `server.js` 必须保持单文件**。
因此"拆分"指的是**函数体内重排**（模块作用域 + 路由段函数），**不要把它拆成多个文件**。

### 3.2 结构（自上而下）

1. **头部基础设施**：`CHILDREN` 子进程登记（**包装过的 `spawn`**，20+ 调用点自动入册，退出时统一杀）、日志环形缓冲 + SSE 广播、`secret-store` 接入。
2. **安全基线**：Host 回环校验、实际监听端口的 HTTP Origin 明确集合；有 Origin 的读写请求均检查，无 Origin 的写入须带 `X-SubFabric-Token`。托盘 token 经环境传递，工具使用当前 Origin。静态服务走 `STATIC_RESOURCES/staticResource/publicResource`，只公开浏览器实际依赖和 `samples/` 顶层媒体/字幕，拒绝编码穿越及文件/祖先链接；`/__test/` 仅 `SUBFABRIC_TEST_MODE=1` 启用。项目字幕、媒体、字体仍通过各自 API。
3. **简单路由表 `SIMPLE_ROUTE_MAP`**：`/` `/index.html` `/api/samples` `/api/version` `/api/fonts` `/api/font-file` `/favicon.ico|svg`；处理器签名 `(req,res,u) → boolean`。
4. **主体（模块作用域）**：项目系统（`projDir/readMeta/writeMeta/metaView/readBody…`）＋ 下载/prepare/ASR/翻译流水线 ＋ 状态容器。
5. **路由分发**：`SIMPLE_ROUTE_MAP`（同步无副作用端点）查表 → `API_SECTIONS` 前缀表分发到 7 个路由段函数 → 静态回落（`serveFile`）。
   段函数签名统一 `(req, res, u)`，段内保持原书写顺序的 if 链，段末 404 JSON 兜底（同码同义，见 §10）。
   2026-10-09 首拆（f8be06a）→ PR #1 合并时被整体回退 → **2026-10-10 在合并后的树上重做**（纯逐字搬移；
   行为等价由行多重集 + AST 路由字面量对照 + `route_smoke`/`http_layer_probe` 新旧对照证明）。
6. 七个段：`handleWaveRoutes`(waveform/peaks/upload-video/image) · `handleFetchRoutes`(pick/fetch) · `handleAsrRoutes`(asr/analyze) ·
   `handleLlmRoutes`(translate/cast/mt) · `handleLogsRoutes`(logs/lifecycle/quit) · `handleDiagRoutes`(diag/media) ·
   `handleProjectsRoutes`(projects：含热词候选/压缩包/`if (pm)` 项目内操作)。`API_SECTIONS` 正则前缀互不相交（`\b` 防误匹配）。
7. **退出**：`shutdown()`（`/api/quit` 或 SIGINT/SIGTERM 触发）：广播 lifecycle → await 常驻 ASR `stopAll(1500)` 有界退出 → 杀剩余 `CHILDREN` → `close` + `closeAllConnections` → 超时强退；托盘由保留 UTF-8 BOM 的 `scripts/tray.ps1`（PowerShell WinForms）实现。请求入口 `invokeRequest/requestError` 同时接住同步错误与 Promise 拒绝；readBody 回调使用同一入口。

### 3.3 跨请求状态容器（**铁律：必须放模块作用域**）

`prepareJobs` `draftJobs` `pendingAsr` `draftProcs` `draftAborts` `rerecogJobs` `projProcs` `MEDIA_ALLOW`
`mediaMetaCache` `logBuf` `logClients` `lifeClients` `dlState`（模型下载进度）`CHILDREN`
`realignJobs` `subtitleCommits` `deletedProjects`；常驻 `asrSvc` 的 spawn 注入统一进程登记。

> `projProcs`（项目 id → 进程集合）登记"项目目录里的长任务"（下载的 python、prepare 的 ffmpeg、
> 说话人分离 / 选区重识别）—— **删除项目前必须杀掉它们**（否则 Windows 上 unlink 撞 EBUSY）。
> 新增会读写 `projects/<id>/` 的子进程时，spawn 后记得 `trackProjProc(id, proc)`。

> 教训：这些**不能**放进路由段函数体 —— 段函数每个请求执行一次，放进去等于每请求重置
> （历史上 `fetchJobs` 就这样，已删；`mediaMetaCache` 也踩过一次，已归位）。

### 3.4 初稿流水线（数据流）

```
创建（本地视频 / 链接）
→ [下载] startFetchJob → runFetchCli → asr/fetch/fetch_cli.py（10 分钟无输出看门狗）
→ [prepare] startPrepare：ffprobe → ffmpeg 抽 audio.wav + peaks.bin（min/max 包络）
→ [ASR] startDraftAsr：whisper.cpp / Parakeet（sherpa-onnx·CUDA / OpenVINO·NPU / CrispASR·Vulkan 三条） / VibeVoice（Transformers·NF4·CUDA） / 必剪 / 剪映 / NeMo；长音频先静音分片，VibeVoice 保留整段声学上下文
→ [语义分句] reseg（LLM 补标点；所有引擎必经，没配 LLM 就停在这一步）
→ [说话人分离] diarize（可选） → [写字幕]（逐词 ASS 或 SRT）
→ [翻译] translate（LLM，可暂停后"重试"续跑）
```

- 进度写 `meta.draft`（`status: running / paused / error / done`），前端轮询 `GET /api/projects/:id/draft`。
- 防重入：`draftJobs.has(id)`；流水线步骤统一走 `safeDraftStep`（**同步异常与 async reject 都收**，漏收会让状态永远停在 running）。
- 选区重识别是独立后台任务 `rerecogJobs`，前端每秒轮询；**卡死自愈**：20 分钟无进展即判失败（否则按钮被"已有一个任务在运行"永久挡死）。
- **删除项目**：先停该项目全部任务（`killDraftProc` + `killProjProcs`，Windows 上用 `taskkill /T /F` 连孙进程一起收）→ 再逐文件删；删除带重试（杀进程与系统释放文件句柄之间有窗口）；`project.json` **最后删**（失败时项目不消失、可再删一次，不会留"元数据没了但目录还在"的僵尸）。
- 下载/重识别/准备等任务全部有超时或看门狗；新增后台任务时照此办理。
- 常驻 ASR 按 owner 项目取消：结束该项目等待 Promise 并拒绝迟到写回，共享 worker 的其他项目继续。删除项目墓碑拦截元数据重建。只有 active/pending/ready waiters 全为空才调度空闲回收，新请求取消计时，触发时再检查 worker 身份与活动状态。

### 3.5 项目内操作（`/api/projects/:id/<action>`）

`info`(PUT 改名) `retry`(POST 初稿重试) `skip`(POST 跳过语义分句) `rerecognize`(GET 轮询 / POST 发起)
`translate`(POST) `draft`(GET) `subtitle`(GET / PUT 裸流写盘 / POST) `relink`(POST)
`prepare`(POST，支持 force/denoise 参数) `peaks`(GET) `audio`(GET)；`DELETE` 项目 = 无 action 的 DELETE。

---

## 4. 前端地图（`editor/js/`）

### 独立设计原型（与真实 editor 隔离）

`prototypes/subfabric-ui/` 为无构建、无依赖的模拟前端，使用经典脚本以兼容直接打开 HTML。
`studio.html` 是稿件库/任务/设置/帮助与字幕工作台的唯一生产入口；根路径与 `/index.html` 仅作为兼容重定向。
打开稿件通过相对 URL 转到独立工作台，返回项目回到 index；两页共用浏览器原型命名空间，
不与真实 `projects/`、设置、模型或 8321 服务共享数据。`?sandbox=1` 使用验收命名空间。

| 文件 | 职责 |
| --- | --- |
| `app.js` | 原型状态、hash 路由、上下文筛选/空状态、新建校验、可暂停/取消/重试队列、资源、设置草稿离场保护、导入校验、模态、独立工作台顶栏；openWordDemo 创建或复用独立逐词稿件，切换稿件遵循手动保存保护 |
| `editor.js` / `editor.css` / `workspace.css` | 模拟双语编辑、逐词播放高亮/边界、波形覆盖字幕/重叠分轨、时间轴四项设置、历史、角色单击分配与右键菜单、样式、审核建议、备注与字幕导出；独立页保持左预览/下时间轴/右四 Tab，字幕卡左时间/右角色·常驻样式·双语（Quiet Card：角色色左条、时间/置信度低对比、动作渐进披露）。播放中的卡片使用统一高亮与自动跟随提示；低频刷新、异常分类、反思纠错、全片逐词重校对、分段导入放入编辑器设置，高频筛选/搜索/显示模式/跟随播放留在顶部。 |
| `data.js` / `icons.js` | SF_DEMO 通用合成数据、SF_WORD_DEMO 的非等分词时间/重叠角色示例和内联 SVG，无远程资产 |
| `styles.css` | 纸白/石墨/苔绿 token、三种背景、主题、材质、交互反馈、减少动效 |
| `studio-themes.js` / `studio.css` / `editor/themes/*.theme.json` | 声明式内置主题包与自定义主题包导入校验、本地色调角色、受限颜色令牌和本地预览图；主题包不执行脚本、不注入 CSS、不访问远程资源 |
| `progress.js` | 两页共享的任务/播放进度 markup、数值/状态同步、单个可见性观察器与后台/减少动效门控；波形 CSS 固定图案位移，无额外帧循环 |
| `serve.cjs` | 127.0.0.1:8347 静态白名单；CSP connect-src none；不提供 API |
| `review/` | 合成夹具、隔离行为检查与可视验收记录，不由静态服务提供 |

编辑器经 `window.SF_APP` 访问原型接口，入口为 `SF_EDITOR.render/mount/unmount`。
顶栏命令经 `SF_EDITOR.command` 传递。详细流程和数据边界见原型 README；当前验收状态见 STATUS。

`prototypes/adaptive-selection/`（2026-10-18）是无构建、无依赖的「环境自适应选择框」原型：单文件覆盖设置页与右侧字幕栏的可选表面。`.agx::before` 复制整页壁纸并按元素位置设置 `--bgpos` 采样，遮罩成描边环后 `blur/saturate/brightness`；按局部背景 S/V 逐元素计算 `kSat/kBri/kSpec`（高 S 只提亮/轻去饱和），页面内附单轴映射曲线与实时读数；`::after` 提供顶部白高光。仅用于设计评审，不接入生产 editor。

`prototypes/uwp-tiles/`（2026-10-19）是 UWP 工作台磁贴与 Win10 Reveal 光效的独立原型：4×3 网格（继续编辑 2×2、新建 2×1，其余统计/入口 1×1），缝 11px；三层光为 2%T/50% 悬停描边、共享 0.72T 边缘光、12%/0.65T 跟随指针面光；指针在缝隙里也会点亮四格边并形成十字；点击按落点做 3D 边角下陷与 420ms 回弹（对角保持、落点角下沉）；点击磁贴进入全屏二级界面（list/new/settings/resume）：主页面板不缩放、原地淡出，磁贴以屏幕中心为透视原点整体 scale 2.1 按网格比例铺开飞出画幅（行优先左→右、上→下 16ms 阶梯，被点置顶），300ms 后详情 0.96→1 淡入；返回详情向前放大到 1.18 淡出，主页 .94→1 放大淡入后再按视觉行自下而上 0/50/100ms 纯 opacity 渐显（同排同步）。无构建、无依赖，`?demo=hover|gap|resume` 与 `window.__uwpTileDemo` 供评审。2026-10-19 生产 Windows 10 主题（内部 `uwp`）已实装该 4×3 磁贴、Reveal、3D 按压与页面转场；原型保留为设计评审与验收参考。

生产 Windows 10 主题（内部 `uwp`，2026-10-19 第三轮）把同一套设计接入 `#sf-widgets`：4×3、继续编辑 2×2 / 新建 2×1 / 其余 1×1，共 8 块（新增稿件库）；统计磁贴为英文 kicker + 42px Segoe UI 数字 + 13px 中文 label + 说明；所有 `button`/`.btn` 挂 `.uwp-tile`，共用面光/描边/3D 按压；点击磁贴按屏幕中心 scale 2.1 飞出、目标页 `.96→1`、返回当前页 1.18 淡出与主页 `.94→1` + 逐排。稿件库有网格/列表两套 UWP 结构：网格卡保留 Reveal 与 badges 行，列表为 34px 封面 + 标题/元信息 + 动作；空态/骨架/页签/分段/导航/详情/日志/取色器/字体选择器/时间轴 canvas 均进 UWP 分支。实现集中在 `editor/js/studio.js`、`editor/js/timeline.js` 与 `editor/css/studio.css` 末端 UWP 磁贴/控件/收口层；`tests/uwp-theme-test.mjs` 钉住 P/R/S 选择器、token 与 timeline 分支。

2026-10-19 用户 5 张截图反馈后的收口：术语表 `.gl-tabs` 改 2px 直角分段（surface-2 底、active accent-soft + 2px 底线），`.gl-add` 1px 虚线/2px，表头 1px 分隔；热词模型行 `label.st-lbl` 横排不换行；主题包选中改 surface + accent 边框 + 3px 左条，不再整卡 accent-soft 遮罩；编辑器 `#tab-settings` 动态卡圆角 2px；Material You 开关打开态滑块 `translateX(18px)`（mini 16px），右侧空档 2px。验证断言已加进 `tests/uwp-theme-test.mjs`，截图在 `_tmp/uwp-feedback/`（不入库）。

`prototypes/uwp-page-motion/`（2026-10-19）是页面入场动效演示：UWP/MY 两套 token；页面整体 `opacity 0→1 + scale(.92→1)` 从后往前淡入，元素按可视几何 **下→上、右→左** 依次 `scale(.94→1)+淡入`，默认 180ms / 24ms 阶梯（主页基线 240ms / 50ms），支持快/标准/慢三档、重播、主题切换与 reduced-motion。单文件、无依赖；与生产 UWP 页面共用同一套 keyframes 逻辑。

`prototypes/uwp-controls/`（2026-10-19）是“剩下的非磁贴控件”的补充空壳：输入/搜索/密码/数字/文本域/下拉/文件、复选/单选/开关/分段、滑块/seek/时间轴缩略、项目卡/列表行/折叠/页签、进度/Badge/Tooltip/Toast/加载、Flyout/Dialog/Drawer/颜色，以及导航、滚动条和焦点。单文件、无依赖，7 节导航 + 深浅色/减少动效，全部可点。2026-10-19 第三轮已按本清单接入生产 UWP 层（输入/选择/范围/集合/反馈/浮层/时间轴 canvas），生产与空壳的保留边界见该目录 `README.md` §5；截图 `preview*.png`。

编辑器 `prototypeEditor[id].timeline` 保存 double/height/pan/zoom，缺省为单行/188px/80px/1.05×；旧备份可缺此字段，新字段导入校验类型与范围。生产时间轴载入项目时默认显示 30 秒（短视频按实际时长钳制），用户仍可主动适应全片。重叠字幕按时间贪心分轨，波形背后的局部轻微模糊在拖动期间关闭；滚轮方向沿用旧版，Ctrl+滚轮保持指针下时间锚点。词边界调整共用邻词起止、可撤销；移动/缩放句时同步词时间，英文改写使旧词时间失效。逐词模式选择新句时自动聚焦时间轴，按词高亮只随原有播放时钟更新。
主设置以 `draftSettings` 即时预览，保存条显示变更状态；离场统一保存/放弃/取消。
主题包列表以 `draftThemePacks` 一同预览/保存/回滚；旧备份缺少主题字段时使用 Studio。包导入不执行任意代码，主题色角色在本地计算。
任务进度经 `SF_PROGRESS` 同步，运行完成段为波浪、剩余为直线，暂停/结束为直线。页面重建/编辑器卸载释放被观察节点；CSS 仅对可见且运行的 Material 条动画。编辑器的原有 80ms 模拟播放时钟只在前台播放时存在。
新建向导只记录所选文件名并创建合成字幕，完整 JSON 工作区恢复由设置中的备份导入负责。

装配：`editor/studio.html` → `<script type="module" src="js/main.js">`；hash 路由（`#/home`、`#/project/<id>`，见 `project.js` 的 `applyHash`）。
另有第二个入口 `<script type="module" src="js/video-hover-tip.js">`（进度条悬浮时间提示，独立自初始化，不参与 main.js 的装配）。

| 模块 | 职责 |
| --- | --- |
| `main.js` | 应用主入口：装配各模块、视频/播放控制、波形加载、导出、设置面板、诊断上报 |
| `project.js` | 项目列表/创建/详情（活动稿件置顶、复用卡片独立同步顺序、仅运行中进度动画）、打开项目（含**竞态代次守卫**）、按项目保存/恢复视频播放进度、模型下载轮询（含并发闸门） |
| `editor.js` | 右侧编辑面板：**虚拟滚动**卡片列表 + 行内编辑（5000 行量级性能靠它） |
| `timeline.js` | 时间轴 canvas：波形 + 字幕块 + 词级边界拖拽 / 缩放 / 平移（鼠标交互自实现）；字幕块背景用 `mutedHex()` 把角色色混入中性灰以降低饱和度，边框/文字仍保留角色色；右键菜单脱离画布裁剪层并按画布矩形换算命中坐标，保证各主题与 DPI 下可用 |
| `videoedit.js` | 视频区就地编辑框（双击字幕 → 点哪个片段改哪个；Enter 存 / Esc 取消）；命中框使用真实视频矩形、SRT 字符 Range、ASS libass 墨迹和字幕样式字体/字号/粗斜体/缩放/字距计算 |
| `segment.js` | 就地编辑的**纯函数**：可见文本分段 + 最小替换（见 §6） |
| `karaoke.js` | 逐词高亮核心：词切片↔整句合并、词级时间映射、编辑后按词时长重算 |
| `postprocess.js` | 字幕后处理特效（Glow / Grow / Fade）——纯文本变换，**铁律见 §6** |
| `ass.js` | ASS 文档模型：保留原文行，事件级编辑后整体序列化 |
| `srt.js` | SRT 解析 / 序列化 / 双语合并 |
| `overlay.js` | SRT 双语叠加渲染层（按视频 `getBoundingClientRect()` 与父舞台真实偏移贴合 HTML） |
| `assplayer.js` | ASS 渲染器封装（SubtitlesOctopus / libass-wasm，含字体索引缓存） |
| `video-hover-tip.js` | **进度条悬浮时间提示**：悬在**原生** `<video controls>` 的进度条上时，在画面上方显示该位置的时间。实测依据与几何口径写在文件头（控制条区域的事件目标就是 `<video>`，所以一个 mousemove 监听即可，不必自建控制条；横向按"去黑边"的画面矩形换算）。**唯一一个自初始化的模块**（不 import main.js，main.js 也无 export），由 studio.html 里第二个 `<script type="module">` 加载 |
| `util.js` | 时间格式化 / 转义 / 二分查找 / `popOrigin` 等工具 |
| `i18n.js` | 文案词典（`lang/zh-CN.json`：键=原文，值可改；缺失回退原文） |
| `modal.js` | 可拖动二级窗口（对齐 / 视口边界） |
| `shortcuts.js` | 固定键盘快捷键表（刻意不可配置） |
| `accent.js` | 主题强调色（经典脚本，`<head>` 内同步执行防首屏闪色） |
| `icons.js` | 内联 SVG 图标集（不要塞进文本节点中间，会拆散 i18n 词典匹配） |
| `align.js` | 逐词时间重对齐（TTS 合成 → 重识别 → 序列对齐；fork） |
| `asr-service.js` / `mt-local.js` | 常驻识别服务；本地 NLLB 翻译（fork） |
| `ass-group.js` / `region.js` / `region-merge.js` | 分段导入（多人协作·按句聚合）/ 区域字幕导入 / 合并（fork） |
| `project-pack.js` | 项目压缩包导出/导入（字幕+置信度+操作日志，不含视频/音频本体；fork） |
| `repair-words.js` | 逐词字幕自愈（导入/载入时修复被写坏的逐词文本；fork） |
| `danmaku.js` / `hotwords.js` / `reflect.js` / `speech-gap.js` | 备注弹幕 / 热词挖掘 / 长稿反思纠错 / 波形漏字幕检测（fork） |

---

## 5. 数据与本地文件

`projects/<id>/`（**不入库**）：

| 文件 | 内容 |
| --- | --- |
| `project.json` | 项目元数据（meta） |
| `subtitle.ass` / `subtitle.srt` | 字幕权威内容 |
| `audio.wav` | 16k 单声道（供 ASR 与播放音轨） |
| `peaks.bin` | 波形包络缓存（min/max 分桶） |
| `asr.json` | 识别结果（词级时间戳） |
| `translation.json` | 译文缓存，含 sourceKey；仅同一原文/时间/角色/样式/特效来源版本复用，当前稿件已有译文优先 |
| `reseg.json` | 语义分句缓存 |
| `asr-chunks.json` | 分片数据（用户要的"返回分片数据"） |
| `source.json` | 下载来源元数据（标题/UP/时长等） |
| `draft.log` | 初稿流水线日志 |
| `llm-debug.jsonl` | LLM 调用调试（排查翻译问题） |
| `video/` | 下载产物 |

全局 / 本机（**全部不入库**，见 `.gitignore`）：`asr/settings.json`（含**密文**敏感值）、`asr/models/`、
`asr/whisper.cpp/`（whisper 运行时）、`asr/crispasr/`（CrispASR 运行时，Parakeet Vulkan 通用版用）、`asr/ytdlp/`、`asr/runtime-python/`（内置 Python）、`editor/vendor/`（libass，约 19MB）。

**敏感数据**（bilibili Cookie / LLM API Key）统一走 `editor/secret-store.js`：Windows DPAPI 密文落盘
（不可用时降级 AES，解密值仅存内存）。**新敏感字段必须走它**：不进命令行参数、不进日志、不回传前端；
临时明文文件必须**用完即删**。

---

## 6. 核心机制备忘（改相关代码前先读）

- **逐词高亮**：不用 `\k`。中文整句一条事件；英文按词切多条事件，当前词用行内色标
  `{\c&H..&}word{\c}` 标记。配对与时间映射全在 `karaoke.js`；格式设计见 `docs/KARAOKE_DESIGN.md`。
- **`\k` 是另一条线**（`editor/k-line.js`）：初稿生成用 `\k` 行文本（每词亮到下一词起点）。
  生成端与编辑器端"同一格式、两个场景"，改动要两边对齐。
- **就地编辑（`segment.js`）只做最小替换**：把被点中的那一段换成新文本，
  **行内其它内联标签一字不动** —— 整行重建会丢行内变色，画面立刻变色。
- **postprocess 铁律**（文件头注释有完整实测记录）：① 只在已有事件文本里内联标签，
  **绝不新增事件**（libass 按 Layer 分组避让，新增事件会叠压）；② **绝不动 `\bord`**
  （包围盒变化带动整行位移）；③ 其余约束先读文件头注释再动手。
- **弹层动效规范**：弹出层统一 `pop-in`（`--pop-ox/oy` 用 `util.popOrigin` 指向触发点；Modal 例外居中）；
  可点元素要有 `:active` 反馈；时长 120~150ms、ease-out、不从 `scale(0)` 出发；`prefers-reduced-motion` 全局关闭；不用 `transition: all`。
- **批量选区浮条必须挂在 `#app` 外**：`#timeline-panel` 在主题末端带 `backdrop-filter`，会建立 fixed 定位包含块。
  `#range-bar` 若留在 `#tl-canvas-wrap` 里，`refreshRangeBar()` 按视口算出的 left/top 会被面板自身偏移再叠加一次，
  浮条实际落到视口外（实测 y=1421 / 视口 900，用户反馈“Ctrl+左键拖动没选项”）。当前 HTML 把它放在 `#app` 之后；
  改时间轴布局时不要把它塞回 `#tl-canvas-wrap` / `#timeline-panel`。
- **自动保存**：GET 字幕的 ETag 为 SHA-256 版本，PUT/beacon POST 同传 revision 与窗口 client/seq。请求各有 UUID 临时文件，比较版本和 rename 在同一同步段；过期或跨窗口冲突回 409，无版本回 428。同窗口后续保存可衔接上一提交。成功回完整提交内容的新版本；失败只清理本请求临时文件。
- **项目切换**：先 flush 旧稿保存，再完成元数据/字幕/解析，最后同时提交 ID 和文档。所有保存回调、视频/波形/备注/prepare 等异步结果捕获项目与代次；首页/detach 同样使旧加载失效。保存冲突保持不可自动覆盖状态。**无撤销/重做栈**，Esc=取消是安全边界。
- **元数据**：`updateMeta(id, mutate)` 同步读取最新内容、字段更新、唯一临时文件原子替换；`readMeta/writeMeta` 的兼容调用以 WeakMap 基线算递归字段差量，并入最新状态，禁止旧对象整体覆盖已有项目。跨 await 新增更新优先调用 updateMeta。
- **首页列表**：`isCreating` 统一活动置顶与轮询判据，包含下载、提取、初稿及新建空窗，失败/暂停无字幕稿不冒充活动。`cardSig` 不含 progress/message/modifiedAt，三者就地更新；顺序同步独立于结构重建，只移动错位节点。首次直接显示进度，只有 running 的目标值变化才播放数字与 width 的 420ms 线性过渡；WeakMap 使旧动画失效，移除节点停止写入。studio.css 的流光和宽度过渡只属于 running，完成/暂停/失败无填充动画。
- **主页 Tab（2026-10-18，UWP 2026-10-19 扩到 8 块）**：`#/dashboard` 独立主页（`#dashboard-view.workspace-page`）由 `refreshLibrary` 按 `projectPhase` 渲染 7 个通用小组件 + UWP 第 8 块稿件库（继续编辑 / 处理中 / 可编辑 / 需处理 / 全部 / 新建 / 设置 / 稿件库）；计数卡切 `filter` 并跳 `#/home`，动作卡复用 `#btn-new-project` 与设置路由。UWP 主题层把 `.sf-widget` 转成 2px 直角磁贴（统计卡带英文 kicker、42px 数字、13px 标题、说明）；非 UWP 保持卡片。`#/home` 是稿件库，不再有 hero/小组件；无 hash 默认 `#/dashboard`。
- **Material You 主页（2026-10-18）**：依据 GitHub `f0f1bb9391a0` 的旧版稿件库 hero 重做；`#dashboard-view` 内 `#sf-mu-home` 只在 `data-theme-pack="material-you"` 时显示；`syncDashboardMode` 按主题切换 `#sf-mu-home` 与通用 `#sf-widgets`（`data-home-mode=material/widgets`）。Material You 主页按历史稿件库截图使用三段式 `.sf-hero`：左侧 `.sf-flower` 118px SVG 花瓣时钟（上一版单一路径花瓣随秒针同角度旋转；胶囊形时分针两档浅蓝 + 小圆点秒针；文案“点击开始新的创作”；悬浮 1.04 不旋转）、中间 `.sf-resume` 当前正在编辑卡（当前 `prefs.recent`，标题/副标题/按钮已放大）、右侧 `.sf-orbit` 100×148 的 40° 倾斜可编辑统计胶囊（桌面左移 30px；≤1200px 84×124/left 4，≤560px 80×116/left 0，避免遮挡 resume）；下方 6 个 MY 小组件（处理中/可编辑/需处理/全部 + 新建/设置），其中处理卡占两列：最新稿件标题 + 全宽进度条（完成 100%）+ 时长/识别设备两枚胶囊；resume 卡 650×180（左边缘偏移 21px，宽度 `calc(100% - 21px)` 防右列溢出）；搜索与筛选保留在 `#/home` 稿件库，避免 New Tab 控件混入旧版构图。Material You 专属 CSS 仍保留深浅色令牌与 900px/560px 响应式布局；非 Material 主题保持 7 个小组件，UWP 磁贴不变。
- **UWP 邻近光效（2026-10-19）**：`.proj-card` 使用 `--uwp-glow/--uwp-edge`；`studio.js` 的 pointermove 以 46px 距离衰减点亮边框，卡片内另把 8px 内相邻卡片边框抬到 .34；滚动/失焦/换主题清零。工作台磁贴改用 `--uwp-face/--uwp-edge` 的面光/描边，见下条。
- **UWP 磁贴主题（2026-10-19）**：`#sf-widgets` 8 块 4×3（继续编辑 2×2、新建 2×1、其余 1×1，第 8 块稿件库）；`.uwp-tile` 给所有 `button`/`.btn` 加 Reveal（面光深色 12%/浅色 6%、2%+50% 描边、无外发光）与 105/420ms 3D 按压；点击磁贴按屏幕中心 scale 2.1、行优先 16ms 阶梯、165ms 淡出，300ms 后执行真实路由；目标页 `.96→1` 240ms；返回当前页 1.18/180ms、主页 `.94→1` 260ms + 底/中/顶 0/50/100ms 逐排。实现：`studio.js` 的 `renderWidgets`/`syncUwpTiles`/`uwpTileExit`/`uwpPressTile` 与 `studio.css` 末端 UWP 磁贴层；`tests/uwp-theme-test.mjs` 固定布局与按压/转场标记。
- **UWP 控件补充实装（2026-10-19）**：`studio.css` 末端在磁贴层后追加输入/复选/单选/开关/滑块/卡片/字幕卡/浮层/进度/徽标/滚动条。输入 focus 用 1px border + 1px inset ring 的四边 2px 等宽（禁止只加粗底边），`#sf-search`、`#note-input`、`#role-rename-input`、`.st-input`/`.st-area`/`.np-*` 都覆盖；`.switch-slider` 40×20（mini 32×16）；range 4px/12×24 + `--uwp-range` accent 填充；项目卡去外发光改 Reveal；Flyout/Dialog/Drawer/Notice 120/150/220/180ms。空壳 `prototypes/uwp-controls/` 同步移除底线焦点；`tests/uwp-theme-test.mjs` 固定这些选择器与时长。
- **UWP 页面入场（2026-10-19）**：`animateUwpPage` 统一处理 dashboard/home/settings/new/details/help；页面加 `.is-uwp-page-entering` 走 `uwp-page-back-in`（.92→1 / `--uwp-enter-duration:180ms`），元素按 `getBoundingClientRect` 排序（bottom 降序、同行 right 降序）写 `--uwp-enter-delay` 并加 `data-uwp-enter`，由 `uwp-enter-item`（.94→1 / 180ms / 24ms 阶梯）执行。设置面板切换用 `sf-settings-panel-shown`，面板加 `.is-uwp-items-entering` 走 `uwp-panel-in`，设置候选包含 `.st-card/.st-scheme/.sf-asr-family/.sm-model/.st-hw/.st-subhead/.sf-scheme-empty` 且始终补标题；性能页回退 `.sf-settings-heading + .st-section`。旧的 `uwp-page-in .24s`、260ms 主页 `uwp-home-in` 和重复离场规则已移除；面板类动画结束后清理，返回主页的 `uwp-page-out` 统一 180ms。
- **设置页三个“无动画”面板（2026-10-19）**：语音识别可见 `.sf-asr-family`、翻译可见 `.st-scheme`、性能只有 `.st-section`，均没有可见 `.st-card`；旧白名单导致 UWP 下没有面板/元素入场。修法见上；同时修 `closeDrawer` 被 `schemeSaving` 挡住导致删除方案残留、双引擎分工未 ready 也显示/不回填、性能无音频/轮询失败/打开目录无反馈。
- **相邻短句锚点修复（2026-10-19）**：`analyzeKaraoke.findAnchor` 不再只按“跨度最小”选中文锚点，改为优先比较起止误差、再比跨度；修复 `哦.`/`Ooh.` 行吞掉下一句英文首片 `I` 的错配。`.tl-edge-hint` 改用主题 `--surface/--line/--text`，UWP 2px/11px/低阴影。
- **逐词高亮对角线检测（2026-10-19）**：ASS 逐词行在数量齐时由 `wordHighlightIssue(sent)` 校验：每个高亮切片只亮一个词，高亮词下标必须为 `0…W-1`；无高亮 gap 事件忽略，`\k` 行跳过；高亮块允许叠 `\3c/\3a/\blur` 标签。异常写入 `逐词高亮不连续/数量异常/重复`，归入 `words` 类别（“逐词异常”），与既有缺词检测并列。
- **编辑器角色高亮/行内输入/新建切页（2026-10-19）**：`EditorPanel._activeRoleName()` 从当前 `playingItem` 的 `speaker/l1` 解析角色，`setPlayingByTime`/`setItems` 同步 `.role-card.is-speaking`，UWP 用主题色描边；行内 `.ie-line` 去掉 focus 底部 1px inset 线，UWP 改为 2px 直角 + 1px line/surface，focus 四边 accent；`showTab('subs', { instant, skipSync })` 用 `.is-instant-reveal` 跳掉 260ms 面板入场，`createRowAt` 用它立即显示新行输入框。
- **UWP 编辑器入场（2026-10-19）**：`#app` 在从非编辑器路由进入时执行 `uwp-editor-in`（scale .97→1 / 180ms）；`EditorPanel._render` 派发 `sf-cue-rendered`，`studio.js` 的 `animateUwpCueList` 给 `#cue-list` 加 `is-uwp-cue-entering`，可见 `.cue-card` 按 DOM 顺序 `uwp-cue-in`（120ms，14ms 阶梯），结束后清理；虚拟列表快速下拉时只对 `sf-cue-rendered.detail.added` 的新下标重播，不重播重叠窗口/轮询。
- **UWP 自定义主题色（2026-10-19）**：UWP 默认仍用 `pack.seed` 的 Windows 10 蓝；`prefs.accent` 一旦偏离默认就作为有效强调色，`#sf-color`/色板/`SSAccent.set` 均启用。UWP token 的 `--accent-soft` 从 `themes.palette(accent)` 派生，`.btn-accent:hover/active` 用 `color-mix` 从 accent 变暗，不再硬编码固定蓝。颜色控件 `.sscp-control` 外壳全主题透明（UWP `!important`），色块与色号各自保留表面，不再共用灰色遮罩。
- **UWP 主页/稿件卡细节（2026-10-19）**：UWP 下 `#dashboard-view .dashboard-foot` 隐藏，避免与底部稿件库磁贴重复；`.pc-st` 用 `align-items:center`，状态圆点 `flex:0 0 5px; align-self:center`；封面播放三角定位 `left:28.5px; bottom:27px`，在 38×38 方框内居中。
- **背景切换渐变（2026-10-19）**：纯色/流光/自定义图片 mode 变更走 `applyBackgroundWithFade()`，根节点 `data-bg-transition="fade"` + `startViewTransition`，旧/新画面 `sf-bg-fade-out/in` 交叉淡变 .38s；图片选择/清除同样走此路径，UWP 与 Material You 共用。
- **Windows 10 明暗切换（2026-10-19）**：UWP 下 `applyModeWithReveal` 用 `startViewTransition` + `html[data-mode-transition="uwp-fade"]`，旧主题淡出、新主题淡入 `.34s`，无 Material 圆形揭示；结束后清理属性，Material 分支不变。
- **Material You 编辑器/字幕卡入场（2026-10-19）**：打开编辑器 `#app` 执行 `my-editor-in`（opacity + `translateY(10px→0)`，260ms）；`animateMaterialCueList` 给 `#cue-list` 加 `is-my-cue-entering`，新卡 `data-my-cue` 执行 `my-cue-in`（从上方 `perspective(900px) translate3d(0,-64px,60px) scale(1.07)` 连续向下飞入，68% 略越过目标到 `translateZ(-1px)/scale(.994)`，再连续回弹到 `scale(1)`，没有中间停顿；420ms；从上到下逐条 55ms 进场）；`sf-cue-rendered.detail.added` 只提供候选，按视口过滤后才播放；`#cue-list` 滚动时补播新进入视口的卡，`materialCueSeen` 去重，旧卡/overscan 卡不重播。
- **Material You 页面卡片入场（2026-10-19）**：`animateMaterialPage` 用于 `#home-view .proj-card`、`#sf-folders .sf-folder`、设置面板的卡片/系列/方案/标题、`#sf-help` 的文章和快捷键 `dl > div`；按可视几何 **top→bottom、同行 left→right** 写 `--my-enter-delay`（45ms 阶梯），复用 `sf-home-card-in` 的 420ms 上浮。首屏由 `applyTheme` rAF、`refreshLibrary` 卡片渲染后补播、`renderFolders` 和设置 Tab 事件触发；`data-motion=off`/reduced-motion 关闭。
- **主题包选择（2026-10-19）**：内置主题改为 3 个（Windows 10 默认，内部 `uwp` / Material You / SubFabric Classic），Studio 从选择器与 `editor/themes/` 移除，`design:"studio"` 仅保留给旧自定义包；旧 `themePack:"studio"` 经 `themes.get` 回退 UWP。主题卡按主页磁贴处理：2px 直角、surface 底、选中只有 1px accent 边框，无 3px 蓝竖条/整卡 accent-soft。自定义主题包图标统一为 Windows 10 斜向四格窗户（`customGlyph`，`fill=currentColor`）；Windows 10 内置主题卡使用实心斜向四格开始菜单徽标。
- **自定义背景图（2026-10-19）**：输入上限从 2MB 改为 64MB 安全上限；`prepareBackgroundImage()` 解码后压到长边 2560 的 WebP（不支持时 JPEG），避免 localStorage 撑爆；HEIC/HEIF 先走浏览器 `createImageBitmap`/`<img>`，失败时 `POST /api/image/convert` 由 ffprobe 选 default/最后一路流 + ffmpeg 输出 JPEG data URL。新增 `imageBlur`（0–40px）/`imageDim`（0–80%）偏好、两个滑杆；`.sf-backdrop` 用 `filter:blur(var(--sf-image-blur)) brightness(calc(1 - var(--sf-image-dim)))`。
- **文件夹 Dialog（2026-10-19）**：`sf-folder-add` 与移除文件夹不再调 `prompt()/confirm()`，改为模块内动态 `.sf-folder-dialog`；支持名称校验/重名检查、Esc/遮罩/取消、Enter 提交、触发点还焦。UWP 2px 直角 + 150ms，Material You 28px 圆角 + 52px 输入 + 胶囊按钮；`setFolderDialogButtons` 给 UWP 按钮补 `.uwp-tile`。
- **UWP 第三轮完整实装（2026-10-19）**：在控件层后新增 P/Q/R/S 段处理旧 audit pass 的高特异性级联（4px/投影/背景简写），并补：设置分类短竖条 8px、设置卡 2px、主题包/背景/方案/ASR/识别模型卡 accent-soft + 3px 左条、`#panel-tabs` 选中 surface + 2px 底线、活动页/日志子页签/分段 2px 底线、项目卡 badges 行与列表行模式、`#sf-widgets` 统计 label、`.st-scheme-inline` 220ms 内联展开、帮助页 `.sf-page` 转场、`#toast`/`#sf-notice` 右下次级表面与 180/160ms、`#sf-seek` 4px 轨道 + 12×24 滑块（显示层 `pointer-events:none`，命中仍由 28px 透明 range 负责）、`--surface-3`、`data-indeterminate`、`data-motion=off` 的 JS 动效门控、取色器色板 `aria-pressed`、字体面板视口夹取、`#log-view/#oplog-view/#note-view` 2px。`timeline.js` 增加 `this.uwp` 分支：2px 播放头无光晕、1px 选中框、hover 1px 外框、块圆角 2px；`timeline.js`/`studio-progress.js`/`project.js`/`color-picker.js`/`font-picker.js` 同步进 `tests/jsmod/` 镜像。边界：Tooltip 只有原生 title（生产无 `data-tip` 控件）、方案抽屉是内联结构（无 `.st-drawer` DOM）、取色器保留完整双栏、新建页文件行仅常驻虚线视觉（真实 drop 仍在视频区）。
- **稿件库入场（2026-10-19）**：`#home-view.is-entering .home-list > .proj-card` 复用 `sf-home-card-in`，nth-child 45ms 错峰；`animateLibraryCards` 在库页可见/返回时重播。UWP 用 `.sf-studio[data-design=uwp]` 的 `--sf-card-duration:.24s` 与 `--sf-card-delay-scale:.55` 加速主页和稿件库动画。
- **主页入场（2026-10-19）**：`#dashboard-view.is-entering` 下，`.sf-mu` hero/widgets 与非 MY `.sf-widget` 使用 `sf-home-card-in`（opacity + translate 12px，0.42s）并按 DOM 顺序错峰；`animateDashboardCards` 在页面可见/返回/主题切换时重播，MutationObserver 监听 `hidden`。
- **筛选空状态（2026-10-18）**：`#sf-filter-empty` 改为纵向 flex（标题在上、清除筛选按钮在下，gap 16px，居中），对所有主题包生效；`#sf-filter-empty[hidden]` 保持隐藏。
- **取色器交互（2026-10-18）**：`SSColorPicker.open(input, point)` 支持鼠标落点定位；角色菜单「修改颜色」传递菜单项坐标；标题栏可拖动（pointer capture + 视口夹取），打开/拖动位置均在 `placePopup` 统一处理。
- **取色器（2026-10-18）**：`color-picker.js` 改为 Windows 经典双栏：左 250px 基础色/自定义色板，右 HSV + Hex/RGB/HSV 字段；`studio.css` 末段用主题变量和 Material 28px 玻璃表面覆盖旧暗色样式。`.sscp` 纳入 `RIM_SELECTOR`，自适应 rim 环 z-index 100001，边框由采样色场生成。
- **背景工具显隐（2026-10-18）**：`#sf-image-tools` 默认 `hidden`，`applyTheme` 按 `prefs.background === 'image'` 切换；`选择图片/清除图片`只在自定义图片模式出现，aurora 模式仍只显示流光选项。
- **MY 明暗转场（2026-10-18）**：Material You 的明暗按钮通过 View Transitions API 做圆形 reveal；从按钮中心设置 `--sf-mode-x/y/r`，`::view-transition-new(root)` 用 `clip-path: circle()` 从 0 扩到全屏。非 Material、减少动效、motion=off 或无 API 时退回即时切换。
- **设置页侧栏（2026-10-18）**：设置专用的透明覆盖不再作用于 `.sf-nav`；左栏和其他页面一样使用全局玻璃表面（`color-mix(surface 88%,transparent)` + blur + shadow）。顶部栏/内容仍按设置页透明处理。
- **设置页背景（2026-10-18）**：设置工作区本身透明；旧规则在 `[data-workspace=settings]` 下强制隐藏 `.sf-ambient/.sf-backdrop`，导致「模糊流光 / 自定义图片」只在设置页不生效。已移除该隐藏，让背景层在设置页可见；卡片仍使用毛玻璃表面。
- **页面切换（2026-10-18）**：`setPageVisible` 离场立即 `hidden`（不再保留 200ms 淡出），避免透明首页/稿件库浮层背后的旧页残影；只保留新页入场动画。`#dashboard-view` 已纳入 `is-leaving`/z-index 兼容规则。
- **任务中心移除（2026-10-18）**：侧栏不再有 `#/tasks`；旧书签在 `applyHash` 里重定向 `#/home`，`matchesProject` 的 tasks 分支保留给历史测试/旧语义。顶栏 `#sf-direct-editor`、`#sf-create` 删除，页面内入口保留。
- **项目封面与视图**：`server.js` 在项目列表/详情读取时为没有在线来源缩略图的本地视频异步抽取 `cover.jpg`，通过受保护的 `/api/projects/:id/cover` 提供；Studio 的稿件库卡片视图使用 `prefs.view`，卡片视图不再被任务路由强制改成列表。
- **翻译**：`subtitleSource` 从当前 ASS/SRT 取原文、对应译文和版本；只在没有稿件时回落 ASR。`patchSubtitleTranslations` 仅更新译文事件/行，保留人工原文、时间、角色、样式和特效；每批及落盘前检查当前稿件版本。`planJobs` 用完整稿件索引和 todo，每批由 `translationRefs` 从同版本已有/新译文刷新前文；拆批右半批接续左半批，参考行不计输出数量，contextRows=0 不带参考。LLM 默认只输出逐行纯文本，`llm-text.parseLineArrayReply` 按输入行数解析；旧 JSON 数组仍兼容，解析失败继续拆批/重试，不把 JSON 原文落盘。
- **语义分句**：`reseg.js` 默认要求模型复述原词并直接在词尾补标点，`parsePunctTextReply` 校验词序/词数后映射为标点对并保留逐词时间；旧 JSON 标点对仍兼容解析。模型不能保持原词时拒绝该批并按既有拆批/停顿兜底，避免改写造成时间轴错位。
- **全片重校对**：从当前稿件提取目标，共用 karaoke 的 `realignTargetKey/applyRealignItems`；结果需匹配项目、规范化稿件版本、句子事件位置、可见文本及完整词序列。只改词级时间，颜色切片与 `\\k` 都保留当前文本，不按相近时间强行套旧结果。
- **模型删除**：只物理删除标准根下该模型的精确普通目录、普通所属文件；根目录、兄弟前缀、自定义/共享目录和祖先链接只解除关联并回 deleted:false。目录中的非所属文件保留。
- **项目包**：导出 tar 显式 `-C` 目标目录并传 cwd，只打包 CORE_FILES 普通文件，失败回退 PowerShell，成功响应及失败均清临时目录。导入先预检 ZIP 目录（128 文件、单文件 64MB、总量 128MB），拒绝越界/链接/重复/不支持格式，只流式提取核心文件，并检查实际字节、CRC 与 30 秒时限；读取前 stat，字幕有效才建成项目，失败清理本次目录。支持单层包装；ZIP64/加密/分卷明确拒绝。
- **长音频分片**：静音优先切点（`audio-slice.js` 真 ffmpeg `silencedetect`；纯函数在 `asr-chunks.js`）。
- **全局设置页的骨架是 CSS grid，别在外面再套 wrapper**（2026-10-12 实测踩过）：
  `studio.css` 的 `#st-view .st-box` 是 `grid-template-columns: 192px minmax(0,1fr)` +
  三行（head / body / actions），`.st-tabs`（竖排分类栏）、`.st-body`（右栏内容）、
  `.st-actions` 必须是它的**直接子元素**。旧 UI 按 grid-area 定位；Studio 动作栏绝对定位到
  `.settings-inner` 标题右侧，`#st-view` 为唯一页滚动区，`.st-body` 不单独滚动。多包一层 `<div>` 会让 grid
  拿不到它们 → **右栏被压成 0 宽**（rect.w = 0），整页看着空白。改版式前先读这条。
- **Studio 设置页的层级（2026-10-14）**：六个一级分类（外观与体验 / 语音识别 / 翻译与术语 / 识别与校对 / 下载与登录 / 性能与调度）。时间轴/显示/角色/文件/导出、自愈与 ASS 完整控件固定在编辑器 #tab-settings；全局不再显示“编辑与工作台”。语音识别先展示 Whisper / Parakeet / 云端 / 前置大卡片；VibeVoice 作为可进入的 CUDA 4bit 系列卡，缺少运行时只显示显式安装按钮，不绑定 CPU/NPU 回退。Parakeet 内展示三种硬件模型，额外多说话人/双引擎在 details 中保留，展开状态使用 GROUP_OPEN。模型与环境下载/删除操作仍在 #st-panel-models 祖先中；Studio 进入页面只探测，缺失运行时通过显式按钮安装，避免导航触发下载。旧 UI 保留原分组与自动运行时链路。
- **VibeVoice CUDA 4bit（2026-10-14）**：`ASR_MODELS` 的 `vibevoice-asr-4bit` 固定使用 `Dubedo/VibeVoice-ASR-HF-NF4` revision `289d51eeddb2f089f6478da4c0ace7d078a69596`。模型文件清单包含 `quantization_metadata.json`；`asr/vibevoice.py` 只走 Transformers 原生 VibeVoice 模型类、NF4 元数据校验与 `cuda:0` 映射，拒绝 CPU/NPU/disk offload/通用 Seq2Seq 回退。服务端的 `vibevoice` 运行时安装在检测到 NVIDIA GPU 后按 cu126 索引安装 CUDA PyTorch（必要时替换 CPU 版），再安装 Transformers/bitsandbytes；初稿和选区重识别均不回退其它设备；未验证的 OpenVINO/NPU 后端不得接入。
- **识别前置与流光（2026-10-14）**：Studio 前置仅 Python/NeMo/说话人三列小卡，Python自定义路径details的开合由 GROUP_OPEN保存；#st-runtime-env只保留隐藏兼容节点，不重复探测/显示。重新识别select移到#sf-asr-rerecog-mount，主页底部显示，仍在#st-panel-models内使用原change API。所有下载按钮显式触发原后端。studio-state的auroraColors为空时跟随主题，否则必须三项#RRGGBB；auroraMotion为dynamic/static；studio.js同步三个CSS变量和body属性，只有流光+dynamic+页面可见才添加CSS动画，减少动效优先，无新时钟。设置子视图必须自己承接flex gap，父panel gap不能穿过普通wrapper。
- **设置重排使用同一份真实表单**：571旧控件保持稳定，编辑器组不再移动到全局；翻译表单仍是常驻 DOM，分类切换不会重建术语输入。命名方案主页面只显示已保存列表与添加入口，保存/测试位于展开表单内，识别与校对的全局保存只写热词配置，不能误覆盖翻译草稿。背景预览卡/明暗分段按钮同步原select的change。
- **入口生成器**：tools/templates/studio-settings.html 为设置常驻表单模板（包含页面尾部闭合）；tools/generate-studio.mjs 用此模板及编辑器组ID再生新入口，ui-integration 在内存运行生成器检查真实控件完整/唯一及图标注册，禁止生成回旧设置布局。
- **品牌版本与焦点（2026-10-14）**：Studio 启动将唯一 `#app-version` 节点移到 `.sf-brand-title`，版本仍由 main 的原服务响应更新；列表标题不另造版本。设置/导航/日志焦点 outline 向内绘制，避免滚动容器裁切；品牌底部留白使用 margin，不能包进链接焦点框。
- **新建项目翻译方案（2026-10-18）**：`#np-settings-panel` 隐藏原来的服务商/模型/提示词输入，改为 `#np-scheme-list` 读取 `/api/translate/schemes`；卡片选用走 `/api/translate/schemes/:id/activate` 并刷新 `/api/translate/config`，无方案时显示空态和直达设置 translate/llm 新建方案抽屉的入口。旧 `np-set-provider/model/prompt` 仍保留隐藏，兼容 gen/render 与测试。
- **命名翻译方案（2026-10-14）**：`asr/settings.json` 的 `translateSchemes` 存独立名称/厂商/API/模型/参数/术语/提示词及加密 apiKeyEnc；`translateSchemeId` 表示当前方案，选用时原子复制到 `translate`，真实翻译/语义分句/跟随翻译的纠错继续读原配置。默认列表为空，不自动制造方案也不删除旧配置。`GET/POST /api/translate/schemes`、`PUT/DELETE /:id`、`POST /:id/activate` 管理方案；`POST /schemes/test` 仅测试草稿，Key 留空只复用该 id 的密文，不回落其它方案，不保存或切换。加密失败拒绝写入，无明文降级；响应只含 hasKey，不含明文或密文。旧 UI 的 `/api/translate/config` POST 解除命名方案关联，保存列表仍保留。
- **LLM 方案展开区**：Studio 常驻 DOM 插入当前命名方案卡片下方，CSS grid 0fr→1fr 自适应术语表高度，关闭期间 inert；动画回调使用代次避免快速开关串入。旧 UI 保留右侧抽屉。重建列表前先移出表单，避免 innerHTML 删除原控件；`st-provider` / `st-baseurl` / `st-key` / `st-model` / `st-batch` / `st-prompt` / `gl-*` ID 稳定，新增 `st-scheme-name`、选用与自动翻译开关。术语分节先识别 ## 再忽略 # 注释，确保多语言独立恢复。
- **设置页模型列表的两个易碎点**：① 分组折叠状态必须记在模块级 `GROUP_OPEN`（Map）里 ——
  `renderAsrModels()` 整个重建 innerHTML，而下载进度轮询**每秒**重画一次，不记住的话
  用户刚折叠的组下一拍又被展开；② 折叠交互必须**事件委托**绑在 `#st-models` 上，逐个绑会
  在重画后全部失效。
- **动态模板里的 `data-ico` 要自己补注入**：`applyIcons()` 只扫调用时已存在的节点，
  启动时跑过一次就不再管新节点。project.js 渲染完模板后调 `window.__applyIcons(root)`。
  另外图标名**必须存在于 `js/icons.js` 的注册表**：未知名字 `ico()` 返回空串、
  `applyIcons()` 静默跳过，界面上只剩一个空方块（实测踩过 `layers` / `link`）。

---

## 7. 开发约定与红线

### 生产 Studio 入口（2026-10-13）

根入口逐请求读取程序根 `ui-config.json`，无论配置缺失、损坏或历史上写有 `{"ui":"legacy"}`，都进入唯一生产入口 `editor/studio.html`。配置不公开服务。旧界面 HTML/CSS 已删除；旧视觉迁移为 `subfabric-classic` 主题包。Studio 模板保留全部真实控件，继续使用 `main`、`project`、ASS、Timeline 与 API。

Studio 的毛玻璃压暗、模糊度、透明度保存在 `studio-state.js` 的界面偏好中；`studio.js` 同时计算深色与浅色材质令牌，`studio.css` 末端对所有主题包的导航、项目卡、编辑器表面、设置卡、弹层和菜单统一应用。主题包只改变视觉令牌与几何，不能绕开这组材质参数。

`editor/js/studio.js` 只适配页面导航、外观、真实项目快照和播放器事件；`studio-state.js` 校验浏览器外观/文件夹关系（不储存字幕/模型/凭据）。`studio-themes.js` 提供三个内置主题包（Windows 10、Material You、SubFabric Classic；Studio 已从选择器移除，`design: studio` 保留给旧自定义包）及“我的主题包”存储；`editor/themes/*.theme.json` 是可分发的同源 JSON，导入包只能使用白名单设计、颜色令牌和本地 PNG/JPEG/WebP 预览图，不能执行脚本、注入 CSS 或引用远程资源。设置页按内置/自定义分组，内置包不可删除，自定义包可导出、替换和删除；格式与制作说明见 `docs/THEME_PACKS.md`。`studio-progress.js` 提供固定 CSS 波浪。全局模型、翻译与识别设置共用唯一“设置”入口；旧 `#/resources` 仅重定向至 `#/settings`。ASS 控件为同一组 DOM，始终停留在稿件编辑器的 #tab-settings，保留原监听器/文档保存链路；无当前 ASS 项目时由编辑器业务自身禁用文档操作，后处理为本机偏好。创建提交期间 Studio 路由统一互斥，避免上传回调读取被重置的材料。

UWP 设置页只保留交互控件等必要的 surface；设置路由下的 `.st-panel`、`.st-card`/表单行/说明条背景透明，避免灰块与黑底冲突，边框和内边距保留。 编辑器 `#tab-settings` 的分组头不吸顶，标题回到卡片顶部并加分隔线，滚动时不再遮住上一组内容。 词生长 Grow 暂停：`#fx-grow-block` 在模板/入口整段注释，`main.js` 强制关闭旧配置；`postprocess.js` 引擎保留以兼容旧特效标签与测试。 微光 `glow.followRole`：从中文行可见 `[角色]` + 行首角色色，按时间跨度映射英文活动词；同 Name 不同角色各用自己的颜色，找不到回退手动色。载入自愈不再把带 `[角色]` 的绿色行首色标当逐词高亮剥掉，并在同角色其它行有颜色时补回丢失色标。 「逐词字幕自愈」卡必须放在 `#tab-settings .settings-list` 内、`#editor-advanced-actions` 之后，不能直接挂到 `#tab-settings` 外层，否则会变成固定浮窗遮挡设置内容。

`editor/js/rim-curve.js` 是 Material You 专属的环境描边层：从 Material 角色色生成局部色场，按目标位置采样 S/V，计算 kSat/kBri/kSpec 并把 `--sf-rim-field`、`--sf-rim-pos` 等写入 DOM；设置页 `#sf-rim-card` 的 SVG 曲线、实时读数与四个滑杆也由该模块渲染，参数保存在 `studio-state.js` 的界面偏好。仅在 `themePack=material-you` 且 `data-rim=on` 时挂载二级 `.sf-choice-menu` 与曲线卡实时预览 `.sf-rim-sample`；一级主题包/背景/模型/角色/方案卡、下拉触发器、字幕卡不挂。`.sf-choice-menu` 自身保持 `position:fixed`（只给 static 目标加 `.sf-rim-anchor`），环宽 1.25px；Material You 下目标边框归零，由取色环覆盖外缘，避免双层。fixed 弹层的环提升为 body 级 `.sf-rim-floating` fixed overlay，按菜单外框定位，菜单内部滚动时边框不随选项滚动；示例卡仍用子环。时间轴块里中文字幕后的黑色 scrim 已移除；英文逐词灰条保留（8px，含拖动热态），轴线与词文本也保留。

相关验收与安装范围见 `docs/UI_INTEGRATION.md`；`tools/studio-install.mjs --prepare` 产生安装候选和哈希清单，候选验收通过后 `--apply <backup-directory>` 才进入备份/锁/替换/失败回滚。仅合并本次 UI 增量，不整体安装先前源码修复，不改 EXE/运行时/设置/项目。

1. **不要引入构建步骤 / npm 依赖**：前端是浏览器原生 ESM，后端零依赖；Python 依赖在 `asr/requirements.txt`。
2. **不要拆 `server.js` 成多文件**（SEA 约束，见 §3.1）。
3. **跨请求状态必须放模块作用域**（见 §3.3）。
4. 注释写**为什么**（带实测数据、踩坑记录），中文；风格不强制统一。
5. **版本号三处同步**（`server.js` / `.iss` / `editor/README.md`）；发版流程见 `editor/README.md`。
6. **改完跑测试基线**；`tests/jsmod/` 镜像会被测试自动同步 —— **镜像要与源码一起提交**。
7. 造测试媒体：ffmpeg lavfi 的 `testsrc` **必须加 `sine` 音轨**（纯视频流抽音轨会失败）。
8. `.gitignore` 已排除 `projects/`、`asr/settings.json`、`editor/vendor/` 等：**不要把用户数据 / 密钥 / 大文件提交上来**。
9. 新增用户可见文案 → 进 `lang/zh-CN.json` 走 i18n。
10. 新增后台任务 → 必须有**超时/看门狗**与**异常收尾**（见 §3.4 的两条教训）。

---

## 8. 测试地图

| 测试 | 覆盖 | 备注 |
| --- | --- | --- |
| `tests/home-project-list-test.mjs` | 首页活动排序、复用卡片重排、静态进度零改写、连续/过期动画、完成与暂停/失败、新建/提取/下载、改名/删除及轮询停止 | 运行真实 initProjects/路由/轮询，使用内存 DOM 与可控时钟，不连接实际服务 |
| `tests/material-home-test.mjs` | Material You 主页模板/生产镜像、旧版三段式 hero、花瓣时钟、主题门控、动态计数入口与响应式 CSS | 源码静态断言；已配合 Chromium 深色 Material 主页核对真实几何与交互 |
| `tests/repair01-*` ～ `repair15-*` | 15 项修复的实际行为（内存 mocks / 临时目录 / 独立 HTTP 服务） | 第 12 项用微型 Python 构建与模拟 Inno；第 15 项本机真实 tar/PowerShell 已验证；不等于 GPU/ASR/LLM/GUI/SEA 真机验收 |
| `tests/run-all.mjs` | 唯一 JS 全量入口；隔离运行、文件筛选、逐项 JSON 报告 | `node tests/run-all.mjs --report _test/maintenance/js-results.json`；不连接默认服务；报告不合并旧结果 |
| `tools/repair15-regression.mjs` | 旧命令兼容别名 | 转发至 `tests/run-all.mjs`，不再维护第二套发现/汇总逻辑 |
| `docs/MAINTENANCE.md` | 本轮完整维护需求、计划、验收与结果边界 | 本任务的范围和本次证据入口 |
| `tests/karaoke-exhaustive.mjs` | 逐词高亮全链路（28183 断言） | 也负责同步 `tests/jsmod` 镜像；报 `fixture.ass` ENOENT 时先跑 `node tests/gen-fixture.mjs`（夹具是生成物，`*.ass` 不入库） |
| `tests/cue-segment-test.mjs` | 就地编辑分段 / 最小替换 | 17 项 |
| `tests/secret-store-test.mjs` | 密文往返 / 篡改检测 | 17 项 |
| `tests/audio-chunk-test.mjs` | 分片纯函数（静音解析 / 切点 / 合并） | 38 项 |
| `tests/overlay-test.mjs` | SRT 叠加层活动 cue 检索（重叠/嵌套不漏显示，钉死 `_maxEnd` 回归） | 11 项，直接可跑 |
| `tests/colorfix-test.mjs` | 颜色修复 | 依赖用户项目，统一入口明确排除；不要为了测试改写个人稿件 |
| `tests/ass-style-preset-test.mjs` | 双语样式预设的导出/导入纯逻辑（往返保真、跨稿件字段名搬运、坏文件拒绝、单样式稿件不乱改） | 纯函数直测，任何机器可跑；新测试文件会被 `run-all.mjs` 自动发现 |
| `tests/timeline-text-test.mjs` | 时间轴块中文行可读性 / 角色色亮度阈值 | 纯函数抽取直测 |
| `tests/ui-feedback-20261017-test.mjs` | 新增字幕自动切回字幕页 / 批量浮条不能落进 fixed 包含块 / 失败任务卡停转 / 时间轴块去角色名保留颜色 / 切 Tab 同步播放位置 / 查找替换不压暗与间距 | 源码与 DOM 断言；真实鼠标验收另见本轮 CDP 探针 |
| `tests/orbit-capsule-test.mjs` | 首页统计胶囊 40° / 内部文字水平 / 非 Material 主题不旋转 / 分档尺寸与 40° 包围盒 | 源码 CSS 断言 + 几何粗算 |
| 其余 `tests/*-test.mjs` | ass / srt / role / postprocess / reseg / zh-* 等 | 多数独立可跑 |
| `tools/http_layer_probe.mjs` | HTTP 层探针（守卫 / 形状 / 设置往返 / 项目全生命周期） | 自带服务启停，但会写同树设置/项目；只有隔离副本才可执行，旧字幕保存探针尚需适配 revision 协议；本轮以 repair 测试验证 |
| `tools/route_smoke.mjs` | 24 路由冒烟 | 需先起服务：`PORT=8399 node editor/server.js` |
| `tools/chunk_probe.mjs` | 静音检测 / 切片（真 ffmpeg） | |
| `tools/videoedit_probe.mjs` 等 | 视频区就地编辑（CDP 真机） | 需 `editor/vendor/`（先 fetch-vendor） |
| `tools/videoedit_live_check.mjs` | 有头窗口真机验收 | 同上 |
| `tests/fetch-format-test.py` | 下载内核站点 / 档位 / Cookie | 用 Python 3.8+ 跑 |
| fork 并入的测试 | 置信度 / 分段导入 / 区域导入 / 压缩包 / 备注弹幕 / 热词 / 反思纠错 / 自愈 等（`tests/*-test.mjs`） | 多为纯函数直测 |

> ✅ **`tests/jsmod/` 镜像自举（2026-10-10 修复）**：两族自举（上游族源 `editor/js/`、fork 族源 `editor/`）+ `ensureJsmod()`
> 现在**只按内容比对补齐/更新本族文件，绝不清空目录**（旧实现 `rmSync` 清空会顺手删掉另一族的文件，
> 导致"哪个测试先跑"决定别的测试能不能过）。跑完测试镜像恒等于源，**无需再 `git checkout` 恢复**；
> 改过源码后跑一次测试即自动同步镜像，**镜像要与源码一起提交**。
> `reload-pipeline-test.mjs` 需要 fork 作者机器上的私有基线（未入库），缺失时**自动跳过**（正常，非跳过即异常）。
> 统一 JS 入口把服务行为测试改为临时服务和临时配置；真实项目 / Edge GUI / GPU / 模型测试不会自动启动。
> 明确缺数据或设备的测试记为部分执行，业务断言中的“跳过”文字不影响分类。

---

## 9. 常见任务速查

- **加一个 API 端点**：判断它是否"同步、无副作用"：是 → 加进 `SIMPLE_ROUTE_MAP`；
  否 → 归到对应 `handleXxxRoutes` 段内的 if 链（保持段内书写顺序，段末已有 404 兜底）。
- **加一个前端弹层**：`[hidden]` 切 display + `:not([hidden]){animation:pop-in}` + JS 设 `--pop-ox/oy`（用 `popOrigin`）。
- **改 UI 文案**：编辑 `editor/lang/zh-CN.json` 的值即可（键=原文）。
- **改 ASS / 逐词相关**：先读 `docs/KARAOKE_DESIGN.md`、`docs/KARAOKE_REFS.md`、`karaoke.js` 与 `postprocess.js` 头注释。
- **改下载内核**：`asr/fetch/`，先读 `asr/fetch/README.md`；站点判定必须**严格 hostname**（子串判站是历史漏洞）。
- **改敏感字段**：走 `secret-store.js`；涉及 Cookie 的临时明文文件用完即删。
- **排查"卡在运行中"**：找对应任务容器（`draftJobs` / `rerecogJobs` / 下载看门狗）与异常收尾路径；
  `metaView` 用容器判断"真在跑 vs 服务重启残留"。

---

## 10. 看起来像问题、其实是有意为之

- **136 处空 `catch {}`**：多为"可选文件不存在 / 写日志失败继续跑"的兜底；关键路径已注释。
- **37 处同步 IO**：项目文件很小，刻意同步以便"编辑后立即重载"；**大文件（视频/音频）必须走流式异步**（见 `serveFile`）。
- **无撤销 / 重做**：Esc 取消 + 单次提交是设计边界。
- **SRT 优先级低于 ASS**：产品定位（逐词高亮在 ASS）。
- **`secret-store` 不可用时降级 AES**：DPAPI 被策略拦截（如 powershell 不可用）时的有意取舍。
- **`timeline.js` 的 `isPlay` 死变量**：为"播放头高亮"预留，别删；`textOnTranslucent` 目前仅由 `timeline-text-test` 覆盖，保留以免误删历史行为。
- **`detectSilences` 包装里显式传 `undefined`**：透传默认超时，别"顺手清理"。
- **路由段末的 404 JSON**：`/api/*` 前缀命中但 method/路径不匹配时，由段函数回 `{error:'not found'}`（旧单体实现落到静态回落回 text）——
  状态码同为 404，JSON 对 API 调用方更可用；`route_smoke` 里 `/api/diag` GET 的 404 body 是唯一可见差异（有意保留）。

---

## 11. 变更锚点（近期重点，全量用 `git log`）

- **beta 1.0 发版 + 版本号命名规则（2026-10-14）**：首次真正跑通"构建安装包 → 发 Release"全链路。
  - 新增 **§1.1「版本号命名规则」**：显示版本 / Windows 文件版本 / Git tag 三段口径 + 推进规则 + **下一待发版本**
    （`beta 1.1` / `v1.1.0-beta.1`），供后续 LLM 发版直接取值。
  - 修复 `SubFabric.iss` 的 `VersionInfoProductVersion={#MyAppVersion}`（显示版本 `beta 1.0` 不是纯数字 → ISCC 编译中止）；
    同时把该文件里"远端补丁位 +1"的老口径注释改成指向 §1.1。
  - 产物：`build/installer/SubFabric-beta 1.0-setup.exe`（34.3MB）；`build/SubFabric.exe` 文件版本 `1.0.0.0`。
    真实静默安装自检未执行（会原地覆盖用户已装版本），"装完能跑"仍属未验证。
- **全局设置页按设计稿实装（2026-10-12，三阶段）**：三份设计稿（全局设置 / 模型设置 /
  LLM 方案）落到 `#st-view` 的设置页上。**只动前端，后端接口一个没加**。
  - ① 全局设置：左侧分类补齐 5 项（模型设置 / 识别增强 / 性能测试 / 下载与登录 / **外观与主题**）；
    模型设置顶部两个**入口卡**（ASR / LLM，带进度条 + 引擎胶囊，数字由 `renderModelEntries()`
    按 `/api/asr/status` 的真实状态算）；新增**运行时环境卡**（Python / NeMo / 说话人分离，
    `renderRuntimeEnv()`，NeMo 缺失时给一键安装）；**外观与主题**分类里的主题色控件
    与项目内设置侧栏那份**共用一份状态**（`renderThemeSwatches()` 往所有
    `[data-theme-swatches]` 容器画，改一处两处同步）。
  - ② 模型设置：**本机硬件条**（`renderHardwareBar()`，只显示探测到的 N 卡 / Intel NPU /
    Vulkan，判定与模型可用性同源）；模型列表**按系列可折叠分组**（`MODEL_FAMILY()` 按
    `engine` 分：Parakeet / Whisper / NeMo 多说话人 / 云端识别），行渲染抽成
    `modelRowHtml()`。⚠ 折叠状态与事件委托的两个坑见 §6。
  - ③ LLM 翻译方案：**ASR / LLM 二级 Tab**（`.st-subtab` / `.st-subview`）+ 方案列表
    （`renderSchemes()` 按 presets 渲染，标「当前使用」、未配置变暗）+ **卡片内展开设置区**
    （`.st-scheme-inline`；`openDrawer()` / `closeDrawer()` 保留旧接口名以兼容保存链路）。
    **「字幕翻译」不再是独立分类**，其表单（保留全部原 id）插入当前方案卡片下方。
  - **设计稿里那几项"看着像设置"的东西，接线口径**：
    · 「采样温度」→ `cfg.temperature`，进请求体（**原来写死 0.3**），范围 0~2。
    · 「上下文行数」→ `cfg.contextRows`，每批额外送前面 N 行「原文 + 已定译文」作参考；
      纯函数 `planJobs()` / `buildTranslateUserMessage()` 在 `editor/llm-text.js`，
      ⚠ **参考行不参与译文行数校验**（否则 `parseTranslationReply` 的等行数校验会失配），
      且 `contextRows = 0` 时批次划分与旧的 `planChunks` **逐例一致**（有单测钉住，
      见 `tests/llm-params-test.mjs` 的 ③）—— 老用户的翻译行为不能因为这次改动而变。
      服务端在 `saveTranslateCfg()` 入口夹范围，不信任前端。
    · 「中间 API」**有意不实装**：本项目的 LLM 请求由本地服务端发出，没有浏览器的同源策略，
      不存在它要解决的 CORS/403 场景，多一层中转只会多一个失败点。面板里如实写明。
    · 「多套方案各自独立存储」也**未做**：后端仍是"一套 cfg + 一份 presets 表"，
      点方案行 = 切换当前那套（与既有模型一致）。要真支持多套得改 `asr/settings.json` 的结构。
  - 验收：`tools/probe_settings_layout.mjs`（17 项骨架/分类/二级 Tab/主题双实例）、
    `tools/verify_model_groups.mjs`（15 项硬件条/分组/折叠状态不丢）、
    `tools/verify_scheme_drawer.mjs`（**34 项**二级 Tab/方案列表/卡片展开动画/字段齐全/新建/Key 可见性/
    温度与上下文行数的**真实保存往返**与服务端夹取；**跑完会把 provider 切回初始值** ——
    它一开始没切，实测把用户的 deepseek 改成了 openai，属于验收污染，已修 + 有断言钉住）、
    `tools/probe_entry_card.mjs`（图标注入与进度填充）、`tools/probe_settings_content.mjs`（量 rect 定位 0 宽问题）。
  - 单测：`tests/llm-params-test.mjs`（39 项：温度/上下文夹取、`planJobs` 的 refs 选取、
    **`contextRows=0` 时与旧 `planChunks` 逐例一致**、提示词里"待翻译行数"不被参考行带偏、
    服务端与浏览器镜像两侧输出逐字一致）。
- **ASS 双语样式预设：导入 / 导出（2026-10-11）**：稿件编辑页 → 设置 → 「ASS 双语样式」里新增两个按钮，
  把「中英两条 Style 轨 + 逐词高亮色 + 卡拉OK 未唱色/扫过形态」存成一个 `*.style-preset.json`，换稿件一键套用。
  纯逻辑在 `editor/js/ass.js`（`assStylePresetOf` / `parseAssStylePreset` / `applyAssStylePreset` / `findStyleForLang`），
  界面接线在 `main.js`（`exportAssStylePreset` / `importAssStylePreset`）。
  **导出的是 [V4+ Styles] 原始行 + 元数据，不是面板那 14 个控件值** —— 面板没暴露的
  Alignment/MarginV/Outline/Shadow/Spacing 也得跟着走，否则导入会静默改坏观感；导入时**按字段名搬运**，
  两边 Format 声明顺序不同也不错位；样式名永不覆盖。
  单测 `tests/ass-style-preset-test.mjs`（6 组 40+ 断言；**抓到两个真 bug**：① 中文线索正则
  `(^|[-_])zh([-_]|$)` 会命中 "English" 里的 "zh"，导致中英轨对调 —— 必须用单词边界；
  ② 只有一条样式的稿件会让两条轨落到同一个样式上、后一条静默覆盖前一条还报成功；
  另有一条"导入没 k 行的稿件时不写 SubFabricKaraokeBaseColor 注释"，避免给稿件塞用不上的元数据）。
  界面验收 `tools/verify_style_preset.mjs`（17 项：按钮在不在 → 点导出截下 Blob 校验 JSON →
  改乱样式后导入看面板与**服务端已保存的字幕**是否还原 → 坏文件不改动样式 → 无 JS 报错）。
  ⚠ 这个验收会经界面真的改到项目字幕，跑之前先备份 `projects/<id>/subtitle.ass`；修好元数据那条之后**已是幂等**的。
- **进度条悬浮时间提示（2026-10-11）**：新增 `editor/js/video-hover-tip.js`（+ `#video-hover-tip` 元素与 `studio.css` 样式，
  studio.html 里第二个 `<script type="module">`）。悬在**原生** `<video controls>` 的进度条上时，在画面上方显示该位置的时间
  （整段 <1h 用 `m:ss`，否则 `h:mm:ss`；`title` 另给毫秒精度）。原生的控件在 UA shadow DOM 里、Chrome 不带 hover 时间预览也没法插元素，
  所以自己做一个。
  **实测依据**（`tools/probe_video_controls.mjs`，CDP 从视频底边每 6px 派发真事件）：距底 2~74px 的 `elementFromPoint` 就是 `video` 本身，
  即控制条区域的事件目标就是 `<video>` —— 一个 `mousemove` 监听即可，**不必自建控制条**；距底 80px 以上归 `#cue-hit-shield`（字幕接管层）。
  横向换算按"去黑边"的画面矩形（`object-fit: contain` 下非 16:9 素材有黑边，只有这种素材才看得出错），
  纵向判定一条薄带（`HOT_LO`~`HOT_HI`，上限与 videoedit 的 `CTRL_BAR=72` 同口径）。
  验收：`tools/verify_video_hover_tip.mjs`（真视频 24 项：轨道位置↔时间、滑块位置对拍、不越界、不在进度条上不弹、播放中不干扰播放、跳转后收起、无 JS 报错）+
  `tools/verify_tip_letterbox.mjs`（4:3 素材 10 项：黑边下按画面贴边铺、黑边里不显示、提示块对齐）。
  **进度条横向几何是标定出来的、别凭直觉改**：`tools/probe_bar_fit.mjs` 拖动滑块到多个已知像素位置、
  用 (像素, currentTime) 做最小二乘，在四个元素宽（960/855/760/560）上拟合出轨道约占元素宽 **0.96**（按比例、
  不是固定像素）；`tools/probe_bar_geometry.mjs` 是早期的粗测版本。**踩过的坑**：最初按"铺满整宽"实现，
  用户当场发现读数偏大（4.3% 的位置显示成 6.1%）；把轨道改对之后又发现"元素比画面宽时进度条贴画面铺"
  （元素 855×334 / 画面 827 宽那次，拟合边界 14.0 与 841.0 正好是画面边界），于是 `trackRect()` 分两类处理。
  靠两端约 2px 内读数会被钳住，拟合边界有 ±2px 不确定度（45 分钟视频上约 ±6 秒）。
- **第二轮全面审查 + 修复（2026-10-10）**：审查报告在 `docs/CODE_REVIEW_2026-10-10.md`（10 高危/30+ 中危/分阶段计划）。本轮已修全部高危 + 安全资源类中危，共 24 处：
  - **server.js**：① autopost 失败兜底的 `stamp()` 是未定义符号（函数内局部 const）→ 改 `apStamp()`，此前该路径一失败就 ReferenceError 吞日志；② `probeDuration`/`buildPeaks` 补 settle 护栏接线（error+close 双触发曾致 `/api/peaks` 双响应崩溃与 `makeWaveform` 无限递归 spawn）；③ **批量重识别空区间**改为按"跳过"处理（`regionDone+1` + warning），此前每段空转等满 30 分钟；④ `startRerecognize` 的 `cleanup` 提到 try 外，失败/空区间路径也清 %TEMP% 切片（~45MB/次）；⑤ **Cookie 写 Netscape 文件失败改为终止任务**（删除 `--cookies <明文>` 的 argv 兜底 —— 明文进程列表可读，宁报错不泄密）；⑥ probe 用 cookie 改 `mkdtemp` 随机目录 + finally 整目录删除；⑦ `fetchPyPromise` 否定结果不再缓存（装好 Python 后无需重启）；⑧ `realignJobs` 完成/失败 10 分钟老化（照抄 rerecognize 套路，内存不再只增不减）；⑨ `rerecognize` POST 互斥改 `jobStillRunning`（与 reidentify 同口径，卡死任务不再挡按钮）。
  - **前端**：`project.js` 打开项目检查字幕 `r.ok`（**此前 500 的错误页会被当字幕解析并污染 lastSavedText，编辑即把坏内容写回 subtitle.ass**）；`refreshDualRatio` 自取 `/api/asr/status`（原来读不存在的 `state.asrStatus`，双引擎分工行永久隐藏）；`timeline.js` 刻度 `/\.0\$/` → `/\.0$/`；`overlay.js` setCues 预计算前缀 `_maxEnd` 修重叠 cue 漏显示（与 timeline 同款防御）；`main.js` rim 解析统计 `console.log` → `debug`。
  - **asr-service.js**：worker ready 前崩溃立即 reject 全部 `readyWaiters`（原来干等 180s）；`waitReady` 的 waiter 补 reject；识别失败路径也布置空闲回收（worker 不再永驻）。
  - **Python**：`asr_npu.py` 复用 `asr.frame_energies`（refine_word_ends 曾复制旧版全量广播索引，1 小时音频 ~0.9GB —— **合并丢修复的 OOM 回归**）+ `log_mel` 分块；`asr_dual.py` `run_engine` 加 Timer 看门狗（加载 120s + 音频×10，至少 300s）；`asr_perf.py` 子进程 timeout + emit 补 UTF-8 reconfigure/try；`asr.py` 单文件模式 `--out` 缺失校验与热词临时文件清理未做（留在审查报告阶段 2）。
  - **新增 `tests/overlay-test.mjs`**（11 断言，O1 用例钉死重叠漏显示回归）；`tests/fixture.ass` 是**生成物**（`node tests/gen-fixture.mjs`），缺失导致 karaoke-exhaustive 报 ENOENT 时先跑它。
  - 验证：6 文件 `node --check` + 3 文件 `py_compile` + karaoke-exhaustive 28183 断言 + http_layer_probe 23 项（ffmpeg 生命周期用例因探针硬编码 D: 路径在本机跳过，先验问题）+ route_smoke 24 路由 + overlay-test 11 断言，全绿。
- **Parakeet-Vulkan 引擎（CrispASR，2026-10-10）**：新增本地引擎 `crispasr`（ggml；CrispASR v0.8.42 Windows Vulkan 包，
  含 ggml-vulkan.dll；MIT）。模型「Parakeet TDT 0.6B v2（英语·Vulkan 通用）」= `cstr/parakeet-tdt-0.6b-v2-GGUF` q4_k
  （实测 379MB / sha256 287f8a46…）。**不需要 Python、不需要 N 卡**：A 卡/Intel 核显/N 卡通吃，无 Vulkan 时自动
  `--no-gpu` 退 CPU（这是与 whisper.cpp "必须 GPU" 的刻意差异）。识别链镜像 whisper.cpp：`runCrispAsr` 用
  `-ojf` 取 words[].offsets（ms）+ 同款分句规则；运行时下载走抽出来的通用 `startRuntimeDownload`（key=`runtime:crispasr`）。
  本机实测：i5-12400 + RX550/UHD730 双 Vulkan 设备，11.6s 音频 2.7s 跑完（6.6x 实时）；端到端建初稿一次通过。
- **文档整理（2026-10-10）**：根目录只留 `README.md` + `PROJECT_MAP.md`（入口与地图），历史/设计文档归入 `docs/`
  （KARAOKE 设计/调研、第一轮审查记录、双引擎实测结论）；删除已完成文档 `CODE_REVIEW_2026-10-08.md`
  （第二轮审查，内容在 git 历史 `git show 2a6dd23:CODE_REVIEW_2026-10-08.md`；曾被 PR 合并复活，再次删除）与
  `UPSTREAM_MERGE_STATUS.md`（2.1.13 合并状态记录，要点已并入本章与 `editor/README.md` 更新日志）。
- **路由重构恢复 + 测试基建修复（2026-10-10）**：`handleRequest` 拆回"薄分发器 + 7 段函数 + `API_SECTIONS`"
  （f8be06a 的做法在合并树上重做；行多重集 + AST 路由字面量对照 + `http_layer_probe`/`route_smoke` 新旧对照
  证明行为等价 —— 唯一差异：`/api/*` 前缀命中但 method 不匹配的 404 由 text 变 JSON，同码同义）；
  `tests/jsmod` 自举 16 处改为"按需补齐 + 内容比对"、不再清空互删；log-panel 测试改为断言"模块级同域"；
  `postprocess.js` 重删 fork 带回的死代码 `has`；server.js 清掉区域里重复的 `LlmError` 声明（模块作用域已有一份）。
- **perf 死代码清理（2026-10-10）**：`/api/asr/perf/*` 在合并后有**成对重复**路由（第一组先命中，
  第二组 state/apply/start 实际不可达，仅 auto-audio 独立可用）——已删除第二组死副本（与活块逐字相同，
  净删 85 行），保留 auto-audio；7 条请求新旧逐字节一致 + `route_smoke`/`http_layer_probe` 双端一致。
- 安全加固：`safeJoin` 边界、Host/Origin 守卫、`/api/media` 白名单、`secret-store` 密文。
- 大拆分：`handleRequest` 3038 行 → 薄分发器 + 7 段函数（行为逐字等价，行多重集对照证明过）。
- **二次加固（2026-10-09）**：`safeDraftStep` 收 async reject、下载看门狗、重识别卡死自愈、
  `mediaMetaCache` 归位、SIGINT/SIGTERM 收尾、明文 cookie 用完即删、前端竞态守卫与 blob 释放、
  `MemoryError` 可读化、字体表边界校验、`detectSilences` 补 duration。
- **删除项目加固（2026-10-09）**：`projProcs` 登记项目内长任务，删除项目前先杀（`taskkill /T` 连孙进程）
  → 带重试删除 + `project.json` 最后删。修复用户报障"下载中删项目 → 500 失败、目录残留"
  （已用真实下载端到端复现与验证）。
- **并入 PR #1（2026-10-10，提交 af04b08/0446ce2）**：接受 R2FtYml0 的 fork 全部功能，并**恢复被其合并
  丢失的上游内容**——\k 卡拉OK全套（karaoke.js/main.js/project.js/studio.html/server.js）、视频区就地编辑
  接线（main.js/studio.html/css/modal）、2.2.1 全部加固（projProcs/看门狗/自愈/SIGINT/流式字幕保存/前端
  守卫/Python 修复等）。教训：**fork 类大 PR 不能只看"mergeable"，必须逐文件核对"上游内容有没有被合并回退"**。
- UI 动效批；视频区就地编辑；`\k` 初稿线。

---

### 维护提醒（再次强调）

**改代码 → 改本文件。在同一个提交里做完。**
新增一个模块、删一个端点、换一个存储位置、加一条约定 —— 都算"地图要改"。
