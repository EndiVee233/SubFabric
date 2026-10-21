# SubFabric 主题包

SubFabric 内置四个主题包：Windows 10（默认，内部设计标识仍为 `uwp`）、Material You、SubFabric Classic、Claude。Studio 主题已从内置选择器移除（`design: "studio"` 仍保留给旧自定义包）；设置 → 外观与主题会把四个内置包与“我的主题包”分组显示。

自定义主题包是一个 JSON 文件。最简单的做法是在设置页导出当前主题包，修改 `id`、名称、描述和颜色，再重新导入：

```json
{
  "schema": "subfabric-theme-v1",
  "id": "my-studio",
  "name": "我的 Studio",
  "version": "1.0.0",
  "description": "我的工作区配色",
  "author": "可选作者",
  "design": "studio",
  "seed": "#5C7560",
  "tokens": {
    "light": {
      "bg": "#F7F8F5",
      "surface": "#FFFFFF",
      "surface2": "#EEF1E8",
      "text": "#28372B",
      "muted": "#647161",
      "line": "#DCE2D5"
    },
    "dark": {
      "bg": "#1C221E",
      "surface": "#252D27",
      "surface2": "#2C352E",
      "text": "#E0E6DA",
      "muted": "#B2BDAE",
      "line": "#465244"
    }
  },
  "assets": {
    "preview": "data:image/png;base64,..."
  }
}
```

`design` 只能使用 `studio`、`material`、`classic` 或 `uwp`。`tokens` 只接受白名单颜色名和 `#RRGGBB`；`assets.preview` 只接受内嵌 PNG、JPEG 或 WebP。主题包不能包含脚本、CSS、HTML、SVG 或远程 URL。Windows 10 主题（内部 `uwp`）使用 Windows 10 Fluent 控件语言，默认蓝色可由用户自定义。

导入同名自定义包会替换旧版本；导入内置包会自动创建一个带 `-custom` 后缀的副本。内置包不能删除，自定义包可以在主题卡片右上角删除。
