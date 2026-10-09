# 视频区字幕就地编辑 —— 实现方案

- 目标版本：SubFabric `APP_VERSION = 2.1.13` → 发版 **`2.1.14`**（2026-10-09）
- 版本号口径：**按仓库惯例只递增补丁位**（远端最新 `v2.1.13`；`2.1.8` 加微光特效、`2.1.9` 加词生长也都是补丁位）。
  中途一度写成 `2.2.0`/`2.2.1`（擅自跳小版本），已改回 `2.1.14`。
- 状态：**已实现并端到端验证**（见文末「九、落地结果」；发版号 `2.1.14`）

---

## 一、目标（来自两张参考图）

**图1 · 就地快改**
在视频画面上双击某条字幕 → 贴着该行弹出一个小输入框：内含该行文字 + 只读的角色标签前缀（`[Wemmbu]`），下方两行提示「Enter 保存 / Esc 取消」「双击字幕可编辑整句」。Enter 保存、Esc 取消。

**图2 · 文本编辑弹窗**
居中深色小窗，标题「编辑字幕文本（仅修改 Text 字段，不改变时间与样式）」，内容为：
- `行预览:` 该行纯文本
- 一个多行文本框（预填可编辑正文）
- 提示：`仅替换 ASS 的 Text 字段；行首角色/颜色前缀会自动保留，不应在编辑框中重复输入。可在此输入 ASS 内联标签。`
- 按钮：`取消` / `保存`

**两图的共同语义**：只改**文字**，不动时间、不动样式。

---

## 二、现状盘点（已在代码中确认）

| 项 | 现状 | 位置 |
|---|---|---|
| 视频区 DOM | `#video-stage` > `<video id="video" controls>` + `#srt-overlay` + `#stage-hint` | `index.html:51-61` |
| SRT 渲染 | HTML 层，`.ov-cue > .ov-line`，按 currentTime 重建 innerHTML；`fitToVideo()` 已算出"去黑边"后的精确画面矩形 | `js/overlay.js` |
| ASS 渲染 | libass-wasm（SubtitlesOctopus）画在 canvas；`passThroughClicks()` 把 canvas/canvasParent 的 pointer-events 强制 none | `js/assplayer.js:219` |
| 指针穿透 | `#srt-overlay`、libass canvas 均 `pointer-events:none` → 视频区点击一律落到 `<video>` | `css/style.css:185,194` |
| 视频区鼠标语义 | 单击 = 播放/暂停（延迟 240ms 排除双击）；双击 = 阻止默认（禁原生全屏）+ 清掉单击定时器 | `js/main.js:66-102` |
| SRT 数据 | `state.srtCues = [{id,start,end,lines[]}]`，lines 可含行内 `<i>/<b>` | `js/main.js:1398` |
| ASS 数据 | `state.kar.rows = [{start,end,zh,en,color,speaker,no,...}]`，zh/en 为 sentence `{style,start,end,text,words,events[]}` | `js/main.js:1415` / `js/karaoke.js` |
| 提交链路 | `panel.onApply({item,start,end,dur,text})` → SRT 改 `cue.lines`；ASS 走 `applyAssRow()` → 落 `assDoc`；随后 `rebuildItemsAndLanes()` + `Projects.scheduleSave()` | `js/main.js:2546` |
| 实时预览链路 | `editPreview` 草稿 + `renderEditPreview()` → `doc.previewMulti(entries)` → `assPlayer.updateNow(track)`（只预览不落盘）；`clearEditPreview()` 还原真实轨 | `js/main.js:2410-2520` |
| 前缀保护 | `buildAnchorText(prevEventText, tag+text)` = 规范化角色标签间距 + 继承行首 `{\c..&}` 色标 + `\n`→`\N`；列表行内编辑用 `_editTag` 把 `[角色]` 藏进只读前缀、提交补回 | `js/karaoke.js:454` / `js/editor.js:1027,1240` |
| 模态框范式 | `#xxx-overlay > .rn-box.modal-surface > .rn-title.modal-drag-handle + 内容 + .rn-actions(取消/保存)`；在 `bindModalDrags()` 注册即得拖动 | `index.html:623-671` / `js/modal.js:80` |
| 快捷键冲突 | 全局 keydown 派发前有 `typing` 判定，`<input>/<textarea>/contenteditable` 内不抢键（Space 播放、Ctrl+Enter 都不误触） | `js/main.js:3769-3776` |
| 撤销 | **全仓无 undo/redo 栈** → 本次以"Esc 取消 / 单次提交"为安全边界，不引入撤销栈 | — |

**关键结论**：视频区的「双击」目前是空位，可以直接挂就地编辑；且提交/预览/前缀保护三条链路都已有现成实现，**不需要新增写盘路径**。

---

## 三、交互设计（提议）

### 3.1 就地快改（图1）

- **触发**：视频画面内**双击**某条字幕。
- **命中**：以"当前播放时刻可见的行"为候选（画面上看得见才可能被双击），再按点击的**纵向位置**区分中/英行（中文在上、英文在下）。
- **弹出**：浮动小框贴在该行上方（上方空间不足则下方），水平居中于画面并 clamp 在画面内；首行是**只读角色标签 chip**（不可编辑，提交时原样补回），下面是文本输入框。
- **编辑范围**：默认"点中哪行改哪行"；双语行是否一次改整句见「八、待确认」。
- **键位**：`Enter` 保存 · `Esc` 取消 · `Tab` 切中/英（双语时）。
- **播放协调**：打开即 `video.pause()`，编辑期间锁定播放头；关闭后恢复原播放状态。
- **边打边看**：输入防抖 → 复用 `editPreview/previewMulti` 送草稿上屏（SRT 直接更新 `#srt-overlay` 对应行）。

### 3.2 文本编辑弹窗（图2）

- **触发（建议）**：① 就地框上的「⤢ 完整编辑」按钮；② 视频区**右键**字幕 → 菜单「编辑字幕文本…」。两者打开同一弹窗。
- **内容**：`行预览` 显示该行**当前**纯文本（`assPlainText()` 剥掉 ASS 覆盖标签）；`<textarea>` 预填**可编辑正文**（已剥离角色标签与行首色标）；底部提示文案照抄图2；按钮 取消 / 保存。
- **保存**：只替换 Text 字段 —— `buildAnchorText(原事件文本, 标签 + 编辑框文本)` → `assDoc.setEventText(ev, newText)`（或复用 `applyAssRow` 的纯文字分支，时间原样传回）→ `assPlayer.updateNow(serialize())` + `rebuildItemsAndLanes(true,true)` + `Projects.scheduleSave()`。**时间 / 样式 / Name / 层号一律不动**，与标题承诺一致。
- **允许写内联标签**：Text 字段原样替换、`escAss` 不参与 → 用户可写 `{\c&H..&}`、`\N`，与提示一致。

### 3.3 SRT 与 ASS 的差异

| 项 | ASS | SRT |
|---|---|---|
| 命中来源 | `state.kar.rows`（时间）+ 点击纵向位置分中/英 | `state.srtCues`（时间）；HTML 层可量 `.ov-cue` rect，命中更精确 |
| 行内标签 | 保留 `{\c..&}`，允许用户写内联标签 | lines 里的 `<i>/<b>` 是 HTML，改纯文本会丢标签 → 需策略（待确认） |
| 预览 | `previewMulti` → libass 重渲 | 直接改 `#srt-overlay` 草稿 DOM |
| 角色前缀 | 有（`[角色]` + 行首色标） | 无 |
| 是否用图2 弹窗 | 是（Text 字段语义清晰） | 待确认（无 ASS 语义） |

---

## 四、技术实现

### 4.1 新增模块 `js/videoedit.js`（建议）

`VideoCueEditor` 类，职责：命中判定 + 就地框 + 弹窗编排。在 `main.js` 里与 `overlay`/`assPlayer` 同级初始化，通过回调注入 main.js 的提交与预览能力（**保持 main.js 为唯一真相源**）。

```
hitTest(clientX, clientY) -> { row|cue, line, rect }   // 命中判定
open(target) / close(reason)                            // 就地框
commit() / cancel()                                     // 提交 / 回滚
```

### 4.2 命中判定 `hitTest`

1. **时间候选**：`t = video.currentTime`，过滤 `start <= t < end`。
2. **顺序**：ASS 用 `state.kar.rows`；SRT 优先量 `#srt-overlay .ov-cue` 的 `getBoundingClientRect()` 精确命中，量不到再退化到"时间 + 纵向位置"。
3. **多候选**（重叠行 / 中英同一行）：按点击 y 在画面高度中的比例取上半 = 中文、下半 = 英文；若仍有多个（真重叠），取时间跨度最贴合 currentTime 的一条，必要时弹"选择行"（复用 `#pick-overlay` 范式）。
4. **坐标系**：`#srt-overlay` 的 rect 即"去黑边"后的画面矩形（`fitToVideo()` 已维护），把屏幕点换算成 0~1 相对坐标，video resize 后可复用。

### 4.3 就地框 DOM / CSS

```html
<div id="cue-inline-editor" hidden>
  <div class="cie-prefix">[Wemmbu]</div>
  <input class="cie-input" spellcheck="false">
  <div class="cie-hints">
    <span>Enter 保存 / Esc 取消</span>
    <span>双击字幕可编辑整句</span>
  </div>
</div>
```

- 放在 `#video-stage` 内、`position:absolute`，z-index 高于 `#srt-overlay` 与 libass canvas 容器；样式写进 `css/style.css`（与 stage 相关样式同处）。
- 定位：由 `hitTest` 返回的 rect 换算；`video` 尺寸变化时重算。

### 4.4 事件协调（必须处理，否则会打架）

| 冲突 | 处理 |
|---|---|
| 双击第一下已启动单击的 240ms 定时器 | 开编辑时清掉（沿用 `videoClickTimer` 现有清法） |
| 双击默认禁全屏 | 现有 `dblclick` 监听继续 `preventDefault`，在其后追加"尝试命中 → 开编辑"，无命中则维持原行为 |
| 全局快捷键 | 已由 `typing` 判定跳过，无需改动；`Enter/Esc/Tab` 在编辑框内自行处理并 `stopPropagation` |
| 编辑中视频播放 | 打开即暂停；编辑期间锁定播放头；关闭后恢复 |
| 右键菜单 | 新增 stage 的 `contextmenu` 处理，与时间轴自身的右键菜单互不干扰（不同元素） |

### 4.5 提交与预览复用

- **ASS**：草稿进 `editPreview`（`{row, doc, zh:{text,tag}, en:{text}, version...}`）→ `renderEditPreview()`；提交走 `panel.onApply` 同款分支（`applyAssRow`），确保与列表行内编辑**同一条落盘路径**，避免两套逻辑分叉。
- **SRT**：草稿改 `overlay` 的临时渲染；提交写 `cue.lines` 后 `overlay.setCues()` + `scheduleSave()`。
- 不新增写盘路径，全部经 `assDoc` / `state.srtCues`。

---

## 五、改动清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `editor/js/videoedit.js` | **新增** `VideoCueEditor` | 命中判定 + 就地框 + 弹窗编排 |
| `editor/index.html` | 新增 `#cue-inline-editor`、`#cue-text-overlay` | 弹窗沿用 `.rn-box/.rn-title/.rn-actions` 范式 |
| `editor/css/style.css` | 就地框样式与定位 | 与 `#video-stage` 样式同处 |
| `editor/css/ui.css` | 弹窗样式（标题橙条 / textarea / 提示） | 复用现有 modal 变量与类 |
| `editor/js/main.js` | 初始化 `VideoCueEditor`；在 `dblclick` 挂命中；注入提交/预览回调；`contextmenu` 菜单 | 保持 main.js 为唯一编排点 |
| `editor/js/modal.js` | `bindModalDrags()` 定义表加入 `#cue-text-overlay` | 一行，获得拖动能力 |
| `editor/lang/zh-CN.json` | 新增文案 | 项目有 i18n 表，需同步 |
| `editor/server.js` | `APP_VERSION` 递增 | 发版约定 |
| `tests/` | 命中判定 / 前缀保留 的纯函数单测 | 见下 |

---

## 六、风险与边界

1. **ASS 行拿不到真实视觉坐标**（libass 画在 canvas 上，没有按行的 DOM）→ 就地框按"**点击点**"锚定而非"按字幕框"锚定；纵向分区用近似（上=中 / 下=英）。这是本方案唯一的近似点，实现时需用真实稿件验收。
2. **同一时刻多条行重叠** → 需要选择交互（复用 `#pick-overlay` 范式）。
3. **逐词英文行的文本编辑** → `applyAssRow` 已有"英文改文本 → 重建词级切片"逻辑，复用即可；注意预览与落盘一致（`zhPreviewText` / `buildAnchorText` 已保证）；不在就地框暴露词级标签。
4. **SRT 行内 HTML 标签**（`<i>`）的取舍需明确。
5. **无撤销栈** → 就地框必须支持 Esc 干净回滚（复用 `clearEditPreview`）；失焦是否自动提交需统一（见待确认 3）。
6. **全屏 / 画中画 / 舞台尺寸变化** 时的重定位与关闭。
7. **i18n** → 项目有 zh-CN 表，且测试可能校验文案 key 完备。

---

## 七、实施阶段

### P0 · 跑通主干（可验收）
1. `hitTest` 命中判定（ASS / SRT 双路径）+ 单测
2. `#cue-inline-editor` DOM / 样式 / 定位；双击打开、Enter 保存、Esc 取消
3. 提交复用 `applyAssRow` / `cue.lines` 分支；落盘 + `scheduleSave`
4. 与播放暂停、双击禁全屏、全局快捷键的冲突处理

> 验收：ASS 与 SRT 各双击一条，改一行中文，Enter 后视频与右侧列表同步更新；Esc 不落盘。

### P1 · 图2 弹窗 + 实时预览
5. `#cue-text-overlay` 弹窗（行预览 / textarea / 提示 / 取消·保存），注册拖动
6. 就地框输入 → `editPreview` 实时上屏（中英双语同时预览，与列表行内编辑一致）
7. 前缀保护：`buildAnchorText` 复用验证（角色标签 + 行首色标不丢）

### P2 · 打磨
8. 重叠行的选择交互
9. 右键菜单入口 + 「⤢ 完整编辑」按钮
10. 视频 resize / 全屏 / 切稿时关闭并重定位
11. i18n 文案、帮助说明、README 更新

---

## 八、待你确认

1. **图2 弹窗入口**：只用"就地框上的完整编辑按钮"，还是同时加"视频区右键 → 编辑字幕文本…"？
2. **就地框的行范围**：只改**点中的那一行**（中或英），还是双语行时**中英一起改**（两个输入框、Tab 切换，对应提示里的"编辑整句"）？
3. **失焦行为**：点框外 = **取消**（更安全）还是 **保存**（与右侧列表行内编辑"点其他位置自动保存"一致）？
4. **SRT 行内 `<i>/<b>`**：保留 / 剔除 / 提示？
5. **图2 弹窗是否也适用于 SRT**？（ASS 的 Text 字段语义清晰，SRT 只是纯文本行）

---

## 九、落地结果（2026-10-09，已实现并验证）

发版号 **`2.1.14`**（`editor/server.js` / `build/installer/SubFabric.iss` / `editor/README.md` 三处已同步）。

### 5 个待确认项的最终决定
| 项 | 决定 | 依据 |
|---|---|---|
| 图2 弹窗入口 | 片段框内 **`Ctrl+Enter`** + **视频区右键**（不额外加按钮） | 你给的 4 条定稿里没有提到按钮；参考图1 的框很紧凑，多一个按钮会破坏观感。要显式按钮随时可加 |
| 就地框的行范围 | **只改点中的那一段**（空格分隔片段；行首 `[角色]` 是只读前缀） | 你定稿的「点什么改什么 空格分隔」 |
| 失焦行为 | **点框外 = 取消** | 你定稿的「点框外即取消」 |
| SRT 行内 `<i>/<b>` | 片段替换**原样保留**（最小替换天然不碰其它字节）；整行弹窗按纯文本整行改写，**并在提示里明确告知不会带回来** | 整行是"你重写这一行"，旧标签与旧文本绑定；但必须说清楚，不能默默丢 |
| 图2 是否适用于 SRT | **适用**，提示文案按格式改写（SRT 没有 Text 字段/内联标签，照抄 ASS 文案会误导） | 「SRT 编辑逻辑尽量同步」 |

### 与方案的不同之处（实测推翻了方案里的假设）
方案原写「ASS 只能按 Style 反推几何」。实测**不可行**：`Fontsize × 帧高 ÷ PlayResY` 算出的字号比真实渲染**大 30~50%**（本机 libass 的字体回退 + 缩放），位置偏 15~20px。
改为**直接读 libass 画布的 alpha 通道拿真实墨迹**（画布是 2D 且背景透明），估算只作兜底。SRT 侧同步升级为**逐字符 `Range` 精确测量**。详见 `editor/README.md` 的 v2.1.14 一节。

### 验证
| 套件 | 项数 | 覆盖 |
|---|---|---|
| `tests/cue-segment-test.mjs` | 17 | 分段 / 最小替换纯逻辑（含行内色标保留、区间失配返回 null） |
| `tools/videoedit_probe.mjs` | 44 | ASS 端到端：截图扫真实文字带对照几何、**按像素量出的段间空格位置去双击**、打字即预览且不落盘、落盘只改那一段、改词后几何重建、**两行重叠时 4 条线逐条命中** |
| `tools/videoedit_srt_probe.mjs` | 35 | SRT 端到端：几何与 DOM 逐像素一致、角色标签不参与编辑、只改那一行/时间戳不变、拆分、整行弹窗前缀补回、右键入口 |
| 合计 | **96 项全绿** | |

截图：`outputs/videoedit-1-before.png`、`-2-inline.png`、`-3-after.png`、`-4-overlap.png`、`videoedit-srt-1-inline.png`、`-2-after.png`、`-3-modal.png`。

### 仍未做（可选）
- 视频区就地框上的**显式「完整编辑」按钮**（当前只有 `Ctrl+Enter` 与右键）。
- 全屏/画中画里的重定位只在 `resize` + `fullscreenchange` 事件里做，没做 `ResizeObserver`（`#video-stage` 被别的面板挤压时不会自动跟随）。

---

## 十、真机复核（2026-10-09 晚）：发现并修掉两个"点不动"的真缺陷

用户在**自己的机器、自己的工程**上试，反馈「字幕点不动」。按要求**真启动**（连已在跑的 `editor/server.js`、
**有头窗口**、从首页点工程卡片进入、真实鼠标事件）复核，先排除了"旧页面"（页面版本戳 == 服务端版本戳），
随后复现并定位到两个真缺陷（当时版本）：

### 缺陷 1：`<video controls>` 底部约 72px 把鼠标事件全吃掉

`video.controls` 为真时，控件在 video 的 **UA shadow** 里。实测那一条带子里
`pointerdown / mousedown / click / dblclick` **一个都到不了页面**（`pointermove` 照常冒泡）——
不是"处理了"，是**根本没派发**。所以压在控制条上的字幕行，双击永远打不开编辑框。
窗口越小 / 字幕越靠下越容易撞上（`main.js:100` 早就知道这条带子，特意把"点视频=播放/暂停"让开了）。

**修法**：`#cue-hit-shield`（`index.html` + `style.css` + `videoedit.js`）
- 只盖 **"字幕行 ∩ 控制条带"** 那一小块，`_syncShield()` 每 250ms 跟着字幕走；
- **默认 `pointer-events:none`，仅当指针悬到该行上才 `auto`**（`_armFromLastPoint`，带 8px 回滞）——
  进度条/音量在别处照常，被接管的只有字幕文字那一截；
- 武装用**整行矩形**（含控制条以上那截），所以往下滑进控制条时已经是武装状态；
- 单击只清掉"点框外取消"留下的 `_swallowClick` 记号（事件本来到不了 `<video>`），右键复用同一个整行弹窗入口。

### 缺陷 2：墨迹扫描的 `null` 被永久缓存 → 中英两行上下颠倒

`_inkBands` 原来把**扫失败（`null`）也写进缓存**。libass 重绘的那一瞬画布是空的，扫不到就存 `null`；
而暂停时缓存 key（帧时间 + 画布尺寸）**永不变化** → 这一帧**永久**退回 Style 估算。
更糟的是**估算回退的上下顺序恰好是反的**（原来按"中文在上"猜），于是同一帧上两次取布局能给出**上下颠倒**的结果。

**修法**
- `_inkBands`：缓存只认扫成功的结果；失败最多重试 `INK_MISS_MAX = 3` 次（接管层 250ms 的节奏下不到 1 秒自愈）。
- 估算回退按 **ASS 文件行号升序 = 由下往上**（`_eventLineIdx`）排开，与墨迹那一支**同一口径**，
  不再按"谁叫中文"猜 —— 两条路径顺序互斥正是"有时点得动、有时点不动"的来源。

### 复核方式与结果

新增 `tools/videoedit_live_check.mjs`：连**已在跑的服务**、**有头窗口**、从首页**点工程卡片**进入、
用**真实鼠标**逐行逐段双击，并按 `st.top/left` 换算视口坐标。断言含
「每行每段都命中自己那一行那一段」「压在控制条上的行必须能打开」「接管层没有霸占整条控制条」。

| 场景 | 结果 |
|---|---|
| ASS 真实工程（4K 3840×2160，自己下载的番剧）+ 1100×700 | 13/13 |
| 同上 + 1366×768（中英两行**都在**控制条上） | 13/13 |
| 同上 + 1600×1000 | 11/11 |
| SRT 工程 + 1366×768 | 13/13 |
| `tools/videoedit_probe.mjs`（含 4 行重叠） | 44/44 |
| `tools/videoedit_srt_probe.mjs` | 35/35 |
| `tests/cue-segment-test.mjs` | 17/17 |

发版号 → **`2.1.14`**（三处已同步）。截图：`outputs/live-1-before.png`、`outputs/live-2-click.png`。

### 已知取舍
- 被接管的那一小块（**字幕文字 ∩ 控制条**）在指针悬停其上时不再响应原生控件（如正好压在进度条上拖拽）。
  移开 8px 即失效，属于可接受取舍；要彻底消除得关掉 `controls` 自绘一套播放控件。

---

## 十一、手势定稿（2026-10-09 晚，用户更正）

用户明确更正了手势：**单击字幕 = 就地编辑 / 双击字幕 = 整行弹窗 / 点其它视频区 = 播放暂停（不变）**。
（原先实现的是"双击进就地编辑、右键弹整行窗"。）

### 落地
- `videoedit.js` 新增两条入口，取代原来单一的 `tryOpen`：
  - `clickAt(clientX, clientY)`：**单击**字幕 → 进就地编辑，改被点中的那一段。
  - `dblClickAt(clientX, clientY)`：**双击**字幕 → 整行文本弹窗。
  - `cancelPendingClick()`；`begin()` 里也调一次（防上一击的尾巴把框抢回去）。
  - `tryOpen` 保留为**程序化入口**（探针/脚本用）。
- **单击/双击靠一个 240ms 的双击窗口分开**（`CUE_CLICK_DELAY`，与 main.js "单击视频=播放/暂停"同值）。
  单击后先按住 240ms，期间没等到第二下才真的把就地框开出来；否则双击会先开出就地框再被弹窗顶掉。
- `main.js` 的 `video.click` 改了分派顺序：**先清 `consumeClick` 记号 → 底部 72px 直接返回 → 问 `clickAt`
  是否吃下这一击 → 吃下就绝不切播放**。原来"点在字幕上"会被当成"点空白"，等 240ms 窗口过去就把视频播起来了 ——
  实测**点一下 `[Wemmbu]` 前缀就能把视频播起来**，这条一并修掉（`clickAt` 对"落在只读前缀/片段缝隙上"
  返回 true 但不编辑，把这一击按住）。
- 新增 `_rowAt(x, y)`（只判"行"不判"段"，横向范围含只读前缀）供 `clickAt` 区分"字幕"与"空白"；
  `_hitTest` 复用它。横向容差与 `_segmentAt` **同一口径**（不能更严，否则估算回退时会出现
  "片段判定命中、行范围却不认"的整条落空）。
- 接管层 `#cue-hit-shield` 的两个手势同步改成"单击→就地编辑 / 双击→整行弹窗"，与画面上方那半截保持一致。
- 就地框提示语改成「双击字幕 / Ctrl+Enter = 整行编辑」。

## 十二、真机验收脚本的两个环境坑（踩过并已处理）

1. **被遮挡/非前台窗口里 Chrome 会节流 `setTimeout`**：裸 `setTimeout(240)` 实测回调于 **630ms**。
   于是"单击 → 等 240ms 开就地框"在测试里会被误判成"没开"。
   → 脚本改成**轮询等**（最长 1.8s）而不是睡固定时长。产品行为不受影响（真人用前台窗口就是 240ms）。
2. **经"首页 → 点工程卡片"进工程时，12.5GB 的 4K 片源偶尔会一直挂在 `networkState=2` 拿不到元数据**
   （同一工程**直接深链** `#/project/<id>` 则秒好）。一旦拿不到元数据，后面所有几何断言都会连坐成假失败。
   → 脚本加"等不到就 `location.reload()` 重试"（刷新后 hash 仍是 `#/project/<id>`，等价于深链重进）。
   另：所有几何断言前统一 `park()`（拨回 T0 + 暂停 + 等画面真的有字再量），并且 **x 与 y 必须来自同一次 dump**。

### 真机验收结果（`tools/videoedit_live_check.mjs`，连已在跑的服务 + 有头窗口 + 真实鼠标）
| 场景 | 结果 |
|---|---|
| ASS 真实工程 1366×768 | 23/23 ×2 |
| ASS 真实工程 1600×1000 | 21/21 ×2 |
| ASS 真实工程 1100×700 | 23/23 ×2 |
| 既有 `videoedit_probe.mjs`（ASS，含 4 行重叠） | 44/44 ×3 |
| 既有 `videoedit_srt_probe.mjs` | 35/35 |
| `tests/cue-segment-test.mjs` | 17/17 |

断言覆盖：单击每行每段都命中自己那一行那一段、压在控制条上的行也能打开、单击不切播放、
双击出整行弹窗且不同时开就地框、单击空白=播放/暂停、框开着时单击另一条直接切过去、
单击只读前缀既不编辑也不切播放、接管层没霸占整条控制条。

截图：`outputs/live-1-before.png`（未点）、`live-2-click.png`（单击后就地框）、`live-3-modal.png`（双击后整行弹窗）。
