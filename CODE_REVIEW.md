# SubFabric 代码质量审查报告

- **审查对象**：`endivee233/SubFabric` @ `b3848af`（v2.1.7 之后）
- **代码量**：35,976 行（JS + Python + HTML + CSS）
- **审查日期**：2026-10-04
- **方法**：静态模式扫描 + 全量测试实跑 + 漏洞动态验证

---

## 总评

**工程质量良好，安全底座扎实。** 核心业务逻辑（逐词高亮配对）测试覆盖扎实，异常处理有全局兜底，敏感数据处理是同类小工具中的标杆。

发现 **1 个可利用的安全漏洞**（路径穿越，已动态验证）、**1 个明显的可维护性瓶颈**（2921 行单体函数），以及若干值得改进的工程习惯问题。均不阻塞使用，但第1 项建议尽快修复。

| 维度 | 评价 |
|---|---|
| 安全性 | ⚠️ 1 个可利用漏洞（本地服务，远程暴露风险低） |
| 正确性 | ✅ 核心逻辑 28183 项断言全通过 |
| 可维护性 | ⚠️ 单文件过大，路由层缺少拆分 |
| 可测试性 | ✅ 自举测试机制设计巧妙 |
| 错误处理 | ✅ 全局兜底完善（有空catch 积压） |
| 工程规范 | ⚠️ 无 lint / 无格式化配置 |

---

## 🔴 P0：路径穿越漏洞（已验证可利用）

**位置**：`editor/server.js:154-159`

```js
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const p = path.normalize(path.join(root, decoded));
  if (!p.startsWith(root)) return null; // 防目录穿越  ← 缺边界检查
  return p;
}
```

### 问题

`startsWith` 是**字符串前缀匹配**，没有路径分隔符边界。当存在与根目录同前缀的兄弟目录时（`D:\SubFabric`vs `D:\SubFabric-secret`），`p.startsWith(root)` 会误判为真，从而放行根目录外的文件。

**同文件 419 行就有正确写法**，证明这是疏漏而非风格选择：

```js
if (ext === '.js' && (filePath === jsDir || filePath.startsWith(jsDir + path.sep))) {
//                                                    ↑ 正确：补了 path.sep
```

### 动态验证（已实跑）

```
请求:  GET /..%2fSubFabric-secret%2fsecret.txt
响应:  HTTP/1.1 200 OK
正文:  CANARY-LEAKED← 真实读到了 D:\SubFabric-secret\secret.txt
```

关键点：Node 的 `new URL()` 会规范化 `..`，所以朴素的 `/../` 反而返回 404。真正的缺口是**编码后的斜杠** —— `new URL()` 保留 `..%2f` 不解码，而 `safeJoin` 内部又调`decodeURIComponent`，两者叠加形成绕过。

**受限条件**：仅能读取与根目录同前缀的兄弟目录（`D:\SubFabric-*`）。跨盘符和无关路径会被正确拦截（实测 `/..%2f..%2f..%2fetc%2fhosts` → 403）。

### 风险评级：低

服务绑定 `127.0.0.1`（第 27 行），仅本机可访问，无法远程利用。但本机任意进程/网页（浏览器同源策略外的场景）若能诱导访问，仍可读取同前缀目录。这是本地工具的合理权衡，**但修复成本仅一行**，没有理由不修。

### 修复建议

```js
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const p = path.normalize(path.join(root, decoded));
  // 前缀匹配必须补分隔符，否则 D:\SubFabric-secret 会被误判为在 D:\SubFabric 内
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}
```

### ✅ 已修复（2026-10-04）

实际实现额外补了两处：给 `decodeURIComponent` 加了 try/catch（非法百分号编码如 `/%zz` 会抛 URIError，原先会变成 500），并写了注释说明「为什么解码要放在 path.join 之前」——这正是绕过成立的关键，不写清楚下次很容易改回去。

验证结果：10 个用例全部拦截（含原可利用的 `..%2f`、URL 编码 `%2e%2e`、跨盘穿越、非法编码），正常请求不受影响；端到端实测原 canary 请求由 `200 + CANARY-LEAKED` 变为 `403`，canary 无泄漏。

---

## 🟡 P1：2921 行单体路由函数

**位置**：`editor/server.js:1689-4610`，`handleRequest()`

一个函数承载 38 个 API 路由 + 完整 ASR/LLM 流水线（下载初稿、识别结果读写、翻译、LLM 调用、音频分片、云端引擎容错）。内部靠注释分节，但无模块边界。

### 影响
- 无法按路由粒度做单测
- 新增路由需在 3000 行函数内定位，认知负担高
- 任何局部改动都有影响全局的风险

### 建议
渐进式拆分，不必大改：

```js
const routes = {
  '/api/asr/status':  handleAsrStatus,
  '/api/waveform':    handleWaveform,
  // ...
};
function handleRequest(req, res) {
  // 解析 → 查表 → 分发；未命中则回落静态文件
}
```

优先把ASR/LLM 那几段（1885-3400）提成独立模块，这部分逻辑最独立、复用价值最高。

---

## 🟡 P1：缺少工程化配置

| 缺失项| 影响 |
|---|---|
| 无 `.eslintrc` / `eslint.config.js` | 风格漂移无约束，`==` vs `===`、分号等只能靠人眼 |
| 无 `pyproject.toml` / `requirements.txt` | Python 依赖版本不可复现（`asr/` 用到 numpy/torch/onnx 等重依赖） |
| 无 Prettier 配置 | 1507 行 CSS 与 4704 行 JS 的格式全靠人工一致 |

**注意**：`tests/jsmod/package.json` 只是为绕过 ESM 解析而生成的 `{"type":"module"}` 标记，**不是**项目包配置。项目本身无 `package.json`，依赖靠 vendor 目录（`editor/scripts/fetch-vendor.js`）下载 —— 这个模式对离线工具合理，但建议在 README 里明确写出依赖清单与版本，便于复现。

---

## 🟢 做得好的地方

### 1. 测试质量突出
```
karaoke-exhaustive.mjs  → 28183 项断言，失败 0
批量运行 16 个 .mjs 测试 → 15 通过，1 个因缺用户数据失败（非缺陷）
```

`tests/jsmod/` 的**自举同步机制**设计巧妙：以 mtime 比对自动从 `editor/js/` 重建镜像，保证测的永远是最新代码（`karaoke-exhaustive.mjs:21-38`）。避免了手工复制副本腐化的问题 —— 我初查时误以为 `project.js` 是过期快照，核实后发现机制健全。

唯一未通过的 `colorfix-test.mjs` 依赖 `projects/p-mugzcab2-09f7z/` 真实用户数据，而 `projects/` 在 `.gitignore` 中，属于环境依赖而非代码缺陷。

### 2. 错误处理有全局兜底
`server.js:4612-4630` —— 处理器异常统一回500 JSON 而非让请求悬空。代码注释显示这是真实用户报障后修的（"实测用户报过设置面板永远显示读取中"）。`uncaughtException` / `unhandledRejection` 均有兜底，符合"本地工具优先可用"的定位。

### 3. 敏感数据处理是标杆 ⭐
- bilibili Cookie 走 Windows DPAPI **密文**落盘（`secret-store.js`），并自动迁移历史明文
- 解密明文**仅存内存**，不回传前端、不进日志
- LLM API Key 对前端只暴露 `hasKey: true/false` 布尔值
- 注释明确标注了安全意图与威胁模型

在同类本地小工具中，这属于优秀水平。

### 4. 命令执行全部参数化
Python 侧无 `shell=True`；Node 侧 `spawn`/`exec` 全部用数组参数形式，无字符串拼接。无命令注入面。

### 5. 注释质量高
大量注释记录**为什么**而非**是什么**，且常带实测数据：

```js
/** 波形 PNG 宽度: 按时长自适应(约 0.25s/像素), 上限 32000(浏览器单边安全上限)。
 *  固定 2400px 时 2.4h 视频每像素 3.5s, 3 秒的字幕块只切到不到 1 个源像素 →
 *  被横向拉成"平顶柱子"(实测块内起伏系数 0.000); 32000px 后同样 3 秒块有 11 个源像素。 */
```

这种注释对后来者是高价值资产。

---

## 🟢 可改进项（不紧急）

### 1. 136 处空catch 吞异常
```
grep "catch {}" → 136 处
```
例：`try { stat = fs.statSync(filePath); } catch { return send(res, 404, ...); }`

多数是有意的"可选文件不存在"兜底，可接受。但建议至少在**非预期位置**加注释说明为何可忽略，否则后续排查疑难问题会很痛苦。项目里已有良好范例（`safeJoin` 的 `// 防目录穿越`）。

### 2. 37 处同步 IO（`readFileSync`/`writeFileSync`）
项目文件小、单机单用户场景下影响有限，**且明显是有意为之** —— `serveFile:411` 注释解释了为何小文件直接整体返回（便于编辑后立即重载）。但视频/音频等大文件路径若误用同步 IO 会阻塞整个事件循环，建议在 README 里标注"新增大文件操作请用异步 API"。

### 3. `editor/js/editor.js:280` 潜在 XSS
```js
this.modeSel.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join('');
```
全项目29 处 `innerHTML=` 中，这是**唯一没走 `esc()`** 的。当前两个调用点（`main.js:673`、`main.js:794`）传入的都是硬编码中文字面量，**无法利用**。但若将来接入 i18n 词条或动态显示模式，即成为真 XSS。建议顺手补上转义，与项目其余28 处保持一致。

### 4. 端口硬编码 8321
`const PORT = process.env.PORT ? Number(process.env.PORT) : 8321;` —— 已有环境变量覆盖，设计良好。仅提示：端口占用时的错误提示已很友好（`EADDRINUSE` 专门文案），无需改动。

---

## 附：本次审查的副作用

- 测试运行触发 `tests/jsmod/` 自举同步 + `gen-lang.mjs` 重写 `editor/lang/zh-CN.json`，属README 说明的预期行为（"测试跑完记得把镜像一起提交"）。**已 `git checkout` 还原，工作树保持干净。**
- 动态验证用的canary 目录 `D:\SubFabric-secret\` 与`tests/fixture.ass` 已删除。
- 未修改任何源码。

---

## 建议处理顺序

1. **修 `safeJoin` 边界检查**（一行，消除已验证漏洞）
2. 补 `editor.js:280` 的 `esc()`（一行，消除潜在 XSS 面）
3. 加 `eslint.config.js`（约束风格，为后续拆分打底）
4. 视需要拆分 `handleRequest`（架构改进，可延后）
5. 在 README 补依赖清单与版本（可复现性）


---

## ✅ 修复执行记录（2026-10-04）

全部 5 项已处理，实际改动如下：

| # | 项目 | 状态 | 验证方式 |
|---|---|---|---|
| 1 | `safeJoin` 路径穿越 | ✅ 已修 | 10 用例单测 + 端到端 canary（200+泄漏 → 403） |
| 2 | `editor.js:280` XSS | ✅ 已修 | 注入用例验证属性/标签均被中和 |
| 3 | ESLint 配置 | ✅ 已加 | `eslint.config.js`，实跑 321 → **0 error** |
| 4 | 依赖清单 | ✅ 已补 | README 依赖表 + `asr/requirements.txt` 注释化 |
| 5 | `handleRequest` 拆分 | ✅ 路由表 | 24 路由冒烟测试，重构前后**逐行一致** |

### 过程中发现并额外修掉的 2 个真bug

- **`new Promise(async (resolve) => ...)`**（`server.js:2085`，原 `runFetchCli`）
  async executor 抛出的异常既不 reject 也不 resolve → 调用方 `await` 永久挂起，表现为「点下载后一直转圈没反应」。已重构为 `Promise.resolve().then(...)` 链，三条错误路径（Python 探测抛错 / 无 Python / spawn 失败）实测均能正常 settle。
  *这个 bug 是 ESLint 装好后报出来的，不在原审查清单里。*

- **`/api/font-file` 的参数名**
  冒烟测试最初传 `?family=` 得到 404，核对前端 `main.js:462` 发现实际用 `?name=`。修正测试后返回 200 / 1,045,720 字节，字体正常。**这是测试自身的错，不是代码 bug**，但说明路由表拆分后参数名有被写错的可能，值得留个冒烟测试守着。

### 关于第 5 项的实际范围

按你的选择只做了**路由表拆分**，没动流水线。抽出的是 8 个「同步、无副作用」的简单端点（`/`、`/index.html`、`/api/samples`、`/api/version`、`/api/fonts`、`/api/font-file`、`/favicon.ico`、`/favicon.svg`）→ `SIMPLE_ROUTES` 表 + Map 查表。

`handleRequest` 仍是 2900+ 行：涉及 `draftJobs`/`fetchJobs` 跨请求状态的 30 个端点（波形、peaks、项目 CRUD、ASR、翻译、下载）仍按原样在函数体里。**这部分要继续拆，必须先给 HTTP 层补测试** —— 现在只有 `tools/route_smoke.mjs` 这个 24 路由的冒烟网，覆盖不了状态机。

### 新增文件

- `eslint.config.js` —— 只抓真会出错的规则（`no-undef` / `use-isnan` / `no-cond-assign` 等），**不配 indent/quotes/semi**：项目 JS 是浏览器原生 module + Node 混用、无构建步骤，2/4 空格与单双引号混用是有意的，强推风格只会产出几百条与正确性无关的噪音。
  配置里记录了两条**刻意不启用**的规则及原因（`no-restricted-properties` 会误报 `Object.prototype.hasOwnProperty.call` 这个推荐写法）。
- `tools/route_smoke.mjs` —— 24 路由冒烟网，断言「有响应 / 非 500 / 穿越被拦」，为路由层改动兜底。POST 端点刻意不碰（多数会写盘或起进程，冒烟测试不该有副作用）。

### 遗留（未做，需你决定）

- `handleRequest` 余下 2900 行未拆（见上）
- 21 个 `no-unused-vars` 警告：多为历史遗留的死变量（如 `server.js` 的 `MODEL_PATTERNS`、`FETCH_QUALITY_CHOICES`）。清理前建议逐个确认是否真是死代码
- 136 处空 `catch`、37 处同步 IO：核实后确认多为有意设计，非缺陷，仅记录

---

## 追加：清理 21 个 no-unused-vars 警告（同日完成）

ESLint 装好后是 321 → **0 error / 21 warn**。这 21 个逐个核实后处理，**21 → 2**。

### 删除的（19 个，全部经 grep 确认零引用）

| 文件 | 变量 | 性质 |
| --- | --- | --- |
| main.js | `srtPlainText` `stripInlineTags` `applyDom` | 死 import。⚠️ `applyDom` 在 `i18n.js:56` 被内部自动调用，**只删 main.js 的 import，别动定义** |
| project.js | `busyPrep` `busyDraft` | 重构遗留，已被下面的 `running`/`paused`/`failed` 体系取代 |
| project.js | `stateHtml` | **抽了函数忘了换调用点** —— 1117-1129 行把同样逻辑内联手写了一遍 |
| project.js | `glRowCount` | 逻辑已被1428 行内联循环取代 |
| timeline.js | `CHIP_W` `WORD_MIN` | 纯常量声明，无引用 |
| timeline.js | `running` | 后续改用 `r.status` 直接判断 |
| server.js | `MODEL_PATTERNS` `dlAnyRunning` `FETCH_QUALITY_CHOICES` `parseJsonArray` | 重构遗留的死常量 / 死别名 |
| server.js | `n` `out` `buf` `i` `v` | 局部：计数器 / map 下标 / 未读缓冲区 |

### 保留的（2 个，是未完成的功能预留，不是死代码）

`timeline.js:1457-1459` 的 `isPlay` / `textColor` —— 为「播放头所在块高亮」预留，绘制逻辑还没接上。**删了会连带删掉 `textOnTranslucent()` 整个工具函数**，且会抹掉功能实现的痕迹。已加注释说明如何接上、以及为何先别删。

### 顺带发现的内存浪费

`runWhisperCpp` 里的 `let out = ''` 一直累加 whisper.cpp 的 stdout，但**从头到尾没人读**（转写结果走 whisper 自己的 `.json` 文件）。长音频能白攒几百 MB。已删并加注释说明。

### 两个"死代码"里藏着的重构遗留（值得留意）

1. **`stateHtml`** —— 抽象出来了却没替换掉手写的老逻辑，说明 `renderAsrModels` 当初重构没做完。
2. **`FETCH_QUALITY_CHOICES`** —— 内容已在 `index.html:906-912` 硬编码了一份（还多了 `audio` 选项），服务端这份是旧副本。删除时保留了取值契约的注释（`best`/`2160`/`1080`/`720`/`480`/`360`/`audio` ↔ `selector.py`）。

### 验证

- 4 个改动文件 `node --check` 全过
- 15/15 测试全过（`karaoke-exhaustive` 28183 断言）
- 24 路由冒烟逐行与基线一致；`main.js` 体积 187927 → 184161 字节（删 import 所致），仍正常加载

### ⚠️ 踩坑：注释里写 `eslint-disable` 会被当成规则名

想局部禁用 lint 规则时，**注释正文里出现 `eslint-disable` 字样会被 ESLint 解析成规则声明**，报 `Definition for rule '...' was not found`。要么用真正的块注释 `/* eslint-disable no-unused-vars */`（且不能与代码同行），要么像本次一样改写注释措辞、接受这 2 个警告存在。

