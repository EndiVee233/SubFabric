# 上游 2.1.13 合并 —— 已完成

> 上游最新：`6d73a6988`（chore(release): 2.1.12 → 2.1.13）
> 上游的编辑器修复提交：`6fe18608b`

**本次合并已全部完成**，包括上一轮推迟的 `main.js` 与 `editor.js`。

## 合并结果

| 文件 | 处理方式 |
|---|---|
| `editor/js/ass.js` | 取上游（含 `previewMulti` / `_specOf`） |
| `editor/js/karaoke.js` | 取上游（含 `recolorRoleInRows` / `sortRoles` / `normalizeZhPunctuation*` / `speakerNames` / `buildAnchorText` / `setWordHighlightColor`） |
| `editor/llm-text.js` | 取上游（含 `normalizeZhPunctuation`） |
| `editor/server.js` | 手工合并（4 处上游改动全部保留） |
| `editor/js/editor.js` | 手工移植（`onChineseInput` + composition 处理） |
| `editor/js/main.js` | 手工移植（逐项见下） |
| 4 个上游测试 | 已加入，全部通过 |

## `main.js` 移植的上游改动

1. **导入新符号** —— `karaoke.js` 用内联 `export function`，`main.js` 必须显式导入
   才能用到：`speakerNames / sortRoles / normalizeZhPunctuation / normalizeZhPunctuationInSentences /
   buildAnchorText / recolorRoleInRows / setWordHighlightColor`。
   ⚠ 这是**前提**：不导入的话，即使代码写了也会运行时 ReferenceError，
   而 `node --check` 照样通过 —— 最容易漏的一步。
2. **`speakerNames` 本地定义删除** —— 已挪到 `karaoke.js`（`recolorRoleInRows` 也要用它）。
3. **`recolorRoleGlobally` 改为调用 `recolorRoleInRows`** —— 修"角色换色串色"
   （旧实现按**旧颜色值**匹配，两个角色撞色时会改到别人身上）。
4. **`computeRoles` 改用 `sortRoles`** —— 从"按出现次数降序"改成"按名称首字母升序"。
   三处消费点（角色栏 / 角色筛选 / 查找替换候选）都走它，一并受益。
5. **中文标点归一** —— `setAss` 里在 `analyzeKaraoke` **之后**、`pairRows` **之前**调用
   `normalizeZhPunctuationInSentences`，并给出 toast 提示。
   ⚠ 位置关键：放在 `analyzeKaraoke` 之前会因 `state.kar` 尚未建立而 TypeError。
6. **逐词高亮色不丢** —— 三处调 `setWordHighlightColor`：
   `setAss` 载入时（无元数据则回默认绿）、`applyAssStyleSettings` 同步、改色时同步。
7. **中文行实时预览** ——
   - `editRowVisible` 改成认中/英任一（以前只认英文行）
   - 新增 `zhPreviewText`（复用 `buildAnchorText`，保证"预览看到的 == 提交后的"）
   - 新增 `restoreRealTrack`
   - `renderEditPreview` 改用 `ass.js` 的 `previewMulti`，中英**一起**上屏
   - 草稿结构由 `{ text, specs }` 改为 `{ zh:{text,tag}, en:{text}, specs, specsText, builtVersion }`
   - 新增 `panel.onChineseInput`（与 `panel.onEnglishInput` 共用同一份 `editPreview`）

## 验证

- `node --check`：全部通过
- **接线审计** `.staging/merge2/audit_wiring.mjs`：**34/34**（确认上游改动真的被调用，
  而不只是字符串出现在文件里）
- **导入解析** `.staging/merge2/check_imports.mjs`：**56 个导入符号，0 缺失**（真 import，非正则）
- **JS 回归**：46 通过 / 1 失败（`colorfix-test.mjs` 是上游既有失败，合并前就在）
- 上游 4 个新测试：`role-recolor` 22 · `role-order` 6 · `edit-preview` 21 · `zh-punct` 28，全通过

## 教训：这两个文件不能靠自动三方合并

自动合并产生了**结构性破坏**，而且 **`node --check` 能过、语义已坏**：

| 尝试 | 结果 |
|---|---|
| Python `difflib` 三方合并 | 重复声明 `punctFixed`、孤儿残片、`editor.js` 类提前闭合 |
| 自研"本地优先"算法 | `main.js` **945 行重复** |

**本次采用的可靠做法**：
1. 用 LCS 动态规划精确算出 base → theirs 的差异块（`.staging/merge2/mkdiff.mjs`），
   不要用贪心匹配（会产生重复）。
2. 逐块判断：**纯插入**看上下文能否唯一定位；**含删除**的块必须人工看 fork 是否已改过同一区域。
3. 用 `edit` 工具逐块移植，**每步 `node --check`**。
4. 最后跑**接线审计** —— 确认"改动真的被调用"，而不只是"字符串在文件里"。

## 环境注意事项（踩过的坑）

- 本机**没有 git / patch / diff**；推送走 GitHub REST API。
- **Python 进程对 `D:\SubFabric-fork` 无写权限**（沙箱）；**node 与 `edit` 工具可以**。
- 运行中的 node 服务会占用 `main.js` / `server.js` / `editor.js`，写之前先停服务。
- **从 fork 的 commit 取文件 != 取到"本地当前状态"** —— 未推送的改动不在里面。
  本次差点因此丢掉备注/弹幕/全片重校对三大功能；正确的预合并基线在 `.staging/main.js`。
- PowerShell 读 UTF-8 文件会带 BOM，`JSON.parse` 前要 `.replace(/^\uFEFF/, '')`。
- 大段 Python/JS 请**写成文件再执行**；PowerShell heredoc 与转义极易出错。
