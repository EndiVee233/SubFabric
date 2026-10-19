# Windows UWP 控件补充 · 设计空壳

UWP 下按钮已经全部是磁贴（2026-10-19 实装）。这个空壳补齐**剩下的、还没有磁贴语言的控件**：输入、选择、范围、列表/卡片、反馈、浮层，以及导航、时间轴、颜色和焦点/滚动条。所有交互都可点，不接生产 editor。

打开：直接双击 `index.html`，或 `file:///D:/SubFabric-main/prototypes/uwp-controls/index.html`。无构建、无依赖。

## 1. 控件清单与设计

| 类别 | 生产里的控件 | 设计 | 动效 |
| --- | --- | --- | --- |
| 文本/搜索/密码/数字 | `input`、`textarea`、`#sf-search`、`#st-*` | 32px 高、2px 直角、1px 中性描边；悬停 2% 面光；错误 2px danger + 说明；禁用 .55 | focus **四边 2px 等宽**（1px border + 1px inset ring）**120ms**；不做底边加粗 |
| 原生/自定义下拉 | `.sf-choice-toggle`、`.sf-choice-menu`、`.sf-rate-menu`、`.fp-panel` | 触发器仍是磁贴；菜单 2px、surface-2、12px 阴影；选项左侧留白 + 右侧 check | flyout **120ms** `translateY(-4px)+scale(.985)`；方向键/Esc |
| 复选/单选 | `input[type=checkbox/radio]` | 18px 方框/圆；accent 填充；indeterminate 短横；禁用 | 勾画 **120ms**、圆点 **140ms**、按下 `scale(.92)` |
| 开关 | 自定义 `role=switch` | 40×20 轨道、12×10 拇指、accent 打开 | 拇指 **140ms**；焦点 2px 外框 |
| 范围/进度 | `input[type=range]`、`#sf-seek`、`#sf-volume` | 4px 轨道、12×24 的 2px 滑块；accent 填充；时间/百分比输出 | 悬停滑块 +2px 宽；拖动高 ×1.08；不放大成圆形 |
| 文件/拖放 | `input[type=file]`、下载/字幕导入区 | 1px 虚线；悬停/dragover 变 accent；浏览按钮是磁贴 | 只换边框/底色，不位移 |
| 导航 | `.sf-nav a` | 3px 左侧 accent 竖条；选中 surface-2 中性底（不是整块蓝）；图标 accent | hover 面光 120ms；active 竖条立即出现；焦点 2px |
| 页签/分段 | `.ptab`、`.st-tab`、`.log-subtab`、`.sf-settings-segments` | 同一 surface；选中 2px accent 底线 + accent-soft；1px 分隔 | 底线 **120ms**；按钮沿用磁贴按压 |
| 卡片/列表行 | `.proj-card`、`.cue-card`、`.sf-pack`、`.sm-model` | Reveal 面光 + 1px 描边；选中 3px 左竖条 + accent-soft；封面/角色色保留 | 面光跟随指针；卡片可按压（磁贴）；行不 tilt |
| 折叠 | `.sf-settings-details`、`details` | 1px 分隔；箭头只旋转；内容淡入 | 箭头 **180ms**；内容 180ms；不用整块高度跳动 |
| 进度 | `.sf-progress`、任务卡进度 | 4px 轨道；确定态 width；不确定 32% 块；暂停灰、失败红 | 不确定 **1.4s** 循环；确定态 300ms linear |
| 徽标/状态 | `.badge`、`.pc-st`、`.st-hw` | 2px、22px 高；圆点 + 文字；蓝/绿/红/琥珀 | 运行态圆点 **1.4s** 呼吸 |
| Tooltip | 自定义 `data-tip` | surface-2、1px、10px；出现在上方；`?` / 重试 | 250ms 延迟 + **120ms** 淡入/3px 位移 |
| Toast/Notice | `#sf-notice`、任务提示 | 右下、2px、左侧 3px accent 条；4s 自动收起 | **180ms** 8px 滑入；关闭 160ms |
| Dialog | `.modal-surface`、`.rn-box`、`.pick-box`、`.fix-box`、`.ctd-box` | scrim .45；2px 表面；标题/说明/两个磁贴按钮 | **150ms** `scale(.96→1)` + 淡入 |
| Drawer | `.st-drawer`、方案抽屉 | 右侧 380px；2px；字段/开关/磁贴动作 | **220ms** `translateX`；scrim 180ms |
| 颜色 | `.sscp`（完整取色器） | 色板、Hex、色相；色板也是磁贴；UWP 固定蓝只做展示 | flyout 120ms；色板按压；hue 滑块 |
| 时间轴 | `#tl-canvas`、字幕块/播放头 | 4px 轨道、2px 播放头、1px accent 选中框；块不放大 | 拖拽/点击 seek；悬停 1px 外框 |
| 滚动条/焦点 | 全局 | 8px 细滚动条；`:focus-visible` 2px accent、offset 1 | 无动画；键盘可见 |

按钮/磁贴仍沿用 `--uwp-face/--uwp-edge` 的 Reveal 与 105/420ms 3D 按压；**输入、复选、开关、滑块不做 3D**，避免“输入框像按钮”。

## 2. 设计令牌

| 令牌 | 深色 | 浅色 |
| --- | --- | --- |
| `--bg` / `--surface` | `#1F1F1F` / `#2B2B2B` | `#F3F3F3` / `#FFFFFF` |
| `--surface-2` / `--surface-3` | `#333333` / `#3A3A3A` | `#EDEDED` / `#E5E5E5` |
| `--text` / `--muted` | `#F3F3F3` / `#C5C5C5` | `#202020` / `#606060` |
| `--line` / `--line-soft` | `#666666` / `#4D4D4D` | `#B8B8B8` / `#D6D6D6` |
| `--accent` / hover / press | `#0078D7` / `#106EBE` / `#005A9E` | 同左 |
| `--accent-soft` | `#153A5A` | `#CCE4F7` |
| Reveal 面光 | 白 12% | 黑 6% |
| 描边 | 2% 底 + edge×50% | 2% 底 + edge×26% |

通用：2px 直角、1px 中性描边、Segoe UI、控件 32px 高；Flyout 才用 12px 阴影；无外发光、无大圆角、无 spring 弹跳。

## 3. 动效表

- 100ms：磁贴按下；`scale(.99)` + 2px 3D 下沉。
- 120ms：勾选、页签底线、flyout、tooltip。
- 140ms：单选圆点、开关拇指、滑块 hover。
- 120ms：输入焦点四边等宽（border + inset ring）；150ms：Dialog。
- 180ms：Toast、折叠内容、页面/卡片进出。
- 220ms：Drawer。
- 400ms：磁贴回弹；不确定进度 1.4s 循环；Badge 呼吸 1.4s。
- 全部只动 opacity / transform / background / border；`prefers-reduced-motion` 和右上角“减少动效”都关闭。

## 4. 空壳结构

左侧导航 7 节：概览 / 输入 / 选择 / 范围 / 列表与卡片 / 反馈 / 浮层。顶栏切深/浅色与减少动效；所有控件带标注和 spec 行。

实测（Edge headless 1440×1000，2026-10-19）：
- 9 个输入表面、56 个 `.uwp-tile`、76 个 `.reveal`；整页 4427px。
- 深/浅色 token 生效（`#F3F3F3/#202020`）；菜单 focus 到第一项、选择 “Parakeet TDT 0.6B” 回填；Dialog 打开；Toast “已保存”；色板选择回填 `#498205`；页面异常 0。
- 截图：`preview.png`（顶部）、`preview-full.png`（整页）、`preview-light.png`、`preview-states.png`。

## 5. 已知边界

- **2026-10-19 第三轮已接入生产**：`editor/css/studio.css` 末端 UWP 层与 `editor/js/{studio,timeline,studio-progress,project,color-picker,font-picker}.js` 已按本清单实装；本目录保留为设计评审与验收参考。
- 颜色选择器生产版保留完整 `.sscp` 双栏（色板/HSV/Hex/RGB），没有搬空壳的紧凑版。
- 时间轴生产版是真实 canvas（波形/缩放/拖拽），UWP 分支只改几何与配色；本原型仍是缩略 mock。
- Dialog/Drawer 的焦点陷阱、scrim 点击与 tab 循环仍是既有实现的边界；本主题只统一视觉与 150/220ms 动效。
- 方案抽屉生产结构是内联 `.st-scheme-inline` 的 220ms 展开，不是右侧 380px 的独立 `.st-drawer`。
- Tooltip 生产仍用原生 `title`，没有引入 `data-tip` 自定义浮层；取色器/字体浮层已做 2px 与视口夹取。
- 新建项目文件行是常驻 1px 虚线视觉，实际拖放仍落在视频区；没有接管每行的 drop。
- 菜单项/抽屉/对话框里的按钮不强制 3D；点按走磁贴 hover/按压。

## 6. 生产落点

- 控件层：`editor/css/studio.css` 的 A–S 段（输入/选择/范围/集合/反馈/浮层/级联收口）。
- 交互：`studio.js` 的 `syncUwpTiles`、`uwpMotionOff`、`syncUwpRanges`、`uwpTileExit`；`timeline.js` 的 `this.uwp` 分支；`project.js` 的 badges/列表/无障碍；`color-picker.js` 色板选中；`font-picker.js` 视口夹取。
- 回归：`tests/uwp-theme-test.mjs` 与完整 `node tests/run-all.mjs`；截图在 `_tmp/uwp-final`（不入库）。
