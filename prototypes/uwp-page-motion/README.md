# 页面入场动效演示 · UWP / Material You

单文件、无依赖的设计演示，直接打开 `index.html`。演示设置各页、稿件库、帮助与快捷键页的“类似主页”的依次非线性放大淡入；不接入生产路由。

## 动效

- 页面整体：`opacity 0→1` + `scale(.92→1)`，从后往前淡入。
- 每个元素：`opacity 0→1` + `scale(.94→1)`；顺序按可视几何 **从下往上、从右往左**。
- 默认 `180ms cubic-bezier(.2,.8,.2,1)`，元素阶梯 `24ms`；主页基线是 `240ms / 50ms`，本方案略快。
- 只动 `opacity / transform`；`prefers-reduced-motion` 下关闭动画并直接显示。
- 顶部“快 / 标准 / 慢”按 0.8× / 1× / 1.3× 调整时长与阶梯；“重播”重放当前页。
- UWP / MY 切换只换 token 与圆角，不改变元素顺序与动效参数。

## 页面

- 主页（基线说明）
- 设置 · 外观 / 模型 / 翻译 / 识别与校对（含设置侧栏与卡片/表单行）
- 稿件库（3 张项目卡）
- 帮助（4 张说明卡）
- 快捷键（13 行长列表）

## 验收

Edge headless 1440×960：
- 初始主页 8 个 `.anim-item`，完成后 `opacity 1 / transform none`。
- 点击稿件库后 60ms，前四项 opacity 约 `0.93 / 0.85 / 0.67 / 0.25`，scale 依次约 `0.996 / 0.991 / 0.980 / 0.955`，delay `0 / 24 / 48 / 72ms`。
- 切到 MY：`data-design=material`、卡片 `border-radius 28px`、动画参数不变。
- “快”档 `--dur=144ms`、`--step=19ms`。
- 页面异常 0；截图 `preview.png`、`preview-library.png`、`preview-my.png`、`preview-shortcuts.png`。

## 边界

- 这是动效演示：页面内容与数据是静态模型，不接生产 `studio.js` 路由。
- 没有做滚动容器内的元素观察入场；只演示页面切换时的一次性入场。
- 若生产接入，建议在 `setPageVisible` 后按页面对 `.st-card`/`.proj-card`/`.sf-help-grid article`/快捷键行编号并加 `.is-entering`，保留 reduced-motion 门控。
