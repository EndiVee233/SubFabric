# SubFabric 代码质量审查报告（第二轮·全面）

- **审查对象**：`EndiVee233/SubFabric` 工作树 @ 2026-10-10（v2.2.1 之后，PR #1 合并、路由层重构恢复后）
- **代码量**：约 96,000 行（JS + Python + HTML + CSS，含 tests/jsmod 镜像 ~27,000 行）
- **方法**：4 路并行深扫（server.js 全文 / 前端 UI / 核心模块+后端辅助 / Python 侧）+ 高危发现逐一回读源码核实 + 工程化配置盘点
- **与第一轮（docs/CODE_REVIEW.md）的关系**：第一轮 5 项修复均已落地且未回退；本轮为 PR #1 大合并后的全面复查，重点转向**合并引入的回归**与**维护性债**
- 本文件处理完（修复项落地后）可删除，避免历史审查文档堆积 —— 惯例同 `CODE_REVIEW_2026-10-08.md`

---

## 总评

**底子好，合并引入了真回归。** 第一轮建立的安全底座（safeJoin/Host/Origin/secret-store）、路由薄分发器结构、自举测试机制依然扎实；注释"写为什么"的文化贯穿全库。但 fork 大合并留下了几处**注释里警告过、护栏写了没接线**的收尾遗漏，以及 Python 侧"复制实现时把修复一起丢掉"的实证（OOM 回归）。

| 维度     | 评价   | 一句话                                                                   |
| ------ | ---- | --------------------------------------------------------------------- |
| 代码结构   | ⚠️   | 后端段函数粒度严重不均（939 行 vs 48 行）；前端 main.js 承担 ≥12 个子系统；Python 分句规则双份且已行为漂移 |
| 命名与可读性 | ✅/⚠️ | 注释质量高，但 2 处过时注释会误导、魔法数字散布、部分新文案绕过 i18n                                |
| 健壮性    | 🔴   | **4 个真 bug**（ReferenceError / 双回调 / 批量挂起 / 数据污染写回），均有精确行号             |
| 性能与资源  | ⚠️   | 滑块全量序列化热路径、3 处 O(n²)、2 处内存无界增长、临时文件泄漏                                 |
| 工程化    | ⚠️   | eslint 已有且质量好；无 CI、无统一测试入口、无 Python lint、requirements 不锁版本            |

---

## 一、高危问题（10 项，全部回读源码核实）

### 高-1【editor/server.js:7606】autopost 失败兜底引用不存在的 `stamp()` → ReferenceError，错误日志丢失

```js
7603:  runAutoPost(id).catch(e => {
7605:    console.error('[autopost] ' + id + ' 失败：' + msg);
7606:    pushDraftLog(id, stamp() + '[自动后处理] 失败：' + msg);   // ← stamp 只在 5231 行函数内部定义
```

`stamp` 是 `continueDraftAfterAsr` 的局部 const；模块作用域只有 `apStamp`（4085 行）。讽刺的是 4081–4084 行注释**恰好就是为这个坑写的警告**，但这个调用点漏改。手动触发 autopost 失败时，catch 处理器自身抛 ReferenceError → unhandledRejection，`pushDraftLog` 不执行。  
**建议**：改为 `apStamp()`。一行。

### 高-2【editor/server.js:305-314】`probeDuration` 的 settled/finish 护栏写了没接线 → 双回调；波形路径可无限递归 spawn

```js
308:  let settled = false;    // spawn 失败时 error 与 close 都会到, 回调只允许落一次
309:  const finish = (v) => { if (!settled) { settled = true; cb(v); } };
311:  p.on('error', () => cb(0));                                    // ← 绕过 finish
312:  p.on('close', () => { ... cb(...); });                          // ← 也绕过 finish
```

ffprobe 不可用时 `error`+`close` 都直呼 `cb`。两条后果链（已核实调用点）：

- `/api/peaks`（5987 行）：`go()` 被调两次 → `sendPeaks` 第二次 `res.writeHead` 抛 `ERR_HTTP_HEADERS_SENT`（异步上下文，落进全局 uncaughtException）；
- `makeWaveform`（353-354 行）：`cb(0)` → `if (!(duration > 0)) return probeDuration(...)` → 再起 ffprobe → 再 `cb(0)` → **无限递归 spawn**。  
  **建议**：311/312 改走 `finish(0)`/`finish(v)`；顺带在 close 时 clearTimeout 313 行的超时 timer。对照 323-326 行 `renderWaveform` 的正确写法。

### 高-3【editor/server.js:4924-4928 + 5059】批量重识别遇到空区间提前置 done → 每段空转等满 30 分钟

```js
4924:  if (!segs.length) {
4925:    setRr({ status: 'done', stage: '完毕', ..., message: '该区间没有识别到语音' });
4927:    return;                                   // ← batch 模式也走这里
4928:  }
...
5059:  while (job.regionDone === done0 && job.status !== 'error' && Date.now() - t0 < 30 * 60 * 1000) {
```

空区间分支不递增 `regionDone`、status 置 `'done'`（不是 `'error'`）→ 批量调度器的等待循环空转 30 分钟。含 N 个静音区间的批量任务挂 N×30 分钟。  
**建议**：4924 分支内加 `if (o.batch) { job.regionDone = (job.regionDone||0)+1; return; }`，与 4973 行 batch 分支语义对齐。

### 高-4【editor/js/project.js:601-609】打开项目时字幕 fetch 不检查 `r.ok` → 错误响应体污染 `lastSavedText` → **自动保存把坏内容写回 subtitle.ass（数据丢失路径）**

```js
603:  const text = await (await fetch(`/api/projects/${pid}/subtitle`)).text();
604:  if (gen !== _openGen) return;
605:  lastSavedText = text;                 // ← 500/404 的 HTML/JSON 错误体也被当字幕
606:  routeSub(text, ...);
```

try/catch 只兜网络拒绝。服务端 500 时：坏文本被 `routeSub` 解析成空/坏文档，且 `lastSavedText` 被污染 —— 用户随后任何一次编辑触发 `saveNow()`，就把序列化后的坏文档 **PUT 回写 `subtitle.ass`，覆盖权威字幕文件**。  
**建议**：`const r = await fetch(...); if (!r.ok) { toast('项目字幕读取失败'); return; }` 后再取 text；`lastSavedText` 只在 `r.ok` 时赋值。

### 高-5【editor/js/project.js:1630】读取不存在的 `state.asrStatus` → 双引擎分工行永久隐藏（功能死代码）

```js
1630:  const anyDual = state.asrStatus && (state.asrStatus.models || [])
1631:    .some((m) => m.engine === 'dual' && m.ready);
```

已核实：`state`（main.js:158-173）无 `asrStatus` 字段；真正的模型状态是本文件模块局部变量 `asrStatus`（2481/2585 行）。`anyDual` 恒 falsy → `#dual-ratio-row` 永远隐藏，`initDualRatio` 整套交互不可达。  
**建议**：改用局部 `asrStatus`；并确认设置页入口也跑过 `refreshAsrStatus`（目前只在 `npSetMode('draft')` 时触发）。

### 高-6【editor/js/main.js:1028-1031 + 1093-1145 + 1431-1436】特效/样式滑块把 `input` 事件直连"全文档 serialize + libass updateNow"（性能热路径）

12 个 FX 控件 + 6 个样式控件绑在 `input` 上，每条路径都：全事件遍历 `replaceWordHighlightColor` → `state.assDoc.serialize()`（5000 行量级数十毫秒）→ libass 重解析。拖动色盘每秒可达 60 次全量序列化，主线程必然卡顿。  
**建议**：`input` 阶段只更新数值 UI + rAF 节流预览；`change`（松手）才 serialize + replaceEvents。或对 serialize 结果做脏检查，文本没变就跳过 updateNow。

### 高-7【editor/js/overlay.js:48-53】活动字幕检索假设 end 随 start 单调 → 重叠 SRT 整条漏显示

```js
49:  for (let k = i; k >= 0 && this.cues[k].end > t; k--) actives.unshift(this.cues[k]);
50:  for (let k = i + 1; k < this.cues.length && this.cues[k].start <= t; k++) {
51:    if (this.cues[k].end > t) actives.push(this.cues[k]);
52:    else break;                              // ← 非法断言
```

cues 只按 start 排序。反例：A=[0,100]、B=[1,2]，t=50 时 bisect 命中 B，回扫第一步 `B.end(2) <= 50` 退出，**A 完全不显示**。timeline.js 已用前缀最大 end（`_maxEnd`，timeline.js:296/926）防过同一类 bug，overlay 没防。  
**建议**：`setCues` 时预计算 `cue._maxEnd`，回扫改用 `_maxEnd > t` 作循环条件。

### 高-8【asr/asr_npu.py:760-762 + 336-339】长音频 OOM 回归：复制 asr.py 旧版时把分块修复一起丢掉了

```python
# asr_npu.py:761 (refine_word_ends) —— asr.py:249-273 注释明确记载旧写法 1 小时音频峰值 ~1.8GB
idx = np.arange(frame, dtype=np.int64)[None, :] + hop * np.arange(n_frames, dtype=np.int64)[:, None]
energies = np.sqrt(np.mean(np.square(samples[idx]), axis=1)).astype(np.float32)
```

asr.py:249-273 的 `frame_energies` 已改分块计算并留下实测教训注释，但 asr_npu.py 两处又抄回旧的全量广播索引矩阵（1 小时音频 ≈ 1.15 亿 int64 索引 ≈ 0.9GB + float64 gather 临时量）。**同样输入下 NPU 引擎会在 asr.py 不崩的地方 OOM** —— "复制实现导致修一处漏一处"的实证。  
**建议**：asr_npu.py 直接 `from asr import frame_energies`（两文件同级），`refine_word_ends` 改为复用；`MelFrontend.log_mel` 的帧索引按 asr.py:267-272 分块模式重写。

### 高-9【editor/server.js:3044 + 6077】Cookie 明文链路两个泄漏点（与 PROJECT_MAP 敏感数据纪律冲突）

1. 3044 行：Netscape 文件写失败时回退 `args.push('--cookies', ckPlain)` —— **明文进命令行 argv**，同用户任意进程可经 WMI `Win32_Process.CommandLine` 读到；3038 行注释自己写着"明文不放命令行"。
2. 6077 行：探测用 Cookie 落 `os.tmpdir() + 'sf-probe-cookies.txt'` 固定名 —— 路径可预测、可被抢占，且仅在正常返回后删除，Node 崩溃即残留明文。  
   **建议**：删除 argv 回退（写文件失败直接报错）；probe 文件改 `fs.mkdtempSync` 随机目录 + 用完 `rmSync(recursive)`；可选：`fetch_cli.py` 用 `os.O_TEMPORARY` 写 cookie 文件（Windows 句柄关闭自动删除）。

### 高-10【asr/asr_dual.py:154-157, 191-198 + asr/asr_perf.py:121-122】子进程无超时看门狗（违反项目自己的红线"新增后台任务必须有超时/看门狗"）

三处 `subprocess.run` / `Popen+wait()` 均无 `timeout`。NPU 编译/CUDA 原生崩溃挂死正是项目注释里反复出现的故障形态；worker 挂住后 `threading.Thread` 永久 join，编排进程自己也变僵尸。  
**建议**：统一加 `timeout`（片数 × 单片实测 × 10 + 加载 120s），捕获 `TimeoutExpired` 后 `kill()` 并记 failed（asr_dual 的 merge 已有 failed 兜底）。

---

## 二、中危问题（按模块分组）

### server.js（后端）

| 位置                                                  | 问题                                                                                                    | 建议                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| server.js:462-474                                   | `buildPeaks` 无 settle 护栏，spawn 失败时 error+close 双触发 → 双重响应（对照 renderWaveform:323 有护栏）                  | 照抄 settled 模式                                                                          |
| server.js:4455-4464                                 | `packProject` 的 bsdtar 主路径永远走不通：`runTool` 未传 `cwd`，打包用相对文件名 → 每次静默落到 PowerShell `Compress-Archive` 兜底 | `runTool` 加 cwd 参数并传 `dir`                                                             |
| server.js:2936-2950                                 | `fetchPyPromise` 把**否定结果**永久缓存：Python 探测失败后，用户装好解释器仍报"需要 Python"直到重启                                  | 结果为 false 时不缓存，或 `finishOk` 里重置                                                        |
| server.js:3255-3262                                 | 进度样板 = 每条进度行一次 readMeta+writeMeta（writeFileSync+renameSync）+ appendFileSync，大文件下载时高频同步 IO             | `setDraft` 加 300-500ms 尾沿节流                                                            |
| server.js:4261-4300                                 | `realignJobs` 无老化清理，job（含全片逐句 items）永久驻留 → 内存只增不减                                                     | 照搬 rerecogJobs 的 7735 行 finishedAt 过期模式                                                |
| server.js:4743-4989                                 | `startRerecognize` 失败路径（4983-4986 catch）不调 `cleanup()` → 25 分钟长 wav 切片（~45MB）留在 %TEMP%                | catch 里补 `try { cleanup(); } catch {}`                                                 |
| server.js:7073                                      | `POST /api/projects` 的 readBody 上限 256MB 全量缓冲进内存（字幕保存路由已改流式并有注释说明原因）                                  | 限到 8-16MB 或改流式                                                                         |
| server.js:7054-7069                                 | 项目列表每秒被轮询，每次 O(N) 同步 IO（逐项目 readMeta + 3 次 existsSync），项目多时每次卡事件循环数十毫秒                                | 按 project.json mtime 做 3 秒列表级缓存                                                        |
| server.js:5962/5981、2385-2445≈2469-2532、5730-5808 等 | 重复代码：okPath 校验逐字重复两遍；whisper/crispasr 进度解析与词分组 ~60 行重复；三处 JSON 行解析近似                                  | 提 `assertRootVideo(name)`、`parseAsrProgressLines`、`groupWordsToSegments` 段函数（单文件约束下允许） |
| server.js:1959/2064/2271 vs 4437                    | `System32/tar.exe` 路径拼了 4 遍，4437 行已有 `SYS_TAR` 常量但旧代码没收编                                              | 统一引用 SYS_TAR（定义上移）                                                                     |
| server.js:7723 vs 5009                              | 重识别互斥判定口径不一致：单区间只看 `status==='running'`，卡死任务在 20 分钟自愈触发前把按钮挡死                                         | 7723 改用 `jobStillRunning`                                                              |
| server.js:7782-7786                                 | `draft.log` 无限增长且详情轮询每秒全量 readFileSync                                                                | 追加时按大小截断（保留尾部 N KB）                                                                    |

### 前端 UI

| 位置                                                                                      | 问题                                                                                                      | 建议                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| main.js:4448-4449、4174                                                                  | reflectRender/任务卡把 LLM 解析链路的数值字段（from/to/confidence/regionTotal）未转义裸拼 innerHTML；同函数其它字段都走了 `reflectEsc` | 统一 `reflectEsc(String(...))` 或先 `Number()` 归一                 |
| project.js:591-595                                                                      | `openProject` 的 catch 分支没有代次守卫：快速 A→B 切换后，A 的慢失败会把已打开 B 的用户拽回 #/home                                    | catch 内先 `if (gen !== _openGen) return;`                      |
| main.js:4203、6544；project.js:527/802/883/1542/1801/1966；videoedit.js:127                | 9 处轮询 setInterval 在页面隐藏时不暂停（含 videoedit 常驻 250ms）                                                       | 抽公共 `setDocumentVisibleInterval`（visibilitychange 暂停/恢复+补跑一次） |
| editor.js:977-998 + 123-128                                                             | 虚拟滚动每次 scroll 无条件重建窗口 innerHTML，且 window capture scroll 对任意容器滚动都触发；无"窗口未变化则跳过"检查                        | `_render()` 开头比较 start/end 无变化直接 return                       |
| main.js:124 + videoedit.js:35,41                                                        | 跨文件魔法数隐式契约：控制条高 72、双击窗口 240ms，注释自己承认"必须与 main.js 一致"                                                    | util.js 导出 `CTRL_BAR`/`CUE_CLICK_DELAY`                       |
| project.js:1936-1951                                                                    | `renderAsrModels` 渲染函数内自动 POST 下载，且被 pollModelDownload 每秒重跑；服务端"已受理未标 running"窗口内会重复 POST               | 自动补运行时逻辑移出渲染函数                                                |
| main.js:706/829/968-1021/4176/4507/5334；project.js:725/944/2565/2610；editor.js:270/1116 | 大量新文案绕过 i18n 词典（违反 PROJECT_MAP §7-9），用户无法用 lang/zh-CN.json 润色                                           | 赋值点统一包 `t(...)`                                               |
| main.js:1843-1844                                                                       | `console.log('[rim] ...')` 残留，每次分段导入必打                                                                  | 删或降 console.debug + URL 开关                                    |
| main.js:1509/2759/1526；util.js:72 vs project.js:81 vs main.js:4386 等                    | 重复实现清单：6 套各自为政的轮询、3 份 escapeHtml（其中 util 版不转 `'`）、3 份重叠扫描算法、2 份 CONF_MODES、localStorage 键字面量跨文件写死       | 抽 util 共享原语；escapeHtml 统一并补 `'`                               |
| main.js:1410-1412                                                                       | `typeof realignEls !== 'undefined'` 的 TDZ 守卫无效（`typeof` 对 TDZ 的 let/const 同样抛 ReferenceError），注释说法错误    | 集中声明到使用点前，修正注释                                                |
| videoedit.js:141+339                                                                    | `_syncShield` 每 250ms 双倍调用 `itemsAt(t)` 全表扫描（5000 行量级 O(n)×2×4次/秒）                                      | 复用 `_layoutItems()` 的结果                                       |

### 核心模块与后端辅助

| 位置                                              | 问题                                                                                                                                | 建议                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| timeline.js:1239                                | 刻度标签正则转义错误：`.replace(/\.0\$/, '')` 里 `\$` 匹配字面美元符 → `.0` 后缀永远去不掉（1189 行是对的）                                                       | 改 `/\.0$/`                                                     |
| asr-service.js:65-80, 108-116                   | worker 在 ready 前崩溃时 `waitReady` 干等满 180s（close/error 只 reject `pending`，没处理 `readyWaiters`）；`transcribe` 抛错路径不布置 idleTimer → 进程永驻 | close/error 里追加 reject readyWaiters；失败路径也布置 idleTimer 或 stop() |
| karaoke.js:585-618 + 798-816                    | 两处载入期 O(n²)：`repairKaraokeGroups`（groups×anchors×span）与 `ghostZhRows`（rows×hosts，且内层循环重复计算 `assPlainText`）                        | 宿主纯文本先算好缓存；anchors 排序后窗口/二分剪枝                                  |
| timeline.js:693-697                             | 悬停路径每个 mousemove 全量扫描全部轨×块×词（`_hitWordHandle` 无二分+`_maxEnd` 剪枝，`_hitTest` 有）                                                      | 套用 `_hitTest` 的定位策略：先限轨、二分找 cue、命中后才遍历词                        |
| timeline.js:124,176                             | Filmstrip 缩略图缓存只进不出：高缩放级别下 1 小时视频 ≈ 400MB+ canvas                                                                                 | 简单 LRU（>300 张淘汰）或换 step 时清旧桶                                   |
| secret-store.js:21,85                           | 缓存无界；**任何** DPAPI 异常（含 10s 超时这类暂态故障）都把 `dpapiUsable` 永久置 false → 之后全走较弱 AES                                                       | cache 加上限（个位数敏感值，16 项足够）；仅确定性失败（ENOENT）才置 false                |
| mt-local.js                                     | `translate()` 单次遇到 ECONNREFUSED 不就地重试（上层有"重试"按钮兜底，可接受但建议 ensure 后失败时 force 重启一次再试）                                                | force 重启一次再试                                                   |
| segment.js `escapeAssUser` ↔ k-line.js `escAss` | ASS 转义规则双实现，**唯一没有交叉一致性测试保护的一对**（normalizeZhPunctuation 那对有 zh-punct-test 钉着）                                                     | 补对拍断言测试                                                        |


### Python

| 位置                                                                            | 问题                                                                                                                                                                    | 建议                                                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| asr.py:53-57/596-652/556-593/65-185 ↔ asr_npu.py:77-81/822-904/750-792/89-229 | 分句规则+serve 循环双份且**已行为漂移**：npu 版 `words_to_segments` 长出 token 分数逻辑，`refine_word_ends` 退化（见高-8），serve_loop/manifest ~120 行逐字重复。asr_dual.py:52 `import asr as A` 已证明复用可行 | 抽 `asr/common.py`：断句常量、words_to_segments（token 分数作可选钩子）、refine_word_ends、read_wav_mono16k、emit/reconfigure、serve_loop、CUDA DLL 注册 |
| asr.py:741-746                                                                | 单文件模式不校验 `--out`：`os.replace(".tmp", "")` 抛莫名 OSError（asr_npu.py:944 有对应检查）                                                                                           | 补 `if not args.out: raise RuntimeError(...)`                                                                                      |
| asr_perf.py:51-53                                                             | `emit` 不吞异常且全文无 stderr UTF-8 `reconfigure` —— Windows GBK 管道下第一条中文日志即崩（asr.py:38-41 已有明确结论与修法）                                                                        | reconfigure 挪进 common 模块统一执行                                                                                                      |
| asr.py:421-424                                                                | 热词临时文件 `kass-hotwords-<pid>.txt` 无 try/finally 清理，常驻模式每次启动泄漏一份                                                                                                        | `try: ... finally: os.unlink(hw_path)`                                                                                            |
| asr.py:551-553 + confidence.py:258-305                                        | `edit_align` 是 O(n·m) 纯 Python DP，但调用方把**所有分块 token 首尾相接成全长序列**喂入：1 小时音频 ~2 万 token → DP 矩阵 4×10⁸ 格，耗时以小时计                                                            | 按块分别计算再聚合（块间本来就连续），或超 2000 token 降采样                                                                                              |
| asr/requirements.txt:23-24                                                    | 只写下限不锁版本（`sherpa-onnx>=1.13`、`numpy>=1.24`）；**mt_nllb.py:87 依赖 `ctranslate2` 完全未声明**                                                                                  | 核心两包加上界（如 `numpy>=1.24,<3`）；补 mt_nllb 可选段                                                                                         |
| main.py 全文 ↔ server.js:3356/3382/3457/3460/3834 等 8 处注释                       | main.py 的 format_time/hex_to_ass_bgr 等与 server.js 是"人肉同步"的两份实现，main.py 成了只活在注释里的参考实现，改动无测试报警                                                                          | 见分阶段计划（阶段 3）                                                                                                                      |
| mt_nllb.py:141                                                                | `encode_one` 每翻译一句重建一次 25 万词的逆映射表                                                                                                                                     | load 时缓存 `self._inv_vocab`                                                                                                        |
| yt_format.py:69-72                                                            | YouTube 判站用子串匹配，与 bilibili.py:37-43 的严格 hostname 口径分叉（PROJECT_MAP 明确要求严格 hostname）                                                                                    | 统一走 `_host_of` + 域名后缀表                                                                                                            |
| asr_dual.py:370-379                                                           | `py = args.python; scripts = {...}` 整块复制粘贴两次；132-180 行 `_piece_worker` 死代码从未被调用（`--dynamic`/`--static` 旗标零引用）；482 行 `__wall` 字段恒为 0（统计造假）                             | 删重复块与死代码；`__wall` 记到 run_engine 返回值补真                                                                                             |

---

## 三、低危问题（择要）

- **魔法数字**（建议提命名常量）：server.js 的超时族（15000/600000/30×60×1000/25×60×1000/5×60×1000 等 12 处）与缓冲上限族（4000/2000/8000/512MB/256MB）；波形 rate `100`（3136/7877）；asr_npu.py:517 `reshape(-1, 1030)`（=vocab+5，硬编码）；timeline.js 缩略图 160/90。
- **过时注释**：server.js:162-165、2641-2646 仍说"readOpLog 必须定义在 handleRequest 内部"（重构后已不成立）；第 4 行头注释"D:\subtitle"是旧路径；editor.js:309 行号引用漂移；reflect.js:31-33 新旧注释叠放；k-line.js:2-5 头注释前提已过时（server.js 现在能 require ESM）。
- **死代码/死变量**：timeline.js `_laneMinH()` 无调用点；util.js:49-51 parseTime 冗余分支；speech-gap.js `COVER_RATIO` 导出无使用；karaoke.js:133/970 死分支、951 局部变量遮蔽导出函数；server.js `perfProc` 只写不读、`finish`（见高-2）。
- **一致性小项**：ass.js:19/srt.js:9,46 用字面不可见 BOM 字符（应统一 `\uFEFF`）；srt.js:62-68 每次调用重建 5 个正则（应顶层预编译）；cast.js `MAX_SPEAKERS`/`CAST_MAX` 同值双常量、与 llm-text.js 复制粘贴平衡扫描器；fonts.js collectionOffsets fd 版/buf 版两份实现；capcut-asr.js:262 日志输出 tdid 设备指纹（会随项目压缩包分享，建议打码）。
- **Range 解析**：server.js:560-579 对多段 Range `bytes=0-1,5-6` 静默误读（本地工具影响小，正则后加 `^\d+$` 校验即可）。
- **无 416 兜底**：waveformFromTemp/peaksFromTemp 的 32GB 中断路径只 `req.destroy()`，不回 413（对照 upload-video 三件事都做了）。
- **bilibili.py:128**：`has_login` 判断两分支等价绕一圈，化简为 `"sessdata" in keys`。
- **ytdlp.py:88-95**：`_dbg` 无限追加 bootstrap.log，无轮转。
- **multitalker.py:102-103**：`from_pretrained` 回退期望云端模型名却传本地 .nemo 路径，几乎必然再抛更模糊的错，不如让原始异常透传。

---

## 四、分维度结论

**1. 代码结构** —— 后端"薄分发器 + 7 段"结构成立，但段粒度不均：`handleProjectsRoutes` 939 行 ~25 个 action、`handleAsrRoutes` 598 行，实质是"披着段函数外衣的原单体"；分发器本体只有 26 行。段函数之外的前 5951 行里，`startDraftAsr`（~356 行）与 `startRerecognize`（~247 行）是两个最大函数，五条引擎分支各有一份结构相同的"spawn→收 JSON→写 asr.json→finishAsr"骨架。前端 main.js 承担 ≥12 个本可独立的子系统（FX 面板/分段导入/查找替换/反思纠错/重校对/任务卡/弹幕/操作日志/导出/设置/诊断/版本检查），同时兼任"唯一真相源 + 事件总线 + 渲染器"三重身份。Python 侧分句规则双份且已漂移（详见高-8、中表）。**未发现循环依赖**；fork 模块"前后端同名"实为同一份 ESM 双端复用（浏览器 import + Node 22 require(esm)），算法只有一份，这个设计是对的，值得保持。

**2. 命名与可读性** —— 注释文化是全项目最大资产（"为什么"+实测数据），仅 5 处过时注释需要修（见低危）；魔法数字集中在超时/缓冲两类，已有 `LOG_MAX`/`PEAK_SR` 等好榜样可循；i18n 覆盖有缺口（toast 走词典但 textContent 直写绕过）。

**3. 健壮性** —— 全局兜底（uncaughtException/unhandledRejection/处理器 try-catch）、34 处 JSON.parse 全带 try-catch、SSE 心跳清理、CHILDREN 双登记均到位。本轮 4 个真 bug（高-1/2/3/4）全是"护栏写了没接线"或"合并时漏改"的收尾遗漏，不是架构问题。依赖注入方面：reseg/asr-chunks/cast/llm-text 等纯函数模块设计范本级；server.js 侧可测性靠 `http_layer_probe`（自带服务启停）补足。

**4. 性能与资源** —— 播放/渲染主链路的性能架构（脏标记+2s 心跳+包络缓存+虚拟滚动）取舍记录清晰、在当前规模合理。热点集中在：滑块全量序列化（高-6）、悬停/载入 3 处 O(n²)、4 处无界增长（realignJobs/Filmstrip/secret cache/draft.log）、2 处临时文件泄漏、高频同步 IO（setDraft 样板、项目列表轮询）。

**5. 工程化** —— 已有：eslint.config.js（第一轮建立，"只抓真错"的定位正确）、.gitignore 完备、secret-store。缺失：**无 CI**（.github/workflows 不存在）、**无统一测试入口**（62 个 .mjs + 13 个 .py 各自跑，没有 run-all）、**无 Python lint 配置**（无 ruff/flake8/pyproject）、requirements.txt 不锁版本。无 TODO/FIXME 残留（全库 grep 为零）、无孤儿模块、密钥不进日志（已核实）。

---

## 五、分阶段改进计划

### 阶段 0：立即修复（半天，全部是行级小改，兼容性风险：无）

| # | 修复项                                                  | 行数 | 兼容性/行为影响                                                             |
| - | ---------------------------------------------------- | -- | -------------------------------------------------------------------- |
| 1 | server.js:7606 `stamp()` → `apStamp()`               | 1  | 仅修复错误日志路径                                                            |
| 2 | server.js:311-312 接线 `finish()`；close 时 clearTimeout | 3  | ffprobe 不可用时不再双响应/递归                                                 |
| 3 | server.js:462-474 buildPeaks 加 settled 护栏            | 4  | 同上                                                                   |
| 4 | server.js:4924 batch 空区间 `regionDone+1`              | 2  | 批量任务不再挂 30min/段；**行为变化=修复**：空区间原来显示"该区间没有识别到语音"，修复后批量模式按跳过处理、单区间模式不变 |
| 5 | project.js:601-606 补 `r.ok` 检查                       | 3  | **数据安全修复**：服务端 500 时不再污染 lastSavedText；前端多一个失败 toast                 |
| 6 | project.js:1630 `state.asrStatus` → 局部 `asrStatus`   | 1  | **功能恢复**：双引擎分工行在有双引擎模型时开始显示（此前永久隐藏）                                  |
| 7 | timeline.js:1239 `/\.0\$/` → `/\.0$/`                | 1  | 刻度标签不再带 `.0`                                                         |
| 8 | overlay.js 预计算 `_maxEnd` 修正回扫                        | 8  | 重叠 SRT 字幕开始正确显示（此前漏显示）                                               |
| 9 | main.js:1843 console.log 删除                          | 1  | 无                                                                    |

**验证手段**：`node tools/http_layer_probe.mjs`（47 项）+ `node tools/route_smoke.mjs` + karaoke-exhaustive（28183 断言）+ 新增 overlay 重叠用例（见"需补充的测试"）。

### 阶段 1：安全与资源（本周内，兼容性风险：低）

1. **Cookie 链路收紧**（高-9）：删 server.js:3044 argv 回退；probe 文件改 mkdtemp。影响：原"写文件失败但明文兜底可用"的极端路径改为报错并提示安装/修复 Python 环境 —— 该回退的正常路径本就走文件，实际用户无感。
2. **asr_npu.py OOM 修复**（高-8）：`from asr import frame_energies` 复用 + log_mel 分块。影响：NPU 引擎长音频不再 OOM；输出数值与 GPU 引擎对齐（本就应该一致）。
3. **子进程超时**（高-10）：asr_dual/asr_perf 三处加 timeout。影响：挂死的 worker 被杀并记 failed，编排进程可退出。
4. **资源泄漏三连**：startRerecognize catch 补 cleanup、realignJobs 老化清理、fetchPyPromise 否定结果不缓存。影响：无（纯收益）。
5. **asr-service readyWaiters 修复**：worker 早期崩溃时 3 分钟等待变立即报错。影响：错误更早更可读。

### 阶段 2：可维护性重构（1-2 周，需测试护栏先行）

1. **Python `asr/common.py` 提取**（收益最大单项）：断句常量、words_to_segments（token 分数作可选钩子）、refine_word_ends、emit+reconfigure、serve_loop。做法：先建 common → asr.py 改 import → asr_npu.py 改 import → 每步跑 fetch-format-test 与端到端建稿。影响：两个引擎的分句输出从此**强制一致**（现 npu 版行为略有分叉，统一时需明确以哪版为准——建议以 asr.py 为准，把 npu 的 token 分数作为钩子并回）。
2. **server.js 段内提辅助函数**：`readJson(req,res,limit,cb)`（消 34 处样板 + 统一 413 语义）、`parseAsrProgressLines`、`groupWordsToSegments`、`assertRootVideo`、SYS_TAR 上移；`startDraftAsr` 抽 `runEngineAndFinish(id, model, runner)` 统一五条引擎骨架。做法：纯逐字搬移 + 行多重集对照 + http_layer_probe/route_smoke 新旧对照（项目已有这套验证惯例，2026-10-10 的路由重构就是这么证明的）。影响：路由行为零变化；`readJson` 统一后 413 的 body 文案略有归一（调用方都是自家前端，无感）。
3. **main.js 拆子系统**：FX 面板、备注弹幕、反思纠错、重校对、操作日志各自拆成 `editor/js/` 模块、经 ctx 注入（与 PROJECT_MAP §4 前端地图自然对齐）。做法：纯搬移 + karaoke-exhaustive 自动同步镜像 + CDP 探针回归。影响：模块加载顺序变化，需注意 `realignEls` 等 TDZ 问题（顺手按中表修掉）；无行为变化。
4. **util 共享原语收拢**：escapeHtml 统一（补 `'`）、`pollUntil`、`CTRL_BAR`/`CUE_CLICK_DELAY`、CONF_MODES 收拢到共享纯模块、localStorage 键常量化。影响：escapeHtml 统一后 project.js 的 `esc` 行为多了 `'` 转义 —— 显示等价（`&#39;`），HTML 语义不变。
5. **性能项**：滑块 input→change 迁移（高-6）、setDraft 节流、POST /api/projects 限 16MB、项目列表 3 秒缓存、editor.js `_render` 短路、videoedit 复用 itemsAt 结果。影响：进度更新可见延迟 ≤500ms；创建项目 body 上限从 256MB 降为 16MB（实际元数据 KB 量级，无感，但要在错误信息里说明）。

### 阶段 3：工程化基建（持续，每次改动顺手推进）

1. **统一测试入口 `tests/run-all.mjs`**：串行跑全部独立测试 + 汇总通过率，自动跳过需用户数据/私有基线的（colorfix、reload-pipeline，遵循现有约定）。影响：无；纯新增。
2. **Python lint**：加 `ruff.toml`（只开 E9/F 类真错误 + B 类可疑默认值，不开风格规则——与 eslint 同哲学）。影响：首批会暴露若干真问题（如死分支），逐个确认。
3. **CI（GitHub Actions）**：`node --check` 全部 JS + eslint + run-all（无外设部分）+ ruff check。影响：无；防止本次发现的"合并回归"类问题再次溜进 main。
4. **requirements.txt**：核心两包加上界（`numpy>=1.24,<3`）、补 mt_nllb 可选段（ctranslate2 + tokenizers）。影响：新装环境更可复现；已装环境不受影响。
5. **main.py 处置**：把 `tests/draft-role-gap-test.py` 依赖的 `merge_srt_to_ass`/`format_time` 抽到 ~200 行的 `lib/ass_karaoke.py`（或改写测试直接测 server.js 对应 JS 实现），然后 main.py 移入 `tools/legacy/` 或删除，同步清理 server.js 里 8 处"与 main.py 保持一致"注释。影响：删掉"人肉同步"这个最脆弱耦合；测试需同步迁移。
6. **i18n 补齐**：中表列出的直写文案赋值点统一包 `t(...)`。影响：用户可通过 lang/zh-CN.json 润色全部文案。
7. **PROJECT_MAP 增加"双实现清单"**：normalizeZhPunctuation（有对拍测试）、escapeAssUser↔escAss（补测试后列入）、格式契约（selector.py ↔ index.html 档位）等，写明"各自被什么测试钉着"。

### 需补充的测试（按优先级）

| 测试                                                       | 防什么     | 落点                        |
| -------------------------------------------------------- | ------- | ------------------------- |
| overlay 重叠 cue 用例（A=[0,100],B=[1,2],t=50）                | 高-8 回归  | 新建 tests/overlay-test.mjs |
| probeDuration/buildPeaks 双回调回归（注入假 ffprobe 或 mock spawn） | 高-2 回归  | http_layer_probe 扩展       |
| 批量重识别含空区间的端到端用例（mock ASR 输出空段）                           | 高-3 回归  | http_layer_probe 扩展       |
| subtitle 接口 500 时前端不写回 lastSavedText                     | 高-4 回归  | CDP 探针（tools/ 新增）         |
| escapeAssUser ↔ escAss 对拍断言                              | 双实现分叉   | tests/ 新增，仿 zh-punct-test |
| asr.py 与 asr_npu.py 的 words_to_segments 对拍（同输入同输出）       | 分句规则再分叉 | tests/ 新增 .py             |
| fetch_cli cookie 临时文件清理（含进程被杀场景）                         | 高-9 回归  | fetch-format-test.py 扩展   |

---

## 六、值得保持的优点（避免误改）

- 注释"写为什么"+实测数据的文化 —— 全项目最值钱的交接资产
- fork 模块"一份 ESM 双端复用"（浏览器 import + Node require(esm)）—— 算法只有一份，bug 只修一处
- 修过的每个坑都留案底注释（如 4081 行的 stamp 警告 —— 本轮高-1 正是没听这个警告的新调用点）
- 前端竞态代次守卫（waveLoadGen/\_openGen）模式一致且覆盖到位（除 project.js:591 catch 一处）
- 34 处 JSON.parse 全带 try-catch、无 TODO 残留、密钥不进日志、无孤儿模块
- 路由重构的验证方法学（行多重集 + AST 对照 + 双探针新旧对照）值得在阶段 2 复用

---

*本报告由 4 路并行深扫生成，高危项全部经人工回读源码二次核实。建议处理顺序：阶段 0 全部 → 阶段 1 全部 → 阶段 2 按序 → 阶段 3 随手推进。处理完成后按惯例删除本文件（或移入 git 历史）。*
