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

我们并没有使用\k标签制作动态效果
`从v2.1.8 开始 可以在稿件设置内开启特效`

特效现有三个独立开关 可以单独开启 也可以任意组合

| 特效 | 效果 |
| --- | --- |
| 微光 Glow | 给活动词或整行加一圈光晕 颜色 描边/阴影通道 半径 强度都能调 |
| 词生长 Grow | 把逐词高亮的活动词放大一圈 |
| 柔和淡入 Fade In | 高亮色静止不动 整行从较淡轻轻浮现 |

三者都不新增事件 不改时间轴 也**不打断多行字幕的自动避让**
淡入时长会自动按每条字幕自身的长度钳制 短字幕不会被超长动画拖住

关于词生长为什么是「静态放大」而不是渐变缩放
ASS 的 `\t()` 变换会让 libass 关闭该行的碰撞避让 —— libass 源码 `ass_parse.c` 里
`\t` 分支无条件执行 `state->detect_collisions = 0` 随后渲染阶段该事件会被整个跳过
实测后果是中英两行直接叠压 而且**哪怕 `\t()` 里什么都没动也一样**
所以全部特效都只用静态标签或 `\fade` / `\k` 这类不碰避让的标签实现

## 创建稿件

在主界面点击 **「新建项目」**，选择一种方式开始：

### 导入已有字幕

选择视频和字幕文件（ASS/SSA 或 SRT）SubFabric 会把它们放进一个独立项目中 已有的逐词 ASS 可以直接打开编辑 SRT

### 使用语音识别创建初稿

选择视频或受支持的视频链接，选择识别方式后点击 **「开始识别」**。项目会立即出现在列表里，可随时进入「详细信息」查看处理步骤 进度和日志

1. 在「生成设置」中选择是否生成逐词字幕 开启后生成 ASS 逐词字幕 关闭后生成普通 SRT
2. 选择识别引擎 
3. 配置 LLM 服务后开始处理 语音识别完成后 所有引擎都会经过 LLM 语义分句 如果尚未配置 LLM 任务会停在这一步并提示补充设置
4. 说话人区分与字幕翻译按需启用 翻译可生成中文字幕轨 识别和翻译任务的进度都可以在项目详情页查看

## 编辑字幕

打开项目后 可以一边播放视频一边校对字幕

- 实时预览：在视频画面上查看 ASS 特效或 SRT 字幕效果
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

逐词高亮通过 ASS 颜色覆盖标签标记当前单词（例如 `{\c&H00FF00&}word{\c}`）而不是把整句做成单一的颜色动画 若需兼容其它字幕工具 请先确认对方是否支持 ASS 覆盖标签及逐词分段事件

`已知的受支持的其它编辑器：subforges`

## 下载与运行

### Windows 安装版

从 [GitHub Releases](https://github.com/EndiVee233/SubFabric/releases/latest) 下载最新的安装包并安装

### 从源码运行

需要 Node.js 22 首次运行先准备 libass 渲染器与中文字体 再启动本地服务

```bash
node editor/scripts/fetch-vendor.js
node editor/server.js
```

然后打开 <http://127.0.0.1:8321/>

## 项目文件与本地数据

- 每个项目的数据保存在本机 `projects/` 下 包括字幕副本 项目资料 以及为波形和后续处理生成的音频数据
- 原始视频按本地路径引用 并不会复制进项目目录 移动或删除原视频后 需要重新选择视频才能继续播放
- 识别 模型与 LLM 等全局设置保存在本机 请妥善保管 API Key 不要把含凭据的设置文件公开分享
- 删除项目会删除该项目目录中的副本与派生文件 不会删除原始视频和原始字幕文件

## 受支持的模型
| 模型 | 硬件要求 |
| --- | --- |
| Parakeet TDT 0.6B v2 | NVIDIA 显卡加速（sherpa-onnx / CUDA） |
| Parakeet TDT 0.6B v2（Intel NPU） | Intel NPU 加速（OpenVINO）：编码器跑 NPU、预测/联合网络跑核显，**无 N 卡可用** |
| Whisper large-v3-turbo | Vulkan 加速 这意味着只要支持 Vulkan 的显卡均可加速 |
| Multitalker Parakeet Streaming 0.6B v1 | NVIDIA 显卡加速（但它仅用于重新识别） |
| 必剪 ASR | 会上传至 bilibili 服务器进行语音识别 无硬件要求 |
| 剪映 ASR | 会上传至字节跳动服务器进行语音识别 无硬件要求 |
  
## 你知道吗

- SubFabric 是独立的本地字幕编辑器 SubForges 是在线的多人协作动态字幕编辑器 并非本项目的依赖或关联服务
- EndiVee233 因为忍受不了 SubForges 编辑时的卡顿而创建了 SubFabric
- SubForges 支持多人一起编辑同一个稿件 但 SubFabric 不可以
- 对比 SubForges 来说 SubFabric 的初稿创建烂透了 而我根本不知道从何下手 所以我建议在 SubForges 创建初稿 再将字幕导入到 SubFabric 进行编辑
- SubFabric 的核心逻辑其实并不是 EndiVee233 提出的 而是 WhitherRoseE`（无法联系）` 提出的
- SubFabric 完全由 AI 负责 而 EndiVee233 实际上并没有看过任何代码 也看不懂任何代码 所以有时 EndiVee233 会怀疑自己能不能胜任这个项目 甚至会想将它拱手让人
- 如果你使用了此项目并会在bilibili发布视频 我`希望`能在联合投稿`研发`里露面`UID:2121076233` 若对此条感到反感 就忽略这个请求吧  
- EndiVee233 通常不希望这个项目有太多的star 因为星星越耀眼 人们越容易注意到它 
