# SubFabric 代码审查 + 功能建议（第二轮）

- **审查对象**：`endivee233/SubFabric` @ `4d50c68`（v2.1.11，2026-10-08 全量克隆）
- **与上一轮的关系**：`CODE_REVIEW.md` 覆盖 `b3848af`（v2.1.7 之后）。本轮先复核上一轮修复是否仍生效，再做新一轮审查。
- **方法**：三路并行静态审查（Python 侧 / Node 后端 / 前端）+ 全部结论逐条人工复核（对照当前源码行号）+ 测试实跑。
- **代码量**：约 40,400 行（JS + Python + HTML + CSS，不含镜像与工具）

---

## 总评

| 维度    | 评价                                                   |
| ----- | ---------------------------------------------------- |
| 功能完整度 | ✅ 编辑/预览/导出/初稿流水线闭环，特效体系（Glow/Grow/Fade）完整            |
| 正确性   | ✅ 核心逻辑测试强：`karaoke-exhaustive` 28183 项断言 0 失败；其余套件全绿 |
| 安全性   | ⚠️ 本地服务边界偏松：密钥回显、Origin 校验仅 1 处、`/api/media` 任意路径读   |
| 健壮性   | ⚠️ 若干竞态与子进程管理缺口（不影响日常，长会话/极端网络下会暴露）                  |
| 性能    | ⚠️ 前端每帧全量重绘、长音频内存峰值高；日常规模无感                          |
| 可维护性  | ✅ 注释质量依旧出色（记录"为什么"与实测数据）；路由表拆分已落地                    |

**结论**：工程质量稳定，上一轮 5 项修复全部仍在生效。本轮新发现 4 个值得尽快处理的安全/边界问题 + 一批中低优先级缺陷，均不阻塞使用。

---

## 一、复核：上一轮修复仍在生效

| 项                      | 位置                                            | 状态                    |
| ---------------------- | --------------------------------------------- | --------------------- |
| `safeJoin` 前缀边界 + 编码防御 | `editor/server.js:157-166`                    | ✅ 边界检查、try/catch、注释齐全 |
| 模式下拉 XSS 转义            | `editor/js/editor.js:281`                     | ✅ 已用 `escapeHtml`     |
| 路由表拆分                  | `editor/server.js:1703/1762`（`SIMPLE_ROUTES`） | ✅ 存在且被使用              |
| ESLint 配置              | `eslint.config.js`                            | ✅ 存在                  |

---

## 二、本轮发现

### 🔴 P1：敏感信息与本地服务边界（4 条，建议尽快）

#### 1. GET `/api/translate/config` 明文回传 LLM API Key

- **位置**：`editor/server.js:4156-4161`（GET 返回 `cfg: c`）→ `translateCfg()` `server.js:742` 返回 `apiKey: t.apiKey`；前端 `editor/js/project.js:1043` 直接把它填进输入框。
- **问题**：同一对象里已有 `hasKey: !!t.apiKey`（742-749），说明本意是"只暴露有无"；但 `apiKey` 字段把明文也带出去了。任何能访问 `127.0.0.1:8321` 的本机页面/进程（结合第 2 条）都可读走 Key。
- **落盘面**：`saveTranslateCfg` → `writeAsrSettings`（`server.js:956-961`）把 Key 明文写进 `asr/settings.json`。该文件已在 `.gitignore` 中（不会误提交），但项目对 bilibili Cookie 用的是 DPAPI 密文（`secret-store.js`），标准不一致。
- **修复**：GET 只回 `hasKey`；前端编辑时留空 = 不修改（提交时跳过空值）；存储改走 `secret-store.encrypt/decrypt`（与 Cookie 同款）。两处改动都不大。

#### 2. 全服务仅 `/api/quit` 做了 Origin 校验

- **位置**：`server.js:4285` 是全文件**唯一**一处 `headers.origin` 校验（在 `/api/quit` 内，4284-4293）。
- **影响端点（抽查实证）**：
  - `DELETE /api/projects/:id`（`server.js:4591-4600`）——删整项目目录，无校验；
  - `POST /api/asr/set-dir`（`server.js:4074-4094`）——`mkdirSync` 任意路径并持久化，无校验；
  - `POST /api/projects`（4331）、字幕覆写（4602）等写操作同样无校验。
- **风险**：恶意网页经 **DNS rebinding** 拿到"同源"后可执行上述操作、读走第 1 条的 Key。服务绑定 `127.0.0.1` 挡不住 rebinding（浏览器视角它就是同源）。
- **修复**：加一个全局中间件：`Host` 不属于 `127.0.0.1/localhost/[::1]` 直接 403；写操作再加 Origin 白名单（复用 4287 的正则）。这是本地桌面应用防 rebinding 的最低成本手段。

#### 3. `/api/media` 可读取任意绝对路径的视频文件

- **位置**：`server.js:4304-4311`。`path.normalize(p)` 后只校验 `isFile()` + 视频扩展名，**没有限定在项目/允许目录内**。
- **影响**：本机任意 `.mp4/.mkv/...`（含其它盘符）都能被读走。叠加第 2 条可被同源页面拉取。
- **修复**：改为"登记制"——只允许项目 meta 里记录过的路径，或校验路径在本机已授权目录前缀内。

#### 4. `fetchSiteOf` 子串匹配 → URL 校验可绕过

- **位置**：`server.js:2054-2059`。`u.indexOf('bilibili.com') >= 0` 这类判断，`https://evil.com/bilibili.com`、`http://127.0.0.1/x?youtube.com` 都能通过；随后原样交给 yt-dlp 下载（2127），且附带用户可控 `--proxy`。
- **风险**：服务器可被诱导访问任意 URL（SSRF / 内网探测 / 任意下载落盘）。
- **修复**：`new URL()` 解析后对 `hostname` 做白名单（`bilibili.com`、`b23.tv`、`youtube.com`、`youtu.be` 及其子域精确匹配）。

### 🟡 P2：中优先级缺陷（7 条）

1. **`frame_energies` 大索引矩阵内存**：`asr/asr.py:110-112` 广播生成 `(n_frames, frame)` 的 int64 索引矩阵。1 小时音频 ≈ 36 万帧 × 320 采样 = 1.15 亿索引（约 0.9GB 索引 + 0.45GB float 切片 + 平方临时量，峰值约 1.8GB）；3 小时约 5GB+，长视频有 OOM 风险。调用点：`split_chunks`（457）、`refine_word_ends`（470），即 parakeet 主链路每次全量跑。**修复**：按块循环计算 RMS 或 `sliding_window_view`。
2. **SRT 中英合并：英文条目少时直接 `break` 丢中文行**：`main.py:982-983`。条目数不等时（975 行有警告），多出的中文行被整段丢弃。**修复**：缺英文时输出中文单行。
3. **中文行被硬编码白色覆盖**：`main.py:990` 给中文正文前置 `{\c&HFFFFFF&}`，而行内覆盖优先于样式 → `zh_color`（默认 `#FFFF00`，`main.py:107`）在 SRT→ASS 模式下**失效**。存疑：可能是有意设计，但默认值与行为矛盾，建议改用配置色或在代码里注明意图。
4. **子进程登记不完整 → "完全退出"杀不干净**：`server.js:36-47` 包装了模块级 `spawn` 并登记 `CHILDREN`，但 `server.js:1314`（函数内 `require` 局部 `spawn`，遮蔽了包装器）与 `editor/audio-slice.js:8/18/36`（独立模块自建 spawn）绕过登记。注释里"退不干净"的教训正是指这个。**修复**：1314 改回外层包装器；`audio-slice.js` 用依赖注入（传 spawn 或注册函数）——它"独立以便探针复用"的初衷可以保留。
5. **请求体 256MB 全量进内存**：`server.js:4332`（项目创建）、`4603`（字幕覆写）上限 256MB，`readBody` 全量 `Buffer.concat`。大字幕/大请求会瞬间吃几百 MB。**修复**：字幕覆写可流式写 `.tmp`（现逻辑已经是 tmp+rename，改造面小）。
6. **波形加载无"视频代次"守卫**：`editor/js/main.js:252-286`（及 `uploadWaveform:287`）。`await waitDuration()` / fetch 返回后直接 `setPeaks`；切视频期间旧请求返回 → 新视频挂上旧波形。**修复**：进入时记 `state.videoUrl`，回填前校验未变。
7. **`rbReRecog` await 后再用 `state.project`**：`main.js:3087` 判空 → `3092` await fetch → `3096` 直接用 `state.project.id`。await 期间切项目会报错或指向错项目。**修复**：await 后重取并校验 `id` 一致。

### 🟢 P3：低优先级 / 建议（6 条）

1. **`fmtTime` 进位未并入秒**：`editor/js/util.js:3-11`。`math.floor` 秒 + 小数独立 `toFixed(3).slice(2)` → `x.9995~x.9999` 渲染成 `x.000`（如 `9.9996` → `00:00:09.000`，应为 `00:00:10.000`）。影响 UI 与 `fmtTimeSrt` 导出。同文件 `fmtTimeAss:22-31` 已有正确做法（整体取整）且注释解释了原因 —— 直接照抄即可。
2. **前端主循环每帧全量重绘**：`main.js:3924-3942` 每帧无条件 `timeline.draw()`；`timeline.js:893-926` 内部无脏检查，clearRect + 标尺/波形/胶片/所有可见块全量重画。暂停静止时也跑满 60fps，长会话持续耗电。**修复**：加脏标记（暂停且无数据/布局变化时跳过绘制）。
3. **`reconcileKaraoke` 不动点迭代**：`main.js:2194-2208`，`while(changed)` 每轮全量 `computeOverlapRows()`（O(n log n)），最坏 O(k·n log n)。每次拖动结束/编辑都会调用。批量操作大项目时可感知。**修复**：限制轮数或一次性拓扑还原。
4. **子进程双重回调/重复重试**：`probeDuration`（188-194）`error` 与 `close` 都会调 `cb`，无 settled 标志；`renderWaveform`（217-223）超时路径 `done(err)` 后 `close` 再次 `done` → 可能重复重试（一次超时最多 2 次重试、3 次执行）。**修复**：加 `settled` 布尔。
5. **wheel 解压的 Zip Slip 余量**：`asr/fetch/ytdlp.py:141` 只挡 `startswith("..")`，`yt_dlp/../../x` 这类成员能通过 `top` 校验（143-146）写到包目录外。来源是 PyPI HTTPS（33、176-182），**实际利用门槛高**，但修复便宜：逐段拒绝 `..` 或 realpath 包含校验。
6. **两处一致性小项**：① `asr/asr.py:48-53` `emit` 未设 UTF-8 `reconfigure`——应用内已被 `pySpawnEnv()`（`server.js:892`，全部 9 处 Python 调用点均使用）兜住，仅独立运行 CLI 时可能吞日志；`fetch_cli.py:39-40` 已有正确示范。② `main.py:873` 输出非原子写（asr.py:474-478 已有 tmp+`os.replace` 范式可抄）。

---

## 三、功能性建议（8 条，按"价值/成本"排序）

> 前 3 条来自本轮审查中确证的能力缺口，后 5 条是产品体验向的增强。

1. **撤销 / 重做（Ctrl+Z / Ctrl+Y）** ⭐ 最推荐  
   全编辑器目前**没有 undo 栈**（仅"新建未输入自动撤销"这类单点补丁）。删除、批量删除、Shift 重叠去逐词均为不可逆操作 —— `reconcileKaraoke` 的存在（`main.js:2127` 注释"避免…无法撤销"）正是这个缺口的旁证。建议用 `assDoc.serialize()` 快照 + 光标做命令栈，与自动保存解耦。
2. **导入编码自动探测（GBK / GB18030 / Big5 / UTF-16）**  
   Python 侧读 SRT/ASS 只认 `utf-8-sig`（`main.py:502/893` 等），国内素材常见 GBK 编码会直接失败。建议按 BOM → 严格 UTF-8 → GBK/GB18030 顺序回退探测，并在导入结果里**回显实际编码**，避免"处理失败"无解释。
3. **中英条目智能对齐**  
   针对发现 #6：条目数不等时不截断，按时间就近 + 文本相似度配对，支持一对多/多对一，残缺条目输出单语行而非丢弃。
4. **长视频低内存模式 / 断点续跑**  
   针对发现 #5：能量计算改分块；ASR 分块"即写"中间结果，失败后从已完成块恢复，避免长视频重跑全量。
5. **时间轴空闲降耗 + 拖动时间气泡**  
   针对发现 #13：脏标记渲染（暂停静止零重绘）；同时把已有 `_drawCreatePreview` 的"实时时间文本"模式复用到块拖动与词级拖动（`onWordRetime`），拖动时直接显示当前时间，减少"拖完才知道对不对"的返工。
6. **波形 / peaks 按视频指纹缓存**  
   针对发现 #10：peaks 与视频指纹（路径 + 大小 + 时长）绑定，修复切视频错配的同时可跨会话复用，省去重复生成。
7. **字幕列表键盘直达**  
   卡片补 roving tabindex：↑/↓ 选行、Enter 进编辑、Delete 删除（现仅 `Alt+↑/↓` 跳转）；`#panel-tabs` 补 `role="tab"`/`aria-selected`。对"边看边校"的高频键盘流收益明显。
8. **敏感值统一治理（安全侧功能化）**  
   针对发现 #1/#2：API Key 纳入 `secret-store`，任何 GET 不回传明文；设置面板密钥字段改为"留空不改、输入即替换"的写式交互。顺手把 Origin/Host 校验中间件做进服务启动路径，作为"本机服务默认安全基线"。

---

## 四、验证记录与副作用

**测试实跑（本机 Node 22.22.2，克隆后）**：

| 套件                                   | 结果                     |
| ------------------------------------ | ---------------------- |
| `tests/karaoke-exhaustive.mjs`       | ✅ 共 28183 项断言，失败 0     |
| `tests/merge-row-test.mjs`           | ✅ 25 passed / 0 failed |
| `tests/reseg-test.mjs`               | ✅ 73 passed / 0 failed |
| `tests/postprocess-presets-test.mjs` | ✅ 10 组全过               |
| `tests/ass-color-uppercase-test.mjs` | ✅ 全部通过                 |

**副作用说明**：

- 测试运行按规定自举生成 `tests/fixture.ass`（`.gitignore` 已排除 `*.ass`）。
- `tests/jsmod/package.json` 被自举同步触碰（仅 CRLF 行尾状态，`git diff` 内容为空）。
- 本次审查**未修改任何源码**，未提交任何改动。

**审查局限**：P1 四条均经逐行复核；P2/P3 各条亦经行号人工核对。前端"可访问性/交互细节"部分依赖静态阅读，未在真机逐项复现。

---

## 修复执行记录（2026-10-08，按优先级高→低；本地识别相关已按约定延后）

### ✅ 已修复并全部实跑验证

| 优先级  | 项                   | 改动要点                                                                                                                                                                                       | 验证                                          |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| P1-1 | API Key 明文回显/落盘     | `server.js`：GET/POST 只回 `hasKey`（新增 `translateCfgPublic`）；明文 Key 自动迁密文（`apiKeyEnc`，走 secret-store DPAPI/AES）；前端输入框不再回显、留空=不改、新增「清除已存 Key」；`cast_pipeline_probe` 的配置备份/恢复改走 settings 文件原样存取 | 动态 5 项（不回传/迁移/清除/同源 POST）                   |
| P1-2 | Host/Origin 校验缺失    | `handleRequest` 顶部安全基线：Host 必须回环（防 DNS rebinding）；写方法 Origin 若非回环 → 403（无 Origin 的非浏览器调用放行）                                                                                                | 动态 5 项（evil.com 403 / 回环 200 / 跨源 POST 403） |
| P1-3 | `/api/media` 任意路径   | 登记制：项目 meta 视频路径（`writeMeta` 钩子实时登记）+ 对话框选择 + 上传落盘；meta 扫描 3 秒缓存（Range 请求量大）；未登记 → 403                                                                                                     | 动态 2 项（未登记 403 / meta 登记 200）               |
| P1-4 | `fetchSiteOf` 弱匹配   | URL 解析 + hostname 白名单（含子域/大小写/FQDN 尾点），无协议头自动补 https（`normalizeFetchUrl`，探测/建项目两个入口同步）                                                                                                     | 单测 19 项（含 7 类构造绕过）                          |
| P2-1 | main.py ×3          | ①英文条目少时多出的中文行输出为"中文单行"不再丢弃；②行首色标白→`zh_color`（与 fb2182d「zh=黄」一致）；③两处输出改 `tmp + os.replace` 原子写                                                                                              | merge 专项 7 项 + draft-role-gap 13 项          |
| P2-2 | 子进程登记 + 流式写盘        | 解压/python 探测/下载内核三处 `childProcess.spawn` 改走登记版；`audio-slice` 增加 `setSpawnImpl` 注入（离线探针仍可独立用）；字幕 PUT 改流式写 `.tmp` + rename（原 256MB 全量进内存）                                                    | 动态 3 项 + 注入单测 2 项                           |
| P2-3 | 前端两竞态               | 波形加载/上传加"代次守卫"（切视频后旧响应不再上屏）；`rbReRecog` 用捕获的 pid，await 前后校验项目未切换                                                                                                                           | 语法 + 回归套件                                   |
| P3-1 | 回调/fmtTime/Zip Slip | `probeDuration`/`renderWaveform` 加 settled 防双回调（顺带修掉超时后重复重试）；`fmtTime` 改"先整体取整再拆分"（进位并入秒，兼容 1/2 位）；`ytdlp.py` 解压逐段拒绝 `..`（堵 `yt_dlp/../../x`）                                              | 语法 + 全量套件回归                                 |
| P3-2 | 渲染降耗                | `timeline` 加脏标记 + `drawIfNeeded`（播放中/脏/播放头动/2s 心跳兜底才重绘；~21 处置脏 + 事件处理器覆盖）；`reconcileKaraoke` 加无备份快路径 + 轮数上限                                                                                | karaoke-exhaustive 28183 断言 0 失败            |

### ⚠️ 行为变化（使用侧需知道）

1. **SRT→ASS 中文行首色标：白色 → `zh_color`（默认黄）**。与「设置 → 中文颜色」语义及 fb2182d 默认值一致；`tests/draft-role-gap-test.py` 断言已同步更新并新增"自定义颜色生效"用例。若作者偏好白色，改回是一行。
2. **API Key 输入框不再回显**：显示为「已保存（留空不修改）」；删除已存 Key 走设置页「清除已存 Key」链接。
3. **`/api/media` 未登记路径返回 403**（此前为 200 任意读）。
4. **新装 eslint 使用的 npm 走法**（本机 MITM 代理）：`NODE_EXTRA_CA_CERTS=win-ca.pem npm_config_proxy=$HTTPS_PROXY npm i --no-save eslint@9`。

### 🕓 延后（按"不用本地识别"约定）

- `asr/asr.py` `frame_energies` 大索引矩阵内存（长音频 OOM 风险）
- `asr/asr.py` `emit` 缺 UTF-8 `reconfigure`（独立 CLI 场景）
- 以及任何 `multitalker / diarize / whisper` 相关改动

### 📋 复验汇总（全部实跑）


- **Node 测试 19/20 套件通过**：karaoke-exhaustive 28183 断言 0 失败、merge-row 25/0、reseg 73/0 等；唯一失败 `colorfix-test` 需真实项目数据（两轮审查均如此，与改动无关）
- **Python**：draft-role-gap 13/0、fetch-format 53/0、merge 专项 7/0
- **ESLint（editor/ tools/ tests/）**：0 error / 3 warning（timeline 2 个为已记录保留项；postprocess 的 `has` 为后续提交引入，非本轮范围，留待确认）
- **刻意附加**：路由冒烟 24/24 无 500；安全探针 16/16；`fetchSiteOf` 19/19；audio-slice 注入 2/2
- `tests/jsmod/` 镜像已按项目约定同步（4 个文件）；`_t/` 下为一次性验证脚本（gitignored，可复跑）
- **未提交任何改动**；工作树仅有上述源文件改动 + 本报告（untracked）

---

### 🆕 追加修复（同日下午）：特效字幕再导入会"字幕块破碎"（用户报障）

**问题复现**：带特效（微光/词生长/柔和淡入）导出的 ASS 重新导入后，时间轴字幕块碎成一地。  
根因：特效命令混进逐词高亮 span 后，`karaoke.js` 的切片识别（`HL_RE` 要求 span 恰好是  
`{\c&H……&}词{\c}` 的形状）失败 → 一句话的每个词切片都被当成独立句子。  
实测（fixture 9 块的双语文件）：直接导入分析 **9 → 33 块**、词级映射全部丢失。

**处理**（按用户要求"先转成普通字幕，实在不行再硬塞"）：

| 项                          | 内容                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 `stripEffectTags()`     | `postprocess.js`：剥掉本模块注入过的全部特效命令 —— 微光 `\3c/\3a/\4c/\4a/\blur`、生长 `\fscx/\fscy`、淡入 `\fade(...)`（含无参复位）；剥空的覆盖块删除；**字面大括号与无关标签不动；无特效文本逐字节直通** |
| 新增 `stripEffectTagsSafe()` | 带兜底版本：转换异常 / 结果为空 / Dialogue 行数对不上 → **原样返回（硬塞语义）**，宁可回到旧行为也不丢内容                                                                            |
| 挂载点 ① 导入                   | `project.js` 新建项目选字幕文件时清理后再存进项目（用户要求的位置），清理成功弹 toast 说明                                                                                     |
| 挂载点 ② 打开                   | `main.js` `routeSub`（项目打开 / 拖放 / URL 载入的统一漏斗）—— **存量已导入的旧项目打开时自动治愈**，同样有 toast                                                              |

**验证**：

- 新增 `tests/effect-reimport-test.mjs`：**28 项断言全过**。核心不变量：`stripEffectTags(applyPostProcess(干净文件))` **逐字节回到原文件**（仅换行归一）；清理后分析的行数/词映射与干净文件完全一致；覆盖 全特效/微光/生长/淡入 4 种配置 + 幂等 + 字面大括号保护 + 兜底路径
- 全量套件 20/21 通过（新增本套件；唯一失败 `colorfix-test` 仍为既知缺数据）；ESLint 0 error
- 行为说明：导入/打开带特效字幕时会自动"转普通"（特效的定位本来就是**导出时**按设置现加），不影响再次导出时重新生成特效
