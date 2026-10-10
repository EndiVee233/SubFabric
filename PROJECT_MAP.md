# SubFabric 项目地图（PROJECT_MAP.md）

> **⚠️ 本文件是"新接手的 AI / 开发者"的第一读本，也是必须随代码更新的活文档。**
> 任何改动只要动了 **目录结构 / 模块职责 / 数据流 / 接口 / 约定**，
> **必须在同一个提交里同步更新本文件**（"改代码 → 改地图"是一件事，不是两件事）。
> 若发现本文件与代码不一致：**以代码为准**，顺手把本文件改对。
> 最后更新：2026-10-10（路由层重构恢复：薄分发器 + 7 段函数 + `API_SECTIONS`；`tests/jsmod` 镜像自举修复，不再互删）

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
| 打开界面 | <http://127.0.0.1:8321/>（`/` 会 302 到 `/editor/index.html`） |
| 打包 exe | `python build_exe.py` → `build/SubFabric.exe`（SEA，入口 `editor/scripts/sea-launcher.cjs`） |
| 打安装包 | `"D:\Program Files\Inno Setup 7\ISCC.exe" build/installer/SubFabric.iss` |
| 完整发版流程 | **见 `editor/README.md`「发版流程」节** |

- 版本号唯一来源是 `editor/server.js` 的 `APP_VERSION`；**发版时还要同步** `build/installer/SubFabric.iss` 与 `editor/README.md`。
- SEA 启动器把端口写死 8321（服务端本身认 `PORT` 环境变量，测试探针靠它跑隔离实例）。

---

## 2. 目录地图

| 路径 | 职责 |
| --- | --- |
| `editor/server.js` | **后端全部**（约 7900 行单文件：安全守卫、薄分发器 + 7 段路由、项目系统、下载/prepare/ASR/翻译流水线、托盘、退出） |
| `editor/index.html`、`editor/css/` | 单页界面（`<script type="module" src="js/main.js">`） |
| `editor/js/` | 前端模块（见 §4） |
| `editor/*.js`（顶层） | 后端辅助模块（CJS）：`cast` `llm-text` `reseg` `k-line` `fonts` `secret-store` `asr-chunks` `audio-slice` `bcut-asr` `capcut-asr`；fork 并入：`align` `asr-service` `ass-group` `danmaku` `hotwords` `mt-local` `project-pack` `reflect` `region` `region-merge` `repair-words` `speech-gap` |
| `asr/` | Python 侧：`asr.py`（本地识别）`diarize.py`（说话人分离）`multitalker.py`（NeMo 多说话人）`fetch/`（下载内核）`settings.json`（本机设置，含密文，不入库） |
| `asr/fetch/` | bilibili / YouTube 下载内核（yt-dlp 自举、格式选择、Cookie、分P），细节见 `asr/fetch/README.md` |
| `tests/` | Node / Python 测试（见 §8）；`tests/jsmod/` 是**前端模块自动同步镜像** |
| `tools/` | 探针 / 诊断脚本（CDP 真机测试、布局探针、HTTP 层探针等） |
| `build/`、`build_exe.py` | 打包（`build/installer/` 内图标与 `.iss` 入库，其余产物不入库） |
| `main.py` | **历史遗留**的 Python GUI 工具（字体/颜色等默认值处理），与编辑器主线关系弱 |
| `KARAOKE_DESIGN.md`、`KARAOKE_REFS.md` | 逐词高亮与 `\k` 的格式设计与调研记录（**改字幕格式前必读**） |
| `CODE_REVIEW.md` | 第一轮代码审查报告（2026-10-04，条目已全部关闭，留作记录） |
| `eslint.config.js` | 只抓真错的规则（`no-undef` 等）；跑 lint 需自行 `npm i eslint`（项目无 `node_modules`） |

---

## 3. 后端地图（`editor/server.js`）

### 3.1 单文件约束（先看这条）

SEA 打包入口 `editor/scripts/sea-launcher.cjs` 用 `Module._compile` 从磁盘加载 `server.js`，
**相对 require 在 SEA 里不可用 → `server.js` 必须保持单文件**。
因此"拆分"指的是**函数体内重排**（模块作用域 + 路由段函数），**不要把它拆成多个文件**。

### 3.2 结构（自上而下）

1. **头部基础设施**：`CHILDREN` 子进程登记（**包装过的 `spawn`**，20+ 调用点自动入册，退出时统一杀）、日志环形缓冲 + SSE 广播、`secret-store` 接入。
2. **安全基线**：`safeJoin`（先解码再归一 + 路径分隔符边界，防穿越）、Host 回环校验（防 DNS rebinding）、写方法 Origin 校验（防 CSRF）、`MEDIA_ALLOW` 视频路径登记表。
3. **简单路由表 `SIMPLE_ROUTE_MAP`**：`/` `/index.html` `/api/samples` `/api/version` `/api/fonts` `/api/font-file` `/favicon.ico|svg`；处理器签名 `(req,res,u) → boolean`。
4. **主体（模块作用域）**：项目系统（`projDir/readMeta/writeMeta/metaView/readBody…`）＋ 下载/prepare/ASR/翻译流水线 ＋ 状态容器。
5. **路由分发**：`SIMPLE_ROUTE_MAP`（同步无副作用端点）查表 → `API_SECTIONS` 前缀表分发到 7 个路由段函数 → 静态回落（`serveFile`）。
   段函数签名统一 `(req, res, u)`，段内保持原书写顺序的 if 链，段末 404 JSON 兜底（同码同义，见 §10）。
   2026-10-09 首拆（f8be06a）→ PR #1 合并时被整体回退 → **2026-10-10 在合并后的树上重做**（纯逐字搬移；
   行为等价由行多重集 + AST 路由字面量对照 + `route_smoke`/`http_layer_probe` 新旧对照证明）。
6. 七个段：`handleWaveRoutes`(waveform/peaks/upload-video) · `handleFetchRoutes`(pick/fetch) · `handleAsrRoutes`(asr/analyze) ·
   `handleLlmRoutes`(translate/cast/mt) · `handleLogsRoutes`(logs/lifecycle/quit) · `handleDiagRoutes`(diag/media) ·
   `handleProjectsRoutes`(projects：含热词候选/压缩包/`if (pm)` 项目内操作)。`API_SECTIONS` 正则前缀互不相交（`\b` 防误匹配）。
7. **退出**：`shutdown()`（`/api/quit` 或 SIGINT/SIGTERM 触发）：广播 lifecycle → 杀 `CHILDREN` → `close` + `closeAllConnections` → 超时强退；托盘由 `scripts/tray.ps1`（PowerShell WinForms）实现。

### 3.3 跨请求状态容器（**铁律：必须放模块作用域**）

`prepareJobs` `draftJobs` `pendingAsr` `draftProcs` `draftAborts` `rerecogJobs` `projProcs` `MEDIA_ALLOW`
`mediaMetaCache` `logBuf` `logClients` `lifeClients` `dlState`（模型下载进度）`CHILDREN`

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
→ [ASR] startDraftAsr：whisper.cpp / Parakeet / 必剪 / 剪映 / NeMo；长音频先静音分片
→ [语义分句] reseg（LLM 补标点；所有引擎必经，没配 LLM 就停在这一步）
→ [说话人分离] diarize（可选） → [写字幕]（逐词 ASS 或 SRT）
→ [翻译] translate（LLM，可暂停后"重试"续跑）
```

- 进度写 `meta.draft`（`status: running / paused / error / done`），前端轮询 `GET /api/projects/:id/draft`。
- 防重入：`draftJobs.has(id)`；流水线步骤统一走 `safeDraftStep`（**同步异常与 async reject 都收**，漏收会让状态永远停在 running）。
- 选区重识别是独立后台任务 `rerecogJobs`，前端每秒轮询；**卡死自愈**：20 分钟无进展即判失败（否则按钮被"已有一个任务在运行"永久挡死）。
- **删除项目**：先停该项目全部任务（`killDraftProc` + `killProjProcs`，Windows 上用 `taskkill /T /F` 连孙进程一起收）→ 再逐文件删；删除带重试（杀进程与系统释放文件句柄之间有窗口）；`project.json` **最后删**（失败时项目不消失、可再删一次，不会留"元数据没了但目录还在"的僵尸）。
- 下载/重识别/准备等任务全部有超时或看门狗；新增后台任务时照此办理。

### 3.5 项目内操作（`/api/projects/:id/<action>`）

`info`(PUT 改名) `retry`(POST 初稿重试) `skip`(POST 跳过语义分句) `rerecognize`(GET 轮询 / POST 发起)
`translate`(POST) `draft`(GET) `subtitle`(GET / PUT 裸流写盘 / POST) `relink`(POST)
`prepare`(POST，支持 force/denoise 参数) `peaks`(GET) `audio`(GET)；`DELETE` 项目 = 无 action 的 DELETE。

---

## 4. 前端地图（`editor/js/`）

装配：`editor/index.html` → `<script type="module" src="js/main.js">`；hash 路由（`#/home`、`#/project/<id>`，见 `project.js` 的 `applyHash`）。

| 模块 | 职责 |
| --- | --- |
| `main.js` | 应用主入口：装配各模块、视频/播放控制、波形加载、导出、设置面板、诊断上报 |
| `project.js` | 项目列表/创建/详情、打开项目（含**竞态代次守卫**）、模型下载轮询（含并发闸门） |
| `editor.js` | 右侧编辑面板：**虚拟滚动**卡片列表 + 行内编辑（5000 行量级性能靠它） |
| `timeline.js` | 时间轴 canvas：波形 + 字幕块 + 词级边界拖拽 / 缩放 / 平移（鼠标交互自实现） |
| `videoedit.js` | 视频区就地编辑框（双击字幕 → 点哪个片段改哪个；Enter 存 / Esc 取消） |
| `segment.js` | 就地编辑的**纯函数**：可见文本分段 + 最小替换（见 §6） |
| `karaoke.js` | 逐词高亮核心：词切片↔整句合并、词级时间映射、编辑后按词时长重算 |
| `postprocess.js` | 字幕后处理特效（Glow / Grow / Fade）——纯文本变换，**铁律见 §6** |
| `ass.js` | ASS 文档模型：保留原文行，事件级编辑后整体序列化 |
| `srt.js` | SRT 解析 / 序列化 / 双语合并 |
| `overlay.js` | SRT 双语叠加渲染层（贴视频矩形的 HTML） |
| `assplayer.js` | ASS 渲染器封装（SubtitlesOctopus / libass-wasm，含字体索引缓存） |
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
| `translation.json` | 译文 |
| `reseg.json` | 语义分句缓存 |
| `asr-chunks.json` | 分片数据（用户要的"返回分片数据"） |
| `source.json` | 下载来源元数据（标题/UP/时长等） |
| `draft.log` | 初稿流水线日志 |
| `llm-debug.jsonl` | LLM 调用调试（排查翻译问题） |
| `video/` | 下载产物 |

全局 / 本机（**全部不入库**，见 `.gitignore`）：`asr/settings.json`（含**密文**敏感值）、`asr/models/`、
`asr/whisper.cpp/`、`asr/ytdlp/`、`asr/runtime-python/`（内置 Python）、`editor/vendor/`（libass，约 19MB）。

**敏感数据**（bilibili Cookie / LLM API Key）统一走 `editor/secret-store.js`：Windows DPAPI 密文落盘
（不可用时降级 AES，解密值仅存内存）。**新敏感字段必须走它**：不进命令行参数、不进日志、不回传前端；
临时明文文件必须**用完即删**。

---

## 6. 核心机制备忘（改相关代码前先读）

- **逐词高亮**：不用 `\k`。中文整句一条事件；英文按词切多条事件，当前词用行内色标
  `{\c&H..&}word{\c}` 标记。配对与时间映射全在 `karaoke.js`；格式设计见 `KARAOKE_DESIGN.md`。
- **`\k` 是另一条线**（`editor/k-line.js`）：初稿生成用 `\k` 行文本（每词亮到下一词起点）。
  生成端与编辑器端"同一格式、两个场景"，改动要两边对齐。
- **就地编辑（`segment.js`）只做最小替换**：把被点中的那一段换成新文本，
  **行内其它内联标签一字不动** —— 整行重建会丢行内变色，画面立刻变色。
- **postprocess 铁律**（文件头注释有完整实测记录）：① 只在已有事件文本里内联标签，
  **绝不新增事件**（libass 按 Layer 分组避让，新增事件会叠压）；② **绝不动 `\bord`**
  （包围盒变化带动整行位移）；③ 其余约束先读文件头注释再动手。
- **弹层动效规范**：弹出层统一 `pop-in`（`--pop-ox/oy` 用 `util.popOrigin` 指向触发点；Modal 例外居中）；
  可点元素要有 `:active` 反馈；时长 120~150ms、ease-out、不从 `scale(0)` 出发；`prefers-reduced-motion` 全局关闭；不用 `transition: all`。
- **自动保存**：编辑即防抖保存；`beforeunload` 用 `sendBeacon` 补最后一笔。**无撤销/重做栈**，Esc=取消是安全边界。
- **长音频分片**：静音优先切点（`audio-slice.js` 真 ffmpeg `silencedetect`；纯函数在 `asr-chunks.js`）。

---

## 7. 开发约定与红线

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
| `tests/karaoke-exhaustive.mjs` | 逐词高亮全链路（28183 断言） | 也负责同步 `tests/jsmod` 镜像 |
| `tests/cue-segment-test.mjs` | 就地编辑分段 / 最小替换 | 17 项 |
| `tests/secret-store-test.mjs` | 密文往返 / 篡改检测 | 17 项 |
| `tests/audio-chunk-test.mjs` | 分片纯函数（静音解析 / 切点 / 合并） | 38 项 |
| `tests/colorfix-test.mjs` | 颜色修复 | **需要真实用户项目**，新克隆必失败（非缺陷） |
| 其余 `tests/*-test.mjs` | ass / srt / role / postprocess / reseg / zh-* 等 | 多数独立可跑 |
| `tools/http_layer_probe.mjs` | HTTP 层 47 项（守卫 / 形状 / 设置往返 / 项目全生命周期 / **占用中删除重试**） | **自带服务启停**，直接 `node tools/http_layer_probe.mjs` |
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
> `colorfix-test.mjs` 需要真实用户项目 `projects/p-mugzcab2-09f7z/`，新克隆必然失败（既有基线，非缺陷）。

---

## 9. 常见任务速查

- **加一个 API 端点**：判断它是否"同步、无副作用"：是 → 加进 `SIMPLE_ROUTE_MAP`；
  否 → 归到对应 `handleXxxRoutes` 段内的 if 链（保持段内书写顺序，段末已有 404 兜底）。
- **加一个前端弹层**：`[hidden]` 切 display + `:not([hidden]){animation:pop-in}` + JS 设 `--pop-ox/oy`（用 `popOrigin`）。
- **改 UI 文案**：编辑 `editor/lang/zh-CN.json` 的值即可（键=原文）。
- **改 ASS / 逐词相关**：先读 `KARAOKE_DESIGN.md`、`KARAOKE_REFS.md`、`karaoke.js` 与 `postprocess.js` 头注释。
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
- **`timeline.js` 的 `isPlay` / `textColor` 两个"死变量"**：为"播放头高亮"预留，别删。
- **`detectSilences` 包装里显式传 `undefined`**：透传默认超时，别"顺手清理"。
- **路由段末的 404 JSON**：`/api/*` 前缀命中但 method/路径不匹配时，由段函数回 `{error:'not found'}`（旧单体实现落到静态回落回 text）——
  状态码同为 404，JSON 对 API 调用方更可用；`route_smoke` 里 `/api/diag` GET 的 404 body 是唯一可见差异（有意保留）。

---

## 11. 变更锚点（近期重点，全量用 `git log`）

- **路由重构恢复 + 测试基建修复（2026-10-10）**：`handleRequest` 拆回"薄分发器 + 7 段函数 + `API_SECTIONS`"
  （f8be06a 的做法在合并树上重做；行多重集 + AST 路由字面量对照 + `http_layer_probe`/`route_smoke` 新旧对照
  证明行为等价 —— 唯一差异：`/api/*` 前缀命中但 method 不匹配的 404 由 text 变 JSON，同码同义）；
  `tests/jsmod` 自举 16 处改为"按需补齐 + 内容比对"、不再清空互删；log-panel 测试改为断言"模块级同域"；
  `postprocess.js` 重删 fork 带回的死代码 `has`；server.js 清掉区域里重复的 `LlmError` 声明（模块作用域已有一份）。
- 安全加固：`safeJoin` 边界、Host/Origin 守卫、`/api/media` 白名单、`secret-store` 密文。
- 大拆分：`handleRequest` 3038 行 → 薄分发器 + 7 段函数（行为逐字等价，行多重集对照证明过）。
- **二次加固（2026-10-09）**：`safeDraftStep` 收 async reject、下载看门狗、重识别卡死自愈、
  `mediaMetaCache` 归位、SIGINT/SIGTERM 收尾、明文 cookie 用完即删、前端竞态守卫与 blob 释放、
  `MemoryError` 可读化、字体表边界校验、`detectSilences` 补 duration。
- **删除项目加固（2026-10-09）**：`projProcs` 登记项目内长任务，删除项目前先杀（`taskkill /T` 连孙进程）
  → 带重试删除 + `project.json` 最后删。修复用户报障"下载中删项目 → 500 失败、目录残留"
  （已用真实下载端到端复现与验证）。
- **并入 PR #1（2026-10-10，提交 af04b08/0446ce2）**：接受 R2FtYml0 的 fork 全部功能，并**恢复被其合并
  丢失的上游内容**——\k 卡拉OK全套（karaoke.js/main.js/project.js/index.html/server.js）、视频区就地编辑
  接线（main.js/index.html/css/modal）、2.2.1 全部加固（projProcs/看门狗/自愈/SIGINT/流式字幕保存/前端
  守卫/Python 修复等）。教训：**fork 类大 PR 不能只看"mergeable"，必须逐文件核对"上游内容有没有被合并回退"**。
- UI 动效批；视频区就地编辑；`\k` 初稿线。

---

### 维护提醒（再次强调）

**改代码 → 改本文件。在同一个提交里做完。**
新增一个模块、删一个端点、换一个存储位置、加一条约定 —— 都算"地图要改"。