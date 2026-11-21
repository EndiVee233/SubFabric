# 稿件编辑器设置

## 当前实现（2026-11-17）

`EditorSettingsPane.ets` 负责从上到下排列的折叠卡片；`Scroll.align(Alignment.TopStart)`
使内容不足一屏时仍紧接页签底部。允许多张卡片展开。标题点击调用 ArkUI
`UIContext.animateTo` 与 `curves.springMotion(0.28, 0.9)`，内容使用原生透明度/位移过渡。

- ASS 双语样式：中文/英文字体、字号、粗斜体、主色/备用色、逐词高亮色、上下顺序、未唱色、k/kf 与颜色切片形态；支持载入字体。
- 字幕后处理：微光总开关、作用范围、角色跟色、分语言通道/半径/强度；淡入范围、不透明度、时长与句长占比上限。沿用原版关闭词生长的决定。
- 字幕样式预设：本机库保存、应用、重命名、删除与 JSON 导入/导出。读写桌面版 `subfabric.ass-style-preset`、`subfabric.subtitle-style-preset`、整库 `subfabric.subtitle-style-presets`；按字段名匹配样式轨，保留标准 ASS 对齐、边距、描边等字段。
- 导入与音频：视频替换、字幕导入换行选项、原声/系统降噪、音频与波形重生成。生成的项目 WAV 可供后续识别复用；降噪播放走独立 AVPlayer 与视频同步。
- 导出：中文/英文/无逐词/逐词 ASS、逐词 JSON、按人物筛选 ASS、原片保存。
- 原字幕显示、识别与翻译设置保留在独立折叠组中。

每个项目的 `editor-options.json` 保存设置；`editor-style-presets.json` 为应用本机预设库。
修改样式不会改写 cue 文本或时间。ASS 生成使用独立 `EditorOptions.ets`；颜色切片在英文轨输出，
不会用英文逐词文本替换中文字幕。预览使用原生 ArkUI 字体/颜色/阴影与字符高亮模拟，不是 libass 像素等价渲染。

## 验证与边界

- 已通过 Hvigor 构建并安装。
- `node tools/editor-options.test.cjs`：验证语言筛选、样式、角色 BGR 颜色、逐词形态、特效标签、原数据不变、新旧预设往返、乱序字段与参数边界。
- `node tools/timeline-timing.test.cjs`：前序时间轴计算回归通过。
- 设备 UITest 已核对设置标题顶部排列、卡片原地展开与收起；预设文件选择器、字体载入、系统降噪播放和真实文件导出尚未逐项完成设备验收。
- 双语硬字幕视频压制未接入当前导出链路；页面明确提示，原片与字幕文件可分别保存。
