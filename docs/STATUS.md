# 项目当前状态（唯一权威入口）

- 最后更新：2026-10-15（Asia/Shanghai）。
- 当前任务：继承全项目测试并改善可维护性，**已完成且已验证**（本地实现、隔离回归、语法检查与逐文件差异审阅已核验；本轮增量已一次性提交至 `EndiVee233/SubFabric` main，并核对父提交与变更文件范围）。完整范围、验收与本轮证据见 [MAINTENANCE.md](MAINTENANCE.md)。
- 连续性规则：[CONTINUITY.md](CONTINUITY.md)；结构与红线：[../PROJECT_MAP.md](../PROJECT_MAP.md) §6–§8。
- 开始基线：当前目录为源码快照，无 `.git`，不初始化。Node v24.21.0；本机无 PATH Python/gh，已发现应用提供的 Python 3.12.14（有 numpy，无 ruff）；未发现 ESLint。
- 已记录源码/测试/文档 417 文件 SHA-256 至本机 `_test/maintenance/baseline.json`（不入库）；保留原文件和已有修改。
- 远程开始基线：`EndiVee233/SubFabric` 默认分支解析至 main，HEAD `8cb07bac42e3f6a85c9c6cbb966d5419887e67ef`，main 未保护；连接器登录账号 R2FtYml0。

## 本次执行

- JS：`node tests/run-all.mjs --report _test/maintenance/js-results.json`，Node v24.21.0；96 项执行，88 通过、7 部分执行、1 个诊断、0 失败，2 项因真实项目数据排除。通过 `SUBFABRIC_PYTHON` 使词边界与 VibeVoice 行为用例完整执行。逐项结果在 gitignore 下 `_test/maintenance/js-results.json`。
- Python：8 个可隔离测试全部退出 0：confidence(65)、draft-role-gap(12)、fetch-format(58)、glommed-split(47)、frame-units 静态(11)、asr-segment-parity(24)、VibeVoice unittest(3)、diarize 合成 WAV/内存测试。frame-units 私有历史数据明确跳过；NPU `samples=None` 已知提示不影响结果。
- 语法：273 个 JS/MJS/CJS 文件 `node --check` 通过；33 个 Python 文件 `ast.parse` 通过。
- 改进：统一 JS 回归入口支持筛选/独立 JSON 报告，旧 repair15 命令改为兼容别名；测试默认隔离；纠错模型切换测试使用临时服务与设置；Python 行为探针可由 `SUBFABRIC_PYTHON` 指定；AES 用户名读取在受限系统 API 报错时回退账户环境变量；修复 home-only 工具的模板语法错误；更新 CI、项目地图和开发说明。
- 未运行/阻塞：本机没有 ESLint/Ruff；真实 GUI、GPU/NPU、推理模型、vendor、SEA/安装器未验收。用户项目颜色修复及字体状态 GUI 未运行；其余 7 项部分执行的确切原因见维护文档。
- 历史 `docs/repair15-regression-results.json` 已恢复为开始 SHA-256 `86fdbe98737403e8aeaeb38df4d244b8ee24c4d0ff45802de62cbafefe572d10`；测试生成的 `tests/jsmod/` 差异是测试镜像同步，已保留。
- 最后复核：兼容入口定向运行 `secret-store-test.mjs` 与隔离 `correct-switch-test.mjs` 均通过；随后完整 JS 回归再次得到 88/7/1/0（排除 2）。
- 云端保存：本轮增量 18 个文件（16 个改动 + 新增 `docs/MAINTENANCE.md`、`docs/STATUS-before-maintenance-20261015.md`）经 GitHub 连接器以**单次原子多文件提交**写入 main。提交前核对：远程 HEAD 与开始基线一致（无并发变化）；本地与远端逐目录 git blob 比对（editor/、editor/js/、asr/、tools/、docs/、tests/jsmod/ 共 249 文件），差异仅限上述文件；敏感信息扫描无命中；全部改动 JS 通过语法检查。`tests/fixture.ass` 等生成物按 `.gitignore` 排除；`启动SubFabric(无窗口).vbs` 在远端为符号链接且与本任务无关，未纳入；`ui-config.example.json` 与远端逐字节一致，无需提交。
- CI 修复（2026-10-15 续）：`eslint.config.js` 浏览器侧 globals 补 `HTMLSelectElement` —— `editor/js/studio.js:739` 的自定义选择器用 `typeof HTMLSelectElement` 透传 `value/selectedIndex/disabled` 访问器，该全局自 8cb07bac 起缺失，导致 2026-10-13 以来每次推送的 `CI / JS · ESLint + 全量测试` 均失败（ESLint 步骤 1 error，测试步骤被跳过）；上一提交已修复 `tools/verify_home_only_running.mjs:97` 的解析错误（同类历史故障）。本地 eslint@9 对 `editor/ tools/ tests/` 复现 0 error（余 19 条历史 warning，不阻断 CI）。

## 历史已验证成果（不代表本次重验）

- 新 Studio UI 已接入真实功能，默认新 UI、保留 legacy；ASS 控件固定在编辑器。完整需求/验收：[UI_INTEGRATION.md](UI_INTEGRATION.md)。
- 15 项修复已完成且已验证：[REPAIR_15.md](REPAIR_15.md)、[REPAIR_15_RESULTS.md](REPAIR_15_RESULTS.md)。
- 2026-10-15：字幕分句/切序/颜色过期引用、设置页材质/焦点/毛玻璃参数和主题包明暗预览已修复并实装；此前 JS 全量 78 通过、20 含跳过、0 失败。
- VibeVoice NF4 CUDA 4bit 已实装并有十秒真实推理证据；长音频、全新环境安装未验证。
- beta 1.0 SEA/Inno 产物此前已构建；真实安装自检未验证，避免覆盖已装版本。未授权本次覆盖安装。
- 本次源码快照没有 vendor/模型/推理 runtime，真实 GPU/NPU/ASR/LLM/wasm/托盘与完整安装验收须具备条件后单独执行。
- 原状态全部保留在 [STATUS-before-maintenance-20261015.md](STATUS-before-maintenance-20261015.md)，仅为历史证据，不再维护第二份状态；其中安装备份路径指向此前工作区，当前快照未确认存在。

## GitHub 与恢复

- GitHub：本轮增量已提交至 `EndiVee233/SubFabric` main，父提交 `8cb07bac42e3f6a85c9c6cbb966d5419887e67ef`；提交标识与链接见最终报告。提交后核对父提交与变更文件范围（18 个文件，无范围外改动）；连接器的单次多文件提交本身即原子操作，但不提供 expected HEAD 参数，故以"提交前核对 HEAD + 提交后核对父提交"代替并发校验。CI 修复提交（`eslint.config.js` + 本文件）在同一 main 上续接，标识见最终报告。
- 恢复时先读本文件，再读 MAINTENANCE 与本次结果；不清理用户数据、不再本地暂存/提交/推送、不创建或调查 Hook。
