# SubFabric 代码质量审查报告（第三轮 · 安全专项 + 第四轮 · 全面清扫）

- **审查对象**：`EndiVee233/SubFabric` @ `main` `2bd7a81`（v2.3.0；PR #2 合并后的现状）
- **代码量**：约 96,000 行（JS + Python + HTML + CSS，含 `tests/jsmod` 镜像约 27,000 行）
- **审查日期**：2026-10-11
- **方法**：本轮**全部结论均经动态实测复现**（起真服务 + 构造真实攻击包 + curl 验证），非纯静态阅读
- **与前两轮的关系**：
  - 第一轮 `docs/CODE_REVIEW.md`（2026-10-04）：发现 `safeJoin` 路径穿越 P0（已修）
  - 第二轮 `docs/CODE_REVIEW_2026-10-10.md`（2026-10-10）：10 项高危，本轮**逐项验收**（见 §三）
  - 本轮为 PR #2 合并后的**安全专项复查**，聚焦"导入 / HTTP 边界 / 静态服务"这三块前两轮未覆盖的面
- 本文件处理完（修复项落地后）可删除，惯例同前两轮

---

## 总评

**底子依然好，但安全边界有三处系统性缺口，其中一处是可直接利用的任意文件写入。** 前两轮的结论（`safeJoin` 修得扎实、注释"写为什么"的文化、模块化与测试）在本轮实测中再次得到验证。但本轮把攻击面从"HTTP 路由"扩展到"**导入的数据**"后，发现了一条完整的 `恶意包 → 任意路径写入` 链路 —— 这类漏洞前两轮都没查，因为前两轮的输入模型是"用户自己在浏览器里操作"，而项目包是**可来自他人**的数据。

| 维度 | 评价 | 一句话 |
| --- | --- | --- |
| **安全性** | 🔴 | **1 项可直接利用的任意文件写入（已复现）** + Origin 校验可绕过 + 静态根覆盖整个仓库 |
| 正确性 | ✅ | 65/68 测试通过；3 项失败均为环境/行尾符问题，非产品回归 |
| 可维护性 | ⚠️ | 与第二轮一致（`server.js` 8,277 行；段函数粒度不均） |
| 工程化 | ⚠️ | 与第二轮一致：**仍无 CI**；无统一测试入口；依赖下载无哈希 |

---

## 一、本轮新发现的安全问题（按优先级）

### 🔴 新-1【高危 · 已实测复现】导入项目包 → 任意文件写入（跨出项目目录）

**这是本轮最值得优先修的一项。** GPT 的外部审查也指出了这一点，我做了完整动态复现，确认成立。

**涉及三处（形成一条完整链路）：**

| # | 位置 | 作用 |
| --- | --- | --- |
| ① | `editor/project-pack.js:86-98` `remapMeta()` | `Object.assign({}, meta)` **整份拷贝**，只覆写 id/时间戳/video/prepare/imported；`meta.subtitle.file` 等路径字段**原样保留** |
| ② | `editor/server.js:7448-7516` 导入处理器（7486 调 `remapMeta`，7493 `writeMeta`） | 把包里的 `project.json` 解析后交 ①，落盘为该项目元数据 |
| ③ | `editor/server.js:8045-8059` 字幕保存 / `4349-4351` 逐词写回 | `path.join(projDir(id), meta.subtitle.file)` —— **没有任何校验** |

**实测复现（本机实跑，非推演）：**

```
① 构造恶意包：project.json = {"subtitle":{"file":"../../poc-proof.txt"}} + subtitle.ass（用于通过清单校验）
② POST /api/projects/import-pack          → {"ok":true,"id":"p-mv3h55qh-8e5z7"}
   导入后 meta.subtitle = {'file': '../../poc-proof.txt', ...}     ← 路径原样保留
③ POST /api/projects/p-mv3h55qh-8e5z7/subtitle  （body = 攻击者可控内容）
   → {"ok":true,"savedAt":"2026-10-11T07:00:57.164Z"}
④ 结果：K:\SubFabric\poc-proof.txt 被创建，内容 = 请求体
   -rw-r--r-- ... 34 ... /k/SubFabric/poc-proof.txt
   PWNED_BY_PATH_TRAVERSAL_1791702056
```

**影响**：写入**完全由攻击者控制**（保存接口把请求体整体落盘），且**跨出了项目沙箱**。用更多 `..\` 可写到该盘任意位置（Windows 上 `path.join` 不能跨盘符，故限于同一盘）。触发条件：受害者**导入一个别人给的包** + 该项目的字幕被保存/重校对一次（编辑器是自动保存的）。

**同一根因的其它受影响点**（读/写均未校验 `subtitle.file`）：
- `server.js:3618-3620` `readSavedWordColor`（读任意文件）
- `server.js:4349-4351` `applyRealignToProject`（**写**）
- `server.js:7687-7692` `sentences` 诊断接口（读任意文件）

**建议修法**（三选一，推荐全做）：
1. **入口白名单化**：`remapMeta` 不再整体拷贝 —— 只按允许清单重建 `{name, kar, translate, subtitle, audio, peaks}` 等已知字段，且 `subtitle.file` 只接受 `subtitle.ass` / `subtitle.srt`。
2. **收口一个校验函数**：`function safeProjectFile(id, name)` —— `path.resolve` 后断言 `startsWith(path.resolve(projDir(id)) + path.sep)`，所有 `projDir + 文件名` 的读写点统一改走它（含上表 4 处）。
3. **补回归测试**：恶意路径 / 绝对路径 / 合法文件名三个用例（可直接照本轮 PoC 写）。

---

### 🟠 新-2【中危 · 已实测】Origin 校验不是真正的同源校验

**位置**：`editor/server.js:2699` `LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i`，判定点在 `8136-8145`。

只判断 Origin 是否属于 loopback，**不看端口、不比对服务自身的源**。实测：

```
POST /api/projects/import-pack
  Origin: http://evil.example.com   → 403   （基线：外源被拦）
  Origin: http://localhost:9999     → 400   （≠403 → 通过校验，仅因空 body 报错）
  无 Origin                          → 400   （通过）
```

即：本机其它端口上的**任意页面**（另一个本地服务、被 XSS 的本地页）都能对本服务发起写请求。服务只监听 `127.0.0.1`，风险限于本机，但"本机其它进程可伪造"确实成立。

**建议**：把 Origin 与服务实际监听的 `http://127.0.0.1:${PORT}`（以及 `localhost` 同端口）做**精确比对**，而不是"是否 loopback"；对无 Origin 的写请求，考虑要求一个自定义头（如 `X-SubFabric: 1`，跨源表单发不出自定义头）。

---

### 🟠 新-3【中低危 · 已实测】静态服务范围覆盖整个仓库根

**位置**：`editor/server.js:8162-8164` 兜底 `safeJoin(ROOT, pathname)` → `serveFile`；`ROOT = path.resolve(__dirname, '..')`（`:77`，即仓库根）。`serveFile`（`:567-620`）**没有扩展名白名单**，只挡目录。

`safeJoin` 本身是**对的**（`../` 与 `%2e%2e%2f` 均被拦，实测 404/403），问题在**范围**。实测可达：

```
GET /.git/config          → 200（吐出真实 git 配置）
GET /.git/HEAD            → 200
GET /.git/logs/HEAD       → 200
GET /projects/<id>/project.json → 200（用户项目数据）
GET /tools/videoedit_probe.mjs  → 200
```

`.git/` 暴露意味着可据以还原完整源码与历史；`projects/` 是用户数据；`asr/settings.json` 里虽是密文（`secret-store` 做得好），但配置结构仍暴露。

**建议**：把静态根从"仓库根"收窄为**前端资源白名单**（`editor/` 下的 html/css/js/字体 + `vendor/`），显式拒绝点开头文件与 `projects/ asr/ logs/ tools/ tests/ docs/ build/`。一条 `if (name.startsWith('.') || BLOCKED_DIRS.includes(top)) return 403` 即可覆盖绝大部分。

---

### 🟠 新-4【中危】依赖下载未固定版本 + 无完整性校验

**位置**：`editor/scripts/fetch-vendor.js:19-20, 100-103`

```js
const BASE = 'https://cdn.jsdelivr.net/npm/libass-wasm@4.1.0/dist/js';   // ✅ 已固定版本
const FONT_URL = '.../notofonts/noto-cjk@main/Sans/.../NotoSansCJKsc-Regular.otf'; // ⚠ @main 未固定
// 校验只有体积下限：if (buf.length < f.min) ...
```

字体走 `@main`（内容随时可变），且**只按体积校验、无 SHA-256**。libass-wasm 本体虽已固定版本，但同样只校验体积。

**建议**：字体改固定 tag/commit；为四个文件各记 SHA-256，下载后校验（`crypto.createHash('sha256')`）。这是典型的供应链完整性缺口，成本很低。

---

## 二、对 GPT 外部审查报告的核对结论

对方报告质量不错，方向全对。逐条核对（**这是本轮的主要增量**：它自己声明"没有实际跑过验证"，我补上了）：

| GPT 的结论 | 核对结果 | 说明 |
| --- | --- | --- |
| P1 导入项目包可任意文件覆写（`remapMeta` / 导入 / 字幕自动保存） | ✅ **成立，已复现** | 三处位置判断准确；我补充了 `4349` 写回、`3618/7687` 读取两处同源点，并给出了完整 PoC |
| P2 Origin 不是真正同源校验 | ✅ **成立，已实测** | `localhost:9999` 确实通过；风险限于本机，定级 P2 合适 |
| P3 静态服务范围过大 | ✅ **成立，已实测** | 补充：`.git/` 实测可读（比"settings.json"更严重，可还原源码）；`safeJoin` 本身没问题 |
| "路径穿越修补已有落实（`safeJoin`）" | ✅ 正确 | 实测 `../` 与编码斜杠都被拦 |
| "核心逻辑有独立模块与测试" | ✅ 正确 | 68 个 `.mjs` + 大量断言，设计确实好 |
| 依赖完整性（fetch-vendor @main / 无 SHA-256） | ✅ **成立** | 见 §一 新-4 |
| 无 CI 自动化 | ✅ 正确 | `.github/workflows/` 不存在 |
| `server.js` 约 8,100 行、建议不拆 | ✅ 正确（8,277 行） | 与第二轮判断一致 |
| 建议修复顺序 | ✅ 基本认同 | 建议把"字幕文件路径白名单"提到最前，它是 P1 的根治点 |

**GPT 报告的一处偏差**：它把 `audio.file` / `peaks.file` 也列为同一风险点。核对后：`audio.wav` / `peaks.bin` 在导入时被 `shouldPack`/`isDerived` **主动拒绝落盘**（`project-pack.js:34,49`），所以经"导入包"这条路**不可达**；但"路径未校验"这个模式本身确实存在，作为纵深防御补上无妨。

---

## 三、第二轮高危项验收（逐项实测，全部已落地）

| 第二轮编号 | 修复点 | 验收证据 |
| --- | --- | --- |
| 高-1 | `stamp()` → `apStamp()` | `server.js:3442/4231/4237` 已用 `apStamp()` |
| 高-2 | `probeDuration` 双回调 / 递归 | `server.js:341-342` 已改走 `finish()`，并留了成因注释 |
| 高-3 | 批量空区间挂 30 分钟 | `server.js:5108-5114` 已按 batch 跳过并计 warning |
| 高-4 | 字幕 500 污染 `lastSavedText` | `project.js:318/393` 已有 `!response.ok` 检查 |
| 高-5 | 读不存在的 `state.asrStatus` | `project.js:1654` 已修，并附注释说明原委 |
| 高-7 | overlay 重叠 cue 漏显示 | `overlay.js:23-25,56` 已实现 `_maxEnd` 前缀最大 end |
| 高-8 | `asr_npu.py` OOM 回归 | `asr_npu.py:56` `from asr import frame_energies`，`:344/772` 已分块 |
| 高-9 | Cookie 明文进 argv / 可预测临时文件 | `server.js:3141` 用 `--cookies-file`；`6269` 用 `mkdtempSync` |

**结论：第二轮 10 项高危已全部落地且未回退。** 这也印证了本轮 §一 的价值 —— 前三轮（含 GPT）都没覆盖"导入数据"这一攻击面。

---

## 四、测试与工程化现状（本轮实跑）

**全量实跑** `tests/*.mjs`（68 个文件，其中 `gen-lang.mjs` 实为**生成器**不是测试）：

```
PASS=65  FAIL=3
失败：carry-confidence-test.mjs / colorfix-test.mjs / word-boundary-test.mjs
```

三项失败**均非产品回归**，但前两项值得顺手修：

| 测试 | 原因 | 性质 | 建议 |
| --- | --- | --- | --- |
| `carry-confidence-test.mjs` | 从 `server.js` 文本切片时用 `'\n  }\n'`（LF），而 Windows 默认 `core.autocrlf=true` 克隆出的是 **CRLF** → `indexOf` 返回 -1 → 抽出空代码 → `export 'carryConfidence' is not defined` | **行尾符健壮性缺陷**（默认 Windows 克隆必失败） | 切片前 `SRC.replace(/\r\n/g, '\n')`，或用 `/\n  \}\r?\n/` |
| `colorfix-test.mjs` | 缺夹具 `projects/p-mugzcab2-09f7z/subtitle.ass`（从未入库） | 环境 | 无夹具时 `skip` 而非 fail（其它测试已有此惯例） |
| `word-boundary-test.mjs` | 依赖 `asr/runtime-python/python.exe`（内嵌 Python，未安装） | 环境 | 同上，缺运行时优雅跳过 |

**另外两点实测观察**：
- `tests/gen-lang.mjs` 会**重写** `editor/lang/zh-CN.json`；跑一次后该文件多出 **811 条**键 —— 说明**已提交的 i18n 字典比源码少约 800 条**（第二轮已提"文案绕过 i18n"，本轮给出了量级）。
- 仓库**无 CI**（`.github/workflows/` 不存在），上述"行尾符""缺夹具"这类问题因此无人自动发现。

---

## 五、建议修复顺序

**阶段 0（立即，都是小改，风险极低）**
1. **新-1 路径白名单**：`remapMeta` 改按清单重建 + 收口 `safeProjectFile()`；4 个读写点改走它；补 3 个回归用例。**这是本次唯一"可直接利用"的漏洞，优先做。**
2. **新-2 Origin 精确比对** + 写请求要求自定义头。
3. **新-3 静态根收窄**到前端资源白名单，拒绝点文件与 `projects/ asr/ logs/ tools/ tests/ docs/`。
4. **新-4** 字体固定版本 + 四文件 SHA-256 校验。
5. 顺手：`carry-confidence-test` 行尾符归一；`colorfix`/`word-boundary` 缺依赖时 skip。

**阶段 1（本周）**
6. **加 CI**（GitHub Actions）：`node --check` 全 JS + `eslint` + 无外设测试 + `ruff`。这一步能自动挡住"行尾符""缺夹具""导入回归"三类问题，性价比最高。
7. 统一测试入口 `tests/run-all.mjs`（第二轮已列，仍缺）。

**阶段 2（承接第二轮）**
8. 第二轮"分阶段改进计划"的阶段 2/3 未完成项（Python `common.py` 提取、`server.js` 段内提辅助函数、`main.js` 拆子系统、i18n 补齐）继续推进。

---

## 六、值得保持的优点（避免误改）

- **注释"写为什么 + 实测数据"的文化**：本轮读到的每一处安全代码（`safeJoin` 的 `%2f` 说明、`probeDuration` 的双回调成因、`secret-store` 的 DPAPI/AES 分级）都自带"踩过什么坑"，交接价值极高。
- **`safeJoin` / Host 校验 / `secret-store`**：前两轮建立的安全底座在本轮实测中依然可靠（编码斜杠被拦、密钥密文落盘）。
- **fork 模块"一份 ESM 双端复用"**：算法只有一份，`tests/jsmod` 镜像自动同步 —— 设计是对的。
- **每修一个坑留案底注释**：第二轮 10 项修复全部落地且未回退，说明"修复 → 留注释 → 后续回归测试"的闭环真的在运转。
- **`import-pack` 已有若干护栏**：512MB 上传上限、单文件 64MB 上限、派生文件拒收、`validateManifest` 清单校验 —— 缺的只是**路径字段这一环**，补上即完整。

---

*本报告全部安全结论均经本机动态实测复现（起服务 + 构造真实攻击包 + curl 验证），现场已清理、工作树已还原至 `2bd7a81`。建议处理顺序：阶段 0 全部 → 阶段 1 第 6 项（CI）。处理完成后按惯例删除本文件。*

---

## 七、第四轮：全面 bug 清扫（同日，全部已修）

第三轮之后又做了一轮"把能发现的 bug 全修掉"。方法上**引入了 ESLint 静态扫描** —— `no-undef`（用了不存在的变量）正是这类项目最容易出真 bug 的一类，而它偏偏被一个配置疏漏挡在了门外。

### 7.1 ESLint 配置 bug：10 个文件**从未被检查过**（已修）

`eslint.config.js` 的 Node 块写的是 `files: ['editor/server.js', 'editor/*.js']` + `sourceType: 'commonjs'`，
而 `editor/` 下有 10 个"双端复用"模块（浏览器 `import` + Node `require(esm)` 同一份）其实是 **ESM**：

> `align.js · asr-service.js · ass-group.js · danmaku.js · hotwords.js · mt-local.js · reflect.js · region-merge.js · region.js · repair-words.js`

含 `export` 的文件被当 commonjs 解析 → 直接报 `import/export may appear only with sourceType: module`，
**整个文件等于没被 lint**。拆成"CJS 显式白名单" + "共享 ESM 模块（补 node 全局）"两块后，这 10 个文件全部正常解析并通过检查。

### 7.2 前端真 ReferenceError（已修）

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `editor/js/project.js:1463,1464,1485,1490` | `escapeHtml` **未定义**（它只从 util.js 导出给 editor.js）。`perfRenderApplied`/`perfRenderResult` 每次渲染"双引擎/性能测试"结果都抛 ReferenceError，被外层 catch 吞成"读不到设置" | 从 `./util.js` 补 `import` |
| `editor/js/project.js:1257` | `logOp` **未定义**（只在 main.js 模块内定义，未导出）。`typeof logOp` 恒为 `'undefined'` → "加进热词表"这条操作日志**从来没记上** | 经 `ctx` 从 main.js 传入（与 `toast` 同路） |

### 7.3 其它真 bug（已修）

- `editor/js/main.js:6770` **重复对象键 `errors`** —— 同一对象里先 `errs.slice(-6)` 后又 `errs.slice(0, 20)`，后者静默覆盖前者。删掉多余的那个（保留当前生效语义，无行为变化）。
- `editor/js/main.js:1607` **无效的 TDZ 守卫** —— `typeof realignEls !== 'undefined'` 中 `realignEls` 是模块级 `const`，而 `typeof` 对 **TDZ 里的 const 会抛 ReferenceError**，根本挡不住。改为 `var`（提升并初始化为 `undefined`）才真的安全，注释同步更正。
- `editor/js/util.js:72` `escapeHtml` 不转 `'` → 补 `&#39;`（单引号属性场景的纵深防御；显示等价）。

### 7.4 测试健壮性（3 项失败 → 0）

| 测试 | 根因 | 修法 |
| --- | --- | --- |
| `carry-confidence-test.mjs` | 用 `'\n  }\n'` 从 server.js 切片，但 Windows 默认 `core.autocrlf=true` 克隆出的是 **CRLF** → `indexOf` 返回 -1 → 抽出空代码（**默认 Windows 克隆必失败**） | 切片前 `replace(/\r\n/g, '\n')` |
| `colorfix-test.mjs` | 读作者本机项目夹具（不入库）→ ENOENT。它本身**无断言**，是诊断脚本 | 缺夹具时优雅跳过 |
| `word-boundary-test.mjs` | 行为段依赖内嵌 Python（"一键安装"才下载，约 60MB） | 缺失时跳过行为段，静态断言照跑 |

### 7.5 验证结果

- **ESLint：17 error → 0 error**（剩余 15 个 warning 均为原有的未使用变量，非 error）。
- **全量测试：68 通过 / 0 失败**（修复前 65 通过 / 3 失败）。

---

## 八、第七轮：无头浏览器实测（同日，抓到 2 个静态查不出的 bug）

第七轮之前的所有结论都来自**静态分析**（读代码 / ESLint / ruff / 单测）。这一轮补上了**真实浏览器实测**：
用 CDP 驱动无头 Edge 打开真实页面、读控制台、执行断言。

**环境技巧**：本项目 `tools/cdp_probe.mjs` 是从 Node 里 `spawn` Edge 的，而当前沙箱禁止 node 派生子进程
（`spawnSync` 连 `cmd.exe` 都 EBUSY）。所以把两步拆开：**bash 起服务与浏览器**，
Node 只用内置 `WebSocket` 做 CDP 连接与求值 —— 零依赖。

### 8.1 【真 bug·已修】`/api/asr/realign-settings` 一律 404 → 「逐词重对齐设置」读写全废

探针在控制台抓到：

```
[HTTP 404] http://127.0.0.1:8399/api/asr/realign-settings
```

**根因**：这个处理块原先落在 `handleProjectsRoutes` 里，被
`pm = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})(?:\/([a-z][a-z-]*))?$/` 匹配 ——
也就是只有 `/api/projects/<id>/realign-settings` 能命中。
而前端 `project.js` 的 `realignLoad()` / `realignSave()` 调的是 `/api/asr/realign-settings`。

**后果**（对用户）：面板读不到设置（`realignLoad` 的 catch 静默吞掉）；
保存时 `realignSave` 抛错 → 弹「重排设置保存失败: not found」。**设置根本存不进去。**

**修法**：处理块本身**完全不使用 project id**（是全局 ASR 设置，存 `asr/settings.json` 的 `realign` 段），
所以搬到 `handleAsrRoutes`、改成 `pathname === '/api/asr/realign-settings'`，
与其它全局 ASR 设置（`correct` / `confidence` / `set-dir` …）同处。

**验证**：`GET` → 200（返回真实设置 + 本机语音列表）；`POST` → 200 `{ok:true}`；重跑探针 404 消失。

**测试同步**：`tests/log-panel-test.mjs` 里那条断言原本钉的是 `action === 'realign-settings'`
—— 它**钉住了错误的位置**。已改成断言"挂在 `/api/asr/` 下"，并新增一条**交叉核对**
（前端 `project.js` 必须调同一个路径），防止再被搬回去。

### 8.2 【可诊断性·已修】资源 404 被报成 `[JS错误]  @ :0:0`

`editor/index.html` 的全局错误上报用 `capture: true` 监听 `error`，因此
`<script>` / `<link>` 加载失败也会走到这里；而这类事件的 `message/filename/lineno` **全是空**，
日志里只剩一行 `[JS错误]  @ :0:0` —— 完全看不出是哪个文件挂了。

实测：没跑 `fetch-vendor.js` 时 `/editor/vendor/subtitles-octopus.js` 404，
服务端日志里就只有这么一行（本项目本来就要求先跑 fetch-vendor，但报错信息不该这么无用）。

**修法**：资源类错误改用出错元素自身的 `src`/`href` 来报。
**验证**：日志现在输出
`[JS错误] 资源加载失败 @ http://127.0.0.1:8399/editor/vendor/subtitles-octopus.js?v=…`。

### 8.3 这一轮同时确认「没问题」的部分

- 页面正常加载（`#app` 6 个子节点、标题正确）→ 第七轮改的 `project.js` 的 `import` 没破坏模块图；
- 设置页打开正常，**双引擎分工区块渲染出了内容**（`dual-ratio-row` 有文本）；
- `/api/asr/perf/state` → 200；
- `window.__diag` 存在，且服务端日志确实收到诊断快照（3704 字节）→ 重复键修复后的路径真的在跑；
- **全程没有任何 `[exception]`** —— 前端 ReferenceError 类问题确已消除。

**仍受环境限制未验证**：ASR 完整链路（需 GPU/模型）、并发与长会话行为。
