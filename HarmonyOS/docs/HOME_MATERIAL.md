# 主页与项目页：一套代码适配手机 / 平板 / 横屏（HdsTabs + 沉浸光感）

本文对应 `entry/src/main/ets/ui/home/` 与 `pages/Index.ets`。所有结论都以
`hvigorw clean && assembleHap` 能通过为前提（见 §8）。

## 1. 目录

```
entry/src/main/ets/
├── entryability/
│   └── EntryAbility.ets          # 全屏 + 透明系统栏 + 外观明暗（浅/深/跟随系统） + 下发安全区高度
├── pages/
│   └── Index.ets                 # @Entry：光感背景 + HdsTabs（主页/项目/模型/设置）
│                                 #         + 项目页抽屉（根层）
├── ui/nav/
│   └── GripAwareness.ets         # 项目页边栏方向：系统握姿优先 + 触摸落点兜底
├── ui/projects/
│   ├── ProjectsPane.ets          # 项目页主体（☰ + ＋ + 稿件瀑布流 + 两侧边缘热区）
│   ├── NewProjectPane.ets        # 新建稿件页（名称 / 媒体 / 创建，HdsTabs 返回键）
│   └── ProjectsDrawer.ets        # 项目页抽屉 / lg 左侧同级浮动侧栏
├── platform/
│   └── ThemeManager.ets          # 明暗模式落地：effectiveLight + 应用 ColorMode + 系统栏图标
├── ui/editor/
│   └── EditorPage.ets            # 稿件编辑页：视频 / 时间轴 / 右边栏三板块 GridRow 布局
├── ui/models/
│   └── ModelsPane.ets            # 模型页：Parakeet NPU / Vulkan 下载卡 + 手动导入
├── ui/settings/
│   ├── SettingsPane.ets          # 设置：sm 一级单列 + 二级；md/lg 双栏
│   └── AppearancePrefs.ets       # 外观与体验偏好（背景/流光/毛玻璃/主题色，PersistentStorage）
└── ui/home/
    ├── HomeBreakpoints.ets       # @ohos.mediaquery 监听 sm/md/lg + HomeDims 断点变量
    ├── HomePreferences.ets       # 光感强度的 AppStorage 键与换算
    ├── HomeTokens.ets            # 双主题语义色令牌（浅/深） + 问候语/日期/相对时间
    ├── HomeData.ets              # HomeSummary / QuickAction
    ├── HomeShapes.ets            # 花形路径（由 Web 模板机械提取）
    ├── GlassCard.ets             # 玻璃卡片：半透明底 + backdropBlur + 阴影 + 按压/悬停
    ├── GlowButton.ets            # 光晕按钮
    ├── HeroSection.ets           # 花形时钟 + 问候；compact 模式只保留钟面
    ├── QuickCards.ets            # 处理中 / 快捷动作卡（竖屏与横屏共用）
    ├── QuickGrid.ets             # 旧竖屏栅格（已不挂载，保留）
    ├── RecentFlex.ets            # 旧最近稿件 Flex（已不挂载，保留）
    ├── RecentCard.ets            # 横屏整宽最近稿件卡（现用于瀑布流单卡）
    ├── ResumeCard.ets            # 横屏「当前正在编辑」宽卡
    ├── StatsRingCard.ets         # 横屏统计环卡（可编辑 / 需处理）
    ├── AppearancePanel.ets       # 光感强度（设置页与主页均已移除入口，保留组件）
    ├── HomePane.ets              # 主页：Hero + WaterFlow 2/3/4 列瀑布流
    └── ImmersiveBackground.ets   # 高模糊位图 + 渐变遮罩 + 斜向光带

docs/archive/                     # 被删除页面的备份（工程没有 git，删掉不可恢复）
├── StudioPage.ets.bak            # 老主页 / 编辑器 / 听写 / 模型 / 设置 五页合一
├── DetailPane.ets.bak            # 原 Navigation 双栏的右栏
├── HomeNavBar.ets.bak            # 原自绘玻璃导航条（已被 HdsTabs 取代）
└── HomeTabBar.ets.bak            # 原横屏自绘胶囊（已改为同一个 HdsTabs + adaptToHandedness）
```

> 2026-11-16 重构：除主页外的旧页面已删除；底部导航换成 UIDesignKit 的 `HdsTabs`。
> **项目页已重建**（仿日历的抽屉结构，稿件卡为宽度自适应瀑布流，右上角 ＋ 进入新建稿件页），设置页已重建为两级结构，模型页已加入 Parakeet NPU / Vulkan 下载卡与手动导入。

## 2. 分区与手势

四个分区固定顺序：**主页 / 项目 / 模型 / 设置**。

| 场景 | 栏的实现 |
| --- | --- |
| sm / md / lg | **同一个 `HdsTabs`**：`barFloatingStyle(IMMERSIVE / EXQUISITE)` + 官方沉浸材质 + 渐变遮罩，`barBottomMargin = (12 + navIndicatorHeight) × 0.8`；横屏不再自绘胶囊 |
| 左右手跟随 | `barFloatingStyle.adaptToHandedness: true`：由 HdsTabs 自带能力按交互手把整条栏在底部左右移动；依赖设备传感器，模拟器/无该硬件时保持默认居中，不能用模拟器结果判断功能失效 |

横屏自绘胶囊已移除，`HomeTabBar.ets` 归档到 `docs/archive/HomeTabBar.ets.bak`。
横屏和竖屏现在是同一个 HdsTabs 实例，切换方向不会重建栏；`adaptToHandedness`
只负责位置，不改变当前选中页签、滚动位置或业务状态。

| 能力 | 实现 |
| --- | --- |
| 是否可左右滑 | `.scrollable(false)`：鼠标滚轮 / 触控板纵向滚动不得切换主页 / 项目 / 模型 / 设置；页签只由点按切换，页面内的横向列表（时间轴等）保留自己的手势 |
| 布局切换 | 统一由 `@ohos.mediaquery` 的 sm (<600vp) / md (600–840vp) / lg (>=840vp) 驱动；不再按 `deviceInfo.deviceType`、折叠状态或横竖屏分支 |
| 切换 | `HdsTabsController.changeIndex(i)`；主页卡片上的动作也会跳到对应分区 |
| 抽屉 / 侧栏 | sm/md 抽屉展开时 `barHeight = 0`，面板覆盖全屏；lg 侧栏展开时底栏保留，项目页整体右移缩窄（按剩余宽度重算断点，间距 ×0.9） |

## 2.5 项目页边栏的握姿侧

**底部 HdsTabs 的左右跟手不在这里实现**：它由 `barFloatingStyle.adaptToHandedness`
交给组件原生处理；这个开关只负责移动页签栏，**不会把手性结果暴露给应用**。

`GripAwareness` 负责项目页抽屉从哪一侧打开，优先使用同一套智感握姿系统能力：

1. `@kit.MultimodalAwarenessKit` 的 `motion.on('holdingHandChanged')`（API 20+，需要
   `ohos.permission.DETECT_GESTURE`）。`LEFT_HAND_HELD` 写 left，`RIGHT_HAND_HELD` 写 right；
   `NOT_HELD / BOTH_HANDS_HELD / UNKNOWN_STATUS` 不表态，保留当前默认侧。
2. 设备不支持（801）或权限被拒（201）时，退回触摸推断：左 1/3 判左手、右 1/3 判右手，
   连续 2 次同向才切换；只采样下半屏内容区（`yRatio` 0.55–0.86），避开左上角 ☰ 和底部 HdsTabs 栏。
3. 系统握姿订阅成功后，触摸推断不再覆盖真实手性（`sensorActive` 守卫）。

结果只写 `AppStorage['gripSide']`；点左上角 ☰ 时读这个值，默认左侧。
右边缘临时拉出只改本次 `drawerSide`，**不写回** `gripSide`，关闭后再点 ☰ 仍按默认/检测侧。

**lg 宽屏例外（`dims.bp === Bp.LG`）**：项目页侧栏固定从左侧呼出，不再读握姿；
左上角 ☰ 直接传 `left`。右侧边缘热区不挂载，避免 lg 宽屏右边缘再拉出反向抽屉。
lg 左边缘热区放在入口页根 Stack、位于 HdsTabs 之上，否则 HdsTabs 的横向切页手势
会先吃掉横滑。sm / md 仍按握姿侧打开覆盖式抽屉。

## 2.6 项目页抽屉

`ProjectsDrawer` 仍渲染在入口页的**根 Stack**，但按断点分成两套形态：

- **sm / md**：全屏遮罩 + 侧滑面板，盖住底部标签栏与状态栏；展开时 `barHeight = 0`。
- **lg**：不再铺遮罩，也不再盖住项目页。侧栏是左侧一张浮起的同级玻璃面板，
  项目页和底部 HdsTabs 一起右移、缩窄，侧栏与内容同时可见。

| 行为 | sm / md | lg |
| --- | --- | --- |
| 呼出 | ☰ 按 `GripAwareness` 的握姿侧；左 / 右边缘都可横滑 | 固定左侧；☰ 与左边缘都开左侧，右侧热区不挂载 |
| 收起 | 点遮罩 / 点面板 ✕ / 把面板朝屏幕外横滑 | 项目页左上角 ☰ 再点一次 / 点面板 ✕ / 把面板朝左横滑；没有遮罩。开启「侧栏常驻展开」后隐藏 ✕ 并禁用横滑收起 |
| 常驻 | 不生效（覆盖式面板会挡住页面） | 设置 → 个性化 →「项目页 → 侧边栏常驻展开」开启后，进入项目页自动展开；离开项目页仍按标签切换逻辑收起 |
| 打开稿件 | 打开卡片或侧栏稿件后保持展开；编辑页是全屏覆盖层，关闭后回到原状态 | 同左；不再在 `openProject()` 里强制 `drawerOpen = false` |
| 新建稿件 | 进入新建页时临时收起覆盖式抽屉，取消/返回后恢复 | 新建页只占右侧内容区，侧栏保持展开；新建页背景改用全局沉浸光感 + 全高玻璃卡，不再叠第二张 `ImmersiveBackground` |
| 面板宽度 | 原 78% 的 2/3（约 52%），夹在 176–307vp；菜单宽度跟随面板上限收窄 | 屏宽约 21%，夹在 280–330vp |
| 面板外形 | 贴屏幕边；只圆朝内的两个角 | 四边各留 10vp，四角圆角，整块浮起；无深色遮罩 |
| 内容让位 | 无（面板覆盖页面） | 左侧让出「面板 + 2×10vp 留白 + 14vp 间距」；底栏保留，项目页按剩余宽度重排，间距 / 内边距轻收 0.9 档 |
| 面板材质 | `backgroundEffect` 实时模糊（radius 36）+ 15% 深色染色 + 高光渐变 + 阴影 | 同左，阴影改为四周均匀，保证和项目页处在同一视觉层级 |
| 内容 | 稿件库（列稿件）+ 文件夹（列文件夹，末尾常驻「＋ 新建文件夹」）；文件夹存 `AppStorage['projectFolders']`，当前层级存 `AppStorage['projectActiveFolder']` | 同左 |
| 字号/图标 | 标题 title+6、正文 body+4、标签 label+2；lg 行高 72、列表图标 30、关闭键 48 | 同左 |
| 文件夹层级 | 单击文件夹进入/退出该层级；当前层级的行用更亮的玻璃底、`folder_fill` 图标和主题色文字区分；抽屉副标题显示「当前：xxx」 | 同左 |
| 文件夹交互 | 行按压 0.97 缩放 + 玻璃底；长按 360ms 抬起 1.02 并跟手拖动，在文件夹下方弹出「重命名 / 删除文件夹」菜单；菜单用 `backgroundEffect` 实时模糊 + 半透明高光渐变，两个条目的按压遮罩是 14vp 圆角矩形（左右各留 4vp）；鼠标右键弹同一菜单；拖拽跨过整行时其余行让位，松手写回顺序；重命名复用同一系统风格对话框并同步当前层级，删除后若删的是当前层级则退回全部 | 同左 |
| 新建文件夹 | 行按压缩放/高亮 → 系统风格 `CustomDialog`：居中标题（sm/md 20 / lg 24），输入框为单横线（透明底，聚焦时线变主题色），底部纯文字「取消」红 /「确定」主题色，中间一条竖分隔线；去掉胶囊底色与描边，按压时整个按钮半区浮出浅色药丸底；空名用「新建文件夹」，确定后去重写入 `projectFolders` | 同左 |

## 3. 断点变量：尺寸不写死

`HomeDims` 是唯一尺寸来源，三个分支各给一套值：

| 字段 | sm (<600) | md (600–840) | lg (≥840) |
| --- | --- | --- | --- |
| `twoPane` | false | true | true |
| `navBarWidth` | 0 | 360 | 460 |
| `pagePaddingH` | 16 | 24 | 30 |
| `gap` / `rowGap` | 10 / 14 | 14 / 18 | 18 / 22 |
| `radiusCard` | 22 | 26 | 30 |
| `cardPadding` | 12 | 18 | 24 |
| `cardMinHeight` | 100 | 124 | 148 |
| `quickColumns` | 2 | 2 | 2 |
| `recentItemBasis` | 47% | 47% | 47% |
| `flowerSize` | 96 | 114 | 136 |
| `titleSize` / `bigNumberSize` | 16 / 26 | 21 / 34 | 24 / 42 |
| `bodySize` / `labelSize` / `miniSize` | 12 / 10 / 9 | 14 / 12 / 11 | 16 / 13 / 12 |
| `buttonHeight` / `navBarHeight` | 38 / 62 | 44 / 72 | 48 / 80 |
| `heroButtonWidth` | 104 | 120 | 136 |
| `glassBlur` | COMPONENT_REGULAR | COMPONENT_THICK | COMPONENT_THICK |

组件里没有 `12`、`24` 这类裸数字，一律 `this.dims.xxx`；断点一变，整页跟着变。

所有视觉尺寸只由 `bp` 决定，不再读 `deviceInfo.deviceType`，也没有“平板额外放大”这一层：
sm / md / lg 三套值就是最终值。同一宽度下的手机横屏、折叠屏展开、平板和 2in1
会得到同一套布局尺寸；设备类型不再参与布局分支。

`HomeDims` 还有第三个可选参数 `compact`（默认 1）。lg 项目页侧栏展开时，
`Index.contentDims()` 按「全屏宽度 − 侧栏让位」重算断点，并传 `0.9`：
只收 `pagePaddingH/T/B`、`gap / rowGap`、`cardPadding`、`cardMinHeight`、
`radiusCard / radiusInner`，字号不变。这样项目页右移后卡片与水平间距一起轻缩，
而不是只把右侧内容裁掉。

## 4. 布局组件

主页当前用 `WaterFlow`（见 §4.1）；旧的 `QuickGrid`、`RecentFlex` 和横屏 `GridRow`
错位布局已不再挂载，文件保留在 `ui/home/` 里作历史实现。

### 4.1 主页瀑布流

`HomePane` 不再按 `landscape` 切两套排列：

- 顶部固定 `HeroSection`（花形时钟 + 新建/导入），整宽，不参与瀑布流；
- 卡片放进 `WaterFlow`：处理中 + 6 张快捷动作 + 最近稿件；
- 列数只按 sm / md / lg：sm 2 列（手机）、md 3 列（折叠屏/横屏）、lg 4 列（平板/宽窗口）；
- `FlowItem` 宽度 100%，列间距用 `dims.gap`、行间距用 `dims.rowGap`，底部给 HdsTabs 留出
  `bottomInset`；
- 横向滚动方向由 `WaterFlow.onDidScroll` 通知入口页：内容向上滚（offset > 0）累计超过
  48vp 收起底栏（`barHeight` 切到 0），向下滚（offset < 0）累计超过 32vp 展开；
  回到顶部也强制展开。切换 Tab、打开项目时同样会展开，避免底栏藏起来后无法导航；
- 横屏不再单独走 `GridRow`，`StatsRingCard` / `ResumeCard` 也不再挂载；同一套卡片在
  横屏只是列数变多。底部仍由入口页同一个 `HdsTabs` 负责。

### 4.2 项目页瀑布流

项目页顶栏固定在顶部，稿件卡片放进 `WaterFlow`：

- 列数只按 sm / md / lg：sm 2 列（手机）、md 3 列（折叠屏/窄窗口）、lg 4 列（平板/宽窗口）；
- 与主页共用同一套 `dims.gap` / `dims.rowGap` 间距；`FlowItem` 宽度 100%，
  卡片外壳统一用 `GlassCard`，按下缩放、悬停抬升和玻璃材质与主页一致；
- 卡片内容：左上音轨图标 + 右上字幕条数徽标、稿件名（最多两行）、媒体文件名、
  分隔线、更新时间与 `EN → ZH` 语言对；标题换行会让卡片自然形成高低差，
  瀑布流按最短列填充；
- 点击卡片仍走 `store.openProject()`；长按卡片或鼠标右键会弹出悬浮菜单（重命名 / 详细信息 /
  删除稿件）。菜单位置按指针/手指坐标计算并夹在窗口内，点空白关闭；重命名走
  `ProjectRenameDialog`，详细信息用系统 `AlertDialog` 展示 ID/字幕数/语言/时长/媒体路径/
  更新时间，删除需二次确认，确认后移除工程目录（`cues.json`、代理缓存等），但保留
  `files/media` 下已导入的媒体文件。长按后 320ms 内屏蔽卡片点击，避免误开编辑页；
- sm/md 保留左右各 28vp 的边缘抽屉热区，lg 只保留左侧热区（见 §2.5），不因瀑布流改变手势范围；
- lg 侧栏展开时，`ProjectsPane` 收到的是按剩余宽度重算的 `contentDims`
  （见 §3），瀑布流列数和卡片宽度随右移后的空间重排，底部 HdsTabs 保留并一起右移。
- lg 页头左侧「☰ + 项目」用 `translate({ x: -leftInset })` 反向抵消入口页给整块内容
  加的左移量，停在屏幕原位，由侧栏直接盖住；右侧「N 个稿件 / ＋」和稿件卡片仍留在
  右移后的内容区。这样侧栏打开时不会出现标题被推到侧栏右边、和卡片一起移动的效果。
- 项目页不再为底部 HdsTabs 预留高度：外层 `padding` 只保留左右和顶部，`WaterFlow`
  直接铺到屏幕底部，浮动栏覆盖在内容之上。

### 4.3 新建稿件页

项目页右上角的「＋」与左上角 ☰ 一样，用 **HdsTabs 单 Tab** 承载
`IMMERSIVE / EXQUISITE` 材质；图标是 `sys.symbol.plus`，主色，尺寸跟随断点
（sm/md 44vp、lg 48vp）。点击后 `NewProjectPane` 从右侧滑入，盖住项目页内容：

- 页头：HdsTabs 返回键 + `SubFabric / 新建稿件` + 标题与说明；
- 主体用 `WaterFlow`，列数由 mediaquery 的 sm/md/lg 断点决定：
  sm 1 列、md 2 列、lg 3 列；四个板块依次为：
  1. **PREVIEW / 稿件预览**：视频或字幕占位、标题 / 作者 / 时长 / 简介元信息；
  2. **INPUT / 输入与配置**：项目名称、生成方式、素材来源（视频 / 字幕 / 项目包）、
     「删除换行符」开关、可创建提示与返回 / 创建按钮；
  3. **PROCESS / 处理进度**：读取素材 → 创建项目 → 写入字幕 / 语音识别（按生成方式切换）
     → 完成四步状态、进度条与最多 6 行处理记录；
  4. **GENERATE / 生成设置**：当前翻译方案（接口 / 模型来自全局设置）、刷新 / 管理入口，
     以及端侧识别的模型/NPU 依赖说明。
- 现阶段可用链路有两条：
  - **导入已有字幕**：
    - 视频可选；字幕支持 `.srt` / `.vtt` / `.ass` / `.json`，创建时才把视频复制进沙箱；
    - `.ass` 只取 Dialogue 文本与时间；遇到 Main / Sub 双样式时把 Sub 当原文、Main 当译文；
    - `.json` 兼容 `{ meta, cues:[...] }` 和纯 cue 数组；
    - `.zip` 项目包读取 `subtitle.srt` / `subtitle.ass`，同时读 `translation.json` 的
      `lines` 写译文、读 `project.json` 的 `name` 作为名称回退；
    - 项目包只带字幕与译文，视频仍需另行选择；
    - 解析失败、空字幕、项目包缺字幕文件都会给出明确提示；创建时先 `createProject()`，
      再写入 cue、调用 `saveCurrent()` 保存，最后刷新 `projects` 并进入编辑页。
  - **创建初稿**：选视频/音频 → 复制进沙箱 → `createProject()` → `AppStore.runRecognition()`
    → 把识别结果写入 `cues.json`；识别失败会删除刚创建的空项目，不留下半成品。
- 两种方式创建成功后都会在 320ms 后调用 `onOpenProject` 直接进入编辑页，省去手动点卡片。
- 新建页打开时，系统返回键/返回手势会关闭新建页并回到项目页；复制媒体或识别进行中时
  不关闭，避免中断当前操作。
- 初稿模式依赖 NPU 与已就绪的 Parakeet `.ms` 模型；模拟器无 NPU 时会给出具体失败原因，
  不会伪造字幕。
- 新建页同样不再为底部 HdsTabs 预留高度，WaterFlow 铺到屏幕底部，浮动栏覆盖内容。

### 4.4 稿件编辑页

点击项目卡片 / 抽屉里的稿件进入全屏 `EditorPage`。入口页根节点是 `Navigation(NavPathStack)`，
编辑页作为 `NavDestination('editor')` 入栈，所以整页盖住底部 HdsTabs；页面返回键与系统返回
都调用同一个 `closeEditor()`，不会出现两套返回逻辑。

开合用 `Navigation.customNavContentTransition`，不依赖 `geometryTransition` / `bindContentCover`：

- 点击卡片时先用 `getComponentUtils().getRectangleById('project_card_<id>')` 记录卡片在窗口中的
  位置与尺寸，再用 `getComponentSnapshot().get(cardId)` 把卡片截成 `PixelMap`；
- 根 Stack 顶层显示截图替身：外层容器负责 `translate`，内层图片负责 `scale`
  （`centerX/centerY = 0`，两套 transform 分开，避免缩放把位移一起放大），并用
  `animateTo` 同时驱动 `scale / translate / borderRadius(clip 形状) / opacity`；
  目标位移由「卡片矩形」与「窗口矩形」的差算出；
- push 前把编辑页 `navContentOpacity` 置 0；替身从卡片铺满窗口后淡出，编辑页同步淡入。
  pop 前截取 `editor_root` 整页快照，用同样的反向替身缩回原卡片矩形，再淡出；
- 无快照时（例如从首页最近稿件进入）直接切换，不阻塞导航。

页面用 `GridRow` + `GridCol`，直接读 `dims.bp`（来源仍是 @ohos.mediaquery）：

- **lg**：左右两栏。左栏 `span 8/12`，内部分上下两块：视频播放板块（上，`layoutWeight 1`）
  和时间轴板块（下，254vp）；右栏 `span 4/12` 为右边栏，占满高度。
- **sm / md**：左右两栏都变成 `span 12/12`，按「视频 → 时间轴 → 右边栏」纵向堆叠，
  外层套 `Scroll`；视频固定 248/300vp，时间轴 268/280vp，右边栏 540/580vp。

三个板块都用同一套 `EditorPanel` 玻璃壳，内部先用原生组件画出功能区：

| 板块 | 当前内容 |
| --- | --- |
| 视频播放 | 真实 `Video` 播放器（本地媒体）+ 实时字幕叠加；播放/上一帧/下一帧、进度滑杆、时间码、倍速、音量滑杆。优先系统解码；AV1 且无系统硬解时自动生成/复用 H.264 代理，视频区显示转码进度与「AV1 · 软件代理」状态 |
| 时间轴 | 备注/弹幕输入、停留时长、发送、时间码、固定 `00:00–00:25` 刻度尺；横向 `List` + `LazyForEach` 渲染真实 `Cue` 卡片，卡片里的词时间刻度来自 `Cue.words`（真实波形提取待接入） |
| 右边栏 | 顶部 Tab：字幕 / 人物 / 设置 / 日志 / 工作量；字幕 Tab 内是角色筛选、内容过滤、显示模式、「重新导入字幕」、真实字幕卡片列表；双栏按钮可同时显示「字幕列表 + 人物列表」（对齐桌面版 split roles）。字幕卡片单击 seek，双击进入行内编辑：中文/英文两个 `TextArea`，保存后写回 `cues.json` 并标记「已校对」；修改英文会清空旧的 ASS 逐词时间，避免高亮错位。人物 Tab 从字幕 `[Name]` 标签统计人物，设置 Tab 接 `showBilingual/showWordHighlight/autoScroll/autoTranslate/useVad/targetLang` 并持久化，日志 Tab 读 `Logger.history()`，工作量 Tab 显示真实 cue/word/speaker/duration/编码统计 |

顶栏：返回（HdsTabs 单 Tab 沉浸材质）、SubFabric / 稿件名、已保存句数、全局设置、导出。

**AV1 软件解码链路**：打开稿件时先用 `libffmpeg.so` 的 `probeMedia` 读容器/编码/分辨率；
若视频为 AV1，则用 `OH_AVCodec_GetCapabilityByCategory(..., HARDWARE)` 判断系统是否有
AV1 硬解。有则原片直接播放；没有则调用 `transcodeToH264`（FFmpeg `libdav1d` 解码 →
`libopenh264` 编码 H.264 + AAC MP4），代理写到项目目录 `proxy_av1_h264.mp4`，完成后
自动切到代理并保留原时间轴/字幕。转码在 async work 线程中执行，UI 显示百分比和进度条；
失败时保留原片并显示错误。模拟器 x86_64 已用 8 秒 AV1 样例验证：约 1.6–1.7s 生成代理，
系统 `Video` 可正常播放。详见 `MEDIA_PIPELINE.md` §2.4，截图见
`docs/preview/shot-lg-editor-av1-proxy.jpeg`。

### 4.5 字幕渲染与逐词高亮

编辑页的预览字幕已从占位文本换成按 ASS 文件渲染：

- **解析**（`platform/SubtitleImporter.ets`）：以「中文字幕」行作为一句的锚点，按时间重叠
  把英文事件归到同一句；英文事件里只有带 `{\c&H00FF00&...}word{\c...}` 的高亮事件才计入
  逐词时间，纯时间占位事件（没有高亮标签）直接忽略。`Cue.words` 保存的每个词文本、
  start/end 都来自源文件，不做按整行均分或其它推测；文件没有高亮就不亮。
- **持久化**：`AppStore` 的 `cues.json` 写入/读取 `words`；旧工程没有 `words` 时仍正常打开。
- **预览**：`Video` 组件负责播放和硬解码；`EditorSubtitleOverlay` 单独承载字幕层，
  中文行洋红 `#FF00FF`、英文行白色，当前词绿色 `#00FF00` + 洋红描边/光晕；
  用多组 `textShadow` 模拟 ASS 的黑色描边和阴影，不再铺黑底矩形。中文行按 ASS 的
  `\fade(...,300,300,300)` 做 300ms 淡入。
- **刷新频率**：`onUpdate` 只用于校准，播放期间 80ms 定时器按播放时钟插值来切词；
  时间码/进度条限制到 4Hz，字幕层做成独立子组件，避免每帧重建整页。
- **旧工程修复**：字幕 Tab 的「重新导入字幕」会重新选择源 ASS，按上述规则重建行和逐词时间；
  测试稿件 1117 已从 57,378 个逐词事件修复为 5,919 行，首行 10 个词的时间与文件完全一致。
- 与桌面安装版（libass-wasm）的差异：当前是原生 `Text` 近似 ASS 样式，字体走系统回退，
  尚未实现 `\k` 卡拉OK扫过、旋转/裁剪等完整 libass 特效；颜色、中英双行、逐词高亮与
  描边层级已对齐。截图见 `shot-lg-editor-subtitles.jpeg`。

## 5. 沉浸光感

三层，`ImmersiveBackground` 一个组件搞定：

1. `Image($r('app.media.home_glow'))` + `.blur(46)` + `.scale(1.18)`：
   900×1200 的径向光斑位图，模糊后放大补掉边缘黑边；
2. 纵向渐变遮罩：顶部 `#CC0A0E15` → 中部 `#1A0A0E15` → 底部 `#E60A0E15`，
   保证状态栏图标与正文都压得住，同时中间留出「光」；
3. 145° 斜向主色光带 + 底部 120vp 兜底渐变，制造方向感。

**必须同时开 `windowLayoutFullScreen`。** `EntryAbility` 里做三件事：

```ts
win.setWindowLayoutFullScreen(true);                 // 内容铺到系统栏下面
win.setWindowSystemBarProperties({                   // 系统栏本身透明
  statusBarColor: '#00000000', navigationBarColor: '#00000000',
  statusBarContentColor: '#FFFFFF', navigationBarContentColor: '#FFFFFF'
});
AppStorage.setOrCreate('statusBarHeight', topRect.height / density);   // 页面按它下移
```

少了任意一步，「光」就被截在内容矩形里，状态栏那条深色带会把画面切断。
背景层用 `expandSafeArea([SafeAreaType.SYSTEM], [TOP, BOTTOM])` 铺满，页面用
`@StorageProp('statusBarHeight')` 给内容留出顶部空间 —— 背景铺满、内容不遮挡。

## 6. 卡片与按钮

- **HeroSection**：左侧「花形时钟 + 问候语 + 日期」，右侧「新建稿件 / 导入字幕」两枚按钮
  **竖排**（宽度取 `dims.heroButtonWidth`，两枚等宽右对齐），整体是一行 Row。
- **GlassCard**（所有卡片的外壳）：`backgroundColor(#1FFFFFFF)` +
  `backgroundBlurStyle(dims.glassBlur)` + 1px 高光描边 + 阴影；按下 `scale 0.97`、
  悬停抬 `-2vp`，都用 `curves.springMotion`，抬起比按下慢（回弹感）。
  `tone` 支持 `plain / accent / danger` 三档底色。
- **GlowButton**：主色 alpha 影子做光晕，按下时光晕收紧（`radius 18 → 10`）
  并缩到 0.96，抬起弹回；`accent: true` 是页面唯一实心主操作。
- **项目页左上角 ☰ / 右上角 ＋**：都用 HdsTabs 单 Tab 悬浮栏，sm/md 44×44、lg 48×48；
  ☰ 用 `sys.symbol.line_3_horizontal`，＋ 用 `sys.symbol.plus`（主色），都不叠自绘玻璃底
  或圆形遮罩。`gradientMask` 设为透明，保留 HdsTabs 的 `IMMERSIVE / EXQUISITE` 沉浸光感；
  图标用系统 SymbolGlyph，光学中心由系统字形保证。
  **注意**：`systemMaterial` 只在 Navigation/NavDestination 标题栏或底部 `barPosition=End`
  的 TabBar 中生效；项目页内容区直接挂 `systemMaterial` 不生效。HdsTabs 单 Tab 本身仍可能
  留下轻微材质底，但不再叠加自定义灰色玻璃层。
- 状态管理：`@State`（按压/悬停/时间/选中）、`@Prop`（dims、summary、条目字段）、
  `@ObjectLink`（AppStore，`@Observed` 类）三类各司其职，没有全局可变单例参与渲染。

## 6.5 光感强度

**光感强度**（`HomePreferences` + `AppearancePanel`）：0 柔和 / 1 标准 / 2 明亮，写
`AppStorage['homeLightLevel']`，`ImmersiveBackground`（底图与光带透明度）、`GlassCard`（半透明底 alpha）
用 `@StorageProp` 订阅，改一档全页跟着变。
换算：`lightScale()` 返回 0.62 / 1.0 / 1.38，`scaleAlpha()` 只改 alpha 不换色，三档之间是连续过渡。

> 2026-11-17：按本次要求，设置页已删除「光感强度」卡片，`AppearancePanel` 不再挂载；
> 光感仍固定使用默认档 1（标准），背景与卡片的换算逻辑保留。

**智感握姿**：自绘导航条删除后，这部分交给 `HdsTabs` 的 `adaptToHandedness: true`
（官方按持握手调整浮动栏），不再自己做触摸落点推断。

## 6.6 设置页（两级）

一级顺序与电脑端一致，另按要求把「储存空间」加入一级并排在最后：

```
个性化 → 语音识别 → 翻译与术语 → 识别与校对 → 下载与登录 → 性能与调度 → 储存空间
```

| 场景 | 布局 |
| --- | --- |
| 手机（sm） | 一级分类单列成独立玻璃卡（图标 + 标题 + 说明 + 箭头），点击进入二级页；二级页左上角是 HdsTabs 单 Tab 沉浸材质返回键，标题在返回键右侧；一级页只保留「设置」标题，不显示浅色副标题和右上角图标 |
| md / lg | 系统设置式双栏：左栏常驻一级分类并高亮当前项，右栏同时显示二级内容；不靠单列页面切换 |
| 判定 | `HomeDims.twoPane`，只看当前断点（md/lg 双栏）；窗口被压回 sm 时自动退回手机单列。手机横屏进入 md/lg，设置页直接切双栏；断点由 `BreakpointObserver` 的 mediaquery 回调驱动，入口页 `onAreaChange` 只做即时校准 |

md/lg 左栏几何与项目页 lg 侧栏对齐：左右与底部各留 10vp、顶部伸到状态栏下（内部给标题补 10vp，
标题仍在安全区内），卡片高度与项目页侧栏同为 `[20,78][625,1900]`（平板 2880×1920）；圆角 + 玻璃底 + 投影。
lg 宽度复用 `projectsPanelWidth()`（21%，280–330vp），md 保持 288vp。分类列表内部可滚动，
矮屏（如折叠屏横屏）不会把最后一项裁掉。右栏不再叠加外层 top/bottom padding，滚动区域
一直铺到屏幕底部，由浮动 HdsTabs 覆盖；一级（手机）和二级 Scroll 的底部也只保留
`pagePaddingBottom`，不再为底栏预留 `bottomInset`。平板右栏直接按 `pageKey` 渲染，
不再走 `Navigation` 替换二级页，避免切分类时整页重建和黑底闪一下；切走再切回设置页时
`HdsTabs.cachedMaxCount` 保留右栏滚动位置与未保存草稿。

手机进入 / 返回二级页时，二级页作为整宽不透明遮罩做 300ms 平移动画：进入从右往左滑入，
返回从左往右滑出；一级页始终留在遮罩下方。遮罩内复用 `ImmersiveBackground`，与主页 /
项目页使用同一套光感背景，不再铺纯色底；状态栏区域与应用其他页保持同一背景。
`pageKey` 保留当前二级页内容，避免返回途中先变回默认页。md/lg 双栏不做整页转场。

二级内容：

| 一级 | 二级内容 |
| --- | --- |
| 个性化 | 背景材质（纯色 / 模糊流光 / 自定义图片）、流光色彩（主题 / 苔绿 / 海蓝 / 暮霞 / 自定义三色，带三色预览条）、流光效果（动态 / 静态）、流光速度（慢 / 标准 / 快）、明暗模式（浅色 / 深色 / 跟随系统，带浅色/深色预览卡）、界面动效（开启 / 减少动效）、莫奈取色预览（从当前背景提取 5 个主色，可应用到流光色彩）、毛玻璃压暗 / 模糊度 / 透明度三条滑杆、当前主题包、导入 / 导出主题包（占位）、自定义主题色、恢复默认 |
| 语音识别 | 当前后端、NPU 可用性、模型状态；VAD 开关；模型目录说明 |
| 翻译与术语 | 目标语言；方案与服务商（方案 chip / 导入 / 导出 / 名称 / DeepSeek / OpenAI / Anthropic / 自定义 / API 地址 / API Key 显示清除）；LLM 模型、采样温度；每批行数、上下文行数；按简体 / 繁體 / English 分组的术语表；LLM 提示词；保存后使用此方案、创建后自动翻译；取消 / 测试 LLM 连接 / 保存方案。方案存 `translation-schemes.json`，导出 JSON 不含 API Key |
| 识别与校对 | 逐句时间戳、逐句置信度、校对建议；端上尚未迁移的校对能力说明 |
| 下载与登录 | 模型状态、manifest 地址、开始下载/保存地址、下载进度；账号「未登录」说明 |
| 性能与调度 | NPU 接口与可用性、GPU（Vulkan）接口（推理待接入）、当前后端；NPU 自检与 Vulkan 接口自检。CPU 线程/CPU 后端已从设置中移除 |
| 储存空间 | 模型/项目/导出目录占用、本机已用/总空间、可用空间；重新计算 |

设置值直接写 `AppStore` 并 `saveSettings()`；会变的展示行和开关都做成 `@Component` 用 `@Prop`
同步。原因是 `@Builder` 的参数按值传递，状态变化不会刷新 Builder 内的 UI（对话框按压态
和设置开关都踩过这个坑）。

外观与体验集中在 `AppearancePrefs`，用 `PersistentStorage.persistProp` 持久化；
`ImmersiveBackground` 按背景材质、流光配色、动态/静态、流光速度和毛玻璃三条滑杆重绘。
自定义图片用 `DocumentViewPicker` 选择后复制到应用沙箱再交给 `Image` 渲染。

流光速度只改光斑呼吸周期：慢 24 秒、标准 14 秒、快 8 秒；改变后立即重建 timer。
莫奈取色用 `@ohos.effectKit` 的 `ColorPicker`：优先读当前自定义背景图，没有则读内置
`home_glow`；`getTopProportionColors(6)` 后过滤纯黑/纯白，最多保留 5 个，格式化为
`#RRGGBB`。点「应用到流光色彩」会写入前三个颜色、切到「自定义」配色并回到「模糊流光」。
浅色 / 深色 / 跟随系统已接通整页：`platform/ThemeManager.ets` 把 `AppearancePrefs.MODE`
解析成 `appearance.effectiveLight`，同时调用应用 `setColorMode`（HdsTabs IMMERSIVE 材质、
系统对话框、状态栏图标跟着换）并更新系统栏图标颜色。`HomeTokens` 改为按明暗返回两套
语义色（底色/玻璃/文本/主色/面板/阴影），所有视觉组件用 `@StorageProp(EFFECTIVE_LIGHT)`
订阅，切换时整页立即重绘。`PersistentStorage` 在 Index 页面加载后初始化，重启保持上次选择。
主题包文件导入导出仍未迁移。

识别硬件改为 `engine/RecognitionHardware.ets` 的统一接口：
CPU 后端已注释，不再作为可选硬件；`NpuHardware` 复用现有 NNRt 探测，
`VulkanHardware` 只预留 `prepare/release`，当前返回未接入。设置里不再出现 CPU 线程或
「CPU 模式」，主页设备标签也改为 NPU / 未加载；真正推理仍由 ParakeetEngine 的 NPU-only
策略执行。

## 6.7 模型页

模型页顶部固定，卡片放进 `WaterFlow`；列数按 `dims.bp`：
sm 1 列、md 2 列、lg 3 列，列/行间距用 `dims.gap` / `dims.rowGap`。
`FlowItem` 宽度 100%，`GlassCard` 卡片按实际内容高度自然错位，底部给 HdsTabs 留出
`bottomInset`。模型页顶部同时显示 NPU 与 Vulkan 状态；主体卡片：

| 卡片 | 内容 |
| --- | --- |
| Parakeet 0.6B · NPU | MindSpore Lite / NNRt；显示模型状态、推理后端、约 622 MB；「下载模型 / 重新下载」调用 `AppStore.downloadModel()`，带下载进度与「取消下载」 |
| Parakeet 0.6B · Vulkan | 与 NPU 共用同一套模型文件；显示模型文件状态和「接口已预留 · 推理待接入」；下载按钮只下载模型文件，Vulkan 推理仍待原生层 |
| Qwen ASR · Vulkan | `VulkanModelInterface` 接口桩；显示「接口预留 · 未安装」、Qwen ASR Vulkan 接口说明、适用场景「多语种 / 长音频」；只有「接口说明」，不伪造下载地址 |
| 对齐模型 · Vulkan | `VulkanModelInterface` 接口桩；显示「接口预留 · 未安装」、对齐模型 Vulkan 接口说明、输出「词级时间戳」；只有「接口说明」 |
| 手动导入模型 | 多选 `encoder.ms / decoder_joint.ms / vocab.txt / encoder.msw / manifest.json`，或导入 zip；复用 `AppStore.importModelFromFiles / importModelFromZip`，显示导入进度与状态 |
| 下载与部署 | 可编辑并保存 manifest 地址；「保存并下载」调用后端下载器，显示阶段、进度、速度与失败/取消原因；下载中第二个按钮变为「取消下载」；底部「清理模型文件」确认后删除模型目录 |
| 语音识别测试 | 选择音频/视频 → `HarmonyAudioDecoder.decodeToPcm16k` → `AppStore.transcribeSamples`；「模型加载测试」用空 PCM 触发同一条后端加载链路，结果只展示、不写稿件 |

下载器协议、断点续传与 SHA-256 校验见 [MODEL_DOWNLOAD.md](MODEL_DOWNLOAD.md)。
默认 HF 清单当前返回 HTTP 401（不可匿名读取），本地 HTTP 服务已跑通完整下载/取消/续传；
真实 `.ms` 模型仍需另外准备。

`VulkanModelInterface` 在 `engine/RecognitionHardware.ets`，与 `VulkanHardware` 共用
`prepare / release / interfaceNote` 契约，当前 `isAvailable()` 返回 false；
Qwen ASR 与对齐模型的权重、原生 Vulkan 推理尚未接入，因此不提供下载按钮。
模型下载地址仍由设置 → 下载与登录里的 manifest 地址给出；CPU 模型/后端不再出现在模型页。

## 7. 主页动作落到哪个分区

| 主页动作 | 结果 |
| --- | --- |
| 新建稿件 / 导入字幕 / 全部稿件 / 可编辑 / 需处理 / 最近稿件 | 切到「项目」分区 |
| 全局设置 | 切到「设置」分区（两级设置页，默认个性化） |
| 批量初稿 | 明确提示「端上尚未接入」，不静默失败 |

## 8. 验证状态

- **2026-11-16 横屏主页 / 底栏**：横屏主页改为 3/4 列错位栅格；删除 `HomeTabBar` 自绘胶囊，
  横竖屏共用同一个 `HdsTabs`，`barFloatingStyle.adaptToHandedness: true`。
  `hvigorw clean` + `assembleHap` 为 `BUILD SUCCESSFUL`；平板模拟器（2880×1920，landscape）验证
  4 列错位 `1+2+1 / 2+1+1 / 1+1+1+1`、TabBar 存在且主页/项目可切换；
  临时把列数切到 3，验证 `1+2 / 1+2 / 1+1+1 / 1+1+1` 的换行节奏后恢复 4 列。
  手机横屏与真实左右手跟随未验收：模拟器没有交互手硬件，`adaptToHandedness`
  保持默认居中，不能据此判断功能失效。
- **2026-11-16 项目页顶栏 / 抽屉调整**：项目页左上角改为 HdsTabs 单 Tab 悬浮栏
  （初版手机 48×48、平板 52×52，现已收至 44×44 / 48×48），`gradientMask` 透明，
  不叠自绘玻璃底或圆形遮罩；图标为 `sys.symbol.line_3_horizontal`。抽屉改为
  `backgroundEffect` 实时模糊，关闭键换成 `sys.symbol.xmark`；抽屉字号/图标比上一版略收
  （标题 +6、正文 +4、标签 +2，平板行高 72、列表图标 30、关闭键 50）。
  `hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机模拟器
  （1280×2832，sm）验证图标居中、按钮开抽屉、关闭键收起、行高与字号、模糊面板。
- **2026-11-16 新建文件夹对话框**：抽屉「新建文件夹」行增加按压缩放/高亮反馈；点击打开
  系统风格 `CustomDialog`：标题居中（手机 20 / 平板 24）并加粗，输入框改为透明底 + 单横线
  （聚焦时横线变主题色），不再使用整块圆角矩形；底部「取消」红色、「确定」主题色均为纯文字，
  去掉胶囊底色与描边，只在按压时给文字一层浅色圆角底，中间一条竖分隔线；确定后调用
  `addFolder(name)`，重名自动追加序号并立即刷新列表。按钮在触摸抬起时只触发一次，
  并加 `submitted` 保护，避免重复添加。
  手机模拟器（1280×2832，sm）验证默认空名添加（1→2→3，每次只加 1 个）、取消不新增、
  对话框布局与按钮文字样式；平板布局按同结构放大（420 宽、24 标题、18 正文）。
  自定义名称路径：模拟器系统输入法处于 BASIC_MODE，注入文字会拉起「小艺输入法」授权页，
  未代替用户接受；改以临时预置 `TextInput` 初始文本「测试文件夹」重装验证——文字替换灰色
  placeholder，确定后列表新增「测试文件夹」（2 个文件夹），随后已还原初值为空。
  真机键盘逐字输入仍需在已配置输入法的环境复验。
- **2026-11-17 文件夹层级 / 长按菜单 / 拖拽排序**：文件夹行加入与「新建文件夹」同款的
  0.97 按压反馈；单击进入层级，当前层级的行使用更亮的玻璃底、`folder_fill` 图标和主题色
  文字，抽屉副标题显示「当前：xxx」，再次单击同一文件夹退出（不再保留「返回全部文件夹」行）。
  长按 360ms 后行轻微放大 1.02、跟手上下拖动，并在文件夹下方弹出「重命名 / 删除文件夹」
  菜单；鼠标右键触发同一菜单。拖动跨过整行时其余行让位，松手写回 `projectFolders` 顺序；
  行宽收到 98% 并在外层留出居中余量，避免放大时被滚动区左右裁切。重命名复用同一个
  系统风格对话框（初始值为原名），删除后若删的是当前层级则退回全部。
  同批 UI 调整：项目页左上角按钮 44/48vp；抽屉关闭键改用 HdsTabs 单 Tab 沉浸材质
  （44/48vp）；抽屉朝内圆角取设备 `display.getRoundedCorner()`；平板抽屉宽度 307vp
  （原 460vp 的 2/3）；对话框「取消 / 确定」按压反馈改为在 `@Builder` 内直接读取
  `@State`（之前的按压值按参数传入，@Builder 不随状态刷新，所以看不到反馈），
  按压范围覆盖整个按钮半区，使用与按钮等高的药丸形浅色底。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机模拟器验证按压态、层级高亮、
  长按菜单、重命名（预置初始名「项目素材」，确认后列表与「当前」同步更新）、删除（3→2）、
  `uinput -T -g` 长按拖拽（默认文件夹从第 1 位移到第 3 位）、按钮按压高亮；
  平板模拟器验证 307vp 抽屉宽度、设备圆角、HdsTabs 关闭键与整体布局。
  鼠标右键菜单已实现但未在模拟器验收（鼠标不可见，注入右键未命中）；自定义文字输入仍受
  BASIC_MODE 输入法限制，真机键盘输入待复验。
- **2026-11-16 平板字号放大**：`HomeDims` 在平板（`tablet` / `2in1`）上对 md/lg 结果再乘
  1.2 / 1.05 的视觉放大量，实际约标题 25、正文 17、标签 14、辅助 13、卡片内边距 22–25、
  栏高 86；HdsTabs 底栏不参与。项目行图标、最近稿件行高、抽屉行高/图标/关闭键/面板宽度
  同步按平板放大。平板模拟器（2880×1920，landscape）截图核对主页 4 列、项目页、设置页、
  模型占位页和抽屉；手机 sm 不受影响。`hvigorw clean` + `assembleHap` 为 `BUILD SUCCESSFUL`；
  手机横屏与真实触控未验收。
  **已由 2026-11-17 断点收敛取代**：删除 `deviceInfo.deviceType` 与额外放大，
  sm/md/lg 三套 `HomeDims` 直接作为最终尺寸。
- **2026-11-16 抽屉默认侧**：抽屉默认从左侧打开；右边缘滑出只影响本次，关闭后
  左上角 ☰ 仍按默认/握姿侧打开；下半屏内容区连续 2 次右 1/3 后，☰ 才改从右侧打开。
  手机模拟器（1280×2832，sm）验证以上四条路径；底部 HdsTabs 栏与左上角 ☰ 不参与握姿采样。
  `hvigorw clean` + `assembleHap` 为 `BUILD SUCCESSFUL`。
  本机模拟器没有交互手硬件，`motion.on('holdingHandChanged')` 走 801/权限失败回退，
  因此本次验证的是触摸兜底路径；真实系统握姿上报仍需支持该能力的真机验收。
- **2026-11-17 设置页两级重建**：删除原有「光感强度」设置卡片（`AppearancePanel` 不再挂载，
  背景固定使用默认档 1）。设置一级按电脑端顺序：个性化 → 语音识别 → 翻译与术语 →
  识别与校对 → 下载与登录 → 性能与调度，并按要求把「储存空间」放在一级末尾。
  手机一级单列为独立卡片，点击进入二级页（HdsTabs 沉浸材质返回键，标题在返回键右侧；
  一级不显示浅色副标题，一级/二级都不再有右上角图标）；折叠屏 / 平板 / 2in1 用
  `twoPane`（只看窗口宽度）判定为系统设置式双栏，左栏高亮当前分类、右栏常驻二级内容；
  平板落在窄窗口时退回手机单列。平板左栏不再显示应用图标，只保留「设置」标题。
  手机进入二级页时二级页作为整宽遮罩从右滑入，返回时向右滑出；遮罩内复用
  `ImmersiveBackground`，背景与主页/项目页一致；`pageKey` 保留当前二级页内容，返回途中
  不会先闪回默认页。平板双栏不做整页转场。
  二级内容分别接入 AppStore 的 VAD、自动翻译、目标语言、翻译接口、NPU 优先、CPU 线程、
  模型下载与 NPU 自检；储存空间读取模型/项目/导出目录大小以及本机可用/总空间。
  会变的开关与数值行改成 `@Component + @Prop`，避免 `@Builder` 参数按值传递不刷新。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机模拟器（1280×2832，sm）
  截图核对一级卡片顺序、进入/返回中间帧（遮罩从右滑入、向右滑出、边缘无紫色竖条）、
  HdsTabs 返回键、标题位置、二级页背景与主页/项目页一致（无纯色底与中间黑条）、
  VAD 开关状态刷新、储存空间真实占用；主页底部的光感强度卡也已移除。
  手机横屏：入口页在 `onAreaChange` 中按新宽度重算断点，宽度进入 md/lg 后设置页自动
  切到平板双栏；本机模拟器的旋转键未被系统响应，宿主工具栏也无法可靠注入旋转，
  横屏切换未截到图，需在可旋转模拟器或真机复验。
  平板模拟器早前核对双栏、左栏选中切换、无浅色副标题；最后一轮 5557 连接中断，
  「平板窄窗口退回单列」和「左栏应用图标移除」未在该设备复验。
- **2026-11-17 个性化 / 外观与体验**：按电脑端「外观与体验」补齐设置项：
  背景材质（纯色 / 模糊流光 / 自定义图片）、流光色彩（主题 / 苔绿 / 海蓝 / 暮霞 / 自定义三色）、
  流光效果（动态 / 静态）、明暗模式、界面动效、毛玻璃压暗 / 模糊度 / 透明度、
  当前主题包、导入 / 导出主题包、自定义主题色、恢复默认。
  偏好放进 `AppearancePrefs` 并用 `PersistentStorage` 持久化；`ImmersiveBackground` 实际读取
  背景材质、配色、动效和三条滑杆重绘。自定义图片通过 `DocumentViewPicker` 选择并复制到沙箱；
  选择器已能拉起系统文件界面，但模拟器弹出「安全访问文件管理」提示，未代替用户接受。
  浅色/跟随系统、主题包文件和全局 UI 换色当时未迁移；后续 2026-11-17「浅色模式 /
  全应用主题」已接通整页明暗（见本文末尾条目），主题包文件仍待接入。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机模拟器截图核对完整条目、
  纯色/模糊流光切换、主题/苔绿配色切换、自定义图片入口与「未选择」状态、三条滑杆与主题包卡片；
  外观设置通过 `PersistentStorage` 跨重启保留（切到苔绿后重启仍为苔绿，随后已切回主题）。
  平板模拟器离线，外观页未在平板复验。
- **2026-11-17 个性化预览补全**：新增「流光色彩预览」三色条、「流光速度」（慢 24s /
  标准 14s / 快 8s，写入 `AppearancePrefs.SPEED` 并重建 `ImmersiveBackground` timer）、
  明暗模式预览卡（浅底 + 深色文字 / 深底 + 浅色文字）和「莫奈取色预览」。
  莫奈取色用 `@ohos.effectKit` 的 `ColorPicker`，优先读当前自定义背景图，否则读内置
  `home_glow`；取 `getTopProportionColors(6)` 过滤黑白后最多保留 5 色，可一键写入
  `COLOR1/2/3`、切到自定义配色和模糊流光。
  验证：平板模拟器 lg 截图核对三色条、速度分段、浅色预览卡
  （`shot-lg-appearance-preview-top.jpeg` / `shot-lg-appearance-light-preview.jpeg`）和莫奈 5 色卡
  （`shot-lg-monet-preview.jpeg`）；点「应用到流光色彩」出现成功 Toast。
  浅色/深色目前只驱动预览卡，全局页面仍保持深色玻璃主题；真实自定义图片取色与
  全局浅色主题未验收。
- **2026-11-17 识别硬件接口**：CPU 从识别硬件中注释掉，设置页不再出现 CPU 线程或
  「CPU 模式」；新增 `engine/RecognitionHardware.ets`，`NpuHardware` 复用现有 NNRt 探测，
  `VulkanHardware` 只预留 `prepare/release`（返回未接入）。语音识别与性能页展示
  NPU / GPU（Vulkan）接口状态，性能页保留 NPU 自检与 Vulkan 接口自检（仅提示接口预留）；
  主页设备标签改为 NPU / 未加载。验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；
  手机模拟器截图核对两页无 CPU 项、Vulkan 接口说明、NPU 不可用状态；模拟器无 NPU，
  真实 Vulkan/NPU 推理仍需原生层接入与真机验收。平板离线未复验。
- **2026-11-17 模型页**：模型分区从占位页改为真实页面，只保留 Parakeet NPU 与
  Parakeet Vulkan 两条下载卡，并新增手动导入卡。NPU/Vulkan 卡显示模型状态、后端、
  约 622 MB 与下载按钮；Vulkan 卡明确「模型文件与 NPU 共用、推理接口待接入」。
  手动导入卡复用 `importModelFromFiles / importModelFromZip`，支持多选模型文件与 zip。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机模拟器截图核对三张卡片、
  NPU 不可用状态、Vulkan 接口说明、下载与导入按钮；未实际触发 622 MB 下载，
  手动导入的文件选择器也因系统安全访问提示未完成选择。平板离线未复验。
- **2026-11-17 模型页 Vulkan 扩展**：新增 `VulkanModelInterface` 接口桩，并在模型页加入
  Qwen ASR · Vulkan 与对齐模型 · Vulkan 两张接口卡；顶部同时显示 NPU / Vulkan 状态。
  两张卡只展示「接口预留 · 未安装」、接口说明与适用场景/输出（Qwen 多语种长音频，
  对齐模型词级时间戳），不伪造模型下载地址。验证：平板 lg 截图核对顶部状态
  （`shot-lg-models-vulkan-top.jpeg`）、Qwen ASR 与对齐模型卡
  （`shot-lg-models-vulkan-ext.jpeg`）；手机 sm 核对顶部双状态和卡片滚动布局。
  真实 Qwen ASR / 对齐权重及 Vulkan 推理仍未接入。
- **2026-11-17 模型页瀑布流**：`ModelsPane` 从整页 `Scroll + Column` 改为固定页头 +
  `WaterFlow`；列数只按 sm / md / lg：sm 1 列、md 2 列、lg 3 列。5 张卡片
  （Parakeet NPU / Vulkan、Qwen ASR Vulkan、对齐模型 Vulkan、手动导入）作为
  `FlowItem`，列/行间距用 `dims.gap` / `rowGap`，底部给 HdsTabs 留 `bottomInset`。
  `infoRow` 的 value 改为 `layoutWeight(1) + 右对齐 + Ellipsis`，窄卡片里长接口说明
  不再溢出。验证：平板 lg 截图核对 3 列错位（`shot-lg-models-waterfall.jpeg`）；
  手机 sm 截图核对 1 列（`shot-sm-models-waterfall.jpeg`）；md 2 列共用同一分支，
  未单独强制截图。
- **2026-11-17 主页瀑布流**：`HomePane` 不再按横竖屏切两套布局，改为固定 `HeroSection` +
  `WaterFlow`。列数只按 sm / md / lg：sm 2 列、md 3 列、lg 4 列；
  卡片为处理中 + 6 张快捷动作 + 最近稿件，`FlowItem` 宽度 100%，列/行间距用
  `dims.gap` / `dims.rowGap`。旧的 `QuickGrid`、`RecentFlex` 和横屏 `GridRow` 不再挂载。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机 sm 截图核对 2 列瀑布流、
  8 张卡片全部出现、Hero 固定顶部、底部不压 HdsTabs；平板 lg 核对 4 列；强制 md
  核对 3 列（见下方断点收敛记录）。
  翻译接口文本输入与下载地址输入仍受模拟器 BASIC_MODE 输入法限制，真机键盘输入待复验。
- **2026-11-17 首页底栏自动收起 / 展开**：`HomePane` 的 `WaterFlow.onDidScroll` 按方向
  通知入口页：向上滚累计超过 48vp 收起 HdsTabs，向下滚累计超过 32vp 展开，
  `onReachStart` 也展开；`Index` 把 `barHeight` 在 0 / 56 之间切换，并同步 `bottomInset`。
  切换 Tab、从首页动作跳到项目/设置时强制展开，避免底栏隐藏后无法导航。
  验证：临时在瀑布流末尾加 900vp 测试占位制造滚动，手机模拟器截图核对上滑后底栏消失、
  下滑后恢复；测试占位已在最终构建中移除。首页没有稿件时内容不足一屏，不会触发滚动收起；
  有稿件后最近稿件卡会撑高内容。平板离线未复验。
- **2026-11-17 项目页瀑布流**：`ProjectsPane` 的稿件列表改为固定顶栏 + `WaterFlow`。
  列数只按 sm / md / lg：sm 2 列、md 3 列、lg 4 列；
  卡片改用 `GlassCard`，含字幕条数徽标、标题（最多两行）、媒体文件名、更新时间与语言对，
  标题换行自然形成高低差，WaterFlow 按最短列填充。点击仍走 `store.openProject()`，
  手机左右 28vp 抽屉热区保留，lg 只保留左侧。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；临时向 `store.projects` 注入
  6 条演示稿件（仅内存，最终构建已移除），手机 sm 截图核对 2 列瀑布流与长短卡错位
  （`shot-projects-waterfall.jpeg`）；平板 lg 截图核对 4 列；把 lg 阈值临时抬到 2000vp
  强制 md 后截图核对 3 列（`shot-md-projects.jpeg`）。早期 sm 内 1/2 列的 360vp 阈值已移除。
  最终构建为无稿件空态（`shot-projects-waterfall-empty.jpeg`），左边缘热区实测仍能拉开抽屉。
- **2026-11-17 新建稿件页**：项目页右上角新增 HdsTabs 单 Tab「＋」按钮，材质/尺寸与
  左上角 ☰ 一致；点击后 `NewProjectPane` 从右侧滑入，返回键同样由 HdsTabs 绘制。
  页面含可选名称、可选媒体（mp4/mov/mkv/m4a/mp3/wav/flac/aac/ogg）、创建按钮；
  名称与媒体至少一个时才可创建，媒体在创建时才复制进沙箱。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；手机模拟器截图核对
  右上角 ＋ 按钮（`shot-projects-add-button.jpeg`）、滑入后的空表单
  （`shot-new-project.jpeg`）、返回键回到瀑布流。模拟器 BASIC_MODE 无法稳定键盘输入，
  临时把名称默认值设为 `Test Project` 后点「创建稿件」，截图核对页面关闭、Toast
  「已创建」、`projects` 立即出现新卡片（`shot-new-project-created.jpeg`）；
  验证后默认值已还原为空，测试稿件已从应用数据删除。系统文件选择器未完成选择，
  真实键盘输入与媒体导入流程待真机复验。平板离线未复验。
- **2026-11-17 稿件编辑页**：新增全屏 `EditorPage`，点击项目卡 / 抽屉稿件进入，顶部返回
  回项目页。布局用 `GridRow` + `GridCol`，按 `dims.bp` 切换：
  lg 左 8/12（视频上 + 时间轴下）+ 右 4/12 右边栏；sm/md 全部 12/12，按
  视频 → 时间轴 → 右边栏纵向堆叠并外层滚动。视频区含预览占位、播放/上一帧/下一帧、
  进度/音量滑杆；时间轴含备注输入、停留、发送、刻度尺、横向片段条与波形；
  右边栏含字幕/角色/设置/日志/工作量 Tab、筛选、显示模式和字幕卡列表。
  验证：平板 lg 截图核对三板块（`shot-lg-editor.jpeg`）；手机 sm 截图核对纵向堆叠与
  页面滚动（`shot-sm-editor.jpeg` / `shot-sm-editor-sidebar.jpeg`）；返回按钮回到项目页。
  临时注入 1 条演示稿件（仅内存，最终构建已移除）。折叠屏 md 走与 sm 相同的堆叠分支，
  未单独截图验收；播放器与字幕引擎仍是功能区占位。
- **2026-11-17 lg 项目页侧栏**：`dims.bp === Bp.LG` 时侧栏固定左侧，并改为与项目页
  同级的浮动玻璃面板：四边 10vp 留白、四角圆角、去掉深色遮罩；项目页与底部 HdsTabs
  让出「面板 + 留白 + 14vp 间距」右移，按剩余宽度重算 `contentDims`（断点重算 +
  `compact 0.9` 收内边距/间距/圆角），底栏保留并一起右移。sm/md 仍是覆盖式抽屉。
  右侧边缘热区在 lg 不挂载；左边缘热区提到入口页根 Stack，避免被 HdsTabs 的横向
  切页手势吃掉。
  验证：平板模拟器（2880×1920 @2x ≈ 1440×960vp，lg）截图核对关闭时 4 列瀑布流
  （`shot-tablet-projects.jpeg`）；打开后侧栏固定在左、项目页右移缩窄、卡片与间距轻缩、
  底栏仍可见（`shot-tablet-projects-sidebar.jpeg`）；空态
  （`shot-tablet-projects-sidebar-empty.jpeg`）；左边缘横滑能打开，右侧横滑不会打开
  反向抽屉（模拟器会弹系统侧边 Dock，属系统手势）；切换 Tab 自动收起；点 ✕ 后恢复
  全宽。动画中间帧截图可见侧栏滑入与项目页同步右移
  （`shot-tablet-projects-sidebar-mid.jpeg`）；手机覆盖式抽屉回归通过。
- **2026-11-17 lg 侧栏关闭 / 文件夹菜单样式**：lg 侧栏展开时，项目页左上角 ☰ 再点一次
  直接 `closeDrawer()`，不会重复打开；侧栏 ✕ 仍先 `closeMenu()` 再收起侧栏。
  「重命名 / 删除文件夹」菜单去掉不透明底色，改为 `backgroundEffect` 实时模糊（radius 28）
  + 半透明高光渐变；两个菜单项左右各留 4vp，按压/悬停遮罩为 14vp 圆角矩形。
  验证：平板 lg 截图核对项目页 ☰ 收起（`shot-lg-sidebar-menu-toggle-close.jpeg`）、
  ✕ 收起（`shot-lg-sidebar-x-close.jpeg`）、菜单实时模糊
  （`shot-lg-folder-menu.jpeg`）、「重命名」按压圆角遮罩
  （`shot-lg-folder-menu-pressed.jpeg`），并成功打开重命名对话框
  （`shot-lg-folder-rename.jpeg`）。删除项与重命名共用同一 `menuItem`，样式一致；
  未实际删除默认文件夹。
- **2026-11-17 sm/md 侧栏收窄**：`projectsPanelWidth` 在 sm/md 先把原 78% 宽度
  夹到 264–460vp，再乘 2/3，得到约 52%、176–307vp；lg 的 21%/280–330vp 不变。
  文件夹菜单宽度同步限制为 `panelWidth - 16`，避免菜单越过面板右缘；sm 行内图标
  22vp、间距 8vp、左右 padding 8vp、字号 body+2，使「默认文件夹」「新建文件夹」
  能完整显示。验证：手机 366vp（sm）截图核对侧栏约 190vp（原约 286vp），
  文件夹名完整、菜单不出界（`shot-sm-drawer-narrow.jpeg` /
  `shot-sm-drawer-menu-narrow.jpeg`）。折叠屏 md 共用同一公式，面板最大约 307vp
  （原 460vp），本次未单独强制 md 截图。
- **2026-11-17 全量 sm/md/lg 断点收敛**：`BreakpointObserver` 统一用
  `@ohos.mediaquery` 的 `MediaQueryListener`（`UIContext.getMediaQuery()` 是未废弃入口）
  监听 `(width<600vp)` / `(600–840vp)` / `(>=840vp)`；`HomeBreakpoints` 删除
  `deviceInfo.deviceType` 与“平板额外放大”，只保留 sm/md/lg 三套 `HomeDims`。
  组件里的 `widthVp >= 840`、`>560`、`360/800` 等布局分支全部改成 `bp === Bp.LG` /
  `Bp.SM` / `Bp.MD`；HomePane 与 ProjectsPane 列数统一为 sm 2 / md 3 / lg 4；
  HeroSection、QuickCards、RecentCard、AppearancePanel、SettingsPane、ProjectsDrawer、
  NewProjectPane 也全部改为断点判断。lg 侧栏、底栏显隐、左右热区同样由 `bp` 决定。
  验证：手机 366vp（sm）截图核对主页 2 列（`shot-sm-home.jpeg`）、项目 2 列
  （`shot-sm-projects.jpeg`）；平板 1440vp（lg）核对主页 4 列（`shot-lg-home.jpeg`）、
  项目 4 列、lg 同级侧栏（`shot-lg-projects-sidebar.jpeg`）；临时把 lg 阈值抬到 2000vp
  在平板上强制 md，截图核对主页 3 列（`shot-md-home.jpeg`）、项目 3 列
  （`shot-md-projects.jpeg`）、设置双栏（`shot-md-settings.jpeg`）和覆盖式抽屉
  （`shot-md-drawer.jpeg`），验证后阈值已恢复 840vp。最终 `hvigorw clean` +
  `assembleHap` 为 `BUILD SUCCESSFUL`，手机与平板均安装。真实折叠屏设备不可用，
  md 用强制阈值验证，未在真实折叠屏上截图。
- **已完成且已验证**：`hvigorw clean` 后完整重建 `BUILD SUCCESSFUL`（41 tasks / 38 executed，
  `CompileArkTS` 无 error）；`ui/home` 下 12 个文件零告警。
  唯一保留的告警是 `EntryAbility` 里 `setWindowSystemBarProperties` 的
  「API is unavailable to 2in1」—— 2in1 没有系统状态栏，代码已用
  `deviceInfo.deviceType === '2in1'` 在运行时跳过，该提示来自 API 的平台标签，属预期。
- **真机（DevEco 模拟器）实测**：Mate 90 Pro（1280×2832 @560dpi ≈ 366vp，sm 断点）装包并跑通。
  四个分区逐一切换验证过，手机端水平滑动不切页（`.scrollable(false)` 生效）。
  本轮另外验证：横屏胶囊在左三分之一点右半屏会切到右三分之一（
  `shot-tab-landscape.jpeg` / `shot-tab-landscape-right.jpeg`）；
  项目页抽屉的三种呼出（☰ / 左边缘 / 右边缘）与「新建文件夹」都通
  （`shot-projects.jpeg` / `shot-projects-drawer.jpeg` / `shot-projects-drawer-right.jpeg` /
  `shot-projects-landscape-drawer.jpeg`）。实测推翻的「只在纸上成立」的实现：
  1. `backgroundBlurStyle` 的材质**跟随系统深浅色**，浅色模式下卡片被染白、白字看不见
     → 全部改为 `backgroundBlurStyle(dims.glassBlur, { colorMode: ThemeColorMode.DARK })`；
  2. `Shape + Path().commands()` 的坐标按 **px** 落、`Line().startPoint()` 按 **vp** 落，
     两者混用会变成「33vp 的迷你花 + 96vp 的长指针」→ 花形时钟改用 Canvas，
     所有坐标由 `dims.flowerSize` 现算（`HeroSection.drawClock()`）；
  3. 卡片内层 `Column().height('100%')` + `Blank()` 在 GridCol 自动高度下会把卡片拉成整屏高
     → 去掉 `height('100%')`，让卡片按内容 + `cardMinHeight` 撑开；
  4. **`@Builder` 不适合收回调参数**：把 `tap: () => void` 传进 @Builder，真机上点上去毫无反应
     （同页其它按钮正常）→ 改成只传档位值、闭包写在 Builder 内部；
  5. **`@Builder` 的字符串参数不随状态刷新**：档位提示文字一直是首帧的值
     → 提示文案改在 Builder 内部用 `this.xxx` 现算；
  6. **在 `onTouch(Down)` 里改 AppStorage 会吞掉本次点击**：手指抬起前触发重建，
     onClick 不再派发 → 握姿采样挪到 `onClick(event)` 里；
  7. **`TabBarSymbol` 只能传对象字面量**：它只是纯类型声明，`new TabBarSymbol()` 编译能过，
     真机直接 `ReferenceError: TabBarSymbol is not defined`（崩在首帧）；
  8. **`sys.symbol.*` 名字错了编译期就会报**（`Unknown resource name 'cube'`）：
     可用的名字要查 `sdk/.../ets-loader/sysResource.js`，模型分区最后用了 `memory_module`；
  9. **系统材质跟随深色模式**：不强制深色时，`IMMERSIVE` 材质与玻璃卡在浅色系统上会被染白
     → 在 `EntryAbility.onCreate` 调 `getApplicationContext().setColorMode(COLOR_MODE_DARK)`；
  10. **抽屉不能放进 TabContent**：为了收起标签栏去改 `barHeight`，HdsTabs 会把整个内容区
      缩放（约 0.93），抽屉跟着缩、右边缘还会离屏 —— 所以抽屉提到根 Stack，
      改 `barHeight` 只影响背后被遮住的内容；
  11. **系统占掉最边缘的返回手势**：从 x≈2vp 起手横滑会触发系统返回（应用直接退到桌面），
      热区虽做到 28vp，可用起手点仍在 ~22vp 之后；这是平台约束，不是实现问题；
  12. **`@Builder` 的参数同样不能传「数量」**：文件夹计数当参数传时新建后一直显示 1，
      改成在 Builder 内部读 `this.folders.length`。
- 装包前置（模拟器）：工程原生层只有 `libs/arm64-v8a/libmslite.so`，而模拟器是 x86_64，
  直接装报 `code:9568347 Abi 不匹配`。SDK 的 sysroot 里两套 ABI 都有
  `libmindspore_lite_ndk.so`，所以 `entry/build-profile.json5` 的
  `externalNativeOptions.abiFilters` 补了 `x86_64`，CMake 的 ABI→sysroot 映射原本就支持。
  另外 `module.json5` 的 EntryAbility 加了 `"orientation": "auto_rotation"`（手机横屏 / 平板横竖切换）。
- **未验证**：真实折叠屏设备上的实际渲染（md 已用临时阈值在平板模拟器强制验证，
  但未在折叠设备上跑过）；平板 lg（1440vp）已在平板模拟器验证。横竖屏切换依赖模拟器
  旋转，真实传感器方向未验证。模糊背景在中低端机的帧率；触感（按压反馈目前只有视觉）。
- **2026-11-17 卡片→编辑页 Navigation 转场**：编辑页从 `bindContentCover` +
  `geometryTransition` 改为 `Navigation(NavPathStack)` + `customNavContentTransition`。
  点击卡片时 `getRectangleById` 取卡片窗口矩形，`getComponentSnapshot().get` 截成
  `PixelMap`；根 Stack 顶层替身外层 `translate`、内层 `scale`（中心 0,0），
  `animateTo` 同步驱动 `scale / translate / borderRadius / opacity`，从卡片铺满窗口后
  淡出、编辑页淡入；关闭时截 `editor_root` 整页快照反向缩回卡片。编辑页
  `navContentOpacity` 在替身就绪前置 0，无快照时直接切换；系统返回与页面返回共用
  `closeEditor()`。`project_card_<id>` 只作为快照定位 id，不再挂 `geometryTransition`。
  验证：平板 1440vp（lg）最终构建 `BUILD SUCCESSFUL`、项目页 1 个持久稿件，开合中间帧
  `shot-lg-editor-open-proxy.jpeg` / `shot-lg-editor-close-proxy.jpeg`，落定
  `shot-lg-editor.jpeg`；手机 366vp（sm）在含临时演示稿件的构建上核对开合中间帧
  `shot-sm-editor-open-proxy.jpeg` / `shot-sm-editor-close-proxy.jpeg` 与纵向布局。
  最终构建已移除 `TEMP_GEOMETRY_SEED`，手机端没有可打开的稿件，且模拟器文本输入仍不可用，
  因此最终构建未在手机上重跑开合动画（动画代码与已验证构建一致）；手机最终构建仅核对
  空项目页与主页空态。折叠屏 md 未单独跑该转场。
- **2026-11-17 新建稿件四板块 + 导入已有字幕**：`NewProjectPane` 重写为
  `WaterFlow` 四板块（预览 / 输入与配置 / 处理进度 / 生成设置），列数只按
  mediaquery 的 sm 1 列、md 2 列、lg 3 列。新增 `platform/SubtitleImporter.ets`：
  `.srt/.vtt` 走 common 的 `readAsCues`，`.ass` 解析 Dialogue 并按 Main/Sub 拆原文/译文，
  `.json` 兼容项目 cue 导出，`.zip` 项目包读取 `subtitle.srt/ass` + `translation.json`
  + `project.json`；视频在创建时才复制进沙箱，cue 通过 `saveCurrent()` 落盘。
  `@Builder` 的徽标 / 元信息 / 素材行改成在 Builder 内部读状态，避免参数首帧缓存导致
  「已就绪 / 可创建」和标题不刷新。
  验证：平板 1440vp 四板块三列（`shot-lg-new-project.jpeg`），临时种子数据核对已选字幕
  状态（`shot-lg-new-project-import.jpeg`）；手机 366vp 单列（`shot-sm-new-project.jpeg`）。
  系统 picker 能打开，实际选择 Downloads 里的 8.4 MB ASS 后解析出 57,378 条并建出
  带媒体的项目，说明解析 / 建稿 / 保存链路可用；随后已删除验证用的无媒体重复稿件。
  项目包导入已实现但手边没有可选的 zip 项目包，未做端到端验证；「创建初稿」仍只保留入口；
  模拟器文本输入不可用，名称输入未复验。
- **2026-11-17 页头 / 设置侧栏 / 页面到底**：lg 项目页侧栏展开时，页头左侧
  「☰ + 项目」用 `translate(-leftInset)` 反向抵消入口页的整体右移，停在原位被侧栏盖住；
  右侧计数 / ＋ 和稿件卡片仍在右移后的内容区。设置双栏左栏复用项目页侧栏几何
  （10vp 外边距、满高、lg `projectsPanelWidth()`），分类列表内部可滚；右栏取消外层
  bottom padding，滚动区域铺到屏幕底部。主页 / 项目页 / 模型页 / 新建页 / 设置二级页
  都不再为底栏预留 `bottomInset`，内容延伸到屏幕底部并由浮动 HdsTabs 覆盖。
  验证：平板 lg 侧栏打开 (``shot-lg-projects-drawer-header.jpeg``)、关闭
  (`shot-lg-projects-header.jpeg`)；设置双栏 (`shot-lg-settings-fullheight.jpeg`)；
  主页 / 模型页底部 (`shot-lg-home-fullheight.jpeg` / `shot-lg-models-fullheight.jpeg`)；
  手机设置与新建页底部 (`shot-sm-new-project.jpeg`)。md 折叠屏没有真实设备，双栏左栏
  宽 288vp 未单独强制截图。
- **2026-11-17 字幕渲染 / 逐词高亮**：`SubtitleImporter` 改为按 ASS 文件渲染：以中文
  `中文字幕` 行为锚点合并英文事件，只采信带 `{\c&H00FF00&}word{\c}` 的高亮事件作为
  `Cue.words`，没有高亮标签的占位事件不生成逐词时间；不再按整行均分伪造时间。
  `AppStore` 的 cues.json 读写 words。编辑页接入真实 `Video` 播放器 + 独立
  `EditorSubtitleOverlay`：中文洋红、英文白色、当前词绿色 + 洋红描边、黑色描边用
  textShadow 模拟，去掉黑底；中文行按 `\fade(...,300,300,300)` 淡入；80ms ticker 切词、
  进度 4Hz 更新。旧工程可用字幕 Tab 的「重新导入字幕」重建；测试稿件 1117 从 57,378 个
  逐词事件修复为 5,919 行，首行 10 个词的时间与文件一致（例如 `the@2.87-2.99`）。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；平板 1440vp 播放到 00:02 时
  中文、英文和绿色当前词同时显示，无黑框（`shot-lg-editor-subtitles.jpeg`）。
  与桌面 libass 仍有字体回退和 \k 扫过等差异；`\k`/旋转/裁剪等完整特效待后续。
- **2026-11-17 编辑页数据接线 / 右边栏双栏**：时间轴改为 `List + LazyForEach` 渲染真实
  `Cue`，卡片词时间刻度来自 `Cue.words`；右侧字幕列表同样接真实 cue（中文/英文、说话人、
  时长、词数，点击 seek）。人物列表从 `[Name]` 标签统计 29 人；设置 Tab 接双行/逐词/自动滚动、
  自动翻译、VAD、目标语言并 `saveSettings()`；日志 Tab 读 `Logger.history()`；工作量 Tab 显示
  真实 cue/word/speaker/duration。右边栏 Tab 改回顶部；新增双栏按钮，同时显示字幕列表 +
  人物列表（对应桌面版 split roles），其他 Tab 自动收起双栏。验证：平板 1440vp 截图
  `shot-lg-editor-split-roles.jpeg`，双栏和顶部 Tab 正常。
- **2026-11-17 视频解码 / FFmpeg 双 ABI**：自编 FFmpeg 8.1（x86_64 + arm64-v8a）+ dav1d
  1.5.1 + OpenH264 2.6.0，`libffmpeg.so` NAPI 提供 probe/AV1 软解代理。编辑页优先系统解码；
  AV1 无系统硬解时自动生成 H.264 代理并显示进度。模拟器 x86_64 用 8 秒 AV1 样例验证：
  代理约 1.6–1.7s 生成、8 秒时长、系统 `Video` 正常播放；H.264 原片也正常。发现并修复视频区
  黑色占位 `Column` 覆盖 `Video` 原生 surface 的问题。FFmpeg 内置 `av1` 解码器无软解，
  必须用 dav1d，详见 `MEDIA_PIPELINE.md` §2.4。
- **2026-11-17 项目卡菜单 / 滚轮防切页**：项目页稿件卡片支持长按/鼠标右键菜单（重命名 /
  详细信息 / 删除）；删除需二次确认并清理工程目录，保留媒体文件。底部 HdsTabs 设
  `.scrollable(false)`，鼠标滚轮不再切换主页/项目/模型/设置。验证：平板长按弹出菜单、
  重命名对话框、详细信息、删除确认均正常；滚轮在项目页保持当前页签。
- **2026-11-17 字幕行内编辑**：字幕列表卡片单击 seek，双击（鼠标双击/触屏双击）进入编辑；
  卡片内出现中文/译文与 English/原文两个 `TextArea`，取消不写盘，保存后更新
  `Cue.targetText/sourceText`、`edited=true` 并 `saveCurrent()` 写入 cues.json。
  修改英文原文会清空该行旧的 `words`，避免 ASS 逐词时间与文本错位。编辑态用
  `CueDataSource.notifyChange(index)` 只刷新当前卡片。验证：平板双击首行进入编辑，
  保存后卡片显示「✓ 已校对」并把 toast「字幕已保存」。
- **2026-11-17 浅色模式 / 全应用主题**：新增 `platform/ThemeManager.ets`，把
  `AppearancePrefs.MODE`（light / dark / system）解析成 `appearance.effectiveLight`，
  同步调用应用 `setColorMode` 并更新状态栏/导航条图标颜色；`HomeTokens` 改为双主题
  语义令牌（base/glass/text/primary/innerFill/cardFill/panelFill/shadow/mediaPlaceholder 等），
  主页、项目页、抽屉、新建页、模型页、设置页、编辑页全部按 `@StorageProp(EFFECTIVE_LIGHT)`
  重绘。修复 PersistentStorage 过早初始化导致“切换到浅色但重启回深色”的问题：持久化初始化
  移到 Index 页面加载后。验证：平板模拟器浅色主页/项目/模型/设置/编辑页/新建页/抽屉/
  卡片菜单均正常，系统栏图标随明暗变深/变浅；浅色下重启保持浅色，切回深色正常，
  「跟随系统」按系统实际明暗解析。
  截图：`shot-lg-light-home.jpeg`、`shot-lg-light-settings.jpeg`、`shot-lg-light-projects.jpeg`、
  `shot-lg-light-editor.jpeg`、`shot-lg-light-models.jpeg`。
- **2026-11-17 底部阴影带**：`ImmersiveBackground` 底部 120vp 的压暗兜底渐变会在底栏高度形成
  一条横跨全屏的深色带；已删除该层。主 `HdsTabs` 的 `gradientMask` 也从系统渐变遮罩改为
  `Color.Transparent`，与其余页面一致。验证：平板模拟器浅色主页、模型页底部恢复为均匀背景，
  浮动胶囊与图标不受影响；截图 `shot-lg-no-bottom-shadow.jpeg`。
- **2026-11-17 模型 / 语音识别接线 + 下载联调**：模型页的下载、取消、清理、语音识别测试、
  模型加载测试、NPU 自检全部接到 `AppStore` / `ModelDownloader` / `ParakeetEngine`，
  不再只是提示文案。新增「下载与部署」卡（manifest 地址编辑、保存并下载、下载中取消、
  进度/速度/失败原因）与「语音识别测试」卡（选音频/视频 → 16 kHz PCM → `transcribeSamples`；
  「模型加载测试」用空 PCM 走同一条加载链路）。`AppStore.clearModelFiles()` 先卸载引擎再
  清空模型目录，UI 需二次确认。
  下载器修复两个实测问题：① `JSON.parse` 得到的普通对象没有 `RemoteManifest.urlOf()` /
  `totalBytes`，导致「urlOf is not callable」；现按 `RemoteFile` 重建。② 续传用
  `fs.writeSync` 会从 filePointer=0 覆盖，SHA 校验失败；改用
  `createRandomAccessFileSync` + `setFilePointer(resumeAt)`；服务端忽略 Range 时按
  200 状态码从 0 重下。
  验证：平板模拟器经 `hdc rport` 连本机 HTTP 服务，12 MB 测试文件完成进度/速度/SHA-256/
  部署；取消后 `.part` 保留，重试从 2.0 MB 续传通过；强制服务端忽略 Range 时日志出现
  「从 0 重新下载」并最终校验通过。默认 HF 清单返回 HTTP 401（不可匿名读取），
  真实 `.ms` 权重、真实 622 MB 下载和进程被杀续传仍未验证。
  截图：`shot-lg-models-backend.jpeg`、`shot-lg-models-downloading.jpeg`、
  `shot-lg-models-cancelled.jpeg`。
- **2026-11-17 创建初稿 UI / 失败清理**：生成方式切到「创建初稿」时，标题说明、素材来源、
  提示、按钮与进度第 3 步同步变为「语音识别」；`stageStep` 改为只传 index、在 Builder 内部
  按 `this.mode` 现算文案，修复 `@Builder` 参数按值传递导致文案不刷新。选视频后预览显示
  文件名/时长/「视频识别初稿」，只保留视频行；创建时复制媒体 → `createProject()` →
  `runRecognition()` → 保存 cues，失败删除空项目**并删除本次复制的媒体**，避免 100 MB+
  孤儿文件。导入与初稿创建成功后 320ms 自动进入编辑页。
  验证：平板模拟器选择 `1117.mp4` 后创建，进度到 34% 正确显示
  「失败：缺少模型文件…」并给出 toast；返回项目页仍为 2 个稿件，测试用的重复项目已清理；
  无 NPU/模型时不会伪造字幕。截图：`shot-lg-new-project-draft.jpeg`、
  `shot-lg-new-project-draft-failed.jpeg`。
- **2026-11-17 设置二级页 Navigation 重写**：`SettingsPane` 新增 `NavPathStack`，用
  `Navigation(this.settingsStack) + NavigationMode.Stack + navDestination` 承载二级页，
  删除原来手写的 `TransitionEffect.translate`。窄屏根页是设置分类列表，点分类
  `pushPath('settings-detail')`；返回按钮/系统返回走 `pop()`，由系统提供从右滑入、向右滑出。
  宽屏右栏同样用 Navigation，但**不使用展开动画**：第一次 `pushPath(..., false)`、后续
  `replacePath(..., false)`、点回底层分类 `pop(false)`；系统返回在 `onBackPressed` 中
  `pop(false)` 并恢复 `pageKey/selected`。`NavDestination` 使用 `HomeTokens.base` 作为
  不透明底色；`@Watch(dims)` 在转屏/断点切换时同步底层页与左栏高亮。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；平板 lg 双栏点击分类后直接切换，
  无展开/替换中间帧（`shot-lg-settings-nav.jpeg`），左栏常驻、高亮跟随；临时把 lg 强制为
  单栏后验证带默认动画的 push/pop 与返回列表（`shot-sm-settings-nav.jpeg` /
  `shot-sm-settings-nav-back.jpeg`），验证后已恢复 `twoPane = true`。
- **2026-11-17 平板项目侧栏字号**：`ProjectsDrawer` 的 lg 字号单独收一档：
  标题 `titleSize + 3`（27）、列表 `bodySize + 2`（18）、辅助 `labelSize + 1`（14），
  原为 +6 / +4 / +2；sm/md 保持原字号。验证：平板 lg 侧栏截图核对
  `shot-lg-projects-sidebar-font.jpeg`，行高与图标不变，项目名/文件夹名不再显得过大。
- **2026-11-17 媒体编解码切换**：设置 → 性能与调度新增「媒体编解码」卡，可在
  `AVCodec + FFmpeg`（默认）与 `全流程 FFmpeg` 之间切换，写入
  `PersistentStorage('media.codecMode')`。默认模式优先系统 AVCodec 硬解，FFmpeg 只在
  AV1 无硬解时生成代理；全流程 FFmpeg 让 AV1 跳过系统硬解、强制 FFmpeg 软件链路。
  编辑页 `prepareMedia` 已读取该偏好，代理状态显示「AV1 · 硬件解码 / AV1 · FFmpeg（按设置）/
  AV1 · 软件代理」。设置页同时展示视频预览、音频提取、AV1 代理、当前设备 AV1 硬解能力、
  视频压制/导出的实际后端，并明确“全流程 FFmpeg”不会替换系统 Video 播放器，
  AVCodec 硬编导出尚未接入。
  评估矩阵与 `OH_VideoDecoder → NativeWindow/Canvas → OH_VideoEncoder` 路线见
  `MEDIA_PIPELINE.md` §5。
  验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；平板 lg 截图核对两种模式、说明文案
  与卡片布局（`shot-lg-codec-settings.jpeg` / `shot-lg-codec-ffmpeg.jpeg`）；切到全流程
  FFmpeg 后强制停止再启动，选项仍保持，切回 AVCodec 正常。模拟器无 AV1 硬解，硬解/硬编
  实际功耗差异与 AVCodec 导出路线未验收。
- **2026-11-17 新建页系统返回**：去掉上一版自写的侧滑 `PanGesture`；改由入口页
  `Index.onBackPress()` 配合 `NewProjectGate`：新建页打开且当前在项目分区时，系统返回
  请求项目页 `closeCreate()`，并消费返回事件，不再退出应用。`NewProjectPane` 通过
  `onBusyChange` 上报复制媒体/识别状态，忙碌时返回被消费但不关闭页面。
  验证：平板模拟器打开新建页后按系统返回键，成功回到项目瀑布流
  （`shot-lg-new-project-back.jpeg`）；中段横向滑动不再触发关闭；忙碌状态未实际制造。
- **2026-11-17 项目包导入性能 / 加载动画**：修复 `.zip` 项目包导入卡顿与手机闪退：
  - 解压前用 `zlib.getOriginalSize()` 检查解压后体积；压缩包上限 32 MB、解压后上限 64 MB，
    超限直接提示，不再把大包/高压缩比包丢给 zlib。
  - `copyUri` 改为异步 `fs.copyFile`；解压使用并行策略；临时目录用 `deleteTree` 彻底清理。
  - 文本读取改用系统 `util.TextDecoder`，替换逐字节自定义 UTF-8 解码（8 MB ASS 从约 6 s
    降到毫秒级）。
  - ASS 解析缓存 Format 字段索引，并把英文/中文事件配对从全量 O(n²) 改为 3 秒时间窗 +
    二分定位；58,450 个事件不再扫描全部 5,919 个锚点。
  - 「创建项目 / 创建并识别」按钮在 `busy` 时显示 `LoadingProgress` 小环 + “处理中…”，
    进度面板显示“正在读取项目包…”。
  验证：用 8.4 MB ASS 打成 914 KB 项目包导入，解压约 31–47 ms、完整读取 2.1–2.2 s
  （修复前 7.5–9.2 s），5919 条字幕成功进入待创建状态，无闪退。
  截图：`shot-lg-zip-import-loading.jpeg`、`shot-lg-zip-imported.jpeg`。
  带 `translation.json` 的完整项目包与真机低内存场景未单独复验。
- **2026-11-17 项目页双向侧滑 / 编辑器人物**：
  - 项目页内容区加左右横滑 `PanGesture`：向右滑打开侧栏、向左滑打开另一侧
    （lg 由入口页统一落到左侧常驻栏）；不再依赖系统占用的最边缘，平板也能双向呼出。
  - 编辑器右边栏的「字幕 / 人物 / 设置 / 日志 / 工作量」改用 `HdsTabs` + `TabContent`，
    顶部固定 38vp 标签栏；split 按钮移入字幕页头，双栏仍为字幕 + 人物。
  - 人物列表改两列 `Grid`，首个卡片是「添加人物」；人物卡片去掉首字母图标，改为
    11vp 圆形色点（颜色随人物/字幕），点击标注当前句、长按打开名字/颜色编辑弹窗。
    双栏人物列表使用 `speakerTab(true)`，卡片单列，同样有添加按钮和色点。
  - 新增 `SpeakerRecord` 持久化到项目 `speakers.json`；Cue 增加 `speaker/speakerColor`
    并写入 `cues.json`。人物颜色同步用于时间轴/字幕卡的说话人标签。
  - 校验：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；平板截图核对 HdsTabs 标签
    （`shot-lg-editor-hdstabs.jpeg`）、两列人物 + 添加按钮（`shot-lg-editor-speakers-grid.jpeg`）、
    双栏单列人物（`shot-lg-editor-speakers-split.jpeg`）、长按编辑弹窗
    （`shot-lg-speaker-edit.jpeg`）、项目页双向滑出侧栏
    （`shot-lg-projects-swipe-sidebar.jpeg`）。点击 eggchan 标注首句、长按编辑、添加/删除人物
    均实际触发；验证后重新导入 ASS 恢复 1117 的 5919 条字幕，首句仍为 Wemmbu。
  - 数据安全：`cues.json / speakers.json / projects.json` 改为 `.tmp + fsync + rename` 原子写；
    之前强杀写入曾留下不可读的 cues.json，已通过「重新导入字幕」恢复并重启复验 5919 条。
- **2026-11-17 字幕颜色归因 / 修复**：预览字幕此前中英文都不对，根因有三处：
  - `EditorSubtitleOverlay.trackColor()` 把同一个 `speakerColor` 同时用于中文和英文，英文
    未唱色被说话人颜色污染；逐词底色也用了 `speakerColor`。
  - ASS 解析只提取了逐词文本，没有保存中文行内联 `\c`、`[V4+ Styles]` 的
    `Main/Sub PrimaryColour`，以及英文高亮色；界面只能用 `EditorOptions` 默认值。
  - 人物色来自固定调色板哈希，而不是字幕文件里的中文颜色。
  修复：
  - `SubtitleImporter` 解析 `[V4+ Styles]` 的 `PrimaryColour` 和每行 `{\c&HBBGGRR&}`；
    `Cue` 新增 `targetColor / sourceColor / wordColor` 并写入 `cues.json`。
  - 中文预览色 = `cue.speakerColor || cue.targetColor`；英文未唱色 = `cue.sourceColor`
    （ASS `Sub` 样式色）；逐词高亮色 = `cue.wordColor`（ASS 内联高亮色）。
  - 人物列表颜色改为优先采用字幕里的中文颜色；Wemmbu 为洋红、eggchan 橙、
    Spoke 蓝等，不再使用调色板哈希。
  - `EditorSubtitleOverlay` 不再把 `speakerColor` 用于英文轨道。
  验证：平板 1117 项目播放到 00:03，中文字幕洋红、英文白色、当前词
  “world's”绿色；人物列表颜色与 ASS 一致（`shot-lg-editor-subtitle-colors.jpeg` /
  `shot-lg-editor-speaker-colors.jpeg`）。重导入后仍为 5919 条。
- **2026-11-18 项目卡片一镜到底**：按华为开发者官网「共享元素转场（一镜到底）」与
  `geometryTransition` API 参考重写卡片打开动画。官网对三种方案的建议是：同容器直接变形
  适合开销小的简单场景；`NodeController` 适合视频等创建开销大的组件；`geometryTransition`
  适合新建节点开销小、需要跨容器共享元素的场景。编辑器是本地轻量组件，采用官网的
  `bindContentCover` + `geometryTransition` + `animateTo` 模态方案：
  - `modalTransition: ModalTransition.NONE`，避免系统默认全屏转场与共享元素打架；
  - 卡片与全屏编辑页绑定同一个 `project_cover_<id>`，`follow: true`；
  - 打开和关闭都在 `animateTo` 内翻转 `editorOpen`；侧滑/系统返回在 `onWillDismiss` 里
    调用同一个关闭方法，保证缩回卡片；
  - 动画结束 `onFinish` 清空共享 id，避免快速连点/状态变化误触发；卡片和编辑页不能嵌套
    同一个 id。
  旧的 `Navigation.customNavContentTransition`、卡片/编辑页截图替身与 `NavPathStack` 动画
  已移除。验证：平板模拟器点击 1117 卡片，300 ms 中间帧为从卡片位置展开的圆角编辑页，
  600 ms 落到全屏；系统返回时先缩回卡片再显示项目瀑布流。截图：
  `shot-lg-editor-cover-mid.jpeg`、`shot-lg-editor-cover.jpeg`、
  `shot-lg-editor-cover-close.jpeg`。首页最近稿件/抽屉进入不做共享元素，直接显示全屏。
- **2026-11-18 项目侧栏常驻 / 打开稿件保留 / 新建页与设置边栏高度**：
  - 设置 → 个性化新增「项目页 → 侧边栏常驻展开」开关，写入 `settings.json`；
    仅 lg 宽屏生效。开启后进入项目页自动展开、隐藏 ✕、禁用横滑收起，
    离开项目页仍按标签切换逻辑收起。
  - `openProject()` 不再强制 `drawerOpen = false`；从网格或侧栏打开稿件，
    编辑页关闭后侧栏保持原展开状态。窄屏进入新建页仍临时收起覆盖式抽屉，
    取消后恢复；lg 新建页只占右侧内容区，侧栏保持展开。
  - 新建稿件页去掉第二张 `ImmersiveBackground`，项目列表在转场中淡出；
    页面本身保持透明，背景直接沿用全局沉浸光感（不再叠灰色玻璃卡）；
    「创建项目」禁用态改为实色并移除底部蓝色光边。
  - 设置双栏左栏去掉顶部 10vp 外边距并给标题补回内部留白，
    卡片高度与项目页侧栏一致（平板 `[20,78][625,1900]`）；
    平板右栏不再用 Navigation 替换分类，切分类不重建、无黑底闪烁；
    切页签保留滚动位置与未保存草稿。
  - 验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；平板模拟器
    进入项目页自动展开、无关闭键；打开 1117 后系统返回，侧栏仍展开；
    新建页保留侧栏且背景与全局光感连续；设置左栏与项目侧栏顶底对齐。
    截图：`shot-lg-projects-pinned.jpeg`、`shot-lg-new-project-transparent.jpeg`、
    `shot-lg-settings-equal-height.jpeg`。md/sm 覆盖式抽屉与真机握姿未复验。
- **2026-11-18 波形转 WAV / 时间轴块内波形**：
  - 根因：系统 AVTranscoder 在 API 12 只支持 MP4/AAC，`CFT_WAV` 会直接报
    “The Parameter fileFormat is invalid”；旧 `MediaDecoder.transcodeToWav` 因此
    对非 WAV 媒体必然失败。
  - 新增 `libffmpeg.so` 的 `decodeAudioToWav(input, output)` NAPI：用
    libavformat/libavcodec/libswresample 把任意容器的音轨解成 16 kHz / 单声道 /
    S16LE WAV。`MediaDecoder` 改用该接口，波形提取与语音识别共用同一条 WAV 通路。
  - 时间轴改为「波形嵌入字幕块」：每个块只画本句时间段的波形，块宽按句长
    （宽屏 64 px/s、窄屏 52 px/s，再乘时间轴缩放）变化；波形和字幕块一起横向
    滚动/缩放，不再有独立波形条或固定背景。块内中文/英文各占一半、都只显示一行、
    字号加大；逐词进度线移到中英之间；块背景改成低模糊玻璃。
  - 放大时时间轴面板高度不变；平板被选中的块最长 2/3 板块宽度，手机 sm 约 94%
    （基本占满时间轴），其它块水平推开；放大块置顶并向上覆盖备注/刻度区，
    其它字幕块的垂直绝对位置不变。块内中文缩小上移，
    蓝线与英文在放大时淡出；放大块内是独立逐词编辑器：波形 + 蓝色词区间高亮 + 纯文字词标签
    + 灰色虚线 + 长提手（拖动编辑 start/end），去掉白色遮罩/词块高亮。
    放大块背景用大半径模糊 + 高不透明度压暗遮住下方的备注/刻度，波形是子节点，
    保持原始亮度与清晰度；浅色模式下遮罩改为浅色玻璃（`#D9F7FAFF`），
    普通块用淡白玻璃，不再出现整块发黑。
  - 双击未居中的块直接展开，不再先 seek 跳转；单击 seek 延迟 440ms 给双击让路。
    双击已展开块顶部可收起，点击其它字幕块也会先保存并收起；收起时若逐词有未落盘改动会先保存。
    展开后用 `ScrollAlign.AUTO` 只做最小滚动，保证右边界不超出时间轴区域。
    逐词拖动改为波形条整体 `PanGesture`（不再依赖小提手命中），波形区域点击不触发父块收起。
  - 时间轴支持双指水平缩放：`PinchGesture` 挂在字幕 List 上（与横向滚动并行），
    `timelineZoom` 限制 0.65–2.4；块宽与块内波形同比缩放，LazyForEach key 带缩放档位
    以确保宽度刷新；展开逐词编辑时暂停时间轴缩放，避免编辑器被重建。
    手机 sm 布局时间轴内容上边距 16vp、下边距 6vp，整体继续下移并收紧底部玻璃遮罩留白。
  - 验证：`hvigorw ... assembleHap` 为 `BUILD SUCCESSFUL`；1117 编辑器波形正常
    渲染（`shot-lg-editor-waveform-ffmpeg.jpeg`），块内布局与字号
    （`shot-lg-timeline-block-layout.jpeg`），放大置顶/2-3 宽度（`shot-lg-timeline-expanded.jpeg`），
    拖动逐词边界保持展开（`shot-lg-timeline-worddrag.jpeg`）。真实长视频/多音轨/无音轨媒体
    未逐个复验。
- **2026-11-18 编辑页侧栏 HdsTabs 材质**：右侧「字幕/人物/设置/日志/工作量」保留
  HdsTabs，但去掉单个 tab 的 `accentGlass` 蓝底，改用 `barFloatingStyle` +
  `IMMERSIVE` 材质；双栏 split 按钮从自绘 `Stack` 改为单 Tab HdsTabs 沉浸材质按钮，
  激活时只换图标颜色，不再铺主题色底。验证：`hvigorw ... assembleHap` 为
  `BUILD SUCCESSFUL`，平板截图核对（`shot-lg-editor-sidebar-hdstabs.jpeg`）。
- **2026-11-20 编辑页人物栏展开 / 字幕卡右边界**：
  - 展开动画期间的深色矩形来自 split 面板的 `Navigation` 根页/NavBar，以及分栏
    `translate({ x: 18 })` 露出的底色。改为直接渲染 `speakerTab(true)`，
    分隔线与人物栏只做 opacity 过渡，不再横向位移。
  - 分栏展开时，字幕卡左侧 106vp 时间/操作列宽度收为 0（clip + fade），
    主内容不再 `translate(-106)`，字幕卡/文字右边界直接顶到分隔线，
    不再在人物栏左侧留出 106vp 空白。
  - 验证：slim HAP（26 MB，不含 1.085 GB `encoder.ms`）安装成功；
    1117 项目 5919 条字幕、示例稿件 0 条、引用的 1117.mp4 均保留；
    分栏展开截图核对右边界（`shot-lg-editor-split-right.jpeg`）。
- **2026-11-20 时间轴回滚到标尺修改前**：
  - 连续时间画布和动态刻度尝试导致时间轴显示异常，已回滚到修改时间标尺之前的版本：
    顶部恢复固定 `00:00–00:25` 刻度尺，字幕卡片仍用横向 `List + LazyForEach`，
    不再显示逐块时间标签或连续画布。
  - 时间轴刻度与首块左边距从 8vp 收到 0，和备注区时间码左对齐，首块更靠左；
    横向滚动和双指缩放仍保留。
  - 验证：slim HAP 构建成功；固定刻度、首块位置与播放栏在断开前的平板截图核对
    （`docs/preview/shot-lg-editor-final-ui.jpeg`）。1117 项目 5919 条字幕保留。
- **2026-11-20 播放栏原生图标 / 双栏按钮**：
  - 播放栏的上一帧、播放/暂停、下一帧、音量改用 `SymbolGlyph` 系统扁平图标
    `backward_end_fill`、`play_fill`/`pause_fill`、`forward_end_fill`、
    `speaker_wave_2_fill`，保留原有点击行为和无障碍文案。
  - 双栏切换按钮改为 `Stack` 居中图标；取消 `Bp.SM` 隐藏，手机比例下也显示。
  - 验证：平板截图核对图标居中与播放/暂停切换
    （`docs/preview/shot-lg-editor-final-ui.jpeg`、`shot-lg-player-icons.jpeg`）。
    手机 SM 布局只完成代码改动，模拟器在复验前断开，未取得手机比例截图。
- **2026-11-21 preview 0.1.0 导出**：
  - `versionName` 设为 `0.1.0`、`versionCode` 设为 `1000001`（高于原 `1.0.0` 的
    `1000000`，便于覆盖安装）。HarmonyOS 的 `versionName` schema 只接受数字/点，
    文件名保留 `preview` 标识。
  - 导出 `SubFabric_preview_0.1.0.hap`，26,052,810 字节；slim 包不含模型，
    `encoder.ms` 已恢复在 `rawfile/parakeet/`。已安装到 MatePad 模拟器并打开，
    1117 项目 5919 条字幕保留。
- **仍为接口预留**：Qwen ASR · Vulkan、对齐模型 · Vulkan 以及 Parakeet 的 Vulkan 推理没有
  权重与原生实现，模型页只展示「接口预留 · 未安装」，不提供假下载地址；
  真实 Parakeet `.ms` + NPU 的识别、初稿成功路径仍待真机与模型文件。
