# 环境自适应选择框 · 编辑器原型

打开 [index.html](index.html)。单文件、无外部依赖、无构建，可直接用 `file://` 打开。

## 这版做了什么

把上一轮从消息弹窗拆出的「边框随背景取色」规则，落到 SubFabric 编辑器设置页与右侧字幕栏的全部可选表面：

- 主题包卡片（4 个）
- 背景材质卡片（3 个）
- 明暗分段控件
- 识别模型单选卡片（3 个）
- 编辑器字幕卡（6 个）
- 角色下拉（触发器 + 选项）
- 复选框、开关
- 原生下拉（显示模式 / 界面密度 / 界面语言）
- 取样窗口与映射曲线（说明用）
- 描边映射曲线：S ↑ → kSat ↓ / kBri ↑
- 强调色板保留强调色语义，不套环境描边

## 交互

- 点主题包 → 切换强调色。
- 点背景材质 → 换壁纸；所有描边立即重取当前位置的颜色（极光 / 石墨 / 暮色）。
- 浅色 / 深色 / 跟随系统。
- 点字幕卡、模型卡、复选、开关、下拉。
- 底栏「对比模式」→ 关掉环境描边，回退为 1px 普通边。
- 悬停任一选择框 → 曲线标记、S/V、kSat/kBri、映射输出同步更新。
- 右侧「SAMPLING WINDOW」显示当前位置的壁纸原件，外圈就是取样结果。

## 实现

- `.agx` 的 `::before` 复制一张 100vw × 100vh 壁纸，用 JS 按 `getBoundingClientRect()` 设置 `--bgpos: -x -y`，得到元素身后的壁纸切片。
- 用 `mask: linear-gradient(...) content-box, linear-gradient(...)` + `mask-composite: exclude` 把切片裁成 1.3px 描边环。
- 读取当前 `--wp` 的渐变层，在元素边缘取 5 个点，得到局部 S/V。
- 映射：`kSat = 1.10 − 0.25·S^1.5`（高 S 降到 0.85，不再加饱和）、`kBri = 1.40 + 0.58·S^1.2 + 0.10·(1−V)`、`kSpec = 0.60 + 0.18·S`；逐元素写入 `--rim-sat/--rim-bri/--spec-op`。
- 页面「描边映射曲线」用单轴展示 kSat/kBri；悬停任一 `.agx` 更新 S/V、映射输出与标记点。
- `::after` 叠顶部白高光，负责暗背景下的轮廓保底。
- 不能用 `background-attachment: fixed`：窗口的 `backdrop-filter` 会改变 fixed 的参照，所有卡片会取到左上角。
- 生产接入时把 `--wp` 换成应用真实背景层（当前是 `.sf-ambient` 多层），在 resize / scroll / 布局变化时更新 `--bgpos`；UWP、Classic 等固定主题可整体关闭。

## 说明

- 这是**设计原型**，未接入 `editor/studio.html` 或 `editor/css/studio.css`，不影响生产界面。
- 预览：[`preview.png`](preview.png)（深色）、[`preview-light.png`](preview-light.png)（浅色）。
