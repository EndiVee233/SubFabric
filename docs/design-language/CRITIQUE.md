# 为什么 SubFabric Classic 看起来最丑

> 实测记录，2026-10-20。所有数字取自 `EndiVee233/SubFabric@8f2213d` 的
> `editor/css/studio.css`、`editor/js/studio-themes.js`，对比度按 WCAG 2.x 公式实算。
> 可视化证据见同目录 `why-classic-fails.html`。

## 结论

**Classic 不是一套设计语言，是一层没做完的换色。**

它用 22 行独占规则改颜色、去模糊、加阴影，没有自己的形状、动效、版式母题；
骨架是为 Studio 设计的（218px 侧栏、18px 圆角、28px 花朵、999px 胶囊），
它只把颜色染成橙灰、圆角压到 6/8。

所以"丑"不是某个配色选错了，而是**中间缺了"设计"这一层**：
骨架是别人的，皮是旧的。

## 一、体量：22 / 104 / 694

| 主题 | 含 `data-design=` 的行 | 说明 |
| --- | --- | --- |
| Classic | **22** | 其中 6 行在做同一件事：去 `backdrop-filter`、换 `background:var(--surface)`、加 `0 2px 10px` |
| Material You | 104 | 有独立首页（`sf-mu`）、播放器、波浪进度、rim 卡片 |
| Windows 10 | **694** | 每个组件都有 UWP 专用形态：磁贴、细描边、2/4px 直角、按压内阴影 |

数量不代表质量，但它准确描述了三种实施方式：
**UWP 是重写，Material 是重写，Classic 是打补丁。**

## 二、五个病灶（每条都能指到行号）

### 1. 明度分层失效，又没有替代方案

| 关系 | 实测 | 结论 |
| --- | --- | --- |
| `bg-0 #0b0b0e` → `surface #131318` | **1.06 : 1** | 近黑区几乎不可辨 |
| `surface` → `line #2a2a34` | **1.30 : 1** | 描边和底色同灰 |
| `#12171e` → 选中态 `#1a212b`（字幕卡） | **1.11 : 1** | 选中几乎看不到 |
| 色相偏移 | **0°** | 纯中性灰，没有色相帮忙 |

深色分层只有三条路：明度差、描边、色相/光。Classic 三条都没占住，
唯一补充是 `box-shadow: 0 2px 10px #00000030` —— 打在 `#0b0b0e` 上等于没有。

对照：UWP 的描边是 **2.47 : 1**（`#666` on `#2B2B2B`）；
Material 的 surface **带 seed 色相**，描边 1.92 : 1，另有环境色描边（rim）。

### 2. 强调色通胀：438 次引用

全表 `var(--accent*)` 共 611 次，其中 `var(--accent)` **438 次**。
同一个橙色同时是：主按钮填充、悬停文字、边框、播放头、进度条、徽标、版本号、字标渐变、光晕、选中左线。

一个颜色承担 9 种语义 = 一种语义都不成立。
用户看到橙色无法判断"这是当前状态、可点、还是品牌装饰"。

### 3. 淡橙叠在近黑上会变成"棕"

`--accent-soft: rgba(255,122,69,.16)` 叠在 `#131318` 上，实际合成 **#39241F**
（H≈20°, S≈29%, L≈17%）——一个饱和度明度都很低的**棕色**。

棕色在灰黑底上天然读作"脏 / 锈 / 旧皮革"。
Material 做同一件事用的是 **#223454**（navy）：蓝降明度仍然是蓝，不进入"脏"的联想区。

这就是"两块淡色容器，一块看着高级、一块看着土"的物理原因，不是审美分歧。

### 4. 18 种圆角，`--sf-radius` 只被引用 1 次

只统计生产外壳段（3150–3650 行）就出现 18 种取值：

```
4 6 7 8 10 12 13 14 16 18 19 20 22 24 26 28 50% 999px
```

同屏（首页）实际生效：花朵 28 / 续作卡 24 / 胶囊 999 / 组件卡 18 / 项目卡 20 / 封面 13 / 按钮 10。

而号称"统一圆角令牌"的 `--sf-radius` 在全表**只被引用 1 次**。
所以"圆角跟语义走"只存在于文档里，代码里是逐组件手写 → 读起来就是"随机圆角"。

对照：UWP 只有 2/4px 两档，且用一条巨型 `:is()` 列表把 40+ 个容器强制归一到 4px；
Material 只有 24px / 999px 两档。

### 5. 它把位移动效显式关掉了

`studio.css:4067`：

```css
.sf-studio[data-design=classic] :is(.btn, .sf-nav a, .st-tab, ...) {
  border-radius: 6px;
  transform: none !important;                 /* ← 一行杀掉全部按压反馈 */
  transition: background .12s, color .12s, border-color .12s, box-shadow .12s !important;
}
```

且 Classic **没有任何 `:active` 规则**。

对照：UWP 也关位移，但补了 Fluent 的按压内阴影 `inset 0 1px 2px`；
Material 用 spring 驱动的 scale（播放键低到 `.92`）。
**Classic 是唯一"按下什么都不发生"的方言。**

### 附：一个被自己关掉的签名

`studio.css:3327`：

```css
.sf-studio .proj-card::before { display:none }
```

Classic 唯一的结构签名——3px 左侧强调条——在首页被关掉了。
于是它连"一个有母题的主题"都算不上，只剩颜色。

## 三、为什么另两套能成立

| | 一致性机制 | 具体做法 |
| --- | --- | --- |
| Windows 10 | **强制归一** | 694 行把表面压到 2–4px 直角；统一 1px `#666` 描边；关毛玻璃、关位移；悬停只用中性色；系统蓝锁死不可改；首页用磁贴做版式母题 |
| Material You | **算法生成** | 一个 seed 推 13 令牌 + 5 角色容器；surface 带 seed 色相；`readable()` 把对比度顶到 4.6；形状只有 24/999 两档 + 会 morph 的播放键 |
| SubFabric Classic | **没有实现** | 22 行改颜色 + 取消材质。骨架继承 Studio，皮是旧版编辑器，中间没有设计层 |

判断标准很清楚：**一个主题如果只剩颜色，它被评价为"只有颜色"就是必然的。**

## 四、最小抢救清单

| # | 动作 | 做法 | 目标 |
| --- | --- | --- | --- |
| 1 | 拉开明度或补描边 | `surface → #181a20`，`line → #3a3a46`；二选一必须做 | ≥1.2 / ≥2.0 |
| 2 | 容器色改实色降彩 | 不用 `rgba(橙,.16)` 叠黑，用 `#2E1B12` 这类压过饱和的深棕 | 去脏 |
| 3 | 收回强调色 | 只留给主操作 / 当前态 / 数据高亮 | 438 → ≤120 |
| 4 | hover 不许动主色 | 次级按钮 hover = `surface-2` + 1px accent 边框 | 主次不塌 |
| 5 | 恢复按压反馈 | 删掉 `transform:none!important`，用 `scale(.97)` 或 inset 阴影 | 有回执 |
| 6 | 圆角收敛到 3 档 | 卡片 12 / 控件 8 / 胶囊 999 | 18 → 3 |
| 7 | 给它一个母题 | 把「3px 左线 + 等宽时间列」贯穿所有容器，并恢复 `.proj-card::before` | 可被认出 |

前六条是修表面，第七条是修根因。

---

## 五、已实装（2026-10-20）

这份构想已落到真实应用里：`editor/css/classic.css`（270 行，只作用于 `body[data-design="classic"]`）。
接入点三处：`editor/studio.html` 与 `tools/templates/studio.html` 各加一行 `<link>`，
`editor/server.js` 的 `STATIC_RESOURCES` 放行 `/editor/css/classic.css`。

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| bg → surface | 1.06 | **1.15**（#0C0B0A → #1E1B19） |
| surface → line | 1.30 | **1.94**（#514942） |
| 强调卡 | 整块铺橙 | **surface + 3px 左线 + 橙色 CTA** |
| 导航选中 | 棕色块 | **中性抬升 + 3px 左线** |
| 次级按钮 hover | 填橙 + 橙字 | **surface-2 + 1px 橙边** |
| 按压 | 被 `transform:none!important` 关掉 | **scale .985** |
| 入场 | 无 | **340ms / 5px / 24ms 错峰** |

### 审查轮（两个只读子代理 + 实拍复核）

子代理 A（主题覆盖）交回 15 条，子代理 B（布局健壮性）交回 12 条。已立即修复并可实拍验证的：

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| 翻译方案表单错位（截图反馈） | `.st-grid` 是「标签｜控件」两列，空的 `<small class="st-field-error">` 仍占一格，后面全部错位一格 | `studio.css`：`.st-field-error{display:none;grid-column:1/-1}` + `:not(:empty)` 才显示（原来只有 UWP 方言有兜底） |
| 术语表输入框/页签是黑的 | `.gl-input` 写死 `#101015`、`.gl-tabs` 写死 `#131318` | 改为 `var(--surface-2, var(--bg-3))` + `var(--line-soft, var(--border))`，浅色模式一并修好 |
| 术语表表头与行错位 | `.gl-rows` 出滚动条后内容缩窄，表头没有同样沟槽 | `.gl-rows{scrollbar-gutter:stable}` + 表头 `padding-right: calc(2px + 11px)` |
| 空徽标留下空胶囊 | `.st-hw` / `.gl-tabs` 为空时仍渲染边框 | 补 `:empty{display:none}` |
| 窄屏表单不塌成一列 | 媒体查询 `#st-view .st-grid`(1,1,0) 打不过 `.sf-studio #st-view .st-grid`(1,2,0) | 媒体查询内改用同等权重选择器 |

验证截图在 `shots/`（dark 首页、light 首页、设置页、稿件库），由真实服务 + 无头浏览器实拍。

### 适配协作者版本（R2FtYml0 / 89299ce）

他推的 `refactor(动效): 入场动画按编辑器会话只播一次` 重写了 `studio.js` 的入场体系，和重制层的动效直接相冲。
适配后的差异：

| 项 | 适配前（我的第一版） | 适配后 |
| --- | --- | --- |
| 卡片入场触发器 | 给 `.proj-card` / `.cue-card` 常驻 `animation` | 接管应用既有的 `.is-entering` / `[data-view-enter]`，只换曲线 |
| 重播 | 每次 `refreshLibrary()` 重建节点都会重播 | 不再重播（对齐 `studio.css:2901` 的既有结论） |
| 错峰 | 自己用 `--i` 数 24ms | 沿用应用给的 `--sf-card-delay` / `--view-enter-delay` |
| 视图切换 | 无 | `animateLibraryViewChange()` 增加 classic 分支：24ms / 340ms |

同时补掉首页磁贴的空洞：8 个磁贴共 10 格，4 列下末行只填 2 格；让 `settings` / `library` 各 `span 2`，宽屏正好三整行。

全量回归：**100 通过 / 9 部分通过 / 0 失败**。

## 六、可运行空壳

抢救清单已实现为可运行的空壳：`classic-shell.html`（自包含，无外部依赖）。
右上角可切换 **旧 Classic / 新 Classic / Windows 10** 三种方言与明暗，同一份 DOM。

重制版关键令牌（实测对比度）：

| 关系 | 新 Classic | 旧 Classic | Windows 10 |
| --- | --- | --- | --- |
| bg → surface | **1.15**（#0C0B0A → #1E1B19） | 1.06 | 1.16 |
| surface → line | **1.94**（#514942） | 1.30 | 2.47 |
| surface → 容器 | **1.29**（#402B21，H20/S32） | 1.11（棕 #39241F） | 1.12 |
| 圆角档位 | **3**（12 / 8 / 999） | 18 | 2 |
| 强调色用法 | 主按钮 + 3px 线 + 数字 | 填充 + 悬停 + 边框 + 徽标 | 选中态 + 主按钮 |

身份来自 **暖石墨**：surface 带 24° 暖色相（不是中性灰，也不是 Material 的 seed 冷调），
所以既不需要靠橙色铺面，也不会落回"高级灰"的通用感。

