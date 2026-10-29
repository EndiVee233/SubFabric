# SubFabric

受 [Subforges](https://www.subforges.com/) 启发制作的本地动态字幕编辑器 专注于编辑 预览和导出逐词高亮字幕

SubFabric 适合制作这类字幕
中文整句与英文逐词字幕按时间配对 播放时 高亮颜色跟随当前单词变化

```ASS
Dialogue: 0,0:01:29.33,0:01:30.99,中文字幕,,0,0,0,,{\c&H6262FF&}[AJTHEBOLD]每位选手将拥有三个不死图腾
Dialogue: 0,0:01:29.33,0:01:29.51,Default,,0,0,0,,{\c&H00FF00&}Each{\c} fighter will have three Totem of Undying
Dialogue: 0,0:01:29.51,0:01:29.84,Default,,0,0,0,,Each {\c&H00FF00&}fighter{\c} will have three Totem of Undying
Dialogue: 0,0:01:29.84,0:01:30.02,Default,,0,0,0,,Each fighter {\c&H00FF00&}will{\c} have three Totem of Undying
Dialogue: 0,0:01:30.02,0:01:30.21,Default,,0,0,0,,Each fighter will {\c&H00FF00&}have{\c} three Totem of Undying
Dialogue: 0,0:01:30.21,0:01:30.44,Default,,0,0,0,,Each fighter will have {\c&H00FF00&}three{\c} Totem of Undying
Dialogue: 0,0:01:30.44,0:01:30.67,Default,,0,0,0,,Each fighter will have three {\c&H00FF00&}Totem{\c} of Undying
Dialogue: 0,0:01:30.67,0:01:30.76,Default,,0,0,0,,Each fighter will have three Totem {\c&H00FF00&}of{\c} Undying
Dialogue: 0,0:01:30.76,0:01:30.99,Default,,0,0,0,,Each fighter will have three Totem of {\c&H00FF00&}Undying{\c}
```

## 特效 

目前可用的特效有两个独立开关 可以单独开启 也可以组合

| 特效 | 效果 |
| --- | --- |
| 微光 Glow | 给活动词或整行加一圈光晕 |
| 柔和淡入 Fade In | 高亮色静止不动 整行从较淡轻轻浮现 |

两者都不新增事件 不改时间轴 也**不打断多行字幕的自动避让**
淡入时长会自动按每条字幕自身的长度钳制 短字幕不会被超长动画拖住

词生长 Grow 目前已暂停 控件与运行入口关闭 保留旧存档解析与实现供兼容和后续评估

关于词生长为什么是「静态放大」而不是渐变缩放
ASS 的 `\t()` 变换会让 libass 关闭该行的碰撞避让 —— libass 源码 `ass_parse.c` 里
`\t` 分支无条件执行 `state->detect_collisions = 0` 随后渲染阶段该事件会被整个跳过
实测后果是中英两行直接叠压 而且**哪怕 `\t()` 里什么都没动也一样**
所以全部特效都只用静态标签或 `\fade` / `\k` 这类不碰避让的标签实现

## 首次启动

第一次打开会先检测本机加速能力：

- **CUDA**（NVIDIA 显卡）与 **Vulkan**（AMD / Intel / NVIDIA 通用）至少勾选一项才能进入工作台；没有 N 卡时 CUDA 不可选。
- 不提供 CPU 推理；没有可用 GPU 后端时无法进入。
- **NPU** 不在欢迎界面出现，有 Intel AI Boost / Ryzen AI 等硬件时会在「设置 → 性能与调度」里显示。
- 选择结果会决定语音识别里显示哪些模型：只勾 Vulkan 就只显示 Vulkan，只勾 CUDA 就只显示 CUDA，两个都勾才都显示；NPU 按硬件显示，云端识别免显卡、始终保留。
- 以前下载过但当前后端未勾选/硬件不匹配的模型不会丢，会收进「其它模型」，可以删除释放空间，但不会参与识别。
- 之后可在「设置 → 性能与调度 → 重新进入欢迎界面」重新配置。

## 改界面文案

所有界面文案集中在 `editor/lang/zh-CN.json`，键是原文，值是实际显示内容。想换一种说法直接改值，刷新页面即可；新增文案由 `node tests/gen-lang.mjs` 补齐，`tests/i18n-coverage-test.mjs` 会检查是否有漏掉的用户可见文字。

## 创建稿件

在主界面点击 **「新建项目」**，选择一种方式开始：

### 导入已有字幕

选择视频和字幕文件（ASS/SSA 或 SRT）SubFabric 会把它们放进一个独立项目中 已有的逐词 ASS 可以直接打开编辑

`SubFabric的重心在ASS字幕上 SRT字幕优先级较低`

### 使用语音识别创建初稿

选择视频或受支持的视频链接，选择识别方式后点击 **「开始识别」**。项目会立即出现在列表里，可随时进入「详细信息」查看处理步骤 进度和日志

1. 在「生成设置」中选择是否生成逐词字幕 开启后生成 ASS 逐词字幕 关闭后生成普通 SRT
2. 选择识别引擎 
3. 配置 LLM 服务后开始处理 语音识别完成后 所有引擎都会经过 LLM 语义分句 如果尚未配置 LLM 任务会停在这一步并提示补充设置
4. 说话人区分与字幕翻译按需启用 翻译可生成中文字幕轨 识别和翻译任务的进度都可以在项目详情页查看

## 编辑字幕

打开项目后 可以一边播放视频一边校对字幕

- 实时预览：在视频画面上查看 ASS 特效或 SRT 字幕效果
- 视频区就地编辑：在画面上**双击**某条字幕即弹出小输入框 只改你点中的那一段（按空格分片段） 打字时画面实时跟着变 `Enter` 保存 / `Esc` 取消 / 点框外取消 中文行会保留行首角色标签与行内变色标签 右键字幕可整行改文本（不改时间与样式）
- 字幕列表：查看中英双行 只看中文或只看英文 搜索 筛选并编辑字幕文本
- 时间轴：按时间查看字幕块 拖动字幕或词级边界来调整时间 支持缩放和平移
- 逐词字幕：英文逐词事件会在列表中合并显示为整句 编辑器仍保留词级时间映射 修改句子后会按原词时长重新分配词级时间并刷新预览
- 角色与样式：查看角色信息 调整 ASS 中英样式和逐词高亮色 并检查或修复常见字幕问题
- 自动保存：项目中的编辑会自动保存 

## 导出

可按需要导出

- 原始格式：保留当前格式与 ASS 逐词特效 
- 逐词字幕：导出带逐词高亮效果的 ASS
- 无逐词效果：导出整句 ASS
- 仅中文 / 仅英文：导出对应语言轨
- 逐词 JSON：导出词级时间轴数据 供其它工作流使用

### 导出视频

在编辑器「设置 → 导出 → 导出视频…」里选一个导出目录，勾选需要的内容（可多选 一次导出）：

| 选项 | 产出 |
| --- | --- |
| 双语言硬字幕视频 | 把字幕永久烧进画面 逐词高亮 角色色 微光 淡入都按你的稿件渲染 |
| 生肉（原视频） | 复制一份原片 链接下载的视频也一样 |
| 字幕文件 | 当前稿件的 ASS 含你调好的样式与特效 |

压制的样式**默认继承稿件设置** 你在「设置」里调过的字体 字号 颜色 特效会直接生效 不需要再配一遍
高级选项里可以改编码（H.264 / H.265 / AV1）、加速方式（自动识别 NVIDIA / AMD / Intel 硬件编码 跑不通会自动回退 CPU）
以及画质参数 相同目录下的同名文件默认不会被覆盖

逐词高亮通过 ASS 颜色覆盖标签标记当前单词（例如 `{\c&H00FF00&}word{\c}`）而不是把整句做成单一的颜色动画 若需兼容其它字幕工具 请先确认对方是否支持 ASS 覆盖标签及逐词分段事件

`已知的支持此类型的其它编辑器：subforges`

## 下载与运行

### Windows 安装版

从 [GitHub Releases](https://github.com/EndiVee233/SubFabric/releases) 列表选择已发布的 Windows 安装包。

当前桌面实现为 **SubFabric Electron**（NSIS，Windows x64），版本 `beta 1.5.1.1`，
安装包名 `SubFabric-1.5.1.1-electron-x64-setup.exe`，已完成构建及桌面启动、接口、渲染隔离和退出冒烟。
这是未签名的测试版；实际 GPU 识别、真实媒体导出及旧版迁移未在本轮验收。
安装包包含 Electron、真实 Node 22 运行时和字幕渲染资源，无需自行安装 Node 或 Python；
语音识别所需的 Python 运行时与模型仍按需下载。

这是与旧 SEA 版并存的新安装，不会自动覆盖或迁移旧安装，也不会迁移旧浏览器的 `localStorage`。
桌面版的代码与本地数据位于 Electron 用户数据目录的 `workspace/`；更新只替换校验过的随包代码与渲染资源，
不复制设置、项目、视频、模型或已下载运行时，不删除用户数据。默认后端端口固定为 `8325`，
以保持桌面窗口设置的本源；可用 `SUBFABRIC_DESKTOP_PORT` 覆盖，测试时可设为 `0` 使用临时端口。

### 从源码构建与运行 Electron

需要 Node.js **22.12+（22.x，当前构建运行时为 22.22.2）**。在仓库根目录执行：

```bash
npm --prefix desktop ci
node editor/scripts/fetch-vendor.js
npm --prefix desktop run dist:win
```

安装包输出到 `build/electron/build-<id>/SubFabric-1.5.1.1-electron-x64-setup.exe`；
`build/electron/latest-build.json` 记录最新成功构建的位置和 SHA-256。每次使用新目录，不删除旧构建。
只启动开发版时，前两步完成后执行：

```bash
npm --prefix desktop run stage
npm --prefix desktop start
```

`start` **不会自动 stage**，代码或渲染资源变动后须重新执行 `stage`。
Electron `45.1.0` 与 electron-builder `26.18.0` 的依赖仅在 `desktop/` 独立子包；
根目录不建 `package.json`，后端仍零 npm 依赖，前端仍为无构建步骤的原生 ESM。

### 从源码运行浏览器版（保留入口）

需要 Node.js 22.12+（22.x），不需要安装 `desktop/` 依赖。

> **⚠ 第一次跑必须先生成渲染依赖，否则视频区不会有任何字幕**
>
> ```bash
> node editor/scripts/fetch-vendor.js     # 约 18MB：libass(WASM) + 中文字体
> ```
>
> `editor/vendor/` 没有入库（体积原因），所以**每个新克隆都要跑一次**。
> 缺了它会发生什么：字幕**列表**正常、时间轴正常，但**视频画面上不显示字幕**，
> 而且样式面板里也**看不到「ASS 渲染就绪」这行状态** —— 因为 libass 的 worker
> 起不来。这不是字幕文件的问题，是渲染器缺失。
>
> 从 Releases 下载的**安装版不需要**这一步（安装包里已包含）。

然后启动本地服务：

```bash
node editor/server.js
```

打开 <http://127.0.0.1:8321/>

## 项目文件与本地数据

- 每个项目的数据保存在本机 `projects/` 下 包括字幕副本 项目资料 以及为波形和后续处理生成的音频数据
- 通过浏览器选择的视频会保存一份到程序目录的 `videos/` 下 项目引用这份持久副本 旧项目若直接引用外部视频路径 移动或删除该文件后需要重新关联
- 识别 模型与 LLM 等全局设置保存在本机 请妥善保管 API Key 不要把含凭据的设置文件公开分享
- 删除项目会删除该项目目录中的副本与派生文件 不会删除原始视频和原始字幕文件

## 受支持的模型
| 模型 | 硬件要求 |
| --- | --- |
| Parakeet TDT 0.6B v2（Vulkan 通用） | Vulkan 加速（CrispASR/ggml）：A 卡 / Intel 核显 / N 卡都能用，**无 N 卡也能跑**；不需要 Python，没有 Vulkan 驱动时自动退 CPU |
| Parakeet TDT 0.6B v2（Intel NPU） | Intel NPU 加速（OpenVINO）：编码器跑 NPU、预测/联合网络跑核显，**无 N 卡可用** |
| Qwen3-ASR 1.7B | NVIDIA CUDA；只下载 ASR 权重（约 4.0GB）；逐词时间由「对齐模型」中的 Qwen3-ForcedAligner 单独提供，5/10 分钟按 150s 分块 |
| Qwen3-ForcedAligner 0.6B | 独立对齐模型；CUDA / Vulkan 两个版本，只在需要逐词或「对齐」时使用 |
| Qwen3-ASR 1.7B（Vulkan 通用） | 无 N 卡时的中档兜底：CrispASR + Vulkan，Q4 约 1.5GB；逐词需另下对齐模型；有 N 卡请优先 CUDA 版 |
| **Whisper large-v2（人声分离精校）** | NVIDIA 显卡 + 约 1.5GB Faster-Whisper-XXL 运行时；内置 MDX 人声分离，带 BGM 的素材准确率最高（本机实测比 Parakeet 更准，但更慢） |
| Whisper large-v2（Vulkan 通用） | 无 N 卡时的质量档兜底：CrispASR + Vulkan，约 3.1GB；逐词需另下对齐模型；有 N 卡请优先 CUDA 版 |
| 必剪 ASR | 会上传至 bilibili 服务器进行语音识别 无硬件要求 |
| 剪映 ASR | 会上传至字节跳动服务器进行语音识别 无硬件要求 |

> 2026-10-21 起停用：Parakeet CUDA（sherpa-onnx）、Whisper large-v3-turbo（whisper.cpp）、
> Multitalker Parakeet Streaming 0.6B v1（NeMo）、NPU+GPU 双引擎、VibeVoice ASR 4bit。
> 对应模型、运行时安装、设置入口与速度测试均已关闭；已下载的文件不会自动删除。

Whisper 与 CrispASR 模型行上有「参数」入口：可调识别语言、VAD 开关/阈值/方法、MDX 人声分离、
逐词时间戳、线程数等；面板显示当前值和默认值，支持保存与恢复默认。

## 开发与文档

开始任务或恢复上下文时，先看 **[docs/PROJECT.md](docs/PROJECT.md)**（唯一技术文档：目录地图 后端/前端结构
核心数据流 测试与发版流程 设计结论）和 **[AGENTS.md](AGENTS.md)**（长期工作规则）。

代码结构发生变化时 **请同步更新 docs/PROJECT.md**

## 你知道吗

- SubFabric 是独立的本地字幕编辑器 SubForges 是在线的多人协作动态字幕编辑器 并非本项目的依赖或关联服务
- EndiVee233 因为忍受不了 SubForges 编辑时的卡顿而创建了 SubFabric
- SubForges 支持多人一起编辑同一个稿件 但 SubFabric 不可以
- 对比 SubForges 来说 SubFabric 的初稿创建烂透了 而我根本不知道从何下手 所以我建议在 SubForges 创建初稿 再将字幕导入到 SubFabric 进行编辑
- SubFabric 的核心逻辑其实并不是 EndiVee233 提出的 而是 WhitherRoseE`（无法联系）` 提出的
- SubFabric 完全由 AI 负责 而 EndiVee233 实际上并没有看过任何代码 也看不懂任何代码 所以有时 EndiVee233 会怀疑自己能不能胜任这个项目 甚至会想将它拱手让人
- 如果你使用了此项目并会在bilibili发布视频 我`希望`能在联合投稿`研发`里露面`UID:2121076233` 若对此条感到反感 就忽略这个请求吧
- EndiVee is the biggest bird
- 
